import type { Context, Hono } from 'hono';
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import {
  pool,
  workerPool,
  withActor,
  idempotent,
  canonical,
  HttpError,
  audit,
  consumeQuota,
} from '../db.js';
import { config } from '../config.js';
import { requirePlacePermission } from './business-auth.js';
import {
  requirePublicationCapability,
  requireLocationCapability,
  locationEntitlement,
} from './entitlements.js';
import {
  merchantProfileSchema,
  snapshotFromRows,
  renderPage,
  snapshotDigest,
  canonicalPath,
  type PageSnapshot,
} from './publishing.js';
import { resolvePublicAssets } from './media.js';
import { renderSiteArtifact } from './site-artifacts.js';
import {
  sha256,
  signBundle,
  verifyBundle,
  trustedSigningKeys,
  RENDERER_VERSION,
  TEMPLATE_HASH,
} from './adapters/bundles.js';
import { validatedPublicURL } from './adapters/safe-fetch.js';
const uuid = z.string().uuid(),
  id = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9-]+$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const prefix = '/v1/tenants/:tenantID/places/:placeID';
const mutationKey = (c: Context) => c.req.header('Idempotency-Key') ?? '';
const params = (c: Context) => ({
  tenant: uuid.parse(c.req.param('tenantID')),
  place: id.parse(c.req.param('placeID')),
});
export const wordpressContent = (fragment: string) =>
  '<!-- wp:html -->\n' + fragment + '\n<!-- /wp:html -->';
export function destinationDTO(r: any) {
  return {
    id: r.id,
    tenantID: r.tenant_id,
    placeID: r.place_id,
    pageID: r.page_id ?? null,
    metadataPermissions: r.allowed_metadata ?? [],
    kind: r.kind,
    state: r.state,
    version: r.version,
    publicURL: r.public_url,
    canonicalURL: r.canonical_url,
    installationID: r.installation_id ?? null,
    bindingID: r.binding_id,
    lastSequence: Number(r.last_sequence),
    lastSuccessAt: r.last_success_at ?? null,
    lastError: r.last_error ?? null,
    pausedAt: r.paused_at ?? null,
    domain: r.domain ?? null,
  };
}
export function deliveryDTO(r: any) {
  return {
    id: r.id,
    destinationID: r.destination_id,
    publicationID: r.publication_id,
    sequence: Number(r.sequence),
    state: r.state,
    errorCode: r.error_code ?? null,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? null,
    verifiedAt: r.verified_at ?? null,
  };
}
export async function targetFor(
  db: PoolClient,
  tenant: string,
  place: string,
  target: string,
  lock = false,
) {
  const r = (
    await db.query(
      `SELECT * FROM publication_destinations WHERE id=$1 AND tenant_id=$2 AND place_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [target, tenant, place],
    )
  ).rows[0];
  if (!r) throw new HttpError(404, 'destination_not_found', 'Website destination not found');
  return r;
}
export async function approvedAuthority(db: PoolClient, tenant: string, place: string) {
  const claim = (
    await db.query(
      "SELECT id FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
      [tenant, place],
    )
  ).rows[0];
  if (!claim)
    throw new HttpError(403, 'approved_claim_required', 'Approved business authority is required');
  return claim;
}
export async function enqueueAccess(
  db: PoolClient,
  destinationID: string,
  deliveryID: string | null = null,
  kind = 'page',
) {
  await db.query(
    "INSERT INTO access_jobs(destination_id,delivery_id,kind) VALUES($1,$2,$3) ON CONFLICT(destination_id,kind) WHERE state IN('queued','running') DO NOTHING",
    [destinationID, deliveryID, kind === 'page' && deliveryID ? 'page:' + deliveryID : kind],
  );
}
async function beforeProfile(db: PoolClient, place: string) {
  return (
    (await db.query('SELECT snapshot FROM public_pages WHERE place_id=$1', [place])).rows[0]
      ?.snapshot?.profile ?? {}
  );
}
export function correctionAssetsAreSubset(previous: unknown[], next: unknown[]): boolean {
  const approved = new Set(previous.map((value) => canonical(value)));
  return next.every((value) => approved.has(canonical(value)));
}
/** Essential correction is scoped to the previously delivered website, not a newer directory profile. */
export async function requireTargetCapability(
  db: PoolClient,
  target: any,
  snapshot: PageSnapshot,
  assets: unknown[],
  sequence: number,
  metadata: any,
) {
  const plan = await locationEntitlement(db, {
    tenantID: target.tenant_id,
    placeID: target.place_id,
    capability: 'publish',
  });
  if (plan.allowed) return plan;
  const prior = (
    await db.query(
      'SELECT p.snapshot,p.asset_manifest,p.metadata FROM target_deliveries d JOIN destination_previews p ON p.id=d.preview_id WHERE d.destination_id=$1 AND d.sequence<$2 AND d.applied_at IS NOT NULL ORDER BY d.sequence DESC LIMIT 1',
      [target.id, sequence],
    )
  ).rows[0];
  if (!prior)
    throw new HttpError(
      402,
      'location_plan_required',
      'Publishing a new website requires an active location plan',
    );
  if (
    !correctionAssetsAreSubset(prior.asset_manifest, assets) ||
    metadata.canonical !== prior.metadata.canonical
  )
    throw new HttpError(
      402,
      'location_plan_required',
      'New website images and canonical changes require an active location plan',
    );
  return requirePublicationCapability(
    db,
    target.tenant_id,
    target.place_id,
    prior.snapshot.profile,
    snapshot.profile,
  );
}
export async function withInstallation<T>(
  c: Context,
  fn: (db: PoolClient, installation: any) => Promise<T>,
): Promise<T> {
  const bearer = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,160})$/)?.[1];
  if (!bearer) throw new HttpError(401, 'installation_auth', 'Installation credential required');
  const installationID = uuid.parse(c.req.param('installationID')),
    db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.adapter_hash',$1,true)", [sha256(bearer)]);
    const installation = (
      await db.query(
        "SELECT * FROM adapter_installations WHERE id=$1 AND credential_hash=$2 AND status<>'revoked'",
        [installationID, sha256(bearer)],
      )
    ).rows[0];
    if (!installation)
      throw new HttpError(401, 'installation_revoked', 'Installation is unavailable or revoked');
    const result = await fn(db, installation);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
function version(c: Context) {
  const raw = c.req.header('If-Match')?.replaceAll('"', '');
  if (!raw || !/^[1-9][0-9]*$/.test(raw))
    throw new HttpError(428, 'version_required', 'Supply the reviewed draft version in If-Match');
  return Number(raw);
}
export function registerPublicationTargets(app: Hono) {
  app.get(prefix + '/destinations', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c);
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'view');
        const rows = (
          await db.query(
            'SELECT * FROM publication_destinations WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at DESC LIMIT 50',
            [tenant, place],
          )
        ).rows;
        return { destinations: rows.map(destinationDTO), nextCursor: null };
      }),
    );
  });
  app.get(prefix + '/destinations/:destinationID', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c);
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'view');
        const target = await targetFor(db, tenant, place, uuid.parse(c.req.param('destinationID')));
        const domain = (
          await db.query(
            'SELECT hostname,state,expires_at AS "expiresAt",activated_at AS "activatedAt" FROM destination_domains WHERE destination_id=$1 AND removed_at IS NULL',
            [target.id],
          )
        ).rows[0];
        return { destination: destinationDTO({ ...target, domain: domain ?? null }) };
      }),
    );
  });
  app.post(prefix + '/destinations', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      body = z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('hosted') }).strict(),
          z
            .object({
              kind: z.literal('wordpress'),
              pairingCode: z.string().regex(/^[A-Fa-f0-9]{10}$/),
              metadataPermissions: z
                .array(z.enum(['canonical', 'schema']))
                .max(2)
                .default([]),
            })
            .strict(),
        ])
        .parse(await c.req.json());
    await consumeQuota('destination:' + u.id, 30, 3600);
    const result = await withActor(u.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'manage_destinations');
      await approvedAuthority(db, tenant, place);
      return idempotent(
        db,
        u.id,
        mutationKey(c),
        'destination:' + tenant + ':' + place,
        body,
        async () => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'claim-place:' + place,
          ]);
          if (
            (
              await db.query(
                "SELECT id FROM publication_destinations WHERE place_id=$1 AND state<>'revoked'",
                [place],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              'destination_exists',
              'One included website is already selected for this location',
            );
          let installationID = null,
            pairingID = null,
            pageID = null,
            url = config.publicURL + '/sites/' + encodeURIComponent(place),
            hash = sha256(''),
            state = 'connected';
          if (body.kind === 'wordpress') {
            await db.query("SELECT set_config('app.pairing_hash',$1,true)", [
              sha256(body.pairingCode.toUpperCase()),
            ]);
            const pairing = (
              await db.query('SELECT * FROM adapter_pairings WHERE code_hash=$1 FOR UPDATE', [
                sha256(body.pairingCode.toUpperCase()),
              ])
            ).rows[0];
            if (
              !pairing ||
              pairing.approved_at ||
              pairing.consumed_at ||
              new Date(pairing.expires_at) <= new Date()
            )
              throw new HttpError(
                409,
                'pairing_expired',
                'This code expired or was already used. Generate a new code in WordPress.',
              );
            installationID = pairing.installation_id;
            pairingID = pairing.id;
            pageID = pairing.page_id;
            url = pairing.page_url;
            hash = pairing.base_content_hash;
            state = 'awaiting_confirmation';
            await db.query('UPDATE adapter_pairings SET approved_at=now() WHERE id=$1', [
              pairing.id,
            ]);
          }
          const target = (
            await db.query(
              'INSERT INTO publication_destinations(tenant_id,place_id,kind,installation_id,pairing_id,page_id,allowed_metadata,public_url,canonical_url,state,last_applied_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING *',
              [
                tenant,
                place,
                body.kind,
                installationID,
                pairingID,
                pageID,
                JSON.stringify(body.kind === 'wordpress' ? body.metadataPermissions : []),
                url,
                state,
                hash,
              ],
            )
          ).rows[0];
          await audit(db, u.id, tenant, 'destination.created', target.id, {
            placeID: place,
            kind: body.kind,
          });
          return { destination: destinationDTO(target) };
        },
      );
    });
    return c.json(result, 201);
  });
  app.post(prefix + '/destinations/:destinationID/preview', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      targetID = uuid.parse(c.req.param('destinationID')),
      body = z
        .object({ draftID: uuid, assetIDs: z.array(uuid).max(100).optional() })
        .strict()
        .parse(await c.req.json());
    const result = await withActor(u.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      await approvedAuthority(db, tenant, place);
      const target = await targetFor(db, tenant, place, targetID);
      const draft = (
          await db.query(
            'SELECT * FROM merchant_drafts WHERE id=$1 AND tenant_id=$2 AND place_id=$3',
            [body.draftID, tenant, place],
          )
        ).rows[0],
        p = (await db.query('SELECT * FROM places WHERE id=$1', [place])).rows[0];
      if (!draft || !p) throw new HttpError(404, 'draft_not_found', 'Draft not found');
      const pending = (
        await db.query(
          "SELECT id FROM target_deliveries WHERE destination_id=$1 AND state IN('queued','preparing','awaiting_sync','applying','reconciling') LIMIT 1",
          [targetID],
        )
      ).rows[0];
      const blockingIssues: string[] = [];
      if (pending)
        blockingIssues.push('Finish or reconcile the pending delivery before approving another.');
      if (draft.state !== 'draft') blockingIssues.push('Start a fresh draft.');
      if (!draft.rights_confirmed) blockingIssues.push('Confirm publication rights.');
      if (draft.base_place_revision !== p.revision)
        blockingIssues.push('The public record changed. Reconcile a fresh draft.');
      if (['revoked', 'awaiting_confirmation', 'awaiting_control'].includes(target.state))
        blockingIssues.push('Complete the website connection before publishing.');
      const previousAssets =
        body.assetIDs === undefined
          ? ((
              await db.query(
                'SELECT p.asset_manifest FROM target_deliveries d JOIN destination_previews p ON p.id=d.preview_id WHERE d.destination_id=$1 AND d.applied_at IS NOT NULL ORDER BY d.sequence DESC LIMIT 1',
                [targetID],
              )
            ).rows[0]?.asset_manifest ?? [])
          : [];
      const snapshot = snapshotFromRows(p, draft),
        assets = await resolvePublicAssets(
          db,
          tenant,
          place,
          body.assetIDs ?? previousAssets.map((a: any) => a.id),
        ),
        artifact = renderSiteArtifact(
          snapshot,
          {
            id: target.id,
            canonicalURL: target.canonical_url,
            sequence: Number(target.next_sequence),
          },
          assets,
        );
      const previewDigest = sha256(
        canonical({
          snapshot,
          targetID,
          targetVersion: target.version,
          sequence: Number(target.next_sequence),
          baseContentHash: target.conflict_hash ?? target.last_applied_hash,
          artifactDigest: artifact.artifactDigest,
          metadataDigest: artifact.metadataDigest,
          assets,
          rendererVersion: artifact.rendererVersion,
          templateHash: artifact.templateHash,
        }),
      );
      const preview = (
        await db.query(
          "INSERT INTO destination_previews(destination_id,tenant_id,place_id,draft_id,draft_version,target_version,sequence,snapshot,fragment,html,metadata,asset_manifest,base_content_hash,artifact_digest,metadata_digest,digest,renderer_version,template_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now()+interval '15 minutes') RETURNING *",
          [
            targetID,
            tenant,
            place,
            draft.id,
            draft.version,
            target.version,
            target.next_sequence,
            JSON.stringify(snapshot),
            artifact.fragment,
            artifact.html,
            JSON.stringify(artifact.metadata),
            JSON.stringify(assets),
            target.conflict_hash ?? target.last_applied_hash,
            artifact.artifactDigest,
            artifact.metadataDigest,
            previewDigest,
            artifact.rendererVersion,
            artifact.templateHash,
          ],
        )
      ).rows[0];
      return {
        preview: {
          id: preview.id,
          draftID: draft.id,
          draftVersion: draft.version,
          digest: previewDigest,
          html: artifact.html,
          managedFragment: artifact.fragment,
          managedArtifactDigest: artifact.artifactDigest,
          canonicalAndSchemaDigest: artifact.metadataDigest,
          baseContentHash: target.conflict_hash ?? target.last_applied_hash,
          sequence: Number(target.next_sequence),
          rendererVersion: artifact.rendererVersion,
          publicURL: target.public_url,
          blockingIssues,
          expiresAt: preview.expires_at,
        },
      };
    });
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    return c.json(result);
  });
  app.post(prefix + '/destinations/:destinationID/publish', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      targetID = uuid.parse(c.req.param('destinationID')),
      expected = version(c),
      body = z
        .object({ previewID: uuid, previewDigest: digest, approval: z.literal(true) })
        .strict()
        .parse(await c.req.json());
    const result = await withActor(u.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'publish');
      await approvedAuthority(db, tenant, place);
      return idempotent(
        db,
        u.id,
        mutationKey(c),
        'target-publish:' + targetID,
        { ...body, expected },
        async () => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'claim-place:' + place,
          ]);
          const target = await targetFor(db, tenant, place, targetID, true);
          if (
            (
              await db.query(
                "SELECT id FROM target_deliveries WHERE destination_id=$1 AND state IN('queued','preparing','awaiting_sync','applying','reconciling') LIMIT 1",
                [targetID],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              'delivery_pending',
              'Finish or reconcile the current delivery first',
            );
          const preview = (
            await db.query('SELECT * FROM destination_previews WHERE id=$1 AND destination_id=$2', [
              body.previewID,
              targetID,
            ])
          ).rows[0];
          if (!preview) throw new HttpError(404, 'preview_not_found', 'Preview not found');
          const draft = (
              await db.query('SELECT * FROM merchant_drafts WHERE id=$1 FOR UPDATE', [
                preview.draft_id,
              ])
            ).rows[0],
            p = (await db.query('SELECT * FROM places WHERE id=$1', [place])).rows[0];
          if (draft.version !== expected || preview.draft_version !== expected)
            throw new HttpError(412, 'draft_changed', 'Review the current draft');
          if (
            draft.state !== 'draft' ||
            !draft.rights_confirmed ||
            draft.base_place_revision !== p.revision ||
            ['revoked', 'awaiting_confirmation', 'awaiting_control'].includes(target.state)
          )
            throw new HttpError(
              409,
              'publication_blocked',
              'Resolve draft, authority or connection blockers before publication',
            );
          if (
            preview.digest !== body.previewDigest ||
            new Date(preview.expires_at) <= new Date() ||
            preview.target_version !== target.version ||
            Number(preview.sequence) !== Number(target.next_sequence) ||
            preview.base_content_hash !== (target.conflict_hash ?? target.last_applied_hash)
          )
            throw new HttpError(
              409,
              'preview_expired',
              'Review a fresh preview of this destination',
            );
          await requireTargetCapability(
            db,
            target,
            preview.snapshot,
            preview.asset_manifest,
            Number(preview.sequence),
            preview.metadata,
          );
          await resolvePublicAssets(
            db,
            tenant,
            place,
            preview.asset_manifest.map((a: any) => a.id),
          );
          const snapshot = snapshotFromRows(p, draft);
          if (canonical(snapshot) !== canonical(preview.snapshot))
            throw new HttpError(409, 'preview_changed', 'Draft facts changed; review again');
          const html = renderPage(snapshot),
            publication = (
              await db.query(
                'INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
                [
                  tenant,
                  place,
                  draft.id,
                  draft.version,
                  p.revision + 1,
                  JSON.stringify(snapshot),
                  snapshotDigest(snapshot, html),
                  html,
                  canonicalPath(snapshot),
                  u.id,
                ],
              )
            ).rows[0];
          await db.query('INSERT INTO publication_jobs(publication_id) VALUES($1)', [
            publication.id,
          ]);
          await db.query("UPDATE merchant_drafts SET state='queued' WHERE id=$1", [draft.id]);
          const delivery = (
            await db.query(
              'INSERT INTO target_deliveries(tenant_id,place_id,destination_id,publication_id,preview_id,sequence) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
              [tenant, place, targetID, publication.id, preview.id, preview.sequence],
            )
          ).rows[0];
          await db.query(
            "UPDATE publication_destinations SET next_sequence=next_sequence+1,state='awaiting_sync',last_error=NULL WHERE id=$1",
            [targetID],
          );
          await audit(db, u.id, tenant, 'target.approved', delivery.id, {
            previewID: preview.id,
            digest: preview.digest,
            destinationID: targetID,
          });
          return {
            publication: {
              id: publication.id,
              status: publication.status,
              placeID: place,
              revision: publication.revision,
            },
            delivery: deliveryDTO(delivery),
          };
        },
      );
    });
    return c.json(result, 202);
  });
  app.get(prefix + '/deliveries', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      cursor = c.req.query('cursor');
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'view');
        const rows = (
          await db.query(
            'SELECT * FROM target_deliveries WHERE tenant_id=$1 AND place_id=$2 AND ($3::uuid IS NULL OR destination_id=$3) AND ($4::timestamptz IS NULL OR created_at<$4) ORDER BY created_at DESC LIMIT 51',
            [
              tenant,
              place,
              c.req.query('destinationID') ? uuid.parse(c.req.query('destinationID')) : null,
              cursor ? z.iso.datetime().parse(cursor) : null,
            ],
          )
        ).rows;
        return {
          deliveries: rows.slice(0, 50).map(deliveryDTO),
          nextCursor: rows.length > 50 ? rows[49].created_at : null,
        };
      }),
    );
  });
  app.post(prefix + '/destinations/:destinationID/rollback', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      targetID = uuid.parse(c.req.param('destinationID')),
      body = z
        .object({ deliveryID: uuid })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'edit');
        const claim = await approvedAuthority(db, tenant, place);
        return idempotent(
          db,
          u.id,
          mutationKey(c),
          'target-rollback:' + targetID,
          body,
          async () => {
            const prior = (
              await db.query(
                'SELECT p.snapshot,p.asset_manifest FROM target_deliveries d JOIN destination_previews p ON p.id=d.preview_id WHERE d.id=$1 AND d.destination_id=$2 AND d.tenant_id=$3 AND d.place_id=$4',
                [body.deliveryID, targetID, tenant, place],
              )
            ).rows[0];
            if (!prior) throw new HttpError(404, 'delivery_not_found', 'Prior delivery not found');
            const p = (await db.query('SELECT revision FROM places WHERE id=$1', [place])).rows[0],
              draft = (
                await db.query(
                  'INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,rights_confirmed,created_by) VALUES($1,$2,$3,$4,$5,true,$6) RETURNING *',
                  [
                    tenant,
                    place,
                    claim.id,
                    p.revision,
                    JSON.stringify(merchantProfileSchema.parse(prior.snapshot.profile)),
                    u.id,
                  ],
                )
              ).rows[0];
            return {
              assetIDs: prior.asset_manifest.map((a: any) => a.id),
              draft: {
                id: draft.id,
                placeID: place,
                tenantID: tenant,
                basePlaceRevision: draft.base_place_revision,
                version: draft.version,
                state: draft.state,
                profile: draft.profile,
                rightsConfirmed: draft.rights_confirmed,
                updatedAt: draft.updated_at,
              },
            };
          },
        );
      }),
      201,
    );
  });
  app.post(prefix + '/destinations/:destinationID/retry', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      targetID = uuid.parse(c.req.param('destinationID')),
      body = z
        .object({ deliveryID: uuid })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'publish');
        return idempotent(db, u.id, mutationKey(c), 'target-retry:' + targetID, body, async () => {
          const row = (
            await db.query(
              'SELECT * FROM target_deliveries WHERE id=$1 AND destination_id=$2 AND tenant_id=$3 AND place_id=$4 FOR UPDATE',
              [body.deliveryID, targetID, tenant, place],
            )
          ).rows[0];
          if (!row) throw new HttpError(404, 'delivery_not_found', 'Delivery not found');
          if (row.envelope) {
            const payload = verifyBundle(row.envelope);
            if (new Date(payload.installBefore) <= new Date())
              throw new HttpError(
                409,
                'bundle_expired',
                'Create a fresh preview and approval; an expired bundle cannot be replayed',
              );
          }
          if (!['failed', 'delayed'].includes(row.state))
            throw new HttpError(
              409,
              'retry_unavailable',
              'This delivery is not retryable. Conflicts need a fresh reviewed draft.',
            );
          await db.query(
            "UPDATE target_deliveries SET state='queued',available_at=now(),attempts=0,error_code=NULL WHERE id=$1",
            [row.id],
          );
          return { queued: true };
        });
      }),
      202,
    );
  });
  app.post(prefix + '/destinations/:destinationID/disconnect', async (c) => {
    const u = await requireUser(c),
      { tenant, place } = params(c),
      targetID = uuid.parse(c.req.param('destinationID')),
      body = z
        .object({ retainContent: z.literal(true) })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        return idempotent(
          db,
          u.id,
          mutationKey(c),
          'target-disconnect:' + targetID,
          body,
          async () => {
            await targetFor(db, tenant, place, targetID, true);
            const r = (
              await db.query(
                "UPDATE publication_destinations SET state='revoked',version=version+1,disconnected_at=now(),last_error='connection_revoked' WHERE id=$1 RETURNING *",
                [targetID],
              )
            ).rows[0];
            await db.query(
              "UPDATE target_deliveries SET state='revoked',error_code='connection_revoked' WHERE destination_id=$1 AND state NOT IN('verified_live','applied_unverified')",
              [targetID],
            );
            await audit(db, u.id, tenant, 'destination.disconnected', targetID, {
              retainContent: true,
            });
            return { destination: destinationDTO(r) };
          },
        );
      }),
    );
  });
  registerAdapterMachine(app);
}
function registerAdapterMachine(app: Hono) {
  app.post('/v1/adapter/pairings', async (c) => {
    const body = z
      .object({
        origin: z.string().max(1000),
        pageID: z.string().regex(/^[1-9][0-9]{0,15}$/),
        pageURL: z.string().max(1800),
        baseContentHash: digest,
        pluginVersion: z.literal('1.0.0'),
        rendererVersion: z.literal(RENDERER_VERSION),
        templateHash: z.literal(TEMPLATE_HASH),
      })
      .strict()
      .parse(await c.req.json());
    const origin = validatedPublicURL(body.origin);
    if (origin.pathname !== '/' || origin.search)
      throw new HttpError(422, 'invalid_origin', 'Use the website HTTPS origin');
    const page = validatedPublicURL(body.pageURL);
    if (page.origin !== origin.origin)
      throw new HttpError(422, 'wrong_origin', 'Managed page must belong to this website');
    await consumeQuota('adapter-pair:' + sha256(c.req.header('X-Real-IP') ?? 'unknown'), 10, 3600);
    const credential = randomBytes(32).toString('base64url'),
      code = randomBytes(5).toString('hex').toUpperCase(),
      challenge = randomBytes(32).toString('base64url'),
      db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.adapter_hash',$1,true)", [sha256(credential)]);
      const installation = (
        await db.query(
          'INSERT INTO adapter_installations(origin,credential_hash,plugin_version,renderer_version,template_hash) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [
            origin.origin,
            sha256(credential),
            body.pluginVersion,
            body.rendererVersion,
            body.templateHash,
          ],
        )
      ).rows[0];
      const pairing = (
        await db.query(
          "INSERT INTO adapter_pairings(installation_id,code_hash,challenge,page_id,page_url,base_content_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') RETURNING id,expires_at",
          [installation.id, sha256(code), challenge, body.pageID, page.href, body.baseContentHash],
        )
      ).rows[0];
      await db.query('COMMIT');
      return c.json(
        {
          installationID: installation.id,
          credential,
          pairingID: pairing.id,
          code,
          challenge,
          expiresAt: pairing.expires_at,
          publicKeys: trustedSigningKeys(),
          revokedKeyIDs: (process.env.PUBLICATION_REVOKED_KEY_IDS ?? '').split(',').filter(Boolean),
        },
        201,
      );
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/adapter/installations/:installationID/pairings', async (c) => {
    const body = z
      .object({
        pageID: z.string().regex(/^[1-9][0-9]{0,15}$/),
        pageURL: z.string().max(1800),
        baseContentHash: digest,
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await withInstallation(c, async (db, installation) => {
        const url = validatedPublicURL(body.pageURL);
        if (url.origin !== installation.origin)
          throw new HttpError(422, 'wrong_origin', 'The page must use the approved origin');
        const code = randomBytes(5).toString('hex').toUpperCase(),
          challenge = randomBytes(32).toString('base64url');
        const r = (
          await db.query(
            "INSERT INTO adapter_pairings(installation_id,code_hash,challenge,page_id,page_url,base_content_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') RETURNING *",
            [installation.id, sha256(code), challenge, body.pageID, url.href, body.baseContentHash],
          )
        ).rows[0];
        return {
          installationID: installation.id,
          pairingID: r.id,
          code,
          challenge,
          expiresAt: r.expires_at,
        };
      }),
      201,
    );
  });
  app.get('/v1/adapter/installations/:installationID/pairings/:pairingID', async (c) =>
    c.json(
      await withInstallation(c, async (db, i) => {
        const p = (
          await db.query(
            'SELECT id,expires_at,approved_at,confirmed_at FROM adapter_pairings WHERE id=$1 AND installation_id=$2',
            [uuid.parse(c.req.param('pairingID')), i.id],
          )
        ).rows[0];
        if (!p) throw new HttpError(404, 'pairing_not_found', 'Pairing not found');
        const d = (
          await db.query('SELECT * FROM publication_destinations WHERE pairing_id=$1', [p.id])
        ).rows[0];
        return {
          pairingID: p.id,
          approved: !!p.approved_at,
          expiresAt: p.expires_at,
          destination: d ? destinationDTO(d) : null,
        };
      }),
    ),
  );
  app.post('/v1/adapter/installations/:installationID/pairings/:pairingID/confirm', async (c) =>
    c.json(
      await withInstallation(c, async (db, i) => {
        const p = (
          await db.query(
            'SELECT * FROM adapter_pairings WHERE id=$1 AND installation_id=$2 FOR UPDATE',
            [uuid.parse(c.req.param('pairingID')), i.id],
          )
        ).rows[0];
        if (!p || !p.approved_at || p.consumed_at || new Date(p.expires_at) <= new Date())
          throw new HttpError(
            409,
            'pairing_expired',
            'Pairing is expired, unapproved or already consumed',
          );
        const d = (
          await db.query(
            'SELECT * FROM publication_destinations WHERE pairing_id=$1 AND installation_id=$2',
            [p.id, i.id],
          )
        ).rows[0];
        if (!d)
          throw new HttpError(
            409,
            'binding_missing',
            'Approve this site and branch in Kulture first',
          );
        await db.query('UPDATE adapter_pairings SET confirmed_at=now() WHERE id=$1', [p.id]);
        await db.query("UPDATE publication_destinations SET state='awaiting_control' WHERE id=$1", [
          d.id,
        ]);
        await enqueueAccess(db, d.id, null, 'control');
        return { state: 'awaiting_control' };
      }),
      202,
    ),
  );
  app.get('/v1/adapter/installations/:installationID/bundles', async (c) =>
    c.json(
      await withInstallation(c, async (db, i) => {
        if (i.status !== 'connected') return { bundles: [], bindings: [] };
        await db.query('UPDATE adapter_installations SET last_seen_at=now() WHERE id=$1', [i.id]);
        const bindings = (
          await db.query(
            'SELECT * FROM publication_destinations WHERE installation_id=$1 ORDER BY created_at LIMIT 100',
            [i.id],
          )
        ).rows;
        const rows = (
          await db.query(
            "SELECT d.envelope FROM target_deliveries d JOIN publication_destinations t ON t.id=d.destination_id WHERE t.installation_id=$1 AND t.state<>'revoked' AND d.state IN('awaiting_sync','applying') ORDER BY d.sequence LIMIT 25",
            [i.id],
          )
        ).rows;
        return {
          bundles: rows.map((r) => r.envelope),
          bindings: bindings.map(destinationDTO),
          publicKeys: trustedSigningKeys(),
          revokedKeyIDs: (process.env.PUBLICATION_REVOKED_KEY_IDS ?? '').split(',').filter(Boolean),
        };
      }),
    ),
  );
  app.post('/v1/adapter/installations/:installationID/apply-leases', async (c) => {
    const body = z
      .object({ bundleID: uuid, payloadDigest: digest })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await withInstallation(c, async (db, i) => {
        const d = (
          await db.query(
            'SELECT d.*,t.binding_id,t.version AS target_version,t.state AS target_state,t.installation_id FROM target_deliveries d JOIN publication_destinations t ON t.id=d.destination_id WHERE d.bundle_id=$1 AND t.installation_id=$2 FOR UPDATE OF d,t',
            [body.bundleID, i.id],
          )
        ).rows[0];
        if (!d || d.target_state === 'revoked' || !['awaiting_sync', 'applying'].includes(d.state))
          throw new HttpError(409, 'apply_unavailable', 'This bundle is no longer authorized');
        if (d.envelope?.payloadDigest !== body.payloadDigest)
          throw new HttpError(409, 'bundle_conflict', 'Bundle digest does not match');
        const payload = verifyBundle(d.envelope);
        if (new Date(payload.installBefore) <= new Date())
          throw new HttpError(409, 'bundle_expired', 'Review a new publication');
        if (
          !(await db.query('SELECT adapter_approval_current($1) AS allowed', [d.publication_id]))
            .rows[0]?.allowed
        )
          throw new HttpError(
            403,
            'approval_revoked',
            'The approving user no longer has publication authority',
          );
        await approvedAuthority(db, d.tenant_id, d.place_id);
        await requireTargetCapability(
          db,
          { id: d.destination_id, tenant_id: d.tenant_id, place_id: d.place_id },
          payload.factsSnapshot,
          payload.assetManifest,
          Number(d.sequence),
          payload.metadata,
        );
        for (const asset of payload.assetManifest ?? []) {
          const publicAsset = (
            await db.query(
              'SELECT id FROM public_media WHERE id=$1 AND tenant_id=$2 AND place_id=$3 AND sha256=$4 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now())',
              [asset.id, d.tenant_id, d.place_id, asset.sha256],
            )
          ).rows[0];
          if (!publicAsset)
            throw new HttpError(
              422,
              'media_revoked',
              'An approved image is no longer available for publication',
            );
        }
        const token = randomBytes(32).toString('base64url'),
          expiresAt = new Date(Date.now() + 15000);
        await db.query(
          'INSERT INTO adapter_apply_leases(delivery_id,installation_id,token_hash,destination_version,expires_at) VALUES($1,$2,$3,$4,$5)',
          [d.id, i.id, sha256(token), d.target_version, expiresAt],
        );
        await db.query("UPDATE target_deliveries SET state='applying' WHERE id=$1", [d.id]);
        return {
          token,
          expiresAt,
          bundleID: d.bundle_id,
          payloadDigest: body.payloadDigest,
          bindingID: d.binding_id,
        };
      }),
      201,
    );
  });
  app.post('/v1/adapter/installations/:installationID/receipts', async (c) => {
    const body = z
      .object({
        bundleID: uuid,
        payloadDigest: digest,
        state: z.enum(['applied', 'conflict', 'failed']),
        leaseToken: z.string().max(160).optional(),
        contentHash: digest,
        reason: z.string().max(200).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await withInstallation(c, async (db, i) => {
        const requestDigest = sha256(canonical(body)),
          prior = (
            await db.query(
              'SELECT * FROM adapter_receipts WHERE installation_id=$1 AND bundle_id=$2',
              [i.id, body.bundleID],
            )
          ).rows[0];
        if (prior) {
          if (prior.request_digest !== requestDigest)
            throw new HttpError(
              409,
              'receipt_conflict',
              'Receipt ID already has different content',
            );
          return prior.result;
        }
        const d = (
          await db.query(
            'SELECT d.*,t.state AS target_state,t.version AS target_version,t.last_sequence FROM target_deliveries d JOIN publication_destinations t ON t.id=d.destination_id WHERE d.bundle_id=$1 AND t.installation_id=$2 FOR UPDATE OF d,t',
            [body.bundleID, i.id],
          )
        ).rows[0];
        if (!d || d.envelope?.payloadDigest !== body.payloadDigest)
          throw new HttpError(404, 'bundle_not_found', 'Bundle not found');
        const payload = verifyBundle(d.envelope);
        if (body.state === 'applied') {
          const lease = (
            await db.query(
              'SELECT * FROM adapter_apply_leases WHERE delivery_id=$1 AND installation_id=$2 AND token_hash=$3 AND used_at IS NULL FOR UPDATE',
              [d.id, i.id, sha256(body.leaseToken ?? '')],
            )
          ).rows[0];
          if (
            !lease ||
            lease.destination_version !== d.target_version ||
            d.target_state === 'revoked' ||
            Number(d.sequence) <= Number(d.last_sequence)
          )
            throw new HttpError(
              409,
              'apply_lease_expired',
              'Apply authorization expired or changed; reconcile before another write',
            );
          if (body.contentHash !== sha256(wordpressContent(payload.managedHTML)))
            throw new HttpError(
              409,
              'artifact_mismatch',
              'The saved managed page does not match the approved artifact',
            );
          if (new Date(lease.expires_at) <= new Date()) {
            // The plugin may have saved before an acknowledgement was lost. Do not issue another write.
            // Reconcile the exact public artifact independently before accepting its sequence/base hash.
            await db.query(
              "UPDATE target_deliveries SET state='reconciling',error_code='late_acknowledgement' WHERE id=$1",
              [d.id],
            );
            await enqueueAccess(db, d.destination_id, d.id);
            const pending = { accepted: true, state: 'reconciling' };
            await db.query(
              'INSERT INTO adapter_receipts(installation_id,bundle_id,request_digest,result) VALUES($1,$2,$3,$4)',
              [i.id, body.bundleID, requestDigest, JSON.stringify(pending)],
            );
            return pending;
          }
          await db.query('UPDATE adapter_apply_leases SET used_at=now() WHERE id=$1', [lease.id]);
          await db.query(
            "UPDATE target_deliveries SET state='applied_unverified',applied_at=now(),error_code=NULL WHERE id=$1",
            [d.id],
          );
          await db.query(
            "UPDATE publication_destinations SET state='applied_unverified',last_sequence=$2,last_applied_hash=$3,conflict_hash=NULL WHERE id=$1",
            [d.destination_id, d.sequence, body.contentHash],
          );
          await enqueueAccess(db, d.destination_id, d.id);
        } else {
          await db.query('UPDATE target_deliveries SET state=$2,error_code=$3 WHERE id=$1', [
            d.id,
            body.state,
            body.reason ?? body.state,
          ]);
          await db.query(
            "UPDATE publication_destinations SET state=$2,last_error=$3,conflict_hash=CASE WHEN $2='conflict' THEN $4 ELSE conflict_hash END,version=version+1 WHERE id=$1",
            [d.destination_id, body.state, body.reason ?? body.state, body.contentHash],
          );
        }
        const result = {
          accepted: true,
          state: body.state === 'applied' ? 'applied_unverified' : body.state,
        };
        await db.query(
          'INSERT INTO adapter_receipts(installation_id,bundle_id,request_digest,result) VALUES($1,$2,$3,$4)',
          [i.id, body.bundleID, requestDigest, JSON.stringify(result)],
        );
        return result;
      }),
    );
  });
  app.post('/v1/adapter/installations/:installationID/bindings/:bindingID/disconnect', async (c) =>
    c.json(
      await withInstallation(c, async (db, i) => {
        const row = (
          await db.query(
            "UPDATE publication_destinations SET state='revoked',version=version+1,disconnected_at=now() WHERE installation_id=$1 AND binding_id=$2 RETURNING id",
            [i.id, uuid.parse(c.req.param('bindingID'))],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, 'binding_missing', 'Connection not found');
        return { revoked: true, retainContent: true };
      }),
    ),
  );
  app.post('/v1/adapter/installations/:installationID/disconnect', async (c) =>
    c.json(
      await withInstallation(c, async (db, i) => {
        await db.query(
          "UPDATE publication_destinations SET state='revoked',version=version+1,disconnected_at=now() WHERE installation_id=$1",
          [i.id],
        );
        await db.query(
          "UPDATE adapter_installations SET status='revoked',revoked_at=now() WHERE id=$1",
          [i.id],
        );
        return { revoked: true, retainContent: true };
      }),
    ),
  );
}
export async function processTargetPublicationJob(): Promise<boolean> {
  const db = await workerPool.connect();
  let job: any;
  try {
    await db.query('BEGIN');
    job = (
      await db.query(
        "SELECT * FROM target_deliveries WHERE state IN('queued','preparing') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!job) {
      await db.query('COMMIT');
      return false;
    }
    await db.query(
      "UPDATE target_deliveries SET state='preparing',lease_until=now()+interval '60 seconds' WHERE id=$1",
      [job.id],
    );
    await db.query('COMMIT');
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'claim-place:' + job.place_id,
    ]);
    const target = await targetFor(db, job.tenant_id, job.place_id, job.destination_id, true),
      preview = (await db.query('SELECT * FROM destination_previews WHERE id=$1', [job.preview_id]))
        .rows[0],
      publication = (await db.query('SELECT * FROM publications WHERE id=$1', [job.publication_id]))
        .rows[0];
    if (publication.status === 'queued') {
      await db.query(
        "UPDATE target_deliveries SET state='queued',lease_until=NULL,available_at=now()+interval '2 seconds' WHERE id=$1",
        [job.id],
      );
      await db.query('COMMIT');
      return true;
    }
    if (publication.status !== 'live' || target.state === 'revoked')
      throw new HttpError(409, 'publication_revoked', 'Authority or publication changed');
    await approvedAuthority(db, job.tenant_id, job.place_id);
    if (!job.approved_by && !publication.approved_by)
      throw new HttpError(403, 'approval_required', 'A current publishing approval is required');
    await db.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE', [
      job.tenant_id,
      job.approved_by ?? publication.approved_by,
    ]);
    await db.query("SELECT set_config('app.actor_id',$1,true)", [
      job.approved_by ?? publication.approved_by,
    ]);
    await requirePlacePermission(db, job.tenant_id, job.place_id, 'publish');
    const older =
      (
        await db.query(
          'SELECT snapshot FROM publications WHERE place_id=$1 AND revision<$2 AND published_at IS NOT NULL ORDER BY revision DESC LIMIT 1',
          [job.place_id, publication.revision],
        )
      ).rows[0]?.snapshot?.profile ?? {};
    await requireTargetCapability(
      db,
      target,
      preview.snapshot,
      preview.asset_manifest,
      Number(job.sequence),
      preview.metadata,
    );
    await resolvePublicAssets(
      db,
      job.tenant_id,
      job.place_id,
      preview.asset_manifest.map((a: any) => a.id),
    );
    if (
      preview.target_version !== target.version ||
      sha256(preview.fragment) !== preview.artifact_digest ||
      sha256(canonical(preview.metadata)) !== preview.metadata_digest
    )
      throw new HttpError(409, 'artifact_changed', 'Target or approved artifact changed');
    if (target.kind === 'hosted') {
      await db.query(
        'INSERT INTO hosted_sites(destination_id,place_id,delivery_id,html,digest,canonical_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(place_id) DO UPDATE SET destination_id=EXCLUDED.destination_id,delivery_id=EXCLUDED.delivery_id,html=EXCLUDED.html,digest=EXCLUDED.digest,canonical_url=EXCLUDED.canonical_url,published_at=now(),withdrawn_at=NULL',
        [
          target.id,
          target.place_id,
          job.id,
          preview.html,
          sha256(preview.html),
          target.canonical_url,
        ],
      );
      await db.query(
        "UPDATE target_deliveries SET state='applied_unverified',applied_at=now(),lease_until=NULL,error_code=NULL WHERE id=$1",
        [job.id],
      );
      await db.query(
        "UPDATE publication_destinations SET state='applied_unverified',last_sequence=$2,last_applied_hash=$3,conflict_hash=NULL WHERE id=$1",
        [target.id, job.sequence, preview.artifact_digest],
      );
      await enqueueAccess(db, target.id, job.id);
    } else {
      const installation = (
        await db.query('SELECT * FROM adapter_installations WHERE id=$1', [target.installation_id])
      ).rows[0];
      if (installation?.status !== 'connected')
        throw new HttpError(409, 'installation_revoked', 'Reconnect the approved website');
      const payload = {
        bundleID: job.bundle_id,
        schemaVersion: 1,
        rendererVersion: preview.renderer_version,
        templateHash: preview.template_hash,
        managedArtifactDigest: preview.artifact_digest,
        canonicalAndSchemaDigest: preview.metadata_digest,
        tenantID: target.tenant_id,
        placeID: target.place_id,
        destinationID: target.id,
        installationID: installation.id,
        bindingID: target.binding_id,
        expectedOrigin: installation.origin,
        allowedPageOrBlockIDs: [target.page_id],
        permittedMetadataChanges: target.allowed_metadata,
        sequence: Number(job.sequence),
        baseContentHash: preview.base_content_hash,
        approvedRevisionID: publication.id,
        approvalID: preview.id,
        issuedAt: new Date().toISOString(),
        installBefore: new Date(Date.now() + 24 * 3600000).toISOString(),
        factsSnapshot: preview.snapshot,
        previousFactsSnapshot: older,
        assetManifest: preview.asset_manifest,
        managedHTML: preview.fragment,
        metadata: preview.metadata,
        metadataBytes: Buffer.from(canonical(preview.metadata)).toString('base64'),
      };
      const envelope = job.envelope ?? signBundle(payload);
      await db.query(
        "UPDATE target_deliveries SET state='awaiting_sync',envelope=$2,lease_until=NULL,error_code=NULL WHERE id=$1",
        [job.id, JSON.stringify(envelope)],
      );
      await db.query("UPDATE publication_destinations SET state='awaiting_sync' WHERE id=$1", [
        target.id,
      ]);
    }
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    if (job) {
      const code = error instanceof HttpError ? error.code : 'target_worker_error',
        permanent = error instanceof HttpError && error.status < 500;
      await db.query(
        "UPDATE target_deliveries SET attempts=attempts+1,state=CASE WHEN $2 OR attempts>=4 THEN 'failed' ELSE 'queued' END,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,6)))+random()*10),lease_until=NULL,error_code=$3 WHERE id=$1",
        [job.id, permanent, code],
      );
      await db.query(
        "UPDATE publication_destinations SET last_error=$2,state='delayed' WHERE id=$1 AND state<>'revoked'",
        [job.destination_id, code],
      );
    }
    return !!job;
  } finally {
    db.release();
  }
}
