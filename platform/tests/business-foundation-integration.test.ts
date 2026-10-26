import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test(
  'business onboarding, branch roles, recipient-bound invitations, CSRF and interval entitlements',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async (t) => {
    const { app } = await import('../src/app.js'),
      { workerPool, pool, withActor } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js'),
      { config } = await import('../src/config.js'),
      { locationEntitlement } = await import('../src/modules/entitlements.js');
    const suffix = randomUUID(),
      ip = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}`;
    let n = 1;
    const req = (
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
          'X-Real-IP': `${ip}::${n}`,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const checked = async (r: Response, status = 200) => {
      assert.equal(r.status, status, await r.clone().text());
      return r.json() as Promise<any>;
    };
    const signup = async (label: string) => {
      n++;
      const email = `business-${label}-${suffix}@example.test`,
        r = await req('/api/auth/sign-up/email', 'POST', {
          name: label,
          email,
          password: 'Test-workspace-long-password!',
        });
      const body = await checked(r);
      return {
        email,
        id: body.user.id,
        token: r.headers.get('set-auth-token')!,
        cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '',
      };
    };
    try {
      const owner = await signup('owner'),
        manager = await signup('manager'),
        outsider = await signup('outsider');
      const tenant = (
        await checked(
          await req('/v1/tenants', 'POST', { name: 'Business foundation fixture' }, owner.token, {
            'Idempotency-Key': randomUUID(),
          }),
          201,
        )
      ).id;
      const profile = {
        name: 'Clinic fixture ' + suffix,
        businessType: 'healthcare',
        category: 'business',
        neighborhood: 'Jubilee Hills',
        address: 'Test clinic, Road 45, Jubilee Hills',
        summary: 'Isolated private business onboarding fixture for tests.',
        tags: [],
        locality: {
          country: 'IN',
          state: 'Telangana',
          city: 'Hyderabad',
          citySlug: 'hyderabad',
          locality: 'Jubilee Hills',
          street: 'Road 45',
          postalCode: '500033',
        },
      };
      const body = {
        profile,
        evidence: {
          description: 'This is an isolated test fixture with no real-world ownership assertion.',
        },
      };
      const k = randomUUID(),
        created = await checked(
          await req(`/v1/tenants/${tenant}/locations`, 'POST', body, owner.token, {
            'Idempotency-Key': k,
          }),
          202,
        ),
        pid = created.place.id;
      assert.equal(
        (
          await checked(
            await req(`/v1/tenants/${tenant}/locations`, 'POST', body, owner.token, {
              'Idempotency-Key': k,
            }),
            202,
          )
        ).place.id,
        pid,
        'creation replay preserves identity',
      );
      assert.equal(
        (await req('/v1/places/' + pid)).status,
        404,
        'private new location is not public',
      );
      assert.equal(
        (await withActor(outsider.id, (db) => db.query('SELECT id FROM places WHERE id=$1', [pid])))
          .rowCount,
        0,
        'RLS hides pending submissions',
      );
      const catalog = await checked(await req('/v1/catalog'));
      assert(
        !catalog.places.some((p: any) => p.id === pid),
        'clinic does not enter leisure catalog',
      );
      await checked(
        await req(
          `/v1/ops/claims/${created.claim.id}/review`,
          'POST',
          { decision: 'approved', reason: 'Isolated test reviewer decision only.' },
          undefined,
          { 'X-Ops-Token': config.opsToken },
        ),
      );
      const now = new Date();
      const entitlement = (at = now) =>
        withActor(owner.id, (db) =>
          locationEntitlement(db, { tenantID: tenant, placeID: pid, capability: 'publish', at }),
        );
      assert.equal((await entitlement()).allowed, false, 'no implicit pilot');
      const grant = (
        await checked(
          await req(
            '/v1/ops/pilot-grants',
            'POST',
            {
              tenantID: tenant,
              placeID: pid,
              startsAt: new Date(now.getTime() - 1000).toISOString(),
              endsAt: new Date(now.getTime() + 3600000).toISOString(),
              reason: 'Explicit bounded test pilot only',
            },
            undefined,
            { 'X-Ops-Token': config.opsToken },
          ),
          201,
        )
      ).grant;
      assert.equal((await entitlement()).source, 'pilot');
      await checked(
        await req('/v1/ops/pilot-grants/' + grant.id + '/revoke', 'POST', {}, undefined, {
          'X-Ops-Token': config.opsToken,
        }),
      );
      assert.equal((await entitlement()).allowed, false);
      const sid = randomUUID();
      await workerPool.query(
        "INSERT INTO subscriptions(id,tenant_id,place_id,status) VALUES($1,$2,$3,'active')",
        [sid, tenant, pid],
      );
      const start = new Date(now.getTime() + 86400000),
        end = new Date(now.getTime() + 31 * 86400000);
      await workerPool.query(
        "INSERT INTO payment_ledger(payment_id,subscription_id,amount_minor,currency,period_start,paid_until,invoice_id) VALUES($1,$2,29900,'INR',$3,$4,$5)",
        ['pay_' + suffix, sid, start, end, 'inv_' + suffix],
      );
      assert.equal(
        (await entitlement()).allowed,
        false,
        'future paid interval does not activate early',
      );
      assert.equal(
        (await entitlement(new Date(start.getTime() + 1))).source,
        'paid',
        'future coverage activates by time without another webhook',
      );
      await workerPool.query(
        "UPDATE subscriptions SET status='cancelled',cancel_at_period_end=true WHERE id=$1",
        [sid],
      );
      assert.equal(
        (await entitlement(new Date(start.getTime() + 1))).source,
        'paid',
        'cancelled service lasts through captured period',
      );
      await workerPool.query(
        "UPDATE subscriptions SET status='pending',cancel_at_period_end=false,renewal_failed_at=$2 WHERE id=$1",
        [sid, end],
      );
      assert.equal((await entitlement(new Date(end.getTime() + 86400000))).source, 'grace');
      assert.equal((await entitlement(new Date(end.getTime() + 8 * 86400000))).allowed, false);
      await workerPool.query(
        'UPDATE payment_ledger SET refunded_at=now() WHERE subscription_id=$1',
        [sid],
      );
      assert.equal(
        (await entitlement(new Date(end.getTime() + 86400000))).allowed,
        false,
        'refunded payment grants no grace',
      );
      const invite = await checked(
          await req(
            `/v1/tenants/${tenant}/invitations`,
            'POST',
            {
              email: manager.email,
              permissions: {
                role: 'manager',
                scopeMode: 'selected',
                placeIDs: [pid],
                canPublish: false,
                canManageDestinations: false,
              },
            },
            owner.token,
            { 'Idempotency-Key': randomUUID() },
          ),
          201,
        ),
        inviteToken = invite.acceptURL.split('#invite=')[1];
      assert.equal(
        (await req('/v1/team/invitations/accept', 'POST', { token: inviteToken }, manager.token))
          .status,
        403,
        'unverified email cannot claim recipient identity',
      );
      await authPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=ANY($1::text[])', [
        [manager.id, outsider.id],
      ]);
      assert.equal(
        (await req('/v1/team/invitations/accept', 'POST', { token: inviteToken }, outsider.token))
          .status,
        404,
        'different verified recipient cannot accept',
      );
      await checked(
        await req('/v1/team/invitations/accept', 'POST', { token: inviteToken }, manager.token),
      );
      assert.equal(
        (await req('/v1/team/invitations/accept', 'POST', { token: inviteToken }, manager.token))
          .status,
        404,
        'single use',
      );
      const me = await checked(await req('/v1/me', 'GET', undefined, manager.token));
      assert.deepEqual(me.tenants[0].placeIDs, [pid]);
      assert.equal(me.tenants[0].canPublish, false);
      assert.equal(
        (
          await req(
            `/v1/tenants/${tenant}/places/${pid}/drafts/${created.draft.id}/publish`,
            'POST',
            { approval: true, previewDigest: 'a'.repeat(64) },
            manager.token,
            { 'If-Match': '1', 'Idempotency-Key': randomUUID() },
          )
        ).status,
        403,
        'manager without grant cannot publish',
      );
      const second = 'scope-other-' + suffix;
      await workerPool.query(
        "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Other branch','cafes','Jubilee Hills','Test address','Other isolated branch','2026-09-29','Test')",
        [second],
      );
      await workerPool.query(
        "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{}','approved',now())",
        [tenant, second, owner.id],
      );
      assert.equal(
        (
          await withActor(manager.id, (db) =>
            db.query('SELECT id FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2', [
              tenant,
              second,
            ]),
          )
        ).rowCount,
        0,
        'assigned manager cannot read another branch',
      );
      assert.equal(
        (await req(`/v1/tenants/${tenant}/places/${second}`, 'GET', undefined, manager.token))
          .status,
        404,
      );
      const badScope = {
        role: 'manager',
        scopeMode: 'selected',
        placeIDs: [pid, pid],
        canPublish: false,
        canManageDestinations: false,
      };
      assert.equal(
        (
          await req(
            `/v1/tenants/${tenant}/invitations`,
            'POST',
            { email: 'duplicate@example.test', permissions: badScope },
            owner.token,
            { 'Idempotency-Key': randomUUID() },
          )
        ).status,
        400,
        'duplicate scope IDs fail before invitation creation',
      );
      assert.equal(
        (
          await req(
            `/v1/tenants/${tenant}/members/${manager.id}`,
            'PATCH',
            { state: 'active', permissions: badScope },
            owner.token,
          )
        ).status,
        400,
        'duplicate scope IDs cannot break member update',
      );
      assert.equal(
        (
          await req(
            '/v1/service-requests',
            'POST',
            {
              tenantID: tenant,
              placeID: second,
              kind: 'support',
              message: 'Attempt an unassigned location request',
            },
            manager.token,
            { 'Idempotency-Key': randomUUID() },
          )
        ).status,
        404,
        'support requests cannot forge a workspace branch association',
      );
      const unassigned = await checked(
        await req(
          `/v1/tenants/${tenant}/locations`,
          'POST',
          { ...body, profile: { ...profile, name: 'Unassigned pending ' + suffix } },
          owner.token,
          { 'Idempotency-Key': randomUUID() },
        ),
        202,
      );
      assert.equal(
        (
          await withActor(manager.id, (db) =>
            db.query('SELECT id FROM places WHERE id=$1', [unassigned.place.id]),
          )
        ).rowCount,
        0,
        'branch-scoped RLS hides another pending location in the same workspace',
      );
      const cookie = owner.cookie;
      assert(cookie);
      assert.equal(
        (
          await req('/v1/tenants', 'POST', { name: 'CSRF probe' }, undefined, {
            Cookie: cookie,
            Origin: 'https://attacker.example',
            'Idempotency-Key': randomUUID(),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req('/v1/tenants', 'POST', { name: 'No origin probe' }, undefined, {
            Cookie: cookie,
            'Idempotency-Key': randomUUID(),
          })
        ).status,
        403,
      );
      await checked(
        await req(
          '/v1/service-requests',
          'POST',
          {
            tenantID: tenant,
            placeID: pid,
            kind: 'correction',
            message: 'Incorrect entrance needs a reviewed correction.',
          },
          owner.token,
          { 'Idempotency-Key': randomUUID() },
        ),
        202,
      );
      const exported = await checked(
        await req(`/v1/tenants/${tenant}/places/${pid}/export`, 'GET', undefined, owner.token),
      );
      assert.equal(exported.place.id, pid);
      assert(!JSON.stringify(exported).includes('token_hash'));
    } finally {
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
