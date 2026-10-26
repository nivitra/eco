// Optional browser regression: start the console on 127.0.0.1:5179 first.
// Supply PLAYWRIGHT_MODULE when Playwright is provided by a shared tool runtime.
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = process.env.CONSOLE_TEST_ARTIFACTS ?? 'test-results/outdoor-map';
await mkdir(artifacts, { recursive: true });
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
let arrivalDraft = null, graphWrites = 0, mapEnabled = true;
const base = '/v1/tenants/fixture-tenant/places/fixture-place';
await page.route('**/*', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  if (url.hostname === 'api.mapbox.com' || url.hostname.endsWith('.mapbox.com')) {
    if (path.includes('/styles/v1/mapbox/dark-v11')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 8, name: 'Local fixture — no provider data', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#10241c' } }] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  if (!path.startsWith('/v1/') && !path.startsWith('/api/')) return route.continue();
  let status = 200,
    data = {};
  if (path === '/v1/maps/client-config') data = { enabled: mapEnabled, publicToken: mapEnabled ? 'pk.' + 'a'.repeat(40) : '', styleURL: 'mapbox://styles/mapbox/dark-v11' };
  else if (path.startsWith(base + '/arrival-drafts')) {
    if (req.method() === 'GET') data = { drafts: arrivalDraft ? [arrivalDraft] : [] };
    else {
      graphWrites++;
      arrivalDraft = { graph: req.postDataJSON().graph, revision: graphWrites, state: 'draft', approvedDigest: null, reviewNote: null };
      data = arrivalDraft;
    }
  }
  else if (path === '/v1/me') {
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
  await page.goto('http://127.0.0.1:5179/console/?section=arrival');
  await page.getByLabel('Email address').fill('owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create arrival draft', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mapboxgl-canvas') && !document.body.innerText.includes('Loading Mapbox'));
  await page.waitForFunction(() => document.body.innerText.includes('Draft saved; published directions are unchanged.'));
  assert.equal(graphWrites, 1);
  assert.equal(await page.locator('.map-outdoor-pin').count(), 0, 'No invented point for a new graph');
  const canvas = page.locator('.mapboxgl-canvas');
  await canvas.click({ position: { x: 350, y: 180 } });
  await page.locator('.map-outdoor-pin').waitFor();
  const latitude = page.getByLabel('Latitude', { exact: true });
  const longitude = page.getByLabel('Longitude', { exact: true });
  assert.notEqual(await latitude.inputValue(), '');
  assert.equal(await page.getByLabel('Uncertainty, metres').inputValue(), '');
  const confirm = page.getByRole('checkbox', { name: 'I observed this checkpoint and its permitted access on site.' });
  assert(!(await confirm.isChecked()));
  const before = await longitude.inputValue();
  const box = await page.locator('.map-outdoor-pin').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 65, box.y + box.height / 2 + 25, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(old => document.querySelector('input[placeholder="No assumed coordinate"]').value.length > 0, before);
  assert.notEqual(await longitude.inputValue(), before, 'Dragging updates the candidate coordinate');
  assert.equal(await page.locator('.map-outdoor-pin').count(), 1, 'Dragging never duplicates the point');
  await page.waitForTimeout(1600);
  assert.equal(graphWrites, 1, 'Map click and drag do not save an observation');
  assert.equal(arrivalDraft.graph.nodes[0].outdoorPoint, null);
  await page.getByLabel('Uncertainty, metres').fill('10');
  await page.getByLabel('Evidence expires').fill('2027-01-01T12:00');
  await confirm.check();
  await page.getByRole('button', { name: 'Record owner observation', exact: true }).click();
  await page.waitForTimeout(1700);
  assert.equal(graphWrites, 2);
  assert.equal(arrivalDraft.graph.nodes[0].outdoorPoint.source, 'owner_observation');
  assert.equal(arrivalDraft.graph.verificationRecords.length, 1);
  assert.equal(await page.locator('.map-outdoor-pin').count(), 1);
  await page.getByRole('img', { name: 'Floor diagram; not surveyed geometry' }).waitFor();
  await page.locator('.mapboxgl-ctrl-logo').waitFor();
  await page.locator('.mapboxgl-ctrl-attrib').waitFor();
  await page.screenshot({ path: artifacts + '/outdoor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: artifacts + '/outdoor-mobile.png', fullPage: true });
  mapEnabled = false;
  await page.reload();
  await page.getByText('Mapbox is not configured.', { exact: false }).waitFor();
  await latitude.waitFor();
  assert.notEqual(await latitude.inputValue(), '');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedProvider: true, graphWrites, checks: ['real Mapbox GL canvas with local style fixture', 'no invented initial point', 'click creates one candidate', 'drag changes one candidate', 'no persisted unconfirmed coordinates', 'explicit owner observation persists once', 'floor graph retained', 'Mapbox attribution visible', 'mobile no overflow', 'missing configuration preserves coordinate form', 'no browser errors'] }, null, 2));
} catch (error) {
  await page.screenshot({ path: artifacts + '/failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
