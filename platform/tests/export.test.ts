import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { archiveStream, archiveByteLength, tarHeader, EXPORT_LIMITS } = await import(
  '../src/modules/export.js'
);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const entry = (path: string, bytes: Buffer) => ({
  path,
  size: bytes.length,
  sha256: sha256(bytes),
  load: async () => bytes,
});

test('portable archive extracts with the system tar, preserving Unicode bytes and media exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kulture-archive-unit-'));
  try {
    const facts = Buffer.from('{"name":"నమస్తే Café — ₹299"}\n'),
      image = Buffer.from([82, 73, 70, 70, 0, 255, 128, 0, 87, 69, 66, 80]);
    const entries = [
      entry('facts.json', facts),
      entry('media/test.webp', image),
      entry('empty.txt', Buffer.alloc(0)),
    ];
    const archive = Buffer.from(
      await new Response(archiveStream(entries, new Date('2026-09-29T10:00:00Z'))).arrayBuffer(),
    );
    assert.equal(archive.length, archiveByteLength(entries));
    await writeFile(join(dir, 'export.tar'), archive);
    await promisify(execFile)('tar', ['-xf', 'export.tar'], { cwd: dir });
    assert.deepEqual(await readFile(join(dir, 'facts.json')), facts);
    assert.deepEqual(await readFile(join(dir, 'media/test.webp')), image);
    assert.equal((await readFile(join(dir, 'empty.txt'))).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('unsafe paths, duplicate entries and oversized archive plans are rejected before reads', () => {
  for (const path of ['../proof', '/absolute', 'a/../../b', 'a//b', 'a/./b', 'a\\b', 'a\nname'])
    assert.throws(() => tarHeader(path, 1, new Date()));
  const file = entry('facts.json', Buffer.from('facts'));
  assert.throws(() => archiveByteLength([file, file]));
  assert.throws(() => archiveByteLength([{ ...file, size: EXPORT_LIMITS.archiveBytes }]));
});
test('changed or corrupt content aborts rather than returning a valid incomplete archive', async () => {
  const file = {
    ...entry('media/test.webp', Buffer.from('approved')),
    load: async () => Buffer.from('tampered'),
  };
  await assert.rejects(
    () => new Response(archiveStream([file], new Date())).arrayBuffer(),
    /changed/,
  );
});
test('cancelled archive does not load later media', async () => {
  let reads = 0;
  const first = entry('facts.json', Buffer.from('facts'));
  const later = {
    ...entry('media/test.webp', Buffer.from('approved')),
    load: async () => {
      reads++;
      return Buffer.from('approved');
    },
  };
  const reader = archiveStream([first, later], new Date()).getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(reads, 0);
});

after(async () => {
  const { pool, workerPool } = await import('../src/db.js'),
    { authPool } = await import('../src/auth.js');
  await Promise.all([
    pool.end(),
    authPool.end(),
    ...(workerPool !== pool ? [workerPool.end()] : []),
  ]);
});
