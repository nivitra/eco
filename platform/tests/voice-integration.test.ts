import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test(
  'real signed-session voice route applies durable user quota and exposes no provider key',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { app } = await import('../src/app.js');
    const { config } = await import('../src/config.js');
    const { pool, workerPool, consumeQuota } = await import('../src/db.js');
    const { authPool } = await import('../src/auth.js');
    const suffix = randomUUID();
    const ip = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::55`;
    const request = (path: string, method = 'GET', body?: unknown, token?: string) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': ip,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const oldKey = config.sonioxKey,
      oldMapbox = config.mapboxPublicToken,
      oldFetch = globalThis.fetch;
    let calls = 0,
      token: string | null = null;
    config.sonioxKey = 'test-only-server-voice-key';
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://api.soniox.com/v1/auth/temporary-api-key')
        return oldFetch(input, init);
      calls++;
      return Response.json(
        {
          api_key: 'snx_temp_' + 'fake-single-use-test-value'.repeat(2),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
        { status: 201 },
      );
    };
    try {
      config.mapboxPublicToken = 'sk.' + 'secret-test-value-'.repeat(3);
      const disabledMaps = await request('/v1/maps/client-config');
      assert.equal(disabledMaps.status, 200);
      assert.deepEqual(await disabledMaps.json(), {
        enabled: false,
        publicToken: '',
        styleURL: 'mapbox://styles/mapbox/dark-v11',
      });
      config.mapboxPublicToken = 'pk.' + 'public-test-value-'.repeat(3);
      const enabledMaps = (await (await request('/v1/maps/client-config')).json()) as any;
      assert.equal(enabledMaps.enabled, true);
      assert.equal(enabledMaps.publicToken, config.mapboxPublicToken);
      const anonymous = await request('/v1/voice/session', 'POST', {});
      assert.equal(anonymous.status, 401);
      assert.equal(calls, 0);
      assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
      const signup = await request('/api/auth/sign-up/email', 'POST', {
        name: 'Voice test',
        email: `voice-${suffix}@example.test`,
        password: 'Voice-test-long-password!',
      });
      assert.equal(signup.status, 200);
      token = signup.headers.get('set-auth-token');
      assert.ok(token);
      const capabilities = (await (await request('/v1/capabilities')).json()) as any;
      assert.equal(capabilities.voice.configured, true);
      const session = await request('/v1/voice/session', 'POST', {}, token);
      assert.equal(session.status, 200);
      assert.equal(calls, 1);
      assert.equal(session.headers.get('cache-control'), 'private, no-store');
      assert.ok(!(await session.text()).includes(config.sonioxKey));
      const me = (await (await request('/v1/me', 'GET', undefined, token)).json()) as any;
      for (let i = 1; i < 5; i++) await consumeQuota(`voice:user:minute:${me.user.id}`, 5, 60);
      const limited = await request('/v1/voice/session', 'POST', {}, token);
      assert.equal(limited.status, 429);
      assert.equal(calls, 1);
      assert.equal(limited.headers.get('cache-control'), 'private, no-store');
      await request('/api/auth/sign-out', 'POST', {}, token);
      assert.equal((await request('/v1/voice/session', 'POST', {}, token)).status, 401);
    } finally {
      globalThis.fetch = oldFetch;
      config.sonioxKey = oldKey;
      config.mapboxPublicToken = oldMapbox;
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
