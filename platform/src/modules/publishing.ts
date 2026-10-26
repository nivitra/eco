import { createHash } from 'node:crypto';
import { merchantProfileSchema, type MerchantProfile, businessTypes } from './business-profile.js';
export { merchantProfileSchema, type MerchantProfile } from './business-profile.js';
import { requirePublicationCapability } from './entitlements.js';
import { requirePlacePermission } from './business-auth.js';
import { HttpError, canonical, workerPool } from '../db.js';
import { config } from '../config.js';
export interface PageSnapshot {
  schemaVersion: 1;
  placeID: string;
  slug: string;
  city: string;
  profile: MerchantProfile;
  sourceURLs: string[];
  ownerConfirmedAt: string;
  policyVersion: string;
}
export const PUBLICATION_POLICY = 'kulture-public-page-v1';
export function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function scriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
export function canonicalPath(
  snapshot: Pick<PageSnapshot, 'city' | 'slug'> & {
    profile?: MerchantProfile;
  },
): string {
  const city =
    snapshot.profile?.locality?.citySlug ??
    snapshot.city
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  if (!city)
    throw new HttpError(
      422,
      'invalid_locality',
      'A validated locality is required for publication',
    );
  if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(snapshot.slug))
    throw new HttpError(422, 'invalid_slug', 'This place needs an operator-reviewed public URL');
  return `/${city}/places/${snapshot.slug}`;
}
export function publicURL(
  snapshot: Pick<PageSnapshot, 'city' | 'slug'> & {
    profile?: MerchantProfile;
  },
): string {
  return config.publicURL + canonicalPath(snapshot);
}
export function renderPage(snapshot: PageSnapshot): string {
  const p = merchantProfileSchema.parse(snapshot.profile),
    e = escapeHTML,
    url = publicURL(snapshot);
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type':
      businessTypes.find((t) => t.id === p.businessType)?.schemaType ??
      (p.category === 'cafes'
        ? 'CafeOrCoffeeShop'
        : p.category === 'food'
          ? 'Restaurant'
          : 'LocalBusiness'),
    '@id': url + '#business',
    name: p.name,
    url,
    description: p.summary,
    address: {
      '@type': 'PostalAddress',
      streetAddress: p.address,
      addressLocality: snapshot.city,
      addressCountry: 'IN',
    },
  };
  if (p.phone) schema.telephone = p.phone;
  if (p.website) schema.sameAs = [p.website];
  // Free-form hours, provider points and unverified entrances cannot become structured claims.
  const sources = snapshot.sourceURLs
    .filter((v) => {
      try {
        const u = new URL(v);
        return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
      } catch {
        return false;
      }
    })
    .slice(0, 8)
    .map((v, i) => `<li><a rel="noopener noreferrer" href="${e(v)}">Source ${i + 1}</a></li>`)
    .join('');
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(p.name)} — ${e(p.neighborhood)} | Kulture</title><meta name="description" content="${e(p.summary.slice(0, 160))}"><link rel="canonical" href="${e(url)}"><meta property="og:title" content="${e(p.name)}"><meta property="og:description" content="${e(p.summary.slice(0, 200))}"><meta property="og:url" content="${e(url)}"><script type="application/ld+json">${scriptJSON(schema)}</script><style>body{margin:0;background:#081511;color:#f4f2e7;font:17px/1.65 system-ui}main{max-width:780px;margin:auto;padding:48px 24px}a{color:#ffa56a}h1{font:600 clamp(34px,6vw,56px)/1.1 system-ui;letter-spacing:-1.2px}h2{font-size:23px;margin-top:36px}nav,footer,.meta{font-size:14px;color:#a6b9ab}.tag{display:inline-block;border:1px solid #29483a;border-radius:20px;padding:4px 12px;margin:4px}address{font-style:normal}.notice{border-left:3px solid #ffa56a;padding-left:16px}footer{margin-top:48px;border-top:1px solid #29483a;padding-top:20px}</style></head><body><main><nav><a href="/${canonicalPath(snapshot).split('/')[1]}">Kulture / ${e(snapshot.city)}</a></nav><p class="meta">${e(p.category)} · ${e(p.neighborhood)}</p><h1>${e(p.name)}</h1>${p.status === 'permanently_closed' ? '<p class="notice">Permanently closed — owner supplied status.</p>' : p.status === 'temporarily_closed' ? '<p class="notice">Temporarily closed — owner supplied status.</p>' : ''}<p>${e(p.summary)}</p><address>${e(p.address)}</address><div>${p.tags.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</div>${p.phone ? `<p><a href="tel:${e(p.phone.replace(/[^+0-9]/g, ''))}">Call ${e(p.phone)}</a></p>` : ''}${p.website ? `<p><a href="${e(p.website)}" rel="noopener noreferrer">Business website</a></p>` : ''}<p><a href="/places/${encodeURIComponent(snapshot.placeID)}/coupons">View current offers</a></p>${p.hoursText ? `<h2>Owner-supplied hours</h2><p>${e(p.hoursText)}</p><p class="meta">Confirm with the venue before leaving; this is not live availability.</p>` : '<p class="meta">Current opening hours are not confirmed.</p>'}${p.entranceNote ? `<h2>Arrival note from the business</h2><p>${e(p.entranceNote)}</p><p class="notice">This note is owner supplied. Kulture has not independently verified the entrance or a legal route.</p>` : '<p class="meta">The exact entrance has not been verified.</p>'}<h2>About this information</h2><p class="meta">Owner supplied and approved for publication on ${e(snapshot.ownerConfirmedAt.slice(0, 10))}. Ownership review does not independently verify every business fact.</p>${sources ? `<ul>${sources}</ul>` : ''}<footer><a href="/discovery-methodology">How Kulture reports discovery</a><p>Report an incorrect or unsafe detail to the business using its listed contact. Kulture operators can withdraw this page while a correction is reviewed.</p><p>No guaranteed search ranking, AI recommendation or live availability.</p></footer></main></body></html>`;
}
export function snapshotDigest(snapshot: PageSnapshot, html = renderPage(snapshot)): string {
  return createHash('sha256').update(canonical({ snapshot, html })).digest('hex');
}
export function snapshotFromRows(place: any, draft: any): PageSnapshot {
  return {
    schemaVersion: 1,
    placeID: place.id,
    slug: place.slug,
    city: draft.profile.locality?.city ?? place.city,
    profile: merchantProfileSchema.parse(draft.profile),
    sourceURLs: Array.isArray(place.source_urls) ? place.source_urls : [],
    ownerConfirmedAt: new Date(draft.updated_at).toISOString(),
    policyVersion: PUBLICATION_POLICY,
  };
}
/** A worker transaction atomically updates public HTML and the native catalog projection. */
export async function processPublishingJob(): Promise<boolean> {
  const db = await workerPool.connect();
  let jobID: string | undefined;
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `SELECT * FROM publication_jobs WHERE (state='queued' AND next_attempt_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = rows[0];
    if (!job) {
      await db.query('COMMIT');
      return false;
    }
    jobID = job.id;
    await db.query(
      "UPDATE publication_jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '60 seconds' WHERE id=$1",
      [job.id],
    );
    const reference = (
      await db.query('SELECT place_id FROM publications WHERE id=$1', [job.publication_id])
    ).rows[0];
    if (!reference) throw new Error('publication_missing');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `claim-place:${reference.place_id}`,
    ]);
    const publication = (
      await db.query('SELECT * FROM publications WHERE id=$1 FOR UPDATE', [job.publication_id])
    ).rows[0];
    if (!publication) throw new Error('publication_missing');
    if (publication.status === 'live') {
      await db.query("UPDATE publication_jobs SET state='succeeded',lease_until=NULL WHERE id=$1", [
        job.id,
      ]);
      await db.query('COMMIT');
      return true;
    }
    const draft = (
      await db.query('SELECT * FROM merchant_drafts WHERE id=$1 FOR UPDATE', [publication.draft_id])
    ).rows[0];
    const claim = (
      await db.query("SELECT id FROM merchant_claims WHERE id=$1 AND state='approved' FOR SHARE", [
        draft?.claim_id,
      ])
    ).rows[0];
    const place = (
      await db.query('SELECT * FROM places WHERE id=$1 FOR UPDATE', [publication.place_id])
    ).rows[0];
    const failure = !claim
      ? 'claim_not_approved'
      : !draft?.rights_confirmed
        ? 'rights_not_confirmed'
        : draft.version !== publication.draft_version
          ? 'draft_changed'
          : place.revision !== draft.base_place_revision
            ? 'place_changed'
            : publication.status === 'withdrawn'
              ? 'publication_withdrawn'
              : null;
    if (failure) {
      await db.query(
        "UPDATE publications SET status='failed',error=$2 WHERE id=$1 AND status<>'withdrawn'",
        [publication.id, failure],
      );
      await db.query(
        "UPDATE publication_jobs SET state='failed',last_error=$2,lease_until=NULL WHERE id=$1",
        [job.id, failure],
      );
      await db.query('COMMIT');
      return true;
    }
    if (!publication.approved_by)
      throw new HttpError(403, 'approval_required', 'A current publishing approval is required');
    await db.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE', [
      publication.tenant_id,
      publication.approved_by,
    ]);
    await db.query("SELECT set_config('app.actor_id',$1,true)", [publication.approved_by]);
    await requirePlacePermission(db, publication.tenant_id, publication.place_id, 'publish');
    const previous =
      (await db.query('SELECT snapshot FROM public_pages WHERE place_id=$1', [place.id])).rows[0]
        ?.snapshot?.profile ?? {};
    await requirePublicationCapability(
      db,
      publication.tenant_id,
      place.id,
      previous,
      publication.snapshot.profile,
    );
    const snapshot = publication.snapshot as PageSnapshot;
    if (snapshotDigest(snapshot, publication.html) !== publication.digest)
      throw new Error('snapshot_digest_mismatch');
    const p = merchantProfileSchema.parse(snapshot.profile);
    // Only reviewed merchant fields replace catalog values; source rights/photo metadata stay explicit.
    const extra = { ...p, merchantMaintained: true, factVerification: 'owner_supplied' };
    await db.query(
      `UPDATE places SET name=$2,category=$3,neighborhood=$4,address=$5,summary=$6,tags=$7,search_query=$8,catalog_data=catalog_data||$9::jsonb,state=CASE WHEN $9::jsonb->>'status'='permanently_closed' THEN 'closed' ELSE 'published' END,revision=$10,business_type=COALESCE($11,business_type),locality=COALESCE($12::jsonb,locality),consumer_eligible=($3<>'business'),city=COALESCE($13,city),updated_at=now() WHERE id=$1`,
      [
        place.id,
        p.name,
        p.category,
        p.neighborhood,
        p.address,
        p.summary,
        JSON.stringify(p.tags),
        `${p.name} ${p.address} ${p.locality?.city ?? place.city}`,
        JSON.stringify(extra),
        publication.revision,
        p.businessType ?? null,
        p.locality ? JSON.stringify(p.locality) : null,
        p.locality?.city ?? null,
      ],
    );
    await db.query(
      `INSERT INTO public_pages(place_id,publication_id,canonical_path,revision,snapshot,html,digest,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(place_id) DO UPDATE SET publication_id=EXCLUDED.publication_id,canonical_path=EXCLUDED.canonical_path,revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot,html=EXCLUDED.html,digest=EXCLUDED.digest,published_at=EXCLUDED.published_at,withdrawn_at=NULL`,
      [
        place.id,
        publication.id,
        publication.canonical_path,
        publication.revision,
        JSON.stringify(snapshot),
        publication.html,
        publication.digest,
      ],
    );
    await db.query(
      "UPDATE publications SET status='live',published_at=now(),error=NULL WHERE id=$1",
      [publication.id],
    );
    await db.query("UPDATE merchant_drafts SET state='published' WHERE id=$1", [draft.id]);
    await db.query(
      "UPDATE publication_jobs SET state='succeeded',lease_until=NULL,last_error=NULL WHERE id=$1",
      [job.id],
    );
    await db.query(
      "INSERT INTO audit_log(actor_id,tenant_id,action,target_id,data) VALUES('worker',$1,'publication.live',$2,$3)",
      [
        publication.tenant_id,
        publication.id,
        JSON.stringify({ digest: publication.digest, revision: publication.revision }),
      ],
    );
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    if (jobID) {
      // Failures roll back serving changes; retries are bounded and never claim success.
      await db.query(
        `UPDATE publication_jobs SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END,next_attempt_at=now()+interval '30 seconds'*power(2,LEAST(attempts,5)),lease_until=NULL,last_error='publication_worker_error' WHERE id=$1`,
        [jobID],
      );
      await db.query(
        "UPDATE publications SET status='failed',error='publication_worker_error' WHERE id=(SELECT publication_id FROM publication_jobs WHERE id=$1 AND state='failed')",
        [jobID],
      );
    }
    throw error;
  } finally {
    db.release();
  }
}
