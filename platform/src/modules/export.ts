import type { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { audit, consumeQuota, HttpError, pool, requireRole, withActor } from '../db.js';
import { mediaStorage } from '../storage/filesystem.js';
import { graphAssetIDs } from '../maps/graph.js';
import { requirePlacePermission } from './business-auth.js';
import { requireLocationCapability } from './entitlements.js';
import { resolvePublicAssets } from './media.js';

export const EXPORT_LIMITS = Object.freeze({
  archiveBytes: 270 * 1024 * 1024,
  textBytes: 16 * 1024 * 1024,
  mediaFileBytes: 5 * 1024 * 1024,
  historyRows: 1000,
  mediaFiles: 100,
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const boundsError = () =>
  new HttpError(
    413,
    'export_too_large',
    'This archive exceeds the self-service export limit. Request a complete assisted export; no files have been silently omitted.',
  );
export interface ArchiveEntry {
  path: string;
  size: number;
  sha256: string;
  load: () => Promise<Uint8Array>;
}

/** Deliberately supports only ordinary ASCII-named files, never links, devices or user paths. */
export function tarHeader(path: string, size: number, modifiedAt: Date): Buffer {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,99}$/.test(path) ||
    path.split('/').some((x) => !x || x === '.' || x === '..')
  )
    throw new Error('Unsafe archive path');
  if (!Number.isSafeInteger(size) || size < 0 || size > EXPORT_LIMITS.archiveBytes)
    throw boundsError();
  const header = Buffer.alloc(512);
  const octal = (value: number, start: number, length: number) =>
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
  header.write(path, 0, 100, 'ascii');
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.max(0, Math.floor(modifiedAt.getTime() / 1000)), 136, 12);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}
export function archiveByteLength(entries: ArchiveEntry[]): number {
  const paths = new Set<string>();
  let total = 1024;
  for (const entry of entries) {
    tarHeader(entry.path, entry.size, new Date(0));
    if (paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error('Invalid archive manifest');
    paths.add(entry.path);
    total += 512 + Math.ceil(entry.size / 512) * 512;
  }
  if (total > EXPORT_LIMITS.archiveBytes) throw boundsError();
  return total;
}
/** One derivative at a time; cancellation stops future loads and never emits a valid trailer. */
export function archiveStream(
  entries: ArchiveEntry[],
  modifiedAt: Date,
): ReadableStream<Uint8Array> {
  archiveByteLength(entries);
  let cancelled = false;
  async function* chunks() {
    for (const entry of entries) {
      if (cancelled) return;
      const bytes = await entry.load();
      if (cancelled) return;
      if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256)
        throw new Error('Export content changed. Download a fresh archive.');
      yield tarHeader(entry.path, bytes.byteLength, modifiedAt);
      for (let offset = 0; offset < bytes.byteLength && !cancelled; offset += 65536)
        yield bytes.subarray(offset, offset + 65536);
      if (cancelled) return;
      if (bytes.byteLength % 512) yield new Uint8Array(512 - (bytes.byteLength % 512));
    }
    if (!cancelled) yield new Uint8Array(1024);
  }
  const iterator = chunks();
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (cancelled) return;
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          if (!cancelled) controller.error(error);
        }
      },
      async cancel() {
        cancelled = true;
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

async function authority(db: PoolClient, actor: string, tenant: string, place: string) {
  await requirePlacePermission(db, tenant, place, 'view');
  await requireRole(db, tenant, ['owner', 'manager']);
  await requireLocationCapability(db, tenant, place, 'export');
  if (
    !(
      await db.query('SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2', [
        tenant,
        place,
      ])
    ).rowCount
  )
    throw new HttpError(404, 'place_not_found', 'Workspace location not found');
}

/** Row sizes are checked in SQL before loading publication history into the HTTP process. */
async function boundedRows(
  db: PoolClient,
  sql: string,
  parameters: unknown[],
  budget: { remaining: number },
): Promise<any[]> {
  const stats = (
    await db.query(
      `SELECT count(*)::int AS count,coalesce(sum(octet_length(row_to_json(export_row)::text)),0)::bigint AS bytes FROM (${sql}) export_row`,
      parameters,
    )
  ).rows[0];
  const bytes = Number(stats.bytes);
  if (stats.count > EXPORT_LIMITS.historyRows || bytes > budget.remaining) throw boundsError();
  budget.remaining -= bytes;
  return (await db.query(sql, parameters)).rows;
}

/** Open only a bounded derivative, not an original; refuse symlink substitution. */
async function readDerivative(key: string, expectedBytes: number): Promise<Buffer> {
  const file = await open(mediaStorage.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedBytes || stat.size > EXPORT_LIMITS.mediaFileBytes)
      throw new Error('Export image is unavailable or changed');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const result = await file.read(data, offset, data.length - offset, offset);
      if (!result.bytesRead) throw new Error('Export image is incomplete');
      offset += result.bytesRead;
    }
    return data;
  } finally {
    await file.close();
  }
}

export async function prepareLocationArchive(
  actor: string,
  tenant: string,
  place: string,
  exportedAt = new Date(),
): Promise<ArchiveEntry[]> {
  const client = await pool.connect();
  const snapshot = async (db: PoolClient) => {
    await authority(db, actor, tenant, place);
    const budget = { remaining: EXPORT_LIMITS.textBytes / 2 };
    const facts = (
      await boundedRows(
        db,
        `SELECT id,name,slug,city,category,neighborhood,address,summary,tags,locality,business_type AS "businessType",revision,state FROM places WHERE id=$1`,
        [place],
        budget,
      )
    )[0];
    const draft =
      (
        await boundedRows(
          db,
          `SELECT id,version,profile,state,rights_confirmed AS "rightsConfirmed",updated_at AS "updatedAt" FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1`,
          [tenant, place],
          budget,
        )
      )[0] ?? null;
    const publications = await boundedRows(
      db,
      `SELECT id,revision,snapshot,html,digest,status,created_at AS "createdAt",published_at AS "publishedAt" FROM publications WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at,id`,
      [tenant, place],
      budget,
    );
    const deliveries = await boundedRows(
      db,
      `SELECT d.id,d.destination_id AS "destinationID",d.publication_id AS "publicationID",d.sequence,d.state,d.applied_at AS "appliedAt",d.verified_at AS "verifiedAt",p.snapshot,p.metadata,p.html,p.artifact_digest AS "artifactDigest",p.digest AS "approvalDigest" FROM target_deliveries d JOIN destination_previews p ON p.id=d.preview_id WHERE d.tenant_id=$1 AND d.place_id=$2 AND d.applied_at IS NOT NULL ORDER BY d.created_at,d.id`,
      [tenant, place],
      budget,
    );
    const destinations = await boundedRows(
      db,
      `SELECT id,kind,state,public_url AS "publicURL",canonical_url AS "canonicalURL",created_at AS "createdAt" FROM publication_destinations WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at,id`,
      [tenant, place],
      budget,
    );
    // An editing/shared-building grant is not ownership of the building graph.
    const arrivals = await boundedRows(
      db,
      `SELECT r.id,r.graph_id AS "graphID",r.revision,r.graph,r.digest AS "originalPublicationDigest",r.verification AS "publicVerification",r.published_at AS "publishedAt",r.withdrawn_at AS "withdrawnAt" FROM arrival_releases r JOIN arrival_sites s ON s.id=r.site_id JOIN arrival_drafts d ON d.graph_id=r.graph_id WHERE s.tenant_id=$1 AND d.tenant_id=$1 AND d.place_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.graph->'placeDestinationBindings') binding WHERE binding->>'placeID'=$2) ORDER BY r.published_at,r.id`,
      [tenant, place],
      budget,
    );
    const media = (
      await db.query(
        `SELECT p.id,p.derivative_key,p.sha256,p.mime,p.alt,p.width,p.height,p.valid_until AS "validUntil",m.rights->>'basis' AS "rightsBasis",m.rights->>'holder' AS "rightsHolder" FROM public_media p JOIN media_assets m ON m.id=p.id AND m.tenant_id=p.tenant_id AND m.place_id=p.place_id WHERE p.tenant_id=$1 AND p.place_id=$2 AND m.state='ready' AND p.revoked_at IS NULL AND (p.valid_until IS NULL OR p.valid_until>now()) AND m.rights->>'publicUse'='true' AND (m.rights->>'expiresAt' IS NULL OR (m.rights->>'expiresAt')::timestamptz>now()) ORDER BY p.id LIMIT 101`,
        [tenant, place],
      )
    ).rows;
    if (media.length > EXPORT_LIMITS.mediaFiles) throw boundsError();
    await resolvePublicAssets(
      db,
      tenant,
      place,
      media.map((x) => x.id),
    );
    return { facts, draft, publications, deliveries, destinations, arrivals, media };
  };
  let data: Awaited<ReturnType<typeof snapshot>>;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('app.actor_id',$1,true)", [actor]);
    data = await snapshot(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const entries: ArchiveEntry[] = [];
  let textBytes = 0;
  const text = (path: string, content: string) => {
    const bytes = Buffer.from(content, 'utf8');
    textBytes += bytes.length;
    if (textBytes > EXPORT_LIMITS.textBytes) throw boundsError();
    entries.push({ path, size: bytes.length, sha256: hash(bytes), load: async () => bytes });
  };
  const json = (path: string, value: unknown) => text(path, JSON.stringify(value, null, 2) + '\n');
  text(
    'README.txt',
    'Kulture location export, schema version 1\n\nExtract with a standard tar utility. manifest.json records every payload file, byte count and SHA-256.\nFacts and the latest editable draft are in facts.json. Publication and website HTML are exact historical bytes, not rewritten for offline hosting; external links may need migration. Status and timestamps distinguish approval, application and synthetic access verification.\nMedia contains only currently approved, nonrevoked, rights-valid derivatives owned by this location. No private originals, ownership evidence, private review evidence, credentials or shared-building content owned by another tenant are included. A public-use licence is not expanded by export; see media/index.json.\nArrival releases are historical published graphs owned by this workspace and location, not a live navigation guarantee. They may be withdrawn or expired; do not navigate from this archive. Missing/revoked image IDs remain references in historical graphs but have no included binary.\nExport remains available without a paid plan. No oversized history is silently truncated: the service instead requests assisted export.\n',
  );
  json('facts.json', {
    schemaVersion: 1,
    exportedAt: exportedAt.toISOString(),
    place: data.facts,
    latestDraft: data.draft,
  });
  json('destinations.json', data.destinations);
  for (const row of data.publications) {
    const { html, ...metadata } = row;
    json(`publications/${row.id}.json`, metadata);
    if (typeof html === 'string') text(`publications/${row.id}.html`, html);
  }
  for (const row of data.deliveries) {
    const { html, ...metadata } = row;
    json(`websites/${row.id}.json`, metadata);
    text(`websites/${row.id}.html`, html);
  }
  const includedMedia = new Set(data.media.map((m) => m.id));
  for (const row of data.arrivals) {
    const referenced = graphAssetIDs(row.graph);
    json(`arrival/${row.id}.json`, {
      ...row,
      liveNavigation: false,
      includedMediaIDs: referenced.filter((id) => includedMedia.has(id)),
      unavailableMediaIDs: referenced.filter((id) => !includedMedia.has(id)),
      note: 'Historical graph; the original publication digest also covered its original asset manifest, which is not reproduced when rights have changed.',
    });
  }
  const mediaIndex = [];
  for (const asset of data.media) {
    if (!asset.derivative_key.startsWith(`derivatives/${asset.id}/`) || asset.mime !== 'image/webp')
      throw new HttpError(
        409,
        'export_media_unavailable',
        'A public derivative is inconsistent. Request media repair before exporting.',
      );
    let size: number;
    try {
      size = await mediaStorage.size(asset.derivative_key);
    } catch {
      throw new HttpError(
        409,
        'export_media_unavailable',
        'A public derivative is missing. Request media repair before exporting.',
      );
    }
    if (size > EXPORT_LIMITS.mediaFileBytes) throw boundsError();
    const path = `media/${asset.id}.webp`;
    const { derivative_key: key, ...metadata } = asset;
    mediaIndex.push({ ...metadata, path, bytes: size });
    entries.push({
      path,
      size,
      sha256: asset.sha256,
      load: async () => {
        await withActor(actor, async (db) => {
          await authority(db, actor, tenant, place);
          const current = await resolvePublicAssets(db, tenant, place, [asset.id]);
          if (current[0].sha256 !== asset.sha256)
            throw new Error('Media rights or content changed during export');
        });
        return readDerivative(key, size);
      },
    });
  }
  json('media/index.json', mediaIndex);
  json('manifest.json', {
    schemaVersion: 1,
    tenantID: tenant,
    placeID: place,
    exportedAt: exportedAt.toISOString(),
    files: entries.map(({ path, size, sha256 }) => ({ path, bytes: size, sha256 })),
    counts: {
      publications: data.publications.length,
      appliedWebsites: data.deliveries.length,
      ownedArrivalReleases: data.arrivals.length,
      publicDerivatives: data.media.length,
    },
    exclusions: [
      'Private originals and proof documents',
      'Credentials, pairing secrets and signed machine envelopes',
      'Private review evidence and draft arrival maps',
      'Unapproved, revoked or expired media',
      'Shared-building graphs and assets owned by another tenant or location',
    ],
    limits: EXPORT_LIMITS,
  });
  archiveByteLength(entries);
  await withActor(actor, async (db) => {
    await authority(db, actor, tenant, place);
    await audit(db, actor, tenant, 'location.archive_prepared', place, {
      files: entries.length,
      bytes: archiveByteLength(entries),
      exportedAt: exportedAt.toISOString(),
    });
  });
  return entries;
}

export function registerExports(app: Hono) {
  app.get('/v1/tenants/:tenantID/places/:placeID/export/archive', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z
        .string()
        .regex(/^[A-Za-z0-9-]{1,160}$/)
        .parse(c.req.param('placeID'));
    await consumeQuota(`archive-export:${user.id}`, 4, 3600);
    const exportedAt = new Date(),
      entries = await prepareLocationArchive(user.id, tenant, place, exportedAt);
    c.header('Content-Type', 'application/x-tar');
    c.header(
      'Content-Disposition',
      `attachment; filename="kulture-${place}-${exportedAt.toISOString().slice(0, 10)}.tar"`,
    );
    c.header('Content-Length', String(archiveByteLength(entries)));
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(archiveStream(entries, exportedAt));
  });
}
