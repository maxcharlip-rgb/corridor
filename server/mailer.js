/**
 * Outbound email.
 *
 * Uses an HTTP email API rather than SMTP so there is no new dependency and no
 * long-lived socket to babysit on a small instance — it is one fetch.
 *
 * The governing rule here is that email is a NOTIFICATION, never the record. A
 * request that reached the server is already saved before this module is
 * called, and a send that fails is reported rather than thrown. Losing a
 * broker's job because a mail provider had a bad minute would be the single
 * worst bug this product could have: the customer believes they have ordered,
 * and nobody knows they exist.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY && mailFrom());

/** Where new-order notifications land. NOTIFY_EMAIL wins; otherwise Max. */
const DEFAULT_NOTIFY = 'max@corridor.video';
export const notifyAddress = () => process.env.NOTIFY_EMAIL || DEFAULT_NOTIFY;

export const mailFrom = () => process.env.MAIL_FROM || null;

export function mailStatus() {
  return {
    configured: mailConfigured(),
    from: mailFrom(),
    notify: notifyAddress(),
    reason: mailConfigured()
      ? null
      : !process.env.RESEND_API_KEY
        ? 'RESEND_API_KEY is not set'
        : 'MAIL_FROM is not set',
  };
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @returns {Promise<{ok: boolean, id?: string, error?: string, skipped?: boolean}>}
 *          Never throws. The caller decides what a failure means.
 */
export async function sendMail({ to, subject, html, replyTo, attachments }) {
  if (!mailConfigured()) {
    return { ok: false, skipped: true, error: mailStatus().reason };
  }
  if (!to) return { ok: false, error: 'no recipient' };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: mailFrom(),
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.message || data?.error?.message || `HTTP ${res.status}`;
      console.error('[mail] send failed:', detail);
      return { ok: false, error: detail };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// --- templates ---------------------------------------------------------------

const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";
const SANS = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** Live site origin for operator-facing links. Uploads and /requests are
 *  served here; Render's hostname is an intern leak, not a public URL. */
const SITE_ORIGIN = 'https://corridor.video';
const QUEUE_URL = `${SITE_ORIGIN}/requests`;

export function mailPublicUrl(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (
        /onrender\.com$/i.test(u.hostname)
        || /^(localhost|127\.0\.0\.1)$/i.test(u.hostname)
      ) {
        return `${SITE_ORIGIN}${u.pathname}${u.search}${u.hash}`;
      }
      if (/^(www\.)?corridor\.video$/i.test(u.hostname)) {
        return `${SITE_ORIGIN}${u.pathname}${u.search}${u.hash}`;
      }
      return raw;
    }
  } catch {
    /* fall through and treat as a path */
  }
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${SITE_ORIGIN}${path}`;
}

const SHELL = (body) => `<div style="margin:0;padding:28px 20px;background:#F7FAFD">
<div style="font:15px/1.6 ${SANS};color:#101418;max-width:560px;margin:0 auto">
<p style="margin:0 0 28px;font:22px/1.15 ${SERIF};color:#101418">Corridor</p>
${body}
<div style="margin-top:32px;padding-top:20px;border-top:1px solid #E9F0F8">
<p style="margin:0;font:13px/1.5 ${SANS};color:#5B6672">Corridor · Detroit · <a href="mailto:max@corridor.video" style="color:#5B6672;text-decoration:none">max@corridor.video</a></p>
</div>
</div>
</div>`;

const field = (label, value) =>
  value || value === 0
    ? `<p style="margin:0 0 14px"><span style="display:block;font:11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:#5B6672">${esc(label)}</span><span style="display:block;margin-top:3px">${esc(value)}</span></p>`
    : '';

const optionLabel = (request) => {
  const o = request.order || {};
  if (o.phoneWalk && o.extended) return 'Phone walk, extended cut';
  if (o.phoneWalk) return 'Phone walk';
  if (o.extended) return 'Extended cut';
  if (Array.isArray(request.wants) && request.wants.length) {
    const joined = request.wants.filter(Boolean).join(', ');
    if (joined && joined !== 'video tour') return joined;
  }
  return 'One listing';
};

const photoList = (urls) => {
  const items = (urls || []).filter(Boolean).map((u, i) => {
    const href = mailPublicUrl(u);
    return `<div style="margin:0 0 6px"><a href="${esc(href)}" style="color:#1E5AA8;word-break:break-all">Photo ${i + 1}</a></div>`;
  });
  return items.length
    ? `<p style="margin:0 0 6px"><span style="display:block;font:11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:#5B6672">Photos</span></p>${items.join('')}`
    : '';
};

const queueButton = () =>
  `<p style="margin:24px 0 0"><a href="${QUEUE_URL}" style="background:#1E5AA8;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px">Open the queue</a></p>`;

function brokerConfirmBody(request) {
  const name = String(request.name || '').trim() || 'there';
  const address = String(request.address || '').trim() || 'your listing';
  return `
      <p style="margin:0 0 16px">Hi ${esc(name)},</p>
      <p style="margin:0 0 16px">We have ${esc(address)}. We cut by hand from the photos you sent. It comes back in 48 hours.</p>
      <p style="margin:0 0 24px">We work the cut with you until it's a video you'd send.</p>
      <p style="margin:0">Corridor<br><a href="mailto:max@corridor.video" style="color:#101418;text-decoration:none">max@corridor.video</a></p>
    `;
}

/** What lands in the operator's inbox: everything needed to start work. */
export function requestNotification(request, photos) {
  const photoUrls = (photos || []).map((p) => `${SITE_ORIGIN}/uploads/${p.file}`);
  return {
    subject: `New listing — ${request.address || request.firm || 'untitled'}`,
    html: SHELL(`
      ${field('Name', request.name)}
      ${field('Email', request.email)}
      ${field('Address', request.address)}
      ${field('Option', optionLabel(request))}
      ${field('Photo count', String((photos || []).length))}
      ${field('Account', request.accountId ? 'Yes' : 'No')}
      ${request.notes ? field('Notes', request.notes) : ''}
      ${photoList(photoUrls)}
      ${queueButton()}
    `),
  };
}

/** What the broker gets back, so the form does not feel like a void. */
export function requestConfirmation(request) {
  return {
    subject: 'We have your listing',
    html: SHELL(brokerConfirmBody(request)),
  };
}

/** The sign-in link. The whole of authentication, as far as a broker is concerned. */
export function signInLink(account, url, minutes) {
  return {
    subject: 'Your Corridor link',
    html: SHELL(`
      <h2 style="margin:0 0 10px;font:400 26px/1.2 ${SERIF};color:#101418">Open Corridor.</h2>
      <p style="margin:0 0 20px">One tap. No password.</p>
      <p style="margin:0 0 18px"><a href="${esc(url)}" style="background:#1E5AA8;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:500;font-size:15px">Sign in</a></p>
      <p style="margin:0;color:#5B6672;font-size:13px">Works once. Expires in ${minutes} minutes. If you didn’t ask for this, ignore it.</p>
    `),
  };
}

const priceLine = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;

/** What the broker gets back the moment an order lands. Notification only —
 *  never a sign-in gate. A listing is done when the form returns 201. */
export function orderConfirmation(request) {
  return {
    subject: 'We have your listing',
    html: SHELL(brokerConfirmBody(request)),
  };
}

/**
 * The full submission, to the operator. Everything needed to start cutting.
 *
 * The optional files — flyer, OM, floor plan, logo, headshot — ride along as
 * real attachments, because those are what you open while you work. The photos
 * are linked instead: forty of them will not fit in an inbox, and a bounced
 * notification is worse than a click.
 */
export function orderNotification(request, { photoUrls = [], attachedCount = 0 } = {}) {
  const o = request.order || {};
  const urls = photoUrls.length
    ? photoUrls
    : (request.photos || []).map((p) => `${SITE_ORIGIN}/uploads/${p.file}`);
  const photoCount = urls.length || (request.photos || []).length;

  return {
    subject: `New listing — ${request.address || 'untitled'}`,
    html: SHELL(`
      ${field('Name', request.name)}
      ${field('Email', request.email)}
      ${field('Address', request.address)}
      ${field('Option', optionLabel(request))}
      ${field('Price', priceLine(o.amountCents || 0))}
      ${field('Photo count', String(photoCount))}
      ${field('Account', request.accountId ? 'Yes' : 'No')}
      ${field('Phone', request.phone)}
      ${field('Firm', request.firm)}
      ${attachedCount ? field('Attached', `${attachedCount} file(s) on this email`) : ''}
      ${request.brandingContact ? field('End card', request.brandingContact) : ''}
      ${request.notes ? field('Notes', request.notes) : ''}
      ${photoList(urls)}
      ${queueButton()}
    `),
  };
}

/** Delivery: the finished work, sent back to the broker. */
export function requestDelivery(request, { tourUrl, downloadUrl, note }) {
  return {
    subject: `Your video tour — ${request.address || 'Corridor'}`,
    html: SHELL(`
      <h2 style="margin:0 0 10px;font:400 26px/1.2 ${SERIF};color:#101418">It's ready.</h2>
      ${note ? `<p style="margin:0 0 16px">${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
      ${tourUrl ? `<p style="margin:0 0 12px"><a href="${esc(tourUrl)}" style="background:#1E5AA8;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px">Watch the tour</a></p>` : ''}
      ${downloadUrl ? `<p style="margin:0 0 16px"><a href="${esc(downloadUrl)}" style="color:#1E5AA8">Download the MP4</a> — post it anywhere.</p>` : ''}
      <p style="margin:16px 0 0;color:#5B6672;font-size:13px">Want a change? Reply to this email and say what to fix.</p>
    `),
  };
}
