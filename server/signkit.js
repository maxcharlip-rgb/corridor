import QRCode from 'qrcode';

/**
 * Sign kit.
 *
 * The QR on a listing sign is the only place Corridor touches the physical
 * world, and it is the part CoStar cannot copy — they do not own the sign in
 * the ground. Everything here exists to make that scan trackable and the
 * printed asset good enough that a broker will actually order it.
 *
 * Every generated link carries a `src` tag so a drive-by scan is never
 * confused with a LinkedIn click. That attribution is the whole point: without
 * it the sign is unmeasurable and the broker has no reason to renew.
 */

/** Scannability rule of thumb: usable scan distance ≈ 10× the QR's width. */
export const SIGN_FORMATS = {
  rider: {
    key: 'rider',
    label: 'Sign rider',
    note: 'Standard 24 × 6 in rider that bolts under an existing listing sign.',
    widthIn: 24,
    heightIn: 6,
    qrIn: 4.6,
    scanFeet: 4,
  },
  panel: {
    key: 'panel',
    label: 'Window panel',
    note: 'Square 12 × 12 in panel for a window, door or lobby easel.',
    widthIn: 12,
    heightIn: 12,
    qrIn: 7.5,
    scanFeet: 6,
  },
  flyer: {
    key: 'flyer',
    label: 'Flyer corner',
    note: 'Compact 3.5 × 3.5 in block to drop into a PDF flyer or OM.',
    widthIn: 3.5,
    heightIn: 3.5,
    qrIn: 2.4,
    scanFeet: 2,
  },
};

/** Append the attribution tag without clobbering an existing query string. */
export function taggedUrl(baseUrl, source) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}src=${encodeURIComponent(source)}`;
}

/**
 * Build the QR matrix ourselves rather than taking the library's rendered SVG,
 * so the modules can be laid out inside a designed sign at exact print sizes.
 */
async function qrRects(text, { size, x, y, quietModules = 2 }) {
  // 'M' tolerates ~15% damage — the right level for something that will live
  // outdoors on a post through a Michigan winter.
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const data = qr.modules.data;
  const total = count + quietModules * 2;
  const unit = size / total;

  const rects = [];
  for (let row = 0; row < count; row += 1) {
    let run = 0;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && data[row * count + col];
      if (dark) {
        run += 1;
        continue;
      }
      if (run) {
        // Merge horizontal runs into one rect: far fewer nodes, and printers
        // render a solid bar more reliably than a row of abutting squares.
        const startCol = col - run;
        rects.push(
          `<rect x="${(x + (quietModules + startCol) * unit).toFixed(3)}" ` +
            `y="${(y + (quietModules + row) * unit).toFixed(3)}" ` +
            `width="${(run * unit).toFixed(3)}" height="${unit.toFixed(3)}"/>`
        );
        run = 0;
      }
    }
  }
  return { rects: rects.join(''), unit, count };
}

const escapeXml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]
  );

/**
 * Render a print-ready sign asset as SVG.
 * SVG because it is vector (any size, no resampling), every print shop takes
 * it, and it stays a text file we can diff.
 */
export async function renderSign({
  format = 'rider',
  tourUrl,
  listing,
  broker,
  accent = '#c8622a',
}) {
  const spec = SIGN_FORMATS[format];
  if (!spec) throw new Error(`Unknown sign format "${format}".`);

  const DPI = 96; // SVG user units per inch
  const W = spec.widthIn * DPI;
  const H = spec.heightIn * DPI;
  const qrSize = spec.qrIn * DPI;
  const pad = 0.42 * DPI;

  const url = taggedUrl(tourUrl, 'sign');
  const compact = format === 'flyer';
  const square = format === 'panel';

  // Rider is landscape: QR right, copy left. Panel/flyer stack vertically.
  const qrX = square || compact ? (W - qrSize) / 2 : W - qrSize - pad;
  const qrY = square || compact ? pad * 1.1 : (H - qrSize) / 2;

  const { rects } = await qrRects(url, { size: qrSize, x: qrX, y: qrY });

  const headline = compact ? 'Video tour' : 'Take the video tour';
  const sub = compact ? 'Scan to watch' : 'Scan to walk the building from your phone';

  let copy = '';
  if (compact) {
    copy = `
      <text x="${W / 2}" y="${qrY + qrSize + 0.34 * DPI}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.2 * DPI}"
            font-weight="700" fill="#11131a">${escapeXml(headline)}</text>
      <text x="${W / 2}" y="${qrY + qrSize + 0.56 * DPI}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.125 * DPI}"
            fill="#6b7078">${escapeXml(sub)}</text>`;
  } else if (square) {
    copy = `
      <text x="${W / 2}" y="${qrY + qrSize + 0.62 * DPI}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.42 * DPI}"
            font-weight="700" fill="#11131a">${escapeXml(headline)}</text>
      <text x="${W / 2}" y="${qrY + qrSize + 1.0 * DPI}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.22 * DPI}"
            fill="#6b7078">${escapeXml(sub)}</text>
      <text x="${W / 2}" y="${H - pad * 0.7}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.2 * DPI}"
            font-weight="600" fill="${accent}">${escapeXml(broker?.company || '')}</text>`;
  } else {
    const textX = pad;
    copy = `
      <rect x="0" y="0" width="${0.16 * DPI}" height="${H}" fill="${accent}"/>
      <text x="${textX + 0.16 * DPI}" y="${H * 0.36}"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.86 * DPI}"
            font-weight="700" fill="#11131a" letter-spacing="-1.5">${escapeXml(headline)}</text>
      <text x="${textX + 0.16 * DPI}" y="${H * 0.56}"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.34 * DPI}"
            fill="#5d626b">${escapeXml(sub)}</text>
      <text x="${textX + 0.16 * DPI}" y="${H * 0.80}"
            font-family="Helvetica, Arial, sans-serif" font-size="${0.3 * DPI}"
            font-weight="600" fill="${accent}">${escapeXml(
              [broker?.company, broker?.phone].filter(Boolean).join('   ·   ')
            )}</text>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${spec.widthIn}in" height="${spec.heightIn}in"
     viewBox="0 0 ${W} ${H}">
  <title>${escapeXml(listing?.name || 'Listing')} — ${escapeXml(spec.label)}</title>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${copy}
  <rect x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" fill="#ffffff"/>
  <g fill="#000000">${rects}</g>
</svg>`;
}

/** Screen-resolution PNG data URL for previewing the code in the studio. */
export async function qrDataUrl(tourUrl, source = 'sign', width = 320) {
  return QRCode.toDataURL(taggedUrl(tourUrl, source), {
    errorCorrectionLevel: 'M',
    width,
    margin: 2,
    color: { dark: '#11131aff', light: '#ffffffff' },
  });
}

/**
 * Where a tour link gets posted. Each channel gets its own tagged URL so the
 * broker can see which surface actually produced the lead — the thing that
 * justifies the renewal.
 */
export const SHARE_CHANNELS = [
  { key: 'sign', label: 'Listing sign QR', note: 'Drive-by scans. The one nobody else can measure.' },
  { key: 'costar', label: 'CoStar / LoopNet', note: 'Paste into the listing detail.' },
  { key: 'linkedin', label: 'LinkedIn', note: 'Broker post or company page.' },
  { key: 'instagram', label: 'Instagram', note: 'Bio link or story sticker.' },
  { key: 'email', label: 'Email blast', note: 'Tenant-rep and prospect sends.' },
  { key: 'flyer', label: 'Flyer / OM', note: 'PDF hyperlink or printed QR block.' },
];

export const VALID_SOURCES = new Set([...SHARE_CHANNELS.map((c) => c.key), 'direct']);

export function normaliseSource(value) {
  const key = String(value || '').toLowerCase().trim();
  return VALID_SOURCES.has(key) ? key : 'direct';
}
