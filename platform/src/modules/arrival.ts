import type { Hono, Context } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireUser, requireOps } from '../auth.js';
import { withActor, workerPool, query, HttpError, idempotent, audit, consumeQuota } from '../db.js';
import { graphSchema, type Graph, graphAssetIDs, releaseErrors } from '../maps/graph.js';
import { importLegacyGraph } from '../maps/legacy.js';
import { digest, canonicalJSON } from '../maps/canonical.js';
import { planRoute, availabilityExpiry, type Closure } from '../maps/planner.js';
import { resolvePublicAssets, mediaAuthority } from './media.js';
import { requireLocationCapability } from './entitlements.js';
import { RETENTION_LOCK } from './retention.js';
import { escapeHTML } from './publishing.js';
const prefix = '/v1/tenants/:tenantID/places/:placeID';
function version(c: Context) {
  const m = /^"?(?:arrival:)?(\d+)"?$/.exec(c.req.header('If-Match') || '');
  if (!m) throw new HttpError(428, 'version_required', 'Use the exact arrival draft ETag.');
  return Number(m[1]);
}
function draftDTO(r: any) {
  return {
    graph: r.body,
    revision: r.revision,
    state: r.state,
    reviewNote: r.review_note,
    reviewedAt: r.reviewed_at,
    approvedDigest: r.approved_digest,
  };
}
async function loadDraft(
  db: PoolClient,
  graphID: string,
  tenantID: string,
  placeID: string,
  lock = false,
) {
  const row = (
    await db.query(
      `SELECT * FROM arrival_drafts WHERE graph_id=$1 AND tenant_id=$2 AND place_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [graphID, tenantID, placeID],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      'arrival_draft_not_found',
      'Arrival draft not found in this location.',
    );
  return row;
}
async function bindingAuthority(db: PoolClient, g: Graph, tenantID: string) {
  for (const b of g.placeDestinationBindings) {
    const r = await db.query('SELECT arrival_binding_authorized($1,$2,$3) AS allowed', [
      g.buildingID,
      tenantID,
      b.placeID,
    ]);
    if (!r.rows[0]?.allowed)
      throw new HttpError(
        409,
        'shared_building_permission_required',
        'Every branch binding needs approved control or an operator-assigned shared-building grant.',
      );
  }
}
/** Serialize private image attachment with deletion. Public/shared media are never auto-purged. */
export async function lockArrivalDraftAssets(
  db: PoolClient,
  g: Graph,
  tenantID: string,
  placeID: string,
) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [RETENTION_LOCK]);
  const ids = graphAssetIDs(g);
  if (!ids.length) return;
  const rows = (
    await db.query(
      "SELECT id FROM media_assets WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND place_id=$3 AND retention_deleted_at IS NULL AND state<>'revoked'",
      [ids, tenantID, placeID],
    )
  ).rows;
  if (rows.length !== new Set(ids).size)
    throw new HttpError(
      422,
      'arrival_media_unavailable',
      'Some attached images are unavailable or belong to another location. Reload the media list.',
    );
}
async function checkedManifest(db: PoolClient, row: any) {
  const graph = graphSchema.parse(row.body),
    errors = releaseErrors(graph);
  if (errors.length) throw new HttpError(422, 'arrival_not_ready', errors.slice(0, 8).join(' '));
  await bindingAuthority(db, graph, row.tenant_id);
  const assets = await resolvePublicAssets(db, row.tenant_id, row.place_id, graphAssetIDs(graph));
  const manifestJSON = canonicalJSON({ graph, assets });
  return {
    graph,
    assets,
    manifestJSON,
    digest: createHash('sha256').update(manifestJSON).digest('hex'),
  };
}
function closuresDTO(rows: any[]): Closure[] {
  return rows.map((r) => ({
    id: r.id,
    targetType: r.target_type,
    targetID: r.target_id,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    reason: r.reason,
    revision: r.revision,
    status: r.status,
  }));
}
const querySchema = z.object({
  mode: z.enum(['walking', 'driving']).default('walking'),
  stepFree: z.enum(['true', 'false']).default('false'),
  locale: z
    .string()
    .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
    .default('en'),
  entranceID: z.string().max(160).optional(),
  departureAt: z.iso.datetime({ offset: true }).optional(),
});
export async function publicArrival(placeID: string, params: unknown, now = new Date()) {
  const input = querySchema.parse(params),
    departure = input.departureAt ? new Date(input.departureAt) : new Date(now);
  if (
    departure.getTime() < now.getTime() - 120000 ||
    departure.getTime() > now.getTime() + 7 * 86400000
  )
    throw new HttpError(
      400,
      'departure_out_of_range',
      'Choose a departure within the next seven days.',
    );
  // Tolerate a small client clock skew, but never evaluate a live closure against a past departure.
  if (departure < now) departure.setTime(now.getTime());
  const place = (
    await query(
      "SELECT id,revision,name,address FROM places WHERE id=$1 AND state NOT IN('closed','withdrawn','merged')",
      [placeID],
    )
  ).rows[0];
  if (!place) throw new HttpError(404, 'place_not_found', 'This business is unavailable.');
  const base = {
    schemaVersion: 2,
    placeID,
    placeRevision: place.revision,
    graphRevision: null as number | null,
    graphID: null as string | null,
    assetRevision: 'none',
    closureRevision: 0,
    capability: 'listing',
    status: 'listing_only',
    reason: 'This location has no currently published entrance guide.',
    computedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
    verification: null as any,
    selectedEntrance: null as any,
    destination: null as any,
    route: null as any,
    assets: [] as any[],
    graph: null as Graph | null,
    manifestJSON: null as string | null,
    manifestDigest: null as string | null,
    request: { ...input, departureAt: departure.toISOString() },
    address: place.address,
    name: place.name,
  };
  const release = (
    await query(
      'SELECT r.* FROM place_arrival_bindings b JOIN arrival_releases r ON r.id=b.release_id WHERE b.place_id=$1 AND arrival_place_visible($1,r.id)',
      [placeID],
    )
  ).rows[0];
  if (!release) return base;
  const graph = graphSchema.parse(release.graph);
  const ids = graphAssetIDs(graph);
  const assets = (
    await query(
      'SELECT id,revision,sha256,valid_until FROM public_media WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now()) ORDER BY id',
      [ids],
    )
  ).rows;
  const closures = closuresDTO(
    (
      await query('SELECT * FROM arrival_closures WHERE graph_id=$1 ORDER BY id', [
        release.graph_id,
      ])
    ).rows,
  );
  const expiry = availabilityExpiry(graph, closures, now);
  if (release.verification?.validUntil)
    expiry.setTime(Math.min(expiry.getTime(), Date.parse(release.verification.validUntil)));
  for (const a of assets)
    if (a.valid_until && new Date(a.valid_until) < expiry)
      expiry.setTime(new Date(a.valid_until).getTime());
  const result = {
    ...base,
    graphRevision: release.revision,
    graphID: release.graph_id,
    assetRevision: digest(assets.map((a) => [a.id, a.revision, a.sha256])),
    closureRevision: closures.reduce((sum, c) => sum + c.revision, 0),
    capability: graph.nodes.some(
      (n) => n.type === 'lift' || n.type === 'stairs' || n.type === 'ramp' || n.type === 'waypoint',
    )
      ? 'indoor'
      : 'entrance',
    status: 'unavailable',
    expiresAt: expiry.toISOString(),
    verification: release.verification,
  };
  if (assets.length !== ids.length)
    return {
      ...result,
      reason:
        'A required photo or floor-plan permission is unavailable. The guide is temporarily disabled.',
    };
  if (expiry <= now)
    return {
      ...result,
      status: 'expired',
      reason: 'Access-critical verification has expired. Confirm access with the business.',
    };
  const planned = planRoute(graph, closures, {
    placeID,
    mode: input.mode,
    stepFree: input.stepFree === 'true',
    locale: input.locale,
    entranceID: input.entranceID,
    departureAt: departure,
    now,
  });
  return {
    ...result,
    status: planned.route ? 'available' : 'unavailable',
    reason: planned.reason,
    selectedEntrance: planned.selectedEntrance ?? null,
    destination: planned.destination ?? null,
    route: planned.route,
    assets: release.assets,
    graph,
    manifestJSON: release.manifest_json,
    manifestDigest: release.digest,
  };
}
export function registerArrival(app: Hono) {
  app.post(`${prefix}/arrival-drafts/import-v1`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID');
    const b = z
      .object({
        legacy: z.unknown(),
        buildingID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
      })
      .strict()
      .parse(await c.req.json());
    await withActor(u.id, (db) => mediaAuthority(db, t, p));
    return c.json(importLegacyGraph(b.legacy, p, b.buildingID));
  });
  app.get(`${prefix}/arrival-drafts`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID');
    const drafts = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'view');
      return (
        await db.query(
          'SELECT * FROM arrival_drafts WHERE tenant_id=$1 AND place_id=$2 ORDER BY updated_at DESC LIMIT 50',
          [t, p],
        )
      ).rows.map(draftDTO);
    });
    return c.json({ drafts, limit: 50 });
  });
  app.post(`${prefix}/arrival-drafts`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID');
    const { graph } = z
      .object({ graph: graphSchema })
      .strict()
      .parse(await c.req.json());
    if (!graph.placeDestinationBindings.some((b) => b.placeID === p))
      throw new HttpError(
        422,
        'destination_binding_required',
        'Bind this location to its destination node.',
      );
    const result = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p);
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-create:${t}:${p}`,
        graph,
        async () => {
          await lockArrivalDraftAssets(db, graph, t, p);
          await db.query(
            'INSERT INTO arrival_sites(id,tenant_id,name,origin_place_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [graph.buildingID, t, graph.name, p],
          );
          const site = (
            await db.query(
              'SELECT * FROM arrival_sites WHERE id=$1 AND can_edit_arrival_site(id)',
              [graph.buildingID],
            )
          ).rows[0];
          if (!site)
            throw new HttpError(
              403,
              'building_permission_required',
              'This building requires an explicit editing grant.',
            );
          await bindingAuthority(db, graph, t);
          const row = (
            await db.query(
              'INSERT INTO arrival_drafts(graph_id,site_id,tenant_id,place_id,body,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *',
              [graph.graphID, graph.buildingID, t, p, graph, u.id],
            )
          ).rows[0];
          if (!row)
            throw new HttpError(
              409,
              'graph_exists',
              'That graph already exists. Load its current revision.',
            );
          await audit(db, u.id, t, 'arrival.draft_created', graph.graphID, { placeID: p });
          return draftDTO(row);
        },
      );
    });
    c.header('ETag', `"arrival:${result.revision}"`);
    return c.json(result, 201);
  });
  app.put(`${prefix}/arrival-drafts/:graphID`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID'),
      id = c.req.param('graphID'),
      expected = version(c);
    const { graph } = z
      .object({ graph: graphSchema })
      .strict()
      .parse(await c.req.json());
    const result = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p);
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-edit:${id}`,
        { graph, expected },
        async () => {
          await lockArrivalDraftAssets(db, graph, t, p);
          const row = await loadDraft(db, id, t, p, true);
          if (row.revision !== expected)
            throw new HttpError(
              412,
              'version_conflict',
              'The map changed. Reload and reconcile your draft.',
            );
          if (
            graph.graphID !== id ||
            graph.buildingID !== row.site_id ||
            !graph.placeDestinationBindings.some((b) => b.placeID === p)
          )
            throw new HttpError(
              422,
              'graph_identity_changed',
              'Graph, building and branch bindings must retain their identity.',
            );
          await bindingAuthority(db, graph, t);
          const changed = (
            await db.query(
              "UPDATE arrival_drafts SET body=$2,revision=revision+1,state='draft',approved_digest=NULL,review_evidence=NULL,reviewed_at=NULL,updated_at=now() WHERE graph_id=$1 RETURNING *",
              [id, graph],
            )
          ).rows[0];
          await audit(db, u.id, t, 'arrival.draft_edited', id, { revision: changed.revision });
          return draftDTO(changed);
        },
      );
    });
    c.header('ETag', `"arrival:${result.revision}"`);
    return c.json(result);
  });
  app.post(`${prefix}/arrival-drafts/:graphID/submit`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID'),
      id = c.req.param('graphID'),
      expected = version(c);
    const result = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'publish');
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-submit:${id}`,
        { expected },
        async () => {
          const row = await loadDraft(db, id, t, p, true);
          if (row.revision !== expected)
            throw new HttpError(
              412,
              'version_conflict',
              'The map changed. Reload it before review.',
            );
          const manifest = await checkedManifest(db, row);
          await db.query(
            "UPDATE arrival_drafts SET state='submitted',approved_digest=$2,updated_at=now() WHERE graph_id=$1",
            [id, manifest.digest],
          );
          await audit(db, u.id, t, 'arrival.review_requested', id, { digest: manifest.digest });
          return { state: 'submitted', revision: row.revision, digest: manifest.digest };
        },
      );
    });
    return c.json(result);
  });
  // Building grants are operator-reviewed independently of a business ownership claim.
  app.post('/v1/ops/arrival-sites/:siteID/grants', async (c) => {
    requireOps(c);
    const b = z
      .object({
        tenantID: z.uuid(),
        placeID: z.string().min(1).max(160),
        canEdit: z.boolean(),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const site = (
        await db.query(
          "SELECT * FROM arrival_sites WHERE id=$1 AND authority_state<>'revoked' FOR UPDATE",
          [c.req.param('siteID')],
        )
      ).rows[0];
      if (!site) throw new HttpError(404, 'site_not_found', 'Building not found.');
      if (
        !(
          await db.query(
            "SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
            [b.tenantID, b.placeID],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          'ownership_required',
          'An approved branch claim is required for the grant.',
        );
      await db.query(
        'INSERT INTO arrival_site_grants(site_id,tenant_id,place_id,can_edit) VALUES($1,$2,$3,$4) ON CONFLICT(site_id,tenant_id,place_id) DO UPDATE SET can_edit=EXCLUDED.can_edit',
        [site.id, b.tenantID, b.placeID, b.canEdit],
      );
      await audit(db, 'ops', b.tenantID, 'arrival.site_granted', site.id, {
        placeID: b.placeID,
        canEdit: b.canEdit,
        reason: b.reason,
      });
      await db.query('COMMIT');
      return c.json({ granted: true });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/ops/arrival-sites/:siteID/revoke', async (c) => {
    requireOps(c);
    const b = z
      .object({ reason: z.string().trim().min(10).max(1000) })
      .strict()
      .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const r = await db.query(
        "UPDATE arrival_sites SET authority_state='revoked',revision=revision+1 WHERE id=$1 RETURNING tenant_id",
        [c.req.param('siteID')],
      );
      if (!r.rowCount) throw new HttpError(404, 'site_not_found', 'Building not found.');
      await audit(db, 'ops', r.rows[0].tenant_id, 'arrival.site_revoked', c.req.param('siteID'), b);
      await db.query('COMMIT');
      return c.json({ revoked: true });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post(`${prefix}/arrival-drafts/:graphID/withdraw`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID'),
      id = c.req.param('graphID');
    const b = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(await c.req.json());
    const result = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'publish');
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-withdraw:${id}`,
        b,
        async () => {
          await loadDraft(db, id, t, p, true);
          await db.query(
            'UPDATE arrival_releases SET withdrawn_at=now() WHERE graph_id=$1 AND withdrawn_at IS NULL',
            [id],
          );
          await db.query(
            "UPDATE arrival_drafts SET state='draft',approved_digest=NULL,review_evidence=NULL,revision=revision+1,updated_at=now() WHERE graph_id=$1",
            [id],
          );
          await audit(db, u.id, t, 'arrival.withdrawn', id, b);
          return { withdrawn: true };
        },
      );
    });
    return c.json(result);
  });
  app.get('/v1/ops/arrival-reviews', async (c) => {
    requireOps(c);
    return c.json({
      drafts: (
        await workerPool.query(
          'SELECT graph_id AS "graphID",tenant_id AS "tenantID",place_id AS "placeID",body,revision,approved_digest AS digest FROM arrival_drafts WHERE state=\'submitted\' ORDER BY updated_at LIMIT 50',
        )
      ).rows,
    });
  });
  app.post('/v1/ops/arrival-reviews/:graphID', async (c) => {
    requireOps(c);
    const b = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        digest: z.string().length(64),
        reason: z.string().trim().min(10).max(2000),
        buildingAuthorityConfirmed: z.boolean(),
        walkthroughConfirmed: z.boolean(),
        source: z.enum(['owner_confirmed', 'independent']),
        validUntil: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const row = (
        await db.query('SELECT * FROM arrival_drafts WHERE graph_id=$1 FOR UPDATE', [
          c.req.param('graphID'),
        ])
      ).rows[0];
      if (!row || row.state !== 'submitted')
        throw new HttpError(409, 'review_state', 'The map is not awaiting review.');
      if (b.digest !== row.approved_digest)
        throw new HttpError(409, 'review_changed', 'The submitted digest changed.');
      if (b.decision === 'approved') {
        const manifest = await checkedManifest(db, row);
        if (b.digest !== manifest.digest)
          throw new HttpError(
            409,
            'review_changed',
            'The graph or images changed after submission.',
          );
      }
      if (
        b.decision === 'approved' &&
        (!b.buildingAuthorityConfirmed ||
          !b.walkthroughConfirmed ||
          Date.parse(b.validUntil) <= Date.now())
      )
        throw new HttpError(
          422,
          'review_evidence_required',
          'Building authority, completed walk-through and current evidence are required.',
        );
      const verification = {
        source: b.source,
        verifiedAt: new Date().toISOString(),
        validUntil: b.validUntil,
      };
      await db.query(
        'UPDATE arrival_drafts SET state=$2,review_note=$3,reviewed_at=now(),reviewed_by=$4,review_evidence=$5 WHERE graph_id=$1',
        [row.graph_id, b.decision, b.reason, 'ops', verification],
      );
      if (b.decision === 'approved')
        await db.query(
          "UPDATE arrival_sites SET authority_state='approved',revision=revision+1 WHERE id=$1",
          [row.site_id],
        );
      await audit(db, 'ops', row.tenant_id, 'arrival.reviewed', row.graph_id, {
        decision: b.decision,
        digest: b.digest,
      });
      await db.query('COMMIT');
      return c.json({ state: b.decision, verification });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post(`${prefix}/arrival-drafts/:graphID/publish`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID'),
      id = c.req.param('graphID'),
      expected = version(c);
    const b = z
      .object({ digest: z.string().length(64) })
      .strict()
      .parse(await c.req.json());
    const result = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'publish');
      await requireLocationCapability(db, t, p, 'map_publish');
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-publish:${id}`,
        { expected, ...b },
        async () => {
          const row = await loadDraft(db, id, t, p, true);
          if (row.revision !== expected)
            throw new HttpError(
              412,
              'version_conflict',
              'The map changed. Review the new revision.',
            );
          if (
            row.state !== 'approved' ||
            !row.review_evidence ||
            Date.parse(row.review_evidence.validUntil) <= Date.now()
          )
            throw new HttpError(
              409,
              'review_required',
              'A current independent publication review is required.',
            );
          const m = await checkedManifest(db, row);
          if (b.digest !== m.digest || row.approved_digest !== m.digest)
            throw new HttpError(
              409,
              'approved_digest_changed',
              'Approved graph or media changed. Submit for review again.',
            );
          const r = (
            await db.query(
              'INSERT INTO arrival_releases(graph_id,site_id,revision,graph,assets,manifest_json,digest,verification) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
              [
                id,
                row.site_id,
                row.revision,
                m.graph,
                JSON.stringify(m.assets),
                m.manifestJSON,
                m.digest,
                row.review_evidence,
              ],
            )
          ).rows[0];
          for (const binding of m.graph.placeDestinationBindings)
            await db.query(
              'INSERT INTO place_arrival_bindings(place_id,release_id,destination_node_id) VALUES($1,$2,$3) ON CONFLICT(place_id) DO UPDATE SET release_id=EXCLUDED.release_id,destination_node_id=EXCLUDED.destination_node_id,updated_at=now()',
              [binding.placeID, r.id, binding.destinationNodeID],
            );
          await db.query("UPDATE arrival_drafts SET state='published' WHERE graph_id=$1", [id]);
          await audit(db, u.id, t, 'arrival.published', id, {
            revision: row.revision,
            digest: m.digest,
          });
          return {
            published: true,
            graphID: id,
            graphRevision: row.revision,
            manifestDigest: m.digest,
            publicPath: `/places/${encodeURIComponent(p)}/arrival`,
          };
        },
      );
    });
    return c.json(result, 201);
  });
  app.post(`${prefix}/arrival-closures`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID');
    const b = z
      .object({
        graphID: z.string().min(1).max(160),
        targetType: z.enum(['entrance', 'node', 'edge', 'lift']),
        targetID: z.string().min(1).max(160),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }).nullable(),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .refine((b) => !b.endsAt || Date.parse(b.endsAt) > Date.parse(b.startsAt))
      .parse(await c.req.json());
    const r = await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'publish');
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `arrival-close:${t}:${p}`,
        b,
        async () => {
          const row = await loadDraft(db, b.graphID, t, p),
            g = graphSchema.parse(row.body);
          const exists =
            b.targetType === 'entrance'
              ? g.entrances.some((x) => x.id === b.targetID)
              : b.targetType === 'edge'
                ? g.directedEdges.some((x) => x.id === b.targetID)
                : b.targetType === 'lift'
                  ? g.nodes.some((x) => x.connectorID === b.targetID && x.type === 'lift')
                  : g.nodes.some((x) => x.id === b.targetID);
          if (!exists)
            throw new HttpError(422, 'closure_target_unknown', 'Choose a current graph element.');
          const site = (
            await db.query(
              "SELECT id FROM arrival_sites WHERE id=$1 AND authority_state='approved' AND can_edit_arrival_site(id)",
              [row.site_id],
            )
          ).rows[0];
          if (!site)
            throw new HttpError(
              403,
              'building_authority_required',
              'An authorized building editor must close a shared path.',
            );
          const r = (
            await db.query(
              'INSERT INTO arrival_closures(site_id,graph_id,target_type,target_id,starts_at,ends_at,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
              [
                row.site_id,
                b.graphID,
                b.targetType,
                b.targetID,
                b.startsAt,
                b.endsAt,
                b.reason,
                u.id,
              ],
            )
          ).rows[0];
          await audit(db, u.id, t, 'arrival.closed', r.id, { graphID: b.graphID });
          return closuresDTO([r])[0];
        },
      );
    });
    return c.json(r, 201);
  });
  app.post(`${prefix}/arrival-closures/:id/resolve`, async (c) => {
    const u = await requireUser(c),
      t = z.uuid().parse(c.req.param('tenantID')),
      p = c.req.param('placeID'),
      id = z.uuid().parse(c.req.param('id'));
    await withActor(u.id, async (db) => {
      await mediaAuthority(db, t, p, 'publish');
      const row = (
        await db.query(
          'SELECT c.* FROM arrival_closures c JOIN arrival_drafts d ON d.graph_id=c.graph_id WHERE c.id=$1 AND d.tenant_id=$2 AND d.place_id=$3 FOR UPDATE OF c',
          [id, t, p],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, 'closure_not_found', 'Closure not found.');
      if (row.status !== 'resolved') {
        await db.query(
          "UPDATE arrival_closures SET status='resolved',revision=revision+1 WHERE id=$1",
          [id],
        );
        await audit(db, u.id, t, 'arrival.closure_resolved', id);
      }
    });
    return c.json({ resolved: true });
  });
  app.post('/v1/places/:placeID/arrival/issues', async (c) => {
    const p = c.req.param('placeID');
    const b = z
      .object({
        description: z.string().trim().min(10).max(1000),
        graphID: z.string().max(160).nullable().optional(),
      })
      .strict()
      .parse(await c.req.json());
    if (
      !(await query("SELECT 1 FROM places WHERE id=$1 AND state NOT IN('withdrawn','merged')", [p]))
        .rowCount
    )
      throw new HttpError(404, 'place_not_found', 'Location not found.');
    await consumeQuota(`arrival-issue:place:${p}`, 20, 3600);
    await query('INSERT INTO arrival_issues(place_id,graph_id,description) VALUES($1,$2,$3)', [
      p,
      b.graphID ?? null,
      b.description,
    ]);
    return c.json(
      {
        received: true,
        message: 'Submitted for review. This report does not directly change public routes.',
      },
      202,
    );
  });
  app.get('/v1/places/:placeID/arrival', async (c) => {
    const body = await publicArrival(c.req.param('placeID'), c.req.query());
    c.header('Cache-Control', 'no-store');
    c.header('ETag', `"arrival:${digest(body)}"`);
    return c.json(body);
  });
  app.get('/places/:placeID/arrival', async (c) => {
    const b = await publicArrival(c.req.param('placeID'), c.req.query()),
      e = escapeHTML;
    const steps = b.route?.checkpoints ?? [];
    c.header('Cache-Control', 'no-store');
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(b.name)} · directions to the door</title><style>body{max-width:680px;margin:40px auto;padding:20px;background:#081511;color:#f4f2e7;font:18px/1.6 system-ui}a{color:#ffa56a}img{max-width:100%;height:auto}li{margin:24px 0}</style><h1>${e(b.name)}</h1><p>${e(b.address)}</p><p>${e(b.reason ?? 'Use the selected approach; confirm each checkpoint yourself. GPS cannot confirm an indoor floor.')}</p><nav><a href="?mode=walking">Walking</a> · <a href="?mode=driving">Driving approach</a> · <a href="?mode=walking&stepFree=true">Step-free</a></nav>${b.selectedEntrance ? `<h2>${e(b.selectedEntrance.label)}</h2><p>Outdoor approach: ${b.selectedEntrance.approach.latitude}, ${b.selectedEntrance.approach.longitude}</p><p><a rel="noreferrer" href="https://www.google.com/maps/dir/?api=1&amp;destination=${b.selectedEntrance.approach.latitude},${b.selectedEntrance.approach.longitude}&amp;travelmode=${b.request.mode === 'driving' ? 'driving' : 'walking'}&amp;dir_action=navigate">Open Google Maps to this approach</a></p>` : ''}<ol>${steps
        .map(
          (s: any) =>
            `<li><strong>${e(s.label)} · ${e(s.floorLabel)}</strong><p>${e(s.instruction)}</p>${s.photoIDs
              .map((id: string) => b.assets.find((a: any) => a.id === id))
              .filter(Boolean)
              .map((a: any) => `<img loading="lazy" src="${e(a.url)}" alt="${e(a.alt)}">`)
              .join('')}</li>`,
        )
        .join(
          '',
        )}</ol><p>Checked status expires ${e(b.expiresAt)}. Reload before a gated entrance or floor change. Step-free evidence is not a blanket wheelchair-suitability guarantee.</p></html>`,
    );
  });
}
