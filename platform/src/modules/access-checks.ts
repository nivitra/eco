import type { Hono } from 'hono';
import { parse } from 'parse5';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { withActor, workerPool, HttpError, idempotent, canonical } from '../db.js';
import { requirePlacePermission } from './business-auth.js';
import {
  enqueueAccess,
  targetFor,
  approvedAuthority,
  wordpressContent,
} from './publication-targets.js';
import { safeFetch, type PublicFetchResult } from './adapters/safe-fetch.js';
import { extractManagedFragment } from './site-artifacts.js';
import { sha256 } from './adapters/bundles.js';
import { processDomainCheck, registerDomains } from './website-domains.js';
export interface AccessCheck {
  name: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
}
type FetchPublic = (
  url: string,
  options?: Parameters<typeof safeFetch>[1],
) => Promise<PublicFetchResult>;
const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
function walk(node: any, visit: (n: any) => void) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}
function attr(node: any, key: string): string {
  return node.attrs?.find((a: any) => a.name === key)?.value ?? '';
}
/** Parse structure; script/style/head content cannot impersonate visitor-visible facts. */
export function inspectPublishedHTML(
  html: string,
  expected: {
    destinationID: string;
    sequence: number;
    fragment: string;
    canonical: string;
    name: string;
    address: string;
    metadataPermissions: string[];
    schema?: unknown;
  },
): AccessCheck[] {
  const doc = parse(html),
    canonicals: string[] = [],
    robots: string[] = [],
    schemas: unknown[] = [],
    links: string[] = [];
  let text = '';
  const visit = (node: any, hidden = false) => {
    const hide =
      hidden ||
      ['head', 'script', 'style', 'template', 'noscript'].includes(node.tagName) ||
      attr(node, 'hidden') !== '' ||
      (node.attrs ?? []).some((a: any) => a.name === 'hidden') ||
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(node, 'style'));
    if (node.nodeName === '#text' && !hide) text += ' ' + node.value;
    for (const child of node.childNodes ?? []) visit(child, hide);
  };
  visit(doc);
  walk(doc, (n) => {
    if (n.tagName === 'link' && attr(n, 'rel').toLowerCase().split(/\s+/).includes('canonical'))
      canonicals.push(attr(n, 'href'));
    if (
      n.tagName === 'meta' &&
      ['robots', 'googlebot', 'oai-searchbot', 'claude-searchbot'].includes(
        attr(n, 'name').toLowerCase(),
      )
    )
      robots.push(attr(n, 'content'));
    if (n.tagName === 'script' && attr(n, 'type') === 'application/ld+json') {
      try {
        schemas.push(JSON.parse((n.childNodes ?? []).map((v: any) => v.value ?? '').join('')));
      } catch {
        schemas.push(null);
      }
    }
    if (n.tagName === 'a') links.push(attr(n, 'href'));
  });
  const fragment = extractManagedFragment(html, expected.destinationID, expected.sequence),
    visible = normalized(text),
    metadata = expected.metadataPermissions;
  const schemaNodes = (value: any, depth = 0): any[] =>
    depth > 10
      ? []
      : Array.isArray(value)
        ? value.flatMap((v) => schemaNodes(v, depth + 1))
        : value && typeof value === 'object'
          ? [value, ...schemaNodes(value['@graph'], depth + 1)]
          : [];
  const candidates = schemas.flatMap((s) => schemaNodes(s)),
    schemaMatches = expected.schema
      ? candidates.some((s) => canonical(s) === canonical(expected.schema))
      : schemas.some((s) => s !== null);
  const expectedID = (expected.schema as any)?.['@id'],
    schemaConflict = expectedID
      ? candidates.filter((s) => s['@id'] === expectedID).length > 1
      : false;
  return [
    {
      name: 'approved_artifact',
      status: fragment === expected.fragment ? 'pass' : 'fail',
      detail:
        fragment === expected.fragment
          ? 'Exact approved managed HTML is present in the public response.'
          : 'The approved revision is missing, altered, duplicated or still cached.',
    },
    {
      name: 'visible_facts',
      status:
        visible.includes(normalized(expected.name)) &&
        visible.includes(normalized(expected.address))
          ? 'pass'
          : 'fail',
      detail:
        'Business name and address must exist as readable HTML, outside script or hidden content.',
    },
    {
      name: 'meta_robots',
      status: robots.some((v) => /(?:^|[\s,])(noindex|none)(?:$|[\s,])/i.test(v)) ? 'fail' : 'pass',
      detail: robots.length
        ? robots.join('; ').slice(0, 250)
        : 'No noindex meta directive was observed.',
    },
    {
      name: 'canonical',
      status:
        canonicals.length === 1 && canonicals[0] === expected.canonical
          ? 'pass'
          : metadata.includes('canonical')
            ? 'fail'
            : 'unknown',
      detail:
        canonicals.length === 1
          ? `Observed ${canonicals[0]}`
          : canonicals.length
            ? 'Multiple canonical declarations; review the theme or SEO plugin.'
            : 'No canonical declaration observed; this adapter lacks permission to change it.',
    },
    {
      name: 'structured_data',
      status:
        schemaMatches && !schemaConflict
          ? 'pass'
          : metadata.includes('schema')
            ? 'fail'
            : 'unknown',
      detail:
        schemaMatches && !schemaConflict
          ? 'The approved JSON-LD entity is present; this does not establish rich-result eligibility.'
          : 'The approved JSON-LD entity is missing, changed or duplicated.',
    },
    {
      name: 'contact_arrival_links',
      status: links.some((l) => l.includes('/arrival')) ? 'pass' : 'fail',
      detail: 'The managed page must link to its public arrival guide.',
    },
  ];
}
/** Apply longest-match rules to a requested agent, using wildcard groups only as fallback. */
export function robotsAllows(text: string, agent: string, path: string): boolean {
  const groups: {
    agents: string[];
    rules: {
      allow: boolean;
      path: string;
    }[];
  }[] = [];
  let group: (typeof groups)[number] = { agents: [], rules: [] };
  let hadRules = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line
      .replace(/#.*$/, '')
      .trim()
      .match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase(),
      value = m[2].trim();
    if (key === 'user-agent') {
      if (hadRules) {
        groups.push(group);
        group = { agents: [], rules: [] };
        hadRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && group.agents.length) {
      hadRules = true;
      if (value) group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  groups.push(group);
  const specific = groups.filter((g) =>
      g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)),
    ),
    selected = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = selected
    .flatMap((g) => g.rules)
    .filter((r) => {
      const pattern = r.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      try {
        return new RegExp('^' + pattern).test(path);
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        b.path.replace(/\*/g, '').length - a.path.replace(/\*/g, '').length ||
        Number(b.allow) - Number(a.allow),
    );
  return rules[0]?.allow ?? true;
}
export async function verifyPublicPage(
  target: any,
  preview: any,
  fetchPublic: FetchPublic = safeFetch,
): Promise<{
  outcome: string;
  checks: AccessCheck[];
  observedURL: string;
}> {
  const response = await fetchPublic(target.public_url, {
      expectedOrigin: new URL(target.public_url).origin,
    }),
    checks: AccessCheck[] = [
      {
        name: 'public_https',
        status: response.status === 200 ? 'pass' : 'fail',
        detail: `HTTPS returned ${response.status}; ${response.redirects.length} redirect(s).`,
      },
    ];
  if (response.status !== 200) return { outcome: 'unavailable', checks, observedURL: response.url };
  checks.push(
    ...inspectPublishedHTML(response.body, {
      destinationID: target.id,
      sequence: Number(preview.sequence),
      fragment: preview.fragment,
      canonical: target.canonical_url,
      name: preview.snapshot.profile.name,
      address: preview.snapshot.profile.address,
      metadataPermissions:
        target.kind === 'hosted' ? ['canonical', 'schema'] : target.allowed_metadata,
      schema: preview.metadata.schema,
    }),
  );
  checks.push({
    name: 'visual_layout',
    status: 'unknown',
    detail:
      'This is a structural HTML check, not a browser rendering or accessibility audit of the WordPress theme.',
  });
  checks.push({
    name: 'header_robots',
    status: /\b(noindex|none)\b/i.test(response.headers['x-robots-tag'] ?? '') ? 'fail' : 'pass',
    detail: response.headers['x-robots-tag'] ?? 'No X-Robots-Tag exclusion observed.',
  });
  try {
    const robots = await fetchPublic(new URL('/robots.txt', response.url).href, {
      expectedOrigin: new URL(response.url).origin,
      maxBytes: 128000,
      timeoutMs: 5000,
    });
    for (const agent of ['Googlebot', 'OAI-SearchBot', 'Claude-SearchBot'])
      checks.push({
        name: 'robots_' + agent,
        status:
          robots.status === 404
            ? 'pass'
            : robots.status === 200
              ? robotsAllows(
                  robots.body,
                  agent,
                  new URL(response.url).pathname + new URL(response.url).search,
                )
                ? 'pass'
                : 'fail'
              : 'unknown',
        detail:
          robots.status === 200
            ? 'Observed robots.txt policy only; no crawler request or indexing is implied.'
            : `robots.txt returned ${robots.status}.`,
      });
  } catch {
    checks.push({
      name: 'robots_policy',
      status: 'unknown',
      detail: 'robots.txt could not be checked safely.',
    });
  }
  try {
    const sitemap = await fetchPublic(new URL('/sitemap.xml', response.url).href, {
      expectedOrigin: new URL(response.url).origin,
      maxBytes: 512000,
      timeoutMs: 5000,
    });
    checks.push({
      name: 'sitemap_discovery',
      status:
        sitemap.status === 200 && sitemap.body.includes(target.canonical_url) ? 'pass' : 'unknown',
      detail:
        'Checks the conventional sitemap only; sitemap indexes and plugin-specific paths may need a manual review.',
    });
  } catch {
    checks.push({
      name: 'sitemap_discovery',
      status: 'unknown',
      detail: 'The conventional sitemap could not be checked.',
    });
  }
  try {
    const home = await fetchPublic(new URL('/', response.url).href, {
      expectedOrigin: new URL(response.url).origin,
      maxBytes: 512000,
      timeoutMs: 5000,
    });
    let linked = false;
    walk(parse(home.body), (n) => {
      if (n.tagName === 'a') {
        try {
          if (new URL(attr(n, 'href'), response.url).href === target.canonical_url) linked = true;
        } catch {}
      }
    });
    checks.push({
      name: 'internal_discovery',
      status: linked ? 'pass' : 'unknown',
      detail: linked
        ? 'The website homepage links to this page.'
        : 'No homepage link observed; add a relevant navigation link with the site owner’s approval.',
    });
  } catch {
    checks.push({
      name: 'internal_discovery',
      status: 'unknown',
      detail: 'Homepage discovery could not be checked.',
    });
  }
  for (const asset of (preview.asset_manifest ?? []).slice(0, 5)) {
    try {
      const image = await fetchPublic(asset.url, {
        maxBytes: 2000000,
        timeoutMs: 5000,
        maxRedirects: 2,
      });
      checks.push({
        name: 'image_' + asset.id,
        status: image.status === 200 ? 'pass' : 'fail',
        detail: `Approved public image returned ${image.status}.`,
      });
    } catch {
      checks.push({
        name: 'image_' + asset.id,
        status: 'fail',
        detail: 'Approved image is unavailable to the verifier.',
      });
    }
  }
  if ((preview.asset_manifest ?? []).length > 5)
    checks.push({
      name: 'image_sample',
      status: 'unknown',
      detail:
        'Five approved images were checked; remaining images were not probed in this bounded check.',
    });
  return {
    outcome: checks.some((c) => c.status === 'fail') ? 'needs_attention' : 'accessible',
    checks,
    observedURL: response.url,
  };
}
export function registerAccessChecks(app: Hono) {
  const prefix = '/v1/tenants/:tenantID/places/:placeID/destinations/:destinationID';
  app.get(prefix + '/access', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      target = z.uuid().parse(c.req.param('destinationID'));
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'view');
        await targetFor(db, tenant, place, target);
        const rows = (
          await db.query(
            'SELECT * FROM access_observations WHERE destination_id=$1 ORDER BY observed_at DESC LIMIT 30',
            [target],
          )
        ).rows;
        return {
          observations: rows.map((r) => ({
            id: r.id,
            destinationID: r.destination_id,
            deliveryID: r.delivery_id,
            outcome: r.outcome,
            checks: r.checks,
            observedURL: r.observed_url,
            observedAt: r.observed_at,
            synthetic: true,
          })),
          nextCursor: null,
        };
      }),
    );
  });
  app.post(prefix + '/check', async (c) => {
    const user = await requireUser(c),
      tenant = z.uuid().parse(c.req.param('tenantID')),
      place = z.string().min(1).max(160).parse(c.req.param('placeID')),
      target = z.uuid().parse(c.req.param('destinationID'));
    return c.json(
      await withActor(user.id, async (db) => {
        await requirePlacePermission(db, tenant, place, 'manage_destinations');
        await targetFor(db, tenant, place, target);
        return idempotent(
          db,
          user.id,
          c.req.header('Idempotency-Key') ?? '',
          'access-check:' + target,
          {},
          async () => {
            const latest = (
              await db.query(
                "SELECT id FROM target_deliveries WHERE destination_id=$1 AND state IN('verified_live','applied_unverified','delayed') ORDER BY sequence DESC LIMIT 1",
                [target],
              )
            ).rows[0];
            if (!latest)
              throw new HttpError(
                409,
                'no_delivery',
                'Publish this destination before checking it',
              );
            await enqueueAccess(db, target, latest.id);
            return { queued: true };
          },
        );
      }),
      202,
    );
  });
  registerDomains(app);
}
export async function processAccessCheckJob(
  fetchPublic: FetchPublic = safeFetch,
): Promise<boolean> {
  const db = await workerPool.connect();
  let job: any, target: any;
  try {
    await db.query('BEGIN');
    job = (
      await db.query(
        "SELECT * FROM access_jobs WHERE state IN('queued','running') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!job) {
      await db.query('COMMIT');
      return false;
    }
    await db.query(
      "UPDATE access_jobs SET state='running',lease_until=now()+interval '180 seconds' WHERE id=$1",
      [job.id],
    );
    target = (
      await db.query('SELECT * FROM publication_destinations WHERE id=$1', [job.destination_id])
    ).rows[0];
    await db.query('COMMIT');
    if (!target || target.state === 'revoked')
      throw new HttpError(409, 'destination_revoked', 'Destination is disconnected');
    if (job.kind === 'domain') {
      await processDomainCheck(target, fetchPublic);
      await db.query("UPDATE access_jobs SET state='complete',lease_until=NULL WHERE id=$1", [
        job.id,
      ]);
      return true;
    }
    if (job.kind === 'control') {
      const pairing = (
        await db.query(
          'SELECT p.*,i.origin FROM adapter_pairings p JOIN adapter_installations i ON i.id=p.installation_id WHERE p.id=$1',
          [target.pairing_id],
        )
      ).rows[0];
      if (
        !pairing?.approved_at ||
        !pairing.confirmed_at ||
        new Date(pairing.expires_at) <= new Date()
      )
        throw new HttpError(409, 'pairing_expired', 'Generate a new connection code');
      const response = await fetchPublic(
          pairing.origin + '/wp-json/kulture/v1/control/' + pairing.id,
          { expectedOrigin: pairing.origin, maxBytes: 16000 },
        ),
        proof = JSON.parse(response.body);
      if (
        response.status !== 200 ||
        proof.installationID !== pairing.installation_id ||
        proof.challenge !== pairing.challenge
      )
        throw new HttpError(
          409,
          'control_unproven',
          'The public website did not return its current control challenge',
        );
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'claim-place:' + target.place_id,
      ]);
      await approvedAuthority(db, target.tenant_id, target.place_id);
      const current = await targetFor(db, target.tenant_id, target.place_id, target.id, true);
      if (current.state === 'revoked' || current.version !== target.version)
        throw new HttpError(409, 'connection_changed', 'Connection changed during the check');
      await db.query(
        "UPDATE adapter_installations SET status='connected' WHERE id=$1 AND status<>'revoked'",
        [pairing.installation_id],
      );
      await db.query('UPDATE adapter_pairings SET consumed_at=now() WHERE id=$1', [pairing.id]);
      await db.query(
        "UPDATE publication_destinations SET state='connected',last_error=NULL WHERE id=$1",
        [target.id],
      );
      await db.query("UPDATE access_jobs SET state='complete',lease_until=NULL WHERE id=$1", [
        job.id,
      ]);
      await db.query('COMMIT');
      return true;
    }
    const delivery = (
      await db.query('SELECT * FROM target_deliveries WHERE id=$1 AND destination_id=$2', [
        job.delivery_id,
        target.id,
      ])
    ).rows[0];
    if (!delivery)
      throw new HttpError(409, 'delivery_missing', 'No delivery is available to verify');
    const preview = (
      await db.query('SELECT * FROM destination_previews WHERE id=$1', [delivery.preview_id])
    ).rows[0];
    const result = await verifyPublicPage(target, preview, fetchPublic);
    await db.query('BEGIN');
    const current = await targetFor(db, target.tenant_id, target.place_id, target.id, true);
    await db.query(
      'INSERT INTO access_observations(tenant_id,place_id,destination_id,delivery_id,outcome,checks,observed_url) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        target.tenant_id,
        target.place_id,
        target.id,
        delivery.id,
        result.outcome,
        JSON.stringify(result.checks),
        result.observedURL,
      ],
    );
    if (
      delivery.state === 'reconciling' &&
      result.outcome === 'accessible' &&
      current.state !== 'revoked' &&
      current.version === target.version &&
      Number(current.last_sequence) < Number(delivery.sequence)
    ) {
      await approvedAuthority(db, target.tenant_id, target.place_id);
      await db.query(
        'UPDATE publication_destinations SET last_sequence=$2,last_applied_hash=$3 WHERE id=$1',
        [target.id, delivery.sequence, sha256(wordpressContent(preview.fragment))],
      );
      current.last_sequence = delivery.sequence;
    }
    const fresh =
      current.state !== 'revoked' &&
      current.version === target.version &&
      Number(current.last_sequence) === Number(delivery.sequence);
    if (fresh && result.outcome === 'accessible') {
      await db.query(
        "UPDATE target_deliveries SET state='verified_live',verified_at=now(),applied_at=COALESCE(applied_at,now()),error_code=NULL WHERE id=$1",
        [delivery.id],
      );
      await db.query(
        "UPDATE publication_destinations SET state='verified_live',last_success_at=now(),last_error=NULL WHERE id=$1",
        [target.id],
      );
      await db.query(
        "UPDATE destination_domains SET state='live',activated_at=COALESCE(activated_at,now()) WHERE destination_id=$1 AND state='activating'",
        [target.id],
      );
    } else if (fresh) {
      await db.query(
        "UPDATE publication_destinations SET state='delayed',last_error='public_check_failed' WHERE id=$1",
        [target.id],
      );
      await db.query(
        "UPDATE target_deliveries SET state='delayed',error_code='public_check_failed' WHERE id=$1",
        [delivery.id],
      );
    }
    await db.query(
      'UPDATE access_jobs SET state=$2,attempts=attempts+1,available_at=now()+make_interval(secs=>LEAST(3600,60*power(2,attempts))+random()*20),lease_until=NULL WHERE id=$1',
      [job.id, result.outcome === 'accessible' || job.attempts >= 4 ? 'complete' : 'queued'],
    );
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    if (job) {
      const code = error instanceof HttpError ? error.code : 'access_check_failed';
      await db.query(
        "UPDATE access_jobs SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,attempts=attempts+1,available_at=now()+make_interval(secs=>LEAST(3600,60*power(2,attempts))+random()*20),lease_until=NULL,error_code=$2 WHERE id=$1",
        [job.id, code],
      );
      if (target && job.kind.startsWith('page'))
        await db.query(
          'INSERT INTO access_observations(tenant_id,place_id,destination_id,delivery_id,outcome,checks,observed_url) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            target.tenant_id,
            target.place_id,
            target.id,
            job.delivery_id,
            'unavailable',
            JSON.stringify([{ name: 'public_transport', status: 'fail', detail: code }]),
            target.public_url,
          ],
        );
      if (target)
        await db.query(
          "UPDATE publication_destinations SET last_error=$2 WHERE id=$1 AND state<>'revoked'",
          [target.id, code],
        );
    }
    return !!job;
  } finally {
    db.release();
  }
}
