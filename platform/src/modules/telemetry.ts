import type { Hono } from 'hono';
import { createHash, createHmac } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { open, stat } from 'node:fs/promises';
import { requireUser, requireOps } from '../auth.js';
import { withActor, requireRole, HttpError, workerPool, canonical, audit } from '../db.js';
import { requirePlacePermission } from './business-auth.js';
import { config } from '../config.js';
const RULES = [
  {
    provider: 'OpenAI',
    role: 'search',
    token: 'OAI-SearchBot',
    url: 'https://openai.com/searchbot.json',
  },
  { provider: 'OpenAI', role: 'training', token: 'GPTBot', url: 'https://openai.com/gptbot.json' },
  {
    provider: 'OpenAI',
    role: 'user_fetch',
    token: 'ChatGPT-User',
    url: 'https://openai.com/chatgpt-user.json',
  },
] as const;
export interface CrawlerRule {
  id: string;
  provider: string;
  role: string;
  user_agent_token: string;
  ranges: string[];
  checksum: string;
  expires_at: Date | string;
  first_seen_at: Date | string;
}
export function ipInCIDR(ip: string, cidr: string): boolean {
  try {
    const [network, bits, extra] = cidr.split('/');
    if (extra || !network || bits === undefined || !/^\d+$/.test(bits)) return false;
    const version = isIP(network),
      kind = version === 4 ? 'ipv4' : 'ipv6';
    if (!version || isIP(ip) !== version || Number(bits) > (version === 4 ? 32 : 128)) return false;
    const list = new BlockList();
    list.addSubnet(network, Number(bits), kind);
    return list.check(ip, kind);
  } catch {
    return false;
  }
}
export function classifyCrawler(
  ip: string,
  userAgent: string,
  rules: CrawlerRule[],
  now = new Date(),
) {
  const claimed = RULES.find((r) =>
    new RegExp(
      `(?:^|[\\s(;])${r.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|[\\s;)])`,
      'i',
    ).test(userAgent + ' '),
  );
  const rule = claimed
    ? rules.find(
        (r) =>
          r.provider === claimed.provider &&
          r.role === claimed.role &&
          r.user_agent_token === claimed.token &&
          new Date(r.expires_at) > now &&
          new Date(r.first_seen_at) <= now &&
          r.ranges.some((cidr) => ipInCIDR(ip, cidr)),
      )
    : undefined;
  return {
    provider: claimed?.provider ?? null,
    role: claimed?.role ?? null,
    verification: rule ? 'verified' : claimed ? 'claimed' : 'unknown',
    ruleID: rule?.id ?? null,
    checksum: rule?.checksum ?? null,
  };
}
export function normalizePublicPath(value: string): string | null {
  // Queries do not become distinct public pages; only exact branch HTML routes qualify.
  const path = value.split('?')[0];
  if (
    path === '/' ||
    /^\/sites\/[A-Za-z0-9-]{1,160}$/.test(path ?? '') ||
    /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/places\/[a-z0-9][a-z0-9-]{0,199}$/.test(path ?? '')
  )
    return path!;
  return null;
}
export function completeCoverage(
  intervals: {
    start: Date;
    end: Date;
    coverage: string;
  }[],
  from: Date,
  to: Date,
): boolean {
  let cursor = from.getTime();
  for (const row of intervals
    .filter((v) => v.coverage === 'complete')
    .sort((a, b) => a.start.getTime() - b.start.getTime())) {
    if (row.end.getTime() <= cursor) continue;
    if (row.start.getTime() > cursor) return false;
    cursor = Math.max(cursor, row.end.getTime());
    if (cursor >= to.getTime()) return true;
  }
  return false;
}
const recordSchema = z
  .object({
    host: z
      .string()
      .max(300)
      .regex(/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/)
      .optional(),
    deliveryID: z.uuid().optional(),
    requestID: z.string().min(1).max(160),
    observedAt: z.iso.datetime(),
    path: z.string().max(2000),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    clientIP: z
      .string()
      .max(80)
      .refine((v) => isIP(v) !== 0),
    userAgent: z.string().max(1000),
    status: z.number().int().min(100).max(599),
    contentType: z.string().max(120),
    synthetic: z.boolean(),
    cacheStatus: z.string().max(40).optional(),
    pageRevision: z.number().int().positive().optional(),
  })
  .strict();
const batchSchema = z
  .object({
    source: z.literal('caddy-access'),
    batchID: z.string().min(8).max(128),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    coverage: z.enum(['partial', 'complete']),
    expectedRecords: z.number().int().min(0).max(500),
    records: z.array(recordSchema).max(500),
  })
  .strict();
async function boundedJSON(url: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Kulture/1.0 (crawler verification rules)' },
  });
  if (!response.ok || !response.body)
    throw new HttpError(503, 'rules_unavailable', 'Official crawler ranges could not be refreshed');
  const reader = response.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 1000000)
        throw new HttpError(
          503,
          'invalid_rules',
          'Official crawler ranges exceeded the accepted size',
        );
      parts.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new HttpError(503, 'invalid_rules', 'Official crawler ranges were not valid JSON');
  }
}
export async function refreshCrawlerRules(): Promise<{
  updated: number;
}> {
  let updated = 0;
  for (const definition of RULES) {
    const body = z
      .object({
        prefixes: z
          .array(
            z
              .object({ ipv4Prefix: z.string().optional(), ipv6Prefix: z.string().optional() })
              .passthrough(),
          )
          .min(1)
          .max(20000),
      })
      .passthrough()
      .parse(await boundedJSON(definition.url));
    const ranges = body.prefixes.flatMap((p) =>
      [p.ipv4Prefix, p.ipv6Prefix].filter((v): v is string => !!v),
    );
    if (
      !ranges.length ||
      ranges.some((cidr) => {
        const ip = cidr.split('/')[0];
        return !ip || !ipInCIDR(ip, cidr);
      })
    )
      throw new HttpError(503, 'invalid_rules', 'Official crawler ranges failed validation');
    const checksum = createHash('sha256').update(canonical(ranges)).digest('hex');
    await workerPool.query(
      `INSERT INTO crawler_rule_snapshots(provider,role,user_agent_token,source_url,ranges,checksum,fetched_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,now(),now()+interval '48 hours')`,
      [
        definition.provider,
        definition.role,
        definition.token,
        definition.url,
        JSON.stringify(ranges),
        checksum,
      ],
    );
    updated++;
  }
  return { updated };
}
/** Parse only Caddy's server-recorded direct peer address; never trust a forwarded client header. */
export function caddyRecord(line: string): z.infer<typeof recordSchema> | null {
  try {
    const raw = JSON.parse(line),
      request = raw.request;
    if (!request || typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null;
    const path = normalizePublicPath(String(request.uri ?? ''));
    if (!path) return null;
    const header = (headers: unknown, name: string): string => {
      if (!headers || typeof headers !== 'object') return '';
      const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === name.toLowerCase(),
      )?.[1];
      return Array.isArray(entry) ? String(entry[0] ?? '') : typeof entry === 'string' ? entry : '';
    };
    const userAgent = header(request.headers, 'User-Agent'),
      revision = Number(header(raw.resp_headers, 'X-Kulture-Page-Revision')),
      host = typeof request.host === 'string' ? request.host.toLowerCase() : undefined,
      deliveryID = header(raw.resp_headers, 'X-Kulture-Delivery-ID');
    const value = {
      ...(host ? { host } : {}),
      ...(deliveryID ? { deliveryID } : {}),
      requestID:
        header(raw.resp_headers, 'X-Request-Id') || createHash('sha256').update(line).digest('hex'),
      observedAt: new Date(raw.ts * 1000).toISOString(),
      path,
      method: String(request.method ?? ''),
      clientIP: String(request.remote_ip ?? ''),
      userAgent,
      status: raw.status,
      contentType: header(raw.resp_headers, 'Content-Type'),
      synthetic: /\b(Kulture|uptime|healthcheck|synthetic|probe)\b/i.test(userAgent),
      ...(Number.isSafeInteger(revision) && revision > 0 ? { pageRevision: revision } : {}),
    };
    const parsed = recordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** At-least-once local access-log collection: committed ingestion precedes the durable byte cursor. */
export async function collectCaddyLog(path = process.env.CADDY_ACCESS_LOG ?? ''): Promise<{
  records: number;
  advancedBytes: number;
}> {
  if (!path) return { records: 0, advancedBytes: 0 };
  const db = await workerPool.connect();
  let locked = false;
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(26092026,2) AS acquired')).rows[0]
      .acquired;
    if (!locked) return { records: 0, advancedBytes: 0 };
    let info;
    try {
      info = await stat(path, { bigint: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { records: 0, advancedBytes: 0 };
      throw e;
    }
    const source = 'caddy-access',
      prior = (await db.query('SELECT * FROM telemetry_cursors WHERE source=$1', [source])).rows[0];
    const same =
      prior &&
      prior.device === String(info.dev) &&
      prior.inode === String(info.ino) &&
      BigInt(prior.byte_offset) <= info.size;
    const offset = same ? Number(prior.byte_offset) : 0;
    if (offset >= Number(info.size)) return { records: 0, advancedBytes: 0 };
    const file = await open(path, 'r'),
      buffer = Buffer.alloc(Math.min(1048576, Number(info.size) - offset));
    let bytesRead: number;
    try {
      bytesRead = (await file.read(buffer, 0, buffer.length, offset)).bytesRead;
    } finally {
      await file.close();
    }
    let consumed = 0,
      lines = 0;
    const records: z.infer<typeof recordSchema>[] = [];
    while (consumed < bytesRead && lines < 500) {
      const newline = buffer.indexOf(10, consumed);
      if (newline < 0 || newline >= bytesRead) break;
      const record = caddyRecord(buffer.subarray(consumed, newline).toString('utf8'));
      if (record) records.push(record);
      consumed = newline + 1;
      lines++;
    }
    // Reject oversized malformed log lines without looping forever; mark coverage partial regardless.
    if (consumed === 0 && bytesRead === buffer.length && buffer.length === 1048576)
      consumed = bytesRead;
    if (consumed === 0) return { records: 0, advancedBytes: 0 };
    if (records.length) {
      // A chunk spanning a very long outage is split into day-bounded groups.
      const groups = new Map<string, typeof records>();
      for (const record of records) {
        const day = record.observedAt.slice(0, 10);
        groups.set(day, [...(groups.get(day) ?? []), record]);
      }
      for (const [day, items] of groups) {
        const groupTimes = items.map((r) => new Date(r.observedAt).getTime());
        await ingestEdgeBatch({
          source,
          batchID: createHash('sha256')
            .update(`${info.dev}:${info.ino}:${offset}:${consumed}:${day}`)
            .digest('hex'),
          windowStart: new Date(Math.min(...groupTimes)).toISOString(),
          windowEnd: new Date(Math.max(...groupTimes) + 1).toISOString(),
          coverage: 'partial',
          expectedRecords: items.length,
          records: items,
        });
      }
    }
    await db.query(
      `INSERT INTO telemetry_cursors(source,device,inode,byte_offset) VALUES($1,$2,$3,$4) ON CONFLICT(source) DO UPDATE SET device=EXCLUDED.device,inode=EXCLUDED.inode,byte_offset=EXCLUDED.byte_offset,updated_at=now()`,
      [source, String(info.dev), String(info.ino), offset + consumed],
    );
    return { records: records.length, advancedBytes: consumed };
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(26092026,2)');
    db.release();
  }
}
let lastRulesAttempt = 0,
  lastCollection = 0;
/** Call from the dedicated worker. Refresh failure does not halt log ingestion or publication. */
export async function processTelemetry(): Promise<void> {
  if (!process.env.CADDY_ACCESS_LOG) return;
  if (Date.now() - lastRulesAttempt > 3600000) {
    lastRulesAttempt = Date.now();
    const newest = (
      await workerPool.query(
        'SELECT min(last_fetch) AS oldest,count(*)::int AS roles FROM (SELECT role,max(fetched_at) AS last_fetch FROM crawler_rule_snapshots WHERE expires_at>now() GROUP BY role) current_rules',
      )
    ).rows[0];
    if (
      newest.roles < 3 ||
      !newest.oldest ||
      new Date(newest.oldest).getTime() < Date.now() - 24 * 3600000
    ) {
      try {
        await refreshCrawlerRules();
      } catch {
        console.error(
          JSON.stringify({
            event: 'crawler_rules_refresh_failed',
            verification: 'unknown_until_valid_rules',
          }),
        );
      }
    }
  }
  if (Date.now() - lastCollection >= 5000) {
    lastCollection = Date.now();
    await collectCaddyLog();
  }
}
export async function ingestEdgeBatch(input: unknown): Promise<{
  accepted: number;
  duplicate: boolean;
}> {
  const batch = batchSchema.parse(input),
    start = new Date(batch.windowStart),
    end = new Date(batch.windowEnd);
  if (
    end <= start ||
    end.getTime() - start.getTime() > 24 * 3600000 ||
    end.getTime() > Date.now() + 60000 ||
    batch.expectedRecords !== batch.records.length ||
    batch.records.some((r) => new Date(r.observedAt) < start || new Date(r.observedAt) >= end)
  )
    throw new HttpError(
      400,
      'invalid_batch',
      'Batch records must exactly match the declared count and bounded observation window',
    );
  const hash = createHash('sha256').update(canonical(batch)).digest('hex'),
    db = await workerPool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      batch.source + ':' + batch.batchID,
    ]);
    const prior = (
      await db.query('SELECT body_hash FROM edge_ingest_batches WHERE source=$1 AND batch_id=$2', [
        batch.source,
        batch.batchID,
      ])
    ).rows[0];
    if (prior) {
      if (prior.body_hash !== hash)
        throw new HttpError(
          409,
          'batch_conflict',
          'This batch ID was previously used for different content',
        );
      await db.query('COMMIT');
      return { accepted: 0, duplicate: true };
    }
    // Delayed records use proof valid at observation time, including historical windows.
    // A later fetch with identical ranges cannot fill an expired verification gap.
    const rules = (
      await db.query(
        'SELECT * FROM crawler_rule_snapshots WHERE expires_at>$1 AND first_seen_at<$2 ORDER BY fetched_at DESC',
        [start, end],
      )
    ).rows as CrawlerRule[];
    let accepted = 0;
    for (const record of batch.records) {
      const path = normalizePublicPath(record.path);
      if (!path) continue;
      // Attribute only a server-recorded Host/path and, for hosted pages, a response delivery ID.
      // Forwarded Host and request-side X-Kulture-* headers never participate.
      let page: any;
      const host = record.host?.toLowerCase(),
        platformHost = new URL(config.publicURL).host.toLowerCase();
      if (host === platformHost && path.includes('/places/'))
        page = (
          await db.query(
            'SELECT place_id,publication_id,revision FROM public_pages WHERE canonical_path=$1',
            [path],
          )
        ).rows[0];
      else if (host && record.deliveryID) {
        const delivery = (
          await db.query(
            `SELECT d.place_id,d.publication_id,p.revision,t.kind,t.id AS destination_id,v.metadata->>'canonical' AS approved_url
      FROM target_deliveries d JOIN publication_destinations t ON t.id=d.destination_id JOIN publications p ON p.id=d.publication_id JOIN destination_previews v ON v.id=d.preview_id
      WHERE d.id=$1 AND d.applied_at IS NOT NULL AND d.applied_at<=$2`,
            [record.deliveryID, record.observedAt],
          )
        ).rows[0];
        if (delivery?.kind === 'hosted') {
          if (host === platformHost && path === '/sites/' + delivery.place_id) page = delivery;
          else if (path === '/' && new URL(delivery.approved_url).host.toLowerCase() === host) {
            const domain = (
              await db.query(
                "SELECT id FROM destination_domains WHERE destination_id=$1 AND hostname=$2 AND tls_at<=$3 AND verified_at<=$3 AND removed_at IS NULL AND state IN('live','activating')",
                [delivery.destination_id, host, record.observedAt],
              )
            ).rows[0];
            if (domain) page = delivery;
          }
        }
      }
      if (!page && !(host === platformHost && path.includes('/places/'))) continue;
      const result = classifyCrawler(
        record.clientIP,
        record.userAgent,
        rules,
        new Date(record.observedAt),
      );
      const ipHash = createHmac('sha256', config.opsToken)
        .update(record.observedAt.slice(0, 10) + '|' + record.clientIP)
        .digest('hex');
      // An old cached revision must not be labeled as the current artifact.
      let publicationID = page?.publication_id ?? null;
      if (page && record.pageRevision && record.pageRevision !== page.revision)
        publicationID =
          (
            await db.query(
              'SELECT id FROM publications WHERE place_id=$1 AND revision=$2 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1',
              [page.place_id, record.pageRevision],
            )
          ).rows[0]?.id ?? null;
      const inserted = await db.query(
        `INSERT INTO crawler_events(source,request_id,observed_at,place_id,publication_id,canonical_path,method,status,content_type,provider,role,verification,rule_snapshot_id,rule_checksum,ip_hash,synthetic,cache_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(source,request_id) DO NOTHING`,
        [
          batch.source,
          record.requestID,
          record.observedAt,
          page?.place_id ?? null,
          publicationID,
          host === platformHost ? path : 'https://' + host + path,
          record.method,
          record.status,
          record.contentType.toLowerCase().split(';')[0]?.trim() ?? '',
          result.provider,
          result.role,
          result.verification,
          result.ruleID,
          result.checksum,
          ipHash,
          record.synthetic,
          record.cacheStatus ?? null,
        ],
      );
      accepted += inserted.rowCount ?? 0;
    }
    await db.query(
      'INSERT INTO edge_ingest_batches(source,batch_id,window_start,window_end,coverage,expected_records,body_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [batch.source, batch.batchID, start, end, batch.coverage, batch.expectedRecords, hash],
    );
    await audit(db, 'ops', null, 'telemetry.ingested', batch.batchID, {
      accepted,
      coverage: batch.coverage,
    });
    await db.query('COMMIT');
    return { accepted, duplicate: false };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
export function registerTelemetry(app: Hono) {
  app.post('/internal/telemetry/refresh-rules', async (c) => {
    await requireOps(c);
    return c.json(await refreshCrawlerRules());
  });
  app.post('/internal/telemetry/edge-batches', async (c) => {
    await requireOps(c);
    return c.json(await ingestEdgeBatch(await c.req.json()));
  });
  app.get('/v1/tenants/:tenantID/places/:placeID/visibility', async (c) => {
    const user = await requireUser(c),
      tenant = z.string().uuid().parse(c.req.param('tenantID')),
      place = c.req.param('placeID');
    const now = new Date(),
      from = new Date(now.getTime() - 30 * 24 * 3600000);
    const report = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const claim = (
        await db.query(
          "SELECT reviewed_at FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
          [tenant, place],
        )
      ).rows[0];
      if (!claim)
        throw new HttpError(
          403,
          'approved_claim_required',
          'Visibility requires an approved current claim',
        );
      const lower = new Date(Math.max(from.getTime(), new Date(claim.reviewed_at).getTime()));
      const intervals = (
        await db.query(
          'SELECT window_start,window_end,coverage FROM edge_ingest_batches WHERE window_end>$1 AND window_start<$2 ORDER BY window_start',
          [lower, now],
        )
      ).rows.map((r) => ({
        start: new Date(r.window_start),
        end: new Date(r.window_end),
        coverage: r.coverage,
      }));
      const covered = intervals.length > 0,
        status = !covered
          ? 'unavailable'
          : completeCoverage(intervals, lower, now)
            ? 'complete'
            : 'partial';
      const metrics: {
        kind: string;
        value: number;
        definition: string;
        method: string;
        coverage: string;
      }[] = [];
      if (covered) {
        const rows = (
          await db.query(
            `SELECT role,verification,status,count(*)::int AS value FROM crawler_events WHERE place_id=$1 AND observed_at>=$2 AND observed_at<$3 AND synthetic=false AND method='GET' AND content_type='text/html' AND status IN(200,304) GROUP BY role,verification,status`,
            [place, lower, now],
          )
        ).rows;
        for (const [kind, role, statusCode] of [
          ['verified_search_html_fetch', 'search', 200],
          ['verified_training_html_fetch', 'training', 200],
          ['verified_user_html_fetch', 'user_fetch', 200],
          ['verified_search_revalidation', 'search', 304],
        ] as const) {
          metrics.push({
            kind,
            value: rows
              .filter(
                (r) => r.verification === 'verified' && r.role === role && r.status === statusCode,
              )
              .reduce((n, r) => n + r.value, 0),
            definition: `Verified ${role} ${statusCode === 200 ? 'status-200 HTML deliveries' : 'status-304 revalidations'}; synthetic checks excluded`,
            method: 'trusted-caddy-log + official IP range + user-agent; v1',
            coverage: status,
          });
        }
        metrics.push({
          kind: 'unverified_claimed_bot_html_fetch',
          value: rows
            .filter((r) => r.verification === 'claimed' && r.status === 200)
            .reduce((n, r) => n + r.value, 0),
          definition: 'Claimed provider identity without current matching source verification',
          method: 'trusted-caddy-log user-agent classification; v1',
          coverage: status,
        });
      }
      return {
        placeID: place,
        from: lower.toISOString(),
        to: now.toISOString(),
        computedAt: now.toISOString(),
        coverage: {
          status,
          reason: covered
            ? 'Coverage follows authenticated collector windows; provider verification currently supports OpenAI crawler roles only.'
            : 'No authenticated edge-log batches cover this reporting period.',
        },
        metrics,
        notes: [
          'Crawls are not citations, people, visits or revenue.',
          'Only the period under your approved claim is available.',
          'Caddy logs cover Kulture-served listings and hosted sites. External WordPress server crawler logs are not connected; public access checks on those sites are synthetic, not crawler counts.',
          'Indexing, citations, referrals and customer actions are not connected; no zero is inferred for them.',
          'Publishing requires current location entitlement; measured crawler activity is independent of payment.',
        ],
      };
    });
    return c.json(report);
  });
}
