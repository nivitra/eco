import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context, Hono } from 'hono';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { consumeQuota, HttpError } from '../db.js';
import { boundedJSON } from './ai.js';

const TOKEN_ENDPOINT = 'https://api.soniox.com/v1/auth/temporary-api-key';
export const VOICE_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const VOICE_MAX_DURATION_SECONDS = 60;

/** Client receives a single-use key only. Audio flows directly to Soniox. */
export function validateVoiceToken(value: unknown, now = Date.now()) {
  const data = value as Record<string, unknown> | null;
  if (
    !data ||
    typeof data.api_key !== 'string' ||
    !/^snx_temp_[A-Za-z0-9._-]{24,2040}$/.test(data.api_key) ||
    typeof data.expires_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(data.expires_at)
  ) {
    throw new HttpError(
      502,
      'invalid_voice_session',
      'Voice could not start securely. Please try again.',
    );
  }
  const expiry = Date.parse(data.expires_at);
  // Leave enough time to connect; reject unexpectedly long-lived credentials.
  if (!Number.isFinite(expiry) || expiry <= now + 5_000 || expiry > now + 75_000) {
    throw new HttpError(
      502,
      'invalid_voice_session',
      'Voice could not start securely. Please try again.',
    );
  }
  return { apiKey: data.api_key, expiresAt: new Date(expiry).toISOString() };
}

interface VoiceDependencies {
  authenticate: (c: Context) => Promise<{ id: string }>;
  quota: typeof consumeQuota;
  fetch: typeof globalThis.fetch;
}

/** The edge overwrites X-Real-IP. The API container is not publicly exposed. */
export function voiceIPQuotaKey(raw: string | undefined, now = new Date()) {
  const address = raw && isIP(raw) ? raw : 'unknown';
  return createHmac('sha256', config.authSecret)
    .update(now.toISOString().slice(0, 10) + '|' + address)
    .digest('hex');
}

export function registerVoice(app: Hono, overrides: Partial<VoiceDependencies> = {}) {
  const dependencies: VoiceDependencies = {
    authenticate: requireUser,
    quota: consumeQuota,
    fetch: (...args) => globalThis.fetch(...args),
    ...overrides,
  };
  app.post('/v1/voice/session', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Pragma', 'no-cache');
    c.header('Vary', 'Authorization, Cookie');
    const user = await dependencies.authenticate(c);
    if (!config.sonioxKey)
      throw new HttpError(
        503,
        'voice_not_configured',
        'Voice is not available on this server yet. You can type your message.',
      );
    // No client-supplied durations, tracking IDs, provider URLs, or audio input.
    const raw = await c.req.text();
    if (
      raw &&
      (raw.length > 128 ||
        (() => {
          try {
            const parsed = JSON.parse(raw);
            return (
              !parsed ||
              Array.isArray(parsed) ||
              typeof parsed !== 'object' ||
              Object.keys(parsed).length !== 0
            );
          } catch {
            return true;
          }
        })())
    )
      throw new HttpError(
        400,
        'invalid_voice_request',
        'Start voice without additional request fields.',
      );

    const ip = voiceIPQuotaKey(c.req.header('X-Real-IP'));
    await dependencies.quota(`voice:ip:minute:${ip}`, 30, 60);
    await dependencies.quota(`voice:ip:daily:${ip}`, 200, 86400);
    await dependencies.quota(`voice:user:minute:${user.id}`, 5, 60);
    await dependencies.quota(`voice:user:daily:${user.id}`, config.voiceDailyLimit, 86400);
    let response: Response;
    try {
      response = await dependencies.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]),
        headers: {
          Authorization: `Bearer ${config.sonioxKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          usage_type: 'transcribe_websocket',
          expires_in_seconds: 60,
          single_use: true,
          max_session_duration_seconds: 90,
          client_reference_id: randomUUID(),
        }),
      });
    } catch {
      throw new HttpError(
        503,
        'voice_provider_unavailable',
        'Voice could not connect. Please try again or type your message.',
      );
    }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        response.status === 429 ? 429 : 503,
        'voice_provider_unavailable',
        'Voice is temporarily unavailable. Please try again or type your message.',
      );
    }
    let token: ReturnType<typeof validateVoiceToken>;
    try {
      token = validateVoiceToken(await boundedJSON(response, 8_192));
    } catch {
      throw new HttpError(
        502,
        'invalid_voice_session',
        'Voice could not start securely. Please try again.',
      );
    }
    if (token.apiKey === config.sonioxKey)
      throw new HttpError(
        502,
        'invalid_voice_session',
        'Voice could not start securely. Please try again.',
      );
    return c.json({
      ...token,
      websocketURL: VOICE_WEBSOCKET_URL,
      model: config.sonioxModel,
      maxDurationSeconds: VOICE_MAX_DURATION_SECONDS,
    });
  });
}
