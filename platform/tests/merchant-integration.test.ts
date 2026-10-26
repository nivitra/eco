import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
test(
  'merchant claim review, tenant isolation, exact preview publication, replay and withdrawal',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { app } = await import('../src/app.js'),
      { pool, workerPool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js'),
      { processPublishingJob } = await import('../src/modules/publishing.js');
    const suffix = randomUUID(),
      placeID = 'merchant-test-' + suffix,
      testIP = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`;
    const priorInternal = process.env.INTERNAL_API;
    process.env.INTERNAL_API = 'true';
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
      extra: Record<string, string> = {},
    ) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': testIP,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const signup = async (label: string) => {
      const r = await request('/api/auth/sign-up/email', 'POST', {
        name: label,
        email: `${label}-${suffix}@example.test`,
        password: 'A-long-local-test-password!',
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.headers.get('set-auth-token')!;
    };
    const expect = async (r: Response, status: number) => {
      assert.equal(r.status, status, await r.clone().text());
      return r.json() as Promise<any>;
    };
    const profile = {
      name: 'Integration Café <script>bad()</script>',
      category: 'cafes',
      neighborhood: 'Jubilee Hills',
      address: 'Test-only Road 36, Jubilee Hills',
      summary: 'A test-only business record for transactional integration checks.',
      tags: ['Coffee'],
      phone: null,
      website: 'https://example.com',
      hoursText: null,
      entranceNote: 'Owner supplied only, not verified.',
    };
    try {
      await workerPool.query(
        `INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Integration fixture','cafes','Jubilee Hills','Test address','Test fixture only','2026-09-26','Fixture Hyderabad')`,
        [placeID],
      );
      const a = await signup('merchant-a'),
        b = await signup('merchant-b');
      const tenant = await expect(
          await request('/v1/tenants', 'POST', { name: 'Merchant integration workspace' }, a, {
            'Idempotency-Key': randomUUID(),
          }),
          201,
        ),
        prefix = `/v1/tenants/${tenant.id}`;
      const claim = await expect(
        await request(
          prefix + '/claims',
          'POST',
          {
            placeID,
            evidence: {
              description: 'Test-only ownership evidence reviewed by the integration operator.',
            },
          },
          a,
          { 'Idempotency-Key': randomUUID() },
        ),
        202,
      );
      assert.equal((await request(prefix + '/places', 'GET', undefined, b)).status, 404);
      const pendingDetail = await expect(
        await request(prefix + `/places/${placeID}`, 'GET', undefined, a),
        200,
      );
      assert.equal(pendingDetail.canEditDraft, true);
      const privateDraft = await expect(
        await request(
          prefix + `/places/${placeID}/drafts`,
          'POST',
          { basePlaceRevision: 1, profile, rightsConfirmed: false },
          a,
          { 'Idempotency-Key': randomUUID() },
        ),
        201,
      );
      assert.equal(
        (
          await request(
            prefix + `/places/${placeID}/drafts/${privateDraft.draft.id}/preview`,
            'GET',
            undefined,
            a,
          )
        ).status,
        403,
        'a submitted claim permits private edits but not publication preview',
      );
      assert.equal(
        (
          await request(
            `/v1/ops/claims/${claim.claim.id}/review`,
            'POST',
            { decision: 'approved', reason: 'Reviewed local integration test fixture.' },
            a,
          )
        ).status,
        403,
      );
      await expect(
        await request(
          `/v1/ops/claims/${claim.claim.id}/review`,
          'POST',
          { decision: 'approved', reason: 'Reviewed local integration test fixture.' },
          undefined,
          { 'X-Ops-Token': process.env.OPS_TOKEN! },
        ),
        200,
      );
      await workerPool.query(
        "INSERT INTO service_grants(tenant_id,place_id,kind,starts_at,ends_at,reason,issued_by) VALUES($1,$2,'pilot',now(),now()+interval '1 day','Integration fixture only','test')",
        [tenant.id, placeID],
      );
      const created = await expect(
          await request(
            prefix + `/places/${placeID}/drafts`,
            'POST',
            { basePlaceRevision: 1, profile, rightsConfirmed: true },
            a,
            { 'Idempotency-Key': randomUUID() },
          ),
          201,
        ),
        draftPath = prefix + `/places/${placeID}/drafts/${created.draft.id}`;
      assert.equal((await request(draftPath, 'GET', undefined, b)).status, 404);
      const first = await expect(await request(draftPath + '/preview', 'GET', undefined, a), 200);
      assert.equal(first.blockingIssues.length, 0);
      assert(!first.html.includes('<script>bad()'));
      const edited = await expect(
        await request(
          draftPath,
          'PATCH',
          {
            profile: {
              ...profile,
              summary: 'An updated test fixture with exact reviewed content.',
            },
            rightsConfirmed: true,
          },
          a,
          { 'If-Match': '"1"' },
        ),
        200,
      );
      assert.equal(edited.draft.version, 2);
      assert.equal(
        (
          await request(draftPath, 'PATCH', { profile, rightsConfirmed: true }, a, {
            'If-Match': '"1"',
          })
        ).status,
        412,
      );
      assert.equal(
        (
          await request(
            draftPath + '/publish',
            'POST',
            { approval: true, previewDigest: first.digest },
            a,
            { 'If-Match': '"2"', 'Idempotency-Key': randomUUID() },
          )
        ).status,
        409,
      );
      const preview = await expect(await request(draftPath + '/preview', 'GET', undefined, a), 200),
        publishKey = randomUUID();
      const queued = await expect(
        await request(
          draftPath + '/publish',
          'POST',
          { approval: true, previewDigest: preview.digest },
          a,
          { 'If-Match': '"2"', 'Idempotency-Key': publishKey },
        ),
        202,
      );
      const replay = await expect(
        await request(
          draftPath + '/publish',
          'POST',
          { approval: true, previewDigest: preview.digest },
          a,
          { 'If-Match': '"2"', 'Idempotency-Key': publishKey },
        ),
        202,
      );
      assert.equal(queued.publication.id, replay.publication.id);
      assert.equal(
        (
          await request(draftPath, 'PATCH', { profile, rightsConfirmed: true }, a, {
            'If-Match': '"2"',
          })
        ).status,
        409,
      );
      let live: any;
      for (let i = 0; i < 30; i++) {
        await processPublishingJob();
        live = (
          await workerPool.query('SELECT * FROM publications WHERE id=$1', [queued.publication.id])
        ).rows[0];
        if (live.status === 'live') break;
      }
      assert.equal(live.status, 'live');
      const page = await request(`/hyderabad/places/${placeID}`);
      assert.equal(page.status, 200);
      assert.equal(await page.text(), preview.html);
      const publicPlace = await expect(await request(`/v1/places/${placeID}`), 200);
      assert.equal(publicPlace.place?.id ?? publicPlace.id, placeID);
      const visibility = await expect(
        await request(prefix + `/places/${placeID}/visibility`, 'GET', undefined, a),
        200,
      );
      if (visibility.coverage.status === 'unavailable') assert.equal(visibility.metrics.length, 0);
      await expect(
        await request(
          `/v1/ops/publications/${queued.publication.id}/withdraw`,
          'POST',
          { reason: 'Withdraw test fixture after checking atomic publication.' },
          undefined,
          { 'X-Ops-Token': process.env.OPS_TOKEN! },
        ),
        200,
      );
      assert.equal((await request(`/hyderabad/places/${placeID}`)).status, 404);
      assert(!(await (await request('/sitemap.xml')).text()).includes(placeID));
      assert.equal((await request(`/v1/places/${placeID}`)).status, 404);
      const withdrawn = await expect(
        await request(prefix + `/places/${placeID}`, 'GET', undefined, a),
        200,
      );
      assert.equal(withdrawn.latestPublication.status, 'withdrawn');
      assert.equal(withdrawn.place.revision, 2);
      assert.equal((await request(prefix + `/places/${placeID}`, 'GET', undefined, b)).status, 404);
      await expect(
        await request(
          prefix + `/places/${placeID}/drafts`,
          'POST',
          { basePlaceRevision: 2, profile, rightsConfirmed: true },
          a,
          { 'Idempotency-Key': randomUUID() },
        ),
        201,
      );
    } finally {
      process.env.INTERNAL_API = priorInternal;
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
