import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const restoreDatabasePattern = /^kulture_restore_[0-9]{14}(?:_[a-f0-9]{8})?$/;
export function isolatedWorkerURL(raw: string, database: string): string {
  if (!restoreDatabasePattern.test(database))
    throw new Error('Replay requires an isolated kulture_restore_ timestamp database');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username) !== 'kulture_worker' ||
    url.hash ||
    url.search
  )
    throw new Error('A dedicated kulture_worker database URL without query overrides is required');
  const original = decodeURIComponent(url.pathname.slice(1));
  if (original === database)
    throw new Error('Provide the source worker URL; replay derives a distinct isolated database');
  url.pathname = '/' + database;
  return url.toString();
}
export function parseJournal(data: Buffer): {
  schemaVersion: 1;
  exportedAt: string;
  sourceDatabase: string;
  highWaterSequence: string;
  entries: unknown[];
  holds: unknown[];
} {
  if (data.byteLength > 256 * 1024 * 1024)
    throw new Error('Journal exceeds the recovery size limit');
  const value = JSON.parse(data.toString('utf8'));
  if (
    value?.schemaVersion !== 1 ||
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.sourceDatabase !== 'string' ||
    !/^[0-9]+$/.test(value.highWaterSequence) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.holds)
  )
    throw new Error('Unsupported retention journal envelope');
  return value;
}
export async function validateRestoreMedia(root: string, database: string): Promise<string> {
  const path = resolve(root);
  if (path !== (await realpath(path)) || (await stat(path)).isDirectory() !== true)
    throw new Error('Restore media must be a real extracted directory, not a symlink');
  const marker = JSON.parse(await readFile(resolve(path, '.kulture-restore.json'), 'utf8'));
  if (
    marker?.schemaVersion !== 1 ||
    marker.database !== database ||
    !restoreDatabasePattern.test(database)
  )
    throw new Error('Restore media marker does not match the isolated database');
  // Host restore paths retain the generated basename. The container mount has a fixed isolated alias.
  if (basename(path) !== database + '-media' && path !== '/restore-media')
    throw new Error('Unexpected restore-media location');
  return path;
}
async function verifyWorker(client: pg.PoolClient, database?: string) {
  const row = (
    await client.query(
      'SELECT current_user AS role,current_database() AS database,rolsuper FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  if (row?.role !== 'kulture_worker' || row.rolsuper || (database && row.database !== database))
    throw new Error(
      'Recovery requires the dedicated non-superuser worker role on the expected database',
    );
  return String(row.database);
}
async function exportJournal() {
  const raw = process.env.WORKER_DATABASE_URL;
  if (!raw) throw new Error('WORKER_DATABASE_URL is required');
  const url = new URL(raw);
  if (decodeURIComponent(url.username) !== 'kulture_worker')
    throw new Error('Export requires the dedicated worker role');
  const pool = new pg.Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const database = await verifyWorker(db);
    const entries = (
      await db.query(
        `SELECT id,tenant_id AS "tenantID",place_id AS "placeID",entity_type AS "entityType",entity_id AS "entityID",deleted_at AS "deletedAt",reason,object_keys AS "objectKeys" FROM retention_tombstones ORDER BY sequence`,
      )
    ).rows;
    const holds = (
      await db.query(
        `SELECT id,tenant_id AS "tenantID",place_id AS "placeID",entity_type AS "entityType",entity_id AS "entityID",reason,created_at AS "createdAt",released_at AS "releasedAt",release_reason AS "releaseReason" FROM retention_holds ORDER BY created_at,id`,
      )
    ).rows;
    const highWaterSequence = String(
      (
        await db.query(
          'SELECT coalesce(max(sequence),0)::text AS sequence FROM retention_tombstones',
        )
      ).rows[0].sequence,
    );
    const exportedAt = (
      await db.query('SELECT transaction_timestamp() AS time')
    ).rows[0].time.toISOString();
    await db.query('COMMIT');
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        exportedAt,
        sourceDatabase: database,
        highWaterSequence,
        entries,
        holds,
      }) + '\n',
    );
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
async function replayJournal(args: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--database', '--journal', '--sha256', '--media-root'].includes(args[i]) ||
      !args[i + 1] ||
      options.has(args[i])
    )
      throw new Error('Invalid replay arguments');
    options.set(args[i], args[i + 1]);
  }
  if (options.size !== 4)
    throw new Error('Replay requires --database, --journal, --sha256 and --media-root');
  const database = options.get('--database')!,
    source = process.env.WORKER_DATABASE_URL;
  if (!source) throw new Error('WORKER_DATABASE_URL is required');
  const workerURL = isolatedWorkerURL(source, database);
  const mediaRoot = await validateRestoreMedia(options.get('--media-root')!, database);
  const bytes = await readFile(options.get('--journal')!);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(options.get('--sha256')!) || digest !== options.get('--sha256'))
    throw new Error('Retention journal checksum does not match');
  const journal = parseJournal(bytes);
  if (journal.sourceDatabase !== decodeURIComponent(new URL(source).pathname.slice(1)))
    throw new Error('Journal source database does not match the configured source');
  // No application/config/auth/storage import is permitted before every URL and media path is rebound.
  process.env.DATABASE_URL = workerURL;
  process.env.AUTH_DATABASE_URL = workerURL;
  process.env.WORKER_DATABASE_URL = workerURL;
  process.env.MEDIA_ROOT = mediaRoot;
  delete process.env.ADMIN_DATABASE_URL;
  const { pool, workerPool } = await import('../src/db.js');
  try {
    const db = await workerPool.connect();
    try {
      await verifyWorker(db, database);
    } finally {
      db.release();
    }
    const { replayRetention, drainRetentionFiles } = await import('../src/modules/retention.js');
    // ALL current holds (including releases) are installed before any tombstone applies.
    for (let i = 0; i < journal.holds.length; i += 1000)
      await replayRetention([], journal.holds.slice(i, i + 1000), { drain: false });
    let replayed = 0;
    for (let i = 0; i < journal.entries.length; i += 100)
      replayed += (await replayRetention(journal.entries.slice(i, i + 100), [], { drain: false }))
        .replayed;
    let pending = Number(
      (
        await workerPool.query(
          'SELECT count(*) AS count FROM retention_tombstones WHERE files_deleted_at IS NULL',
        )
      ).rows[0].count,
    );
    while (pending > 0) {
      const deleted = await drainRetentionFiles(100);
      const next = Number(
        (
          await workerPool.query(
            'SELECT count(*) AS count FROM retention_tombstones WHERE files_deleted_at IS NULL',
          )
        ).rows[0].count,
      );
      if (deleted === 0 || next >= pending)
        throw new Error('Retention cleanup remains blocked; quarantine this restore');
      pending = next;
    }
    process.stdout.write(
      JSON.stringify({
        database,
        replayed,
        holds: journal.holds.length,
        pendingFiles: 0,
        journalSHA256: digest,
        exportedAt: journal.exportedAt,
        cutoverApproved: false,
      }) + '\n',
    );
  } finally {
    await Promise.all([pool.end(), ...(workerPool !== pool ? [workerPool.end()] : [])]);
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === 'export') return exportJournal();
  if (args[0] === 'replay') return replayJournal(args.slice(1));
  throw new Error(
    'Usage: retention-recovery export | replay --database kulture_restore_TIMESTAMP --journal FILE --sha256 HASH --media-root DIR',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code =
      typeof error?.code === 'string' && /^[a-zA-Z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : '';
    process.stderr.write(
      `Retention recovery failed${code}. No cutover approval. Check the supplied archive, worker role, restore marker and legal holds; database and media stay quarantined.\n`,
    );
    process.exitCode = 1;
  });
}
