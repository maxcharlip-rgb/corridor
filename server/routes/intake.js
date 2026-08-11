import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { getDb, saveNow, id, now } from '../store.js';
import { sendMail, requestNotification, requestConfirmation, mailConfigured } from '../mailer.js';
import { rateLimit } from '../limits.js';

/**
 * Landing-page intake.
 *
 * This is a second door onto the SAME record store the /request page writes to,
 * not a second intake system. Everything lands in db.requests and shows up in
 * the one queue at /requests. Two stores would mean two places to check, and
 * the one nobody checks is where a broker's job goes to die.
 *
 * Two rules govern this file:
 *   1. The submission is saved before any mail is attempted, and the response
 *      never depends on mail succeeding.
 *   2. A rejected submission leaves nothing behind on disk.
 */
export const intakeApi = express.Router();

const MIN_PHOTOS = 12;
const MAX_PHOTOS = 40;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const NOTIFY = 'hello@corridor.tours';

const ALLOWED_IMAGE = /^image\/(jpeg|png|webp)$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/* Checked from the header before multer runs, so half a gigabyte is refused at
   the door rather than written to disk and then deleted. */
function capTotalSize(req, res, next) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_TOTAL_BYTES) {
    return res.status(413).json({
      success: false,
      error: 'Those photos are over the 500 MB limit. Send fewer, or smaller versions.',
    });
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `${id('img')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_PHOTOS },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE.test(file.mimetype)) return cb(null, true);
    req.rejectedFiles = req.rejectedFiles || [];
    req.rejectedFiles.push({
      name: file.originalname,
      reason: /heic|heif/i.test(file.mimetype)
        ? 'HEIC is not supported. On iPhone: Settings → Camera → Formats → "Most Compatible".'
        : 'Only JPEG, PNG and WebP images are supported.',
    });
    cb(null, false);
  },
});

/** Nothing accepted means nothing kept. */
async function discard(files) {
  await Promise.all(
    (files || []).map((f) =>
      fs.unlink(path.join(config.uploadsDir, f.filename)).catch(() => {})
    )
  );
}

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, scope: 'intake' });

/* multer signals its own limits by throwing, which would otherwise surface as a
   500 and an unusable message. Translate them into the {success,error} contract
   the page expects. */
function receive(req, res, next) {
  upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'One of those photos is over 25 MB. Send a smaller version.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? `That is more than ${MAX_PHOTOS} photos — send your best ${MAX_PHOTOS}.`
          : 'We could not read that upload. Try again.';
    discard(req.files).then(() => res.status(400).json({ success: false, error: message }));
  });
}

intakeApi.post('/', limiter, capTotalSize, receive, async (req, res) => {
  const body = req.body || {};
  const files = req.files || [];

  const fail = async (status, error) => {
    await discard(files);
    return res.status(status).json({ success: false, error, rejected: req.rejectedFiles || [] });
  };

  const name = clean(body.name, 120);
  if (!name) return fail(400, 'Tell us who to send it back to.');

  const email = clean(body.email, 200);
  if (!EMAIL_RE.test(email)) return fail(400, 'A valid email address is required — it is where the tour goes.');

  const address = clean(body.address);
  if (!address) return fail(400, 'The property address is required.');

  /* Re-checked here even though the page checks it. The page is a convenience;
     this is the rule. */
  if (files.length < MIN_PHOTOS) {
    const rejected = req.rejectedFiles || [];
    return fail(
      400,
      rejected.length
        ? `Only ${files.length} of those photos could be used, and we need at least ${MIN_PHOTOS}. ${rejected[0].reason}`
        : `We need at least ${MIN_PHOTOS} photos to cut a tour — you sent ${files.length}.`
    );
  }

  const extended = /^(yes|true|on|1)$/i.test(clean(body.extended, 10));

  const request = {
    id: id('req'),
    firm: clean(body.firm),
    name,
    email,
    phone: '',
    address,
    propertyType: clean(body.propertyType, 60),
    deal: '',
    size: clean(body.size, 80),
    price: '',
    notes: extended ? 'Extended cut requested — large or multi-building property (+$60).' : '',
    wants: ['video tour'],
    photos: files.map((f, i) => ({ file: f.filename, originalName: f.originalname, order: i })),
    rejected: req.rejectedFiles || [],
    status: 'new',
    payment: { paid: false, comped: false, amount: null, packageKey: null, sessionId: null },
    createdAt: now(),
    source: 'landing',
  };

  const db = getDb();
  db.requests = db.requests || [];
  db.requests.push(request);
  // Durable before we answer: this is somebody's job, not a cache entry.
  saveNow();

  res.status(201).json({
    success: true,
    id: request.id,
    photos: files.length,
    rejected: request.rejected,
  });

  // After the response. The record is already safe; mail is a notification.
  (async () => {
    const note = requestNotification(request, request.photos);
    const toOperator = await sendMail({ to: NOTIFY, subject: note.subject, html: note.html, replyTo: email });

    const confirm = requestConfirmation(request);
    const toBroker = await sendMail({ to: email, subject: confirm.subject, html: confirm.html });

    const stored = (getDb().requests || []).find((r) => r.id === request.id);
    if (stored) {
      stored.notified = { operator: toOperator, broker: toBroker, at: now() };
      saveNow();
    }
    if (!toOperator.ok) {
      console.error(
        `[intake] request ${request.id} SAVED but ${NOTIFY} was not emailed: ${toOperator.error}. ` +
        (mailConfigured() ? 'Check the mail provider.' : 'Set RESEND_API_KEY and MAIL_FROM.')
      );
    }
  })();
});
