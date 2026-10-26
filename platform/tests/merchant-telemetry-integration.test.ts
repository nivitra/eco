import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test(
  'trusted telemetry deduplicates logs, separates HEAD/synthetic/304, restricts tenants and resumes a file cursor',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { pool, workerPool, withActor } = await import('../src/db.js'),
      { ingestEdgeBatch, collectCaddyLog } = await import('../src/modules/telemetry.js'),
      { authPool } = await import('../src/auth.js');
    const id = randomUUID(),
      actor = 'telemetry-test-' + id,
      place = 'telemetry-place-' + id,
      now = Date.now(),
      folder = await mkdtemp(join(tmpdir(), 'kulture-telemetry-'));
    let tenant: string;
    try {
      tenant = (
        await workerPool.query('INSERT INTO tenants(name,created_by) VALUES($1,$2) RETURNING id', [
          'Telemetry test',
          actor,
        ])
      ).rows[0].id;
      await workerPool.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        [tenant, actor],
      );
      await workerPool.query(
        "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Telemetry fixture','cafes','Jubilee Hills','Test-only address','Test fixture','2026-09-26','Test')",
        [place],
      );
      const claim = (
        await workerPool.query(
          "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{}','approved',now()-interval '1 hour') RETURNING id",
          [tenant, place, actor],
        )
      ).rows[0].id;
      const draft = (
        await workerPool.query(
          "INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,rights_confirmed,created_by) VALUES($1,$2,$3,1,'{}',true,$4) RETURNING id",
          [tenant, place, claim, actor],
        )
      ).rows[0].id;
      const publication = (
        await workerPool.query(
          "INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,status,published_at) VALUES($1,$2,$3,1,2,'{}',$4,'<html>test</html>',$5,'live',now()) RETURNING id",
          [tenant, place, draft, 'a'.repeat(64), `/hyderabad/places/${place}`],
        )
      ).rows[0].id;
      await workerPool.query(
        "INSERT INTO public_pages(place_id,publication_id,canonical_path,revision,snapshot,html,digest,published_at) VALUES($1,$2,$3,2,'{}','<html>test</html>',$4,now())",
        [place, publication, `/hyderabad/places/${place}`, 'a'.repeat(64)],
      );
      await workerPool.query(
        "INSERT INTO crawler_rule_snapshots(provider,role,user_agent_token,source_url,ranges,checksum,first_seen_at,fetched_at,expires_at) VALUES('OpenAI','search','OAI-SearchBot','https://openai.com/searchbot.json','[\"192.0.2.0/24\"]',$1,now()-interval '2 hours',now()-interval '1 hour',now()+interval '1 hour')",
        [id],
      );
      const base = {
        host: 'localhost:3000',
        observedAt: new Date(now).toISOString(),
        path: `/hyderabad/places/${place}`,
        method: 'GET',
        clientIP: '192.0.2.1',
        userAgent: 'OAI-SearchBot/1.0',
        status: 200,
        contentType: 'text/html',
        synthetic: false,
        pageRevision: 2,
      };
      const records = [
        { ...base, requestID: id + '-get' },
        { ...base, requestID: id + '-head', method: 'HEAD' },
        { ...base, requestID: id + '-304', status: 304 },
        { ...base, requestID: id + '-synthetic', synthetic: true },
        { ...base, requestID: id + '-spoof', clientIP: '203.0.113.1' },
      ];
      const batch = {
        source: 'caddy-access',
        batchID: id,
        windowStart: new Date(now - 1).toISOString(),
        windowEnd: new Date(now + 1).toISOString(),
        coverage: 'partial',
        expectedRecords: 5,
        records,
      };
      assert.equal((await ingestEdgeBatch(batch)).accepted, 5);
      assert((await ingestEdgeBatch(batch)).duplicate);
      await assert.rejects(ingestEdgeBatch({ ...batch, coverage: 'complete' }), {
        code: 'batch_conflict',
      });
      const qualified = await withActor(actor, (db) =>
        db.query(
          "SELECT count(*)::int AS n FROM crawler_events WHERE place_id=$1 AND method='GET' AND status=200 AND content_type='text/html' AND synthetic=false AND verification='verified'",
          [place],
        ),
      );
      assert.equal(qualified.rows[0].n, 1);
      const denied = await withActor('unrelated-' + id, (db) =>
        db.query('SELECT * FROM crawler_events WHERE place_id=$1', [place]),
      );
      assert.equal(denied.rowCount, 0);
      const stored = (
        await workerPool.query('SELECT * FROM crawler_events WHERE source=$1 AND request_id=$2', [
          'caddy-access',
          id + '-get',
        ])
      ).rows[0];
      assert(!JSON.stringify(stored).includes('192.0.2.1'));
      assert.equal(stored.verification, 'verified');
      const file = join(folder, 'discovery.json');
      const log = (requestID: string) =>
        JSON.stringify({
          ts: now / 1000,
          request: {
            host: 'localhost:3000',
            uri: `/hyderabad/places/${place}?private=redact`,
            method: 'GET',
            remote_ip: '192.0.2.1',
            headers: { 'User-Agent': ['OAI-SearchBot/1.0'] },
          },
          status: 200,
          resp_headers: {
            'Content-Type': ['text/html'],
            'X-Request-ID': [requestID],
            'X-Kulture-Page-Revision': ['2'],
          },
        }) + '\n';
      await writeFile(file, log(id + '-file'));
      assert.equal((await collectCaddyLog(file)).records, 1);
      assert.equal((await collectCaddyLog(file)).records, 0);
      await appendFile(file, log(id + '-file-2'));
      assert.equal((await collectCaddyLog(file)).records, 1);
      await rename(file, file + '.old');
      await writeFile(file, log(id + '-file'));
      assert.equal((await collectCaddyLog(file)).records, 1);
      assert.equal(
        (
          await workerPool.query(
            'SELECT count(*)::int AS n FROM crawler_events WHERE place_id=$1',
            [place],
          )
        ).rows[0].n,
        7,
      );
    } finally {
      await workerPool.query('UPDATE public_pages SET withdrawn_at=now() WHERE place_id=$1', [
        place,
      ]);
      await workerPool.query("UPDATE places SET state='withdrawn' WHERE id=$1", [place]);
      await rm(folder, { recursive: true, force: true });
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
