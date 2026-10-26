import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

test(
  'real PostgreSQL arrival/media: tenant isolation, image processing, exact review, closure variants and revocation',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'kulture-media-test-'));
    process.env.MEDIA_ROOT = storage;
    const priorOps = process.env.INTERNAL_API;
    process.env.INTERNAL_API = 'true';
    const { app } = await import('../src/app.js'),
      { pool, workerPool, withActor } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js');
    const suffix = randomUUID(),
      tenantA = randomUUID(),
      tenantB = randomUUID(),
      placeA = `map-a-${suffix}`,
      placeB = `map-b-${suffix}`;
    const req = (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
      headers: Record<string, string> = {},
    ) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': `2001:db8:${suffix.slice(0, 4)}::1`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof Uint8Array ? (body as any) : JSON.stringify(body) }),
      });
    const command = (path: string, body: unknown, token: string, tag?: string) =>
      req(path, 'POST', body, token, {
        'Idempotency-Key': randomUUID(),
        ...(tag ? { 'If-Match': tag } : {}),
      });
    async function account(name: string) {
      const r = await req('/api/auth/sign-up/email', 'POST', {
        name,
        email: `${name}-${suffix}@example.test`,
        password: 'Map-test-long-password-only!',
      });
      assert.equal(r.status, 200, await r.clone().text());
      return { token: r.headers.get('set-auth-token')!, user: ((await r.json()) as any).user };
    }
    try {
      const a = await account('map-a'),
        b = await account('map-b');
      for (const [tenant, place, user] of [
        [tenantA, placeA, a.user.id],
        [tenantB, placeB, b.user.id],
      ]) {
        await workerPool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [
          tenant,
          'Map test tenant',
          user,
        ]);
        await workerPool.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
          [tenant, user],
        );
        await workerPool.query(
          "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Synthetic integration test','cafes','Jubilee Hills','Synthetic premises, never a real route','Controlled test fixture only','2026-09-29','test')",
          [place],
        );
        await workerPool.query(
          "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{}','approved',now())",
          [tenant, place, user],
        );
        await workerPool.query(
          "INSERT INTO service_grants(tenant_id,place_id,starts_at,ends_at,reason,issued_by) VALUES($1,$2,now(),now()+interval '1 day','Controlled integration test','test')",
          [tenant, place],
        );
      }
      const reserve = await command(
        '/v1/media/uploads',
        {
          tenantID: tenantA,
          placeID: placeA,
          purpose: 'checkpoint',
          alt: 'Synthetic test image',
          rights: {
            basis: 'owned',
            holder: 'Test fixture',
            publicUse: true,
            permissionNote: 'Synthetic generated test pixels, no real photograph.',
            expiresAt: null,
          },
        },
        a.token,
      );
      assert.equal(reserve.status, 201, await reserve.clone().text());
      const upload = (await reserve.json()) as any;
      assert.equal(
        (await req(`/v1/media/${upload.id}/preview`, 'GET', undefined, b.token)).status,
        404,
      );
      const pixels = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#88aa77' },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      assert.equal(
        (
          await req(upload.uploadPath, 'PUT', new Uint8Array(pixels), b.token, {
            'Content-Type': 'image/jpeg',
          })
        ).status,
        404,
      );
      const uploaded = await req(upload.uploadPath, 'PUT', new Uint8Array(pixels), a.token, {
        'Content-Type': 'image/jpeg',
      });
      assert.equal(uploaded.status, 200, await uploaded.clone().text());
      const privateImage = await req(`/v1/media/${upload.id}/preview`, 'GET', undefined, a.token);
      assert.equal(privateImage.status, 200);
      const meta = await sharp(Buffer.from(await privateImage.arrayBuffer())).metadata();
      assert.equal(meta.exif, undefined);
      assert.equal(meta.width, 20);
      assert.equal(meta.height, 40);
      assert.equal(
        (
          await withActor(b.user.id, (db) =>
            db.query('SELECT * FROM media_assets WHERE id=$1', [upload.id]),
          )
        ).rowCount,
        0,
      );
      const mediaListPath = `/v1/tenants/${tenantA}/places/${placeA}/media`;
      assert.equal((await req(mediaListPath, 'GET', undefined, b.token)).status, 404);
      const privateListing = (await (
        await req(mediaListPath, 'GET', undefined, a.token)
      ).json()) as any;
      assert.equal(privateListing.assets[0].publicApproved, false);
      assert.equal(privateListing.assets[0].publicAsset, null);
      const approved = await command(
        `/v1/media/${upload.id}/approve-public`,
        { reviewed: true, permissionConfirmed: true },
        a.token,
      );
      assert.equal(approved.status, 200, await approved.clone().text());
      const asset = ((await approved.json()) as any).asset;
      assert.equal((await req(new URL(asset.url).pathname)).status, 200);
      const approvedListing = (await (
        await req(mediaListPath, 'GET', undefined, a.token)
      ).json()) as any;
      assert.equal(approvedListing.assets[0].publicApproved, true);
      assert.deepEqual(approvedListing.assets[0].publicAsset, asset);
      assert(!JSON.stringify(approvedListing).includes('derivative_key'));
      assert(!JSON.stringify(approvedListing).includes('original_key'));
      await workerPool.query(
        "UPDATE public_media SET valid_until=now()-interval '1 minute' WHERE id=$1",
        [upload.id],
      );
      const expiredListing = (await (
        await req(mediaListPath, 'GET', undefined, a.token)
      ).json()) as any;
      assert.equal(expiredListing.assets[0].publicApproved, false);
      assert.equal(expiredListing.assets[0].publicAsset, null);
      await workerPool.query('UPDATE public_media SET valid_until=NULL WHERE id=$1', [upload.id]);
      const graph = JSON.parse(
        await readFile(new URL('fixtures/arrival-graph-v2.json', import.meta.url), 'utf8'),
      );
      graph.graphID = `graph-${suffix}`;
      graph.buildingID = `site-${suffix}`;
      graph.placeDestinationBindings[0].placeID = placeA;
      for (const n of graph.nodes) n.permittedPhotoIDs = [upload.id];
      for (const e of graph.directedEdges) e.directionalPhotoIDs = [upload.id];
      const prefix = `/v1/tenants/${tenantA}/places/${placeA}`;
      assert.equal((await command(`${prefix}/arrival-drafts`, { graph }, b.token)).status, 404);
      const create = await command(`${prefix}/arrival-drafts`, { graph }, a.token);
      assert.equal(create.status, 201, await create.clone().text());
      let tag = create.headers.get('etag')!;
      const cross = structuredClone(graph);
      cross.graphID = `cross-${suffix}`;
      cross.buildingID = `cross-site-${suffix}`;
      cross.placeDestinationBindings[0].placeID = placeB;
      assert.equal(
        (
          await command(
            `/v1/tenants/${tenantA}/places/${placeB}/arrival-drafts`,
            { graph: cross },
            a.token,
          )
        ).status,
        409,
      );
      const shared = structuredClone(graph);
      shared.placeDestinationBindings.push({
        ...shared.placeDestinationBindings[0],
        placeID: placeB,
      });
      assert.equal(
        (
          await req(
            `${prefix}/arrival-drafts/${graph.graphID}`,
            'PUT',
            { graph: shared },
            a.token,
            { 'If-Match': tag, 'Idempotency-Key': randomUUID() },
          )
        ).status,
        409,
        'A branch ownership claim is not shared-building authority.',
      );
      const siteGrant = await req(
        `/v1/ops/arrival-sites/${graph.buildingID}/grants`,
        'POST',
        {
          tenantID: tenantB,
          placeID: placeB,
          canEdit: false,
          reason: 'Explicit synthetic shared building permission test.',
        },
        undefined,
        { 'X-Ops-Token': process.env.OPS_TOKEN! },
      );
      assert.equal(siteGrant.status, 200, await siteGrant.clone().text());
      const sharedEdit = await req(
        `${prefix}/arrival-drafts/${graph.graphID}`,
        'PUT',
        { graph: shared },
        a.token,
        { 'If-Match': tag, 'Idempotency-Key': randomUUID() },
      );
      assert.equal(sharedEdit.status, 200, await sharedEdit.clone().text());
      tag = sharedEdit.headers.get('etag')!;
      graph.placeDestinationBindings = shared.placeDestinationBindings;
      const submit = await command(
        `${prefix}/arrival-drafts/${graph.graphID}/submit`,
        {},
        a.token,
        tag,
      );
      assert.equal(submit.status, 200, await submit.clone().text());
      const digest = ((await submit.json()) as any).digest;
      assert.equal(
        (
          await command(
            `${prefix}/arrival-drafts/${graph.graphID}/publish`,
            { digest },
            a.token,
            tag,
          )
        ).status,
        409,
        'Cannot publish before review.',
      );
      const reviewBody = {
        decision: 'approved',
        digest,
        reason: 'Controlled synthetic integration test, not field evidence.',
        buildingAuthorityConfirmed: true,
        walkthroughConfirmed: true,
        source: 'independent',
        validUntil: new Date(Date.now() + 86400000).toISOString(),
      };
      const review = await req(
        `/v1/ops/arrival-reviews/${graph.graphID}`,
        'POST',
        reviewBody,
        undefined,
        { 'X-Ops-Token': process.env.OPS_TOKEN! },
      );
      assert.equal(review.status, 200, await review.clone().text());
      const changed = structuredClone(graph);
      changed.name = 'Changed after approval';
      const edited = await req(
        `${prefix}/arrival-drafts/${graph.graphID}`,
        'PUT',
        { graph: changed },
        a.token,
        { 'If-Match': tag, 'Idempotency-Key': randomUUID() },
      );
      assert.equal(edited.status, 200, await edited.clone().text());
      assert.equal(
        (
          await req(`${prefix}/arrival-drafts/${graph.graphID}`, 'PUT', { graph }, a.token, {
            'If-Match': tag,
            'Idempotency-Key': randomUUID(),
          })
        ).status,
        412,
      );
      tag = edited.headers.get('etag')!;
      assert.equal(
        (
          await command(
            `${prefix}/arrival-drafts/${graph.graphID}/publish`,
            { digest },
            a.token,
            tag,
          )
        ).status,
        409,
        'Editing invalidates exact approval.',
      );
      const resubmit = await command(
        `${prefix}/arrival-drafts/${graph.graphID}/submit`,
        {},
        a.token,
        tag,
      );
      assert.equal(resubmit.status, 200);
      const finalDigest = ((await resubmit.json()) as any).digest;
      assert.equal(
        (
          await req(`/v1/ops/arrival-reviews/${graph.graphID}`, 'POST', reviewBody, undefined, {
            'X-Ops-Token': process.env.OPS_TOKEN!,
          })
        ).status,
        409,
        'Reviewer cannot approve stale digest.',
      );
      assert.equal(
        (
          await req(
            `/v1/ops/arrival-reviews/${graph.graphID}`,
            'POST',
            { ...reviewBody, digest: finalDigest },
            undefined,
            { 'X-Ops-Token': process.env.OPS_TOKEN! },
          )
        ).status,
        200,
      );
      const publishKey = randomUUID(),
        publicationPath = `${prefix}/arrival-drafts/${graph.graphID}/publish`,
        publicationHeaders = { 'If-Match': tag, 'Idempotency-Key': publishKey };
      const publish = await req(
        publicationPath,
        'POST',
        { digest: finalDigest },
        a.token,
        publicationHeaders,
      );
      assert.equal(publish.status, 201, await publish.clone().text());
      assert.equal(
        (await req(publicationPath, 'POST', { digest: finalDigest }, a.token, publicationHeaders))
          .status,
        201,
        'Same publication operation replays safely.',
      );
      const guide = await req(`/v1/places/${placeA}/arrival?mode=walking&stepFree=true`);
      assert.equal(guide.status, 200);
      const data = (await guide.json()) as any;
      assert.equal(data.status, 'available');
      assert.equal(data.selectedEntrance.id, 'east-door');
      assert.equal(
        createHash('sha256').update(data.manifestJSON).digest('hex'),
        data.manifestDigest,
      );
      assert.deepEqual(JSON.parse(data.manifestJSON).graph, data.graph);
      assert.equal(
        ((await (await req(`/v1/places/${placeB}/arrival`)).json()) as any).status,
        'available',
        'A separately claimed branch can share an explicitly granted building guide.',
      );
      const closed = await command(
        `${prefix}/arrival-closures`,
        {
          graphID: graph.graphID,
          targetType: 'lift',
          targetID: 'lift-a',
          startsAt: new Date(Date.now() - 1000).toISOString(),
          endsAt: null,
          reason: 'Controlled closure test',
        },
        a.token,
      );
      assert.equal(closed.status, 201, await closed.clone().text());
      const unavailable = await req(`/v1/places/${placeA}/arrival?mode=walking&stepFree=true`);
      const noStepFree = (await unavailable.json()) as any;
      assert.equal(noStepFree.status, 'unavailable');
      assert.equal(noStepFree.route, null);
      assert.notEqual(unavailable.headers.get('etag'), guide.headers.get('etag'));
      const slightlyPast = encodeURIComponent(new Date(Date.now() - 60000).toISOString());
      assert.equal(
        (
          (await (
            await req(`/v1/places/${placeA}/arrival?stepFree=true&departureAt=${slightlyPast}`)
          ).json()) as any
        ).status,
        'unavailable',
        'Small client clock skew must not bypass a current closure.',
      );
      const stairs = (await (await req(`/v1/places/${placeA}/arrival?mode=walking`)).json()) as any;
      assert.equal(stairs.status, 'available');
      assert(stairs.route.edgeIDs.includes('stairs-up'));
      assert.equal((await req(`/v1/media/${upload.id}`, 'DELETE', undefined, a.token)).status, 200);
      assert.equal((await req(new URL(asset.url).pathname)).status, 404);
      assert.equal(
        ((await (await req(`/v1/places/${placeA}/arrival`)).json()) as any).status,
        'unavailable',
      );
      const revokedListing = (await (
        await req(mediaListPath, 'GET', undefined, a.token)
      ).json()) as any;
      assert.equal(revokedListing.assets[0].publicApproved, false);
      assert.equal(revokedListing.assets[0].publicAsset, null);
      assert.equal((await req(`/places/${placeA}/arrival`)).status, 200);
      await workerPool.query(
        "INSERT INTO media_assets(tenant_id,place_id,purpose,alt,rights,created_by) SELECT $1,$2,'checkpoint','Synthetic quota reservation','{}'::jsonb,$3 FROM generate_series(1,100)",
        [tenantA, placeA, a.user.id],
      );
      const overQuota = await command(
        '/v1/media/uploads',
        {
          tenantID: tenantA,
          placeID: placeA,
          purpose: 'checkpoint',
          alt: 'Over quota',
          rights: {
            basis: 'owned',
            holder: 'Test',
            publicUse: true,
            permissionNote: 'Synthetic fixture only',
            expiresAt: null,
          },
        },
        a.token,
      );
      assert.equal(overQuota.status, 409);
      assert.equal(((await overQuota.json()) as any).error.code, 'media_quota');
      assert.equal(
        (
          await command(
            `${prefix}/arrival-drafts/${graph.graphID}/withdraw`,
            { reason: 'Finished controlled integration test' },
            a.token,
          )
        ).status,
        200,
      );
      assert.equal(
        ((await (await req(`/v1/places/${placeA}/arrival`)).json()) as any).status,
        'listing_only',
      );
    } finally {
      await workerPool
        .query("UPDATE places SET state='withdrawn',revision=revision+1 WHERE id=ANY($1::text[])", [
          [placeA, placeB],
        ])
        .catch(() => {});
      await workerPool
        .query('UPDATE arrival_releases SET withdrawn_at=now() WHERE graph_id=$1', [
          `graph-${suffix}`,
        ])
        .catch(() => {});
      await workerPool
        .query('UPDATE public_media SET revoked_at=now() WHERE tenant_id=ANY($1::uuid[])', [
          [tenantA, tenantB],
        ])
        .catch(() => {});
      process.env.INTERNAL_API = priorOps;
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
      await rm(storage, { recursive: true, force: true });
    }
  },
);
