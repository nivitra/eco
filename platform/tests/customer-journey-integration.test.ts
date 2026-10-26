import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** An isolated local journey through customer APIs; operator steps remain explicit.
 * Only the external model is mocked. No provider charges or real shop claim occur.
 */
test('customer signup/login, private onboarding, approved hosted publication, discovery, saves and authenticated AI connect end to end',
  { skip: process.env.RUN_DB_TESTS !== 'true' }, async () => {
  const { app } = await import('../src/app.js');
  const { pool, workerPool } = await import('../src/db.js');
  const { authPool } = await import('../src/auth.js');
  const { config } = await import('../src/config.js');
  const { processPublishingJob } = await import('../src/modules/publishing.js');
  const { processTargetPublicationJob } = await import('../src/modules/publication-targets.js');
  const { robotsAllows } = await import('../src/modules/access-checks.js');
  const suffix = randomUUID(), email = `journey-${suffix}@example.test`;
  const ip = `2001:db8:${suffix.slice(0,4)}:${suffix.slice(4,8)}::9`;
  const originalFetch = globalThis.fetch, originalKey = config.deepseekKey, oldInternal = process.env.INTERNAL_API;
  process.env.INTERNAL_API = 'true';
  const request = (path: string, method = 'GET', body?: unknown, token?: string, extra: Record<string,string> = {}) =>
    app.request('http://localhost:3000' + path, { method, headers: { 'Content-Type':'application/json', 'X-Real-IP':ip,
      ...(token ? { Authorization:'Bearer ' + token } : {}), ...extra }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const checked = async (response: Response, status = 200): Promise<any> => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const post = (path: string, body: unknown, token?: string, extra: Record<string,string> = {}) =>
    request(path, 'POST', body, token, { 'Idempotency-Key':randomUUID(), ...extra });
  let publicationID: string | undefined;
  try {
    const signup = await request('/api/auth/sign-up/email', 'POST', { name:'Local journey test', email, password:'Local-journey-test-password-2026!' });
    await checked(signup);
    const initialToken = signup.headers.get('set-auth-token'); assert(initialToken);
    await checked(await request('/api/auth/sign-out', 'POST', {}, initialToken));
    assert.equal((await request('/v1/me', 'GET', undefined, initialToken)).status, 401);
    const login = await request('/api/auth/sign-in/email', 'POST', { email, password:'Local-journey-test-password-2026!' });
    await checked(login);
    const owner = login.headers.get('set-auth-token'); assert(owner, 'normal login issues signed native session');
    const tenant = await checked(await post('/v1/tenants', { name:'Isolated customer journey' }, owner), 201);
    const profile = {
      name:`Customer Journey ${suffix} (Demo)`, businessType:'cafe', category:'cafes', neighborhood:'Jubilee Hills',
      address:'Fictional test address, Jubilee Hills, Hyderabad', summary:'Fictional local test cafe. No purchases or visits.',
      tags:['Coffee'], locality:{ country:'IN', state:'Telangana', city:'Hyderabad', citySlug:'hyderabad', locality:'Jubilee Hills', street:'Fictional test street', postalCode:'500033' },
    };
    const created = await checked(await post(`/v1/tenants/${tenant.id}/locations`, { profile,
      evidence:{ description:'Private local test proof only. This fictional fixture claims no real business.' } }, owner), 202);
    const placeID = created.place.id, base = `/v1/tenants/${tenant.id}/places/${placeID}`;
    assert.equal((await request('/v1/places/' + placeID)).status, 404, 'onboarding is private');
    assert.equal((await post(`/v1/ops/claims/${created.claim.id}/review`, { decision:'approved', reason:'Fictional local acceptance only.' }, owner)).status, 403, 'owner cannot self-approve');
    await checked(await post(`/v1/ops/claims/${created.claim.id}/review`, { decision:'approved', reason:'Operator review of an explicitly fictional local test fixture.' }, undefined, { 'X-Ops-Token':config.opsToken }));
    const draft = (await checked(await request(base + `/drafts/${created.draft.id}`, 'PATCH', { profile, rightsConfirmed:true }, owner, { 'If-Match':String(created.draft.version) }))).draft;
    const destination = (await checked(await post(base + '/destinations', { kind:'hosted' }, owner), 201)).destination;
    const preview = (await checked(await post(base + `/destinations/${destination.id}/preview`, { draftID:draft.id, assetIDs:[] }, owner))).preview;
    assert.deepEqual(preview.blockingIssues, []);
    const publishBody = { previewID:preview.id, previewDigest:preview.digest, approval:true };
    assert.equal((await post(base + `/destinations/${destination.id}/publish`, publishBody, owner, { 'If-Match':String(draft.version) })).status, 402, 'no implicit free or paid entitlement');
    await checked(await post('/v1/ops/pilot-grants', { tenantID:tenant.id, placeID,
      startsAt:new Date(Date.now()-1000).toISOString(), endsAt:new Date(Date.now()+3600000).toISOString(),
      reason:'Explicit one-hour pilot for this fictional local acceptance fixture only.' }, undefined, { 'X-Ops-Token':config.opsToken }), 201);
    const queued = await checked(await post(base + `/destinations/${destination.id}/publish`, publishBody, owner, { 'If-Match':String(draft.version) }), 202);
    publicationID = queued.publication.id;
    let publication: any, delivery: any;
    for (let i=0;i<40;i++) {
      await processPublishingJob();
      publication = (await workerPool.query('SELECT status FROM publications WHERE id=$1', [publicationID])).rows[0];
      if (publication.status === 'live') break;
    }
    assert.equal(publication.status, 'live');
    for (let i=0;i<40;i++) {
      await processTargetPublicationJob();
      delivery = (await workerPool.query('SELECT state FROM target_deliveries WHERE id=$1', [queued.delivery.id])).rows[0];
      if (delivery.state === 'applied_unverified') break;
    }
    assert.equal(delivery.state, 'applied_unverified', 'delivery is not yet independently verified or crawled');
    const page = await request('/sites/' + placeID); assert.equal(page.status, 200);
    const html = await page.text(); assert.equal(html, preview.html, 'serve exactly what the owner approved');
    assert(html.includes('application/ld+json')); assert(html.includes('CafeOrCoffeeShop'));
    assert(html.includes(`href="http://localhost:3000/sites/${placeID}"`));
    assert(!html.includes('Private local test proof'));
    assert(robotsAllows(await (await request('/robots.txt')).text(), 'OAI-SearchBot', '/sites/' + placeID));
    assert((await (await request('/sitemap.xml')).text()).includes('/sites/' + placeID));
    const discovered = await checked(await request('/v1/places?q=' + encodeURIComponent(`Customer Journey ${suffix}`)));
    assert(discovered.places.some((p: any) => p.id === placeID));
    const direct = await checked(await request('/v1/places/' + placeID));
    assert.equal(direct.publishedFacts.name, profile.name);
    assert.equal(direct.revision, 2); assert.deepEqual(direct.entrances, []);
    const account = await request('/v1/profile', 'GET', undefined, owner);
    const body = (await checked(account)).profile;
    const saved = { ...body, savedIDs:[placeID], outings:[{ id:randomUUID(), title:'Fictional acceptance outing', placeIDs:[placeID], createdAt:Date.now() }] };
    await checked(await request('/v1/profile', 'PUT', saved, owner, { 'If-Match':account.headers.get('etag')! }));
    const reload = await checked(await request('/v1/profile', 'GET', undefined, owner));
    assert.deepEqual(reload.profile.savedIDs, [placeID]); assert.deepEqual(reload.profile.outings, saved.outings);

    // Only this explicitly mocked provider request is intercepted; no real AI call occurs.
    config.deepseekKey = 'local-test-provider-placeholder';
    let called = 0, malformed = false;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.deepseek.com/chat/completions', 'unexpected external request');
      called++;
      const upstream = JSON.parse(String(init?.body));
      const context = JSON.parse(upstream.messages[1].content);
      assert.equal(context.avoidBars, true);
      assert(!context.catalog.some((p: any) => p.category === 'nightlife' || p.category === 'healthcare'));
      assert(!JSON.stringify(context).includes('Private local test proof'));
      assert(context.catalog.length > 0);
      const reply = { answer:'Choose a sourced coffee listing and check current hours before visiting.',
        recommendations:[{ placeID:malformed?'invented-place':context.catalog[0].id, reason:'Matches the requested coffee category.' }], followUp:null };
      return Response.json({ choices:[{ finish_reason:'stop', message:{ content:JSON.stringify(reply) } }] });
    };
    const aiBody = { messages:[{ role:'user', content:'Coffee in Jubilee Hills, no bars.' }], scope:'jubilee_hills', taste:{ interests:['cafes'], pace:'Unhurried', avoidBars:true }, savedIDs:[placeID] };
    assert.equal((await request('/v1/ai/chat', 'POST', aiBody)).status, 401); assert.equal(called, 0);
    const answer = await request('/v1/ai/chat', 'POST', aiBody, owner); assert.equal(answer.status, 200);
    assert(answer.headers.get('content-type')?.includes('text/event-stream'));
    assert.equal(answer.headers.get('cache-control'), 'private, no-store');
    const events = (await answer.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(events.at(-1), '[DONE]');
    const parsed = JSON.parse(JSON.parse(events[0]).choices[0].delta.content);
    assert.equal(parsed.recommendations.length, 1);
    assert.equal((await request('/v1/places/' + parsed.recommendations[0].placeID)).status, 200);
    malformed = true;
    const rejected = await request('/v1/ai/chat', 'POST', aiBody, owner);
    assert.equal(rejected.status, 502); assert.equal((await rejected.json() as any).error.code, 'invalid_ai_recommendation');
    await checked(await request('/api/auth/sign-out', 'POST', {}, owner));
    assert.equal((await request('/v1/profile', 'GET', undefined, owner)).status, 401);
  } finally {
    globalThis.fetch = originalFetch; config.deepseekKey = originalKey;
    // Keep the test fixture out of public discovery after the journey, even if an assertion fails.
    if (publicationID) await request(`/v1/ops/publications/${publicationID}/withdraw`, 'POST',
      { reason:'Finished isolated customer-journey acceptance; remove fictional fixture from public discovery.' }, undefined, { 'X-Ops-Token':config.opsToken });
    process.env.INTERNAL_API = oldInternal;
    await Promise.all([pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);
  }
});
