import { config } from './config.js';

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

const SHELL = (body) => `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:620px">
${body}
<p style="margin-top:28px;font-size:12px;color:#9aa0a6">Corridor · cinematic marketing for commercial real estate</p>
</div>`;

const row = (label, value) =>
  value
    ? `<tr><td style="padding:7px 16px 7px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:7px 0;font-weight:500">${esc(value)}</td></tr>`
    : '';

/** What lands in the operator's inbox: everything needed to start work. */
export function requestNotification(request, photos) {
  const links = photos
    .map((p, i) => `<a href="${config.publicUrl}/uploads/${esc(p.file)}" style="color:#2B4FD7">Photo ${i + 1}</a>`)
    .join(' · ');

  return {
    subject: `New Corridor request — ${request.address || request.firm || 'untitled'}`,
    html: SHELL(`
      <h2 style="margin:0 0 4px;font-size:20px">New request</h2>
      <p style="margin:0 0 18px;color:#6b7280">${esc(request.wants.join(' + ') || 'video tour')}</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${row('Firm', request.firm)}
        ${row('Contact', request.name)}
        ${row('Email', request.email)}
        ${row('Phone', request.phone)}
        ${row('Address', request.address)}
        ${row('Type', request.propertyType)}
        ${row('Deal', request.deal)}
        ${row('Size', request.size)}
        ${row('Price / rate', request.price)}
        ${row('Photos', String(photos.length))}
      </table>
      ${request.notes ? `<p style="margin:18px 0 0"><b>What they want it to look like</b><br>${esc(request.notes).replace(/\n/g, '<br>')}</p>` : ''}
      ${links ? `<p style="margin:18px 0 0;font-size:13px">${links}</p>` : ''}
      <p style="margin:24px 0 0"><a href="${config.publicUrl}/requests" style="background:#2B4FD7;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px">Open the queue</a></p>
    `),
  };
}

/** What the broker gets back, so the form does not feel like a void. */
export function requestConfirmation(request) {
  return {
    subject: 'We got your property — Corridor',
    html: SHELL(`
      <h2 style="margin:0 0 10px;font-size:20px">Thanks — we have it.</h2>
      <p style="margin:0 0 16px">We are cutting the ${esc(request.wants.join(' and ') || 'video tour')} for
      <b>${esc(request.address || 'your property')}</b> now. It comes back to this address, ready to post
      on CoStar, LinkedIn, or anywhere else your listing lives.</p>
      <p style="margin:0 0 16px;color:#6b7280">Your video comes back in 48 hours or less. If we need
      anything else — a better exterior shot, a floor plate — we will reply to this email.</p>
      <p style="margin:0;color:#6b7280;font-size:13px">Nothing else to do on your end.</p>
    `),
  };
}

/** The sign-in link. The whole of authentication, as far as a broker is concerned. */
export function signInLink(account, url, minutes) {
  return {
    subject: 'Your Corridor sign-in link',
    html: SHELL(`
      <h2 style="margin:0 0 10px;font-size:20px">Here's your link.</h2>
      <p style="margin:0 0 20px">It signs you straight in — no password to remember.</p>
      <p style="margin:0 0 18px"><a href="${esc(url)}" style="background:#1E5AA8;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:500;font-size:15px">Sign in to Corridor</a></p>
      <p style="margin:0;color:#6b7280;font-size:13px">The link works once and expires in ${minutes} minutes.
      If you didn't ask for it, you can ignore this — nothing has changed on your account.</p>
    `),
  };
}

const priceLine = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;

/** What the broker gets back the moment an order lands. Notification only —
 *  never a sign-in gate. A listing is done when the form returns 201. */
export function orderConfirmation(request) {
  return {
    subject: `We've got it — ${request.address || 'your listing'}`,
    html: SHELL(`
      <h2 style="margin:0 0 10px;font-size:20px">We've got it.</h2>
      <p style="margin:0 0 16px">We're cutting the tour for <b>${esc(request.address || 'your listing')}</b> now.
      It comes back to this address <b>within 48 hours</b>. If we need a photo you didn't send, we'll just ask.</p>
      <p style="margin:0;color:#6b7280;font-size:13px">Nothing else to do on your end.</p>
    `),
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
  const extras = [o.phoneWalk ? 'Phone walk ($350)' : null, o.extended ? 'Extended cut (+$60)' : null].filter(Boolean);
  const links = photoUrls
    .map((u, i) => `<a href="${esc(u)}" style="color:#1E5AA8">${i + 1}</a>`)
    .join(' · ');

  return {
    subject: `New order — ${request.address || 'untitled'}`,
    html: SHELL(`
      <h2 style="margin:0 0 4px;font-size:20px">${esc(request.address || 'New order')}</h2>
      <p style="margin:0 0 18px;color:#6b7280">${esc(request.name || '')}${request.firm ? ' · ' + esc(request.firm) : ''}</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${row('Email', request.email)}
        ${row('Phone', request.phone)}
        ${row('Firm', request.firm)}
        ${row('Size', request.size)}
        ${row('Type', request.propertyType)}
        ${row('Listing', request.listingUrl)}
        ${row('Options', extras.join(' · ') || 'Standard')}
        ${row('Price', priceLine(o.amountCents || 0))}
        ${row('Photos', String((request.photos || []).length))}
        ${attachedCount ? row('Attached', `${attachedCount} file(s) on this email`) : ''}
        ${row('Account', request.accountId)}
        ${row('Marketing', request.marketingOptIn ? 'opted in' : 'no')}
      </table>
      ${request.brandingContact ? `<p style="margin:18px 0 0"><b>End card</b><br>${esc(request.brandingContact)}</p>` : ''}
      ${request.notes ? `<p style="margin:18px 0 0"><b>Notes</b><br>${esc(request.notes).replace(/\n/g, '<br>')}</p>` : ''}
      ${links ? `<p style="margin:18px 0 0;font-size:13px"><b>Photos:</b> ${links}</p>` : ''}
      <p style="margin:24px 0 0"><a href="${config.publicUrl}/requests" style="background:#1E5AA8;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px">Open the queue</a></p>
    `),
  };
}

/** Delivery: the finished work, sent back to the broker. */
export function requestDelivery(request, { tourUrl, downloadUrl, note }) {
  return {
    subject: `Your video tour — ${request.address || 'Corridor'}`,
    html: SHELL(`
      <h2 style="margin:0 0 10px;font-size:20px">It is ready.</h2>
      ${note ? `<p style="margin:0 0 16px">${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
      ${tourUrl ? `<p style="margin:0 0 12px"><a href="${esc(tourUrl)}" style="background:#2B4FD7;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px">Watch the tour</a></p>` : ''}
      ${downloadUrl ? `<p style="margin:0 0 16px"><a href="${esc(downloadUrl)}" style="color:#2B4FD7">Download the MP4</a> — post it anywhere.</p>` : ''}
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px">Want a change? Reply to this email and say what to fix.</p>
    `),
  };
}
