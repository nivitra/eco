import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { registerRetention } from './modules/retention.js';
import { registerNotifications } from './modules/notifications.js';
import { registerArrival } from './modules/arrival.js';
import { registerMedia } from './modules/media.js';
import { registerLocations } from './modules/locations.js';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import { auth, requireUser } from './auth.js';
import { pool, withActor, requireRole, idempotent, HttpError, audit, consumeQuota } from './db.js';
import { config } from './config.js';
import { registerMerchant } from './modules/merchant.js';
import { registerPublic, registerHostedHostRouting } from './modules/public.js';
import { registerPublicationTargets } from './modules/publication-targets.js';
import { registerAccessChecks } from './modules/access-checks.js';
import { registerDomains } from './modules/website-domains.js';
import { registerTelemetry } from './modules/telemetry.js';
import { registerExports } from './modules/export.js';
import { registerConsumer } from './modules/consumer.js';
import { registerOutingShares, redactOutingSharePath } from './modules/outing-shares.js';
import { registerAI } from './modules/ai.js';
import { registerPlannerIntent } from './modules/planner-intent.js';
import { registerVoice, VOICE_MAX_DURATION_SECONDS } from './modules/voice.js';
import { mapsClientConfig } from './modules/maps-client.js';
import { registerRoutes } from './modules/routes.js';
import { registerBilling, billingConfigured } from './modules/billing.js';
export const app = new Hono();
app.use('*', async (c, next) => {
  const start = Date.now();
  const requestId = randomUUID();
  c.header('X-Request-Id', requestId);
  try {
    await next();
  } finally {
    if (process.env.QUIET_LOGS !== 'true')
      console.log(
        JSON.stringify({
          requestId,
          method: c.req.method,
          path: c.req.path.startsWith('/api/auth/') ? '/api/auth/[redacted]' : redactOutingSharePath(c.req.path),
          status: c.res.status,
          durationMs: Date.now() - start,
        }),
      );
  }
});
registerHostedHostRouting(app);
app.use('/internal/*', async (c, next) => {
  if (
    process.env.INTERNAL_API !== 'true' &&
    !(process.env.DOMAIN_AUTHORITY_ONLY === 'true' && c.req.path === '/internal/caddy/ask')
  )
    throw new HttpError(404, 'not_found', 'Route not found');
  await next();
});
app.use('*', async (c, next) => {
  const consoleRoute = c.req.path.startsWith('/console/');
  return secureHeaders({
    crossOriginResourcePolicy: c.req.path.startsWith('/v1/media/public/')
      ? 'cross-origin'
      : 'same-origin',
    contentSecurityPolicy: consoleRoute
      ? {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          frameSrc: ["'self'", 'blob:'],
          workerSrc: ["'self'", 'blob:'],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        }
      : {
          defaultSrc: ["'none'"],
          styleSrc: ["'unsafe-inline'"],
          imgSrc: /^\/(?:outings|v1\/outing-shares)(?:\/|$)/.test(c.req.path) ? ["'none'"] : ["'self'", 'https:'],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'none'"],
        },
  })(c, next);
});
app.use('*', async (c, next) => {
  const upload =
    c.req.method === 'PUT' && /^\/v1\/media\/uploads\/[A-Za-z0-9-]+\/content$/.test(c.req.path);
  const graph = /^\/v1\/tenants\/[^/]+\/places\/[^/]+\/arrival-drafts(?:\/|$)/.test(c.req.path);
  return bodyLimit({
    maxSize: upload ? 5 * 1024 * 1024 : graph ? 2 * 1024 * 1024 : 256 * 1024,
    onError: (c) =>
      c.json(
        { error: { code: 'body_too_large', message: 'Request exceeds the route size limit' } },
        413,
      ),
  })(c, next);
});
// Cookie sessions on custom API routes require the same origin as the console.
app.use('/v1/*', async (c, next) => {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !c.req.path.startsWith('/v1/webhooks/')
  ) {
    const origin = c.req.header('Origin'),
      cookie = c.req.header('Cookie');
    if (
      (origin && origin !== config.publicURL) ||
      (cookie && !origin) ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      throw new HttpError(
        403,
        'origin_required',
        'Use the signed-in console on this server to make changes',
      );
  }
  await next();
});
app.get(
  '/downloads/kulture-publisher.zip',
  serveStatic({
    path: process.env.WORDPRESS_ZIP_PATH || '../wordpress/dist/kulture-publisher.zip',
  }),
);
app.get('/console', (c) => c.redirect('/console/'));
app.use('/console/*', async (c, next) => {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  await next();
});
app.get(
  '/console/*',
  serveStatic({ root: config.consoleRoot, rewriteRequestPath: (p) => p.replace(/^\/console/, '') }),
);
app.get('/console/*', serveStatic({ root: config.consoleRoot, path: 'index.html' }));
app.use('/v1/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/api/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
app.get('/health/live', (c) => c.json({ status: 'ok' }));
app.get('/health/ready', async (c) => {
  await pool.query('SELECT 1 FROM places LIMIT 1');
  return c.json({ status: 'ready' });
});
app.get('/v1/capabilities', (c) =>
  c.json({
    version: 1,
    backend: 'self-hosted',
    catalog: true,
    accounts: true,
    cloudSync: true,
    ai: { configured: !!config.deepseekKey, requiresSignIn: true, dailyLimit: config.aiDailyLimit },
    voice: { configured: !!config.sonioxKey, requiresSignIn: true, dailyLimit: config.voiceDailyLimit, maxDurationSeconds: VOICE_MAX_DURATION_SECONDS },
    routing: { configured: !!config.routingURL, traffic: false },
    billing: {
      configured: billingConfigured(),
      priceMinor: 29900,
      currency: 'INR',
      interval: 'monthly',
    },
    publishing: {
      mode: 'location_entitlement',
      ownershipReviewRequired: true,
      pilotRequiresGrant: true,
    },
    email: { configured: !!config.smtpURL },
    events: { liveFeed: false },
    entrances: { verification: 'per_location', verifiedCount: null },
  }),
);
app.get('/v1/maps/client-config', (c) => c.json(mapsClientConfig(config.mapboxPublicToken)));
app.get('/v1/me', async (c) => {
  const user = await requireUser(c);
  return c.json(
    await withActor(user.id, async (db) => ({
      user,
      tenants: (
        await db.query(
          `SELECT t.id,t.name,m.role,m.can_publish AS "canPublish",m.can_manage_destinations AS "canManageDestinations",m.scope_mode AS "scopeMode",coalesce((SELECT jsonb_agg(s.place_id) FROM membership_places s WHERE s.tenant_id=m.tenant_id AND s.user_id=m.user_id),'[]'::jsonb) AS "placeIDs" FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 AND m.state='active' ORDER BY t.created_at`,
          [user.id],
        )
      ).rows,
    })),
  );
});
app.post('/v1/tenants', async (c) => {
  const user = await requireUser(c);
  const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(await c.req.json());
  await consumeQuota(`tenant:${user.id}`, 5, 86400);
  const result = await withActor(user.id, (db) =>
    idempotent(
      db,
      user.id,
      c.req.header('Idempotency-Key') || '',
      'create-tenant',
      body,
      async () => {
        const { rows } = await db.query('INSERT INTO tenants(name) VALUES($1) RETURNING id,name', [
          body.name,
        ]);
        await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [
          rows[0].id,
          user.id,
        ]);
        await audit(db, user.id, rows[0].id, 'tenant.created', rows[0].id);
        return { ...rows[0], role: 'owner' };
      },
    ),
  );
  return c.json(result, 201);
});
registerRetention(app);
registerExports(app);
registerPublicationTargets(app);
registerAccessChecks(app);
registerDomains(app);
registerNotifications(app);
registerArrival(app);
registerMedia(app);
registerLocations(app);
registerConsumer(app);
registerOutingShares(app);
registerAI(app);
registerPlannerIntent(app);
registerVoice(app);
registerRoutes(app);
registerMerchant(app);
registerPublic(app);
registerTelemetry(app);
registerBilling(app);
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));
app.onError((e, c) => {
  const requestId = c.res.headers.get('X-Request-Id');
  if (e instanceof HttpError)
    return c.json({ error: { code: e.code, message: e.message }, requestId }, e.status as 400);
  if (e instanceof ZodError)
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Check request fields',
          fields: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        requestId,
      },
      400,
    );
  if (e instanceof SyntaxError)
    return c.json(
      { error: { code: 'invalid_json', message: 'Request must contain valid JSON' }, requestId },
      400,
    );
  console.error(
    JSON.stringify({
      requestId,
      errorType: e.name,
      code: (e as { code?: string }).code || 'internal_error',
    }),
  );
  return c.json(
    { error: { code: 'internal_error', message: 'The request could not be completed' }, requestId },
    500,
  );
});
