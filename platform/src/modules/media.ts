import type { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireUser, requireOps } from '../auth.js';
import { withActor, query, workerPool, HttpError, idempotent, audit, consumeQuota } from '../db.js';
import { config } from '../config.js';
import { requirePlacePermission } from './business-auth.js';
import { mediaStorage } from '../storage/filesystem.js';
import { processImage } from '../storage/images.js';
export const MEDIA_LIMIT_BYTES = 250 * 1024 * 1024,
  MEDIA_FILE_BYTES = 5 * 1024 * 1024,
  MEDIA_COUNT = 100;
const rightsSchema = z
  .object({
    basis: z.enum(['owned', 'licensed']),
    holder: z.string().trim().min(1).max(200),
    publicUse: z.boolean(),
    permissionNote: z.string().trim().min(5).max(2000),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export interface PublicAsset {
  id: string;
  url: string;
  sha256: string;
  mime: string;
  alt: string;
  width: number;
  height: number;
}
function assetURL(id: string, hash: string) {
  return `${config.publicURL}/v1/media/public/${id}/${hash}.webp`;
}
function dto(row: any): PublicAsset {
  return {
    id: row.id,
    url: assetURL(row.id, row.sha256),
    sha256: row.sha256,
    mime: row.mime,
    alt: row.alt,
    width: row.width,
    height: row.height,
  };
}
export async function mediaAuthority(
  db: PoolClient,
  tenantID: string,
  placeID: string,
  permission: 'view' | 'edit' | 'publish' = 'edit',
) {
  await requirePlacePermission(db, tenantID, placeID, permission);
  const claim = await db.query(
    "SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
    [tenantID, placeID],
  );
  if (!claim.rowCount)
    throw new HttpError(409, 'ownership_required', 'An approved business claim is required.');
}
/** Only consented, reviewed derivatives; never private originals. Reuse at preview and delivery. */
export async function resolvePublicAssets(
  db: PoolClient,
  tenantID: string,
  placeID: string,
  assetIDs: string[],
): Promise<PublicAsset[]> {
  const ids = [...new Set(assetIDs)];
  if (ids.length > MEDIA_COUNT)
    throw new HttpError(
      422,
      'media_quota',
      'At most 100 published derivatives are supported per location.',
    );
  if (!ids.length) return [];
  const rows = (
    await db.query(
      `SELECT m.* FROM media_assets m JOIN public_media p ON p.id=m.id WHERE m.tenant_id=$1 AND m.place_id=$2 AND m.id=ANY($3::uuid[]) AND m.state='ready' AND p.revoked_at IS NULL AND (p.valid_until IS NULL OR p.valid_until>now()) AND m.rights->>'publicUse'='true' AND (m.rights->>'expiresAt' IS NULL OR (m.rights->>'expiresAt')::timestamptz>now()) ORDER BY m.id`,
      [tenantID, placeID, ids],
    )
  ).rows;
  if (rows.length !== ids.length)
    throw new HttpError(
      422,
      'media_not_publishable',
      'Some images are private, unreviewed, unavailable, expired or belong to another location.',
    );
  return rows.map(dto);
}
export function registerMedia(app: Hono) {
  app.post('/v1/media/uploads', async (c) => {
    const user = await requireUser(c);
    const b = z
      .object({
        tenantID: z.uuid(),
        placeID: z.string().min(1).max(160),
        purpose: z.enum(['business_photo', 'checkpoint', 'floor_plan']),
        alt: z.string().trim().min(1).max(300),
        rights: rightsSchema,
      })
      .strict()
      .parse(await c.req.json());
    await consumeQuota(`media:${user.id}`, 100, 3600);
    const result = await withActor(user.id, async (db) => {
      await mediaAuthority(db, b.tenantID, b.placeID);
      return idempotent(
        db,
        user.id,
        c.req.header('Idempotency-Key') || '',
        `media-reserve:${b.tenantID}:${b.placeID}`,
        b,
        async () => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `media:${b.tenantID}:${b.placeID}`,
          ]);
          const q = (
            await db.query(
              "SELECT count(*) FILTER(WHERE state IN('reserved','processing','ready'))::int AS count,COALESCE(sum(stored_bytes),0)::bigint AS bytes FROM media_assets WHERE tenant_id=$1 AND place_id=$2",
              [b.tenantID, b.placeID],
            )
          ).rows[0];
          if (q.count >= MEDIA_COUNT || Number(q.bytes) + MEDIA_FILE_BYTES > MEDIA_LIMIT_BYTES)
            throw new HttpError(
              409,
              'media_quota',
              'This location has reached its 100-image or 250 MiB allowance.',
            );
          const r = (
            await db.query(
              'INSERT INTO media_assets(tenant_id,place_id,purpose,alt,rights,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
              [b.tenantID, b.placeID, b.purpose, b.alt, b.rights, user.id],
            )
          ).rows[0];
          await audit(db, user.id, b.tenantID, 'media.reserved', r.id, { placeID: b.placeID });
          return {
            id: r.id,
            state: 'reserved',
            uploadPath: `/v1/media/uploads/${r.id}/content`,
            maxBytes: MEDIA_FILE_BYTES,
          };
        },
      );
    });
    return c.json(result, 201);
  });
  app.put('/v1/media/uploads/:id/content', async (c) => {
    const user = await requireUser(c),
      id = z.uuid().parse(c.req.param('id'));
    if (!c.req.raw.body) throw new HttpError(400, 'empty_upload', 'Supply raw image bytes.');
    if (Number(c.req.header('Content-Length') || 0) > MEDIA_FILE_BYTES)
      throw new HttpError(413, 'media_too_large', 'Images must be at most 5 MiB.');
    const row = await withActor(user.id, async (db) => {
      const r = (await db.query('SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'media_not_found', 'Image not found.');
      await mediaAuthority(db, r.tenant_id, r.place_id);
      if (r.state !== 'reserved')
        throw new HttpError(
          409,
          'upload_state',
          'This upload is already processing or complete. Inspect its state before retrying.',
        );
      await db.query("UPDATE media_assets SET state='processing',updated_at=now() WHERE id=$1", [
        id,
      ]);
      return r;
    });
    const original = `private/${id}/original`,
      derivative = `derivatives/${id}/image.webp`;
    try {
      const bytes = await mediaStorage.write(original, c.req.raw.body, MEDIA_FILE_BYTES);
      const image = await processImage(id, original);
      await withActor(user.id, async (db) => {
        await mediaAuthority(db, row.tenant_id, row.place_id);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `media:${row.tenant_id}:${row.place_id}`,
        ]);
        const q = (
          await db.query(
            'SELECT COALESCE(sum(stored_bytes),0)::bigint AS bytes FROM media_assets WHERE tenant_id=$1 AND place_id=$2 ',
            [row.tenant_id, row.place_id],
          )
        ).rows[0];
        if (Number(q.bytes) + bytes + image.bytes > MEDIA_LIMIT_BYTES)
          throw new HttpError(409, 'media_quota', 'Storage allowance reached.');
        const updated = await db.query(
          "UPDATE media_assets SET state='ready',original_key=$2,derivative_key=$3,sha256=$4,mime=$5,width=$6,height=$7,stored_bytes=$8,revision=revision+1,updated_at=now() WHERE id=$1 AND state='processing' RETURNING id",
          [
            id,
            original,
            image.key,
            image.sha256,
            image.mime,
            image.width,
            image.height,
            bytes + image.bytes,
          ],
        );
        if (!updated.rowCount) throw new HttpError(409, 'upload_state', 'Upload was cancelled.');
      });
      return c.json({ id, state: 'ready', previewPath: `/v1/media/${id}/preview`, public: false });
    } catch (error) {
      // HTTP processes cannot inspect the private legal-hold ledger. Preserve all bytes, including
      // failed partial streams, for the retention worker's hold checks and durable deletion journal.
      // If authority was removed mid-upload and RLS prevents this update, stale-processing recovery
      // still knows these deterministic keys and must make the same hold-aware decision.
      const retainedBytes = (
        await Promise.all([
          mediaStorage.size(original).catch(() => 0),
          mediaStorage.size(derivative).catch(() => 0),
        ])
      ).reduce((a, b) => a + b, 0);
      await withActor(user.id, async (db) => {
        await db.query('SELECT id FROM media_assets WHERE id=$1 FOR UPDATE', [id]);
        await db.query(
          "UPDATE media_assets SET state='failed',original_key=$2,derivative_key=$3,stored_bytes=$4,updated_at=now() WHERE id=$1 AND state='processing' AND retention_deleted_at IS NULL",
          [id, original, derivative, retainedBytes],
        );
      }).catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        'image_processing_failed',
        'The image could not be decoded safely. Use a valid JPEG, PNG or WebP.',
      );
    }
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/media', async (c) => {
    const u = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = c.req.param('placeID');
    const rows = await withActor(u.id, async (db) => {
      await mediaAuthority(db, tenant, place, 'view');
      const result = await db.query(
        `SELECT m.id,m.purpose,m.alt,m.state,m.rights,m.revision,m.width,m.height,m.stored_bytes AS "storedBytes",
   CASE WHEN m.state='ready' AND m.rights->>'publicUse'='true'
    AND (m.rights->>'expiresAt' IS NULL OR (m.rights->>'expiresAt')::timestamptz>now())
    AND p.id IS NOT NULL AND p.revoked_at IS NULL AND (p.valid_until IS NULL OR p.valid_until>now())
   THEN jsonb_build_object('id',p.id,'sha256',p.sha256,'mime',p.mime,'alt',p.alt,'width',p.width,'height',p.height) ELSE NULL END AS "publicAsset"
   FROM media_assets m LEFT JOIN public_media p ON p.id=m.id AND p.tenant_id=m.tenant_id AND p.place_id=m.place_id
   WHERE m.tenant_id=$1 AND m.place_id=$2 ORDER BY m.created_at DESC LIMIT 100`,
        [tenant, place],
      );
      return result.rows.map((row) => ({
        ...row,
        publicApproved: row.publicAsset !== null,
        publicAsset: row.publicAsset ? dto(row.publicAsset) : null,
      }));
    });
    return c.json({ assets: rows, limit: 100, storageLimitBytes: MEDIA_LIMIT_BYTES });
  });
  app.get('/v1/ops/media/:id/preview', async (c) => {
    requireOps(c);
    const id = z.uuid().parse(c.req.param('id'));
    const r = (
      await workerPool.query(
        "SELECT derivative_key FROM media_assets WHERE id=$1 AND state='ready'",
        [id],
      )
    ).rows[0];
    if (!r) throw new HttpError(404, 'media_not_found', 'Image not found.');
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Type', 'image/webp');
    return c.body(new Uint8Array(await mediaStorage.read(r.derivative_key)));
  });
  app.post('/v1/ops/media/:id/revoke', async (c) => {
    requireOps(c);
    const id = z.uuid().parse(c.req.param('id')),
      b = z
        .object({ reason: z.string().trim().min(10).max(1000) })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const row = (
        await db.query(
          "UPDATE media_assets SET state='revoked',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING tenant_id",
          [id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, 'media_not_found', 'Image not found.');
      await db.query('UPDATE public_media SET revoked_at=now(),revision=revision+1 WHERE id=$1', [
        id,
      ]);
      await audit(db, 'ops', row.tenant_id, 'media.operator_revoked', id, b);
      await db.query('COMMIT');
      return c.json({ revoked: true });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.get('/v1/media/:id/preview', async (c) => {
    const u = await requireUser(c),
      id = z.uuid().parse(c.req.param('id'));
    const row = await withActor(u.id, async (db) => {
      const r = (await db.query("SELECT * FROM media_assets WHERE id=$1 AND state='ready'", [id]))
        .rows[0];
      if (r) await mediaAuthority(db, r.tenant_id, r.place_id, 'view');
      return r;
    });
    if (!row) throw new HttpError(404, 'media_not_found', 'Image not found.');
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Type', 'image/webp');
    return c.body(new Uint8Array(await mediaStorage.read(row.derivative_key)));
  });
  app.post('/v1/media/:id/approve-public', async (c) => {
    const u = await requireUser(c),
      id = z.uuid().parse(c.req.param('id'));
    const b = z
      .object({ reviewed: z.literal(true), permissionConfirmed: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    const asset = await withActor(u.id, async (db) => {
      const r = (await db.query('SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'media_not_found', 'Image not found.');
      await mediaAuthority(db, r.tenant_id, r.place_id, 'publish');
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `media-approve:${id}`,
        b,
        async () => {
          if (
            r.state !== 'ready' ||
            !r.rights.publicUse ||
            (r.rights.expiresAt && Date.parse(r.rights.expiresAt) <= Date.now())
          )
            throw new HttpError(
              422,
              'rights_required',
              'Current permission for public use and a processed image are required.',
            );
          await db.query(
            'INSERT INTO public_media(id,tenant_id,place_id,derivative_key,sha256,mime,alt,width,height,revision,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET revoked_at=NULL,revision=EXCLUDED.revision,valid_until=EXCLUDED.valid_until',
            [
              id,
              r.tenant_id,
              r.place_id,
              r.derivative_key,
              r.sha256,
              r.mime,
              r.alt,
              r.width,
              r.height,
              r.revision,
              r.rights.expiresAt,
            ],
          );
          await audit(db, u.id, r.tenant_id, 'media.public_approved', id, { placeID: r.place_id });
          return dto(r);
        },
      );
    });
    return c.json({ asset });
  });
  app.delete('/v1/media/:id', async (c) => {
    const u = await requireUser(c),
      id = z.uuid().parse(c.req.param('id'));
    await withActor(u.id, async (db) => {
      const r = (await db.query('SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'media_not_found', 'Image not found.');
      await mediaAuthority(db, r.tenant_id, r.place_id);
      await db.query(
        "UPDATE media_assets SET state='revoked',revision=revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await db.query('UPDATE public_media SET revoked_at=now(),revision=revision+1 WHERE id=$1', [
        id,
      ]);
      await audit(db, u.id, r.tenant_id, 'media.revoked', id);
    });
    return c.json({ revoked: true, retainedForRecovery: true });
  });
  app.get('/v1/media/public/:id/:file', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const row = (
      await query(
        'SELECT * FROM public_media WHERE id=$1 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now())',
        [id],
      )
    ).rows[0];
    if (!row || c.req.param('file') !== `${row.sha256}.webp`)
      throw new HttpError(404, 'media_not_found', 'Image unavailable.');
    c.header('Cache-Control', 'public, max-age=60, must-revalidate');
    c.header('ETag', `"${row.sha256}"`);
    c.header('Content-Type', 'image/webp');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(await mediaStorage.read(row.derivative_key)));
  });
}
