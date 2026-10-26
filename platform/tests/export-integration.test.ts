import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
const digest = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function unpack(bytes: Buffer) {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ''), 8);
    assert.equal(header[156], 48, 'Only regular files are allowed');
    files.set(path, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test(
  'unpaid location archive exports real derivatives and exact publications, without cross-tenant content or private evidence',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'kulture-export-db-'));
    process.env.MEDIA_ROOT = storage;
    const { app } = await import('../src/app.js'),
      { pool, workerPool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js');
    const { mediaStorage } = await import('../src/storage/filesystem.js');
    const { prepareLocationArchive, archiveStream, EXPORT_LIMITS } = await import(
      '../src/modules/export.js'
    );
    const suffix = randomUUID(),
      tenantA = randomUUID(),
      tenantB = randomUUID(),
      placeA = 'export-a-' + suffix,
      placeB = 'export-b-' + suffix;
    const request = (path: string, token?: string, method = 'GET', body?: unknown) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::7`,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    async function signup(name: string) {
      const r = await request('/api/auth/sign-up/email', undefined, 'POST', {
        name,
        email: `${name}-${suffix}@example.test`,
        password: 'Archive-fixture-long-password!',
      });
      assert.equal(r.status, 200, await r.clone().text());
      return { token: r.headers.get('set-auth-token')!, user: ((await r.json()) as any).user };
    }
    const privateMarker = 'PRIVATE_PROOF_ORIGINAL_CREDENTIAL_MUST_NEVER_EXPORT';
    try {
      const owner = await signup('export-owner'),
        other = await signup('export-other');
      for (const [tenant, place, user] of [
        [tenantA, placeA, owner.user.id],
        [tenantB, placeB, other.user.id],
      ]) {
        await workerPool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [
          tenant,
          'Controlled export test',
          user,
        ]);
        await workerPool.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
          [tenant, user],
        );
        await workerPool.query(
          "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'నమస్తే Café','cafes','Jubilee Hills','Synthetic export fixture','Controlled test data only','2026-09-29','test')",
          [place],
        );
      }
      const claim = (
        await workerPool.query(
          "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at,review_reason) VALUES($1,$2,$3,$4,'approved',now(),$5) RETURNING id",
          [tenantA, placeA, owner.user.id, { privateProof: privateMarker }, privateMarker],
        )
      ).rows[0];
      const profile = {
        name: 'నమస్తే Café',
        category: 'cafes',
        neighborhood: 'Jubilee Hills',
        address: 'Synthetic export fixture',
        summary: 'Controlled export test, not a real venue.',
        tags: [],
      };
      const draft = (
        await workerPool.query(
          'INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,created_by) VALUES($1,$2,$3,1,$4,$5) RETURNING id',
          [tenantA, placeA, claim.id, profile, owner.user.id],
        )
      ).rows[0];
      const page = '<!doctype html><title>నమస్తే Café</title><p>Exact archived page — ₹299.</p>';
      const publication = (
        await workerPool.query(
          "INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,status,published_at) VALUES($1,$2,$3,1,1,$4,$5,$6,$7,'live',now()) RETURNING id",
          [
            tenantA,
            placeA,
            draft.id,
            { profile },
            digest(page),
            page,
            '/hyderabad/places/' + placeA,
          ],
        )
      ).rows[0];
      const target = (
        await workerPool.query(
          "INSERT INTO publication_destinations(tenant_id,place_id,kind,public_url,canonical_url,last_applied_hash) VALUES($1,$2,'hosted',$3,$3,$4) RETURNING id",
          [tenantA, placeA, 'https://example.test/sites/' + placeA, digest(page)],
        )
      ).rows[0];
      const preview = (
        await workerPool.query(
          "INSERT INTO destination_previews(destination_id,tenant_id,place_id,draft_id,draft_version,target_version,sequence,snapshot,fragment,html,metadata,base_content_hash,artifact_digest,metadata_digest,digest,renderer_version,template_hash,expires_at) VALUES($1,$2,$3,$4,1,1,1,$5,$6,$6,$7,$8,$8,$8,$8,'test',$8,now()+interval '1 hour') RETURNING id",
          [
            target.id,
            tenantA,
            placeA,
            draft.id,
            { profile },
            page,
            { canonical: 'https://example.test/sites/' + placeA },
            digest(page),
          ],
        )
      ).rows[0];
      const delivery = (
        await workerPool.query(
          "INSERT INTO target_deliveries(tenant_id,place_id,destination_id,publication_id,preview_id,sequence,state,applied_at,envelope) VALUES($1,$2,$3,$4,$5,1,'verified',now(),$6) RETURNING id",
          [
            tenantA,
            placeA,
            target.id,
            publication.id,
            preview.id,
            { privateSentinel: privateMarker },
          ],
        )
      ).rows[0];
      const pixels = await sharp({
        create: { width: 24, height: 12, channels: 3, background: '#aabb88' },
      })
        .webp()
        .toBuffer();
      const ids: Record<string, string> = {};
      for (const status of ['approved', 'revoked', 'expired', 'unapproved', 'other-place']) {
        const id = randomUUID();
        ids[status] = id;
        const key = `derivatives/${id}/image.webp`,
          original = `private/${id}/original`;
        await mediaStorage.write(key, new Response(pixels).body!, pixels.length);
        await mediaStorage.write(original, new Response(privateMarker).body!, 500);
        const tid = status === 'other-place' ? tenantB : tenantA,
          pid = status === 'other-place' ? placeB : placeA;
        const rights = {
          basis: 'owned',
          holder: 'Test fixture',
          publicUse: true,
          permissionNote: privateMarker,
          expiresAt: status === 'expired' ? '2020-01-01T00:00:00Z' : null,
        };
        await workerPool.query(
          "INSERT INTO media_assets(id,tenant_id,place_id,purpose,alt,rights,state,original_key,derivative_key,sha256,mime,width,height,stored_bytes,created_by) VALUES($1,$2,$3,'checkpoint','Synthetic pixels',$4,'ready',$5,$6,$7,'image/webp',24,12,$8,$9)",
          [id, tid, pid, rights, original, key, digest(pixels), pixels.length, owner.user.id],
        );
        if (status !== 'unapproved')
          await workerPool.query(
            "INSERT INTO public_media(id,tenant_id,place_id,derivative_key,sha256,mime,alt,width,height,revision,revoked_at) VALUES($1,$2,$3,$4,$5,'image/webp','Synthetic pixels',24,12,1,$6)",
            [id, tid, pid, key, digest(pixels), status === 'revoked' ? new Date() : null],
          );
      }
      const graph = JSON.parse(
        await readFile(new URL('fixtures/arrival-graph-v2.json', import.meta.url), 'utf8'),
      );
      graph.graphID = 'export-graph-' + suffix;
      graph.buildingID = 'export-site-' + suffix;
      graph.placeDestinationBindings[0].placeID = placeA;
      for (const node of graph.nodes) node.permittedPhotoIDs = [ids.approved];
      await workerPool.query(
        "INSERT INTO arrival_sites(id,tenant_id,origin_place_id,name,authority_state) VALUES($1,$2,$3,'Synthetic owned building','approved')",
        [graph.buildingID, tenantA, placeA],
      );
      await workerPool.query(
        "INSERT INTO arrival_drafts(graph_id,site_id,tenant_id,place_id,body,state,created_by,review_note,review_evidence) VALUES($1,$2,$3,$4,$5,'published',$6,$7,$8)",
        [
          graph.graphID,
          graph.buildingID,
          tenantA,
          placeA,
          graph,
          owner.user.id,
          privateMarker,
          { privateEvidence: privateMarker },
        ],
      );
      const release = (
        await workerPool.query(
          "INSERT INTO arrival_releases(graph_id,site_id,revision,graph,assets,manifest_json,digest,verification) VALUES($1,$2,1,$3,'[]',$4,$5,$6) RETURNING id",
          [
            graph.graphID,
            graph.buildingID,
            graph,
            JSON.stringify(graph),
            digest(JSON.stringify(graph)),
            { source: 'owner_confirmed', validUntil: '2027-01-01T00:00:00Z' },
          ],
        )
      ).rows[0];
      // A grant to edit someone else's building must not convey export ownership.
      const shared = structuredClone(graph);
      shared.graphID += '-shared';
      shared.buildingID += '-shared';
      shared.name = 'SHARED_GRAPH_NOT_OWNED';
      await workerPool.query(
        "INSERT INTO arrival_sites(id,tenant_id,origin_place_id,name,authority_state) VALUES($1,$2,$3,'Other tenant building','approved')",
        [shared.buildingID, tenantB, placeB],
      );
      await workerPool.query(
        'INSERT INTO arrival_site_grants(site_id,tenant_id,place_id,can_edit) VALUES($1,$2,$3,true)',
        [shared.buildingID, tenantA, placeA],
      );
      await workerPool.query(
        "INSERT INTO arrival_drafts(graph_id,site_id,tenant_id,place_id,body,state,created_by) VALUES($1,$2,$3,$4,$5,'published',$6)",
        [shared.graphID, shared.buildingID, tenantA, placeA, shared, owner.user.id],
      );
      await workerPool.query(
        "INSERT INTO arrival_releases(graph_id,site_id,revision,graph,assets,manifest_json,digest,verification) VALUES($1,$2,1,$3,'[]',$4,$5,'{}')",
        [
          shared.graphID,
          shared.buildingID,
          shared,
          JSON.stringify(shared),
          digest(JSON.stringify(shared)),
        ],
      );
      const path = `/v1/tenants/${tenantA}/places/${placeA}/export/archive`;
      assert.equal((await request(path, other.token)).status, 404);
      const response = await request(path, owner.token);
      assert.equal(response.status, 200, response.status !== 200 ? await response.text() : '');
      assert.equal(response.headers.get('content-type'), 'application/x-tar');
      assert.match(response.headers.get('content-disposition')!, /attachment; filename="kulture-/);
      assert.match(response.headers.get('cache-control')!, /no-store/);
      const archive = Buffer.from(await response.arrayBuffer()),
        files = unpack(archive);
      assert.equal(archive.length, Number(response.headers.get('content-length')));
      assert.equal(files.get(`publications/${publication.id}.html`)!.toString(), page);
      assert.equal(files.get(`websites/${delivery.id}.html`)!.toString(), page);
      assert.deepEqual(files.get(`media/${ids.approved}.webp`), pixels);
      assert.equal([...files.keys()].filter((x) => x.endsWith('.webp')).length, 1);
      assert(files.has(`arrival/${release.id}.json`));
      assert(!archive.includes(Buffer.from(privateMarker)));
      assert(!archive.includes(Buffer.from('SHARED_GRAPH_NOT_OWNED')));
      const manifest = JSON.parse(files.get('manifest.json')!.toString());
      for (const item of manifest.files) {
        const bytes = files.get(item.path)!;
        assert.equal(bytes.length, item.bytes);
        assert.equal(digest(bytes), item.sha256);
      }
      assert.equal(manifest.counts.publicDerivatives, 1);
      assert.equal(manifest.counts.ownedArrivalReleases, 1);
      assert.equal(
        (
          await workerPool.query(
            'SELECT count(*)::int AS n FROM service_grants WHERE tenant_id=$1',
            [tenantA],
          )
        ).rows[0].n,
        0,
        'Export works without a plan or pilot',
      );
      await workerPool.query(
        "INSERT INTO memberships(tenant_id,user_id,role,scope_mode) VALUES($1,$2,'manager','selected')",
        [tenantA, other.user.id],
      );
      assert.equal(
        (await request(path, other.token)).status,
        404,
        'Manager must have this location in scope',
      );
      await workerPool.query('INSERT INTO membership_places VALUES($1,$2,$3)', [
        tenantA,
        other.user.id,
        placeA,
      ]);
      const manager = await request(path, other.token);
      assert.equal(manager.status, 200);
      await manager.arrayBuffer();
      await workerPool.query(
        "UPDATE memberships SET role='editor' WHERE tenant_id=$1 AND user_id=$2",
        [tenantA, other.user.id],
      );
      assert.equal(
        (await request(path, other.token)).status,
        403,
        'Read access alone cannot export',
      );
      const planned = await prepareLocationArchive(owner.user.id, tenantA, placeA);
      await workerPool.query('UPDATE public_media SET revoked_at=now() WHERE id=$1', [
        ids.approved,
      ]);
      await assert.rejects(
        () => new Response(archiveStream(planned, new Date())).arrayBuffer(),
        /private|unreviewed|unavailable|expired|location/i,
        'Revocation after preparation aborts the download',
      );
      const after = await request(path, owner.token);
      assert.equal(after.status, 200);
      const afterFiles = unpack(Buffer.from(await after.arrayBuffer()));
      assert(![...afterFiles.keys()].some((x) => x.endsWith('.webp')));
      await workerPool.query('UPDATE publications SET html=repeat($2,$3) WHERE id=$1', [
        publication.id,
        'x',
        EXPORT_LIMITS.textBytes,
      ]);
      await assert.rejects(
        () => prepareLocationArchive(owner.user.id, tenantA, placeA),
        (error: any) => error.status === 413 && error.code === 'export_too_large',
      );
    } finally {
      await workerPool
        .query("UPDATE places SET state='withdrawn' WHERE id=ANY($1::text[])", [[placeA, placeB]])
        .catch(() => {});
      await workerPool
        .query(
          "UPDATE publications SET html='Archived synthetic test fixture',status='withdrawn' WHERE tenant_id=$1 AND place_id=$2",
          [tenantA, placeA],
        )
        .catch(() => {});
      await workerPool
        .query('UPDATE public_media SET revoked_at=now() WHERE tenant_id=ANY($1::uuid[])', [
          [tenantA, tenantB],
        ])
        .catch(() => {});
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
      await rm(storage, { recursive: true, force: true });
    }
  },
);
