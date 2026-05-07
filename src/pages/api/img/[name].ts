export const prerender = false;

import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';

const SCREENSHOTS_DIR = import.meta.env.PROD
  ? path.resolve('./dist/client/screenshots')
  : path.resolve('./public/screenshots');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

export const GET: APIRoute = async ({ params }) => {
  const name = params.name;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return new Response('not found', { status: 404 });
  }
  const filePath = path.join(SCREENSHOTS_DIR, name);
  if (!fs.existsSync(filePath)) {
    return new Response('not found', { status: 404 });
  }
  const ext = path.extname(name).toLowerCase();
  const type = MIME_TYPES[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};

export const DELETE: APIRoute = async ({ params }) => {
  const name = params.name;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return new Response(JSON.stringify({ error: 'invalid name' }), { status: 400 });
  }
  const filePath = path.join(SCREENSHOTS_DIR, name);
  if (!fs.existsSync(filePath)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  fs.unlinkSync(filePath);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
