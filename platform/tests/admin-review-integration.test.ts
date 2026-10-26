import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test(
  'admin queue requires an allowlisted session and reviews claims through the private operator service',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { app } = await import('../src/app.js');
    const { pool, workerPool } = await import('../src/db.js');
    const { authPool } = await import('../src/auth.js');
    const { config } = await import('../src/config.js');
    const suffix = randomUUID();
    const placeID = 'admin-review-test-' + suffix;
    const originalFetch = globalThis.fetch;
    const priorInternal = process.env.INTERNAL_API;
    const priorReviewOnly = process.env.ADMIN_REVIEW_ONLY;
    process.env.INTERNAL_API = 'true';
    let adminID = '';
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
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const checked = async (response: Response, status: number) => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json() as Promise<any>;
    };
    try {
      await workerPool.query(
        `INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query)
         VALUES($1,$1,'Admin review fixture','business','Test locality','Test-only address','Test fixture only','2026-10-26','Admin fixture')`,
        [placeID],
      );
      const signup = await request('/api/auth/sign-up/email', 'POST', {
        name: 'Review fixture owner',
        email: `review-${suffix}@example.test`,
        password: 'Isolated-test-password-123!',
      });
      const owner = await checked(signup, 200);
      adminID = owner.user.id;
      const token = signup.headers.get('set-auth-token')!;
      const tenant = await checked(
        await request('/v1/tenants', 'POST', { name: 'Review fixture workspace' }, token, {
          'Idempotency-Key': randomUUID(),
        }),
        201,
      );
      const submitted = await checked(
        await request(
          `/v1/tenants/${tenant.id}/claims`,
          'POST',
          {
            placeID,
            evidence: { description: 'Isolated test evidence. No actual business ownership is asserted.' },
          },
          token,
          { 'Idempotency-Key': randomUUID() },
        ),
        202,
      );
      await checked(await request('/v1/admin/claims'), 401);
      await checked(await request('/v1/admin/claims', 'GET', undefined, token), 403);
      config.adminUserIDs.push(adminID);
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname !== 'admin-review') return originalFetch(input, init);
        process.env.ADMIN_REVIEW_ONLY = 'true';
        try {
          return await app.request('http://admin-review:3000' + url.pathname + url.search, init);
        } finally {
          process.env.ADMIN_REVIEW_ONLY = priorReviewOnly;
        }
      };
      const queue = await checked(await request('/v1/admin/claims', 'GET', undefined, token), 200);
      const item = queue.claims.find((claim: any) => claim.id === submitted.claim.id);
      assert(item, 'the submitted claim appears in the admin queue');
      assert.equal(item.placeName, 'Admin review fixture');
      assert.equal(item.submitter.email, `review-${suffix}@example.test`);
      assert.equal(item.evidence.description.startsWith('Isolated test evidence'), true);
      const reviewed = await checked(
        await request(
          `/v1/admin/claims/${item.id}/review`,
          'POST',
          { decision: 'approved', reason: 'Independent verification completed for isolated test fixture.' },
          token,
        ),
        200,
      );
      assert.equal(reviewed.claim.state, 'approved');
      await checked(
        await request(
          `/v1/admin/claims/${item.id}/review`,
          'POST',
          { decision: 'approved', reason: 'Second approval must be rejected.' },
          token,
        ),
        409,
      );
      const audit = await workerPool.query(
        "SELECT actor_id FROM audit_log WHERE action='claim.reviewed' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
        [item.id],
      );
      assert.equal(audit.rows[0].actor_id, 'admin:' + adminID);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.INTERNAL_API = priorInternal;
      process.env.ADMIN_REVIEW_ONLY = priorReviewOnly;
      if (adminID) {
        const index = config.adminUserIDs.indexOf(adminID);
        if (index >= 0) config.adminUserIDs.splice(index, 1);
      }
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
