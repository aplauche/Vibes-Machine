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

- [main.js](main.js) — main process. Owns the linked-folder list, IPC handlers (`vibes:list/save/delete/reveal`, `vibes:folders:*`), one `fs.watch` per folder sharing a 75 ms debounce that broadcasts `vibes:changed`, config persistence, BrowserWindow creation.
- [preload.js](preload.js) — `contextBridge.exposeInMainWorld('vibes', { list, save, delete, reveal, folders, onChanged })`. Sandbox-safe, CommonJS, no Node API leakage to renderer.
- [renderer/index.html](renderer/index.html) — folder sidebar + main column (paste-zone, grid), modal. Strict CSP (`script-src 'self'`, `img-src file: data: 'self'`).
- [renderer/main.js](renderer/main.js) — DOM event wiring, `state` source-of-truth model, sidebar rendering, modal/keyboard nav, paste-to-upload with optimistic prepend, `vibes.onChanged` reconciliation.
- [renderer/styles.css](renderer/styles.css) — port of the legacy CSS, plus the sidebar.

### Linked folders

The app curates **several** folders at once. `FOLDERS` (`[{ id, path }]`) and `ACTIVE_FOLDER_ID` are module-scoped mutables in [main.js](main.js), loaded at startup from `<userData>/config.json`:

```json
{ "version": 2, "folders": [{ "id": "a1b2c3d4", "path": "/abs/path" }], "activeFolderId": "a1b2c3d4" }
```

Ids are `crypto.randomUUID().slice(0, 8)` — stable across renames, safe in `data-` attributes. `loadConfig()` migrates the old v1 `{ screenshotsDir }` shape into a one-folder list on first read. With no config at all it falls back to `path.join(app.getPath('userData'), 'screenshots')` (macOS: `~/Library/Application Support/vibes-machine/screenshots/`).

**View vs. write target.** The sidebar's rows are tabs: `all` plus one per folder. The renderer's `state.view` (`'all'` or a folder id) is what the grid shows and lives in `localStorage`; `ACTIVE_FOLDER_ID` is where pastes land and lives in `config.json`. Selecting a folder row sets both. Selecting `all` only widens the view — the write target stays put, since `all` is not a place files can go. The paste zone appends `→ <label>` whenever the two differ, so the destination is never implicit.

**Removing a folder unlinks only** — `removeFolder()` never touches disk. It stops that folder's watcher, splices the entry, promotes a neighbour if the active one went away, and re-links the default if the list would otherwise be empty (paste always needs a target).

**Adding** rejects a path that is already linked, or that is nested inside / contains an existing one — overlapping folders would list the same image twice.

Unreachable folders (deleted, unmounted, permissions) stay linked and simply list empty, flagged `available: false` for the sidebar's ⚠. Startup deliberately does **not** `mkdir -p` existing links: re-creating a folder the user deleted, or stubbing out an unplugged drive's mount point, is worse than showing it as unavailable. Only a fallback folder gets created, and only when nothing else is reachable.

`app.setName('vibes-machine')` runs **synchronously at module top** in [main.js](main.js). If anything reads `app.getPath('userData')` before `setName`, dev resolves to `~/Library/Application Support/Electron` and prod to the productName, breaking dev↔prod parity. Same for `app.setPath('userData', …)` — both run before `whenReady`.

### IPC contract

Promise-based via `ipcMain.handle` / `ipcRenderer.invoke`. Items are identified by **`{ folderId, name }`**, never by `name` alone — two linked folders may legitimately hold the same filename.

- `vibes:list({ folderId })` → `[{ id, name, folderId, mtime, src }]` sorted mtime desc, merged across folders when `folderId` is `'all'`. `id` is `` `${folderId}:${name}` ``; `src` is `pathToFileURL(absPath).href`, ready for `<img src>`.
- `vibes:save({ bytes: ArrayBuffer, mime, folderId })` → one item. Validates MIME against whitelist + `bytes.byteLength <= 25 MB` in main, not preload. Defaults to the active folder.
- `vibes:delete({ folderId, name })` → `{ ok: true }`.
- `vibes:reveal({ folderId, name })` → `{ ok: true }`, then `shell.showItemInFolder(absPath)`.
- `vibes:folders:list` → `{ folders: [{ id, path, display, label, isDefault, available, count }], activeFolderId }`. Doubles as the availability re-check — a remounted folder gets its watcher restored here.
- `vibes:folders:add` → native picker, then `addFolder`. `{ folder, folders, activeFolderId }`, or `null` if canceled.
- `vibes:folders:remove({ id })` / `vibes:folders:setActive({ id })` → `{ ok: true, … }`.

`resolveInFolder(folderId, name)` is the **single** guard for every renderer-supplied path: unknown-folder check, `safeName()` traversal check, and a `path.resolve` containment check against that folder. Delete and reveal both go through it — don't re-implement the check at a call site.

Plus a one-way push: `webContents.send('vibes:changed')` from the watcher debouncer and from every folder mutation; renderer subscribes via `vibes.onChanged(cb)` (returns an unsubscribe function).

### Why optimistic prepend works here

The legacy code disabled optimistic insert because Vite's public-folder watcher raced the DOM update. In Electron, the main process is the **single writer to disk**, so there's no watcher race: the renderer prepends immediately after `vibes.save()` resolves, and the inevitable `vibes:changed` reconciliation through `refresh()` is a no-op for the just-inserted item (de-duped by composite `id` in [renderer/main.js](renderer/main.js)). The prepend is skipped entirely when the new file's folder isn't in view — writing to a folder the grid isn't showing must not fabricate a tile.

## Gotchas

- **Renderer cannot use Node APIs.** `sandbox: true, contextIsolation: true, nodeIntegration: false` is non-negotiable. Anything FS happens in main, gets exposed via the `vibes` bridge. Don't import `node:fs` in [renderer/main.js](renderer/main.js) — it'll throw at load time.
- **Preload is also sandboxed.** Only `electron` and a small allowlisted set of `node:` modules work. Don't try to do byte-handling in preload — pass `ArrayBuffer` through to main.
- **CSP must allow `file:` for images.** The meta tag in [renderer/index.html](renderer/index.html) sets `img-src file: data: 'self'`. Without `file:`, every thumbnail silently 404s.
- **`fs.watch` fires multiple events per write on macOS.** The 75 ms debounce in [main.js](main.js) coalesces them, and it is *shared across every folder's watcher* — the renderer re-lists wholesale, so which folder fired doesn't matter. Watch event payloads are unreliable (filename can be `undefined`); the design just invalidates and re-lists.
- **`app.setName` ordering** — see "Linked folders" above. If userData resolves wrong in dev, this is why.
- **The masonry breakpoints are viewport-based**, so the four `max-width` queries in [renderer/styles.css](renderer/styles.css) are each offset by `--sidebar-w` (200px) to account for the rail. Change the sidebar width and they need the same shift.
- **`ELECTRON_RUN_AS_NODE=1` in your shell breaks `npm start`** with `Cannot read properties of undefined (reading 'setName')` — `require('electron')` returns a path string instead of the module. Unset it.

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
