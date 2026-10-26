import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedWorkerURL,
  parseJournal,
  validateRestoreMedia,
} from '../scripts/retention-recovery.js';

test('recovery URL guard rejects live targets and rebinds only the isolated database', () => {
  const source = 'postgresql://kulture_worker:fixture-password@db:5432/kulture';
  const result = new URL(isolatedWorkerURL(source, 'kulture_restore_20260929120000_abcd1234'));
  assert.equal(result.pathname, '/kulture_restore_20260929120000_abcd1234');
  assert.equal(result.username, 'kulture_worker');
  assert.equal(result.hostname, 'db');
  for (const name of [
    'kulture',
    'postgres',
    'kulture_restore_',
    'kulture_restore_live',
    'kulture_restore_20260929120000/../kulture',
  ])
    assert.throws(() => isolatedWorkerURL(source, name));
  for (const url of [
    source.replace('kulture_worker', 'kulture_admin'),
    source + '?options=-crole%3Dkulture_admin',
    source + '#override',
    source.replace('/kulture', '/kulture_restore_20260929120000'),
  ])
    assert.throws(() => isolatedWorkerURL(url, 'kulture_restore_20260929120000'));
});
test('retention export envelope requires chronology, sequence and complete hold collection', () => {
  const body = {
    schemaVersion: 1,
    exportedAt: '2026-09-29T12:00:00Z',
    sourceDatabase: 'kulture',
    highWaterSequence: '23',
    entries: [],
    holds: [],
  };
  assert.equal(parseJournal(Buffer.from(JSON.stringify(body))).highWaterSequence, '23');
  for (const patch of [
    { schemaVersion: 2 },
    { exportedAt: 'bad' },
    { highWaterSequence: '-1' },
    { holds: undefined },
    { entries: {} },
  ])
    assert.throws(() => parseJournal(Buffer.from(JSON.stringify({ ...body, ...patch }))));
});
test('restore media guard requires matching marker and refuses symlink or live-like paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kulture-recovery-policy-')));
  const database = 'kulture_restore_20260929120000';
  const media = join(root, database + '-media');
  try {
    await mkdir(media);
    await writeFile(
      join(media, '.kulture-restore.json'),
      JSON.stringify({ schemaVersion: 1, database }),
    );
    assert.equal(await validateRestoreMedia(media, database), media);
    await assert.rejects(validateRestoreMedia(media, 'kulture_restore_20260929120001'));
    await symlink(media, join(root, 'linked'));
    await assert.rejects(validateRestoreMedia(join(root, 'linked'), database));
    const live = join(root, 'media');
    await mkdir(live);
    await writeFile(
      join(live, '.kulture-restore.json'),
      JSON.stringify({ schemaVersion: 1, database }),
    );
    await assert.rejects(validateRestoreMedia(live, database));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
