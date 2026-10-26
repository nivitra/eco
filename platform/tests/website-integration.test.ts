import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
test(
  'durable hosted publication and scoped WordPress pull: approval, control, exact artifact, lease, replay, late acknowledgement and revocation',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { app } = await import('../src/app.js'),
      { pool, workerPool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js');
    const { processPublishingJob } = await import('../src/modules/publishing.js'),
      { processTargetPublicationJob, wordpressContent } = await import(
        '../src/modules/publication-targets.js'
      ),
      { processAccessCheckJob } = await import('../src/modules/access-checks.js'),
      { sha256, verifyBundle, RENDERER_VERSION, TEMPLATE_HASH } = await import(
        '../src/modules/adapters/bundles.js'
      );
    const oldInternal = process.env.INTERNAL_API;
    process.env.INTERNAL_API = 'true';
    const savedKeys = {
      private: process.env.PUBLICATION_SIGNING_PRIVATE_KEY,
      id: process.env.PUBLICATION_SIGNING_KEY_ID,
      keys: process.env.PUBLICATION_TRUSTED_KEYS_JSON,
      revoked: process.env.PUBLICATION_REVOKED_KEY_IDS,
    };
    const kp = generateKeyPairSync('ed25519');
    process.env.PUBLICATION_SIGNING_PRIVATE_KEY = kp.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    process.env.PUBLICATION_SIGNING_KEY_ID = 'website-test';
    process.env.PUBLICATION_TRUSTED_KEYS_JSON = JSON.stringify({
      'website-test': kp.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    });
    process.env.PUBLICATION_REVOKED_KEY_IDS = '';
    const suffix = randomUUID(),
      placeID = 'website-test-' + suffix,
      ip = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`;
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
      headers: Record<string, string> = {},
    ) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': ip,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const expect = async (r: Response, status: number) => {
      assert.equal(r.status, status, await r.clone().text());
      return r.json() as Promise<any>;
    };
    const mutation = (
      path: string,
      body: unknown,
      token?: string,
      headers: Record<string, string> = {},
    ) => request(path, 'POST', body, token, { 'Idempotency-Key': randomUUID(), ...headers });
    const signup = async (label: string) => {
      const r = await request('/api/auth/sign-up/email', 'POST', {
        name: label,
        email: label + '-' + suffix + '@example.test',
        password: 'A-long-local-test-password!',
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.headers.get('set-auth-token')!;
    };
    const profile = {
      name: 'Website integration café',
      category: 'cafes',
      neighborhood: 'Jubilee Hills',
      address: 'Fixture only Road 36',
      summary: 'A test fixture for exact, approved public website delivery.',
      tags: ['Coffee'],
      website: 'https://example.com',
      entranceNote: 'Owner supplied fixture; no independently verified entrance.',
    };
    try {
      await workerPool.query(
        "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Website fixture','cafes','Jubilee Hills','Fixture Road 36','Fixture only','2026-09-29','Fixture')",
        [placeID],
      );
      const owner = await signup('website-owner'),
        outsider = await signup('website-outsider'),
        tenant = await expect(
          await mutation('/v1/tenants', { name: 'Website fixture workspace' }, owner),
          201,
        ),
        base = `/v1/tenants/${tenant.id}/places/${placeID}`;
      const claim = await expect(
        await mutation(
          `/v1/tenants/${tenant.id}/claims`,
          {
            placeID,
            evidence: {
              description: 'Test ownership evidence, approved only by the integration operator.',
            },
          },
          owner,
        ),
        202,
      );
      await expect(
        await request(
          `/v1/ops/claims/${claim.claim.id}/review`,
          'POST',
          { decision: 'approved', reason: 'Approved integration fixture, not a real business.' },
          undefined,
          { 'X-Ops-Token': process.env.OPS_TOKEN! },
        ),
        200,
      );
      const target = (
        await expect(await mutation(base + '/destinations', { kind: 'hosted' }, owner), 201)
      ).destination;
      assert.equal((await request(base + '/destinations', 'GET', undefined, outsider)).status, 404);
      const draft = (
        await expect(
          await mutation(
            base + '/drafts',
            { basePlaceRevision: 1, profile, rightsConfirmed: true },
            owner,
          ),
          201,
        )
      ).draft;
      const preview = (
        await expect(
          await mutation(base + `/destinations/${target.id}/preview`, { draftID: draft.id }, owner),
          200,
        )
      ).preview;
      assert.equal(
        (
          await mutation(
            base + `/destinations/${target.id}/publish`,
            { previewID: preview.id, previewDigest: preview.digest, approval: true },
            owner,
            { 'If-Match': '1' },
          )
        ).status,
        402,
      );
      await workerPool.query(
        "INSERT INTO service_grants(tenant_id,place_id,starts_at,ends_at,reason,issued_by) VALUES($1,$2,now(),now()+interval '1 day','Website integration fixture','test')",
        [tenant.id, placeID],
      );
      const key = randomUUID(),
        queued = await expect(
          await request(
            base + `/destinations/${target.id}/publish`,
            'POST',
            { previewID: preview.id, previewDigest: preview.digest, approval: true },
            owner,
            { 'If-Match': '1', 'Idempotency-Key': key },
          ),
          202,
        );
      const replay = await expect(
        await request(
          base + `/destinations/${target.id}/publish`,
          'POST',
          { previewID: preview.id, previewDigest: preview.digest, approval: true },
          owner,
          { 'If-Match': '1', 'Idempotency-Key': key },
        ),
        202,
      );
      assert.equal(replay.delivery.id, queued.delivery.id);
      for (let i = 0; i < 30; i++) {
        await processPublishingJob();
        if (
          (
            await workerPool.query('SELECT status FROM publications WHERE id=$1', [
              queued.publication.id,
            ])
          ).rows[0].status === 'live'
        )
          break;
      }
      for (let i = 0; i < 30; i++) {
        await processTargetPublicationJob();
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              queued.delivery.id,
            ])
          ).rows[0].state === 'applied_unverified'
        )
          break;
      }
      const page = await request('/sites/' + placeID);
      assert.equal(page.status, 200);
      assert.equal(await page.text(), preview.html);
      const defaultSiteURL = 'http://localhost:3000/sites/' + placeID;
      const robots = await (await request('/robots.txt')).text(),
        { robotsAllows } = await import('../src/modules/access-checks.js');
      assert(
        robotsAllows(
          robots,
          'OAI-SearchBot',
          '/v1/media/public/' + randomUUID() + '/approved.webp',
        ),
        'Approved public derivatives must not inherit the private API crawl block',
      );
      assert(!robotsAllows(robots, 'OAI-SearchBot', '/v1/media/uploads'));
      assert(!robotsAllows(robots, 'Googlebot', '/v1/media/' + randomUUID() + '/preview'));
      const firstSitemap = await (await request('/sitemap.xml')).text();
      assert(
        firstSitemap.includes('<loc>' + defaultSiteURL + '</loc>'),
        'A live platform-hosted primary website must be discoverable in the sitemap',
      );
      assert(
        (await (await request('/sitemaps/1.xml')).text()).includes(
          '<loc>' + defaultSiteURL + '</loc>',
        ),
      );
      await workerPool.query(
        "UPDATE publication_destinations SET paused_at=now()-interval '91 days' WHERE id=$1",
        [target.id],
      );
      assert(
        !(await (await request('/sitemap.xml')).text()).includes(
          '<loc>' + defaultSiteURL + '</loc>',
        ),
        'A downgraded redirect must not remain a canonical sitemap entry',
      );
      await workerPool.query('UPDATE publication_destinations SET paused_at=NULL WHERE id=$1', [
        target.id,
      ]);

      // A disconnected hosted page is intentionally retained, but must still age out even while paid.
      await workerPool.query(
        "UPDATE publication_destinations SET state='revoked',disconnected_at=now()-interval '91 days',lifecycle_checked_at='-infinity' WHERE id=$1",
        [target.id],
      );
      const { processWebsiteLifecycle } = await import('../src/modules/website-domains.js');
      await processWebsiteLifecycle();
      assert.equal(
        (await request('/sites/' + placeID)).status,
        302,
        'Disconnected retained hosted sites must get their 90-day deadline',
      );
      assert(
        (
          await workerPool.query('SELECT paused_at FROM publication_destinations WHERE id=$1', [
            target.id,
          ])
        ).rows[0].paused_at,
      );
      await workerPool.query(
        "UPDATE publication_destinations SET state='applied_unverified',disconnected_at=NULL,paused_at=NULL WHERE id=$1",
        [target.id],
      );

      const fixtureFetch = async (url: string) => ({
        url,
        status: 200,
        headers: {},
        redirects: [],
        body: url.endsWith('robots.txt')
          ? 'User-agent: *\nAllow: /'
          : url.endsWith('sitemap.xml')
            ? '<urlset/>'
            : preview.html,
      });
      for (let i = 0; i < 30; i++) {
        await processAccessCheckJob(fixtureFetch);
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              queued.delivery.id,
            ])
          ).rows[0].state === 'verified_live'
        )
          break;
      }
      const checked = await expect(
        await request(base + `/destinations/${target.id}/access`, 'GET', undefined, owner),
        200,
      );
      assert.equal(checked.observations[0].outcome, 'accessible');
      assert.equal(checked.observations[0].synthetic, true);
      await workerPool.query('UPDATE service_grants SET revoked_at=now() WHERE tenant_id=$1', [
        tenant.id,
      ]);
      const { requireTargetCapability } = await import('../src/modules/publication-targets.js');
      const correctionDB = await workerPool.connect();
      try {
        const stored = (
            await correctionDB.query(
              'SELECT snapshot,asset_manifest,metadata FROM destination_previews WHERE id=$1',
              [preview.id],
            )
          ).rows[0],
          targetScope = { id: target.id, tenant_id: tenant.id, place_id: placeID };
        const factual = {
          ...stored.snapshot,
          profile: {
            ...stored.snapshot.profile,
            hoursText: 'By appointment — isolated correction fixture.',
          },
        };
        assert.equal(
          (
            await requireTargetCapability(
              correctionDB,
              targetScope,
              factual,
              [],
              2,
              stored.metadata,
            )
          ).source,
          'none',
        );
        await assert.rejects(
          requireTargetCapability(
            correctionDB,
            { ...targetScope, id: randomUUID() },
            stored.snapshot,
            [],
            2,
            stored.metadata,
          ),
          { code: 'location_plan_required' },
        );
        await assert.rejects(
          requireTargetCapability(
            correctionDB,
            targetScope,
            stored.snapshot,
            [{ id: randomUUID(), sha256: 'new-photo' }],
            2,
            stored.metadata,
          ),
          { code: 'location_plan_required' },
        );
        await assert.rejects(
          requireTargetCapability(
            correctionDB,
            targetScope,
            {
              ...stored.snapshot,
              profile: {
                ...stored.snapshot.profile,
                summary: 'A new promotional expansion copied from a later directory-only update.',
              },
            },
            [],
            2,
            stored.metadata,
          ),
          { code: 'location_plan_required' },
        );
        await assert.rejects(
          requireTargetCapability(correctionDB, targetScope, stored.snapshot, [], 2, {
            ...stored.metadata,
            canonical: 'https://new.example/',
          }),
          { code: 'location_plan_required' },
        );
      } finally {
        correctionDB.release();
      }
      await workerPool.query('UPDATE service_grants SET revoked_at=NULL WHERE tenant_id=$1', [
        tenant.id,
      ]);

      assert.equal(page.headers.get('X-Kulture-Delivery-ID'), queued.delivery.id);
      assert.equal(
        (await request('/', 'GET', undefined, undefined, { Host: 'unbound.example' })).status,
        421,
      );
      // DNS/TLS state below is an explicit local test fixture, not real domain verification evidence.
      const hostname = 'fixture-' + suffix + '.example';
      await expect(
        await mutation(base + `/destinations/${target.id}/domain`, { hostname }, owner),
        201,
      );
      assert.equal(
        (await mutation(base + `/destinations/${target.id}/domain/preview`, {}, owner)).status,
        409,
      );
      await workerPool.query(
        "UPDATE destination_domains SET state='tls_ready',verified_at=now()-interval '1 minute',routed_at=now(),tls_at=now()-interval '1 minute' WHERE destination_id=$1",
        [target.id],
      );
      const domainPreview = (
        await expect(
          await mutation(base + `/destinations/${target.id}/domain/preview`, {}, owner),
          200,
        )
      ).preview;
      assert.equal(
        (
          await mutation(
            base + `/destinations/${target.id}/domain/activate`,
            { previewDigest: sha256('wrong'), approval: true },
            owner,
          )
        ).status,
        409,
      );
      const migration = await expect(
        await mutation(
          base + `/destinations/${target.id}/domain/activate`,
          { previewDigest: domainPreview.digest, approval: true },
          owner,
        ),
        202,
      );
      for (let i = 0; i < 30; i++) {
        await processTargetPublicationJob();
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              migration.deliveryID,
            ])
          ).rows[0].state === 'applied_unverified'
        )
          break;
      }
      const custom = await request('/', 'GET', undefined, undefined, { Host: hostname });
      assert.equal(custom.status, 200);
      assert.equal(await custom.text(), domainPreview.html);
      assert.equal(custom.headers.get('X-Kulture-Delivery-ID'), migration.deliveryID);
      assert.equal((await request('/sites/' + placeID)).status, 308);
      assert(
        !(await (await request('/sitemap.xml')).text()).includes(
          '<loc>' + defaultSiteURL + '</loc>',
        ),
        'The platform alias must leave the sitemap after custom-domain migration',
      );
      const customSitemap = await (
        await request('/sitemap.xml', 'GET', undefined, undefined, { Host: hostname })
      ).text();
      assert(customSitemap.includes('<loc>https://' + hostname + '/</loc>'));
      assert(customSitemap.includes('<lastmod>'));

      const { ingestEdgeBatch } = await import('../src/modules/telemetry.js'),
        now = Date.now();
      await workerPool.query(
        "INSERT INTO crawler_rule_snapshots(provider,role,user_agent_token,source_url,ranges,checksum,first_seen_at,fetched_at,expires_at) VALUES('OpenAI','search','OAI-SearchBot','https://openai.com/searchbot.json','[\"192.0.2.0/24\"]',$1,now()-interval '1 hour',now(),now()+interval '1 hour')",
        [suffix],
      );
      const edge = {
        observedAt: new Date(now).toISOString(),
        method: 'GET',
        clientIP: '192.0.2.1',
        userAgent: 'OAI-SearchBot/1.0',
        status: 200,
        contentType: 'text/html',
        synthetic: false,
      };
      const records = [
        {
          ...edge,
          requestID: suffix + '-hosted',
          host: 'localhost:3000',
          path: '/sites/' + placeID,
          deliveryID: queued.delivery.id,
        },
        {
          ...edge,
          requestID: suffix + '-custom',
          host: hostname,
          path: '/',
          deliveryID: migration.deliveryID,
        },
        {
          ...edge,
          requestID: suffix + '-synthetic',
          host: hostname,
          path: '/',
          deliveryID: migration.deliveryID,
          synthetic: true,
        },
        {
          ...edge,
          requestID: suffix + '-forged-host',
          host: 'unbound.example',
          path: '/',
          deliveryID: migration.deliveryID,
        },
        {
          ...edge,
          requestID: suffix + '-forged-place',
          host: 'localhost:3000',
          path: '/sites/wrong-place',
          deliveryID: queued.delivery.id,
        },
      ];
      assert.equal(
        (
          await ingestEdgeBatch({
            source: 'caddy-access',
            batchID: 'website-' + suffix,
            windowStart: new Date(now - 1).toISOString(),
            windowEnd: new Date(now + 1).toISOString(),
            coverage: 'partial',
            expectedRecords: records.length,
            records,
          })
        ).accepted,
        3,
      );
      assert.equal(
        (
          await workerPool.query(
            "SELECT count(*)::int AS n FROM crawler_events WHERE place_id=$1 AND synthetic=false AND verification='verified'",
            [placeID],
          )
        ).rows[0].n,
        2,
      );
      await expect(
        await mutation(
          base + `/destinations/${target.id}/disconnect`,
          { retainContent: true },
          owner,
        ),
        200,
      );
      assert.equal((await request('/sites/' + placeID)).status, 200);
      const pair = await expect(
        await mutation('/v1/adapter/pairings', {
          origin: 'https://branch.example',
          pageID: '12',
          pageURL: 'https://branch.example/business/',
          baseContentHash: sha256(''),
          pluginVersion: '1.0.0',
          rendererVersion: RENDERER_VERSION,
          templateHash: TEMPLATE_HASH,
        }),
        201,
      );
      const wp = (
          await expect(
            await mutation(
              base + '/destinations',
              {
                kind: 'wordpress',
                pairingCode: pair.code,
                metadataPermissions: ['canonical', 'schema'],
              },
              owner,
            ),
            201,
          )
        ).destination,
        machine = `/v1/adapter/installations/${pair.installationID}`;
      assert.equal(
        (
          await mutation(
            base + '/destinations',
            { kind: 'wordpress', pairingCode: pair.code },
            owner,
          )
        ).status,
        409,
      );
      await expect(
        await mutation(machine + `/pairings/${pair.pairingID}/confirm`, {}, pair.credential),
        202,
      );
      const controlFetch = async (url: string) => ({
        url,
        status: 200,
        headers: {},
        redirects: [],
        body: JSON.stringify({ installationID: pair.installationID, challenge: pair.challenge }),
      });
      for (let i = 0; i < 30; i++) {
        await processAccessCheckJob(controlFetch);
        if (
          (
            await workerPool.query('SELECT state FROM publication_destinations WHERE id=$1', [
              wp.id,
            ])
          ).rows[0].state === 'connected'
        )
          break;
      }
      const wpDraft = (
        await expect(
          await mutation(
            base + '/drafts',
            { basePlaceRevision: 2, profile: profile, rightsConfirmed: true },
            owner,
          ),
          201,
        )
      ).draft;
      const wpPreview = (
        await expect(
          await mutation(base + `/destinations/${wp.id}/preview`, { draftID: wpDraft.id }, owner),
          200,
        )
      ).preview;
      await workerPool.query('UPDATE service_grants SET revoked_at=now() WHERE tenant_id=$1', [
        tenant.id,
      ]);
      assert.equal(
        (
          await mutation(
            base + `/destinations/${wp.id}/publish`,
            { previewID: wpPreview.id, previewDigest: wpPreview.digest, approval: true },
            owner,
            { 'If-Match': '1' },
          )
        ).status,
        402,
      );
      await workerPool.query('UPDATE service_grants SET revoked_at=NULL WHERE tenant_id=$1', [
        tenant.id,
      ]);
      const wpQueued = await expect(
        await mutation(
          base + `/destinations/${wp.id}/publish`,
          { previewID: wpPreview.id, previewDigest: wpPreview.digest, approval: true },
          owner,
          { 'If-Match': '1' },
        ),
        202,
      );
      for (let i = 0; i < 30; i++) {
        await processPublishingJob();
        if (
          (
            await workerPool.query('SELECT status FROM publications WHERE id=$1', [
              wpQueued.publication.id,
            ])
          ).rows[0].status === 'live'
        )
          break;
      }
      await workerPool.query('UPDATE service_grants SET revoked_at=now() WHERE tenant_id=$1', [
        tenant.id,
      ]);
      for (let i = 0; i < 30; i++) {
        await processTargetPublicationJob();
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              wpQueued.delivery.id,
            ])
          ).rows[0].state === 'failed'
        )
          break;
      }
      assert.equal(
        (
          await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
            wpQueued.delivery.id,
          ])
        ).rows[0].state,
        'failed',
      );
      await workerPool.query('UPDATE service_grants SET revoked_at=NULL WHERE tenant_id=$1', [
        tenant.id,
      ]);
      await expect(
        await mutation(
          base + `/destinations/${wp.id}/retry`,
          { deliveryID: wpQueued.delivery.id },
          owner,
        ),
        202,
      );
      for (let i = 0; i < 30; i++) {
        await processTargetPublicationJob();
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              wpQueued.delivery.id,
            ])
          ).rows[0].state === 'awaiting_sync'
        )
          break;
      }
      const bundles = await expect(
        await request(machine + '/bundles', 'GET', undefined, pair.credential),
        200,
      );
      assert.equal(bundles.bundles.length, 1);
      const envelope = bundles.bundles[0],
        payload = verifyBundle(envelope);
      assert.equal(payload.managedHTML, wpPreview.managedFragment);
      assert.equal(payload.expectedOrigin, 'https://branch.example');
      assert.equal(payload.baseContentHash, sha256(''));
      assert.equal(
        (
          await mutation(
            machine + '/apply-leases',
            { bundleID: payload.bundleID, payloadDigest: sha256('wrong') },
            pair.credential,
          )
        ).status,
        409,
      );
      await workerPool.query("UPDATE memberships SET role='editor' WHERE tenant_id=$1", [
        tenant.id,
      ]);
      assert.equal(
        (
          await mutation(
            machine + '/apply-leases',
            { bundleID: payload.bundleID, payloadDigest: envelope.payloadDigest },
            pair.credential,
          )
        ).status,
        403,
      );
      await workerPool.query("UPDATE memberships SET role='owner' WHERE tenant_id=$1", [tenant.id]);
      await workerPool.query('UPDATE service_grants SET revoked_at=now() WHERE tenant_id=$1', [
        tenant.id,
      ]);
      assert.equal(
        (
          await mutation(
            machine + '/apply-leases',
            { bundleID: payload.bundleID, payloadDigest: envelope.payloadDigest },
            pair.credential,
          )
        ).status,
        402,
      );
      await workerPool.query('UPDATE service_grants SET revoked_at=NULL WHERE tenant_id=$1', [
        tenant.id,
      ]);
      const lease = await expect(
        await mutation(
          machine + '/apply-leases',
          { bundleID: payload.bundleID, payloadDigest: envelope.payloadDigest },
          pair.credential,
        ),
        201,
      );
      // Lost acknowledgement after a local write must reconcile publicly, never rewrite the page.
      await workerPool.query(
        "UPDATE adapter_apply_leases SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [sha256(lease.token)],
      );
      const receipt = {
        bundleID: payload.bundleID,
        payloadDigest: envelope.payloadDigest,
        state: 'applied',
        leaseToken: lease.token,
        contentHash: sha256(wordpressContent(payload.managedHTML)),
      };
      assert.equal(
        (await expect(await mutation(machine + '/receipts', receipt, pair.credential), 200)).state,
        'reconciling',
      );
      assert.equal(
        (await expect(await mutation(machine + '/receipts', receipt, pair.credential), 200)).state,
        'reconciling',
      );
      assert.equal(
        (
          await mutation(
            machine + '/receipts',
            { ...receipt, contentHash: sha256('changed') },
            pair.credential,
          )
        ).status,
        409,
      );
      const wpFetch = async (url: string) => ({
        url,
        status: 200,
        headers: {},
        redirects: [],
        body: url.endsWith('robots.txt')
          ? 'User-agent: *\nAllow: /'
          : url.endsWith('sitemap.xml')
            ? '<urlset/>'
            : wpPreview.html,
      });
      for (let i = 0; i < 30; i++) {
        await processAccessCheckJob(wpFetch);
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              wpQueued.delivery.id,
            ])
          ).rows[0].state === 'verified_live'
        )
          break;
      }
      assert.equal(
        (
          await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
            wpQueued.delivery.id,
          ])
        ).rows[0].state,
        'verified_live',
      );
      const second = (
        await expect(
          await mutation(
            base + '/drafts',
            {
              basePlaceRevision: 3,
              profile: {
                ...profile,
                summary:
                  'Another approved fixture revision, used only to test local conflict recovery.',
              },
              rightsConfirmed: true,
            },
            owner,
          ),
          201,
        )
      ).draft;
      const secondPreview = (
        await expect(
          await mutation(base + `/destinations/${wp.id}/preview`, { draftID: second.id }, owner),
          200,
        )
      ).preview;
      const secondQueued = await expect(
        await mutation(
          base + `/destinations/${wp.id}/publish`,
          { previewID: secondPreview.id, previewDigest: secondPreview.digest, approval: true },
          owner,
          { 'If-Match': '1' },
        ),
        202,
      );
      for (let i = 0; i < 30; i++) {
        await processPublishingJob();
        if (
          (
            await workerPool.query('SELECT status FROM publications WHERE id=$1', [
              secondQueued.publication.id,
            ])
          ).rows[0].status === 'live'
        )
          break;
      }
      for (let i = 0; i < 30; i++) {
        await processTargetPublicationJob();
        if (
          (
            await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [
              secondQueued.delivery.id,
            ])
          ).rows[0].state === 'awaiting_sync'
        )
          break;
      }
      const secondEnvelope = (
          await expect(await request(machine + '/bundles', 'GET', undefined, pair.credential), 200)
        ).bundles[0],
        secondPayload = verifyBundle(secondEnvelope),
        localHash = sha256('Local administrator changed the complete page content.');
      await expect(
        await mutation(
          machine + '/receipts',
          {
            bundleID: secondPayload.bundleID,
            payloadDigest: secondEnvelope.payloadDigest,
            state: 'conflict',
            contentHash: localHash,
            reason: 'Local page changed',
          },
          pair.credential,
        ),
        200,
      );
      const rollback = (
        await expect(
          await mutation(
            base + `/destinations/${wp.id}/rollback`,
            { deliveryID: wpQueued.delivery.id },
            owner,
          ),
          201,
        )
      ).draft;
      const rollbackPreview = (
        await expect(
          await mutation(base + `/destinations/${wp.id}/preview`, { draftID: rollback.id }, owner),
          200,
        )
      ).preview;
      assert.equal(rollbackPreview.baseContentHash, localHash);
      assert(rollbackPreview.sequence > secondPayload.sequence);
      assert.equal(rollback.profile.summary, wpDraft.profile.summary);
      await expect(
        await mutation(base + `/destinations/${wp.id}/disconnect`, { retainContent: true }, owner),
        200,
      );
      assert.equal(
        (
          await mutation(
            machine + '/apply-leases',
            { bundleID: payload.bundleID, payloadDigest: envelope.payloadDigest },
            pair.credential,
          )
        ).status,
        409,
      );
      assert.equal(
        (await expect(await request(machine + '/bundles', 'GET', undefined, pair.credential), 200))
          .bundles.length,
        0,
      );
    } finally {
      process.env.INTERNAL_API = oldInternal;
      for (const [name, value] of Object.entries({
        PUBLICATION_SIGNING_PRIVATE_KEY: savedKeys.private,
        PUBLICATION_SIGNING_KEY_ID: savedKeys.id,
        PUBLICATION_TRUSTED_KEYS_JSON: savedKeys.keys,
        PUBLICATION_REVOKED_KEY_IDS: savedKeys.revoked,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
