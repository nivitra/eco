import type { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { requireUser } from '../auth.js';
import { withActor, workerPool, pool, idempotent, HttpError, canonical, audit } from '../db.js';
import { requirePlacePermission } from './business-auth.js';
import { requireLocationCapability, locationEntitlement } from './entitlements.js';
import { targetFor, approvedAuthority, enqueueAccess } from './publication-targets.js';
import { safeFetch, publicAddresses, validatedPublicURL } from './adapters/safe-fetch.js';
import { renderSiteArtifact } from './site-artifacts.js';
import { resolvePublicAssets } from './media.js';
import { sha256, verifyBundle } from './adapters/bundles.js';
export function domainHostname(value: string): string {
  const host = value.trim().toLowerCase();
  const url = validatedPublicURL('https://' + host);
  if (
    url.hostname !== host ||
    url.pathname !== '/' ||
    url.search ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  )
    throw new HttpError(
      422,
      'invalid_hostname',
      'Enter a public DNS hostname without a path or port',
    );
  if (host === new URL(config.publicURL).hostname)
    throw new HttpError(
      422,
      'reserved_hostname',
      'Choose a domain you control, not the platform hostname',
    );
  return host;
}
const domainDTO = (r: any) => ({
  hostname: r.hostname,
  state: r.state,
  expiresAt: r.expires_at,
  activatedAt: r.activated_at ?? null,
});
export function registerDomains(app: Hono) {
  const prefix = '/v1/tenants/:tenantID/places/:placeID/destinations/:destinationID';
  app.get('/internal/caddy/ask', async (c) => {
    if (process.env.DOMAIN_AUTHORITY_ONLY !== 'true' && process.env.INTERNAL_API !== 'true')
      return c.notFound();
    const host = c.req.query('domain') ?? '';
    let validated: string;
    try {
      validated = domainHostname(host);
    } catch {
      return c.text('denied', 403);
    }
    const db = await pool.connect();
    try {
      const allowed = (
        await db.query('SELECT domain_certificate_allowed($1) AS allowed', [validated])
      ).rows[0]?.allowed;
      return c.text(allowed ? 'allowed' : 'denied', allowed ? 200 : 403);
    } finally {
      db.release();
    }
  });
  app.post(prefix + '/domain', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      targetID = z.uuid().parse(c.req.param('destinationID')),
      body = z
        .object({ hostname: z.string().max(253) })
        .strict()
        .parse(await c.req.json()),
      host = domainHostname(body.hostname);
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        await approvedAuthority(db, tenant, place);
        return idempotent(
          db,
          user.id,
          c.req.header('Idempotency-Key') ?? '',
          'domain:' + targetID,
          { hostname: host },
          async () => {
            const target = await targetFor(db, tenant, place, targetID, true);
            if (target.kind !== 'hosted' || target.state === 'revoked')
              throw new HttpError(
                409,
                'hosted_required',
                'Custom domains require an active hosted website',
              );
            await requireLocationCapability(db, tenant, place, 'publish');
            await db.query(
              "DELETE FROM destination_domains WHERE destination_id=$1 AND state='requested' AND expires_at<=now()",
              [targetID],
            );
            if (
              (
                await db.query(
                  'SELECT id FROM destination_domains WHERE destination_id=$1 AND removed_at IS NULL',
                  [targetID],
                )
              ).rowCount
            )
              throw new HttpError(
                409,
                'domain_exists',
                'A domain is already bound to this location',
              );
            await db.query(
              'DELETE FROM destination_domains WHERE destination_id=$1 AND removed_at IS NOT NULL',
              [targetID],
            );
            const token = randomBytes(24).toString('base64url'),
              row = (
                await db.query(
                  "INSERT INTO destination_domains(destination_id,tenant_id,place_id,hostname,token,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours') RETURNING *",
                  [targetID, tenant, place, host, token],
                )
              ).rows[0];
            return {
              domain: domainDTO(row),
              challenge: {
                name: '_kulture.' + host,
                type: 'TXT',
                value: 'kulture=' + token,
                expiresAt: row.expires_at,
              },
            };
          },
        );
      }),
      201,
    );
  });
  app.post(prefix + '/domain/verify', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      targetID = z.uuid().parse(c.req.param('destinationID'));
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        await targetFor(db, tenant, place, targetID);
        return idempotent(
          db,
          user.id,
          c.req.header('Idempotency-Key') ?? '',
          'domain-check:' + targetID,
          {},
          async () => {
            await enqueueAccess(db, targetID, null, 'domain');
            return { queued: true };
          },
        );
      }),
      202,
    );
  });
  app.post(prefix + '/domain/preview', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      targetID = z.uuid().parse(c.req.param('destinationID'));
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        const target = await targetFor(db, tenant, place, targetID),
          domain = (
            await db.query('SELECT * FROM destination_domains WHERE destination_id=$1', [targetID])
          ).rows[0];
        if (!domain || domain.state !== 'tls_ready')
          throw new HttpError(
            409,
            'domain_not_ready',
            'Verify ownership, DNS routing and HTTPS before migration',
          );
        const prior = (
          await db.query(
            "SELECT d.publication_id,p.* FROM target_deliveries d JOIN destination_previews p ON p.id=d.preview_id WHERE d.destination_id=$1 AND d.state IN('verified_live','applied_unverified','delayed') ORDER BY d.sequence DESC LIMIT 1",
            [targetID],
          )
        ).rows[0];
        if (!prior)
          throw new HttpError(409, 'website_required', 'Publish the hosted website first');
        const assets = await resolvePublicAssets(
            db,
            tenant,
            place,
            prior.asset_manifest.map((a: any) => a.id),
          ),
          canonicalURL = 'https://' + domain.hostname + '/',
          artifact = renderSiteArtifact(
            prior.snapshot,
            { id: targetID, canonicalURL, sequence: Number(target.next_sequence) },
            assets,
          );
        const preview = {
          ...artifact,
          snapshot: prior.snapshot,
          assetManifest: assets,
          publicationID: prior.publication_id,
          draftID: prior.draft_id,
          draftVersion: prior.draft_version,
          targetVersion: target.version,
          sequence: Number(target.next_sequence),
          baseContentHash: target.last_applied_hash,
          canonicalURL,
          approvedBy: user.id,
        };
        const digest = sha256(canonical(preview));
        await db.query(
          "UPDATE destination_domains SET migration_preview=$2,migration_expires_at=now()+interval '15 minutes' WHERE destination_id=$1",
          [targetID, JSON.stringify({ ...preview, digest })],
        );
        return {
          preview: {
            digest,
            html: artifact.html,
            managedArtifactDigest: artifact.artifactDigest,
            canonicalAndSchemaDigest: artifact.metadataDigest,
            publicURL: canonicalURL,
            previousURL: target.public_url,
            targetVersion: target.version,
            blockingIssues: [],
            expiresAt: new Date(Date.now() + 15 * 60000),
          },
        };
      }),
    );
  });
  app.post(prefix + '/domain/activate', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      targetID = z.uuid().parse(c.req.param('destinationID')),
      body = z
        .object({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/), approval: z.literal(true) })
        .strict()
        .parse(await c.req.json());
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        await requirePlacePermission(db, tenant, place, 'publish');
        await approvedAuthority(db, tenant, place);
        await requireLocationCapability(db, tenant, place, 'publish');
        return idempotent(
          db,
          user.id,
          c.req.header('Idempotency-Key') ?? '',
          'domain-activate:' + targetID,
          body,
          async () => {
            const target = await targetFor(db, tenant, place, targetID, true),
              domain = (
                await db.query(
                  'SELECT * FROM destination_domains WHERE destination_id=$1 FOR UPDATE',
                  [targetID],
                )
              ).rows[0],
              p = domain?.migration_preview;
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
                'Finish the current delivery before migrating this domain',
              );
            if (
              domain?.state !== 'tls_ready' ||
              !p ||
              p.digest !== body.previewDigest ||
              p.targetVersion !== target.version ||
              p.sequence !== Number(target.next_sequence) ||
              p.baseContentHash !== target.last_applied_hash ||
              new Date(domain.migration_expires_at) <= new Date()
            )
              throw new HttpError(
                409,
                'preview_expired',
                'Review a fresh canonical migration preview',
              );
            await resolvePublicAssets(
              db,
              tenant,
              place,
              p.assetManifest.map((a: any) => a.id),
            );
            const preview = (
              await db.query(
                "INSERT INTO destination_previews(destination_id,tenant_id,place_id,draft_id,draft_version,target_version,sequence,snapshot,fragment,html,metadata,asset_manifest,base_content_hash,artifact_digest,metadata_digest,digest,renderer_version,template_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now()+interval '15 minutes') RETURNING id",
                [
                  targetID,
                  tenant,
                  place,
                  p.draftID,
                  p.draftVersion,
                  target.version + 1,
                  p.sequence,
                  JSON.stringify(p.snapshot),
                  p.fragment,
                  p.html,
                  JSON.stringify(p.metadata),
                  JSON.stringify(p.assetManifest),
                  p.baseContentHash,
                  p.artifactDigest,
                  p.metadataDigest,
                  p.digest,
                  p.rendererVersion,
                  p.templateHash,
                ],
              )
            ).rows[0];
            const delivery = (
              await db.query(
                'INSERT INTO target_deliveries(tenant_id,place_id,destination_id,publication_id,preview_id,sequence,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
                [tenant, place, targetID, p.publicationID, preview.id, p.sequence, user.id],
              )
            ).rows[0];
            await db.query(
              "UPDATE publication_destinations SET canonical_url=$2,public_url=$2,version=version+1,next_sequence=next_sequence+1,state='awaiting_sync' WHERE id=$1",
              [targetID, p.canonicalURL],
            );
            await db.query(
              "UPDATE destination_domains SET state='activating',migration_preview=NULL WHERE destination_id=$1",
              [targetID],
            );
            await audit(db, user.id, tenant, 'domain.migration_approved', targetID, {
              digest: p.digest,
              hostname: domain.hostname,
            });
            return { queued: true, deliveryID: delivery.id, publicURL: p.canonicalURL };
          },
        );
      }),
      202,
    );
  });
}
export async function processDomainCheck(
  target: any,
  fetchPublic: typeof safeFetch = safeFetch,
): Promise<void> {
  const db = await workerPool.connect();
  try {
    const d = (
      await db.query('SELECT * FROM destination_domains WHERE destination_id=$1', [target.id])
    ).rows[0];
    if (!d || d.removed_at) throw new HttpError(404, 'domain_missing', 'No active domain request');
    if (!d.verified_at && new Date(d.expires_at) <= new Date())
      throw new HttpError(409, 'domain_challenge_expired', 'Request a new domain challenge');
    const records = await Promise.race([
      resolveTxt('_kulture.' + d.hostname),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('dns_timeout')), 5000);
        t.unref();
      }),
    ]);
    if (!records.some((row) => row.join('') === 'kulture=' + d.token))
      throw new HttpError(
        409,
        'domain_control_unproven',
        'Publish the exact TXT ownership challenge',
      );
    await db.query(
      "UPDATE destination_domains SET verified_at=now(),state=CASE WHEN state='requested' THEN 'ownership_verified' ELSE state END WHERE id=$1",
      [d.id],
    );
    const [destination, platform] = await Promise.all([
      publicAddresses(d.hostname),
      publicAddresses(new URL(config.publicURL).hostname),
    ]);
    const expected = new Set(platform.map((a) => a.address));
    if (destination.some((a) => !expected.has(a.address)))
      throw new HttpError(
        409,
        'domain_not_routed',
        'Every public A/AAAA record must route to the configured Kulture serving host',
      );
    await db.query(
      "UPDATE destination_domains SET routed_at=now(),state=CASE WHEN state IN('requested','ownership_verified') THEN 'dns_routed' ELSE state END WHERE id=$1",
      [d.id],
    );
    const response = await fetchPublic('https://' + d.hostname + '/', {
      expectedOrigin: 'https://' + d.hostname,
      maxBytes: 1000000,
    });
    if (response.status !== 200)
      throw new HttpError(
        409,
        'domain_https_unavailable',
        'The verified hostname is not yet serving valid HTTPS',
      );
    await db.query(
      "UPDATE destination_domains SET tls_at=now(),recheck_at=now()+interval '1 day',state=CASE WHEN state='dns_routed' THEN 'tls_ready' ELSE state END WHERE id=$1",
      [d.id],
    );
  } finally {
    db.release();
  }
}
/** Retention changes serving state, never silently invents billing success or erases shared arrival data. */
export async function processWebsiteLifecycle(): Promise<void> {
  const db = await workerPool.connect();
  try {
    const rows = (
      await db.query(
        "SELECT d.* FROM publication_destinations d WHERE (d.state<>'revoked' OR EXISTS(SELECT 1 FROM hosted_sites s WHERE s.destination_id=d.id AND s.withdrawn_at IS NULL)) AND d.lifecycle_checked_at<now()-interval '1 hour' ORDER BY d.lifecycle_checked_at LIMIT 100",
      )
    ).rows;
    for (const target of rows) {
      await db.query('BEGIN');
      if (target.kind === 'wordpress') {
        const deliveries = (
          await db.query(
            "SELECT id,envelope,created_at FROM target_deliveries WHERE destination_id=$1 AND state IN('awaiting_sync','applying')",
            [target.id],
          )
        ).rows;
        for (const delivery of deliveries) {
          let expired = false;
          try {
            expired =
              new Date(verifyBundle(delivery.envelope).installBefore).getTime() <= Date.now();
          } catch {
            expired = true;
          }
          if (expired) {
            await db.query(
              "UPDATE target_deliveries SET state='failed',error_code='bundle_expired_or_key_revoked' WHERE id=$1",
              [delivery.id],
            );
            await db.query(
              "UPDATE publication_destinations SET state='delayed',last_error='bundle_expired_or_key_revoked' WHERE id=$1",
              [target.id],
            );
          } else if (Date.now() - new Date(delivery.created_at).getTime() > 15 * 60000)
            await db.query(
              "UPDATE publication_destinations SET state='delayed',last_error='awaiting_wordpress_sync' WHERE id=$1",
              [target.id],
            );
        }
      }
      const entitlement = await locationEntitlement(db, {
        tenantID: target.tenant_id,
        placeID: target.place_id,
        capability: 'publish',
      });
      if (entitlement.allowed && target.state !== 'revoked') {
        if (target.paused_at)
          await db.query('UPDATE publication_destinations SET paused_at=NULL WHERE id=$1', [
            target.id,
          ]);
      } else {
        await db.query(
          'UPDATE publication_destinations SET paused_at=COALESCE(paused_at,disconnected_at,now()) WHERE id=$1',
          [target.id],
        );
        const paused =
            target.paused_at || target.disconnected_at
              ? new Date(target.paused_at ?? target.disconnected_at).getTime()
              : Date.now(),
          days = (Date.now() - paused) / 86400000;
        for (const [threshold, kind] of [
          [0, 'website_paused'],
          [60, 'retention_day_60'],
          [83, 'retention_day_83'],
          [90, 'website_migration_notice'],
          [113, 'domain_removal_notice'],
          [120, 'domain_removed'],
        ] as const) {
          if (days >= threshold) {
            await db.query(
              'INSERT INTO website_incidents(tenant_id,place_id,destination_id,kind,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(destination_id,kind) DO NOTHING',
              [
                target.tenant_id,
                target.place_id,
                target.id,
                kind,
                'Website service has no active entitlement; retention stage ' + kind,
              ],
            );
            await db.query(
              'INSERT INTO business_notifications(tenant_id,place_id,event_key,kind,title,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING',
              [
                target.tenant_id,
                target.place_id,
                target.id + ':' + kind + ':' + new Date(paused).toISOString().slice(0, 10),
                kind,
                'Website service update',
                'Premium website updates are paused. Hosted content is retained for 90 days; a custom domain then displays a 30-day migration notice. Export your facts and contact support before the retention window ends.',
              ],
            );
          }
        }
        if (days >= 120) {
          const removed = await db.query(
            'DELETE FROM destination_domains WHERE destination_id=$1 RETURNING hostname',
            [target.id],
          );
          if (removed.rowCount)
            await audit(db, 'worker', target.tenant_id, 'domain.binding_removed', target.id, {
              hostname: removed.rows[0].hostname,
              reason: 'retention_expired',
            });
        }
      }
      const domain = (
        await db.query(
          "SELECT id FROM destination_domains WHERE destination_id=$1 AND state IN('live','tls_ready','dns_routed','activating') AND removed_at IS NULL AND (recheck_at IS NULL OR recheck_at<=now())",
          [target.id],
        )
      ).rows[0];
      if (domain && target.state !== 'revoked') await enqueueAccess(db, target.id, null, 'domain');
      if (
        target.state !== 'revoked' &&
        target.last_sequence > 0 &&
        (!target.last_success_at ||
          new Date(target.last_success_at).getTime() < Date.now() - 86400000)
      ) {
        const latest = (
          await db.query(
            'SELECT id FROM target_deliveries WHERE destination_id=$1 AND sequence=$2',
            [target.id, target.last_sequence],
          )
        ).rows[0];
        if (latest) await enqueueAccess(db, target.id, latest.id);
      }
      await db.query('UPDATE publication_destinations SET lifecycle_checked_at=now() WHERE id=$1', [
        target.id,
      ]);
      await db.query('COMMIT');
    }
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
