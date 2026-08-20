'use strict';

// State is the source of truth for what's rendered. Items always come from
// vibes.list() — main is the single writer to disk.
//
// `view` is what the grid shows: 'all' or a folder id. `activeFolderId` is
// where new pastes land and is always a real folder — selecting 'all' widens
// the grid without leaving writes homeless.
// `collection` is the film-roll cart: full item snapshots in the order they
// were collected, held in memory only — it is deliberately gone on quit.
const state = { items: [], folders: [], activeFolderId: null, view: 'all', collection: [] };

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
const filmBtn = document.getElementById('film');
const filmCount = document.getElementById('film-count');
const sheet = document.getElementById('collection');
const sheetGrid = document.getElementById('collection-grid');
const sheetCount = document.getElementById('collection-count');
const sheetCreate = document.getElementById('collection-create');
const sheetClear = document.getElementById('collection-clear');
const sheetDest = document.getElementById('collection-dest');
const sheetCopy = document.getElementById('collection-copy');

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
    if (isCollected(item.id)) fig.classList.add('collected');

    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.name;
    img.loading = 'lazy';
    fig.appendChild(img);

    // Text glyph, not an SVG: the grid's click delegation tests
    // e.target.classList, and an SVG child would make e.target the <path>.
    const collect = document.createElement('button');
    collect.type = 'button';
    collect.className = 'collect';
    const collected = isCollected(item.id);
    collect.setAttribute('aria-label', collected ? 'Remove from collection' : 'Collect');
    collect.title = collected ? 'Remove from collection' : 'Collect';
    collect.textContent = collected ? '✓' : '+';
    fig.appendChild(collect);

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
  // The destination dropdown and its enabled state track the folder list.
  updateCollectionUI();
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
  // Those files are no longer reachable through any linked folder.
  pruneCollection((c) => c.folderId !== id);
  setStatus('ok', `unlinked ${f.label}`);
  await refreshFolders();
  refresh();
}

// ------- collection (film roll) -------

function isCollected(id) {
  return state.collection.some((c) => c.id === id);
}

function updateCollectionUI() {
  const n = state.collection.length;
  filmCount.textContent = n === 0 ? '' : String(n);
  filmBtn.title = n === 0 ? 'Collection (empty)' : `Collection — ${n}`;
  sheetCount.textContent = `${n} ${n === 1 ? 'image' : 'images'}`;
  sheetCreate.disabled = n === 0;
  sheetCreate.textContent = n === 0 ? 'create folder' : `create folder from ${n}`;
  sheetCopy.disabled = n === 0 || state.folders.length === 0;
  sheetDest.disabled = state.folders.length === 0;
  if (sheetIsOpen()) renderSheet();
}

// Destination dropdown: every linked folder, unavailable ones disabled.
// Keeps the current pick when it survives a re-render, else the active folder.
function renderDest() {
  const previous = sheetDest.value;
  sheetDest.replaceChildren();
  for (const f of state.folders) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.available ? f.label : `${f.label} (unavailable)`;
    opt.disabled = !f.available;
    sheetDest.append(opt);
  }
  const stillThere = state.folders.some((f) => f.id === previous && f.available);
  sheetDest.value = stillThere ? previous : state.activeFolderId || '';
}

// Both destinations report the same way: what landed, and what didn't.
function copyReport(res, label) {
  const notes = [];
  if (res.skipped) notes.push(`${res.skipped} missing`);
  if (res.alreadyThere) notes.push(`${res.alreadyThere} already there`);
  return `${res.copied} → ${label}${notes.length ? ', ' + notes.join(', ') : ''}`;
}

function toggleCollect(fig) {
  const { id } = fig.dataset;
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  if (isCollected(id)) {
    state.collection = state.collection.filter((c) => c.id !== id);
  } else {
    // Snapshot, not a reference — state.items is replaced on every refresh.
    state.collection.push({ ...item });
  }
  updateCollectionUI();
  rebuildGrid();
}

// Drop entries that can no longer be valid. Called after a delete (one id) and
// after unlinking a folder (every id in it).
function pruneCollection(pred) {
  const before = state.collection.length;
  state.collection = state.collection.filter(pred);
  if (state.collection.length !== before) updateCollectionUI();
}

function sheetIsOpen() {
  return sheet.classList.contains('open');
}

function renderSheet() {
  renderDest();
  sheetGrid.replaceChildren();
  if (state.collection.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'sheet-empty';
    msg.append('nothing collected yet.');
    msg.append(document.createElement('br'));
    msg.append('hover any image and hit + to add it.');
    sheetGrid.append(msg);
    return;
  }
  for (const item of state.collection) {
    const fig = document.createElement('figure');
    fig.dataset.id = item.id;

    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.name;
    img.loading = 'lazy';
    fig.append(img);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.dataset.id = item.id;
    drop.title = 'Remove from collection';
    drop.setAttribute('aria-label', `Remove ${item.name} from collection`);
    drop.innerHTML = '&times;';
    fig.append(drop);

    const from = document.createElement('div');
    from.className = 'from';
    const f = folderById(item.folderId);
    from.textContent = f ? f.label : item.name;
    from.title = item.name;
    fig.append(from);

    sheetGrid.append(fig);
  }
}

function openSheet() {
  renderSheet();
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

async function createFolderFromCollection() {
  const items = state.collection.map(({ folderId, name }) => ({ folderId, name }));
  if (items.length === 0) return;
  try {
    const res = await window.vibes.collection.createFolder(items);
    if (!res) return;   // user canceled the save dialog — collection untouched
    state.collection = [];
    updateCollectionUI();
    closeSheet();
    setStatus('ok', copyReport(res, res.folder.label));
    await refreshFolders();
    // Show the result: scopes the grid and makes it the write target.
    selectView(res.folder.id);
  } catch (err) {
    setStatus('err', errText(err));
  }
}

// Copy the collection into a folder that's already linked. Unlike create, this
// leaves the current view alone — the destination already exists and you know
// where it is; the sidebar count and the status pill are enough feedback.
async function copyCollectionTo() {
  const items = state.collection.map(({ folderId, name }) => ({ folderId, name }));
  const destId = sheetDest.value;
  if (items.length === 0 || !destId) return;
  try {
    const res = await window.vibes.collection.copyTo(items, destId);
    state.collection = [];
    updateCollectionUI();
    closeSheet();
    setStatus('ok', copyReport(res, res.folder.label));
    await refreshFolders();
    refresh();
  } catch (err) {
    setStatus('err', errText(err));
  }
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
  pruneCollection((c) => c.id !== id);
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
  if (e.target.classList && e.target.classList.contains('collect')) {
    e.stopPropagation();
    const fig = e.target.closest('figure[data-id]');
    if (fig) toggleCollect(fig);
    return;
  }
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

filmBtn.addEventListener('click', () => (sheetIsOpen() ? closeSheet() : openSheet()));
document.getElementById('collection-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();   // backdrop
});
sheetGrid.addEventListener('click', (e) => {
  const drop = e.target.closest('.drop');
  if (!drop) return;
  pruneCollection((c) => c.id !== drop.dataset.id);
  rebuildGrid();   // the tile in the main grid loses its collected mark
});
sheetClear.addEventListener('click', () => {
  if (state.collection.length === 0) return;
  pruneCollection(() => false);
  rebuildGrid();
});
sheetCreate.addEventListener('click', createFolderFromCollection);
sheetCopy.addEventListener('click', copyCollectionTo);

modal.addEventListener('click', (e) => {
  if (e.target.classList.contains('nav')) {
    if (e.target.classList.contains('next')) nextModal();
    else prevModal();
    return;
  }
  if (e.target.classList.contains('close') || e.target === modal) closeModal();
});

document.addEventListener('keydown', (e) => {
  // The sheet sits above the lightbox, so it gets first claim on Escape.
  if (sheetIsOpen()) {
    if (e.key === 'Escape') closeSheet();
    return;
  }
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
updateCollectionUI();
refreshFolders().then(() => refresh());
