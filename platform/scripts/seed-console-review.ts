/** Explicit local acceptance fixture. Never runs as part of production seed or migration. */
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { workerPool, pool } from '../src/db.js';
import { authPool } from '../src/auth.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
if (
  process.env.NODE_ENV === 'production' ||
  process.env.ALLOW_LOCAL_REVIEW !== 'true' ||
  !['localhost', '127.0.0.1'].includes(new URL(config.publicURL).hostname)
)
  throw new Error('Explicit local acceptance mode required');
const email = `console-review-${Date.now()}@example.test`,
  password = 'Local-review-only-2026!',
  base = 'http://localhost:3000';
let token = '';
async function request(path: string, body?: unknown, ops = false) {
  const r = await app.request(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'X-Real-IP': '2001:db8:9:29::777',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(ops ? { 'X-Ops-Token': config.opsToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(JSON.stringify({ path, status: r.status, data }));
  if (r.headers.get('set-auth-token')) token = r.headers.get('set-auth-token')!;
  return data;
}
try {
  const user = await request('/api/auth/sign-up/email', {
    name: 'Kulture review',
    email,
    password,
  });
  await authPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [user.user.id]);
  const tenant = await request('/v1/tenants', { name: 'Kulture · Local review' });
  const profile = {
    name: 'Kulture Demo Café',
    businessType: 'cafe',
    category: 'cafes',
    neighborhood: 'Jubilee Hills',
    address: 'Local acceptance fixture · Road 45, Jubilee Hills, Hyderabad',
    summary:
      'A local demonstration record for reviewing Kulture’s business workflow. This is not a real venue listing or a field-verified business.',
    tags: ['Local test fixture'],
    phone: null,
    website: null,
    hoursText: null,
    entranceNote: null,
    locality: {
      country: 'IN',
      state: 'Telangana',
      city: 'Hyderabad',
      citySlug: 'hyderabad',
      locality: 'Jubilee Hills',
      street: 'Road 45',
      postalCode: '500033',
      unit: 'Demo',
      floor: 'Ground',
    },
    offerings: [
      {
        id: 'demo-coffee',
        name: 'Demo coffee',
        description: 'Sample offering for publication tests only.',
        priceMinor: 25000,
        currency: 'INR',
        priceQualifier: 'fixed',
        availability: 'unknown',
      },
    ],
  };
  const location = await request(`/v1/tenants/${tenant.id}/locations`, {
    profile,
    evidence: {
      description:
        'Isolated local acceptance fixture only. No real business authority is asserted.',
    },
    duplicateAcknowledged: true,
  });
  await request(
    `/v1/ops/claims/${location.claim.id}/review`,
    {
      decision: 'approved',
      reason: 'Synthetic local acceptance fixture; not real venue ownership evidence.',
    },
    true,
  );
  await request(
    '/v1/ops/pilot-grants',
    {
      tenantID: tenant.id,
      placeID: location.place.id,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      reason: 'Seven-day local acceptance fixture only.',
    },
    true,
  );
  const record = { email, password, tenantID: tenant.id, placeID: location.place.id, base };
  await writeFile(
    process.env.REVIEW_OUTPUT_FILE ?? '/private/tmp/kulture-console-review.json',
    JSON.stringify(record),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      email,
      tenantID: tenant.id,
      placeID: location.place.id,
      notice: 'Synthetic local review credentials only',
    }),
  );
} finally {
  await Promise.all([pool.end(), workerPool.end(), authPool.end()]);
}
