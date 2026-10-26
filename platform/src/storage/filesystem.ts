import { mkdir, rm, readFile, stat, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../db.js';

export interface ObjectStorage {
  write(key: string, body: ReadableStream<Uint8Array>, limit: number): Promise<number>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  path(key: string): string;
  size(key: string): Promise<number>;
}
export class FileObjectStorage implements ObjectStorage {
  constructor(private root = process.env.MEDIA_ROOT || './media') {}
  path(key: string) {
    if (!/^(private|derivatives)\/[a-f0-9-]{36}\/[a-z0-9][a-z0-9.-]*$/.test(key))
      throw new Error('Invalid object key');
    const base = resolve(this.root),
      path = resolve(base, key);
    if (!path.startsWith(base + '/')) throw new Error('Invalid object path');
    return path;
  }
  async write(key: string, body: ReadableStream<Uint8Array>, limit: number) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    let bytes = 0;
    const bound = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit)
          callback(new HttpError(413, 'media_too_large', 'Images must be at most 5 MiB.'));
        else callback(null, chunk);
      },
    }); // The caller records failed/partial objects for hold-aware, journaled worker cleanup.
    // Never unlink here: legal holds can be created while a stream is still arriving.
    await pipeline(Readable.fromWeb(body as any), bound, file.createWriteStream());
    return bytes;
  }
  async read(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async size(key: string) {
    return (await stat(this.path(key))).size;
  }
}
export const mediaStorage = new FileObjectStorage();
