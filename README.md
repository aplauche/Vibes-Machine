# vibes-machine

A tiny local site that turns a folder of screenshots into a Pinterest-style
masonry grid. Click an image for a fullscreen modal, paste from the clipboard
to add new ones.

## Setup

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4321.

## Usage

- **View:** drop image files into `public/screenshots/` and refresh. Newest
  files appear first. Supported types: `png, jpg, jpeg, gif, webp, avif, bmp`.
- **Paste:** press `⌘V` anywhere on the page (or click the paste zone in the
  header first). The image is uploaded to `public/screenshots/` and prepended
  to the grid without a refresh. Saved as `paste-<timestamp>-<rand>.<ext>`.
  Max 25 MB per image.
- **Modal:** click any image to open. Arrow keys navigate, `Esc` closes.

## Commands

| Command              | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Dev server at http://127.0.0.1:4321                |
| `npm run build`      | Production build into `dist/`                      |
| `npm run preview`    | Serve the production build                         |
| `node ./dist/server/entry.mjs` | Run the built server directly. `PORT=4322` to override |

## How it works

- **Astro 5** with the **`@astrojs/node`** standalone adapter (`output: 'server'`),
  so the index page lists screenshots on every request rather than freezing
  them at build time.
- The grid uses CSS columns (`5 → 4 → 3 → 2 → 1` by viewport width) — no JS
  layout library.
- Uploads go to `POST /api/upload` (`src/pages/api/upload.ts`).

### Where files live

The screenshot directory is mode-aware:

| Mode        | Path                        |
| ----------- | --------------------------- |
| Dev         | `./public/screenshots/`     |
| Production  | `./dist/client/screenshots/` |

This is because the Node adapter copies `public/` into `dist/client/` at
build, so the running production server reads/writes the built copy.

### Gotcha: CSRF on direct API calls

Astro 5 enforces a same-origin check on POSTs. Browser paste calls send the
`Origin` header automatically and pass. If you want to test with `curl`, add
the header explicitly:

```bash
curl -X POST \
  -H "Origin: http://127.0.0.1:4321" \
  -F "image=@some.png;type=image/png" \
  http://127.0.0.1:4321/api/upload
```
