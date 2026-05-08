'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// MUST run before anything reads app.getPath('userData') — otherwise dev mode
// resolves it to ~/Library/Application Support/Electron rather than vibes-machine.
app.setName('vibes-machine');
app.setPath('userData', path.join(app.getPath('appData'), 'vibes-machine'));

// Resolved inside whenReady() so app.getPath() is guaranteed to work.
let SCREENSHOTS_DIR = null;

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

function listScreenshots() {
  const names = fs
    .readdirSync(SCREENSHOTS_DIR)
    .filter((n) => !n.startsWith('.') && EXTS.has(path.extname(n).toLowerCase()));

  return names
    .map((name) => {
      const abs = path.join(SCREENSHOTS_DIR, name);
      const stat = fs.statSync(abs);
      return { name, mtime: stat.mtimeMs, src: pathToFileURL(abs).href };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function saveScreenshot(bytes, mime) {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported type: ${mime}`);

  const buf = Buffer.from(bytes);
  if (buf.byteLength > MAX_BYTES) throw new Error('file too large');

  await fs.promises.mkdir(SCREENSHOTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const name = `paste-${ts}-${rand}${ext}`;
  const abs = path.join(SCREENSHOTS_DIR, name);
  await fs.promises.writeFile(abs, buf);

  return { name, mtime: Date.now(), src: pathToFileURL(abs).href };
}

async function deleteScreenshot(name) {
  if (!safeName(name)) throw new Error('invalid name');
  const abs = path.join(SCREENSHOTS_DIR, name);
  // Defense-in-depth: ensure resolved path stays inside SCREENSHOTS_DIR.
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(SCREENSHOTS_DIR) + path.sep)) {
    throw new Error('invalid name');
  }
  await fs.promises.unlink(resolved);
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
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.screenshotsDir === 'string' && obj.screenshotsDir.length > 0) {
      return { screenshotsDir: obj.screenshotsDir };
    }
  } catch (_e) {
    // missing or malformed — fall through to defaults
  }
  return { screenshotsDir: defaultScreenshotsDir() };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ------- fs.watch with debounce (restartable on folder change) -------

let watcher = null;
let watcherTimer = null;

function broadcastChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vibes:changed');
  }
}

function stopWatcher() {
  if (watcherTimer) {
    clearTimeout(watcherTimer);
    watcherTimer = null;
  }
  if (watcher) {
    try { watcher.close(); } catch (_e) { /* ignore */ }
    watcher = null;
  }
}

function startWatcher() {
  stopWatcher();
  try {
    watcher = fs.watch(SCREENSHOTS_DIR, { persistent: false }, () => {
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(broadcastChanged, 75);
    });
  } catch (e) {
    console.error('fs.watch failed:', e);
  }
}

function setScreenshotsDir(newDir) {
  const resolvedNew = path.resolve(newDir);
  if (resolvedNew === path.resolve(SCREENSHOTS_DIR)) return;
  fs.mkdirSync(resolvedNew, { recursive: true });
  SCREENSHOTS_DIR = resolvedNew;
  saveConfig({ screenshotsDir: resolvedNew });
  startWatcher();
  broadcastChanged();
}

// ------- IPC -------

function registerIpc() {
  ipcMain.handle('vibes:list', () => listScreenshots());

  ipcMain.handle('vibes:save', async (_e, { bytes, mime }) => {
    return saveScreenshot(bytes, mime);
  });

  ipcMain.handle('vibes:delete', async (_e, { name }) => {
    return deleteScreenshot(name);
  });

  ipcMain.handle('vibes:reveal', (_e, { name }) => {
    if (!safeName(name)) throw new Error('invalid name');
    const abs = path.join(SCREENSHOTS_DIR, name);
    const resolved = path.resolve(abs);
    if (!resolved.startsWith(path.resolve(SCREENSHOTS_DIR) + path.sep)) {
      throw new Error('invalid name');
    }
    if (!fs.existsSync(resolved)) throw new Error('not found');
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle('vibes:settings:get', () => ({
    screenshotsDir: SCREENSHOTS_DIR,
    screenshotsDirDisplay: shortenPath(SCREENSHOTS_DIR),
    isDefault: path.resolve(SCREENSHOTS_DIR) === path.resolve(defaultScreenshotsDir()),
  }));

  ipcMain.handle('vibes:settings:pickDir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: SCREENSHOTS_DIR,
      title: 'Choose screenshots folder',
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    setScreenshotsDir(result.filePaths[0]);
    return { screenshotsDir: SCREENSHOTS_DIR };
  });
}

// ------- window -------

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0e0e10',
    title: 'vibes machine',
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
  SCREENSHOTS_DIR = path.resolve(cfg.screenshotsDir);
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch (e) {
    // Configured dir is unreachable (deleted, permissions, unmounted volume).
    // Fall back to default so the app still launches.
    console.error(`screenshots dir ${SCREENSHOTS_DIR} unreachable, falling back to default:`, e);
    SCREENSHOTS_DIR = defaultScreenshotsDir();
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    saveConfig({ screenshotsDir: SCREENSHOTS_DIR });
  }

  registerIpc();
  startWatcher();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
