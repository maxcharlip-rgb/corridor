import fs from 'node:fs';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

/**
 * A bundled font, so text can never silently vanish.
 *
 * Render's Node image ships no fonts. With none available, drawtext cannot run
 * and end cards, address bands, spec lines and captions were all skipped — the
 * reel still built and downloaded fine, it just carried none of the information
 * a broker needs on it. Nothing errored, so nothing surfaced. Depending on the
 * host having fonts was the mistake; DejaVu now travels with the app.
 */
function bundledFont(file) {
  try {
    return requireCjs.resolve(`dejavu-fonts-ttf/ttf/${file}`);
  } catch {
    return null;
  }
}


import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * End card — the broker's face and number held for a few seconds after the
 * tour. This is what converts a video that gets forwarded around into an
 * inbound call, and it costs nothing to render because it is composited
 * locally rather than generated.
 *
 * Built with ffmpeg drawtext rather than an SVG rasteriser so there is no
 * native dependency to install; the trade-off is that layout is arithmetic
 * instead of markup.
 */

/**
 * Font discovery.
 *
 * This matters more than it looks: with no usable font, drawtext cannot run, so
 * end cards, address bands, spec lines and hero captions are all silently
 * skipped. The reel still builds — it just loses every piece of information a
 * broker needs on it. On a Linux host that ships no fonts (many slim container
 * images), the first symptom is a video that renders "fine" and says nothing.
 *
 * So: search widely, allow an explicit override, and let `npm run doctor` fail
 * loudly rather than degrade quietly.
 */
const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  bundledFont('DejaVuSans-Bold.ttf'),
  // macOS
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  // Debian / Ubuntu (Render's native runtime, most CI images)
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
  // Alpine
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
  // RHEL / Amazon Linux
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf',
].filter(Boolean);

const REGULAR_CANDIDATES = [
  process.env.FONT_PATH_REGULAR,
  bundledFont('DejaVuSans.ttf'),
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
].filter(Boolean);

function findFont(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Can this host burn text into a video?
 *
 * Both halves are required and each failed independently: a host with no fonts
 * (fixed by bundling DejaVu) and a binary with no drawtext filter (ffmpeg-static
 * compiles libfreetype on macOS but not on Linux). Reporting "fonts available"
 * while the filter is missing is what made the overlay failure look like a font
 * problem for so long.
 */
export const fontsAvailable = () => Boolean(findFont(FONT_CANDIDATES)) && Boolean(config.ffmpegText);

/** drawtext treats : \ ' % as syntax — escape before interpolating user text. */
function esc(text) {
  return String(text ?? '')
    /* A straight apostrophe cannot be escaped inside drawtext's text='...'
       wrapper: av_get_token treats a backslash as literal there, so the quote
       closes early and the rest of the filtergraph is swallowed as text. The
       whole overlay then silently disappears — and CRE is full of names like
       O'Brien and "Detroit's". The typographic apostrophe renders identically,
       ships with DejaVu, and carries no syntax. */
    .replace(/'/g, '\u2019')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Pull the actual complaint out of ffmpeg's stderr.
 *
 * ffmpeg prints codec statistics last, so taking the final few lines reports
 * bitrate and macroblock percentages and discards the one line that says what
 * went wrong. Select the diagnostic lines instead, and keep the tail only as a
 * fallback when none match.
 */
function explainFfmpeg(stderr) {
  const lines = stderr.trim().split('\n');
  const notable = lines.filter((l) =>
    /error|invalid|no such|failed|cannot|unable|denied|no space|not found|unsupported|conversion failed/i.test(l)
  );
  const picked = (notable.length ? notable : lines).slice(-6);
  return picked.join('\n').slice(0, 1200);
}

function run(binary, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('End card render timed out.'));
    }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // A kill reports code null; without the signal the message reads
      // "ffmpeg exited null", which says nothing about being OOM-killed.
      const how = signal ? `was killed by ${signal}` : `exited ${code}`;
      reject(new Error(`ffmpeg ${how}: ${explainFfmpeg(stderr)}`));
    });
  });
}

const hexToFF = (hex) => (hex || '#c8622a').replace('#', '0x');

/**
 * Burn property information into the montage.
 *
 * The tour gets forwarded, re-posted and screenshotted away from the listing
 * page, so the address and the phone number have to travel *inside* the pixels.
 * A video that lands in a prospect's inbox with no address on it is a dead end.
 *
 * Layout: address held over the opening, a persistent spec line bottom-right,
 * and the call to action over the closing seconds. Each sits on a subtle scrim
 * because white text over a bright ceiling or a snowy parking lot is unreadable.
 */
export async function applyTextOverlays({
  inPath,
  outPath,
  address,
  specLine,
  cta,
  captions = [],
  durationSec,
  accent = '#c8622a',
  holdSec = 4,
  fps = 24,
  height = 1080,
}) {
  if (!config.ffmpegText) {
    throw new Error('no ffmpeg build with the drawtext filter is available — overlays are unavailable.');
  }

  const bold = findFont(FONT_CANDIDATES);
  const regular = findFont(REGULAR_CANDIDATES) || bold;
  if (!bold) throw new Error('No usable font found for text overlays.');

  const filters = [];
  const accentFF = hexToFF(accent);
  const fadeIn = 0.4;

  if (address) {
    const size = Math.round(height * 0.055);
    // Scrim first, then text, both gated to the opening hold.
    filters.push(
      `drawbox=x=0:y=${Math.round(height * 0.72)}:w=iw:h=${Math.round(height * 0.16)}` +
        `:color=black@0.42:t=fill:enable='between(t,${fadeIn},${holdSec})'`
    );
    filters.push(
      `drawtext=fontfile='${bold}':text='${esc(address)}':fontsize=${size}` +
        `:fontcolor=white:x=(w-text_w)/2:y=${Math.round(height * 0.755)}` +
        `:enable='between(t,${fadeIn},${holdSec})'`
    );
  }

  if (specLine) {
    const size = Math.round(height * 0.024);
    // Persistent, but starts after the address clears so they never collide.
    const from = address ? holdSec + 0.3 : 0.5;
    const to = cta ? Math.max(from, durationSec - holdSec - 0.3) : durationSec;
    filters.push(
      `drawtext=fontfile='${regular}':text='${esc(specLine)}':fontsize=${size}` +
        `:fontcolor=white@0.92:x=w-text_w-${Math.round(height * 0.035)}:y=h-text_h-${Math.round(height * 0.035)}` +
        `:box=1:boxcolor=black@0.45:boxborderw=${Math.round(height * 0.012)}` +
        `:enable='between(t,${from},${to})'`
    );
  }

  if (cta) {
    const size = Math.round(height * 0.045);
    const from = Math.max(0, durationSec - holdSec);
    // White on a heavier scrim, with the accent moved to a rule above it.
    // Accent-coloured body text tested poorly over bright frames — a snowy
    // parking lot or a white ceiling washed the orange out completely.
    filters.push(
      `drawbox=x=0:y=${Math.round(height * 0.40)}:w=iw:h=${Math.round(height * 0.20)}` +
        `:color=black@0.66:t=fill:enable='gte(t,${from})'`
    );
    filters.push(
      // iw, not w: inside drawbox, `w` is the box's own width, not the frame's.
      `drawbox=x=(iw-${Math.round(height * 0.07)})/2:y=${Math.round(height * 0.445)}` +
        `:w=${Math.round(height * 0.07)}:h=4:color=${accentFF}@1:t=fill:enable='gte(t,${from})'`
    );
    filters.push(
      `drawtext=fontfile='${bold}':text='${esc(cta)}':fontsize=${size}` +
        `:fontcolor=white:x=(w-text_w)/2:y=${Math.round(height * 0.48)}` +
        `:shadowcolor=black@0.55:shadowx=2:shadowy=2` +
        `:enable='gte(t,${from})'`
    );
  }

  // Per-shot hero captions. Composited in this same pass rather than a second
  // encode — every extra generation is another round of compression loss.
  // Each caption sits low-left on its own scrim so it never collides with the
  // spec line bottom-right or the address band.
  for (const caption of captions) {
    if (!caption?.text || caption.to <= caption.from) continue;
    // Skip any caption that would overlap the opening address or closing CTA.
    if (address && caption.from < holdSec + 0.2) continue;
    if (cta && caption.to > durationSec - holdSec - 0.2) continue;

    const size = Math.round(height * 0.032);
    const y = Math.round(height * 0.845);
    const window = `between(t,${caption.from},${caption.to})`;

    filters.push(
      `drawtext=fontfile='${bold}':text='${esc(caption.text)}':fontsize=${size}` +
        `:fontcolor=white:x=${Math.round(height * 0.045)}:y=${y}` +
        `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(height * 0.014)}` +
        `:shadowcolor=black@0.5:shadowx=2:shadowy=2` +
        `:enable='${window}'`
    );
    // Accent tick to the left of the caption — reads as a lower third rather
    // than a subtitle, which is the register property marketing wants.
    filters.push(
      `drawbox=x=${Math.round(height * 0.028)}:y=${y - Math.round(height * 0.004)}` +
        `:w=4:h=${Math.round(size * 1.35)}:color=${accentFF}@1:t=fill:enable='${window}'`
    );
  }

  if (!filters.length) {
    fs.copyFileSync(inPath, outPath);
    return { path: outPath, applied: false };
  }

  await run(config.ffmpegText, [
    '-y', '-i', inPath,
    '-vf', `${filters.join(',')},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    outPath,
  ]);

  return { path: outPath, applied: true };
}

/** Compose the bottom-right spec line from a listing's spec rows. */
export function buildSpecLine(listing) {
  if (listing?.specLine) return listing.specLine;
  const specs = (listing?.specs || []).filter((s) => s.label || s.value);
  if (!specs.length) return '';
  return specs.map((s) => [s.label, s.value].filter(Boolean).join(': ')).join('   ·   ');
}

/**
 * Render the end card as a standalone clip, ready to concat onto the reel.
 *
 * @param {object} opts
 * @param {object} opts.broker    { name, company, phone, email, accent }
 * @param {object} opts.listing   { name, address }
 * @param {string} [opts.photoPath] absolute path to a headshot / logo
 * @param {number} [opts.durationSec]
 * @param {number} [opts.fps]     must match the reel or concat will judder
 */
export async function renderEndCard({
  broker,
  listing,
  photoPath,
  durationSec = 4,
  fps = 24,
  width = 1920,
  height = 1080,
  outPath,
}) {
  if (!config.ffmpegText) {
    throw new Error('no ffmpeg build with the drawtext filter is available — end cards are unavailable.');
  }

  const bold = findFont(FONT_CANDIDATES);
  const regular = findFont(REGULAR_CANDIDATES) || bold;
  if (!bold) {
    throw new Error('No usable font found for the end card. Set a TTF path in endcard.js.');
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const accent = hexToFF(broker?.accent);
  const hasPhoto = photoPath && fs.existsSync(photoPath);

  // Text sits right of the photo when there is one, centred when there isn't.
  const photoSize = Math.round(height * 0.34);
  const photoX = Math.round(width * 0.22);
  const photoY = Math.round((height - photoSize) / 2);
  const textX = hasPhoto ? photoX + photoSize + Math.round(width * 0.045) : Math.round(width * 0.5);
  const align = hasPhoto ? `x=${textX}` : `x=(w-text_w)/2`;

  const lines = [];
  // Accent rule above the name
  lines.push(
    `drawbox=x=${hasPhoto ? textX : Math.round(width * 0.5 - 40)}:y=${Math.round(height * 0.34)}` +
      `:w=80:h=5:color=${accent}@1:t=fill`
  );
  lines.push(
    `drawtext=fontfile='${bold}':text='${esc(broker?.name || '')}':fontsize=${Math.round(height * 0.075)}` +
      `:fontcolor=white:${align}:y=${Math.round(height * 0.39)}`
  );
  lines.push(
    `drawtext=fontfile='${regular}':text='${esc(broker?.company || '')}':fontsize=${Math.round(height * 0.034)}` +
      `:fontcolor=0xa8adb6:${align}:y=${Math.round(height * 0.49)}`
  );

  const contact = [broker?.phone, broker?.email].filter(Boolean).join('   ·   ');
  if (contact) {
    lines.push(
      `drawtext=fontfile='${regular}':text='${esc(contact)}':fontsize=${Math.round(height * 0.03)}` +
        `:fontcolor=${accent}:${align}:y=${Math.round(height * 0.57)}`
    );
  }

  // Listing name, small, top-left — reminds the viewer what they just watched.
  if (listing?.name) {
    lines.push(
      `drawtext=fontfile='${regular}':text='${esc(listing.name)}':fontsize=${Math.round(height * 0.026)}` +
        `:fontcolor=0x6d727b:x=${Math.round(width * 0.06)}:y=${Math.round(height * 0.08)}`
    );
  }

  const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x111318:s=${width}x${height}:d=${durationSec}:r=${fps}`];
  let filter;

  if (hasPhoto) {
    args.push('-i', photoPath);
    filter =
      `[1:v]scale=${photoSize}:${photoSize}:force_original_aspect_ratio=increase,` +
      `crop=${photoSize}:${photoSize}[pic];` +
      `[0:v][pic]overlay=${photoX}:${photoY}[bg];` +
      `[bg]${lines.join(',')},format=yuv420p[out]`;
  } else {
    filter = `[0:v]${lines.join(',')},format=yuv420p[out]`;
  }

  args.push(
    '-filter_complex', filter,
    '-map', '[out]',
    '-frames:v', String(Math.round(durationSec * fps)),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    outPath
  );

  await run(config.ffmpegText, args);
  return { path: outPath, durationSec };
}
