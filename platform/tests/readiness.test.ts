import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { calculateReadiness } = await import('../src/modules/readiness.js');

test('readiness reflects saved facts and publication without implying rankings', () => {
  const blank = calculateReadiness({}, false);
  assert.equal(blank.geo.score, 0);
  assert.equal(blank.seo.score, 0);
  const profile = {
    name: 'Test Café', category: 'cafes', address: 'Road 36, Jubilee Hills',
    neighborhood: 'Jubilee Hills',
    summary: 'A neighborhood café serving drinks, breakfast and freshly prepared food with clear visit details.',
    offerings: [{ name: 'Tea', category: 'Beverages' }],
    phone: '+919876543210', hoursText: 'Open 9am to 6pm',
  };
  const privateDraft = calculateReadiness(profile, false);
  assert.equal(privateDraft.geo.score, 80);
  assert.equal(privateDraft.seo.score, 65);
  const published = calculateReadiness(profile, true);
  assert.equal(published.geo.score, 100);
  assert.equal(published.seo.score, 100);
  assert.equal(published.seo.checks.find((check) => check.id === 'sitemap')?.passed, true);
});
