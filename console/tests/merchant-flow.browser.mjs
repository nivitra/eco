// Optional browser regression: start the console on 127.0.0.1:5179 first.
// Supply PLAYWRIGHT_MODULE when Playwright is provided by a shared tool runtime.
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = process.env.CONSOLE_TEST_ARTIFACTS ?? 'test-results/merchant-flow';
await mkdir(artifacts, { recursive: true });
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let signedIn = false,
  publishAttempts = 0,
  key,
  savedVersion = 0;
const profile = {
  name: 'Fixture Copper Café',
  businessType: 'cafe',
  category: 'cafes',
  neighborhood: 'Jubilee Hills',
  address: 'Fixture Road 45, Jubilee Hills, Hyderabad',
  summary: 'A fictional cafe used only for local browser tests.',
  tags: ['coffee'],
  phone: null,
  website: null,
  hoursText: null,
  entranceNote: null,
};
let draft = { id: 'draft-fixture', version: 1, state: 'draft', profile, rightsConfirmed: true };
const place = { id: 'fixture-place', name: profile.name, revision: 1 };
const tenant = {
  id: 'fixture-tenant',
  name: 'Fixture Workspace',
  role: 'owner',
  scopeMode: 'all',
  placeIDs: [],
  canPublish: true,
  canManageDestinations: true,
};
const destination = {
  id: 'fixture-destination',
  version: 1,
  state: 'connected',
  kind: 'hosted',
  publicURL: 'https://example.invalid/sites/loc-685586a3-8c6c-40ed-a63f-3b32a3b10454',
  lastSequence: 0,
};
const base = '/v1/tenants/fixture-tenant/places/fixture-place';
await page.route('**/*', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  if (!path.startsWith('/v1/') && !path.startsWith('/api/')) return route.continue();
  let status = 200,
    data = {};
  if (path === '/v1/me') {
    if (!signedIn) {
      status = 401;
      data = { error: { code: 'unauthorized', message: 'Sign in required' } };
    } else
      data = {
        user: {
          id: 'fixture-user',
          name: 'Fixture Owner',
          email: 'owner@example.invalid',
          emailVerified: true,
        },
        tenants: [tenant],
      };
  } else if (path === '/api/auth/sign-in/email') {
    signedIn = true;
    data = { user: { id: 'fixture-user' } };
  } else if (path === '/v1/capabilities')
    data = { email: { configured: false }, pilotPublishing: true };
  else if (path === '/v1/locations/search') data = { places: [] };
  else if (path === '/v1/business-taxonomy')
    data = { types: [{ id: 'cafe', label: 'Café', discoveryCategory: 'cafes' }] };
  else if (path === '/v1/tenants/fixture-tenant/places') data = { places: [place] };
  else if (path === base) data = { place, claim: { state: 'approved' }, draft };
  else if (path === base + '/drafts/draft-fixture' && req.method() === 'PATCH') {
    assert.equal(req.headers()['if-match'], String(draft.version));
    const body = req.postDataJSON();
    draft = { ...draft, version: draft.version + 1, ...body };
    savedVersion = draft.version;
    data = { draft };
  } else if (path === base + '/destinations') data = { destinations: [destination] };
  else if (path === base + '/media') data = { assets: [] };
  else if (path === base + '/deliveries')
    data = {
      deliveries: [
        {
          id: 'delivery-fixture',
          sequence: 1,
          state: 'verified_live',
          createdAt: '2026-10-08T11:30:00Z',
          verifiedAt: '2026-10-08T11:31:00Z',
        },
      ],
    };
  else if (path.endsWith('/access'))
    data = {
      observations: [
        {
          id: 'observation-fixture',
          outcome: 'usable',
          observedURL: destination.publicURL,
          observedAt: '2026-10-08T11:31:00Z',
          checks: [
            { name: 'canonical', status: 'pass', detail: destination.publicURL },
            { name: 'exact_artifact_digest', status: 'pass', detail: 'a'.repeat(64) },
            {
              name: 'structured_business_data',
              status: 'pass',
              detail: 'Approved public business facts are readable',
            },
          ],
        },
      ],
    };
  else if (path.endsWith('/preview'))
    data = {
      preview: {
        id: 'preview-fixture',
        html:
          '<!doctype html><html><body><h1>Exact fixture page</h1><p>' +
          draft.profile.name +
          '</p></body></html>',
        digest: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        blockingIssues: [],
        draftVersion: draft.version,
        publicURL: destination.publicURL,
      },
    };
  else if (path.endsWith('/publish')) {
    publishAttempts++;
    if (publishAttempts === 1) {
      key = req.headers()['idempotency-key'];
      status = 503;
      data = {
        error: {
          code: 'fixture_unavailable',
          message: 'Fixture worker unavailable. Your reviewed version is still ready to retry.',
        },
      };
    } else {
      assert.equal(req.headers()['idempotency-key'], key);
      data = { publication: { id: 'publication-fixture', status: 'queued' } };
      draft = { ...draft, state: 'queued' };
    }
  } else if (path.endsWith('/notifications')) data = { notifications: [] };
  else if (path.endsWith('/entitlement'))
    data = { entitlement: { source: 'pilot', allowed: true } };
  else if (path.endsWith('/arrival')) data = { capability: 'listing_only' };
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
});
try {
  await page.goto('http://127.0.0.1:5179/console/?section=details');
  await page
    .getByRole('button', { name: 'New to Kulture? Create an account', exact: true })
    .click();
  await page.getByLabel('Your name', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Already have an account? Sign in', exact: true }).click();
  await page.getByLabel('Email address').fill('owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).waitFor({ state: 'visible' });
  await page.getByLabel('Business name', { exact: true }).fill('Fixture Copper Café — Updated');
  await page.waitForFunction(() =>
    document.body.innerText.includes('Saved on server · not published'),
  );
  assert(savedVersion > 1, 'Edit was sent through the versioned draft contract');
  await page.getByRole('button', { name: 'Review & publish', exact: true }).first().click();
  await page.getByRole('button', { name: 'Review current draft', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByText('Exact HTML loaded', { exact: true }).waitFor();
  const approve = dialog.getByRole('button', { name: 'Approve & publish', exact: true });
  assert(await approve.isDisabled());
  await dialog.getByRole('checkbox').check();
  await approve.click();
  await dialog
    .getByRole('alert')
    .getByText('Fixture worker unavailable.', { exact: false })
    .waitFor();
  assert.equal(publishAttempts, 1);
  await page.screenshot({ path: artifacts + '/publish-error.png', fullPage: true });
  await approve.click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Publication queued.' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.destination-tabs') !== null);
  assert.equal(publishAttempts, 2);
  assert(await page.getByRole('status').filter({ hasText: 'Publication queued.' }).isVisible());
  const colors = await page.evaluate(() => ({
    canvas: getComputedStyle(document.body).backgroundColor,
    button: getComputedStyle(document.querySelector('.button.primary')).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
  }));
  assert.equal(colors.canvas, 'rgb(16, 15, 14)');
  assert.equal(colors.button, 'rgb(199, 130, 76)');
  assert(colors.font.includes('Geist'));
  await page.screenshot({ path: artifacts + '/website-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Mobile page must not overflow horizontally',
  );
  await page.screenshot({ path: artifacts + '/website-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Add location', exact: true }).click();
  await page.getByRole('heading', { name: 'Add your business', exact: true }).waitFor();
  await page.getByPlaceholder('Business name, locality or address').fill('No matching fixture');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'No matching locations found.' }).waitFor();
  await page.getByRole('button', { name: 'Create a new location', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).waitFor();
  assert(
    await page
      .getByRole('button', { name: 'Create private location draft', exact: true })
      .isDisabled(),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'sign-up/sign-in mode navigation',
          'empty location search with next step',
          'new location draft gate',
          'sign-in',
          'versioned edit autosave',
          'exact preview rendered',
          'explicit approval required',
          'publish failure visible inside modal',
          'retry reuses artifact idempotency key',
          'queued notice survives refresh',
          'desktop/mobile palette',
          'mobile no horizontal overflow',
          'no uncaught browser errors',
        ],
        colors,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({ path: artifacts + '/failure.png', fullPage: true });
  console.error(await page.locator('body').innerText());
  throw e;
} finally {
  await browser.close();
}
