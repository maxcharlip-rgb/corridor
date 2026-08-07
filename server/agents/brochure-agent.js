import { collectFacts, stripUnverified, DISCLOSURES } from '../facts.js';

/**
 * Brochure agent — a broker describes the look, Claude lays out the page.
 *
 * The output is HTML rather than a PDF binary for two reasons. A browser's own
 * print engine produces better typography and page breaks than anything we
 * could assemble server-side, and it needs no headless-Chrome dependency on a
 * 512 MB instance. The broker gets a real PDF through Save as PDF, from a page
 * built for print.
 *
 * Two things are enforced here rather than requested in the prompt, because a
 * prompt is a preference and this document goes to prospects:
 *
 *   1. Every number must already exist in the broker's own entered data.
 *      Asking a model not to invent a rent is not the same as it not doing so.
 *   2. The returned markup is sanitised before it is ever rendered. Broker
 *      notes, photo filenames and lead messages all reach this prompt, so the
 *      response is treated as untrusted input, not as trusted code.
 */

const MODEL = process.env.BROCHURE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 8000;

export const brochureConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Looks a broker can pick from without writing a brief. */
export const BROCHURE_STYLES = [
  {
    key: 'editorial',
    label: 'Editorial',
    hint: 'Large serif headlines, generous white space, one hero photo per section. Reads like a magazine spread.',
  },
  {
    key: 'modern',
    label: 'Modern minimal',
    hint: 'Tight sans-serif, thin rules, a strict grid, restrained colour. Reads like a design studio deck.',
  },
  {
    key: 'classic',
    label: 'Classic CRE',
    hint: 'Conventional brokerage layout: photo bank, spec table, location paragraph, contact block. Familiar to any tenant rep.',
  },
  {
    key: 'bold',
    label: 'Bold',
    hint: 'Full-bleed photography, heavy display type, high contrast. Built to stand out in an inbox.',
  },
];

const STYLE_BY_KEY = Object.fromEntries(BROCHURE_STYLES.map((s) => [s.key, s]));

// --- sanitising --------------------------------------------------------------

/* Elements that can execute, navigate, or fetch. A brochure needs none of them.
   Removed with their content so a stripped <script> cannot leave its body
   behind as visible text. */
const DANGEROUS_BLOCKS = /<\s*(script|iframe|object|embed|form|noscript|template|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DANGEROUS_SELF_CLOSING = /<\s*(script|iframe|object|embed|form|link|meta|base|input|button|textarea|select)\b[^>]*>/gi;

/** Images may only come from this install's own uploads. */
const ALLOWED_IMG = /^\/uploads\/[A-Za-z0-9._-]+$/;

function sanitiseHtml(raw) {
  let html = String(raw || '');
  const removed = [];

  const before = html;
  html = html.replace(DANGEROUS_BLOCKS, '').replace(DANGEROUS_SELF_CLOSING, '');
  if (html !== before) removed.push('active elements');

  // Event handlers in any quoting style, plus javascript: URLs.
  const beforeAttrs = html;
  html = html
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '');
  if (html !== beforeAttrs) removed.push('event handlers');

  // CSS can fetch too: @import and url() are both network reads.
  const beforeCss = html;
  html = html.replace(/@import[^;]+;/gi, '');
  html = html.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _q, url) =>
    ALLOWED_IMG.test(url.trim()) ? match : 'none'
  );
  if (html !== beforeCss) removed.push('external stylesheet references');

  // Every <img> must point at our own uploads; anything else is dropped so the
  // page cannot beacon out or hotlink a photo we do not control.
  const beforeImg = html;
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    return ALLOWED_IMG.test(src.trim()) ? tag : '';
  });
  if (html !== beforeImg) removed.push('foreign images');

  // Links may leave, but only over http(s) or mail.
  html = html.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(href.trim())) return tag;
    return tag.replace(/\bhref\s*=\s*["'][^"']*["']/i, '');
  });

  return { html: html.trim(), removed };
}

/**
 * Strip numbers the broker never entered from the brochure's visible text.
 *
 * Runs over text nodes only — a stray match inside a class name or a hex colour
 * would corrupt the layout, and those are not what a prospect reads.
 */
function enforceFacts(html, facts) {
  const stripped = [];

  const out = html.replace(/>([^<>]+)</g, (match, text) => {
    if (!/\d/.test(text)) return match;

    /* Drop the whole sentence, not just the number.
     *
     * Excising "$18.50 NNN" from "Asking $18.50 NNN, built in 1998" leaves
     * "Asking built in ." — the claim is gone but the page now looks broken,
     * which in a document a broker hands to a client is its own kind of
     * failure. A sentence that quietly is not there reads as intentional. */
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (const sentence of sentences) {
      const result = stripUnverified(sentence, facts);
      if (!result.stripped.length) {
        kept.push(sentence);
        continue;
      }
      stripped.push(...result.stripped);
      /* A short fragment — a spec cell like "24,000 SF · $18.50 NNN" — is worth
       * keeping trimmed, because it may still carry a verified fact. But only
       * if what survives reads as English: removing the number from "14ft
       * ceilings" leaves the orphaned unit "ft ceilings", which looks like a
       * typo rather than an omission. */
      // Sentence-ending punctuation is a . ! or ? followed by a space or the
      // end of the text. Testing for a bare "." classified "$18.50 NNN" as
      // prose and discarded the verified square footage sitting beside it.
      const isFragment = sentences.length === 1 && !/[.!?](\s|$)/.test(text.trim()) && text.trim().split(/\s+/).length <= 8;
      const remainder = result.text.trim();
      const orphanedUnit = /^(ft|sf|psf|nnn|sq|m|%|\/|·|-)\b/i.test(remainder);
      if (isFragment && remainder.length > 2 && !orphanedUnit) kept.push(remainder);
    }

    const joined = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
    return `>${joined}<`;
  });

  return { html: out, stripped: [...new Set(stripped)] };
}

// --- prompt ------------------------------------------------------------------

const SYSTEM = `You lay out commercial real estate brochures as self-contained HTML.

OUTPUT
Return ONLY an HTML fragment: one <style> block followed by the brochure markup.
No markdown fence, no commentary, no <html>/<head>/<body> wrapper.

HARD RULES
- Use ONLY the photo paths given to you, exactly as written. Never invent a path.
- Use ONLY the facts given to you. Never state a number — square footage, rent,
  year, parking ratio, ceiling height, floor count — that is not in the supplied
  facts. If a fact is missing, omit that line entirely. Do not estimate, round,
  or infer. A wrong number in a brochure is a misrepresentation.
- No <script>, no external stylesheets, no web fonts, no tracking pixels.
  System font stacks only.
- Every image must be an <img> whose src is one of the supplied paths.

PRINT
The page is printed to PDF on US Letter. Include @page { size: letter; margin: 0 }
and use page-break-inside: avoid on any block that must not split. Assume the
brochure is 1-3 pages; use <div class="page"> per page with a page-break-after.

CRAFT
Real hierarchy: one dominant headline, clear secondary structure, and space to
breathe. Photographs carry the page — let them run large. Type at print sizes
(body 10-11pt, not 16px). Align to a grid. The result should look like a broker
paid a designer, not like a form was filled in.`;

function buildUserMessage({ listing, photos, prompt, style, facts, previous }) {
  const chosen = STYLE_BY_KEY[style];
  const lines = [];

  lines.push(`BUILDING: ${listing.name || 'Untitled'}`);
  if (listing.address) lines.push(`ADDRESS: ${listing.address}`);
  if (listing.propertyType) lines.push(`TYPE: ${listing.propertyType}`);
  if (listing.headline) lines.push(`HEADLINE: ${listing.headline}`);

  const specs = (listing.specs || []).filter((s) => s.label || s.value);
  if (specs.length) {
    lines.push('', 'SPECS the broker entered (these are the only facts you may state):');
    for (const s of specs) lines.push(`- ${s.label}: ${s.value}`);
  }
  if (listing.specNotes) lines.push('', `BROKER NOTES: ${listing.specNotes}`);

  lines.push('', 'PHOTOS available (use the path verbatim as the img src):');
  for (const p of photos) {
    lines.push(`- /uploads/${p.file} — ${p.spaceType || 'space'}${p.caption ? ` — ${p.caption}` : ''}`);
  }

  lines.push(
    '',
    'EVERY NUMBER YOU MAY USE (any other number will be deleted from your output):',
    facts.numbers.size ? [...facts.numbers].join(', ') : '(none — state no numbers at all)'
  );

  if (chosen) lines.push('', `STYLE: ${chosen.label} — ${chosen.hint}`);
  if (prompt?.trim()) lines.push('', `WHAT THE BROKER ASKED FOR:\n${prompt.trim()}`);

  if (previous) {
    lines.push(
      '',
      'REVISE the brochure below. Keep everything the broker did not ask to change.',
      '--- CURRENT BROCHURE ---',
      previous,
      '--- END ---'
    );
  }

  lines.push(
    '',
    `Include this disclosure in small print at the end: "${DISCLOSURES.accuracy}"`
  );

  return lines.join('\n');
}

// --- entry point -------------------------------------------------------------

/**
 * @returns {Promise<{html: string, stripped: string[], removed: string[], model: string}>}
 */
export async function brochureAgent({ listing, photos = [], prompt = '', style = 'editorial', previous = null }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Brochures need an Anthropic API key. Add ANTHROPIC_API_KEY to the environment and redeploy.'
    );
  }
  if (!photos.length) {
    throw new Error('Add at least one photo before building a brochure.');
  }

  const facts = collectFacts(listing, listing.spec);
  const userContent = buildUserMessage({ listing, photos, prompt, style, facts, previous });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic returned ${response.status}`);
  }

  let html = (data.content || []).map((c) => c.text || '').join('').trim();
  // Models fence HTML often enough that stripping it is cheaper than retrying.
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!html) throw new Error('The model returned an empty brochure.');

  const clean = sanitiseHtml(html);
  const checked = enforceFacts(clean.html, facts);

  if (checked.stripped.length) {
    console.warn(`[brochure] removed unverifiable numbers: ${checked.stripped.join(', ')}`);
  }
  if (clean.removed.length) {
    console.warn(`[brochure] sanitiser removed: ${clean.removed.join(', ')}`);
  }

  return { html: checked.html, stripped: checked.stripped, removed: clean.removed, model: MODEL };
}

export const _internals = { sanitiseHtml, enforceFacts };
