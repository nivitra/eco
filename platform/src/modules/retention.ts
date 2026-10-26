import type { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireOps } from '../ops-auth.js';
import { workerPool, audit, HttpError, canonical } from '../db.js';
import { mediaStorage } from '../storage/filesystem.js';
import { locationEntitlement } from './entitlements.js';

export const RETENTION_LOCK = 20472901;
const LOCK = RETENTION_LOCK;
const typeSchema = z.enum(['claim_proof', 'merchant_draft', 'media_asset']);
type Kind = z.infer<typeof typeSchema>;
export function claimProofRetentionDays(value = process.env.CLAIM_PROOF_RETENTION_DAYS): number {
  if (value === undefined || value === '') return 180;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 30 || days > 3650)
    throw new Error('CLAIM_PROOF_RETENTION_DAYS must be an integer from 30 to 3650');
  return days;
}
const journalEntry = z
  .object({
    id: z.uuid(),
    tenantID: z.uuid(),
    placeID: z.string().min(1).max(160),
    entityType: typeSchema,
    entityID: z.uuid(),
    deletedAt: z.iso.datetime({ offset: true }),
    reason: z.string().min(1).max(100),
    objectKeys: z.array(z.string().max(160)).max(2),
  })
  .strict();
type Entry = z.infer<typeof journalEntry>;
const holdSchema = z
  .object({
    id: z.uuid(),
    tenantID: z.uuid(),
    placeID: z.string().min(1).max(160).nullable(),
    entityType: typeSchema.nullable(),
    entityID: z.uuid().nullable(),
    reason: z.string().min(10).max(2000),
    createdAt: z.iso.datetime({ offset: true }),
    releasedAt: z.iso.datetime({ offset: true }).nullable(),
    releaseReason: z.string().min(10).max(2000).nullable(),
  })
  .strict()
  .refine(
    (h) =>
      (h.entityType === null) === (h.entityID === null) &&
      (h.releasedAt === null) === (h.releaseReason === null) &&
      (!h.releasedAt || Date.parse(h.releasedAt) >= Date.parse(h.createdAt)),
  );
function holdEntry(r: any) {
  return {
    id: r.id,
    tenantID: r.tenant_id,
    placeID: r.place_id,
    entityType: r.entity_type,
    entityID: r.entity_id,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
    releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
    releaseReason: r.release_reason,
  };
}
const notHeld = (alias: string, kind: Kind, id = 'id') =>
  `NOT EXISTS(SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.tenant_id=${alias}.tenant_id AND (h.place_id IS NULL OR h.place_id=${alias}.place_id) AND (h.entity_type IS NULL OR (h.entity_type='${kind}' AND h.entity_id=${alias}.${id})))`;

function entry(row: any): Entry {
  return {
    id: row.id,
    tenantID: row.tenant_id,
    placeID: row.place_id,
    entityType: row.entity_type,
    entityID: row.entity_id,
    deletedAt: new Date(row.deleted_at).toISOString(),
    reason: row.reason,
    objectKeys: row.object_keys,
  };
}
export function validateReplayEntry(value: unknown): Entry {
  const e = journalEntry.parse(value);
  if (e.entityType !== 'media_asset' && e.objectKeys.length)
    throw new HttpError(422, 'invalid_tombstone', 'Only asset tombstones may contain storage keys');
  for (const key of e.objectKeys)
    if (!new RegExp(`^(private|derivatives)/${e.entityID}/[a-z0-9][a-z0-9.-]*$`).test(key))
      throw new HttpError(
        422,
        'invalid_tombstone',
        'Storage key must belong to the tombstoned asset',
      );
  return e;
}
export async function retentionHeld(
  db: PoolClient,
  tenant: string,
  place: string,
  kind: Kind,
  id: string,
): Promise<boolean> {
  return !!(
    await db.query(
      `SELECT 1 FROM retention_holds WHERE tenant_id=$1 AND released_at IS NULL AND (place_id IS NULL OR place_id=$2) AND (entity_type IS NULL OR (entity_type=$3 AND entity_id=$4)) LIMIT 1`,
      [tenant, place, kind, id],
    )
  ).rowCount;
}
async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await workerPool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
async function record(db: PoolClient, row: any, kind: Kind, reason: string, keys: string[] = []) {
  await db.query(
    `INSERT INTO retention_tombstones(tenant_id,place_id,entity_type,entity_id,reason,object_keys) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(entity_type,entity_id) DO NOTHING`,
    [row.tenant_id, row.place_id, kind, row.id, reason, JSON.stringify(keys)],
  );
  await audit(db, 'worker', row.tenant_id, 'retention.deleted', row.id, {
    entityType: kind,
    reason,
  });
}
// Even revoked/expired public derivatives and shared building material require a separate reviewed process.
const SAFE_MEDIA = `m.purpose='business_photo' AND NOT EXISTS(SELECT 1 FROM public_media p WHERE p.id=m.id)
 AND NOT EXISTS(SELECT 1 FROM destination_previews p WHERE p.asset_manifest::text LIKE '%'||m.id::text||'%')
 AND NOT EXISTS(SELECT 1 FROM arrival_drafts a WHERE a.body::text LIKE '%'||m.id::text||'%')
 AND NOT EXISTS(SELECT 1 FROM arrival_releases a WHERE a.assets::text LIKE '%'||m.id::text||'%' OR a.graph::text LIKE '%'||m.id::text||'%')`;
export async function retirePrivateMedia(db: PoolClient, row: any, reason: string) {
  // The candidate SELECT can predate an approval transaction. Recheck with a fresh snapshot after its row lock.
  if (
    !(
      await db.query(
        `SELECT 1 FROM media_assets m WHERE m.id=$1 AND m.retention_deleted_at IS NULL AND ${SAFE_MEDIA}`,
        [row.id],
      )
    ).rowCount
  )
    return false;
  const keys = [row.original_key, row.derivative_key].filter((x): x is string => !!x);
  // Interrupted uploads may have written deterministic objects before recording their keys.
  if (row.state === 'processing' || row.state === 'reserved') {
    for (const key of [`private/${row.id}/original`, `derivatives/${row.id}/image.webp`])
      if (!keys.includes(key)) keys.push(key);
  }
  const e = validateReplayEntry({
    id: row.id,
    tenantID: row.tenant_id,
    placeID: row.place_id,
    entityType: 'media_asset',
    entityID: row.id,
    deletedAt: new Date().toISOString(),
    reason,
    objectKeys: keys,
  });
  await record(db, row, 'media_asset', reason, e.objectKeys);
  await db.query(
    "UPDATE media_assets SET state='revoked',original_key=NULL,derivative_key=NULL,stored_bytes=0,retention_deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",
    [row.id],
  );
  return true;
}
/** Commit a minimal journal before unlink. A crash resumes physical cleanup from that journal. */
export async function drainRetentionFiles(limit = 20): Promise<number> {
  return transaction(async (db) => {
    const rows = (
      await db.query(
        `SELECT t.* FROM retention_tombstones t WHERE t.files_deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.tenant_id=t.tenant_id AND (h.place_id IS NULL OR h.place_id=t.place_id) AND (h.entity_type IS NULL OR (h.entity_type=t.entity_type AND h.entity_id=t.entity_id))) ORDER BY t.sequence LIMIT $1 FOR UPDATE`,
        [Math.min(100, Math.max(1, limit))],
      )
    ).rows;
    let deleted = 0;
    for (const row of rows) {
      if (await retentionHeld(db, row.tenant_id, row.place_id, row.entity_type, row.entity_id))
        continue;
      const e = validateReplayEntry(entry(row));
      for (const key of e.objectKeys) await mediaStorage.remove(key);
      await db.query('UPDATE retention_tombstones SET files_deleted_at=now() WHERE id=$1', [
        row.id,
      ]);
      deleted++;
    }
    return deleted;
  });
}
/** Existing upload recovery uses the same tombstone and hold boundary as scheduled private retention. */
export async function recoverPrivateMedia(limit = 20): Promise<{ processed: number }> {
  const count = await transaction(async (db) => {
    const rows = (
      await db.query(
        `SELECT m.* FROM media_assets m WHERE m.retention_deleted_at IS NULL AND ${notHeld('m', 'media_asset')} AND ${SAFE_MEDIA} AND
  ((m.state='processing' AND m.updated_at<now()-interval '1 hour') OR (m.state='reserved' AND m.updated_at<now()-interval '1 day') OR (m.state='failed' AND m.updated_at<now()-interval '1 day') OR (m.state='revoked' AND m.updated_at<now()-interval '30 days')) ORDER BY m.updated_at LIMIT $1 FOR UPDATE OF m SKIP LOCKED`,
        [Math.min(100, Math.max(1, limit))],
      )
    ).rows;
    let n = 0;
    for (const row of rows) {
      if (await retentionHeld(db, row.tenant_id, row.place_id, 'media_asset', row.id)) continue;
      if (await retirePrivateMedia(db, row, 'private_upload_recovery')) n++;
    }
    return n;
  });
  await drainRetentionFiles(limit);
  return { processed: count };
}
export async function processRetention(): Promise<{
  proofs: number;
  drafts: number;
  assets: number;
}> {
  const days = claimProofRetentionDays();
  const result = await transaction(async (db) => {
    const clocks = (
      await db.query(
        `SELECT c.tenant_id,c.place_id FROM merchant_claims c LEFT JOIN retention_location_clocks k ON k.tenant_id=c.tenant_id AND k.place_id=c.place_id GROUP BY c.tenant_id,c.place_id,k.checked_at HAVING k.checked_at IS NULL OR k.checked_at<now()-interval '1 hour' ORDER BY k.checked_at NULLS FIRST LIMIT 100`,
      )
    ).rows;
    for (const c of clocks) {
      const ent = await locationEntitlement(db, {
        tenantID: c.tenant_id,
        placeID: c.place_id,
        capability: 'publish',
      });
      await db.query(
        `INSERT INTO retention_location_clocks(tenant_id,place_id,paused_at) VALUES($1,$2,CASE WHEN $3::boolean THEN NULL ELSE now() END) ON CONFLICT(tenant_id,place_id) DO UPDATE SET paused_at=CASE WHEN $3 THEN NULL ELSE COALESCE(retention_location_clocks.paused_at,now()) END,checked_at=now()`,
        [c.tenant_id, c.place_id, ent.allowed],
      );
    }
    const result = { proofs: 0, drafts: 0, assets: 0 };
    const claims = (
      await db.query(
        `SELECT c.* FROM merchant_claims c WHERE ${notHeld('c', 'claim_proof')} AND evidence_deleted_at IS NULL AND state IN('approved','rejected','revoked') AND reviewed_at<now()-($1::int*interval '1 day') ORDER BY reviewed_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
        [days],
      )
    ).rows;
    for (const c of claims) {
      if (await retentionHeld(db, c.tenant_id, c.place_id, 'claim_proof', c.id)) continue;
      await record(db, c, 'claim_proof', 'claim_review_window_elapsed');
      await db.query(
        'UPDATE merchant_claims SET evidence=\'{"retained":false,"reason":"retention_expired"}\',review_reason=\'Private review material expired under retention policy\',evidence_deleted_at=now() WHERE id=$1',
        [c.id],
      );
      result.proofs++;
    }
    const drafts = (
      await db.query(
        `SELECT d.* FROM merchant_drafts d JOIN retention_location_clocks k USING(tenant_id,place_id) WHERE ${notHeld('d', 'merchant_draft')} AND d.state='draft' AND d.updated_at<now()-interval '90 days' AND k.paused_at<now()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.draft_id=d.id) AND NOT EXISTS(SELECT 1 FROM destination_previews p JOIN target_deliveries t ON t.preview_id=p.id WHERE p.draft_id=d.id) ORDER BY d.updated_at LIMIT 20 FOR UPDATE OF d SKIP LOCKED`,
      )
    ).rows;
    for (const d of drafts) {
      if (await retentionHeld(db, d.tenant_id, d.place_id, 'merchant_draft', d.id)) continue;
      if (
        (
          await locationEntitlement(db, {
            tenantID: d.tenant_id,
            placeID: d.place_id,
            capability: 'publish',
          })
        ).allowed
      )
        continue;
      await record(db, d, 'merchant_draft', 'unused_private_draft_90d');
      await db.query('DELETE FROM destination_previews WHERE draft_id=$1', [d.id]);
      await db.query('DELETE FROM merchant_drafts WHERE id=$1', [d.id]);
      result.drafts++;
    }
    const assets = (
      await db.query(
        `SELECT m.* FROM media_assets m JOIN retention_location_clocks k USING(tenant_id,place_id) WHERE m.retention_deleted_at IS NULL AND ${notHeld('m', 'media_asset')} AND m.state IN('ready','failed','reserved','revoked') AND m.updated_at<now()-interval '90 days' AND k.paused_at<now()-interval '90 days' AND ${SAFE_MEDIA} ORDER BY m.updated_at LIMIT 20 FOR UPDATE OF m SKIP LOCKED`,
      )
    ).rows;
    for (const m of assets) {
      if (await retentionHeld(db, m.tenant_id, m.place_id, 'media_asset', m.id)) continue;
      if (
        (
          await locationEntitlement(db, {
            tenantID: m.tenant_id,
            placeID: m.place_id,
            capability: 'publish',
          })
        ).allowed
      )
        continue;
      if (await retirePrivateMedia(db, m, 'unused_private_asset_90d')) result.assets++;
    }
    return result;
  });
  await drainRetentionFiles();
  return result;
}
export async function replayRetention(
  entries: unknown[],
  holds: unknown[] = [],
  options: { drain?: boolean } = {},
): Promise<{ replayed: number }> {
  const validated = entries.map(validateReplayEntry);
  const result = await transaction(async (db) => {
    for (const raw of holds) {
      const h = holdSchema.parse(raw),
        old = (await db.query('SELECT * FROM retention_holds WHERE id=$1 FOR UPDATE', [h.id]))
          .rows[0];
      if (
        old &&
        (old.tenant_id !== h.tenantID ||
          old.place_id !== h.placeID ||
          old.entity_type !== h.entityType ||
          old.entity_id !== h.entityID ||
          new Date(old.created_at).toISOString() !== h.createdAt ||
          old.reason !== h.reason)
      )
        throw new HttpError(
          409,
          'hold_replay_conflict',
          'Imported hold changes immutable identity or scope',
        );
      await db.query(
        `INSERT INTO retention_holds(id,tenant_id,place_id,entity_type,entity_id,reason,created_at,created_by,released_at,released_by,release_reason) VALUES($1,$2,$3,$4,$5,$6,$7,'restore-replay',$8,CASE WHEN $8::timestamptz IS NOT NULL THEN 'restore-replay' ELSE NULL END,$9) ON CONFLICT(id) DO UPDATE SET released_at=EXCLUDED.released_at,released_by=EXCLUDED.released_by,release_reason=EXCLUDED.release_reason WHERE retention_holds.tenant_id=EXCLUDED.tenant_id AND retention_holds.released_at IS NULL AND EXCLUDED.released_at IS NOT NULL`,
        [
          h.id,
          h.tenantID,
          h.placeID,
          h.entityType,
          h.entityID,
          h.reason,
          h.createdAt,
          h.releasedAt,
          h.releaseReason,
        ],
      );
    }
    let replayed = 0;
    for (const e of validated) {
      const oldJournal = (
        await db.query('SELECT * FROM retention_tombstones WHERE entity_type=$1 AND entity_id=$2', [
          e.entityType,
          e.entityID,
        ])
      ).rows[0];
      if (oldJournal && canonical(entry(oldJournal)) !== canonical(e))
        throw new HttpError(
          409,
          'journal_replay_conflict',
          'Imported deletion identity differs from the existing journal',
        );
      if (await retentionHeld(db, e.tenantID, e.placeID, e.entityType, e.entityID))
        throw new HttpError(
          409,
          'retention_hold',
          'Restore replay stopped at a legal hold; resolve the conflict before exposing this restore',
        );
      const table = {
        claim_proof: 'merchant_claims',
        merchant_draft: 'merchant_drafts',
        media_asset: 'media_assets',
      }[e.entityType];
      const row = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [e.entityID]))
        .rows[0];
      if (row && (row.tenant_id !== e.tenantID || row.place_id !== e.placeID))
        throw new HttpError(
          409,
          'replay_scope_conflict',
          'Journal object scope does not match this restore',
        );
      if (
        row &&
        new Date(
          row.updated_at ?? row.reviewed_at ?? row.created_at ?? row.submitted_at,
        ).getTime() > Date.parse(e.deletedAt)
      )
        throw new HttpError(
          409,
          'replay_newer_object',
          'Object changed after this deletion journal entry; quarantine and review',
        );
      if (e.entityType === 'claim_proof' && row) {
        await db.query(
          'UPDATE merchant_claims SET evidence=\'{"retained":false,"reason":"restore_replay"}\',review_reason=\'Private review material removed by retention replay\',evidence_deleted_at=$2 WHERE id=$1',
          [e.entityID, e.deletedAt],
        );
      }
      if (e.entityType === 'merchant_draft' && row) {
        const used = (
          await db.query(
            'SELECT 1 FROM publications WHERE draft_id=$1 UNION ALL SELECT 1 FROM destination_previews p JOIN target_deliveries t ON t.preview_id=p.id WHERE p.draft_id=$1',
            [e.entityID],
          )
        ).rowCount;
        if (used)
          throw new HttpError(
            409,
            'replay_used_draft',
            'Restored draft now has publication history; quarantine and review',
          );
        await db.query('DELETE FROM destination_previews WHERE draft_id=$1', [e.entityID]);
        await db.query('DELETE FROM merchant_drafts WHERE id=$1', [e.entityID]);
      }
      if (e.entityType === 'media_asset' && row) {
        const safe = (
          await db.query(`SELECT 1 FROM media_assets m WHERE m.id=$1 AND ${SAFE_MEDIA}`, [
            e.entityID,
          ])
        ).rowCount;
        if (!safe)
          throw new HttpError(
            409,
            'replay_public_asset',
            'Journal asset has public/shared references; quarantine and review',
          );
        await db.query(
          "UPDATE media_assets SET state='revoked',original_key=NULL,derivative_key=NULL,stored_bytes=0,retention_deleted_at=$2,revision=revision+1 WHERE id=$1",
          [e.entityID, e.deletedAt],
        );
      }
      await db.query(
        `INSERT INTO retention_tombstones(id,tenant_id,place_id,entity_type,entity_id,deleted_at,reason,object_keys) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(entity_type,entity_id) DO UPDATE SET files_deleted_at=NULL`,
        [
          e.id,
          e.tenantID,
          e.placeID,
          e.entityType,
          e.entityID,
          e.deletedAt,
          e.reason,
          JSON.stringify(e.objectKeys),
        ],
      );
      await audit(db, 'ops', null, 'retention.restore_replayed', e.entityID, {
        journalID: e.id,
        entityType: e.entityType,
      });
      replayed++;
    }
    return { replayed };
  });
  if (options.drain !== false) await drainRetentionFiles(100);
  return result;
}
export function registerRetention(app: Hono) {
  app.get('/v1/ops/retention/holds', async (c) => {
    requireOps(c);
    const after = z.uuid().optional().parse(c.req.query('after'));
    const rows = (
      await workerPool.query(
        'SELECT * FROM retention_holds WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1000',
        [after ?? null],
      )
    ).rows;
    return c.json({ holds: rows.map(holdEntry), nextCursor: rows.at(-1)?.id ?? null });
  });
  app.get('/v1/ops/retention/status', async (c) => {
    requireOps(c);
    return c.json(
      (
        await workerPool.query(
          'SELECT (SELECT count(*)::int FROM retention_tombstones WHERE files_deleted_at IS NULL) AS pending_files,(SELECT min(deleted_at) FROM retention_tombstones WHERE files_deleted_at IS NULL) AS oldest_pending,(SELECT count(*)::int FROM retention_holds WHERE released_at IS NULL) AS active_holds',
        )
      ).rows[0],
    );
  });
  app.post('/v1/ops/retention/drain', async (c) => {
    requireOps(c);
    return c.json({ processed: await drainRetentionFiles(100) });
  });
  app.post('/v1/ops/retention/holds', async (c) => {
    requireOps(c);
    const body = z
      .object({
        tenantID: z.uuid(),
        placeID: z.string().max(160).optional(),
        entityType: typeSchema.optional(),
        entityID: z.uuid().optional(),
        reason: z.string().trim().min(10).max(2000),
      })
      .strict()
      .refine((b) => !!b.entityType === !!b.entityID)
      .parse(await c.req.json());
    const hold = await transaction(async (db) => {
      if (
        body.placeID &&
        !(
          await db.query('SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2', [
            body.tenantID,
            body.placeID,
          ])
        ).rowCount
      )
        throw new HttpError(422, 'hold_scope', 'Location is not associated with this workspace');
      if (body.entityID) {
        const table = {
          claim_proof: 'merchant_claims',
          merchant_draft: 'merchant_drafts',
          media_asset: 'media_assets',
        }[body.entityType!];
        if (
          !(
            await db.query(
              `SELECT 1 FROM ${table} WHERE id=$1 AND tenant_id=$2 AND ($3::text IS NULL OR place_id=$3)`,
              [body.entityID, body.tenantID, body.placeID ?? null],
            )
          ).rowCount
        )
          throw new HttpError(422, 'hold_scope', 'Object is not associated with this hold scope');
      }
      const r = (
        await db.query(
          "INSERT INTO retention_holds(tenant_id,place_id,entity_type,entity_id,reason,created_by) VALUES($1,$2,$3,$4,$5,'ops') RETURNING *",
          [
            body.tenantID,
            body.placeID ?? null,
            body.entityType ?? null,
            body.entityID ?? null,
            body.reason,
          ],
        )
      ).rows[0];
      await audit(db, 'ops', body.tenantID, 'retention.hold_created', r.id, {
        placeID: body.placeID,
        entityType: body.entityType,
        entityID: body.entityID,
      });
      return r;
    });
    return c.json({ hold }, 201);
  });
  app.post('/v1/ops/retention/holds/:id/release', async (c) => {
    requireOps(c);
    const id = z.uuid().parse(c.req.param('id')),
      body = z
        .object({ reason: z.string().trim().min(10).max(2000) })
        .strict()
        .parse(await c.req.json());
    await transaction(async (db) => {
      const row = (
        await db.query(
          "UPDATE retention_holds SET released_at=now(),released_by='ops',release_reason=$2 WHERE id=$1 AND released_at IS NULL RETURNING tenant_id",
          [id, body.reason],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, 'hold_not_found', 'Active hold not found');
      await audit(db, 'ops', row.tenant_id, 'retention.hold_released', id);
    });
    return c.json({ released: true });
  });
  app.get('/v1/ops/retention/journal', async (c) => {
    requireOps(c);
    const after = z.coerce
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .parse(c.req.query('after') ?? 0),
      limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(c.req.query('limit') ?? 1000);
    const rows = (
      await workerPool.query(
        'SELECT * FROM retention_tombstones WHERE sequence>$1 ORDER BY sequence LIMIT $2',
        [after, limit],
      )
    ).rows;
    return c.json({
      entries: rows.map(entry),
      nextCursor: rows.length ? Number(rows.at(-1).sequence) : after,
    });
  });
  app.post('/v1/ops/retention/replay', async (c) => {
    requireOps(c);
    const body = z
      .object({
        approval: z.literal(true),
        entries: z.array(z.unknown()).max(100),
        holds: z.array(z.unknown()).max(1000).default([]),
      })
      .strict()
      .refine((b) => b.entries.length + b.holds.length > 0)
      .parse(await c.req.json());
    return c.json(await replayRetention(body.entries, body.holds));
  });
}
