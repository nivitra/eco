import type { Hono, Context } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireUser, requireOps, authPool } from '../auth.js';
import { withActor, requireRole, idempotent, HttpError, audit, workerPool } from '../db.js';
import { config } from '../config.js';
import { requirePlacePermission } from './business-auth.js';
import { requirePublicationCapability } from './entitlements.js';
import {
  merchantProfileSchema,
  snapshotFromRows,
  renderPage,
  snapshotDigest,
  publicURL,
  canonicalPath,
} from './publishing.js';
export { processPublishingJob } from './publishing.js';
const uuid = z.string().uuid(),
  placeID = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9-]+$/);
const claimBody = z
  .object({
    placeID,
    evidence: z
      .object({
        description: z.string().trim().min(30).max(4000),
        url: z
          .string()
          .url()
          .max(1000)
          .optional()
          .refine((v) => !v || ['https:', 'http:'].includes(new URL(v).protocol)),
      })
      .strict(),
  })
  .strict();
const createBody = z
  .object({
    basePlaceRevision: z.number().int().positive(),
    profile: merchantProfileSchema,
    rightsConfirmed: z.boolean(),
  })
  .strict();
const editBody = z
  .object({ profile: merchantProfileSchema, rightsConfirmed: z.boolean() })
  .strict();
const approveBody = z
  .object({ approval: z.literal(true), previewDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export function expectedVersion(c: Context): number {
  const raw = c.req.header('If-Match');
  if (!raw)
    throw new HttpError(428, 'version_required', 'Review the current draft and provide If-Match');
  const match = /^"?([1-9][0-9]*)"?$/.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new HttpError(400, 'invalid_version', 'If-Match must be a draft revision');
  return Number(match[1]);
}
function claimDTO(r: any) {
  return {
    id: r.id,
    placeID: r.place_id,
    tenantID: r.tenant_id,
    state: r.state,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at ?? null,
    reviewReason: r.review_reason ?? null,
  };
}
function draftDTO(r: any) {
  return {
    id: r.id,
    placeID: r.place_id,
    tenantID: r.tenant_id,
    basePlaceRevision: r.base_place_revision,
    version: r.version,
    state: r.state,
    profile: r.profile,
    rightsConfirmed: r.rights_confirmed,
    updatedAt: r.updated_at,
  };
}
function publicationDTO(r: any) {
  return {
    id: r.id,
    placeID: r.place_id,
    tenantID: r.tenant_id,
    draftID: r.draft_id,
    draftVersion: r.draft_version,
    revision: r.revision,
    status: r.status,
    publicURL: config.publicURL + r.canonical_path,
    digest: r.digest,
    createdAt: r.created_at,
    publishedAt: r.published_at ?? null,
    error: r.error ?? null,
  };
}
function placeDTO(r: any) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    neighborhood: r.neighborhood,
    address: r.address,
    summary: r.summary,
    tags: r.tags,
    revision: r.revision,
    city: r.city,
  };
}
async function ownedPlace(db: PoolClient, tenant: string, id: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`claim-place:${id}`]);
  const place = (await db.query('SELECT * FROM places WHERE id=$1', [id])).rows[0];
  if (!place) throw new HttpError(404, 'place_not_found', 'Place not found');
  const claim = (
    await db.query(
      "SELECT * FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
      [tenant, id],
    )
  ).rows[0];
  if (!claim)
    throw new HttpError(
      403,
      'approved_claim_required',
      'An operator must approve your ownership claim before editing this place',
    );
  return { place, claim };
}
async function editablePlace(db: PoolClient, tenant: string, id: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`claim-place:${id}`]);
  const place = (await db.query('SELECT * FROM places WHERE id=$1', [id])).rows[0];
  if (!place) throw new HttpError(404, 'place_not_found', 'Place not found');
  const claim = (
    await db.query(
      `SELECT * FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2
       AND state IN ('approved','submitted')
       ORDER BY (state='approved') DESC,submitted_at DESC LIMIT 1`,
      [tenant, id],
    )
  ).rows[0];
  if (!claim)
    throw new HttpError(
      403,
      'approved_claim_required',
      'An operator must approve your ownership claim before editing this place',
    );
  return { place, claim };
}
async function draftFor(db: PoolClient, tenant: string, id: string, draft: string, lock = false) {
  const r = (
    await db.query(
      `SELECT * FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`,
      [tenant, id, draft],
    )
  ).rows[0];
  if (!r) throw new HttpError(404, 'draft_not_found', 'Draft not found');
  return r;
}
function params(c: Context) {
  return {
    tenant: uuid.parse(c.req.param('tenantID')),
    place: placeID.parse(c.req.param('placeID')),
  };
}
export function registerMerchant(app: Hono) {
  app.get('/v1/tenants/:tenantID/places', async (c) => {
    const user = await requireUser(c),
      tenant = uuid.parse(c.req.param('tenantID'));
    const result = await withActor(user.id, async (db) => {
      await requireRole(db, tenant, ['owner', 'manager', 'editor', 'viewer']);
      return (
        await db.query(
          `SELECT DISTINCT ON(p.id) p.id,p.name,p.category,p.neighborhood,p.revision,c.state AS claim_state,c.id AS claim_id FROM merchant_claims c JOIN places p ON p.id=c.place_id WHERE c.tenant_id=$1 ORDER BY p.id,(c.state='approved') DESC,c.submitted_at DESC`,
          [tenant],
        )
      ).rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        neighborhood: r.neighborhood,
        revision: r.revision,
        claimState: r.claim_state,
        claimID: r.claim_id,
      }));
    });
    return c.json({ places: result });
  });
  app.post('/v1/tenants/:tenantID/claims', async (c) => {
    const user = await requireUser(c),
      tenant = uuid.parse(c.req.param('tenantID')),
      body = claimBody.parse(await c.req.json());
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, body.placeID, 'edit');
      return idempotent(
        db,
        user.id,
        c.req.header('Idempotency-Key') ?? '',
        `claim:${tenant}`,
        body,
        async () => {
          if (!(await db.query('SELECT id FROM places WHERE id=$1', [body.placeID])).rows[0])
            throw new HttpError(
              404,
              'place_not_found',
              'Choose an existing place from the public collection',
            );
          const r = (
            await db.query(
              'INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,$3,$4) RETURNING *',
              [tenant, body.placeID, user.id, JSON.stringify(body.evidence)],
            )
          ).rows[0];
          await audit(db, user.id, tenant, 'claim.submitted', r.id, { placeID: body.placeID });
          return { claim: claimDTO(r) };
        },
      );
    });
    return c.json(result, 202);
  });
  app.get('/v1/tenants/:tenantID/claims/:claimID', async (c) => {
    const user = await requireUser(c),
      tenant = uuid.parse(c.req.param('tenantID')),
      id = uuid.parse(c.req.param('claimID'));
    const claim = await withActor(user.id, async (db) => {
      await requireRole(db, tenant, ['owner', 'manager', 'editor', 'viewer']);
      const r = (
        await db.query('SELECT * FROM merchant_claims WHERE tenant_id=$1 AND id=$2', [tenant, id])
      ).rows[0];
      if (!r) throw new HttpError(404, 'claim_not_found', 'Claim not found');
      await requirePlacePermission(db, tenant, r.place_id, 'view');
      return claimDTO(r);
    });
    return c.json({ claim });
  });
  app.get('/v1/tenants/:tenantID/places/:placeID', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c);
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const claim = (
        await db.query(
          "SELECT * FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 ORDER BY (state='approved') DESC,submitted_at DESC LIMIT 1",
          [tenant, place],
        )
      ).rows[0];
      if (!claim)
        throw new HttpError(404, 'claim_not_found', 'Submit a claim for this place first');
      const p = (await db.query('SELECT * FROM places WHERE id=$1', [place])).rows[0];
      if (!p) throw new HttpError(404, 'place_not_found', 'Place not found');
      const draft = (
        await db.query(
          'SELECT * FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 ORDER BY updated_at DESC LIMIT 1',
          [tenant, place],
        )
      ).rows[0];
      const publication = (
        await db.query(
          'SELECT * FROM publications WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at DESC LIMIT 1',
          [tenant, place],
        )
      ).rows[0];
      return {
        place: placeDTO(p),
        claim: claimDTO(claim),
        draft: draft ? draftDTO(draft) : null,
        latestPublication: publication ? publicationDTO(publication) : null,
        canEditDraft: claim.state === 'approved' || claim.state === 'submitted',
      };
    });
    return c.json(result);
  });
  app.post('/v1/tenants/:tenantID/places/:placeID/drafts', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      body = createBody.parse(await c.req.json());
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'edit');
      const owned = await editablePlace(db, tenant, place);
      return idempotent(
        db,
        user.id,
        c.req.header('Idempotency-Key') ?? '',
        `draft:${tenant}:${place}`,
        body,
        async () => {
          if (owned.place.revision !== body.basePlaceRevision)
            throw new HttpError(
              409,
              'place_changed',
              'The live place changed; reload before starting this draft',
            );
          const r = (
            await db.query(
              'INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,rights_confirmed,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [
                tenant,
                place,
                owned.claim.id,
                body.basePlaceRevision,
                JSON.stringify(body.profile),
                body.rightsConfirmed,
                user.id,
              ],
            )
          ).rows[0];
          await audit(db, user.id, tenant, 'draft.created', r.id, { placeID: place });
          return { draft: draftDTO(r) };
        },
      );
    });
    c.header('ETag', `"${result.draft.version}"`);
    return c.json(result, 201);
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/drafts/:draftID', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      id = uuid.parse(c.req.param('draftID'));
    const draft = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      return draftDTO(await draftFor(db, tenant, place, id));
    });
    c.header('ETag', `"${draft.version}"`);
    return c.json({ draft });
  });
  app.patch('/v1/tenants/:tenantID/places/:placeID/drafts/:draftID', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      id = uuid.parse(c.req.param('draftID')),
      version = expectedVersion(c),
      body = editBody.parse(await c.req.json());
    const draft = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'edit');
      await editablePlace(db, tenant, place);
      const existing = await draftFor(db, tenant, place, id, true);
      if (existing.version !== version)
        throw new HttpError(412, 'draft_changed', 'The draft changed; reload it before saving');
      if (existing.state !== 'draft')
        throw new HttpError(
          409,
          'draft_locked',
          'Create a new draft to change queued or published content',
        );
      const r = (
        await db.query(
          'UPDATE merchant_drafts SET profile=$2,rights_confirmed=$3,version=version+1,updated_at=now(),preview_digest=NULL,preview_expires_at=NULL WHERE id=$1 RETURNING *',
          [id, JSON.stringify(body.profile), body.rightsConfirmed],
        )
      ).rows[0];
      await audit(db, user.id, tenant, 'draft.edited', id, { version: r.version });
      return draftDTO(r);
    });
    c.header('ETag', `"${draft.version}"`);
    return c.json({ draft });
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/drafts/:draftID/preview', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      id = uuid.parse(c.req.param('draftID'));
    const preview = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const owned = await ownedPlace(db, tenant, place),
        draft = await draftFor(db, tenant, place, id);
      const snapshot = snapshotFromRows(owned.place, draft),
        html = renderPage(snapshot),
        digest = snapshotDigest(snapshot, html),
        expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const blockingIssues: string[] = [];
      if (!draft.rights_confirmed)
        blockingIssues.push('Confirm you have permission to publish these facts.');
      if (draft.base_place_revision !== owned.place.revision)
        blockingIssues.push('The public place changed. Start a new draft.');
      if (draft.state !== 'draft')
        blockingIssues.push('This draft has already been queued or published.');
      await db.query(
        'UPDATE merchant_drafts SET preview_digest=$2,preview_expires_at=$3 WHERE id=$1',
        [id, digest, expiresAt],
      );
      return {
        draftID: id,
        draftVersion: draft.version,
        digest,
        html,
        publicURL: publicURL(snapshot),
        blockingIssues,
        expiresAt,
      };
    });
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    return c.json(preview);
  });
  app.post('/v1/tenants/:tenantID/places/:placeID/drafts/:draftID/publish', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      id = uuid.parse(c.req.param('draftID')),
      version = expectedVersion(c),
      body = approveBody.parse(await c.req.json());
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'publish');
      const owned = await ownedPlace(db, tenant, place);
      return idempotent(
        db,
        user.id,
        c.req.header('Idempotency-Key') ?? '',
        `publish:${tenant}:${id}`,
        { ...body, version },
        async () => {
          const draft = await draftFor(db, tenant, place, id, true);
          if (draft.version !== version)
            throw new HttpError(412, 'draft_changed', 'Review the updated draft before publishing');
          if (draft.state !== 'draft')
            throw new HttpError(
              409,
              'draft_locked',
              'This draft has already been queued or published',
            );
          if (!draft.rights_confirmed)
            throw new HttpError(
              409,
              'rights_required',
              'Permission to publish these facts is required',
            );
          if (owned.place.revision !== draft.base_place_revision)
            throw new HttpError(
              409,
              'place_changed',
              'The public place changed; create a fresh draft',
            );
          const previous =
            (await db.query('SELECT snapshot FROM public_pages WHERE place_id=$1', [place])).rows[0]
              ?.snapshot?.profile ?? {};
          await requirePublicationCapability(db, tenant, place, previous, draft.profile);
          const snapshot = snapshotFromRows(owned.place, draft),
            html = renderPage(snapshot),
            digest = snapshotDigest(snapshot, html);
          if (
            digest !== body.previewDigest ||
            draft.preview_digest !== digest ||
            !draft.preview_expires_at ||
            new Date(draft.preview_expires_at).getTime() < Date.now()
          )
            throw new HttpError(
              409,
              'preview_expired',
              'Open a fresh preview and approve that exact output',
            );
          const publication = (
            await db.query(
              'INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
              [
                tenant,
                place,
                id,
                version,
                draft.base_place_revision + 1,
                JSON.stringify(snapshot),
                digest,
                html,
                canonicalPath(snapshot),
                user.id,
              ],
            )
          ).rows[0];
          await db.query('INSERT INTO publication_jobs(publication_id) VALUES($1)', [
            publication.id,
          ]);
          await db.query("UPDATE merchant_drafts SET state='queued' WHERE id=$1", [id]);
          await audit(db, user.id, tenant, 'publication.queued', publication.id, {
            draftID: id,
            digest,
          });
          return { publication: publicationDTO(publication) };
        },
      );
    });
    return c.json(result, 202);
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/publications/:publicationID', async (c) => {
    const user = await requireUser(c),
      { tenant, place } = params(c),
      id = uuid.parse(c.req.param('publicationID'));
    const publication = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const r = (
        await db.query('SELECT * FROM publications WHERE id=$1 AND tenant_id=$2 AND place_id=$3', [
          id,
          tenant,
          place,
        ])
      ).rows[0];
      if (!r) throw new HttpError(404, 'publication_not_found', 'Publication not found');
      return publicationDTO(r);
    });
    return c.json({ publication });
  });
  // Only the isolated ops service can execute these routes; no native app receives its token.
  app.get('/v1/ops/claims', async (c) => {
    await requireOps(c);
    const state = z
      .enum(['submitted', 'approved', 'rejected', 'revoked', 'disputed', 'all'])
      .parse(c.req.query('state') || 'submitted');
    const offset = z.coerce.number().int().min(0).max(10000).parse(c.req.query('offset') || 0);
    const rows = (
      await workerPool.query(
        `SELECT c.id,c.tenant_id AS "tenantID",c.place_id AS "placeID",c.submitted_by AS "submittedBy",
          c.evidence,c.state,c.submitted_at AS "submittedAt",c.reviewed_at AS "reviewedAt",
          c.review_reason AS "reviewReason",p.name AS "placeName",p.address,p.city,
          p.state AS "placeState",t.name AS "workspaceName"
         FROM merchant_claims c JOIN places p ON p.id=c.place_id JOIN tenants t ON t.id=c.tenant_id
         WHERE ($1='all' OR c.state=$1) ORDER BY c.submitted_at DESC,c.id DESC LIMIT 51 OFFSET $2`,
        [state, offset],
      )
    ).rows;
    const ids = [...new Set(rows.map((r) => r.submittedBy))];
    const people = ids.length
      ? (await authPool.query('SELECT id,name,email FROM "user" WHERE id=ANY($1::text[])', [ids]))
          .rows
      : [];
    const identities = new Map(people.map((person) => [person.id, person]));
    return c.json({
      claims: rows.slice(0, 50).map((row) => ({
        ...row,
        submitter: identities.get(row.submittedBy) ?? null,
      })),
      hasMore: rows.length > 50,
      nextOffset: rows.length > 50 ? offset + 50 : null,
    });
  });
  app.post('/v1/ops/claims/:claimID/review', async (c) => {
    await requireOps(c);
    const id = uuid.parse(c.req.param('claimID')),
      body = z
        .object({
          decision: z.enum(['approved', 'rejected', 'revoked', 'disputed']),
          reason: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const reference = (await db.query('SELECT place_id FROM merchant_claims WHERE id=$1', [id]))
        .rows[0];
      if (!reference) throw new HttpError(404, 'claim_not_found', 'Claim not found');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `claim-place:${reference.place_id}`,
      ]);
      const claim = (await db.query('SELECT * FROM merchant_claims WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!claim) throw new HttpError(404, 'claim_not_found', 'Claim not found');
      if (['approved', 'rejected'].includes(body.decision) && claim.state !== 'submitted')
        throw new HttpError(409, 'claim_already_reviewed', 'This claim has already been reviewed');
      if (
        body.decision === 'approved' &&
        process.env.NODE_ENV === 'production' &&
        claim.evidence?.description?.startsWith('DEMO SUBMISSION ONLY')
      )
        throw new HttpError(422, 'demo_claim', 'A demo submission cannot be approved for production');
      if (
        body.decision === 'approved' &&
        (
          await db.query(
            "SELECT id FROM merchant_claims WHERE place_id=$1 AND state='approved' AND id<>$2",
            [claim.place_id, id],
          )
        ).rows[0]
      )
        throw new HttpError(
          409,
          'already_claimed',
          'Another claim is approved; resolve the dispute first',
        );
      const r = (
        await db.query(
          'UPDATE merchant_claims SET state=$2,reviewed_at=now(),review_reason=$3 WHERE id=$1 RETURNING *',
          [id, body.decision, body.reason],
        )
      ).rows[0];
      if (body.decision !== 'approved') {
        await db.query(
          'UPDATE public_pages SET withdrawn_at=now() WHERE publication_id IN(SELECT id FROM publications WHERE tenant_id=$1 AND place_id=$2)',
          [claim.tenant_id, claim.place_id],
        );
        await db.query(
          "UPDATE publications SET status='withdrawn',error='claim_not_approved' WHERE tenant_id=$1 AND place_id=$2 AND status IN('queued','live')",
          [claim.tenant_id, claim.place_id],
        );
        await db.query(
          "UPDATE publication_destinations SET state='revoked',version=version+1,disconnected_at=now(),last_error='claim_not_approved' WHERE tenant_id=$1 AND place_id=$2",
          [claim.tenant_id, claim.place_id],
        );
        await db.query(
          "UPDATE target_deliveries SET state='revoked',error_code='claim_not_approved' WHERE tenant_id=$1 AND place_id=$2 AND state NOT IN('verified_live','applied_unverified')",
          [claim.tenant_id, claim.place_id],
        );
        await db.query('UPDATE hosted_sites SET withdrawn_at=now() WHERE place_id=$1', [
          claim.place_id,
        ]);
        await db.query(
          "UPDATE places SET state='withdrawn',updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM public_pages pp WHERE pp.place_id=$1 AND pp.withdrawn_at IS NOT NULL)",
          [claim.place_id],
        );
      }
      await audit(db, c.req.header('X-Review-Actor') || 'ops', claim.tenant_id, 'claim.reviewed', id, {
        decision: body.decision,
        reason: body.reason,
      });
      await db.query('COMMIT');
      return c.json({ claim: claimDTO(r) });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/ops/publications/:publicationID/withdraw', async (c) => {
    await requireOps(c);
    const id = uuid.parse(c.req.param('publicationID')),
      body = z
        .object({ reason: z.string().trim().min(10).max(1000) })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const reference = (await db.query('SELECT place_id FROM publications WHERE id=$1', [id]))
        .rows[0];
      if (!reference) throw new HttpError(404, 'publication_not_found', 'Publication not found');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `claim-place:${reference.place_id}`,
      ]);
      const r = (
        await db.query(
          "UPDATE publications SET status='withdrawn',error='operator_withdrawal' WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, 'publication_not_found', 'Publication not found');
      const current = await db.query(
        'UPDATE public_pages SET withdrawn_at=now() WHERE publication_id=$1 RETURNING place_id',
        [id],
      );
      if (current.rowCount) {
        await db.query("UPDATE places SET state='withdrawn',updated_at=now() WHERE id=$1", [
          r.place_id,
        ]);
        await db.query('UPDATE hosted_sites SET withdrawn_at=now() WHERE place_id=$1', [
          r.place_id,
        ]);
        await db.query(
          "UPDATE target_deliveries SET state='revoked',error_code='operator_withdrawal' WHERE publication_id=$1",
          [id],
        );
      }
      await audit(db, 'ops', r.tenant_id, 'publication.withdrawn', id, { reason: body.reason });
      await db.query('COMMIT');
      return c.json({ publication: publicationDTO(r) });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
}
