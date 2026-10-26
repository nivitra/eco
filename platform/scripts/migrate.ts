import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from '../src/auth-options.js';
import { pool, workerPool } from '../src/db.js';
const url = process.env.ADMIN_DATABASE_URL;
if (!url) throw new Error('ADMIN_DATABASE_URL required for migrations only');
const admin = new pg.Pool({ connectionString: url, max: 1 });
const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
const db = await admin.connect();
try {
  await db.query('SELECT pg_advisory_lock(18092026)');
  for (const [role, key, extra] of [
    ['kulture_app', 'APP_DB_PASSWORD', 'NOBYPASSRLS'],
    ['kulture_auth', 'AUTH_DB_PASSWORD', 'NOBYPASSRLS'],
    ['kulture_worker', 'WORKER_DB_PASSWORD', 'BYPASSRLS'],
  ]) {
    const password = process.env[key];
    if (!password || password.length < 24)
      throw new Error(`${key} must have at least 24 random characters`);
    if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
      await db.query(
        `CREATE ROLE ${role} LOGIN PASSWORD ${quote(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE ${extra}`,
      );
  }
  await db.query('CREATE SCHEMA IF NOT EXISTS auth');
  await db.query('REVOKE ALL ON SCHEMA auth FROM PUBLIC');
  await db.query('GRANT USAGE ON SCHEMA auth TO kulture_auth');
  await db.query('ALTER ROLE kulture_auth SET search_path=auth,public');
  await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const migrationNames = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const through = process.argv.find((a) => a.startsWith('--through='))?.slice('--through='.length);
  if (through && !migrationNames.includes(through)) throw new Error('Unknown --through migration');
  for (const name of migrationNames.filter((n) => !through || n <= through)) {
    const sql = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const prior = await db.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]);
    if (prior.rows[0]) {
      if (prior.rows[0].sha256 !== digest)
        throw new Error(`Migration ${name} changed after application`);
      continue;
    }
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, digest]);
      await db.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
  const authAdmin = new pg.Pool({
    connectionString: url,
    options: '-c search_path=auth,public',
    max: 1,
  });
  try {
    const migrations = await getMigrations(authOptions(authAdmin));
    await migrations.runMigrations();
  } finally {
    await authAdmin.end();
  }
  await db.query('GRANT USAGE ON SCHEMA public TO kulture_app,kulture_worker');
  await db.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO kulture_app,kulture_worker',
  );
  await db.query(
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO kulture_app,kulture_worker',
  );
  await db.query('REVOKE ALL ON schema_migrations,quota_buckets FROM kulture_app');
  await db.query('REVOKE UPDATE,DELETE ON audit_log FROM kulture_app');
  await db.query('REVOKE INSERT,UPDATE,DELETE ON spatial_ref_sys FROM kulture_app,kulture_worker');
  await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA auth TO kulture_auth');
  await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA auth TO kulture_auth');
  console.log('Migrations and isolated runtime roles ready');
} finally {
  await db.query('SELECT pg_advisory_unlock(18092026)');
  db.release();
  await Promise.all([admin.end(), pool.end(), ...(workerPool !== pool ? [workerPool.end()] : [])]);
}
