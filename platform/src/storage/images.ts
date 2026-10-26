import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mediaStorage } from './filesystem.js';
import { HttpError } from '../db.js';
let active = 0;
const waiting: Array<() => void> = [];
async function acquire() {
  if (active < 2) {
    active++;
    return;
  }
  if (waiting.length >= 8)
    throw new HttpError(
      429,
      'image_processing_busy',
      'Image processing is busy. Try again shortly.',
    );
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}
export async function processImage(id: string, originalKey: string) {
  await acquire();
  try {
    const source = sharp(mediaStorage.path(originalKey), {
      limitInputPixels: 40_000_000,
      animated: false,
      failOn: 'warning',
    });
    const meta = await source.metadata();
    if (
      !['jpeg', 'png', 'webp'].includes(meta.format || '') ||
      !meta.width ||
      !meta.height ||
      (meta.pages ?? 1) > 1
    )
      throw new HttpError(415, 'unsupported_image', 'Use a non-animated JPEG, PNG or WebP image.');
    const key = `derivatives/${id}/image.webp`;
    await mkdir(dirname(mediaStorage.path(key)), { recursive: true, mode: 0o700 });
    // Sharp strips source metadata by default; rotate applies EXIF orientation before removal.
    const result = await source
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(mediaStorage.path(key));
    const bytes = await mediaStorage.read(key);
    return {
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: result.width,
      height: result.height,
      bytes: result.size,
      mime: 'image/webp',
    };
  } finally {
    release();
  }
}
