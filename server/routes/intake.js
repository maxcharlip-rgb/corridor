import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { getDb, saveNow, id, now } from '../store.js';
import { accountByEmail, createAccount, setSessionCookie } from '../auth.js';
import {
  sendMail, orderNotification, orderConfirmation, mailConfigured, notifyAddress,
} from '../mailer.js';
import { rateLimit } from '../limits.js';

/**
 * The order desk. This is the entire product surface: a broker fills in one
 * form and a tour comes back. There is no video generation here — Corridor
 * produces the tours by hand — so this route's whole job is to not lose the
 * order.
 *
 * Three rules govern the file:
 *   1. The order is saved before any mail is attempted, and the response never
 *      depends on mail succeeding. A provider outage must not read as "your
 *      request failed" to someone who just uploaded forty photos.
 *   2. The account is found or created from the email. Nobody is asked to
 *      register, and nobody has two accounts because they typed a capital.
 *   3. A rejected submission leaves nothing behind on disk.
 */
export const intakeApi = express.Router();

const MIN_PHOTOS = 12;
const MAX_PHOTOS = 40;
const MAX_ATTACHMENTS = 12;
const MAX_BRANDING = 4;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/* Priced here as well as on the page. The page is a convenience; this is the
   rule. Public cards stay $200 / $750; these are the single-listing extras. */
const BASE_CENTS = 20000;      // photos-only listing
const PHONE_WALK_CENTS = 15000; // two-minute phone walk → $350
const EXTENDED_CENTS = 6000;   // large or multi-building

/* Resend caps a message around 40 MB. The optional files are what the operator
   actually opens while cutting, so they ride along; past this budget the rest
   are linked instead of attached rather than bouncing the whole notification. */
const ATTACH_BUDGET_BYTES = 18 * 1024 * 1024;

const ALLOWED_PHOTO = /^image\/(jpeg|png|webp)$/i;
const ALLOWED_ATTACHMENT = /^(image\/(jpeg|png|webp)|application\/pdf)$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const yes = (v) => /^(yes|true|on|1)$/i.test(clean(v, 10));

/* Read from the header before multer runs, so half a gigabyte is refused at the
   door rather than written to disk and then deleted. */
function capTotalSize(req, res, next) {
  if (Number(req.headers['content-length'] || 0) > MAX_TOTAL_BYTES) {
    return res.status(413).json({
      success: false,
      error: 'That upload is over the 500 MB limit. Send fewer photos, or smaller versions.',
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
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_PHOTOS + MAX_ATTACHMENTS + MAX_BRANDING },
  fileFilter: (req, file, cb) => {
    const ok = file.fieldname === 'photos' ? ALLOWED_PHOTO : ALLOWED_ATTACHMENT;
    if (ok.test(file.mimetype)) return cb(null, true);
    req.rejectedFiles = req.rejectedFiles || [];
    req.rejectedFiles.push({
      name: file.originalname,
      reason: /heic|heif/i.test(file.mimetype)
        ? 'HEIC is not supported. On iPhone: Settings → Camera → Formats → "Most Compatible".'
        : file.fieldname === 'photos'
          ? 'Photos must be JPEG, PNG or WebP.'
          : 'Attachments must be a PDF or an image.',
    });
    cb(null, false);
  },
});

const fields = upload.fields([
  { name: 'photos', maxCount: MAX_PHOTOS },
  { name: 'attachments', maxCount: MAX_ATTACHMENTS },
  { name: 'branding', maxCount: MAX_BRANDING },
]);

const flatten = (grouped) =>
  Object.values(grouped || {}).reduce((all, list) => all.concat(list || []), []);

/** Nothing accepted means nothing kept. */
async function discard(files) {
  await Promise.all(
    (files || []).map((f) => fs.unlink(path.join(config.uploadsDir, f.filename)).catch(() => {}))
  );
}

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, scope: 'intake' });

/* multer signals its own limits by throwing, which would otherwise surface as a
   500 and an unusable message. Translate into the {success,error} contract. */
function receive(req, res, next) {
  fields(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'One of those files is over 50 MB. Send a smaller version.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `That is more than ${MAX_PHOTOS} photos — send your best ${MAX_PHOTOS}.`
          : 'We could not read that upload. Try again.';
    discard(flatten(req.files)).then(() =>
      res.status(400).json({ success: false, error: message })
    );
  });
}

intakeApi.post('/', limiter, capTotalSize, receive, async (req, res) => {
  try {
  const body = req.body || {};
  const grouped = req.files || {};
  const photos = grouped.photos || [];
  const attachments = grouped.attachments || [];
  const brandingFiles = grouped.branding || [];

  const fail = async (status, error) => {
    await discard(flatten(grouped));
    return res.status(status).json({ success: false, error, rejected: req.rejectedFiles || [] });
  };

  /* Signed-in desk: identity comes from the session. Guest form still sends
     name and email. A signed-in broker cannot attach the upload to someone else
     by editing hidden fields. */
  const name = clean((req.account && req.account.name) || body.name, 120);
  if (!name) return fail(400, 'Tell us who to send it back to.');

  const email = req.account
    ? req.account.email
    : clean(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail(400, 'A valid email address is required — it is your account.');

  const address = clean(body.address);
  if (!address) return fail(400, 'The property address is required.');

  /* Optional extras live in the homepage expander. The public form only asks
     for name, email, address and photos — do not 400 when the rest is blank. */
  const size = clean(body.size, 80);

  /* Re-checked here even though the page checks it. The page is a convenience;
     this is the rule. */
  if (photos.length < MIN_PHOTOS) {
    const rejected = req.rejectedFiles || [];
    return fail(
      400,
      rejected.length
        ? `Only ${photos.length} of those photos could be used, and we need at least ${MIN_PHOTOS}. ${rejected[0].reason}`
        : `We need at least ${MIN_PHOTOS} photos to cut a tour — you sent ${photos.length}.`
    );
  }
  if (photos.length > MAX_PHOTOS) return fail(400, `That is ${photos.length} photos. Send your best ${MAX_PHOTOS}.`);
  const totalBytes = photos.concat(attachments, brandingFiles).reduce((s, f) => s + (f.size || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return fail(413, 'That upload is over the 500 MB limit. Send fewer photos, or smaller versions.');
  }

  const phone = clean(body.phone, 60);
  const firm = clean(body.firm);
  const marketingOptIn = yes(body.marketing);

  /* The account, found or created. This is the whole of registration: a broker
     never chose a password and never will. A session wins so the desk upload
     stays on this account even if the form is missing an email. */
  let account = req.account || accountByEmail(email);
  let created = false;
  if (!account) {
    try {
      account = createAccount({ email, name, company: firm, phone });
      created = true;
    } catch (err) {
      account = accountByEmail(email);
      if (!account) return fail(err.status || 500, err.message || 'Could not create the account.');
    }
  } else {
    // Fill gaps from this order without overwriting what they already have.
    if (!account.name && name) account.name = name;
    if (!account.phone && phone) account.phone = phone;
    if (!account.company && firm) account.company = firm;
  }
  account.marketing_opt_in = marketingOptIn;

  const extended = yes(body.extended);
  const phoneWalk = yes(body.phoneWalk);
  const amountCents = BASE_CENTS + (phoneWalk ? PHONE_WALK_CENTS : 0) + (extended ? EXTENDED_CENTS : 0);
  const claimed = Number(body.amountCents);
  if (Number.isFinite(claimed) && claimed !== amountCents) {
    console.warn(`[intake] page claimed ${claimed} but the price is ${amountCents}; using ${amountCents}.`);
  }

  const order = {
    id: id('ord'),
    accountId: account.id,
    address,
    extended,
    phoneWalk,
    amountCents,
    currency: 'usd',
    // Invoiced after delivery — no card is taken and none is implied.
    billing: 'invoice_after_delivery',
    status: 'new',
    at: now(),
  };

  const request = {
    id: id('req'),
    accountId: account.id,
    order,
    name,
    firm,
    email,
    phone,
    address,
    propertyType: clean(body.propertyType, 60),
    size,
    listingUrl: clean(body.listingUrl, 500),
    brandingContact: clean(body.brandingContact, 300),
    notes: clean(body.notes, 4000),
    marketingOptIn,
    wants: ['video tour'],
    photos: photos.map((f, i) => ({ file: f.filename, originalName: f.originalname, order: i })),
    attachments: attachments.map((f) => ({ file: f.filename, originalName: f.originalname, kind: 'attachment' })),
    branding: brandingFiles.map((f) => ({ file: f.filename, originalName: f.originalname, kind: 'branding' })),
    rejected: req.rejectedFiles || [],
    status: 'new',
    // The shape /requests already renders, so an order shows a sensible pill.
    payment: {
      paid: false, comped: false,
      amount: amountCents / 100,
      packageKey: phoneWalk ? 'phone-walk' : (extended ? 'extended' : 'listing'),
      sessionId: null,
    },
    createdAt: now(),
    source: req.account ? 'desk' : 'landing',
  };

  const db = getDb();
  db.requests = db.requests || [];
  db.orders = db.orders || [];
  db.requests.push(request);
  db.orders.push(order);
  // Durable before we answer: this is somebody's job, not a cache entry.
  saveNow();

  /* First order is how they get in. Same cookie as magic-link verify, so the
     landing form can send them straight to their desk without an emailed link. */
  setSessionCookie(res, account.id);

  res.status(201).json({
    success: true,
    error: null,
    id: request.id,
    orderId: order.id,
    photos: photos.length,
    rejected: request.rejected,
    order: { amountCents, extended, phoneWalk },
    redirect: '/listings',
  });

  // After the response. The record is already safe; mail is a notification.
  (async () => {
    const optional = attachments.concat(brandingFiles);
    let spent = 0;
    const attached = [];
    for (const f of optional) {
      if (spent + f.size > ATTACH_BUDGET_BYTES) continue;
      try {
        const content = await fs.readFile(path.join(config.uploadsDir, f.filename));
        attached.push({ filename: f.originalname || f.filename, content: content.toString('base64') });
        spent += f.size;
      } catch (err) {
        console.error(`[intake] could not attach ${f.filename}: ${err.message}`);
      }
    }
    if (attached.length < optional.length) {
      console.warn(`[intake] ${optional.length - attached.length} optional file(s) exceeded the email budget and were left in the queue only.`);
    }

    const note = orderNotification(request, {
      photoUrls: request.photos.map((p) => `${config.publicUrl}/uploads/${p.file}`),
      attachedCount: attached.length,
    });
    const operator = notifyAddress();
    const toOperator = await sendMail({
      to: operator, subject: note.subject, html: note.html, replyTo: email, attachments: attached,
    });

    /* Confirmation is optional and never a gate. The order is already saved. */
    const confirm = orderConfirmation(request);
    const toBroker = await sendMail({ to: email, subject: confirm.subject, html: confirm.html });

    const stored = (getDb().requests || []).find((r) => r.id === request.id);
    if (stored) {
      stored.notified = { operator: toOperator, broker: toBroker, at: now() };
      saveNow();
    }
    if (!toOperator.ok) {
      console.error(
        `[intake] order ${order.id} SAVED but ${operator} was not emailed: ${toOperator.error}. ` +
        (mailConfigured() ? 'Check the mail provider.' : 'Set RESEND_API_KEY and MAIL_FROM.')
      );
    }
    if (created) console.log(`[intake] created account ${account.id} for ${email} from their first order.`);
  })();
  } catch (err) {
    await discard(flatten(req.files || grouped));
    if (!res.headersSent) {
      res.status(err.status || 500).json({ success: false, error: err.message || 'We could not take that listing. Try again.' });
    }
  }
});
