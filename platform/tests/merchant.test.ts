import { test, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { merchantProfileSchema, renderPage, snapshotDigest, scriptJSON } = await import(
  '../src/modules/publishing.js'
);
const { ipInCIDR, classifyCrawler, completeCoverage, normalizePublicPath, caddyRecord } =
  await import('../src/modules/telemetry.js');
const snapshot = {
  schemaVersion: 1 as const,
  placeID: 'fixture',
  slug: 'fixture',
  city: 'Hyderabad',
  profile: {
    name: 'A <script>alert(1)</script> Café',
    category: 'cafes' as const,
    neighborhood: 'Jubilee Hills',
    address: 'Road 36, Jubilee Hills',
    summary: 'A sourced café with a deliberate </script> injection fixture.',
    tags: ['Coffee'],
    hoursText: 'Hours supplied by owner',
    entranceNote: 'Entrance details supplied by owner',
  },
  sourceURLs: ['https://example.com', 'javascript:alert(1)'],
  ownerConfirmedAt: '2026-09-26T12:00:00.000Z',
  policyVersion: 'kulture-public-page-v1',
};
test('public renderer escapes HTML and JSON script termination without inventing geo/hours/ratings', () => {
  const html = renderPage(snapshot);
  assert(!html.includes('<script>alert'));
  assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('href="javascript:'));
  const schema = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
  assert(schema);
  const decoded = JSON.parse(schema);
  assert.equal(decoded.name, snapshot.profile.name);
  assert.equal(decoded.geo, undefined);
  assert.equal(decoded.openingHoursSpecification, undefined);
  assert.equal(decoded.aggregateRating, undefined);
  assert(html.includes('owner supplied'));
  assert(!scriptJSON('</script>').includes('<'));
});
test('collector trusts direct Caddy peer, redacts query and ignores private paths', () => {
  const log = {
    ts: Date.now() / 1000,
    request: {
      method: 'GET',
      uri: '/hyderabad/places/cafe?token=private',
      remote_ip: '192.0.2.1',
      headers: { 'User-Agent': ['OAI-SearchBot/1.0'], 'X-Forwarded-For': ['203.0.113.3'] },
    },
    status: 200,
    resp_headers: {
      'Content-Type': ['text/html; charset=utf-8'],
      'X-Request-Id': ['request-test'],
      'X-Kulture-Page-Revision': ['2'],
    },
  };
  const parsed = caddyRecord(JSON.stringify(log));
  assert(parsed);
  assert.equal(parsed.path, '/hyderabad/places/cafe');
  assert.equal(parsed.clientIP, '192.0.2.1');
  assert.equal(parsed.pageRevision, 2);
  assert(!JSON.stringify(parsed).includes('private'));
  assert.equal(
    caddyRecord(JSON.stringify({ ...log, request: { ...log.request, uri: '/v1/profile' } })),
    null,
  );
  assert(
    caddyRecord(
      JSON.stringify({
        ...log,
        request: { ...log.request, headers: { 'User-Agent': ['Kulture synthetic probe'] } },
      }),
    )?.synthetic,
  );
});
test('exact snapshot digest is stable but changes for a material public edit', () => {
  assert.equal(
    snapshotDigest(snapshot),
    snapshotDigest({ ...snapshot, profile: { ...snapshot.profile } }),
  );
  assert.notEqual(
    snapshotDigest(snapshot),
    snapshotDigest({
      ...snapshot,
      profile: { ...snapshot.profile, address: 'A different branch address' },
    }),
  );
  assert.equal(
    merchantProfileSchema.safeParse({ ...snapshot.profile, phone: '0000000000' }).success,
    false,
  );
  assert.equal(
    merchantProfileSchema.safeParse({ ...snapshot.profile, website: 'javascript:alert(1)' })
      .success,
    false,
  );
});
test('crawler verification requires matching UA, valid IP ranges and unexpired proof', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const rule = {
    id: 'test',
    provider: 'OpenAI',
    role: 'search',
    user_agent_token: 'OAI-SearchBot',
    ranges: ['192.0.2.0/24', '2001:db8::/32'],
    checksum: 'test',
    first_seen_at: '2026-09-26T00:00:00Z',
    expires_at: '2026-09-27T00:00:00Z',
  };
  assert(ipInCIDR('192.0.2.255', '192.0.2.0/24'));
  assert(!ipInCIDR('192.0.3.0', '192.0.2.0/24'));
  assert(ipInCIDR('2001:db8::123', '2001:db8::/32'));
  assert(!ipInCIDR('2001:db9::1', '2001:db8::/32'));
  assert(!ipInCIDR('192.0.2.1', '192.0.2.0/99'));
  assert.equal(
    classifyCrawler('192.0.2.3', 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)', [rule], now)
      .verification,
    'verified',
  );
  assert.equal(
    classifyCrawler('198.51.100.1', 'OAI-SearchBot/1.0', [rule], now).verification,
    'claimed',
  );
  assert.equal(
    classifyCrawler('192.0.2.3', 'OAI-SearchBot-fake/1.0', [rule], now).verification,
    'unknown',
  );
  assert.equal(
    classifyCrawler(
      '192.0.2.3',
      'OAI-SearchBot/1.0',
      [{ ...rule, expires_at: '2026-09-25T00:00:00Z' }],
      now,
    ).verification,
    'claimed',
  );
  const old = {
    ...rule,
    id: 'old',
    first_seen_at: '2026-09-24T00:00:00Z',
    expires_at: '2026-09-25T00:00:00Z',
  };
  assert.equal(
    classifyCrawler('192.0.2.3', 'OAI-SearchBot/1.0', [rule, old], new Date('2026-09-24T12:00:00Z'))
      .ruleID,
    'old',
  );
  assert.equal(
    classifyCrawler('192.0.2.3', 'OAI-SearchBot/1.0', [rule, old], new Date('2026-09-25T12:00:00Z'))
      .verification,
    'claimed',
  );
  assert.equal(
    classifyCrawler('192.0.2.3', 'OAI-SearchBot/1.0', [rule, old], new Date('2026-09-25T00:00:00Z'))
      .verification,
    'claimed',
  );
});
test('coverage gaps and partial intervals never become a complete observation window', () => {
  const date = (s: number) => new Date(s * 1000),
    row = (s: number, e: number, coverage = 'complete') => ({
      start: date(s),
      end: date(e),
      coverage,
    });
  assert(completeCoverage([row(0, 5), row(5, 10)], date(0), date(10)));
  assert(!completeCoverage([row(0, 4), row(5, 10)], date(0), date(10)));
  assert(!completeCoverage([row(0, 10, 'partial')], date(0), date(10)));
  assert.equal(
    normalizePublicPath('/hyderabad/places/cafe?utm_source=test'),
    '/hyderabad/places/cafe',
  );
  assert.equal(normalizePublicPath('/api/secret'), null);
  assert.equal(normalizePublicPath('/hyderabad/places/cafe/logo.png'), null);
});

test('Caddy parsing uses the actual host and response delivery ID, never forwarded/request identifiers', () => {
  const id = '0af07324-2a13-4c29-8f68-61f402d4271d',
    raw = {
      ts: Date.now() / 1000,
      request: {
        host: 'business.example',
        uri: '/?private=removed',
        method: 'GET',
        remote_ip: '192.0.2.1',
        headers: {
          'User-Agent': ['OAI-SearchBot/1.0'],
          'X-Forwarded-Host': ['other.example'],
          'X-Kulture-Delivery-ID': ['b1c50dcc-e735-48e3-81be-3a30186993cd'],
        },
      },
      status: 200,
      resp_headers: { 'Content-Type': ['text/html'], 'X-Kulture-Delivery-ID': [id] },
    };
  const r = caddyRecord(JSON.stringify(raw));
  assert(r);
  assert.equal(r.host, 'business.example');
  assert.equal(r.deliveryID, id);
  assert.equal(r.path, '/');
  assert(!JSON.stringify(r).includes('private'));
  assert.equal(normalizePublicPath('/bengaluru/places/store'), '/bengaluru/places/store');
  assert.equal(normalizePublicPath('/sites/store'), '/sites/store');
});

after(async () => {
  const { pool, workerPool } = await import('../src/db.js'),
    { authPool } = await import('../src/auth.js');
  await Promise.all([
    pool.end(),
    authPool.end(),
    ...(workerPool !== pool ? [workerPool.end()] : []),
  ]);
});
