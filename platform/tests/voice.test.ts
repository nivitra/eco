import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { registerVoice, validateVoiceToken, voiceIPQuotaKey } = await import(
  '../src/modules/voice.js'
);
const { config } = await import('../src/config.js');
const { HttpError } = await import('../src/db.js');
const temporary = 'snx_temp_' + 'test-only-not-a-real-credential'.repeat(2);
const providerReply = () => ({
  api_key: temporary,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});
type Overrides = NonNullable<Parameters<typeof registerVoice>[1]>;

function harness(overrides: Overrides = {}) {
  const app = new Hono();
  const quotas: { key: string; max: number; seconds: number }[] = [];
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  registerVoice(app, {
    authenticate: async () => ({ id: 'test-user-only' }),
    quota: async (key, max, seconds) => {
      quotas.push({ key, max, seconds });
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json(providerReply(), { status: 201 });
    },
    ...overrides,
  });
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    throw error;
  });
  const request = (body = '{}') =>
    app.request('http://localhost:3000/v1/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': '192.0.2.25' },
      body,
    });
  return { request, quotas, requests };
}
async function withTestKey(work: () => Promise<void>) {
  const previous = config.sonioxKey;
  config.sonioxKey = 'server-only-fake-credential';
  try {
    await work();
  } finally {
    config.sonioxKey = previous;
  }
}
function privateResponse(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('vary'), 'Authorization, Cookie');
}

test('voice issues only constrained temporary credential with fixed endpoints and opaque reference', async () =>
  withTestKey(async () => {
    const h = harness();
    const response = await h.request();
    assert.equal(response.status, 200);
    privateResponse(response);
    const data = (await response.json()) as any;
    assert.deepEqual(Object.keys(data).sort(), [
      'apiKey',
      'expiresAt',
      'maxDurationSeconds',
      'model',
      'websocketURL',
    ]);
    assert.equal(data.apiKey, temporary);
    assert.equal(data.maxDurationSeconds, 60);
    assert.equal(data.websocketURL, 'wss://stt-rt.soniox.com/transcribe-websocket');
    assert.equal(data.model, config.sonioxModel);
    assert.equal(h.requests.length, 1);
    const sent = h.requests[0];
    assert.equal(sent.url, 'https://api.soniox.com/v1/auth/temporary-api-key');
    assert.equal(sent.options?.redirect, 'error');
    assert.ok(sent.options?.signal);
    assert.equal(
      new Headers(sent.options?.headers).get('Authorization'),
      'Bearer server-only-fake-credential',
    );
    const body = JSON.parse(String(sent.options?.body));
    assert.equal(body.usage_type, 'transcribe_websocket');
    assert.equal(body.expires_in_seconds, 60);
    assert.equal(body.single_use, true);
    assert.equal(body.max_session_duration_seconds, 90);
    assert.match(body.client_reference_id, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes('test-user-only'));
    assert.equal(h.quotas.length, 4);
    assert.deepEqual(
      h.quotas.map((q) => [q.max, q.seconds]),
      [
        [30, 60],
        [200, 86400],
        [5, 60],
        [config.voiceDailyLimit, 86400],
      ],
    );
    assert.ok(h.quotas.every((q) => !q.key.includes('192.0.2.25')));
  }));

test('unauthenticated voice request cannot consume quota or issue a credential', async () =>
  withTestKey(async () => {
    const h = harness({
      authenticate: async () => {
        throw new HttpError(401, 'sign_in_required', 'Sign in.');
      },
    });
    const response = await h.request();
    assert.equal(response.status, 401);
    privateResponse(response);
    assert.equal(h.quotas.length, 0);
    assert.equal(h.requests.length, 0);
  }));
test('unconfigured voice stays unavailable without contacting provider', async () => {
  const previous = config.sonioxKey;
  config.sonioxKey = '';
  try {
    const h = harness();
    const response = await h.request();
    assert.equal(response.status, 503);
    privateResponse(response);
    assert.equal(((await response.json()) as any).error.code, 'voice_not_configured');
    assert.equal(h.requests.length, 0);
  } finally {
    config.sonioxKey = previous;
  }
});
test('both per-user and shared-IP quota failures stop before upstream', async () =>
  withTestKey(async () => {
    for (const failingPrefix of [
      'voice:ip:minute:',
      'voice:ip:daily:',
      'voice:user:minute:',
      'voice:user:daily:',
    ]) {
      const h = harness({
        quota: async (key) => {
          if (key.startsWith(failingPrefix)) throw new HttpError(429, 'rate_limited', 'Wait.');
        },
      });
      const response = await h.request();
      assert.equal(response.status, 429);
      privateResponse(response);
      assert.equal(h.requests.length, 0);
    }
  }));
test('client cannot override voice limits or submit audio through this endpoint', async () =>
  withTestKey(async () => {
    for (const body of [
      '{"expires_in_seconds":3600}',
      '{"audio":"data"}',
      'null',
      '[]',
      'not-json',
      '{"url":"https://example.test"}',
    ]) {
      const h = harness();
      const response = await h.request(body);
      assert.equal(response.status, 400);
      privateResponse(response);
      assert.equal(h.requests.length, 0);
      assert.equal(h.quotas.length, 0);
    }
  }));
test('provider errors and network failures never reflect provider secrets or body', async () =>
  withTestKey(async () => {
    for (const status of [301, 400, 401, 429, 500]) {
      const h = harness({
        fetch: async () => new Response('private-provider-secret-and-message', { status }),
      });
      const response = await h.request();
      assert.equal(response.status, status === 429 ? 429 : 503);
      privateResponse(response);
      const text = await response.text();
      assert.ok(!text.includes('private-provider-secret'));
      assert.ok(!text.includes('server-only-fake'));
    }
    const h = harness({
      fetch: async () => {
        throw new Error('private-provider-secret');
      },
    });
    const response = await h.request();
    assert.equal(response.status, 503);
    privateResponse(response);
    assert.ok(!(await response.text()).includes('private-provider-secret'));
  }));
test('expired, long-lived, malformed and interrupted provider replies fail closed without caching', async () =>
  withTestKey(async () => {
    const now = Date.now();
    const invalid = [
      null,
      {},
      { api_key: 'long-lived-master-key', expires_at: new Date(now + 60000).toISOString() },
      { ...providerReply(), expires_at: 'invalid' },
      { ...providerReply(), expires_at: new Date(now - 1000).toISOString() },
      { ...providerReply(), expires_at: new Date(now + 3600000).toISOString() },
      { ...providerReply(), api_key: temporary + '\n' },
    ];
    for (const body of invalid) {
      const h = harness({ fetch: async () => Response.json(body, { status: 201 }) });
      const response = await h.request();
      assert.equal(response.status, 502);
      privateResponse(response);
      assert.ok(!(await response.text()).includes(temporary));
    }
    for (const body of ['invalid-json', 'x'.repeat(8193)]) {
      const h = harness({ fetch: async () => new Response(body, { status: 201 }) });
      assert.equal((await h.request()).status, 502);
    }
  }));
test('temporary token expiry edge and IP quota privacy remain bounded', () => {
  const now = Date.now();
  assert.equal(validateVoiceToken(providerReply(), now).apiKey, temporary);
  assert.throws(() =>
    validateVoiceToken({ ...providerReply(), expires_at: new Date(now + 4999).toISOString() }, now),
  );
  const today = new Date('2026-10-09T12:00:00Z');
  assert.equal(voiceIPQuotaKey('192.0.2.25', today), voiceIPQuotaKey('192.0.2.25', today));
  assert.notEqual(
    voiceIPQuotaKey('192.0.2.25', today),
    voiceIPQuotaKey('192.0.2.25', new Date('2026-10-10T12:00:00Z')),
  );
  assert.equal(voiceIPQuotaKey('bad-header', today), voiceIPQuotaKey(undefined, today));
});
