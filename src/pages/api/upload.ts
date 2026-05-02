export const prerender = false;

import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';

const SCREENSHOTS_DIR = import.meta.env.PROD
  ? path.resolve('./dist/client/screenshots')
  : path.resolve('./public/screenshots');

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};

const MAX_BYTES = 25 * 1024 * 1024;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const file = form.get('image');
    if (!(file instanceof File)) {
      return json({ error: 'missing image field' }, 400);
    }
    const ext = MIME_EXT[file.type];
    if (!ext) {
      return json({ error: `unsupported type: ${file.type}` }, 400);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: 'file too large' }, 413);
    }

    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 6);
    const name = `paste-${ts}-${rand}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, name), buf);

    return json({
      name,
      src: `/screenshots/${encodeURIComponent(name)}`,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};
