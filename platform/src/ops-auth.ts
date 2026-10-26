import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { config } from './config.js';
import { HttpError } from './db.js';

export function requireOps(c: Context): void {
  if (process.env.INTERNAL_API !== 'true') throw new HttpError(404, 'not_found', 'Route not found');
  const incoming = Buffer.from(c.req.header('X-Ops-Token') || '');
  const expected = Buffer.from(config.opsToken);
  if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected))
    throw new HttpError(403, 'ops_required', 'Operator authentication required');
}
