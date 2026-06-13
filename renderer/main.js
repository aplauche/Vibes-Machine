'use strict';

// State is the source of truth for what's rendered. Always derived from
// vibes.list() — main process is the single writer to disk.
const state = { items: [] };

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const countEl = document.getElementById('count');
const pasteZone = document.getElementById('paste-zone');
const modal = document.getElementById('modal');
const modalImg = document.getElementById('modal-img');
const caption = document.getElementById('modal-caption');
const cog = document.getElementById('cog');
const statusbar = document.getElementById('statusbar');
const busyOverlay = document.getElementById('busy-overlay');

let current = 0;

// ------- rendering -------

function updateCount() {
  const n = state.items.length;
  countEl.textContent = `${n} ${n === 1 ? 'image' : 'images'}`;
  empty.style.display = n === 0 ? '' : 'none';
}

function rebuildGrid() {
  // De-dupe by name in case an optimistic prepend overlaps with a watcher reconcile.
  const seen = new Set();
  const deduped = [];
  for (const it of state.items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    deduped.push(it);
  }
  state.items = deduped;

  grid.replaceChildren();
  state.items.forEach((item, i) => {
    const fig = document.createElement('figure');
    fig.dataset.index = String(i);
    fig.dataset.name = item.name;

    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.name;
    img.loading = 'lazy';
    fig.appendChild(img);

    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'reveal';
    reveal.setAttribute('aria-label', 'Reveal in Finder');
    reveal.title = 'Reveal in Finder';
    reveal.textContent = '↗';
    fig.appendChild(reveal);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '&times;';
    fig.appendChild(del);

    grid.appendChild(fig);
  });
  updateCount();
}

async function refresh() {
  state.items = await window.vibes.list();
  rebuildGrid();
}

// ------- modal -------

function openModal(i) {
  if (!state.items.length) return;
  current = (i + state.items.length) % state.items.length;
  const item = state.items[current];
  modalImg.src = item.src;
  modalImg.alt = item.name;
  caption.textContent = item.name;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}
function closeModal() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  modalImg.src = '';
}
function nextModal() { openModal(current + 1); }
function prevModal() { openModal(current - 1); }

// ------- delete -------

async function revealItem(fig) {
  const name = fig.dataset.name;
  if (!name) return;
  try {
    await window.vibes.reveal(name);
  } catch (err) {
    console.error('reveal failed:', err);
  }
}

async function deleteItem(fig) {
  const name = fig.dataset.name;
  if (!name) return;
  if (!confirm(`Delete ${name}?`)) return;
  try {
    await window.vibes.delete(name);
  } catch (err) {
    alert('delete failed: ' + (err && err.message ? err.message : err));
    return;
  }
  state.items = state.items.filter((it) => it.name !== name);
  rebuildGrid();
}

// ------- paste-to-upload -------

let resetTimer = null;
function setStatus(cls, text) {
  pasteZone.className = 'paste-zone' + (cls ? ' ' + cls : '');
  pasteZone.textContent = '';
  if (typeof text === 'string') {
    pasteZone.append(text);
  } else {
    pasteZone.append('paste image here ');
    const k = document.createElement('kbd');
    k.textContent = '⌘V';
    pasteZone.append(k);
  }
  if (resetTimer) clearTimeout(resetTimer);
  if (cls === 'ok' || cls === 'err') {
    resetTimer = setTimeout(() => setStatus('', null), 2000);
  }
}

const FADE_MS = 200;   // must match the .busy-overlay transition in styles.css
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fade the black curtain fully in, so the masonry reflow is completely hidden.
async function fadeToBlack() {
  busyOverlay.classList.add('show');
  busyOverlay.setAttribute('aria-hidden', 'false');
  await sleep(FADE_MS);
}
// Fade the curtain back out, revealing the settled layout.
async function fadeFromBlack() {
  busyOverlay.classList.remove('show');
  await sleep(FADE_MS);
  busyOverlay.setAttribute('aria-hidden', 'true');
}

// After a prepend, the new tile is grid.firstElementChild. Wait for its image
// to decode so the masonry reflow finishes *behind* the curtain.
async function waitForNewTile() {
  const img = grid.querySelector('figure img');
  if (!img) return;
  try { await img.decode(); } catch (_e) { /* decode can reject if cached/odd; ignore */ }
}

async function uploadBlob(blob) {
  setStatus('busy', 'uploading…');
  await fadeToBlack();          // fully black BEFORE anything happens
  try {
    const buf = await blob.arrayBuffer();
    const item = await window.vibes.save(buf, blob.type);
    // Optimistic prepend — vibes:changed will reconcile shortly via refresh().
    state.items.unshift(item);
    rebuildGrid();
    await waitForNewTile();     // let the reflow settle, hidden behind black
    setStatus('ok', 'added ✓');
  } catch (err) {
    setStatus('err', (err && err.message) || 'failed');
  } finally {
    await fadeFromBlack();      // fade out from black
  }
}

// Synchronously pull the first image File out of clipboard items. Must stay
// sync + be called during the paste event, both because DataTransferItem is
// only valid then and because the caller needs to preventDefault() before any
// await (otherwise the image lands in the contenteditable paste-zone).
function imageFromClipboard(items) {
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) return blob;
    }
  }
  return null;
}

// ------- event wiring -------

grid.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('reveal')) {
    e.stopPropagation();
    const fig = e.target.closest('figure[data-name]');
    if (fig) revealItem(fig);
    return;
  }
  if (e.target.classList && e.target.classList.contains('del')) {
    e.stopPropagation();
    const fig = e.target.closest('figure[data-name]');
    if (fig) deleteItem(fig);
    return;
  }
  const fig = e.target.closest('figure[data-index]');
  if (fig) openModal(parseInt(fig.dataset.index, 10));
});

modal.addEventListener('click', (e) => {
  if (e.target.classList.contains('nav')) {
    if (e.target.classList.contains('next')) nextModal();
    else prevModal();
    return;
  }
  if (e.target.classList.contains('close') || e.target === modal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (!modal.classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowRight') nextModal();
  else if (e.key === 'ArrowLeft') prevModal();
});

document.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const blob = imageFromClipboard(Array.from(e.clipboardData.items));
  if (!blob) return;
  // Synchronous: stop the browser from inserting the image into the paste-zone
  // before we start the fade. Then run the upload (fire-and-forget).
  e.preventDefault();
  uploadBlob(blob);
});

// ------- drag-and-drop from Finder -------

// dragenter/dragleave fire for every child element transition. Use a depth
// counter so the visual stays put while moving over nested elements.
let dragDepth = 0;

function dragHasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

document.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth++;
  if (dragDepth === 1) document.body.classList.add('drag-active');
});

document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();             // required for drop to fire
  e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-active');
  }
});

document.addEventListener('drop', async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();             // stop the browser from navigating to the file
  dragDepth = 0;
  document.body.classList.remove('drag-active');

  const files = Array.from(e.dataTransfer.files || []).filter((f) =>
    f && f.type && f.type.startsWith('image/'),
  );
  if (files.length === 0) {
    setStatus('err', 'no images in drop');
    return;
  }
  // Sequential so main isn't slammed with concurrent writes; status pill
  // shows progress per file.
  for (const file of files) {
    await uploadBlob(file);
  }
});

pasteZone.addEventListener('input', () => {
  if (pasteZone.textContent.length > 64) setStatus('', null);
});
pasteZone.addEventListener('focus', () => pasteZone.classList.add('focus'));
pasteZone.addEventListener('blur', () => pasteZone.classList.remove('focus'));

// ------- settings cog + status bar -------

async function refreshSettingsUI() {
  try {
    const cfg = await window.vibes.settings.get();
    const display = cfg.screenshotsDirDisplay || cfg.screenshotsDir;
    statusbar.textContent = display;
    statusbar.title = cfg.screenshotsDir;
    cog.title = `Screenshots folder: ${cfg.screenshotsDir}\nClick to change.`;
  } catch (_e) { /* ignore */ }
}

cog.addEventListener('click', async () => {
  try {
    const result = await window.vibes.settings.pickDir();
    if (!result) return;  // user canceled
    setStatus('ok', `folder → ${result.screenshotsDir}`);
    refreshSettingsUI();
    // refresh() will also fire from the vibes:changed broadcast triggered
    // by setScreenshotsDir, but call it here too so the UI updates without
    // waiting for the watcher event to round-trip.
    refresh();
  } catch (err) {
    setStatus('err', (err && err.message) || 'failed');
  }
});

// Watcher push from main → re-list. Coalesces external writes (Finder drops,
// other tools touching the dir) and reconciles optimistic UI inserts.
window.vibes.onChanged(() => { refresh(); });

// Initial load.
refresh();
refreshSettingsUI();
