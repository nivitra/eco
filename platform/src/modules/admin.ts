import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { HttpError } from '../db.js';

const uuid = z.string().uuid();
const reviewBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

async function requireAdmin(c: Context) {
  const user = await requireUser(c);
  if (!config.adminUserIDs.includes(user.id))
    throw new HttpError(403, 'admin_required', 'This account is not allowed to review claims');
  if (process.env.NODE_ENV === 'production' && !user.emailVerified)
    throw new HttpError(403, 'verified_admin_required', 'Verify your email before reviewing claims');
  return user;
}

async function reviewService(path: string, method = 'GET', body?: unknown, actor?: string) {
  let response: Response;
  try {
    response = await fetch('http://admin-review:3000' + path, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/json',
        'X-Ops-Token': config.opsToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor ? { 'X-Review-Actor': actor } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new HttpError(503, 'review_unavailable', 'Claim review service is unavailable');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new HttpError(
      response.status,
      data?.error?.code || 'review_failed',
      data?.error?.message || 'The review could not be completed',
    );
  if (!data) throw new HttpError(502, 'review_invalid_response', 'Claim review service returned no data');
  return data;
}

export function registerAdmin(app: Hono) {
  app.get('/v1/admin/me', async (c) => {
    const user = await requireAdmin(c);
    return c.json({ user: { id: user.id, name: user.name, email: user.email } });
  });
  app.get('/v1/admin/claims', async (c) => {
    await requireAdmin(c);
    const state = z
      .enum(['submitted', 'approved', 'rejected', 'revoked', 'disputed', 'all'])
      .parse(c.req.query('state') || 'submitted');
    const offset = z.coerce.number().int().min(0).max(10000).parse(c.req.query('offset') || 0);
    const data = await reviewService(
      `/v1/ops/claims?state=${encodeURIComponent(state)}&offset=${offset}`,
    );
    return c.json(data);
  });
  app.post('/v1/admin/claims/:claimID/review', async (c) => {
    const user = await requireAdmin(c);
    const id = uuid.parse(c.req.param('claimID'));
    const body = reviewBody.parse(await c.req.json());
    const data = await reviewService(
      `/v1/ops/claims/${id}/review`,
      'POST',
      body,
      'admin:' + user.id,
    );
    return c.json(data);
  });
}
