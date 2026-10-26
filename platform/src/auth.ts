import { betterAuth } from 'better-auth';
import pg from 'pg';
import type { Context } from 'hono';
import { config } from './config.js';
import { HttpError } from './db.js';
import { authOptions } from './auth-options.js';
export const authPool = new pg.Pool({
  connectionString: config.authDatabaseURL,
  max: 5,
  connectionTimeoutMillis: 5000,
});
export const auth = betterAuth(authOptions(authPool));
export async function requireUser(
  c: Context,
): Promise<{ id: string; email: string; name: string; emailVerified: boolean }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HttpError(401, 'sign_in_required', 'Sign in to continue');
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    emailVerified: session.user.emailVerified,
  };
}
export { requireOps } from './ops-auth.js';
