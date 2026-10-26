import type { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUser, requireOps, authPool } from '../auth.js';
import {
  withActor,
  requireRole,
  HttpError,
  idempotent,
  audit,
  consumeQuota,
  workerPool,
  pool,
} from '../db.js';
import { config } from '../config.js';
import { businessTypes, merchantProfileSchema, discoveryCategoryFor } from './business-profile.js';
import { requirePlacePermission } from './business-auth.js';
import { locationEntitlement } from './entitlements.js';

const uuid = z.uuid(),
  placeID = z.string().regex(/^[A-Za-z0-9-]{1,160}$/),
  key = (c: any) => c.req.header('Idempotency-Key') || '';
const membershipBody = z
  .object({
    role: z.enum(['manager', 'editor', 'viewer']),
    scopeMode: z.enum(['all', 'selected']),
    placeIDs: z
      .array(placeID)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each location once'),
    canPublish: z.boolean().default(false),
    canManageDestinations: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.role === 'manager' || (!v.canPublish && !v.canManageDestinations),
    'Only managers may receive explicit publication or destination permissions',
  )
  .refine((v) => v.scopeMode === 'all' || v.placeIDs.length > 0, 'Choose at least one location');
const requestSchema = z
  .object({
    tenantID: uuid.nullable().optional(),
    placeID: placeID.nullable().optional(),
    kind: z.enum(['support', 'correction', 'deletion', 'ownership_transfer', 'refund', 'export']),
    message: z.string().trim().min(10).max(4000),
    relatedID: z.string().max(200).optional(),
  })
  .strict();
const invitationDTO = (r: any) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  scopeMode: r.scope_mode,
  placeIDs: r.place_ids,
  canPublish: r.can_publish,
  canManageDestinations: r.can_manage_destinations,
  expiresAt: r.expires_at,
  acceptedAt: r.accepted_at,
  revokedAt: r.revoked_at,
});
async function validateScope(db: any, tenant: string, ids: string[]) {
  for (const id of ids) {
    if (
      !(
        await db.query('SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2', [
          tenant,
          id,
        ])
      ).rowCount
    )
      throw new HttpError(
        422,
        'invalid_location_scope',
        'Choose locations belonging to this workspace',
      );
  }
}

export function registerLocations(app: Hono) {
  app.get('/v1/business-taxonomy', (c) =>
    c.json({ version: 1, country: 'IN', types: businessTypes, timezones: ['Asia/Kolkata'] }),
  );
  app.get('/v1/locations/search', async (c) => {
    const q = z.string().trim().min(2).max(150).parse(c.req.query('q')),
      city = z.string().max(120).optional().parse(c.req.query('city')),
      offset = z.coerce.number().int().min(0).max(10000).parse(c.req.query('offset') ?? 0),
      escaped = q.replace(/[%_\\]/g, '\\$&');
    const rows = (
      await pool.query(
        `SELECT id,name,category,city,neighborhood,address,revision,business_type AS "businessType",consumer_eligible AS "consumerEligible"
         FROM places
         WHERE state IN('research','published','closed')
           AND (name ILIKE $1 OR neighborhood ILIKE $1 OR address ILIKE $1
             OR EXISTS(SELECT 1 FROM public_pages pg WHERE pg.place_id=places.id
               AND pg.withdrawn_at IS NULL AND pg.snapshot->'profile'->>'phone' ILIKE $1))
           AND ($2::text IS NULL OR city ILIKE $2)
         ORDER BY CASE
           WHEN lower(name)=lower($3) THEN 0
           WHEN name ILIKE $4 THEN 1
           WHEN name ILIKE $1 THEN 2
           WHEN neighborhood ILIKE $1 THEN 3
           ELSE 4 END, lower(name), id
         LIMIT 31 OFFSET $5`,
        ['%' + escaped + '%', city || null, q, escaped + '%', offset],
      )
    ).rows;
    return c.json({
      places: rows.slice(0, 30),
      limit: 30,
      hasMore: rows.length > 30,
      nextOffset: rows.length > 30 ? offset + 30 : null,
    });
  });
  app.post('/v1/tenants/:tenantID/locations', async (c) => {
    const user = await requireUser(c),
      tenant = uuid.parse(c.req.param('tenantID'));
    const body = z
      .object({
        profile: merchantProfileSchema,
        evidence: z.object({
          description: z.string().trim().min(30).max(4000),
          url: z
            .url()
            .max(1000)
            .refine((value) => ['https:', 'http:'].includes(new URL(value).protocol))
            .optional(),
        }),
        duplicateAcknowledged: z.boolean().default(false),
      })
      .strict()
      .parse(await c.req.json());
    if (!body.profile.businessType || !body.profile.locality)
      throw new HttpError(
        422,
        'location_details_required',
        'New locations require a business type and structured Indian address',
      );
    await consumeQuota(`new-location:${user.id}`, 20, 86400);
    const result = await withActor(user.id, async (db) => {
      await requireRole(db, tenant, ['owner']);
      return idempotent(db, user.id, key(c), `new-location:${tenant}`, body, async () => {
        const p = body.profile,
          l = p.locality!;
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `new-location:${l.city.toLowerCase()}:${p.name.toLowerCase()}`,
        ]);
        const duplicates = (
          await db.query(
            "SELECT id,name,address FROM places WHERE lower(city)=lower($1) AND lower(name)=lower($2) AND state IN('research','published','closed','pending')",
            [l.city, p.name],
          )
        ).rows;
        if (duplicates.length && !body.duplicateAcknowledged)
          throw new HttpError(
            409,
            'possible_duplicate',
            'A location with this name already exists in this city. Search and claim it, or explicitly confirm this is a different physical branch',
          );
        const id = 'loc-' + randomUUID(),
          slug =
            (p.name
              .normalize('NFKD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 130) || 'business') +
            '-' +
            id.slice(-12);
        await db.query(
          `INSERT INTO places(id,slug,name,category,city,neighborhood,address,summary,tags,researched_at,search_query,state,business_type,consumer_eligible,locality,submitted_by,submitting_tenant_id,catalog_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,'pending',$11,$12,$13,$14,$15,$16)`,
          [
            id,
            slug,
            p.name,
            p.category,
            l.city,
            p.neighborhood,
            p.address,
            p.summary,
            JSON.stringify(p.tags),
            `${p.name} ${p.address} ${l.city}`,
            p.businessType,
            !!discoveryCategoryFor(p.businessType!),
            JSON.stringify(l),
            user.id,
            tenant,
            JSON.stringify({ merchantSubmitted: true, factVerification: 'unverified' }),
          ],
        );
        const claim = (
          await db.query(
            'INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,$3,$4) RETURNING id,state,submitted_at',
            [
              tenant,
              id,
              user.id,
              JSON.stringify({
                ...body.evidence,
                duplicateAcknowledged: body.duplicateAcknowledged,
                possibleDuplicateIDs: duplicates.map((d) => d.id),
              }),
            ],
          )
        ).rows[0];
        const draft = (
          await db.query(
            'INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,rights_confirmed,created_by) VALUES($1,$2,$3,1,$4,false,$5) RETURNING id,version',
            [tenant, id, claim.id, JSON.stringify(p), user.id],
          )
        ).rows[0];
        await audit(db, user.id, tenant, 'location.submitted', id, { claimID: claim.id });
        return {
          place: {
            id,
            slug,
            name: p.name,
            city: l.city,
            revision: 1,
            state: 'pending',
            consumerEligible: !!discoveryCategoryFor(p.businessType!),
          },
          claim: { id: claim.id, state: claim.state, submittedAt: claim.submitted_at },
          draft: { id: draft.id, version: draft.version },
        };
      });
    });
    return c.json(result, 202);
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/entitlement', async (c) => {
    const u = await requireUser(c),
      tenant = uuid.parse(c.req.param('tenantID')),
      pid = placeID.parse(c.req.param('placeID'));
    return c.json(
      await withActor(u.id, async (db) => {
        await requirePlacePermission(db, tenant, pid, 'view');
        const capabilities: Record<string, unknown> = {};
        for (const capability of [
          'publish',
          'adapter_sync',
          'map_publish',
          'essential_correction',
          'export',
        ] as const)
          capabilities[capability] = await locationEntitlement(db, {
            tenantID: tenant,
            placeID: pid,
            capability,
          });
        return {
          placeID: pid,
          priceMinor: 29900,
          currency: 'INR',
          interval: 'monthly',
          termsVersion: 'location-plan-v1',
          capabilities,
        };
      }),
    );
  });
  app.post('/v1/ops/pilot-grants', async (c) => {
    requireOps(c);
    const b = z
      .object({
        tenantID: uuid,
        placeID,
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    const start = new Date(b.startsAt),
      end = new Date(b.endsAt);
    if (end <= start || end.getTime() - start.getTime() > 90 * 86400000)
      throw new HttpError(
        422,
        'invalid_grant_period',
        'Pilot grants must be explicitly bounded to at most 90 days',
      );
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
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
          'approved_claim_required',
          'Approve ownership before issuing a pilot grant',
        );
      const r = (
        await db.query(
          "INSERT INTO service_grants(tenant_id,place_id,starts_at,ends_at,reason,issued_by) VALUES($1,$2,$3,$4,$5,'ops') RETURNING id,starts_at,ends_at",
          [b.tenantID, b.placeID, start, end, b.reason],
        )
      ).rows[0];
      await audit(db, 'ops', b.tenantID, 'pilot.granted', r.id, b);
      await db.query('COMMIT');
      return c.json({ grant: r }, 201);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/ops/pilot-grants/:id/revoke', async (c) => {
    requireOps(c);
    const id = uuid.parse(c.req.param('id'));
    const r = await workerPool.query(
      'UPDATE service_grants SET revoked_at=now() WHERE id=$1 RETURNING id',
      [id],
    );
    if (!r.rowCount) throw new HttpError(404, 'grant_not_found', 'Grant not found');
    return c.json({ revoked: true });
  });

  app.get('/v1/tenants/:tenantID/members', async (c) => {
    const u = await requireUser(c),
      tid = uuid.parse(c.req.param('tenantID'));
    const data = await withActor(u.id, async (db) => {
      await requireRole(db, tid, ['owner']);
      const members = (
        await db.query(
          `SELECT m.user_id AS "userID",m.role,m.state,m.scope_mode AS "scopeMode",m.can_publish AS "canPublish",m.can_manage_destinations AS "canManageDestinations",coalesce((SELECT jsonb_agg(s.place_id) FROM membership_places s WHERE s.tenant_id=m.tenant_id AND s.user_id=m.user_id),'[]'::jsonb) AS "placeIDs" FROM memberships m WHERE m.tenant_id=$1 ORDER BY (m.role='owner') DESC,m.user_id`,
          [tid],
        )
      ).rows;
      return {
        limit: 2,
        members,
        invitations: (
          await db.query(
            'SELECT * FROM team_invitations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',
            [tid],
          )
        ).rows.map(invitationDTO),
      };
    });
    // Resolve only identities already authorized by the owner-scoped membership query.
    const identities = (
      await authPool.query('SELECT id,name,email FROM "user" WHERE id=ANY($1::text[])', [
        data.members.map((m) => m.userID),
      ])
    ).rows;
    return c.json({
      ...data,
      members: data.members.map((m) => {
        const identity = identities.find((i) => i.id === m.userID);
        return { ...m, name: identity?.name ?? null, email: identity?.email ?? null };
      }),
    });
  });
  app.post('/v1/tenants/:tenantID/invitations', async (c) => {
    const u = await requireUser(c),
      tid = uuid.parse(c.req.param('tenantID')),
      b = z
        .object({ email: z.email().max(254), permissions: membershipBody })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        return idempotent(db, u.id, key(c), `invite:${tid}`, b, async () => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`team:${tid}`]);
          await validateScope(db, tid, b.permissions.placeIDs);
          const total = Number(
            (
              await db.query(
                "SELECT (SELECT count(*) FROM memberships WHERE tenant_id=$1 AND state='active' AND role<>'owner')+(SELECT count(*) FROM team_invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()) AS n",
                [tid],
              )
            ).rows[0].n,
          );
          if (total >= 2)
            throw new HttpError(
              409,
              'team_limit',
              'The location plan includes an owner and two invited team members; revoke an unused invitation or member first',
            );
          const token = randomBytes(32).toString('base64url'),
            hash = createHash('sha256').update(token).digest('hex'),
            p = b.permissions;
          const r = (
            await db.query(
              "INSERT INTO team_invitations(tenant_id,email,token_hash,role,scope_mode,place_ids,can_publish,can_manage_destinations,created_by,expires_at) VALUES($1,lower($2),$3,$4,$5,$6,$7,$8,$9,now()+interval '7 days') RETURNING *",
              [
                tid,
                b.email,
                hash,
                p.role,
                p.scopeMode,
                p.placeIDs,
                p.canPublish,
                p.canManageDestinations,
                u.id,
              ],
            )
          ).rows[0];
          await audit(db, u.id, tid, 'team.invited', r.id, { role: p.role });
          return {
            invitation: invitationDTO(r),
            acceptURL: config.publicURL + '/console/#invite=' + token,
            delivery: 'share_link',
          };
        });
      }),
      201,
    );
  });
  app.post('/v1/team/invitations/accept', async (c) => {
    const u = await requireUser(c),
      b = z
        .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(await c.req.json());
    if (!u.emailVerified)
      throw new HttpError(
        403,
        'verified_email_required',
        'Verify the invited email address before accepting workspace access',
      );
    return c.json(
      await withActor(u.id, async (db) => {
        const tid = (
          await db.query('SELECT accept_team_invitation($1,$2) AS id', [
            createHash('sha256').update(b.token).digest('hex'),
            u.email.toLowerCase(),
          ])
        ).rows[0].id;
        if (!tid)
          throw new HttpError(
            404,
            'invitation_unavailable',
            'Invitation is expired, used, revoked or belongs to another email address',
          );
        await audit(db, u.id, tid, 'team.invitation_accepted', u.id);
        return { tenantID: tid };
      }),
    );
  });
  app.delete('/v1/tenants/:tenantID/invitations/:id', async (c) => {
    const u = await requireUser(c),
      tid = uuid.parse(c.req.param('tenantID')),
      id = uuid.parse(c.req.param('id'));
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        const r = await db.query(
          'UPDATE team_invitations SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL RETURNING id',
          [id, tid],
        );
        if (!r.rowCount)
          throw new HttpError(404, 'invitation_not_found', 'Active invitation not found');
        await audit(db, u.id, tid, 'team.invitation_revoked', id);
        return { revoked: true };
      }),
    );
  });
  app.patch('/v1/tenants/:tenantID/members/:userID', async (c) => {
    const u = await requireUser(c),
      tid = uuid.parse(c.req.param('tenantID')),
      target = z.string().min(1).max(128).parse(c.req.param('userID')),
      b = z
        .object({ state: z.enum(['active', 'revoked']), permissions: membershipBody })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`team:${tid}`]);
        await validateScope(db, tid, b.permissions.placeIDs);
        const prior = (
          await db.query('SELECT role,state FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
            tid,
            target,
          ])
        ).rows[0];
        if (!prior || prior.role === 'owner')
          throw new HttpError(
            409,
            'member_unavailable',
            'Owners require a reviewed transfer; new members must accept an invitation',
          );
        if (
          b.state === 'active' &&
          prior.state !== 'active' &&
          Number(
            (
              await db.query(
                "SELECT (SELECT count(*) FROM memberships WHERE tenant_id=$1 AND state='active' AND role<>'owner')+(SELECT count(*) FROM team_invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()) AS n",
                [tid],
              )
            ).rows[0].n,
          ) >= 2
        )
          throw new HttpError(409, 'team_limit', 'Two team member limit reached');
        const p = b.permissions;
        await db.query(
          'UPDATE memberships SET role=$3,state=$4,scope_mode=$5,can_publish=$6,can_manage_destinations=$7 WHERE tenant_id=$1 AND user_id=$2',
          [tid, target, p.role, b.state, p.scopeMode, p.canPublish, p.canManageDestinations],
        );
        await db.query('DELETE FROM membership_places WHERE tenant_id=$1 AND user_id=$2', [
          tid,
          target,
        ]);
        for (const pid of p.placeIDs)
          await db.query('INSERT INTO membership_places VALUES($1,$2,$3)', [tid, target, pid]);
        await audit(db, u.id, tid, 'membership.changed', target, b);
        return { updated: true };
      }),
    );
  });

  app.get('/v1/tenants/:tenantID/places/:placeID/export', async (c) => {
    const u = await requireUser(c),
      tid = uuid.parse(c.req.param('tenantID')),
      pid = placeID.parse(c.req.param('placeID'));
    const data = await withActor(u.id, async (db) => {
      await requirePlacePermission(db, tid, pid, 'view');
      await requireRole(db, tid, ['owner', 'manager']);
      if (
        !(
          await db.query('SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2', [
            tid,
            pid,
          ])
        ).rowCount
      )
        throw new HttpError(404, 'place_not_found', 'Workspace location not found');
      const place = (
        await db.query(
          'SELECT id,name,slug,city,category,neighborhood,address,summary,tags,locality,business_type,revision FROM places WHERE id=$1',
          [pid],
        )
      ).rows[0];
      const drafts = (
        await db.query(
          'SELECT id,version,profile,state,rights_confirmed,created_at,updated_at FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at',
          [tid, pid],
        )
      ).rows;
      const publications = (
        await db.query(
          'SELECT id,revision,snapshot,html,digest,status,created_at,published_at FROM publications WHERE tenant_id=$1 AND place_id=$2 ORDER BY created_at',
          [tid, pid],
        )
      ).rows;
      await audit(db, u.id, tid, 'location.exported', pid);
      return {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        place,
        drafts,
        publications,
        exclusions: [
          'Private ownership evidence and site credentials require a separate verified access request',
        ],
      };
    });
    c.header('Content-Disposition', `attachment; filename="kulture-${pid}.json"`);
    return c.json(data);
  });
  app.post('/v1/service-requests', async (c) => {
    const u = await requireUser(c),
      b = requestSchema.parse(await c.req.json());
    await consumeQuota(`support:${u.id}`, 20, 86400);
    return c.json(
      await withActor(u.id, async (db) =>
        idempotent(db, u.id, key(c), 'service-request', b, async () => {
          if (b.tenantID) {
            await requireRole(db, b.tenantID, ['owner', 'manager', 'editor', 'viewer']);
            if (b.placeID) {
              await requirePlacePermission(db, b.tenantID, b.placeID, 'view');
              if (
                !(
                  await db.query(
                    'SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2',
                    [b.tenantID, b.placeID],
                  )
                ).rowCount
              )
                throw new HttpError(404, 'place_not_found', 'Workspace location not found');
            }
          }
          if (b.kind === 'ownership_transfer' || b.kind === 'refund') {
            if (!b.tenantID)
              throw new HttpError(422, 'workspace_required', 'Choose the affected workspace');
            await requireRole(db, b.tenantID, ['owner']);
          }
          const r = (
            await db.query(
              'INSERT INTO service_requests(tenant_id,actor_id,place_id,kind,body) VALUES($1,$2,$3,$4,$5) RETURNING id,kind,state,created_at AS "createdAt"',
              [
                b.tenantID || null,
                u.id,
                b.placeID || null,
                b.kind,
                JSON.stringify({ message: b.message, relatedID: b.relatedID || null }),
              ],
            )
          ).rows[0];
          await audit(db, u.id, b.tenantID || null, 'service_request.created', r.id, {
            kind: b.kind,
          });
          return { request: r };
        }),
      ),
      202,
    );
  });
  app.get('/v1/service-requests', async (c) => {
    const u = await requireUser(c);
    return c.json(
      await withActor(u.id, async (db) => ({
        requests: (
          await db.query(
            'SELECT id,tenant_id AS "tenantID",place_id AS "placeID",kind,body,state,created_at AS "createdAt",updated_at AS "updatedAt",resolution FROM service_requests ORDER BY created_at DESC LIMIT 100',
          )
        ).rows,
      })),
    );
  });
  app.get('/v1/settings', async (c) => {
    const u = await requireUser(c);
    return c.json(
      await withActor(u.id, async (db) => {
        const r = (
          await db.query('SELECT body,revision FROM account_preferences WHERE user_id=$1', [u.id])
        ).rows[0];
        return {
          preferences: r?.body ?? { productUpdates: false, serviceNotifications: true },
          revision: r?.revision ?? 0,
        };
      }),
    );
  });
  app.put('/v1/settings', async (c) => {
    const u = await requireUser(c),
      b = z
        .object({ productUpdates: z.boolean(), serviceNotifications: z.boolean() })
        .strict()
        .parse(await c.req.json()),
      version = z.coerce.number().int().min(0).parse(c.req.header('If-Match'));
    return c.json(
      await withActor(u.id, async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `settings:${u.id}`,
        ]);
        const r = (
          await db.query('SELECT revision FROM account_preferences WHERE user_id=$1', [u.id])
        ).rows[0];
        if ((r?.revision ?? 0) !== version)
          throw new HttpError(
            409,
            'settings_changed',
            'Settings changed in another session; reload before saving',
          );
        const saved = (
          await db.query(
            'INSERT INTO account_preferences(user_id,body) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET body=EXCLUDED.body,revision=account_preferences.revision+1,updated_at=now() RETURNING body,revision',
            [u.id, JSON.stringify(b)],
          )
        ).rows[0];
        return { preferences: saved.body, revision: saved.revision };
      }),
    );
  });
  app.get('/v1/ops/service-requests', async (c) => {
    requireOps(c);
    return c.json({
      requests: (
        await workerPool.query(
          "SELECT id,tenant_id,actor_id,place_id,kind,body,state,created_at,resolution FROM service_requests WHERE state IN('open','in_review') ORDER BY created_at LIMIT 100",
        )
      ).rows,
    });
  });
  app.patch('/v1/ops/service-requests/:id', async (c) => {
    requireOps(c);
    const id = uuid.parse(c.req.param('id')),
      b = z
        .object({
          state: z.enum(['in_review', 'resolved', 'declined']),
          resolution: z.string().trim().min(10).max(4000),
        })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const r = (
        await db.query(
          'UPDATE service_requests SET state=$2,resolution=$3,updated_at=now() WHERE id=$1 RETURNING id,tenant_id,state',
          [id, b.state, b.resolution],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, 'request_not_found', 'Request not found');
      await audit(db, 'ops', r.tenant_id, 'service_request.updated', id, b);
      await db.query('COMMIT');
      return c.json({ request: r });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
}
