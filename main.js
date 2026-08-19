'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// MUST run before anything reads app.getPath('userData') — otherwise dev mode
// resolves it to ~/Library/Application Support/Electron rather than vibes-machine.
app.setName('vibes-machine');
app.setPath('userData', path.join(app.getPath('appData'), 'vibes-machine'));

// Linked folders, resolved inside whenReady() so app.getPath() is guaranteed to
// work. ACTIVE_FOLDER_ID is the write target — always a real folder id, never
// 'all' (which is a *view* the renderer owns, not a place to put files).
let FOLDERS = [];            // [{ id, path }]
let ACTIVE_FOLDER_ID = null;

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']);
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};
const MAX_BYTES = 25 * 1024 * 1024;

function safeName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.startsWith('.')
  );
}

// ------- folder model -------

function newFolderId() {
  return crypto.randomUUID().slice(0, 8);
}

function folderById(id) {
  return FOLDERS.find((f) => f.id === id) || null;
}

function activeFolder() {
  return folderById(ACTIVE_FOLDER_ID) || FOLDERS[0] || null;
}

// Two linked folders can share a basename (~/a/shots and ~/b/shots). Only the
// colliding ones get their parent dir prepended; unique names stay short.
function labelFor(folder) {
  const base = path.basename(folder.path);
  const collides = FOLDERS.some((f) => f.id !== folder.id && path.basename(f.path) === base);
  if (!collides) return base;
  return path.join(path.basename(path.dirname(folder.path)), base);
}

// The single guard for every path that originates in the renderer. Throws
// rather than returning null so a caller can't forget to check.
function resolveInFolder(folderId, name) {
  const folder = folderById(folderId);
  if (!folder) throw new Error('unknown folder');
  if (!safeName(name)) throw new Error('invalid name');
  const resolved = path.resolve(path.join(folder.path, name));
  if (!resolved.startsWith(path.resolve(folder.path) + path.sep)) {
    throw new Error('invalid name');
  }
  return resolved;
}

// True when the two paths are the same or one contains the other — either way
// linking both would list the same images twice.
function overlaps(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return ra === rb || ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

// ------- listing -------

function imageNames(folder) {
  try {
    return fs
      .readdirSync(folder.path)
      .filter((n) => !n.startsWith('.') && EXTS.has(path.extname(n).toLowerCase()));
  } catch (_e) {
    // Unmounted volume, deleted dir, permissions — this folder contributes
    // nothing instead of breaking the listing for every other folder.
    return [];
  }
}

function listFolder(folder) {
  const names = imageNames(folder);

  const out = [];
  for (const name of names) {
    const abs = path.join(folder.path, name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (_e) {
      continue; // raced with a delete
    }
    out.push({
      id: `${folder.id}:${name}`,
      name,
      folderId: folder.id,
      mtime: stat.mtimeMs,
      src: pathToFileURL(abs).href,
    });
  }
  return out;
}

function listScreenshots(folderId) {
  const targets =
    !folderId || folderId === 'all' ? FOLDERS : [folderById(folderId)].filter(Boolean);
  return targets.flatMap(listFolder).sort((a, b) => b.mtime - a.mtime);
}

async function saveScreenshot(bytes, mime, folderId) {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported type: ${mime}`);

  const buf = Buffer.from(bytes);
  if (buf.byteLength > MAX_BYTES) throw new Error('file too large');

  const folder = folderById(folderId) || activeFolder();
  if (!folder) throw new Error('no folder linked');

  await fs.promises.mkdir(folder.path, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const name = `paste-${ts}-${rand}${ext}`;
  const abs = path.join(folder.path, name);
  await fs.promises.writeFile(abs, buf);

  return {
    id: `${folder.id}:${name}`,
    name,
    folderId: folder.id,
    mtime: Date.now(),
    src: pathToFileURL(abs).href,
  };
}

async function deleteScreenshot(folderId, name) {
  await fs.promises.unlink(resolveInFolder(folderId, name));
  return { ok: true };
}

// ------- settings -------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaultScreenshotsDir() {
  return path.join(app.getPath('userData'), 'screenshots');
}

function shortenPath(p) {
  const home = app.getPath('home');
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

function loadConfig() {
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_e) {
    // missing or malformed — fall through to defaults
  }

  if (obj && Array.isArray(obj.folders)) {
    const folders = obj.folders
      .filter((f) => f && typeof f.path === 'string' && f.path.length > 0)
      .map((f) => ({
        id: typeof f.id === 'string' && f.id.length > 0 ? f.id : newFolderId(),
        path: path.resolve(f.path),
      }));
    if (folders.length > 0) {
      const active = folders.some((f) => f.id === obj.activeFolderId)
        ? obj.activeFolderId
        : folders[0].id;
      return { folders, activeFolderId: active };
    }
  }

  // v1 → v2: a single { screenshotsDir } becomes a one-folder list.
  const dir =
    obj && typeof obj.screenshotsDir === 'string' && obj.screenshotsDir.length > 0
      ? path.resolve(obj.screenshotsDir)
      : defaultScreenshotsDir();
  const folder = { id: newFolderId(), path: dir };
  return { folders: [folder], activeFolderId: folder.id };
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const cfg = { version: 2, folders: FOLDERS, activeFolderId: ACTIVE_FOLDER_ID };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ------- fs.watch with debounce, one watcher per linked folder -------

const watchers = new Map(); // folder id → fs.FSWatcher
let watcherTimer = null;

function broadcastChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vibes:changed');
  }
}

function stopWatcher(id) {
  const w = watchers.get(id);
  if (!w) return;
  try { w.close(); } catch (_e) { /* ignore */ }
  watchers.delete(id);
}

function startWatcher(folder) {
  stopWatcher(folder.id);
  try {
    const w = fs.watch(folder.path, { persistent: false }, () => {
      // One debounce shared across every folder: the renderer re-lists
      // wholesale, so which folder fired doesn't matter.
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(broadcastChanged, 75);
    });
    watchers.set(folder.id, w);
  } catch (e) {
    console.error(`fs.watch failed for ${folder.path}:`, e);
  }
}

// ------- folder mutations -------

function addFolder(dirPath) {
  const resolved = path.resolve(dirPath);
  const clash = FOLDERS.find((f) => overlaps(resolved, f.path));
  if (clash) {
    throw new Error(
      path.resolve(clash.path) === resolved
        ? 'folder already linked'
        : `overlaps ${labelFor(clash)}`,
    );
  }

  fs.mkdirSync(resolved, { recursive: true });
  const folder = { id: newFolderId(), path: resolved };
  FOLDERS.push(folder);
  if (!folderById(ACTIVE_FOLDER_ID)) ACTIVE_FOLDER_ID = folder.id;
  saveConfig();
  startWatcher(folder);
  broadcastChanged();
  return folder;
}

// Unlink only — nothing on disk is ever touched.
function removeFolder(id) {
  const i = FOLDERS.findIndex((f) => f.id === id);
  if (i === -1) throw new Error('unknown folder');
  stopWatcher(id);
  FOLDERS.splice(i, 1);

  // Keep at least one folder linked so a paste always has somewhere to land.
  if (FOLDERS.length === 0) {
    const fallback = { id: newFolderId(), path: defaultScreenshotsDir() };
    fs.mkdirSync(fallback.path, { recursive: true });
    FOLDERS.push(fallback);
    startWatcher(fallback);
  }
  if (!folderById(ACTIVE_FOLDER_ID)) {
    ACTIVE_FOLDER_ID = FOLDERS[Math.min(i, FOLDERS.length - 1)].id;
  }

  saveConfig();
  broadcastChanged();
}

function setActiveFolder(id) {
  if (!folderById(id)) throw new Error('unknown folder');
  if (id === ACTIVE_FOLDER_ID) return;
  ACTIVE_FOLDER_ID = id;
  saveConfig();
  broadcastChanged();
}

// Snapshot for the sidebar. Doubles as the availability re-check: a folder that
// came back (remounted volume) gets its watcher restored here.
function describeFolders() {
  const folders = FOLDERS.map((f) => {
    const available = fs.existsSync(f.path);
    if (available && !watchers.has(f.id)) startWatcher(f);
    if (!available && watchers.has(f.id)) stopWatcher(f.id);
    return {
      id: f.id,
      path: f.path,
      display: shortenPath(f.path),
      label: labelFor(f),
      isDefault: path.resolve(f.path) === path.resolve(defaultScreenshotsDir()),
      available,
      // Names only — the sidebar badge doesn't need an mtime per file.
      count: available ? imageNames(f).length : 0,
    };
  });
  const active = activeFolder();
  return { folders, activeFolderId: active ? active.id : null };
}

// ------- IPC -------

function registerIpc() {
  ipcMain.handle('vibes:list', (_e, args) => listScreenshots(args && args.folderId));

  ipcMain.handle('vibes:save', async (_e, { bytes, mime, folderId }) => {
    return saveScreenshot(bytes, mime, folderId);
  });

  ipcMain.handle('vibes:delete', async (_e, { folderId, name }) => {
    return deleteScreenshot(folderId, name);
  });

  ipcMain.handle('vibes:reveal', (_e, { folderId, name }) => {
    const resolved = resolveInFolder(folderId, name);
    if (!fs.existsSync(resolved)) throw new Error('not found');
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle('vibes:folders:list', () => describeFolders());

  ipcMain.handle('vibes:folders:add', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const current = activeFolder();
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current ? current.path : app.getPath('home'),
      title: 'Add a folder',
      buttonLabel: 'Link this folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const folder = addFolder(result.filePaths[0]);
    return {
      folder: { id: folder.id, path: folder.path, label: labelFor(folder) },
      ...describeFolders(),
    };
  });

  ipcMain.handle('vibes:folders:remove', (_e, { id }) => {
    removeFolder(id);
    return { ok: true, ...describeFolders() };
  });

  ipcMain.handle('vibes:folders:setActive', (_e, { id }) => {
    setActiveFolder(id);
    return { ok: true, activeFolderId: ACTIVE_FOLDER_ID };
  });
}

// ------- window -------

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0e0e10',
    title: 'vibes machine',
    // Sets the window/taskbar icon on Windows & Linux. Ignored on macOS, where
    // the Dock icon comes from the app bundle — see app.dock.setIcon() below.
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ------- app lifecycle -------

app.whenReady().then(() => {
  const cfg = loadConfig();
  FOLDERS = cfg.folders;
  ACTIVE_FOLDER_ID = cfg.activeFolderId;

  // Deliberately no mkdir over existing links: re-creating a folder the user
  // deleted, or stubbing out the mount point of an unplugged drive, is worse
  // than showing it as unavailable. Only the fallback below gets created.
  if (!FOLDERS.some((f) => fs.existsSync(f.path))) {
    console.error('no linked folder is reachable, falling back to the default');
    const fallback = { id: newFolderId(), path: defaultScreenshotsDir() };
    fs.mkdirSync(fallback.path, { recursive: true });
    FOLDERS.push(fallback);
    ACTIVE_FOLDER_ID = fallback.id;
  }
  saveConfig();

  // macOS: BrowserWindow({ icon }) is ignored; the Dock icon comes from the app
  // bundle (Electron.app in dev). Override it at runtime so dev shows our icon.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }

  registerIpc();
  for (const f of FOLDERS) startWatcher(f);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
