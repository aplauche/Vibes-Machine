# vibes-machine

Local screenshots vault. A tiny Electron app that turns a folder of screenshots
into a Pinterest-style masonry grid. Click an image for a fullscreen modal,
paste from the clipboard to add new ones.

## Setup

```bash
npm install
npm start
```

## Usage

- **Add:** paste with `⌘V`, drag image files in from Finder, or drop them
  directly into the screenshots folder. Saved as
  `paste-<timestamp>-<rand>.<ext>`. Max 25 MB per image.
  Supported types: `png, jpg, jpeg, gif, webp, avif, bmp`.
- **Modal:** click any image to open. Arrow keys navigate, `Esc` closes.
- **Reveal in Finder:** hover a thumbnail, click the ↗ in the corner.
- **Delete:** hover a thumbnail, click the × in the corner.
- **Change folder:** click the ⚙ cog in the header.

## Where files live

| What | Path |
| --- | --- |
| Screenshots (default) | `~/Library/Application Support/vibes-machine/screenshots/` |
| Settings | `~/Library/Application Support/vibes-machine/config.json` |

The screenshots folder is configurable: click the **⚙ cog** in the header to
pick a different folder via the native picker. Your choice is persisted in
`config.json`. Switching folders does not move existing files — the new folder
just becomes the source.

## How it works

- **Electron 33**, plain JavaScript, no bundler.
- Main process ([main.js](main.js)) owns the filesystem; renderer talks to it
  via a `contextBridge` IPC surface (`window.vibes.{list,save,delete,onChanged}`).
- Images render via `<img src="file:///…">` directly — no custom protocol.
- `fs.watch` on the screenshots dir broadcasts a `vibes:changed` event to the
  renderer (debounced 75 ms) which reconciles state by re-listing.

See [CLAUDE.md](CLAUDE.md) for architecture details.

## Legacy version

The original Astro 5 SSR version is preserved under [legacy/](legacy/) as a
fallback reference. Run with `cd legacy && npm i && npm run dev`.
