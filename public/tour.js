/* Public tour viewer.
   Plays the storyboard as one continuous walkthrough, records which stops the
   prospect actually reached, and captures the lead with that history attached. */

const slug = location.pathname.split('/').filter(Boolean).pop();

/**
 * Where this visit came from. Captured once on arrival and remembered for the
 * session, because the ?src= tag is only present on the first URL — a prospect
 * who scans the sign then reloads must still count as a sign scan.
 */
function visitSource() {
  const fromUrl = new URLSearchParams(location.search).get('src');
  if (fromUrl) sessionStorage.setItem('corridor_src', fromUrl);
  return sessionStorage.getItem('corridor_src') || 'direct';
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );

// One session id per browser tab: a broker sharing their screen shouldn't
// inflate the view count, and a prospect returning later is a new session.
function sessionId() {
  let value = sessionStorage.getItem('corridor_sid');
  if (!value) {
    value = `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    sessionStorage.setItem('corridor_sid', value);
  }
  return value;
}

const seenStops = new Set();
let tour = null;
let index = 0;
let started = false;

function track(type, shotId) {
  // Fire-and-forget: analytics must never block or break playback.
  fetch(`/api/public/tours/${encodeURIComponent(slug)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, shotId, sessionId: sessionId(), source: visitSource() }),
    keepalive: true,
  }).catch(() => {});
}

async function load() {
  const res = await fetch(`/api/public/tours/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    $('#app').innerHTML =
      '<div style="padding:60px 0;text-align:center"><h1 style="font-size:22px;margin:0 0 8px">Tour not available</h1>' +
      '<p style="color:#9aa0a8">This tour is not published, or the link is wrong.</p></div>';
    return;
  }
  tour = await res.json();
  if (!tour.stops.length) {
    $('#app').innerHTML = '<div style="padding:60px 0;color:#9aa0a8">This tour has no stops yet.</div>';
    return;
  }
  paint();
  track('tour_open');
}

function paint() {
  const { listing, broker, stops } = tour;
  document.title = `${listing.name} — video tour`;

  $('#app').innerHTML = `
    <header class="top">
      <div>
        <h1>${esc(listing.name)}</h1>
        ${listing.address ? `<div class="addr">${esc(listing.address)}</div>` : ''}
        ${listing.headline ? `<div class="headline">${esc(listing.headline)}</div>` : ''}
      </div>
      ${listing.cta?.enabled !== false
        ? `<button class="btn primary" id="cta-top">${esc(listing.cta?.label || 'Request a showing')}</button>`
        : ''}
    </header>

    <div class="stage" id="stage">
      <div class="segments" id="segments">
        ${stops.map((_, i) => `<div class="seg" data-seg="${i}"><i></i></div>`).join('')}
      </div>
      <video id="video" playsinline preload="auto"
             ${stops[0].posterUrl ? `poster="${esc(stops[0].posterUrl)}"` : ''}></video>
      <div class="staged-badge" id="staged" hidden>Virtually staged</div>
      <div class="overlay">
        <div class="cap">
          <div class="stop-name" id="stop-name"></div>
          <div class="stop-sub" id="stop-sub"></div>
        </div>
        <div class="controls">
          <button class="btn" id="prev">‹ Back</button>
          <button class="btn" id="next">Next ›</button>
        </div>
      </div>
      <button class="big-play" id="big-play"><span>▶</span></button>
    </div>

    <div class="below">
      <div>
        <h3 style="font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#9aa0a8;margin:0 0 10px;font-weight:650">
          ${stops.length} stops on this tour
        </h3>
        <div class="stops" id="stops">
          ${stops.map((stop, i) => `
            <div class="stop" data-stop="${i}">
              <div class="th" ${stop.posterUrl ? `style="background-image:url('${esc(stop.posterUrl)}')"` : ''}></div>
              <div>
                <div class="nm">${esc(stop.title)}</div>
                <div class="sub">${esc(stop.caption || stop.motionLabel || '')}</div>
              </div>
              <div class="dur">${Math.round(stop.durationSec)}s</div>
            </div>`).join('')}
        </div>
      </div>

      <aside>
        ${listing.specs?.length
          ? `<div class="card"><h3>The space</h3>
              ${listing.specs.map((s) => `<div class="spec"><span class="k">${esc(s.label)}</span><span class="v">${esc(s.value)}</span></div>`).join('')}
             </div>`
          : ''}

        <div class="card broker">
          <h3>Your contact</h3>
          <div class="nm">${esc(broker.name)}</div>
          <div class="co">${esc(broker.company)}</div>
          ${broker.email ? `<a href="mailto:${esc(broker.email)}">${esc(broker.email)}</a>` : ''}
          ${broker.phone ? `<a href="tel:${esc(broker.phone)}">${esc(broker.phone)}</a>` : ''}
          ${listing.cta?.enabled !== false
            ? `<button class="btn primary" id="cta-side" style="width:100%;justify-content:center;margin-top:14px">${esc(listing.cta?.label || 'Request a showing')}</button>`
            : ''}
        </div>

        ${listing.reelUrl
          ? `<div class="card"><h3>Share</h3>
              <a class="btn" href="${esc(listing.reelUrl)}" download style="width:100%;justify-content:center">Download the full reel</a>
             </div>`
          : ''}
      </aside>
    </div>

    ${(tour.disclosures || [])
      .map((d) => `<p class="disclosure">${esc(d)}</p>`)
      .join('')}`;

  wire();
  show(0, false);
}

function wire() {
  const video = $('#video');

  $('#big-play').onclick = () => { started = true; $('#big-play').hidden = true; play(); };
  $('#next').onclick = () => show(Math.min(index + 1, tour.stops.length - 1));
  $('#prev').onclick = () => show(Math.max(index - 1, 0));

  $$('[data-stop]').forEach((node) => {
    node.onclick = () => { started = true; $('#big-play').hidden = true; show(Number(node.dataset.stop)); };
  });
  $$('[data-seg]').forEach((node) => {
    node.onclick = () => { started = true; $('#big-play').hidden = true; show(Number(node.dataset.seg)); };
  });

  video.addEventListener('ended', () => {
    if (index < tour.stops.length - 1) show(index + 1);
    else {
      track('tour_complete');
      $('#big-play').hidden = false;
      started = false;
    }
  });

  video.addEventListener('timeupdate', () => {
    const fill = $(`[data-seg="${index}"] i`);
    if (fill && video.duration) fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
  });

  ['#cta-top', '#cta-side'].forEach((sel) => {
    const node = $(sel);
    if (node) node.onclick = () => { track('cta_click'); leadForm(); };
  });

  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').innerHTML) return;
    if (e.key === 'ArrowRight') $('#next').click();
    if (e.key === 'ArrowLeft') $('#prev').click();
    if (e.key === ' ') { e.preventDefault(); video.paused ? play() : video.pause(); }
  });
}

function show(next, autoplay = true) {
  index = next;
  const stop = tour.stops[index];
  const video = $('#video');

  video.src = stop.videoUrl;
  if (stop.posterUrl) video.poster = stop.posterUrl;

  $('#stop-name').textContent = stop.title;
  $('#stop-sub').textContent = stop.caption || stop.motionLabel || '';
  $('#staged').hidden = !stop.virtuallyStaged;

  $$('.stop').forEach((node, i) => node.classList.toggle('active', i === index));
  $$('.seg').forEach((node, i) => {
    node.classList.toggle('done', i < index);
    if (i >= index) $('i', node).style.width = '0';
  });

  if (!seenStops.has(stop.id)) seenStops.add(stop.id);
  track('shot_view', stop.id); // repeat views are meaningful, so always send

  // Warm the next clip so stop-to-stop playback doesn't stall.
  const upcoming = tour.stops[index + 1];
  if (upcoming) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'video';
    link.href = upcoming.videoUrl;
    document.head.append(link);
  }

  if (autoplay && started) play();
}

function play() {
  const video = $('#video');
  video.play().catch(() => {
    // Autoplay refused (common on mobile until a gesture) — show the play button.
    $('#big-play').hidden = false;
    started = false;
  });
}

function leadForm() {
  const label = tour.listing.cta?.label || 'Request a showing';
  $('#modal-root').innerHTML = `
    <div class="modal-bg">
      <div class="modal">
        <h2>${esc(label)}</h2>
        <p class="sub">${esc(tour.broker.name)} will get back to you about ${esc(tour.listing.name)}.</p>
        <div class="err" id="lead-err" hidden></div>
        <div class="row">
          <div class="f"><label>Name</label><input id="l-name" autocomplete="name" /></div>
          <div class="f"><label>Company</label><input id="l-company" autocomplete="organization" /></div>
        </div>
        <div class="row">
          <div class="f"><label>Email</label><input id="l-email" type="email" autocomplete="email" /></div>
          <div class="f"><label>Phone</label><input id="l-phone" type="tel" autocomplete="tel" /></div>
        </div>
        <div class="f"><label>Anything specific?</label>
          <textarea id="l-message" placeholder="Timing, square footage needs, questions about the space…"></textarea></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button class="btn" id="l-cancel">Cancel</button>
          <button class="btn primary" id="l-send">Send</button>
        </div>
      </div>
    </div>`;

  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#l-cancel').onclick = close;
  $('.modal-bg').onclick = (e) => { if (e.target === e.currentTarget) close(); };
  $('#l-name').focus();

  $('#l-send').onclick = async () => {
    const button = $('#l-send');
    const error = $('#lead-err');
    button.disabled = true;
    error.hidden = true;

    try {
      const res = await fetch(`/api/public/tours/${encodeURIComponent(slug)}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#l-name').value,
          company: $('#l-company').value,
          email: $('#l-email').value,
          phone: $('#l-phone').value,
          message: $('#l-message').value,
          sessionId: sessionId(),
          source: visitSource(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send.');

      $('#modal-root').innerHTML = `
        <div class="modal-bg">
          <div class="modal" style="text-align:center">
            <div style="font-size:40px;margin-bottom:8px">✓</div>
            <h2>Thanks — that's sent.</h2>
            <p class="sub">${esc(tour.broker.name)} will be in touch shortly.</p>
            <button class="btn primary" id="l-done" style="width:100%;justify-content:center">Back to the tour</button>
          </div>
        </div>`;
      $('#l-done').onclick = close;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
    }
  };
}

load();
