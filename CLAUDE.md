# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server at http://127.0.0.1:4321 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `node ./dist/server/entry.mjs` | Run the built server directly. `PORT=4322` to override |

There is no test runner, linter, or formatter configured.

## Architecture

Astro 5 in **SSR mode** (`output: 'server'`) with the `@astrojs/node` standalone adapter. The whole app is three files:

- [src/pages/index.astro](src/pages/index.astro) — server-renders the masonry grid by `readdirSync`-ing the screenshots directory on every request, sorted by mtime desc. Inline `<script is:inline>` handles the modal viewer, paste-to-upload, and delete. No bundler/framework on the client.
- [src/pages/api/upload.ts](src/pages/api/upload.ts) — `POST /api/upload`, multipart form field `image`, max 25 MB, writes `paste-<iso-ts>-<rand4>.<ext>` to the screenshots dir.
- [src/pages/api/img/[name].ts](src/pages/api/img/[name].ts) — `GET` and `DELETE` for individual files. GET sets `Cache-Control: public, max-age=31536000, immutable`.

### The mode-aware screenshots directory

The same constant is duplicated in all three files above:

```ts
const SCREENSHOTS_DIR = import.meta.env.PROD
  ? path.resolve('./dist/client/screenshots')
  : path.resolve('./public/screenshots');
```

This is intentional, not a refactor target. Reason: `@astrojs/node` copies `public/` into `dist/client/` at build, so the running production server reads/writes the *built copy* — touching `public/screenshots/` in prod has no effect. **If you change this path, update all three files.**

### Why uploads are served through `/api/img/[name]` instead of `/screenshots/`

Astro serves `public/` (or `dist/client/` in prod) as static files, but new uploads written at runtime aren't always picked up by the static handler — and in dev, Vite's public-folder watcher fights the writes. The `/api/img/[name].ts` route reads from disk on each request, so newly written files are immediately visible.

### Client-side paste flow ([src/pages/index.astro](src/pages/index.astro:415))

After a successful upload the page does `window.location.reload()` rather than optimistically prepending to the grid. Optimistic insert was tried and removed — the comment at [src/pages/index.astro:399-401](src/pages/index.astro#L399-L401) explains: Vite's public-folder watcher races the optimistic DOM update in dev. Reload re-runs SSR and is the single source of truth.

## Gotchas

- **Same-origin POST check.** Astro 5 rejects cross-origin POSTs. Browser paste works (sends `Origin`). For `curl` testing, pass `-H "Origin: http://127.0.0.1:4321"`.
- **`export const prerender = false`** is required at the top of every API route — without it, Astro tries to prerender them at build time even with `output: 'server'`.
- **`public/screenshots/*` is gitignored** (only `.gitkeep` is tracked). Don't commit screenshot files.
- **Path traversal guard** in [api/img/[name].ts](src/pages/api/img/[name].ts#L23) rejects `/`, `\`, `..`. Keep this in any new file-name route.
