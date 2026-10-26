import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { renderSiteArtifact } = await import('../src/modules/site-artifacts.js');
const { inspectPublishedHTML, robotsAllows, verifyPublicPage } = await import(
  '../src/modules/access-checks.js'
);
const { validatedPublicURL, isPublicAddress, publicAddresses } = await import(
  '../src/modules/adapters/safe-fetch.js'
);
const { signBundle, verifyBundle, sha256 } = await import('../src/modules/adapters/bundles.js');
const { domainHostname } = await import('../src/modules/website-domains.js');
const { canonicalPath } = await import('../src/modules/publishing.js');
const snapshot = {
  schemaVersion: 1 as const,
  placeID: 'fixture',
  slug: 'fixture',
  city: 'హైదరాబాద్',
  profile: {
    name: 'నమస్తే Café & Co. <script>x</script>',
    category: 'cafes' as const,
    businessType: 'cafe' as const,
    neighborhood: 'Jubilee Hills',
    address: 'Road 36 & Lane 2',
    summary: 'Owner supplied café facts with Unicode, quotation marks and a </script> fixture.',
    tags: ['Coffee'],
    locality: {
      country: 'IN' as const,
      state: 'Telangana',
      city: 'హైదరాబాద్',
      citySlug: 'hyderabad',
      locality: 'Jubilee Hills',
      street: 'Road 36',
      postalCode: '500033',
    },
    hours: {
      timezone: 'Asia/Kolkata' as const,
      weekly: [
        {
          day: 5,
          state: 'open' as const,
          periods: [{ opens: '20:00', closes: '01:00', endsNextDay: true, appointmentOnly: false }],
        },
      ],
      exceptions: [
        {
          date: '2026-10-02',
          state: 'closed' as const,
          periods: [],
          note: 'Owner-supplied closure',
        },
      ],
    },
    offerings: [
      {
        id: 'coffee',
        name: 'Coffee',
        priceMinor: 12500,
        currency: 'INR' as const,
        priceQualifier: 'from' as const,
        availability: 'unknown' as const,
      },
    ],
  },
  sourceURLs: [],
  ownerConfirmedAt: '2026-09-29T00:00:00.000Z',
  policyVersion: 'kulture-public-page-v1',
};
const target = {
  id: '99f18dfd-e4a0-4c00-87ac-77d5c9a02e6d',
  canonicalURL: 'https://business.example/',
  sequence: 3,
};
test('one escaped artifact preserves Unicode, declared prices, overnight hours and India locality', () => {
  const a = renderSiteArtifact(snapshot, target);
  assert.equal(a.artifactDigest, sha256(a.fragment));
  assert(a.fragment.includes('నమస్తే'));
  assert(a.fragment.includes('&lt;script&gt;'));
  assert(!a.fragment.includes('<script>'));
  assert(a.fragment.includes('From ₹125.00'));
  assert(a.fragment.includes('20:00–01:00 next day'));
  assert(a.fragment.includes('2026-10-02: Closed'));
  assert(a.fragment.includes('500033'));
  assert(!JSON.stringify(a.metadata).includes('aggregateRating'));
  assert.equal(canonicalPath(snapshot), '/hyderabad/places/fixture');
});
test('public verification requires exact revision and visitor-readable material facts', () => {
  const a = renderSiteArtifact(snapshot, target),
    expected = {
      destinationID: target.id,
      sequence: 3,
      fragment: a.fragment,
      canonical: target.canonicalURL,
      name: snapshot.profile.name,
      address: snapshot.profile.address,
      metadataPermissions: ['canonical', 'schema'],
      schema: a.metadata.schema,
    };
  assert(inspectPublishedHTML(a.html, expected).every((v) => v.status !== 'fail'));
  assert.equal(
    inspectPublishedHTML(a.html.replace(a.fragment, a.fragment + a.fragment), expected).find(
      (c) => c.name === 'approved_artifact',
    )?.status,
    'fail',
  );
  assert.equal(
    inspectPublishedHTML(a.html.replace('<main>', '<main hidden>'), expected).find(
      (c) => c.name === 'visible_facts',
    )?.status,
    'fail',
  );
  assert.equal(
    inspectPublishedHTML(
      a.html.replace('</head>', '<meta name="robots" content="noindex"></head>'),
      expected,
    ).find((c) => c.name === 'meta_robots')?.status,
    'fail',
  );
  assert.equal(
    inspectPublishedHTML(
      a.html.replace('\"@type\":\"CafeOrCoffeeShop\"', '\"@type\":\"Person\"'),
      expected,
    ).find((c) => c.name === 'structured_data')?.status,
    'fail',
  );
});
test('robots agent groups, longest allow and wildcard rules remain separate from crawl evidence', () => {
  const text =
    'User-agent: *\nDisallow: /private\nAllow: /private/public\nUser-agent: OAI-SearchBot\nDisallow: /*?secret=*\nDisallow: /blocked$';
  assert(!robotsAllows(text, 'Googlebot', '/private/x'));
  assert(robotsAllows(text, 'Googlebot', '/private/public/guide'));
  assert(!robotsAllows(text, 'OAI-SearchBot', '/blocked'));
  assert(robotsAllows(text, 'OAI-SearchBot', '/blocked/child'));
  assert(!robotsAllows(text, 'OAI-SearchBot', '/page?secret=yes'));
  assert(robotsAllows(text, 'OAI-SearchBot', '/private/x'));
});
test('DNS guard rejects rebinding/mixed answers, internal metadata and non-global IPv6', async () => {
  for (const ip of [
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '10.0.0.5',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fd00::1',
    '::2',
    '2001:db8::1',
  ])
    assert(!isPublicAddress(ip), ip);
  assert(isPublicAddress('1.1.1.1'));
  assert(isPublicAddress('2001:4860:4860::8888'));
  await assert.rejects(
    publicAddresses('example.com', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
  );
  for (const url of [
    'http://example.com',
    'https://u:p@example.com',
    'https://example.com:8443',
    'https://localhost',
    'https://example.com/#secret',
  ])
    assert.throws(() => validatedPublicURL(url));
  assert.throws(() => domainHostname('example.com/path'));
  assert.throws(() => domainHostname('127.0.0.1'));
  assert.equal(domainHostname('Business.Example'), 'business.example');
});
test('Ed25519 exact bytes reject altered payload, unknown and emergency-revoked keys', () => {
  const prior = {
    key: process.env.PUBLICATION_SIGNING_PRIVATE_KEY,
    id: process.env.PUBLICATION_SIGNING_KEY_ID,
    keys: process.env.PUBLICATION_TRUSTED_KEYS_JSON,
    revoked: process.env.PUBLICATION_REVOKED_KEY_IDS,
  };
  const keys = generateKeyPairSync('ed25519');
  process.env.PUBLICATION_SIGNING_PRIVATE_KEY = keys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  process.env.PUBLICATION_SIGNING_KEY_ID = 'ephemeral-test';
  process.env.PUBLICATION_TRUSTED_KEYS_JSON = JSON.stringify({
    'ephemeral-test': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  process.env.PUBLICATION_REVOKED_KEY_IDS = '';
  try {
    const envelope = signBundle({ name: 'Café తెలుగు', sequence: 2 });
    assert.equal(verifyBundle(envelope).name, 'Café తెలుగు');
    assert.throws(() =>
      verifyBundle({
        ...envelope,
        payloadBytes: Buffer.from('{"name":"changed"}').toString('base64'),
      }),
    );
    assert.throws(() => verifyBundle({ ...envelope, keyID: 'unknown' }));
    process.env.PUBLICATION_REVOKED_KEY_IDS = 'ephemeral-test';
    assert.throws(() => verifyBundle(envelope));
  } finally {
    for (const [key, value] of Object.entries({
      PUBLICATION_SIGNING_PRIVATE_KEY: prior.key,
      PUBLICATION_SIGNING_KEY_ID: prior.id,
      PUBLICATION_TRUSTED_KEYS_JSON: prior.keys,
      PUBLICATION_REVOKED_KEY_IDS: prior.revoked,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test('bounded synthetic verifier cannot report an altered or blocked page as accessible', async () => {
  const artifact = renderSiteArtifact(snapshot, target),
    preview = { ...artifact, snapshot, sequence: 3, asset_manifest: [] },
    destination = {
      ...target,
      public_url: target.canonicalURL,
      canonical_url: target.canonicalURL,
      kind: 'hosted',
    };
  const fetcher = async (url: string) => ({
    url,
    status: 200,
    redirects: [],
    headers: {},
    body: url.endsWith('/robots.txt')
      ? 'User-agent: *\nDisallow: /'
      : url.endsWith('/sitemap.xml')
        ? ''
        : artifact.html,
  });
  const result = await verifyPublicPage(destination, preview, fetcher);
  assert.equal(result.outcome, 'needs_attention');
  assert(result.checks.some((c) => c.name === 'robots_OAI-SearchBot' && c.status === 'fail'));
  assert(!('crawlCount' in result));
});
test('committed cross-language fixture verifies exact artifact and metadata digests in Node', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('../../wordpress/tests/protocol-fixture.json', import.meta.url), 'utf8'),
  );
  const p = verifyBundle(fixture.envelope, fixture.keys);
  assert.equal(sha256(p.managedHTML), p.managedArtifactDigest);
  assert.equal(sha256(Buffer.from(p.metadataBytes, 'base64')), p.canonicalAndSchemaDigest);
  assert.equal(p.managedHTML, fixture.expectedFragment);
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

test('essential correction image set permits only exact existing assets and removals', async () => {
  const { correctionAssetsAreSubset } = await import('../src/modules/publication-targets.js');
  const a = { id: 'photo-a', sha256: 'approved-hash', alt: 'Existing entrance' },
    b = { id: 'photo-b', sha256: 'other-hash', alt: 'Existing room' };
  assert(correctionAssetsAreSubset([a, b], [b]));
  assert(correctionAssetsAreSubset([a, b], []));
  assert(correctionAssetsAreSubset([a, b], [b, a]));
  assert(!correctionAssetsAreSubset([a], [a, b]));
  assert(!correctionAssetsAreSubset([a], [{ ...a, sha256: 'replacement' }]));
  assert(!correctionAssetsAreSubset([a], [{ ...a, alt: 'New promotion' }]));
});
