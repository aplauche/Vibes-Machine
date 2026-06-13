# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Launch the Electron app (`electron .`) |

There is no build step, no test runner, no linter. The app is plain JavaScript loaded directly by Electron.

To work on the legacy Astro version (preserved for reference): `cd legacy && npm i && npm run dev`.

## Architecture

A minimal Electron app — six files, one runtime dependency (`electron`). The renderer is loaded via `loadFile`, so the renderer's origin is `file://` and `<img src="file:///…">` works natively without a custom protocol or CSP gymnastics.

- [main.js](main.js) — main process. Owns the screenshots directory, IPC handlers (`vibes:list/save/delete/reveal/settings.*`), `fs.watch` with 75 ms debounce broadcasting `vibes:changed`, settings persistence, BrowserWindow creation.
- [preload.js](preload.js) — `contextBridge.exposeInMainWorld('vibes', { list, save, delete, reveal, settings, onChanged })`. Sandbox-safe, CommonJS, no Node API leakage to renderer.
- [renderer/index.html](renderer/index.html) — body shell with paste-zone, grid, modal. Strict CSP (`script-src 'self'`, `img-src file: data: 'self'`).
- [renderer/main.js](renderer/main.js) — DOM event wiring, `state.items` source-of-truth model, modal/keyboard nav, paste-to-upload with optimistic prepend, `vibes.onChanged` reconciliation.
- [renderer/styles.css](renderer/styles.css) — verbatim port of the legacy CSS.

### The screenshots directory (configurable)

`SCREENSHOTS_DIR` is a module-scoped mutable in [main.js](main.js), set at startup from `<userData>/config.json` (key `screenshotsDir`). On first launch the file doesn't exist and it falls back to `path.join(app.getPath('userData'), 'screenshots')` (on macOS: `~/Library/Application Support/vibes-machine/screenshots/`). The user can change it from the UI — the cog button in the header opens a native folder picker via `vibes:settings:pickDir`.

When the path changes, `setScreenshotsDir(newDir)` does five things: `mkdir -p` the new dir, replace the in-memory `SCREENSHOTS_DIR`, write the new path to `config.json`, restart the watcher (`stopWatcher()` then `startWatcher()`), and broadcast `vibes:changed` so the renderer re-lists. Switching folders **does not move or copy** existing files — the new folder simply becomes the source.

If the configured path is unreachable on startup (deleted, unmounted volume, permissions), [main.js](main.js) logs the error and falls back to the default, rewriting `config.json`. The app always launches.

`app.setName('vibes-machine')` runs **synchronously at module top** in [main.js](main.js). If anything reads `app.getPath('userData')` before `setName`, dev resolves to `~/Library/Application Support/Electron` and prod to the productName, breaking dev↔prod parity. Same for `app.setPath('userData', …)` — both run before `whenReady`.

### IPC contract

Promise-based via `ipcMain.handle` / `ipcRenderer.invoke`:

- `vibes:list` → `[{ name, mtime, src }]` sorted mtime desc. `src` is `pathToFileURL(absPath).href`, ready for `<img src>`.
- `vibes:save({ bytes: ArrayBuffer, mime })` → `{ name, mtime, src }`. Validates MIME against whitelist + `bytes.byteLength <= 25 MB` in main, not preload.
- `vibes:delete({ name })` → `{ ok: true }`. Path-traversal guard + `path.resolve` containment check using current `SCREENSHOTS_DIR`.
- `vibes:reveal({ name })` → `{ ok: true }`. Same guards, then `shell.showItemInFolder(absPath)`.
- `vibes:settings:get` → `{ screenshotsDir, isDefault }`.
- `vibes:settings:pickDir` → opens `dialog.showOpenDialog`. On confirm: switches dir + persists + restarts watcher. Returns `{ screenshotsDir }` or `null` if canceled.

Plus a one-way push: `webContents.send('vibes:changed')` from the watcher debouncer (and from `setScreenshotsDir`); renderer subscribes via `vibes.onChanged(cb)` (returns an unsubscribe function).

### Why optimistic prepend works here

The legacy code disabled optimistic insert because Vite's public-folder watcher raced the DOM update. In Electron, the main process is the **single writer to disk**, so there's no watcher race: the renderer prepends immediately after `vibes.save()` resolves, and the inevitable `vibes:changed` reconciliation through `refresh()` is a no-op for the just-inserted item (de-duped by `name` in [renderer/main.js](renderer/main.js)).

## Gotchas

- **Renderer cannot use Node APIs.** `sandbox: true, contextIsolation: true, nodeIntegration: false` is non-negotiable. Anything FS happens in main, gets exposed via the `vibes` bridge. Don't import `node:fs` in [renderer/main.js](renderer/main.js) — it'll throw at load time.
- **Preload is also sandboxed.** Only `electron` and a small allowlisted set of `node:` modules work. Don't try to do byte-handling in preload — pass `ArrayBuffer` through to main.
- **CSP must allow `file:` for images.** The meta tag in [renderer/index.html](renderer/index.html) sets `img-src file: data: 'self'`. Without `file:`, every thumbnail silently 404s.
- **`fs.watch` fires multiple events per write on macOS.** The 75 ms debounce in [main.js](main.js) coalesces them. Watch event payloads are unreliable (filename can be `undefined`); the design just invalidates and re-lists.
- **`app.setName` ordering** — see "screenshots directory" above. If userData resolves wrong in dev, this is why.

## App icon & window title

The placeholder lives at [assets/icon.png](assets/icon.png) (512×512, generated dependency-free; swap it for a real icon anytime). Three separate things show the app's identity, set in different places:

- **Window title bar** — `title: 'vibes machine'` in [main.js](main.js), but the `<title>` in [renderer/index.html](renderer/index.html) wins once the page loads. Keep them in sync.
- **Window/taskbar icon (Windows & Linux)** — the `icon:` option on `BrowserWindow` in [main.js](main.js).
- **Dock icon (macOS)** — `BrowserWindow({ icon })` is *ignored* on macOS; the Dock icon comes from the app bundle. In dev that bundle is `Electron.app`, so [main.js](main.js) calls `app.dock.setIcon()` in `whenReady()` to override it at runtime.

What you **cannot** fix while running unpackaged: the macOS menu-bar app name (top-left, next to the Apple menu) reads "Electron" because it comes from `Electron.app`'s `Info.plist`. Neither `app.setName()` nor any runtime call reliably overrides it. The only real fix is packaging — see below.

## Packaging (for later — not set up yet)

Packaging produces a real `.app`/`.exe` bundle with the correct name, icon, *and* macOS menu-bar name. Recommended: `electron-builder`.

1. `npm i -D electron-builder`
2. Convert the icon to platform formats. macOS wants `.icns`, Windows wants `.ico`; electron-builder auto-generates them from a single ≥512×512 PNG if you point `build.icon` at `assets/icon.png` (or use `iconutil`/`png2icns` to make `.icns` by hand).
3. Add to [package.json](package.json):
   ```json
   "build": {
     "appId": "com.vibesmachine.app",
     "productName": "vibes machine",
     "icon": "assets/icon.png",
     "files": ["main.js", "preload.js", "renderer/**", "assets/**"],
     "mac": { "category": "public.app-category.productivity" }
   },
   "scripts": { "dist": "electron-builder" }
   ```
4. `npm run dist` → bundle in `dist/`. `productName` becomes the menu-bar name and `.app` filename; `icon` becomes the Dock/file icon. The runtime `app.dock.setIcon()` call is harmless in a packaged build (it just re-sets the same icon) but becomes redundant.

Note: a packaged build reads `app.getPath('userData')` from `productName`, so existing dev data under `…/Application Support/vibes-machine/` carries over only if `productName` resolves to the same `vibes-machine` folder. It won't (`productName` is `"vibes machine"` with a space) — decide whether to migrate or accept a fresh data dir.

## What's deliberately not here

No bundler, no TypeScript, no Vite, no HMR, no `electron-builder` packaging, no auto-updater, no custom protocol, no menu beyond Electron defaults. Add any of these only when they pay for themselves. Cmd+R reloads the renderer after edits to [renderer/](renderer/); main process changes need a full app restart (`Cmd+Q`, `npm start`).
