import { config } from './config.js';

/**
 * Payments — Stripe Checkout, over the REST API.
 *
 * Checkout is hosted by Stripe, so no card number, CVC or expiry ever reaches
 * this server. That is the whole reason to use it: the most sensitive data in
 * the product is data we never hold. It is also one fetch, so no new dependency.
 *
 * The rule that matters: a paid session is only ever confirmed by asking Stripe.
 * The browser is told the session id on redirect and could say anything, so the
 * form gate reads payment_status from the API, never from the URL.
 */

const API = 'https://api.stripe.com/v1';

export const paymentsConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

export function paymentStatus() {
  return {
    configured: paymentsConfigured(),
    reason: paymentsConfigured() ? null : 'STRIPE_SECRET_KEY is not set',
    livemode: (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_'),
  };
}

/**
 * What a broker can buy. Prices come from the pricing model: a CRE trophy
 * listing is under what the owner already pays a drone crew, which is the
 * anchor that makes it an easy yes.
 */
export const PACKAGES = [
  {
    key: 'listing',
    name: 'Listing video',
    price: 899,
    blurb: 'A cinematic walkthrough cut from your photos. Ready for CoStar, LinkedIn and email.',
    detail: ['Up to 6 scenes', 'Address and specs on screen', 'Back in 24 hours or less'],
  },
  {
    key: 'marquee',
    name: 'Marquee',
    price: 1199,
    blurb: 'For the asset the whole pitch rests on. Longer cut, more scenes, a hosted tour page and a QR sign kit.',
    detail: ['Up to 10 scenes', 'Hosted tour page with lead capture', 'QR code sign kit', 'Back in 24 hours or less'],
  },
  {
    key: 'residential',
    name: 'Luxury residential',
    price: 699,
    blurb: 'For $2M+ homes. Same cinematic treatment, tuned for a residential audience.',
    detail: ['Up to 6 scenes', 'Social crops on request', 'Back in 24 hours or less'],
  },
];

export const PACKAGE_BY_KEY = Object.fromEntries(PACKAGES.map((p) => [p.key, p]));

/** Stripe's API is form-encoded, including nested keys. */
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => form(item, `${key}[${i}]`, out));
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || `Stripe returned ${res.status}`;
    throw new Error(detail);
  }
  return data;
}

/**
 * @returns {Promise<{url: string, id: string}>} the hosted payment page
 */
export async function createCheckout({ packageKey, email }) {
  const pkg = PACKAGE_BY_KEY[packageKey];
  if (!pkg) throw new Error('Unknown package.');
  if (!paymentsConfigured()) throw new Error('Payments are not configured on this server.');

  const session = await stripe('/checkout/sessions', {
    method: 'POST',
    body: {
      mode: 'payment',
      // Prices are defined here rather than in the Stripe dashboard so the
      // number a broker sees on the page and the number they are charged come
      // from one place and cannot drift apart.
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pkg.price * 100,
          product_data: { name: `Corridor — ${pkg.name}`, description: pkg.blurb },
        },
      }],
      success_url: `${config.publicUrl}/request?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicUrl}/#pricing`,
      ...(email ? { customer_email: email } : {}),
      metadata: { package: pkg.key },
    },
  });
  return { url: session.url, id: session.id };
}

/**
 * Confirm a session was actually paid.
 *
 * Called server-side before the form is unlocked and again before the request is
 * accepted. The browser only ever supplies an id; whether that id was paid is a
 * question only Stripe can answer.
 */
export async function verifyCheckout(sessionId) {
  if (!sessionId) return { paid: false, reason: 'no session' };
  if (!paymentsConfigured()) return { paid: false, reason: 'payments not configured' };

  try {
    const session = await stripe(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const paid = session.payment_status === 'paid';
    return {
      paid,
      reason: paid ? null : `payment_status is ${session.payment_status}`,
      packageKey: session.metadata?.package || null,
      amount: typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
      email: session.customer_details?.email || session.customer_email || null,
      sessionId,
    };
  } catch (err) {
    return { paid: false, reason: err.message };
  }
}
