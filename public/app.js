/* Corridor studio. Vanilla ES modules — no build step, no framework.
   State is deliberately small: one bootstrap payload, one listing payload,
   and a re-render on every mutation. At this scale that is faster to reason
   about than incremental DOM updates, and the panes are cheap to rebuild. */

const state = {
  boot: null,
  listingId: null,
  data: null,       // { listing, photos, shots }
  tab: 'photos',
  selectedPhotos: [],
  analytics: null,
  leads: [],
  pollTimer: null,
};

// --- tiny helpers ------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );

async function api(pathname, options = {}) {
  const res = await fetch(`/api${pathname}`, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s ease';
    setTimeout(() => node.remove(), 260);
  }, kind === 'bad' ? 7000 : 3600);
}

const fail = (err) => toast(err.message || String(err), 'bad');

function modal({ title, sub, body, confirmLabel = 'Save', onConfirm, wide }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-bg">
      <div class="modal" ${wide ? 'style="width:min(720px,100%)"' : ''}>
        <h3>${esc(title)}</h3>
        ${sub ? `<div class="sub">${sub}</div>` : ''}
        <div id="modal-body">${body}</div>
        <div class="foot">
          <button class="btn ghost" data-close>Cancel</button>
          ${onConfirm ? `<button class="btn primary" data-confirm>${esc(confirmLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; };
  $('[data-close]', root).onclick = close;
  $('.modal-bg', root).onclick = (e) => { if (e.target === e.currentTarget) close(); };

  const confirmBtn = $('[data-confirm]', root);
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      try {
        await onConfirm(root);
        close();
      } catch (err) {
        fail(err);
        confirmBtn.disabled = false;
      }
    };
  }
  return { close, root };
}

// --- bootstrap ---------------------------------------------------------------

/** Gate the studio. The public tour is never gated — only this side. */
async function ensureSignedIn() {
  const { account, authEnabled } = await api('/auth/me');
  state.account = account;
  if (account || !authEnabled) return true;

  document.body.innerHTML = `
    <div style="display:grid;place-items:center;min-height:100vh;padding:24px">
      <div style="width:min(380px,100%)">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:22px">
          <span style="color:var(--accent);font-size:22px;line-height:1">▶</span>
          <h1 style="margin:0;font-size:21px;font-weight:680;letter-spacing:-0.02em">Corridor</h1>
        </div>
        <div id="auth-err" class="callout" style="border-left-color:var(--bad);display:none"></div>
        <div class="field"><span class="label">Email</span>
          <input type="email" id="a-email" autocomplete="email" /></div>
        <div class="field"><span class="label">Password</span>
          <input type="password" id="a-password" autocomplete="current-password" /></div>
        <div id="a-extra" style="display:none">
          <div class="field"><span class="label">Your name</span><input type="text" id="a-name" /></div>
          <div class="field"><span class="label">Brokerage</span><input type="text" id="a-company" /></div>
        </div>
        <button class="btn primary" id="a-submit" style="width:100%;justify-content:center">Sign in</button>
        <div style="text-align:center;margin-top:14px">
          <button class="btn ghost sm" id="a-toggle">Create an account instead</button>
        </div>
      </div>
    </div>`;

  let mode = 'login';
  const err = document.querySelector('#auth-err');
  const submit = document.querySelector('#a-submit');

  document.querySelector('#a-toggle').onclick = () => {
    mode = mode === 'login' ? 'signup' : 'login';
    document.querySelector('#a-extra').style.display = mode === 'signup' ? 'block' : 'none';
    submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    document.querySelector('#a-toggle').textContent =
      mode === 'signup' ? 'I already have an account' : 'Create an account instead';
  };

  submit.onclick = async () => {
    submit.disabled = true;
    err.style.display = 'none';
    try {
      await api(`/auth/${mode}`, {
        method: 'POST',
        body: {
          email: document.querySelector('#a-email').value,
          password: document.querySelector('#a-password').value,
          name: document.querySelector('#a-name')?.value,
          company: document.querySelector('#a-company')?.value,
        },
      });
      location.reload();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      submit.disabled = false;
    }
  };

  document.querySelector('#a-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
  return false;
}

async function boot() {
  if (!(await ensureSignedIn())) return;
  state.boot = await api('/bootstrap');
  renderRail();
  const first = state.boot.listings[0];
  if (first) selectListing(first.id);
  else renderWelcome();
}

function renderRail() {
  const { listings, capabilities } = state.boot;

  $('#listing-list').innerHTML =
    listings
      .map(
        (l) => `
      <button class="listing-btn ${l.id === state.listingId ? 'active' : ''}" data-listing="${l.id}">
        <div class="nm">${esc(l.name)}</div>
        <div class="meta">${l.shotCount} shots · ${l.leadCount} leads${l.published ? ' · live' : ''}</div>
      </button>`
      )
      .join('') || '<div style="font-size:12.5px;color:var(--muted-2);padding:4px">No buildings yet.</div>';

  $('#capabilities').innerHTML = `
    <div class="cap"><span class="dot" style="color:${capabilities.preview ? 'var(--good)' : 'var(--bad)'}"></span>
      Preview ${capabilities.preview ? '(local, free)' : '— ffmpeg missing'}</div>
    <div class="cap"><span class="dot" style="color:${capabilities.cinematic ? 'var(--good)' : 'var(--muted-2)'}"></span>
      Cinematic ${capabilities.cinematic ? `(${esc(capabilities.model)})` : '— no API key'}</div>
    <div class="cap"><span class="dot" style="color:${capabilities.staging ? 'var(--good)' : 'var(--muted-2)'}"></span>
      Virtual staging ${capabilities.staging ? '' : '— not configured'}</div>`;
}

function renderWelcome() {
  $('#tabs').hidden = true;
  $$('.pane').forEach((p) => (p.hidden = true));
  const pane = $('#pane-welcome');
  pane.hidden = false;
  pane.innerHTML = `
    <div class="empty" style="margin-top:40px">
      <h4>Start with a building</h4>
      <p>Upload the photos you already have — exterior, lobby, floor plate, amenities — and Corridor
         sequences them into a walkthrough, assigns a camera move to each space, and gives you a
         shareable tour link that captures leads.</p>
      <button class="btn primary" id="welcome-new">Create your first building</button>
    </div>`;
  $('#welcome-new').onclick = newListingDialog;
}

// --- listing selection -------------------------------------------------------

async function selectListing(listingId) {
  state.listingId = listingId;
  state.selectedPhotos = [];
  await refresh();
  renderRail();
}

async function refresh() {
  if (!state.listingId) return;
  state.data = await api(`/listings/${state.listingId}`);
  render();
  schedulePoll();
}

/** Poll while anything is mid-render so the board updates itself. */
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const busy = (state.data?.shots || []).some(
    (s) => s.status === 'queued' || s.status === 'rendering' ||
      (s.cinematic?.requestId && !s.cinematic?.file && !s.cinematic?.error)
  );
  if (!busy) return;
  state.pollTimer = setTimeout(async () => {
    try {
      state.data = await api(`/listings/${state.listingId}`);
      render();
      schedulePoll();
    } catch { /* transient; the next user action will resync */ }
  }, 2500);
}

function render() {
  const { listing, photos, shots } = state.data;

  $('#pane-welcome').hidden = true;
  $('#tabs').hidden = false;

  $('#listing-title').textContent = listing.name;
  $('#listing-sub').innerHTML = `${esc(listing.address || 'No address set')} · <span style="color:var(--muted)">${esc(listing.propertyType)}</span>`;

  $('#c-photos').textContent = photos.length || '';
  $('#c-shots').textContent = shots.length || '';
  $('#c-leads').textContent = listing.leadCount || '';

  $('#listing-actions').innerHTML = `
    ${listing.published
      ? `<a class="btn" href="/t/${esc(listing.slug)}" target="_blank" rel="noopener">View live tour ↗</a>`
      : ''}
    <button class="btn ghost" id="act-settings">Details</button>
    <button class="btn ghost danger" id="act-delete">Delete</button>`;
  $('#act-settings').onclick = () => listingDialog(listing);
  $('#act-delete').onclick = () => deleteListing(listing);

  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.pane === state.tab));
  $$('.pane').forEach((p) => (p.hidden = true));
  const pane = $(`#pane-${state.tab}`);
  pane.hidden = false;

  ({
    photos: renderPhotos,
    board: renderBoard,
    visualize: renderVisualize,
    publish: renderPublish,
    leads: renderLeads,
    insight: renderInsight,
  })[state.tab](pane);
}

// --- photos pane -------------------------------------------------------------

function renderPhotos(pane) {
  const { photos } = state.data;
  const { spaceTypes, enhanceProfiles, capabilities } = state.boot;

  const spaceOptions = (selected) =>
    spaceTypes.map((s) => `<option value="${s.key}" ${s.key === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Photos</h3>
        <div class="hint">Corridor guesses each space from the filename. Correcting a guess changes both the
          tour order and the camera move that space gets.</div>
      </div>
      <div style="display:flex;gap:8px">
        ${photos.length ? `<button class="btn" id="select-all">${state.selectedPhotos.length ? 'Clear selection' : 'Select all'}</button>` : ''}
        ${photos.length ? '<button class="btn primary" id="build-shots">Build storyboard →</button>' : ''}
      </div>
    </div>

    <div class="dropzone" id="dropzone">
      <strong>Drop photos here, or click to choose</strong>
      <span>JPEG, PNG, WebP or HEIC · up to 25&nbsp;MB each</span>
      <input type="file" id="file-input" multiple accept="image/*" hidden />
    </div>

    ${state.selectedPhotos.length
      ? `<div class="callout" style="border-left-color:var(--accent)">
          <strong>${state.selectedPhotos.length} selected.</strong>
          Build a single shot from them —
          <button class="btn sm" id="make-shot" style="margin-left:6px">Create shot</button>
          ${state.selectedPhotos.length === 2 ? '<span style="margin-left:8px">Two photos become a seamless blend between rooms.</span>' : ''}
        </div>`
      : ''}

    <div class="photo-grid">
      ${photos
        .map(
          (p) => `
        <div class="photo-card ${state.selectedPhotos.includes(p.id) ? 'selected' : ''}" data-photo="${p.id}">
          <div class="thumb" style="background-image:url('/uploads/${esc(p.file)}')" data-pick="${p.id}">
            <div class="pick">${state.selectedPhotos.indexOf(p.id) + 1 || '✓'}</div>
            <div class="badges">
              ${p.staged ? '<span class="pill accent">Virtually staged</span>' : ''}
              ${p.enhanced ? `<span class="pill">Enhanced</span>` : ''}
            </div>
          </div>
          <div class="body">
            <div class="fname" title="${esc(p.originalName)}">${esc(p.originalName)}</div>
            <select data-space="${p.id}">${spaceOptions(p.spaceType)}</select>
            <div class="ops">
              <select data-enhance="${p.id}" style="flex:1;padding:4px 7px;font-size:12px">
                <option value="">Enhance…</option>
                ${enhanceProfiles.map((e) => `<option value="${e.key}" ${p.enhanced === e.key ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
                ${p.enhanced ? '<option value="__revert">Revert to original</option>' : ''}
              </select>
              ${capabilities.staging ? `<button class="btn sm" data-stage="${p.id}" title="Virtually stage">Stage</button>` : ''}
              <button class="btn sm danger" data-del-photo="${p.id}" title="Remove">✕</button>
            </div>
          </div>
        </div>`
        )
        .join('')}
    </div>

    ${photos.length ? '' : '<div class="empty" style="margin-top:8px"><h4>No photos yet</h4><p>Upload the marketing photos you already have. Ten to twenty covering exterior through amenities makes a strong tour.</p></div>'}`;

  wirePhotos(pane);
}

function wirePhotos(pane) {
  const input = $('#file-input', pane);
  const zone = $('#dropzone', pane);

  zone.onclick = () => input.click();
  input.onchange = () => uploadPhotos([...input.files]);

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('over'); })
  );
  zone.addEventListener('drop', (e) => uploadPhotos([...e.dataTransfer.files]));

  $$('[data-pick]', pane).forEach((node) => {
    node.onclick = () => {
      const photoId = node.dataset.pick;
      const index = state.selectedPhotos.indexOf(photoId);
      if (index === -1) state.selectedPhotos.push(photoId);
      else state.selectedPhotos.splice(index, 1);
      render();
    };
  });

  $$('[data-space]', pane).forEach((node) => {
    node.onchange = async () => {
      try {
        await api(`/photos/${node.dataset.space}`, { method: 'PATCH', body: { spaceType: node.value } });
        await refresh();
      } catch (err) { fail(err); }
    };
  });

  $$('[data-enhance]', pane).forEach((node) => {
    node.onchange = async () => {
      const value = node.value;
      if (!value) return;
      node.disabled = true;
      try {
        await api(`/photos/${node.dataset.enhance}/enhance`, {
          method: 'POST',
          body: value === '__revert' ? { revert: true } : { profile: value },
        });
        toast(value === '__revert' ? 'Reverted to the original photo.' : 'Photo enhanced.', 'good');
        await refresh();
      } catch (err) { fail(err); node.disabled = false; }
    };
  });

  $$('[data-stage]', pane).forEach((node) => {
    node.onclick = async () => {
      node.disabled = true;
      node.textContent = '…';
      try {
        await api(`/photos/${node.dataset.stage}/stage`, { method: 'POST' });
        toast('Staged. This photo is now permanently badged in the public tour.', 'good');
        await refresh();
      } catch (err) { fail(err); node.disabled = false; node.textContent = 'Stage'; }
    };
  });

  $$('[data-del-photo]', pane).forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/photos/${node.dataset.delPhoto}`, { method: 'DELETE' });
        state.selectedPhotos = state.selectedPhotos.filter((id) => id !== node.dataset.delPhoto);
        await refresh();
      } catch (err) { fail(err); }
    };
  });

  const selectAll = $('#select-all', pane);
  if (selectAll) {
    selectAll.onclick = () => {
      state.selectedPhotos = state.selectedPhotos.length ? [] : state.data.photos.map((p) => p.id);
      render();
    };
  }

  const buildShots = $('#build-shots', pane);
  if (buildShots) buildShots.onclick = autoplanDialog;

  const makeShot = $('#make-shot', pane);
  if (makeShot) makeShot.onclick = createShotDialog;
}

async function uploadPhotos(files) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;

  const form = new FormData();
  images.forEach((f) => form.append('photos', f));
  toast(`Uploading ${images.length} photo${images.length > 1 ? 's' : ''}…`);
  try {
    await api(`/listings/${state.listingId}/photos`, { method: 'POST', body: form });
    await refresh();
    toast(`${images.length} photo${images.length > 1 ? 's' : ''} added.`, 'good');
  } catch (err) { fail(err); }
}

// --- storyboard pane ---------------------------------------------------------

function renderBoard(pane) {
  const { shots } = state.data;
  const { motions, capabilities } = state.boot;

  if (!shots.length) {
    pane.innerHTML = `
      <div class="empty" style="margin-top:8px">
        <h4>No shots yet</h4>
        <p>Auto-sequence a storyboard from your photos — Corridor orders them the way a physical
           tour runs and assigns each space the camera move that suits it.</p>
        <button class="btn primary" id="board-autoplan">Auto-sequence the tour</button>
      </div>`;
    $('#board-autoplan').onclick = autoplanDialog;
    return;
  }

  const readyCount = shots.filter((s) => s.videoUrl).length;
  const motionOptions = (selected) =>
    motions.map((m) => `<option value="${m.key}" ${m.key === selected ? 'selected' : ''}>${esc(m.label)}</option>`).join('');

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Storyboard</h3>
        <div class="hint">${readyCount} of ${shots.length} shots rendered. Drag to reorder.
          Preview renders locally and free; Cinematic sends the shot to Higgsfield and spends credits.</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="render-all-preview">Render all previews</button>
        <button class="btn" id="render-all-cinematic" ${capabilities.cinematic ? '' : 'disabled title="Add Higgsfield API keys to .env"'}>Render all cinematic</button>
        <button class="btn" id="rebuild">Re-sequence</button>
      </div>
    </div>

    ${!capabilities.cinematic
      ? `<div class="callout"><strong>Cinematic rendering is off.</strong>
         Add <code>HIGGSFIELD_KEY_ID</code> and <code>HIGGSFIELD_KEY_SECRET</code> to <code>.env</code> to enable it.
         Everything else — sequencing, previews, publishing, lead capture — works without it.</div>`
      : capabilities.publicUrlIsLocal
        ? `<div class="callout"><strong>Cinematic renders need a public URL.</strong>
           Higgsfield downloads your photos over the internet, but <code>PUBLIC_URL</code> is
           <code>${esc(capabilities.publicUrl)}</code>. Point it at a tunnel before rendering cinematic.</div>`
        : ''}

    <div class="board" id="board">
      ${shots.map((shot, index) => shotRow(shot, index, motionOptions)).join('')}
    </div>`;

  wireBoard(pane);
}

function shotRow(shot, index, motionOptions) {
  const busy = shot.status === 'queued' || shot.status === 'rendering';
  const cinePending = shot.cinematic?.requestId && !shot.cinematic?.file && !shot.cinematic?.error;

  let badge = '<span class="pill">Draft</span>';
  if (busy) badge = `<span class="pill warn"><span class="spinner"></span>${shot.status === 'queued' ? 'Queued' : 'Rendering'}</span>`;
  else if (cinePending) badge = `<span class="pill warn"><span class="spinner"></span>Higgsfield: ${esc(shot.cinematic.status || 'queued')}</span>`;
  else if (shot.bestQuality === 'cinematic') badge = '<span class="pill accent">Cinematic</span>';
  else if (shot.bestQuality === 'preview') badge = '<span class="pill ok">Preview</span>';
  if (shot.status === 'failed') badge = '<span class="pill bad">Failed</span>';

  return `
    <div class="shot ${shot.motionKey === 'blend_transition' ? 'transition' : ''}" data-shot="${shot.id}" draggable="true">
      <div class="grip" title="Drag to reorder"><span class="num">${String(index + 1).padStart(2, '0')}</span></div>

      <div class="frame" ${shot.posterUrl ? `style="background-image:url('${esc(shot.posterUrl)}')"` : ''}>
        ${shot.videoUrl ? `<div class="play" data-play="${esc(shot.videoUrl)}">▶</div>` : ''}
        ${shot.motionInputs === 2 ? '<div class="stack">2 frames</div>' : ''}
      </div>

      <div class="info">
        <div class="title-row">
          <input class="title" data-title="${shot.id}" value="${esc(shot.title)}" placeholder="Untitled stop" />
          ${badge}
        </div>
        <div class="controls">
          <select data-motion="${shot.id}">${motionOptions(shot.motionKey)}</select>
          <input class="dur" type="number" min="2" max="12" step="1" value="${shot.durationSec}" data-dur="${shot.id}" title="Seconds" />
          <button class="btn ghost sm" data-prompt="${shot.id}">Prompt</button>
        </div>
        ${takeStrip(shot)}
        ${shot.error ? `<div class="err">${esc(shot.error)}</div>` : ''}
      </div>

      <div class="acts">
        <button class="btn sm" data-render="${shot.id}" data-quality="preview" ${busy ? 'disabled' : ''}>Preview</button>
        <button class="btn sm primary" data-render="${shot.id}" data-quality="cinematic" ${cinePending ? 'disabled' : ''}>Cinematic</button>
        <button class="btn sm ghost danger" data-del-shot="${shot.id}">✕</button>
      </div>
    </div>`;
}

/**
 * Take picker. Generation is unreliable per-shot, so we render several and let
 * the operator pick — this strip is the QC step that keeps a hallucinated
 * facade from reaching a broker.
 */
function takeStrip(shot) {
  const takes = shot.takes || [];
  if (takes.length < 2) return '';

  const done = takes.filter((t) => t.file).length;
  const failed = takes.filter((t) => t.error).length;

  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px">
      <span class="label" style="letter-spacing:.1em">Takes ${done}/${takes.length}${failed ? ` · ${failed} failed` : ''}</span>
      ${takes
        .map((take, i) => {
          const selected = shot.selectedTakeId === take.id;
          if (take.error) {
            return `<span class="pill bad" title="${esc(take.error)}">${i + 1} ✕</span>`;
          }
          if (!take.file) {
            return `<span class="pill warn"><span class="spinner"></span>${i + 1}</span>`;
          }
          return `<button class="btn sm ${selected ? 'primary' : ''}"
                    data-take="${take.id}" data-take-shot="${shot.id}"
                    data-take-url="${esc(`/renders/${take.file}`)}"
                    title="Preview take ${i + 1}${selected ? ' (in use)' : ''}"
                    style="padding:3px 9px">${i + 1}${selected ? ' ✓' : ''}</button>`;
        })
        .join('')}
    </div>`;
}

function wireBoard(pane) {
  $$('[data-take]', pane).forEach((node) => {
    // Click previews the take in the shot's frame; click again to select it.
    node.onclick = async () => {
      const row = node.closest('.shot');
      const frame = $('.frame', row);
      if (node.dataset.previewing === '1') {
        try {
          await api(`/shots/${node.dataset.takeShot}/select-take`, {
            method: 'POST',
            body: { takeId: node.dataset.take },
          });
          toast('Take selected — it will be used in the tour and reel.', 'good');
          await refresh();
        } catch (err) { fail(err); }
        return;
      }
      $$('[data-take]', row).forEach((b) => (b.dataset.previewing = '0'));
      node.dataset.previewing = '1';
      frame.innerHTML = `<video src="${node.dataset.takeUrl}" controls autoplay playsinline
                          style="width:100%;height:100%;object-fit:cover"></video>`;
      toast('Playing this take. Click it again to use it.');
    };
  });

  $('#render-all-preview', pane)?.addEventListener('click', () => renderAll('preview'));
  $('#render-all-cinematic', pane)?.addEventListener('click', () => confirmCinematicBatch());
  $('#rebuild', pane)?.addEventListener('click', autoplanDialog);

  $$('[data-play]', pane).forEach((node) => {
    node.onclick = () => {
      const frame = node.closest('.frame');
      frame.innerHTML = `<video src="${node.dataset.play}" controls autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video>`;
    };
  });

  $$('[data-title]', pane).forEach((node) => {
    node.onchange = () => patchShot(node.dataset.title, { title: node.value });
  });
  $$('[data-motion]', pane).forEach((node) => {
    node.onchange = () => patchShot(node.dataset.motion, { motionKey: node.value }, true);
  });
  $$('[data-dur]', pane).forEach((node) => {
    node.onchange = () => patchShot(node.dataset.dur, { durationSec: Number(node.value) });
  });

  $$('[data-prompt]', pane).forEach((node) => {
    node.onclick = async () => {
      try {
        const { prompt, motion, model } = await api(`/shots/${node.dataset.prompt}/prompt`);
        const shot = state.data.shots.find((s) => s.id === node.dataset.prompt);
        modal({
          title: 'Generation prompt',
          sub: `Sent to Higgsfield <strong>${esc(model)}</strong> with the <strong>${esc(motion)}</strong> camera move. Edit the direction below to steer it.`,
          wide: true,
          body: `
            <pre class="prompt">${esc(prompt)}</pre>
            <div class="field" style="margin-top:16px">
              <span class="label">Extra direction (optional)</span>
              <textarea id="m-direction" placeholder="e.g. hold on the window line, end centred on the reception desk">${esc(shot.direction || '')}</textarea>
            </div>
            <div class="field">
              <span class="label">Or replace the prompt entirely</span>
              <textarea id="m-override" placeholder="Leave blank to use the generated prompt above">${esc(shot.promptOverride || '')}</textarea>
            </div>`,
          confirmLabel: 'Save direction',
          onConfirm: async (root) => {
            await patchShot(shot.id, {
              direction: $('#m-direction', root).value,
              promptOverride: $('#m-override', root).value,
            });
          },
        });
      } catch (err) { fail(err); }
    };
  });

  $$('[data-render]', pane).forEach((node) => {
    node.onclick = async () => {
      const quality = node.dataset.quality;
      if (quality === 'cinematic') return confirmCinematic(node.dataset.render);
      node.disabled = true;
      try {
        await api(`/shots/${node.dataset.render}/render`, { method: 'POST', body: { quality } });
        await refresh();
      } catch (err) { fail(err); node.disabled = false; }
    };
  });

  $$('[data-del-shot]', pane).forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/shots/${node.dataset.delShot}`, { method: 'DELETE' });
        await refresh();
      } catch (err) { fail(err); }
    };
  });

  wireDragReorder(pane);
}

function wireDragReorder(pane) {
  let dragged = null;
  $$('.shot', pane).forEach((row) => {
    row.addEventListener('dragstart', () => { dragged = row; row.classList.add('dragging'); });
    row.addEventListener('dragend', async () => {
      row.classList.remove('dragging');
      $$('.shot', pane).forEach((r) => r.classList.remove('drop-target'));
      const orderedIds = $$('.shot', pane).map((r) => r.dataset.shot);
      try {
        await api('/shots/reorder', { method: 'POST', body: { orderedIds } });
        await refresh();
      } catch (err) { fail(err); }
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragged || dragged === row) return;
      row.classList.add('drop-target');
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  });
}

async function patchShot(shotId, body, hard = false) {
  try {
    await api(`/shots/${shotId}`, { method: 'PATCH', body });
    if (hard) await refresh();
    else {
      const shot = state.data.shots.find((s) => s.id === shotId);
      Object.assign(shot, body);
    }
  } catch (err) { fail(err); }
}

async function renderAll(quality) {
  try {
    const result = await api(`/listings/${state.listingId}/render-all`, { method: 'POST', body: { quality } });
    toast(`${result.submitted} shot${result.submitted === 1 ? '' : 's'} submitted.`, 'good');
    const errors = result.results.filter((r) => !r.ok);
    if (errors.length) toast(`${errors.length} could not start: ${errors[0].error}`, 'bad');
    await refresh();
  } catch (err) { fail(err); }
}

function confirmCinematic(shotId) {
  modal({
    title: 'Render in Cinematic quality?',
    sub: 'Sends the shot to Higgsfield and spends credits. Preview renders are free and stay local.',
    body: `
      <div style="font-size:13.5px;color:var(--muted);line-height:1.65;margin-bottom:16px">
        Roughly 2 shots in 5 come back with a defect — invented signage, an inverted camera move.
        Generating several takes and keeping the best one is the cheapest fix there is: at 5 credits
        a take, three takes turn a ~8% chance of a clean five-shot tour into ~73%.
      </div>
      <div class="field">
        <span class="label">Takes to generate</span>
        <select id="m-takes">
          <option value="1">1 take — 5 credits (not recommended)</option>
          <option value="2">2 takes — 10 credits</option>
          <option value="3" selected>3 takes — 15 credits (recommended)</option>
          <option value="4">4 takes — 20 credits</option>
        </select>
      </div>`,
    confirmLabel: 'Send to Higgsfield',
    onConfirm: async (root) => {
      await api(`/shots/${shotId}/render`, {
        method: 'POST',
        body: { quality: 'cinematic', takes: Number($('#m-takes', root).value) },
      });
      toast('Submitted. Takes appear on the board as they land.', 'good');
      await refresh();
    },
  });
}

function confirmCinematicBatch() {
  const count = state.data.shots.filter((s) => s.photoIds?.length).length;
  modal({
    title: `Render ${count} shots in Cinematic quality?`,
    sub: 'Every shot is submitted to Higgsfield and each one spends credits.',
    body: '<div style="font-size:13.5px;color:var(--muted);line-height:1.6">If you are still deciding the cut, render previews first — they are free — and upgrade only the shots that make the final tour.</div>',
    confirmLabel: `Send ${count} shots`,
    onConfirm: () => renderAll('cinematic'),
  });
}

// --- dialogs -----------------------------------------------------------------

function newListingDialog() {
  modal({
    title: 'New building',
    body: `
      <div class="field"><span class="label">Building name</span>
        <input type="text" id="f-name" placeholder="1011 Commerce Center" /></div>
      <div class="field"><span class="label">Address</span>
        <input type="text" id="f-address" placeholder="1011 Michigan Ave, Grand Rapids, MI" /></div>
      <div class="field"><span class="label">Property type</span>
        <select id="f-type">
          <option value="office">Office</option>
          <option value="industrial">Industrial / Flex</option>
          <option value="retail">Retail</option>
          <option value="medical">Medical Office</option>
          <option value="mixed-use">Mixed Use</option>
        </select></div>`,
    confirmLabel: 'Create',
    onConfirm: async (root) => {
      const listing = await api('/listings', {
        method: 'POST',
        body: {
          name: $('#f-name', root).value,
          address: $('#f-address', root).value,
          propertyType: $('#f-type', root).value,
        },
      });
      state.boot = await api('/bootstrap');
      state.tab = 'photos';
      await selectListing(listing.id);
    },
  });
}

function listingDialog(listing) {
  modal({
    title: 'Building details',
    body: `
      <div class="field"><span class="label">Name</span><input type="text" id="f-name" value="${esc(listing.name)}" /></div>
      <div class="field"><span class="label">Address</span><input type="text" id="f-address" value="${esc(listing.address)}" /></div>
      <div class="field"><span class="label">Headline shown on the tour</span>
        <input type="text" id="f-headline" value="${esc(listing.headline)}" placeholder="24,000 SF available · Q1 occupancy" /></div>`,
    onConfirm: async (root) => {
      await api(`/listings/${listing.id}`, {
        method: 'PATCH',
        body: {
          name: $('#f-name', root).value,
          address: $('#f-address', root).value,
          headline: $('#f-headline', root).value,
        },
      });
      state.boot = await api('/bootstrap');
      renderRail();
      await refresh();
    },
  });
}

async function deleteListing(listing) {
  modal({
    title: `Delete ${listing.name}?`,
    sub: 'This removes its photos, shots, leads and analytics. It cannot be undone.',
    body: '',
    confirmLabel: 'Delete building',
    onConfirm: async () => {
      await api(`/listings/${listing.id}`, { method: 'DELETE' });
      state.boot = await api('/bootstrap');
      state.listingId = null;
      state.data = null;
      renderRail();
      if (state.boot.listings[0]) await selectListing(state.boot.listings[0].id);
      else renderWelcome();
    },
  });
}

function autoplanDialog() {
  modal({
    title: 'Auto-sequence the tour',
    sub: 'Orders your photos the way a walkthrough actually runs — exterior, entrance, lobby, corridor, floor plate, amenities, rooftop — and gives each space the camera move that suits it.',
    body: `
      <label style="display:flex;gap:9px;align-items:flex-start;font-size:13.5px;margin-bottom:12px;cursor:pointer">
        <input type="checkbox" id="f-transitions" checked style="width:auto;margin-top:3px" />
        <span><strong>Weave in blend transitions</strong><br />
        <span style="color:var(--muted-2)">Adds a two-photo shot between rooms so the tour reads as one continuous walk instead of a slideshow. Roughly doubles the shot count.</span></span>
      </label>
      <label style="display:flex;gap:9px;align-items:flex-start;font-size:13.5px;cursor:pointer">
        <input type="checkbox" id="f-replace" checked style="width:auto;margin-top:3px" />
        <span><strong>Replace the current storyboard</strong><br />
        <span style="color:var(--muted-2)">Uncheck to append instead. Replacing discards existing renders.</span></span>
      </label>`,
    confirmLabel: 'Sequence tour',
    onConfirm: async (root) => {
      const shots = await api(`/listings/${state.listingId}/autoplan`, {
        method: 'POST',
        body: {
          withTransitions: $('#f-transitions', root).checked,
          replace: $('#f-replace', root).checked,
        },
      });
      state.tab = 'board';
      await refresh();
      toast(`${shots.length} shots sequenced. Render previews to see the cut.`, 'good');
    },
  });
}

function createShotDialog() {
  const { motions } = state.boot;
  const count = state.selectedPhotos.length;
  const usable = motions.filter((m) => m.inputs <= count);

  modal({
    title: `New shot from ${count} photo${count > 1 ? 's' : ''}`,
    body: `
      <div class="field"><span class="label">Camera move</span>
        <select id="f-motion">
          ${usable.map((m) => `<option value="${m.key}">${esc(m.label)} — ${esc(m.tagline)}</option>`).join('')}
        </select></div>
      <div class="field"><span class="label">Title</span>
        <input type="text" id="f-title" placeholder="Reception" /></div>
      <div id="motion-note" style="font-size:12.5px;color:var(--muted-2);line-height:1.6"></div>`,
    confirmLabel: 'Add shot',
    onConfirm: async (root) => {
      await api(`/listings/${state.listingId}/shots`, {
        method: 'POST',
        body: {
          photoIds: state.selectedPhotos,
          motionKey: $('#f-motion', root).value,
          title: $('#f-title', root).value,
        },
      });
      state.selectedPhotos = [];
      state.tab = 'board';
      await refresh();
    },
  });

  const select = $('#f-motion');
  const note = $('#motion-note');
  const showNote = () => {
    const motion = motions.find((m) => m.key === select.value);
    note.textContent = motion?.description || '';
  };
  select.onchange = showNote;
  showNote();
}

function brokerDialog() {
  const broker = state.boot.broker;
  modal({
    title: 'Brokerage details',
    sub: 'Shown on every published tour and attached to every lead.',
    body: `
      <div class="grid-2">
        <div class="field"><span class="label">Your name</span><input type="text" id="b-name" value="${esc(broker.name)}" /></div>
        <div class="field"><span class="label">Company</span><input type="text" id="b-company" value="${esc(broker.company)}" /></div>
        <div class="field"><span class="label">Email</span><input type="email" id="b-email" value="${esc(broker.email)}" /></div>
        <div class="field"><span class="label">Phone</span><input type="tel" id="b-phone" value="${esc(broker.phone)}" /></div>
      </div>
      <div class="field"><span class="label">Logo URL (optional)</span><input type="text" id="b-logo" value="${esc(broker.logoUrl)}" placeholder="https://…" /></div>`,
    onConfirm: async (root) => {
      state.boot.broker = await api('/broker', {
        method: 'PUT',
        body: {
          name: $('#b-name', root).value,
          company: $('#b-company', root).value,
          email: $('#b-email', root).value,
          phone: $('#b-phone', root).value,
          logoUrl: $('#b-logo', root).value,
        },
      });
      toast('Saved.', 'good');
    },
  });
}

// --- visualize pane ----------------------------------------------------------
// Second workflow, not the product. Video tours sell the building as it is;
// this answers "could this work for us?" with a picture instead of a paragraph.

async function renderVisualize(pane) {
  const { visualizeModes, visualStyles, imageModels, capabilities } = state.boot;
  const mode = state.visualMode || 'fitout';
  const spec = visualizeModes.find((m) => m.key === mode) || visualizeModes[0];

  let visuals = [];
  try {
    ({ visuals } = await api(`/listings/${state.listingId}/visuals`));
  } catch { /* first load */ }
  $('#c-visuals').textContent = visuals.length || '';

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Visualize</h3>
        <div class="hint">Show a client what a space could become. Concepts are clearly labelled as
          concepts — they never present as photographs of the property.</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:22px">
      ${visualizeModes
        .map(
          (m) => `
        <button class="btn" data-mode="${m.key}"
          style="flex-direction:column;align-items:flex-start;gap:5px;padding:14px;height:100%;text-align:left;white-space:normal;
                 ${m.key === mode ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
          <span style="font-weight:620;font-size:13.5px${m.key === mode ? ';color:var(--accent)' : ''}">${esc(m.label)}</span>
          <span style="font-size:12px;color:var(--muted-2);line-height:1.45;font-weight:400">${esc(m.blurb)}</span>
        </button>`
        )
        .join('')}
    </div>

    <div class="grid-2" style="align-items:start">
      <div>
        <div class="field"><span class="label">Character</span>
          <select id="v-style">
            ${Object.entries(visualStyles)
              .map(([key, s]) => `<option value="${key}" ${key === (state.visualStyle || 'modern') ? 'selected' : ''}>${esc(s.label)}</option>`)
              .join('')}
          </select></div>

        <div class="field"><span class="label">Direction (optional)</span>
          <textarea id="v-notes" placeholder="e.g. glass-fronted offices along the window line, warm lighting, planting">${esc(state.visualNotes || '')}</textarea></div>

        <div class="grid-2">
          <div class="field"><span class="label">Variants per photo</span>
            <select id="v-variants">
              ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}
            </select></div>
          <div class="field"><span class="label">Quality</span>
            <select id="v-quality">
              ${Object.entries(imageModels).map(([key, m]) => `<option value="${key}">${esc(m.label)}</option>`).join('')}
            </select></div>
        </div>

        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn" id="v-plan">Estimate cost</button>
          <button class="btn primary" id="v-run" ${capabilities.cinematic ? '' : 'disabled title="Add Higgsfield API keys to .env"'}>
            ${esc(spec.label)}
          </button>
        </div>
        <div id="v-estimate" style="margin-top:12px"></div>
      </div>

      <div>
        <div class="callout" style="border-left-color:var(--accent)">
          <strong>${esc(spec.disclosureLabel)}.</strong>
          Every image produced here is labelled with this wherever it appears. ${
            spec.preserveArchitecture
              ? 'Walls, windows, columns and ceiling height are preserved — only finishes, furniture and lighting change.'
              : 'No building exists yet, so this renders as an architectural concept rather than a photograph.'
          }
        </div>
        ${!capabilities.cinematic
          ? '<div class="callout"><strong>Image generation needs API keys.</strong> Add <code>HIGGSFIELD_KEY_ID</code> and <code>HIGGSFIELD_KEY_SECRET</code> to <code>.env</code>.</div>'
          : ''}
      </div>
    </div>

    ${visuals.length
      ? `<div class="section-head" style="margin-top:30px"><div><h3>Concepts</h3>
           <div class="hint">Download and share with clients. Each carries its disclosure label.</div></div></div>
         <div class="photo-grid">
           ${visuals
             .map(
               (v) => `
             <div class="photo-card">
               <div class="thumb" ${v.file ? `style="background-image:url('/renders/${esc(v.file)}')"` : ''}>
                 ${!v.file && !v.error ? '<div style="position:absolute;inset:0;display:grid;place-items:center"><span class="spinner"></span></div>' : ''}
                 <div class="badges"><span class="pill accent">${esc(v.disclosureLabel || 'Concept')}</span></div>
               </div>
               <div class="body">
                 <div class="fname" title="${esc(v.title)}">${esc(v.title)}</div>
                 ${v.error ? `<div class="err" style="font-size:11.5px">${esc(v.error)}</div>` : ''}
                 <div class="ops">
                   ${v.file ? `<a class="btn sm" href="/renders/${esc(v.file)}" download style="flex:1;justify-content:center">Download</a>` : ''}
                   <button class="btn sm danger" data-del-visual="${v.id}">✕</button>
                 </div>
               </div>
             </div>`
             )
             .join('')}
         </div>`
      : '<div class="empty" style="margin-top:24px"><h4>No concepts yet</h4><p>Pick what you want to show a client above, then generate. Images cost 1–7 credits each, so exploring options is cheap.</p></div>'}`;

  wireVisualize(pane, visuals);
}

function wireVisualize(pane, visuals) {
  $$('[data-mode]', pane).forEach((node) => {
    node.onclick = () => { state.visualMode = node.dataset.mode; render(); };
  });

  const collect = () => ({
    mode: state.visualMode || 'fitout',
    style: $('#v-style', pane).value,
    notes: $('#v-notes', pane).value.split('\n').map((n) => n.trim()).filter(Boolean),
    variants: Number($('#v-variants', pane).value),
    quality: $('#v-quality', pane).value,
  });

  $('#v-plan', pane).onclick = async () => {
    try {
      const plan = await api(`/listings/${state.listingId}/visualize/plan`, { method: 'POST', body: collect() });
      $('#v-estimate', pane).innerHTML = `
        <div class="stat" style="padding:12px 14px">
          <div style="font-size:13.5px"><strong>${plan.estimate.images}</strong> image${plan.estimate.images === 1 ? '' : 's'}
            · <strong>${plan.estimate.totalCredits}</strong> credits (~$${plan.estimate.approxUsd})</div>
          ${plan.warnings.length ? `<div class="note" style="color:var(--warn)">${plan.warnings.map(esc).join('<br>')}</div>` : ''}
          ${plan.withinBudget ? '' : `<div class="note" style="color:var(--bad)">${esc(plan.budgetMessage)}</div>`}
        </div>`;
    } catch (err) { fail(err); }
  };

  $('#v-run', pane).onclick = async () => {
    const body = collect();
    let plan;
    try {
      plan = await api(`/listings/${state.listingId}/visualize/plan`, { method: 'POST', body });
    } catch (err) { return fail(err); }

    modal({
      title: `Generate ${plan.estimate.images} image${plan.estimate.images === 1 ? '' : 's'}?`,
      sub: `${plan.estimate.totalCredits} credits (~$${plan.estimate.approxUsd}) using ${esc(plan.estimate.model)}.`,
      body: `<div style="font-size:13.5px;color:var(--muted);line-height:1.6">
        Every image is permanently labelled for the client. Failed generations are refunded.</div>`,
      confirmLabel: 'Generate',
      onConfirm: async () => {
        const result = await api(`/listings/${state.listingId}/visualize`, { method: 'POST', body });
        toast(`${result.created} image${result.created === 1 ? '' : 's'} submitted.`, 'good');
        render();
        // Images finish fast; refresh the grid a few times rather than polling forever.
        [4000, 9000, 15000].forEach((ms) => setTimeout(() => state.tab === 'visualize' && render(), ms));
      },
    });
  };

  $$('[data-del-visual]', pane).forEach((node) => {
    node.onclick = async () => {
      try {
        await api(`/listings/${state.listingId}/visuals/${node.dataset.delVisual}`, { method: 'DELETE' });
        render();
      } catch (err) { fail(err); }
    };
  });
}

// --- publish pane ------------------------------------------------------------

function renderPublish(pane) {
  const { listing, shots } = state.data;
  const ready = shots.filter((s) => s.videoUrl).length;
  const tourUrl = `${state.boot.capabilities.publicUrl}/t/${listing.slug}`;
  const specs = listing.specs || [];

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Publish</h3>
        <div class="hint">A published tour is a public link — no login for the prospect. Every view and
          every stop they reach is recorded against their session.</div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="v">${ready}</div><div class="k">Shots ready</div></div>
      <div class="stat"><div class="v">${listing.published ? 'Live' : 'Draft'}</div><div class="k">Status</div></div>
      <div class="stat"><div class="v">${listing.leadCount}</div><div class="k">Leads captured</div></div>
    </div>

    ${ready === 0 ? '<div class="callout"><strong>Nothing to publish yet.</strong> Render at least one shot on the Storyboard tab.</div>' : ''}

    <div class="grid-2" style="align-items:start">
      <div>
        <div class="field"><span class="label">Headline</span>
          <input type="text" id="p-headline" value="${esc(listing.headline)}" placeholder="24,000 SF available · Q1 occupancy" /></div>

        <div class="field">
          <span class="label">Key specs</span>
          <div id="spec-rows">
            ${specs.map((s, i) => specRow(s, i)).join('')}
          </div>
          <button class="btn sm" id="add-spec" style="align-self:flex-start">+ Add spec</button>
        </div>

        <div class="field"><span class="label">Call to action</span>
          <input type="text" id="p-cta" value="${esc(listing.cta?.label || 'Request a showing')}" /></div>
      </div>

      <div>
        <div class="field">
          <span class="label">Shareable link</span>
          <div style="display:flex;gap:8px">
            <input type="text" readonly value="${esc(tourUrl)}" id="p-url" />
            <button class="btn" id="copy-url">Copy</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          <button class="btn ${listing.published ? '' : 'primary'}" id="toggle-publish" ${ready === 0 && !listing.published ? 'disabled' : ''}>
            ${listing.published ? 'Unpublish' : 'Publish tour'}
          </button>
          ${listing.published ? `<a class="btn" href="/t/${esc(listing.slug)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
        </div>

        <div class="field">
          <span class="label">Export</span>
          <div style="font-size:12.5px;color:var(--muted-2);margin-bottom:8px;line-height:1.55">
            Stitch every rendered shot, in storyboard order, into one MP4 for LoopNet, LinkedIn or an email blast.
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="build-reel" ${ready === 0 ? 'disabled' : ''}>Build reel</button>
            ${listing.reelFile ? `<a class="btn" href="/renders/${esc(listing.reelFile)}" download>Download MP4</a>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:30px">
      <div>
        <h3>Sign kit</h3>
        <div class="hint">Every link below is tagged, so a scan from the sign in the ground is never
          confused with a click from LinkedIn. The sign row is the only lead source in CRE that is
          otherwise completely invisible.</div>
      </div>
    </div>
    <div id="signkit">
      <div style="color:var(--muted-2);font-size:13px">Loading sign kit…</div>
    </div>`;

  wirePublish(pane);
  renderSignKit(pane).catch(fail);
}

async function renderSignKit(pane) {
  const host = $('#signkit', pane);
  if (!host) return;
  const kit = await api(`/listings/${state.listingId}/signkit`);

  host.innerHTML = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:start">
      <div style="text-align:center">
        <img src="${kit.qrPreview}" alt="Tour QR code" width="180" height="180"
             style="border-radius:10px;display:block;background:#fff;padding:8px" />
        <div style="font-size:11.5px;color:var(--muted-2);margin-top:8px">Points at <code>?src=sign</code></div>
      </div>

      <div>
        <div class="label" style="margin-bottom:8px">Print-ready assets</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          ${kit.formats
            .map(
              (f) => `<a class="btn sm" href="/api/listings/${state.listingId}/sign.svg?format=${f.key}"
                        title="${esc(f.note)}">${esc(f.label)} · ${f.widthIn}×${f.heightIn}in</a>`
            )
            .join('')}
        </div>
        <div style="font-size:12px;color:var(--muted-2);line-height:1.55;margin-bottom:18px">
          Vector SVG — scales to any sign size without resampling, and every print shop accepts it.
          QR error correction is set to ~15% damage tolerance, which is what an outdoor post through a
          winter actually needs.
        </div>

        <div class="label" style="margin-bottom:8px">Tagged links per channel</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${kit.links
            .map(
              (l) => `
            <div style="display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:center">
              <div style="font-size:13px;font-weight:550">${esc(l.label)}</div>
              <input type="text" readonly value="${esc(l.url)}" data-link="${l.key}"
                     style="font-size:11.5px;padding:5px 8px;font-family:var(--mono)" />
              <button class="btn sm" data-copy-link="${l.key}">Copy</button>
            </div>`
            )
            .join('')}
        </div>
      </div>
    </div>

    ${!kit.published
      ? '<div class="callout" style="margin-top:16px"><strong>Tour is not published yet.</strong> These links will 404 for anyone who scans them until you publish.</div>'
      : ''}`;

  $$('[data-copy-link]', host).forEach((node) => {
    node.onclick = async () => {
      const input = $(`[data-link="${node.dataset.copyLink}"]`, host);
      try {
        await navigator.clipboard.writeText(input.value);
        toast('Link copied.', 'good');
      } catch {
        input.select();
        toast('Press ⌘C to copy.');
      }
    };
  });
}

function specRow(spec = { label: '', value: '' }, index) {
  return `
    <div class="spec-row" data-spec-row="${index}">
      <input type="text" placeholder="Available SF" value="${esc(spec.label)}" data-spec-label="${index}" />
      <input type="text" placeholder="24,000" value="${esc(spec.value)}" data-spec-value="${index}" />
      <button class="btn sm ghost danger" data-spec-del="${index}">✕</button>
    </div>`;
}

function wirePublish(pane) {
  const { listing } = state.data;

  const collectSpecs = () =>
    $$('[data-spec-row]', pane).map((row) => ({
      label: $('[data-spec-label]', row).value,
      value: $('[data-spec-value]', row).value,
    })).filter((s) => s.label || s.value);

  const persist = async () => {
    await api(`/listings/${listing.id}`, {
      method: 'PATCH',
      body: {
        headline: $('#p-headline', pane).value,
        specs: collectSpecs(),
        cta: { ...(listing.cta || {}), label: $('#p-cta', pane).value, enabled: true },
      },
    });
  };

  ['#p-headline', '#p-cta'].forEach((sel) => {
    $(sel, pane).onchange = () => persist().then(refresh).catch(fail);
  });
  $$('[data-spec-label], [data-spec-value]', pane).forEach((node) => {
    node.onchange = () => persist().catch(fail);
  });
  $$('[data-spec-del]', pane).forEach((node) => {
    node.onclick = async () => {
      node.closest('[data-spec-row]').remove();
      await persist().catch(fail);
      await refresh();
    };
  });

  $('#add-spec', pane).onclick = async () => {
    const specs = [...collectSpecs(), { label: '', value: '' }];
    await api(`/listings/${listing.id}`, { method: 'PATCH', body: { specs } });
    await refresh();
  };

  $('#copy-url', pane).onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#p-url', pane).value);
      toast('Link copied.', 'good');
    } catch {
      $('#p-url', pane).select();
      toast('Press ⌘C to copy.');
    }
  };

  $('#toggle-publish', pane).onclick = async () => {
    try {
      const result = await api(`/listings/${listing.id}/publish`, {
        method: 'POST',
        body: { published: !listing.published },
      });
      toast(result.published ? 'Tour is live.' : 'Tour unpublished.', 'good');
      state.boot = await api('/bootstrap');
      renderRail();
      await refresh();
    } catch (err) { fail(err); }
  };

  $('#build-reel', pane).onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Stitching…';
    try {
      const result = await api(`/listings/${listing.id}/reel`, { method: 'POST' });
      toast(`Reel built from ${result.clips} shots.`, 'good');
      await refresh();
    } catch (err) { fail(err); e.target.disabled = false; e.target.textContent = 'Build reel'; }
  };
}

// --- leads pane --------------------------------------------------------------

async function renderLeads(pane) {
  pane.innerHTML = '<div style="color:var(--muted-2);font-size:13px">Loading…</div>';
  let leads = [];
  try {
    leads = await api(`/listings/${state.listingId}/leads`);
  } catch (err) { return fail(err); }

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Leads</h3>
        <div class="hint">Captured from the public tour. "Stops viewed" tells you how much of the building
          they actually watched before reaching out — the warmest leads finish the tour first.</div>
      </div>
      ${leads.length ? '<button class="btn" id="export-csv">Export CSV</button>' : ''}
    </div>

    ${leads.length === 0
      ? '<div class="empty"><h4>No leads yet</h4><p>Publish the tour and share the link. Prospects who fill in the form land here with their viewing history attached.</p></div>'
      : `<table class="leads">
          <thead><tr>
            <th>Name</th><th>Company</th><th>Contact</th><th>Engagement</th><th>Message</th><th>When</th>
          </tr></thead>
          <tbody>
            ${leads.map((lead) => `
              <tr>
                <td><strong>${esc(lead.name)}</strong></td>
                <td>${esc(lead.company) || '—'}</td>
                <td><a href="mailto:${esc(lead.email)}" style="color:var(--accent)">${esc(lead.email)}</a>
                    ${lead.phone ? `<div style="color:var(--muted-2);font-size:12px">${esc(lead.phone)}</div>` : ''}</td>
                <td>${lead.stopsViewed || 0} stops
                    ${lead.completedTour ? '<div><span class="pill ok" style="margin-top:4px">Finished tour</span></div>' : ''}</td>
                <td class="msg">${esc(lead.message) || '—'}</td>
                <td style="color:var(--muted-2);font-size:12.5px;white-space:nowrap">${new Date(lead.createdAt).toLocaleDateString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}`;

  const exportBtn = $('#export-csv', pane);
  if (exportBtn) {
    exportBtn.onclick = () => {
      const header = ['Name', 'Company', 'Email', 'Phone', 'Stops viewed', 'Finished tour', 'Message', 'Date'];
      const rows = leads.map((l) => [
        l.name, l.company, l.email, l.phone, l.stopsViewed || 0,
        l.completedTour ? 'yes' : 'no', l.message, l.createdAt,
      ]);
      const csv = [header, ...rows]
        .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
        .join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = Object.assign(document.createElement('a'), {
        href: url, download: `${state.data.listing.slug}-leads.csv`,
      });
      link.click();
      URL.revokeObjectURL(url);
    };
  }
}

// --- engagement pane ---------------------------------------------------------

async function renderInsight(pane) {
  pane.innerHTML = '<div style="color:var(--muted-2);font-size:13px">Loading…</div>';
  let stats;
  try {
    stats = await api(`/listings/${state.listingId}/analytics`);
  } catch (err) { return fail(err); }

  const maxReached = Math.max(1, ...stats.perShot.map((s) => s.reached));

  pane.innerHTML = `
    <div class="section-head">
      <div>
        <h3>Engagement</h3>
        <div class="hint">Where prospects lose interest is the most actionable thing here — a stop that
          loses most of its audience is usually the wrong photo or the wrong camera move, not the wrong space.</div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="v">${stats.sessions}</div><div class="k">Unique viewers</div></div>
      <div class="stat"><div class="v">${stats.completionRate}%</div><div class="k">Finished the tour</div></div>
      <div class="stat"><div class="v">${stats.ctaClicks}</div><div class="k">CTA clicks</div></div>
      <div class="stat"><div class="v">${stats.leads}</div><div class="k">Leads</div>
        ${stats.sessions ? `<div class="note">${Math.round((stats.leads / stats.sessions) * 100)}% of viewers converted</div>` : ''}</div>
    </div>

    ${stats.biggestDropOff
      ? `<div class="callout"><strong>Biggest drop-off: “${esc(stats.biggestDropOff.title)}”.</strong>
         Most viewers who reach the preceding stop do not get past this one. Try a different photo,
         a shorter duration, or moving it later in the sequence.</div>`
      : ''}

    ${stats.sources?.length
      ? `<div class="section-head" style="margin-top:26px"><div><h3>Where they came from</h3>
           <div class="hint">Sign scans are the row worth watching — a drive-by who reads a sign and
             leaves is invisible to every other tool in CRE.</div></div></div>
         <table class="leads" style="margin-bottom:8px">
           <thead><tr><th>Channel</th><th>Viewers</th><th>Leads</th><th>Conversion</th></tr></thead>
           <tbody>
             ${stats.sources.map((s) => `
               <tr>
                 <td><strong>${esc(s.source === 'sign' ? 'Listing sign QR' : s.source)}</strong></td>
                 <td>${s.sessions}</td>
                 <td>${s.leads}</td>
                 <td>${s.conversion}%</td>
               </tr>`).join('')}
           </tbody>
         </table>`
      : ''}

    ${stats.sessions === 0
      ? '<div class="empty"><h4>No views yet</h4><p>Share the tour link. Viewer sessions, per-stop attention and drop-off appear here as people watch.</p></div>'
      : `<div class="section-head" style="margin-top:26px"><div><h3>Attention by stop</h3>
           <div class="hint">Bars show how many viewers reached each stop. The number in brackets rewatched it.</div></div></div>
         <div class="bars">
           ${stats.perShot.map((s) => `
             <div class="bar-row">
               <div class="nm" title="${esc(s.title)}">${esc(s.title)}</div>
               <div class="bar-track"><div class="bar-fill" style="width:${Math.round((s.reached / maxReached) * 100)}%"></div></div>
               <div class="val">${s.reached}${s.rewatched ? ` (${s.rewatched})` : ''}</div>
             </div>`).join('')}
         </div>`}`;
}

// --- wiring ------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const listingBtn = e.target.closest('[data-listing]');
  if (listingBtn) selectListing(listingBtn.dataset.listing);
});

$('#new-listing').onclick = newListingDialog;
$('#edit-broker').onclick = () => brokerDialog();

$$('.tab').forEach((tab) => {
  tab.onclick = () => { state.tab = tab.dataset.pane; render(); };
});

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:var(--sans)">
    <h2>Corridor could not start</h2>
    <p style="color:#8b909a">${esc(err.message)}</p></div>`;
});
