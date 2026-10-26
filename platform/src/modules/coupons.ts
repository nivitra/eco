import type { Context, Hono } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { audit, HttpError, idempotent, query, withActor } from '../db.js';
import { requirePlacePermission } from './business-auth.js';
import { couponInputSchema, couponScopeIssue, eligibleOfferings, type CouponInput, type CouponOffering } from './coupon-contract.js';
import { escapeHTML } from './publishing.js';

const uuid = z.uuid();
const placeSchema = z.string().min(1).max(160);
const versionSchema = z.number().int().positive();
const updateSchema = couponInputSchema.safeExtend({ version: versionSchema });
const toggleSchema = z.object({ version: versionSchema, enabled: z.boolean() }).strict();
const archiveSchema = z.object({ version: versionSchema }).strict();

function location(c: Context) {
  return { tenant: uuid.parse(c.req.param('tenantID')), place: placeSchema.parse(c.req.param('placeID')) };
}
async function currentClaim(db: PoolClient, tenant: string, place: string) {
  const row = (await db.query(
    "SELECT id,state FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 ORDER BY (state='approved') DESC,(state='submitted') DESC,submitted_at DESC LIMIT 1",
    [tenant, place],
  )).rows[0];
  if (!row || !['submitted', 'approved'].includes(row.state))
    throw new HttpError(403, 'current_claim_required', 'A submitted or approved ownership claim is required.');
  return row as { id: string; state: string };
}
async function savedOfferings(db: PoolClient, tenant: string, place: string, claimID: string): Promise<CouponOffering[]> {
  const draft = (await db.query(
    'SELECT profile FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 AND claim_id=$3 ORDER BY updated_at DESC LIMIT 1',
    [tenant, place, claimID],
  )).rows[0];
  if (Array.isArray(draft?.profile?.offerings)) return draft.profile.offerings;
  const page = (await db.query(
    'SELECT page.snapshot FROM public_pages page JOIN publications publication ON publication.id=page.publication_id WHERE page.place_id=$1 AND publication.tenant_id=$2 AND page.withdrawn_at IS NULL',
    [place, tenant],
  )).rows[0];
  return Array.isArray(page?.snapshot?.profile?.offerings) ? page.snapshot.profile.offerings : [];
}
function validateScope(input: CouponInput, offerings: CouponOffering[]) {
  const issue = couponScopeIssue(input, offerings);
  if (issue) throw new HttpError(422, 'coupon_scope_invalid', issue);
}
function dto(row: any) {
  const dateOnly = (value: unknown) => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    terms: row.terms,
    discountKind: row.discount_kind,
    discountValue: row.discount_value,
    scope: row.scope,
    offeringIDs: row.offering_ids,
    startsOn: dateOnly(row.starts_on),
    endsOn: dateOnly(row.ends_on),
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function databaseError(error: unknown): never {
  if ((error as { code?: string })?.code === '23505')
    throw new HttpError(409, 'coupon_code_taken', 'This coupon code is already used for this business.');
  throw error;
}
function publicCouponURL(place: string) {
  return config.publicURL + '/places/' + encodeURIComponent(place) + '/coupons';
}

export function registerCoupons(app: Hono) {
  app.get('/v1/tenants/:tenantID/places/:placeID/coupons', async (c) => {
    const user = await requireUser(c);
    const { tenant, place } = location(c);
    const data = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const claim = await currentClaim(db, tenant, place);
      const coupons = (await db.query(
        'SELECT * FROM merchant_coupons WHERE tenant_id=$1 AND place_id=$2 AND claim_id=$3 AND archived_at IS NULL ORDER BY created_at DESC',
        [tenant, place, claim.id],
      )).rows;
      const publicRows = (await db.query('SELECT * FROM public_active_coupons($1)', [place])).rows;
      const visible = new Set(publicRows.filter((row) =>
        eligibleOfferings(row.scope, row.offering_ids, row.snapshot?.profile?.offerings ?? []).length > 0,
      ).map((row) => row.id));
      const page = (await db.query(
        'SELECT 1 FROM public_pages page JOIN publications publication ON publication.id=page.publication_id WHERE page.place_id=$1 AND publication.tenant_id=$2 AND page.withdrawn_at IS NULL',
        [place, tenant],
      )).rows[0];
      return {
        claimState: claim.state,
        publicURL: page ? publicCouponURL(place) : null,
        coupons: coupons.map((row) => ({ ...dto(row), publiclyVisible: visible.has(row.id) })),
      };
    });
    return c.json(data);
  });

  app.post('/v1/tenants/:tenantID/places/:placeID/coupons', async (c) => {
    const user = await requireUser(c);
    const { tenant, place } = location(c);
    const input = couponInputSchema.parse(await c.req.json());
    try {
      const result = await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'edit');
        const claim = await currentClaim(db, tenant, place);
        validateScope(input, await savedOfferings(db, tenant, place, claim.id));
        return idempotent(db, user.id, c.req.header('Idempotency-Key') ?? '', `coupon-create:${tenant}:${place}`, input, async () => {
          const row = (await db.query(
            `INSERT INTO merchant_coupons(tenant_id,place_id,claim_id,code,title,description,terms,discount_kind,discount_value,scope,offering_ids,starts_on,ends_on,enabled,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [tenant, place, claim.id, input.code, input.title, input.description, input.terms,
              input.discountKind, input.discountValue, input.scope, input.offeringIDs,
              input.startsOn, input.endsOn, input.enabled, user.id],
          )).rows[0];
          await audit(db, user.id, tenant, 'coupon.created', row.id, { placeID: place, enabled: row.enabled });
          return { coupon: dto(row) };
        });
      });
      return c.json(result, 201);
    } catch (error) { databaseError(error); }
  });

  app.put('/v1/tenants/:tenantID/places/:placeID/coupons/:couponID', async (c) => {
    const user = await requireUser(c);
    const { tenant, place } = location(c);
    const id = uuid.parse(c.req.param('couponID'));
    const input = updateSchema.parse(await c.req.json());
    try {
      const result = await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'edit');
        const claim = await currentClaim(db, tenant, place);
        const before = (await db.query(
          'SELECT * FROM merchant_coupons WHERE id=$1 AND tenant_id=$2 AND place_id=$3 AND claim_id=$4 AND archived_at IS NULL FOR UPDATE',
          [id, tenant, place, claim.id],
        )).rows[0];
        if (!before) throw new HttpError(404, 'coupon_not_found', 'Coupon not found.');
        if (before.version !== input.version) throw new HttpError(409, 'coupon_changed', 'This coupon changed. Reload and try again.');
        validateScope(input, await savedOfferings(db, tenant, place, claim.id));
        const row = (await db.query(
          `UPDATE merchant_coupons SET code=$2,title=$3,description=$4,terms=$5,discount_kind=$6,discount_value=$7,scope=$8,offering_ids=$9,starts_on=$10,ends_on=$11,enabled=$12,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, input.code, input.title, input.description, input.terms, input.discountKind,
            input.discountValue, input.scope, input.offeringIDs, input.startsOn, input.endsOn, input.enabled],
        )).rows[0];
        await audit(db, user.id, tenant, 'coupon.updated', id, { placeID: place, enabled: row.enabled });
        return { coupon: dto(row) };
      });
      return c.json(result);
    } catch (error) { databaseError(error); }
  });

  app.patch('/v1/tenants/:tenantID/places/:placeID/coupons/:couponID/toggle', async (c) => {
    const user = await requireUser(c);
    const { tenant, place } = location(c);
    const id = uuid.parse(c.req.param('couponID'));
    const input = toggleSchema.parse(await c.req.json());
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'edit');
      const claim = await currentClaim(db, tenant, place);
      const before = (await db.query(
        'SELECT * FROM merchant_coupons WHERE id=$1 AND tenant_id=$2 AND place_id=$3 AND claim_id=$4 AND archived_at IS NULL FOR UPDATE',
        [id, tenant, place, claim.id],
      )).rows[0];
      if (!before) throw new HttpError(404, 'coupon_not_found', 'Coupon not found.');
      if (before.version !== input.version) throw new HttpError(409, 'coupon_changed', 'This coupon changed. Reload and try again.');
      if (input.enabled) {
        const candidate: CouponInput = {
          code: before.code, title: before.title, description: before.description, terms: before.terms,
          discountKind: before.discount_kind, discountValue: before.discount_value,
          scope: before.scope, offeringIDs: before.offering_ids,
          startsOn: before.starts_on, endsOn: before.ends_on, enabled: true,
        };
        validateScope(candidate, await savedOfferings(db, tenant, place, claim.id));
      }
      const row = (await db.query(
        'UPDATE merchant_coupons SET enabled=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
        [id, input.enabled],
      )).rows[0];
      await audit(db, user.id, tenant, input.enabled ? 'coupon.enabled' : 'coupon.disabled', id, { placeID: place });
      return { coupon: dto(row) };
    });
    return c.json(result);
  });

  app.delete('/v1/tenants/:tenantID/places/:placeID/coupons/:couponID', async (c) => {
    const user = await requireUser(c);
    const { tenant, place } = location(c);
    const id = uuid.parse(c.req.param('couponID'));
    const input = archiveSchema.parse(await c.req.json());
    const result = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'edit');
      const claim = await currentClaim(db, tenant, place);
      const before = (await db.query(
        'SELECT * FROM merchant_coupons WHERE id=$1 AND tenant_id=$2 AND place_id=$3 AND claim_id=$4 AND archived_at IS NULL FOR UPDATE',
        [id, tenant, place, claim.id],
      )).rows[0];
      if (!before) throw new HttpError(404, 'coupon_not_found', 'Coupon not found.');
      if (before.version !== input.version) throw new HttpError(409, 'coupon_changed', 'This coupon changed. Reload and try again.');
      await db.query('UPDATE merchant_coupons SET enabled=false,archived_at=now(),version=version+1,updated_at=now() WHERE id=$1', [id]);
      await audit(db, user.id, tenant, 'coupon.archived', id, { placeID: place });
      return { archived: true };
    });
    return c.json(result);
  });

  app.get('/places/:placeID/coupons', async (c) => {
    const place = placeSchema.parse(c.req.param('placeID'));
    const page = (await query(
      'SELECT canonical_path,snapshot FROM public_pages WHERE place_id=$1 AND withdrawn_at IS NULL',
      [place],
    )).rows[0];
    if (!page) return c.notFound();
    const offerings: CouponOffering[] = page.snapshot?.profile?.offerings ?? [];
    const rows = (await query('SELECT * FROM public_active_coupons($1)', [place])).rows;
    const coupons = rows.map((row) => ({ ...row, eligible: eligibleOfferings(row.scope, row.offering_ids, offerings) }))
      .filter((row) => row.eligible.length > 0);
    const name = escapeHTML(page.snapshot.profile.name);
    const businessPath = escapeHTML(page.canonical_path);
    const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    const cards = coupons.map((coupon) => {
      const discount = coupon.discount_kind === 'percent' ? `${coupon.discount_value}% off` : `${money.format(coupon.discount_value / 100)} off`;
      const items = coupon.eligible.map((item: CouponOffering) => `<li>${escapeHTML(item.name)}</li>`).join('');
      const validity = coupon.ends_on ? `<p class="meta">Valid through ${escapeHTML(coupon.ends_on instanceof Date ? coupon.ends_on.toISOString().slice(0, 10) : String(coupon.ends_on).slice(0, 10))} (India time)</p>` : '';
      return `<article><span class="discount">${escapeHTML(discount)}</span><h2>${escapeHTML(coupon.title)}</h2>${coupon.description ? `<p>${escapeHTML(coupon.description)}</p>` : ''}<p class="code-label">Use code</p><strong class="code">${escapeHTML(coupon.code)}</strong><p class="meta">Applies to:</p><ul>${items}</ul>${validity}${coupon.terms ? `<p class="terms">${escapeHTML(coupon.terms)}</p>` : ''}</article>`;
    }).join('');
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, follow');
    return c.html(`<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Current offers — ${name} | Kulture</title><style>*{box-sizing:border-box}body{margin:0;background:#081511;color:#f4f2e7;font:16px/1.6 system-ui}main{max-width:920px;margin:auto;padding:clamp(28px,6vw,64px) 22px 80px}a{color:#ffa56a}h1{font-size:clamp(38px,6vw,64px);line-height:1.05;letter-spacing:-.05em;margin:30px 0 12px}h2{font-size:27px;margin:13px 0}p,.meta{color:#a6b9ab}article{border:1px solid #355542;border-radius:20px;background:linear-gradient(140deg,#1a392b,#10241c);padding:clamp(24px,4vw,38px);margin:22px 0}.discount{color:#ffa56a;font-size:32px;font-weight:700}.code-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;margin:22px 0 6px}.code{display:inline-block;border:1px dashed #ffa56a;border-radius:10px;padding:11px 19px;font-size:23px;letter-spacing:.08em}li{margin:3px 0}.terms{border-top:1px solid #355542;padding-top:14px;font-size:13px}footer{margin-top:40px;border-top:1px solid #355542;padding-top:20px;font-size:13px;color:#a6b9ab}</style></head><body><main><nav><a href="${businessPath}">← ${name}</a></nav><h1>Current offers</h1><p>Coupons supplied by ${name}. Confirm eligibility with the business before purchase.</p>${cards || '<p>No active coupons right now. Check back later.</p>'}<footer>Present the code to the business. Kulture does not process coupon redemption or payment.</footer></main></body></html>`);
  });
}
