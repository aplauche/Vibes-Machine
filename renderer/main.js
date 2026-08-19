'use strict';

// State is the source of truth for what's rendered. Items always come from
// vibes.list() — main is the single writer to disk.
//
// `view` is what the grid shows: 'all' or a folder id. `activeFolderId` is
// where new pastes land and is always a real folder — selecting 'all' widens
// the grid without leaving writes homeless.
const state = { items: [], folders: [], activeFolderId: null, view: 'all' };

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const countEl = document.getElementById('count');
const pasteZone = document.getElementById('paste-zone');
const modal = document.getElementById('modal');
const modalImg = document.getElementById('modal-img');
const caption = document.getElementById('modal-caption');
const statusbar = document.getElementById('statusbar');
const busyOverlay = document.getElementById('busy-overlay');
const folderTabs = document.getElementById('folder-tabs');
const addFolderBtn = document.getElementById('add-folder');
const collapseBtn = document.getElementById('sidebar-collapse');
const openBtn = document.getElementById('sidebar-open');

let current = 0;

// ipcRenderer.invoke wraps main-process errors as
// "Error invoking remote method 'x': Error: <real message>". Keep the tail.
function errText(err) {
  const msg = (err && err.message) || String(err);
  const i = msg.lastIndexOf('Error: ');
  return i === -1 ? msg : msg.slice(i + 7);
}

function folderById(id) {
  return state.folders.find((f) => f.id === id) || null;
}

// ------- rendering -------

function updateCount() {
  const n = state.items.length;
  countEl.textContent = `${n} ${n === 1 ? 'image' : 'images'}`;
  empty.style.display = n === 0 ? '' : 'none';
  if (n > 0) return;

  // Empty copy depends on what's being looked at.
  const f = state.view === 'all' ? null : folderById(state.view);
  empty.replaceChildren();
  if (f && !f.available) {
    empty.append(`${f.display} is unavailable.`);
    empty.append(document.createElement('br'));
    empty.append('reconnect it, or unlink the folder.');
    return;
  }
  empty.append(f ? `nothing in ${f.label} yet.` : 'no screenshots yet.');
  empty.append(document.createElement('br'));
  empty.append('paste ');
  const k = document.createElement('kbd');
  k.textContent = '⌘V';
  empty.append(k, ' or drag images in.');
}

function rebuildGrid() {
  // De-dupe by composite id in case an optimistic prepend overlaps with a
  // watcher reconcile. Two folders may legitimately hold the same filename,
  // so `name` alone is not an identity.
  const seen = new Set();
  const deduped = [];
  for (const it of state.items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    deduped.push(it);
  }
  state.items = deduped;

  grid.replaceChildren();
  state.items.forEach((item, i) => {
    const fig = document.createElement('figure');
    fig.dataset.index = String(i);
    fig.dataset.id = item.id;
    fig.dataset.name = item.name;
    fig.dataset.folder = item.folderId;

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
  state.items = await window.vibes.list(state.view);
  rebuildGrid();
}

// ------- folder sidebar -------

const VIEW_KEY = 'vibes:view';
const COLLAPSED_KEY = 'vibes:sidebarCollapsed';

function loadUiPrefs() {
  try {
    state.view = localStorage.getItem(VIEW_KEY) || 'all';
    if (localStorage.getItem(COLLAPSED_KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (_e) { /* private mode / disabled storage — defaults are fine */ }
}

function setView(view) {
  state.view = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (_e) { /* ignore */ }
}

function setCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (_e) { /* ignore */ }
}

function tabRow(view, label, opts = {}) {
  const row = document.createElement('div');
  row.className = 'folder-tab' + (state.view === view ? ' selected' : '');
  if (opts.unavailable) row.classList.add('unavailable');
  row.dataset.view = view;
  row.tabIndex = 0;
  if (opts.title) row.title = opts.title;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  row.append(name);

  if (opts.isTarget) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = '●';
    dot.title = 'new pastes land here';
    row.append(dot);
  }
  if (opts.unavailable) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '⚠';
    warn.title = 'folder is unreachable';
    row.append(warn);
  }

  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(opts.count || 0);
  row.append(n);

  if (opts.unlinkId) {
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'unlink';
    unlink.dataset.id = opts.unlinkId;
    unlink.title = 'Unlink folder';
    unlink.setAttribute('aria-label', `Unlink ${label}`);
    unlink.innerHTML = '&times;';
    row.append(unlink);
  }
  return row;
}

function renderFolders() {
  folderTabs.replaceChildren();
  folderTabs.append(
    tabRow('all', 'all', {
      count: state.folders.reduce((sum, f) => sum + f.count, 0),
      title: 'every linked folder, newest first',
    }),
  );
  for (const f of state.folders) {
    folderTabs.append(
      tabRow(f.id, f.label, {
        count: f.count,
        unavailable: !f.available,
        // Only worth marking when the grid isn't already scoped to this folder.
        isTarget: f.id === state.activeFolderId && state.view === 'all',
        title: f.available ? f.display : `${f.display} — unavailable`,
        unlinkId: f.id,
      }),
    );
  }
}

function updateStatusbar() {
  const f = folderById(state.activeFolderId);
  if (!f) {
    statusbar.textContent = '';
    return;
  }
  const n = state.folders.length;
  statusbar.textContent = f.display + (n > 1 ? `   ·   ${n} folders linked` : '');
  statusbar.title = f.path;
}

async function refreshFolders() {
  const res = await window.vibes.folders.list();
  state.folders = res.folders;
  state.activeFolderId = res.activeFolderId;
  // A view pointing at a folder that's no longer linked falls back to merged.
  if (state.view !== 'all' && !folderById(state.view)) setView('all');
  renderFolders();
  updateStatusbar();
  // Refresh the paste hint's "→ folder" suffix, but never stomp on a
  // transient uploading/ok/error message.
  if (!statusCls) setStatus('', null);
}

async function selectView(view) {
  if (!view) return;
  setView(view);
  // Viewing a folder makes it the write target. 'all' leaves the target alone.
  if (view !== 'all') {
    try {
      await window.vibes.folders.setActive(view);
      state.activeFolderId = view;
    } catch (err) {
      setStatus('err', errText(err));
    }
  }
  renderFolders();
  updateStatusbar();
  if (!statusCls) setStatus('', null);
  refresh();
}

async function unlinkFolder(id) {
  const f = folderById(id);
  if (!f) return;
  if (!confirm(`Unlink ${f.label}?\n\nFiles on disk are not deleted.`)) return;
  try {
    await window.vibes.folders.remove(id);
  } catch (err) {
    setStatus('err', errText(err));
    return;
  }
  if (state.view === id) setView('all');
  setStatus('ok', `unlinked ${f.label}`);
  await refreshFolders();
  refresh();
}

// ------- modal -------

function openModal(i) {
  if (!state.items.length) return;
  current = (i + state.items.length) % state.items.length;
  const item = state.items[current];
  modalImg.src = item.src;
  modalImg.alt = item.name;
  // Name the folder when the grid spans several, so the caption is unambiguous.
  const f = folderById(item.folderId);
  caption.textContent =
    state.view === 'all' && f ? `${f.label} / ${item.name}` : item.name;
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

// ------- reveal / delete -------

async function revealItem(fig) {
  const { folder, name } = fig.dataset;
  if (!folder || !name) return;
  try {
    await window.vibes.reveal(folder, name);
  } catch (err) {
    console.error('reveal failed:', err);
  }
}

async function deleteItem(fig) {
  const { id, folder, name } = fig.dataset;
  if (!folder || !name) return;
  if (!confirm(`Delete ${name}?`)) return;
  try {
    await window.vibes.delete(folder, name);
  } catch (err) {
    alert('delete failed: ' + errText(err));
    return;
  }
  state.items = state.items.filter((it) => it.id !== id);
  rebuildGrid();
}

// ------- paste-to-upload -------

let resetTimer = null;
let statusCls = '';

// Where a paste would land, named only when the grid isn't already showing it.
function pasteTarget() {
  const f = folderById(state.activeFolderId);
  return f && state.view !== f.id ? f.label : null;
}

function setStatus(cls, text) {
  statusCls = cls || '';
  pasteZone.className = 'paste-zone' + (cls ? ' ' + cls : '');
  pasteZone.textContent = '';
  if (typeof text === 'string') {
    pasteZone.append(text);
  } else {
    pasteZone.append('paste image here ');
    const k = document.createElement('kbd');
    k.textContent = '⌘V';
    pasteZone.append(k);
    const target = pasteTarget();
    if (target) pasteZone.append(` → ${target}`);
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
    const item = await window.vibes.save(buf, blob.type, state.activeFolderId);
    // Only prepend when the new file belongs to what's on screen — writing to
    // a folder the grid isn't showing must not fabricate a tile.
    const inView = state.view === 'all' || state.view === item.folderId;
    if (inView) {
      // Optimistic — vibes:changed will reconcile shortly via refresh().
      state.items.unshift(item);
      rebuildGrid();
      await waitForNewTile();   // let the reflow settle, hidden behind black
    }
    const f = folderById(item.folderId);
    setStatus('ok', inView || !f ? 'added ✓' : `added ✓ → ${f.label}`);
  } catch (err) {
    setStatus('err', errText(err));
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

folderTabs.addEventListener('click', (e) => {
  const unlink = e.target.closest('.unlink');
  if (unlink) {
    e.stopPropagation();
    unlinkFolder(unlink.dataset.id);
    return;
  }
  const row = e.target.closest('.folder-tab');
  if (row) selectView(row.dataset.view);
});

// Rows are divs (they contain a button, so they can't be buttons themselves) —
// give them the keyboard behavior a button would have had.
folderTabs.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.folder-tab');
  if (!row || e.target.closest('.unlink')) return;
  e.preventDefault();
  selectView(row.dataset.view);
});

addFolderBtn.addEventListener('click', async () => {
  try {
    const res = await window.vibes.folders.add();
    if (!res) return;   // user canceled
    setStatus('ok', `linked ${res.folder.label}`);
    await refreshFolders();
    refresh();
  } catch (err) {
    setStatus('err', errText(err));
  }
});

collapseBtn.addEventListener('click', () => setCollapsed(true));
openBtn.addEventListener('click', () => setCollapsed(false));

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

// Watcher push from main → re-list. Coalesces external writes (Finder drops,
// other tools touching a linked dir) and reconciles optimistic UI inserts.
// Folder counts and availability come along for the ride.
window.vibes.onChanged(async () => {
  await refreshFolders();
  refresh();
});

// Initial load. Folders first: the stored view may name a folder that's gone.
loadUiPrefs();
refreshFolders().then(() => refresh());
