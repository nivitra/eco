import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

test(
  'catalog search combines public words and approved offerings without exposing drafts or hidden businesses',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { registerConsumer } = await import('../src/modules/consumer.js');
    const { pool, workerPool } = await import('../src/db.js');
    const { authPool } = await import('../src/auth.js');
    const app = new Hono();
    registerConsumer(app);
    const tenantID = randomUUID();
    const suffix = randomUUID();
    const ids = ['published', 'excluded', 'pending', 'research', 'closed'].map(
      (kind) => `catalog-search-${kind}-${suffix}`,
    );
    const [publishedID, excludedID, pendingID, researchID, closedID] = ids;
    const privateTerm = `private-${suffix}`;
    const unpublishedTerm = `unpublished-${suffix}`;
    const profile = {
      name: 'Amul Stationery',
      offerings: [{ id: 'pens', name: 'Pens', description: 'Refillable fountain writing tools' }],
    };
    const search = async (q: string, extra: Record<string, string> = {}) => {
      const response = await app.request('/v1/places?' + new URLSearchParams({ q, ...extra }));
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { places: { id: string }[] }).places.map((p) => p.id);
    };
    try {
      await workerPool.query(
        "INSERT INTO tenants(id,name,created_by) VALUES($1,'Search fixture','search-fixture')",
        [tenantID],
      );
      for (const [index, id] of ids.entries()) {
        await workerPool.query(
          `INSERT INTO places(id,slug,name,category,neighborhood,address,summary,tags,
            researched_at,search_query,state,consumer_eligible,catalog_data)
          VALUES($1,$1,$2,$3,'Jubilee Hills','Road 45, Hyderabad',$4,$5::jsonb,
            '2026-09-29','Amul Stationery',$6,$7,$8::jsonb)`,
          [
            id,
            index === 0 || index === 3 ? 'Amul Stationery' : 'Amul Pens',
            index === 1 ? 'business' : 'shopping',
            'School and office supplies. Literal %_ voucher code.',
            JSON.stringify(['Notebooks']),
            ['published', 'published', 'draft', 'research', 'closed'][index],
            index !== 1,
            JSON.stringify({
              offerings: [{ name: unpublishedTerm }],
              privateEvidence: privateTerm,
            }),
          ],
        );
      }
      const claim = (
        await workerPool.query(
          `INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at)
         VALUES($1,$2,'search-fixture','{}','approved',now()) RETURNING id`,
          [tenantID, publishedID],
        )
      ).rows[0];
      const draft = (
        await workerPool.query(
          `INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,created_by)
         VALUES($1,$2,$3,1,$4,'search-fixture') RETURNING id`,
          [
            tenantID,
            publishedID,
            claim.id,
            JSON.stringify({ ...profile, offerings: [{ name: privateTerm }] }),
          ],
        )
      ).rows[0];
      const snapshot = JSON.stringify({ profile });
      const path = `/hyderabad/places/${publishedID}`;
      const publication = (
        await workerPool.query(
          `INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,status,published_at)
         VALUES($1,$2,$3,1,1,$4,$5,'<p>Published fixture</p>',$6,'live',now()) RETURNING id`,
          [tenantID, publishedID, draft.id, snapshot, 'a'.repeat(64), path],
        )
      ).rows[0];
      await workerPool.query(
        `INSERT INTO public_pages(place_id,publication_id,canonical_path,revision,snapshot,html,digest,published_at)
         VALUES($1,$2,$3,1,$4,'<p>Published fixture</p>',$5,now())`,
        [publishedID, publication.id, path, snapshot, 'a'.repeat(64)],
      );

      assert((await search('amul stationery')).includes(publishedID));
      const products = await search('  AMUL   pens  ');
      assert(products.includes(publishedID), 'words may match name and a published offering');
      for (const id of [excludedID, pendingID, researchID, closedID])
        assert(!products.includes(id), `ineligible or nonmatching fixture ${id} must stay hidden`);
      assert(
        (await search('amul fountain')).includes(publishedID),
        'offering description is public',
      );
      assert((await search('amul supplies')).includes(publishedID), 'summary is searchable');
      assert((await search('amul notebooks')).includes(publishedID), 'tags are searchable');
      assert(
        (await search('amul Road 45')).includes(publishedID),
        'address tokens remain searchable',
      );
      assert(
        !(await search('amul pens nonexistent-product')).includes(publishedID),
        'all tokens required',
      );
      assert(!(await search('amul pens', { category: 'food' })).includes(publishedID));
      assert(
        !(await search(privateTerm)).includes(publishedID),
        'private draft and evidence are excluded',
      );
      assert(
        !(await search(unpublishedTerm)).some((id) => ids.includes(id)),
        'catalog_data is not an approved offering source',
      );
      assert(
        (await search('amul %_')).includes(publishedID),
        'literal wildcard characters can match',
      );
      await workerPool.query('UPDATE places SET summary=$2 WHERE id=$1', [
        publishedID,
        'School and office supplies.',
      ]);
      assert(
        !(await search('amul %_')).includes(publishedID),
        'percent and underscore cannot broaden matches',
      );
      assert(
        !(await search("amul ' OR true --")).includes(publishedID),
        'query remains bound data',
      );
      await workerPool.query('UPDATE public_pages SET withdrawn_at=now() WHERE place_id=$1', [
        publishedID,
      ]);
      assert(!(await search('amul pens')).includes(publishedID), 'withdrawn offerings disappear');
    } finally {
      await workerPool.query('DELETE FROM public_pages WHERE place_id=ANY($1::text[])', [ids]);
      await workerPool.query('DELETE FROM publications WHERE tenant_id=$1', [tenantID]);
      await workerPool.query('DELETE FROM merchant_drafts WHERE tenant_id=$1', [tenantID]);
      await workerPool.query('DELETE FROM merchant_claims WHERE tenant_id=$1', [tenantID]);
      await workerPool.query('DELETE FROM places WHERE id=ANY($1::text[])', [ids]);
      await workerPool.query('DELETE FROM tenants WHERE id=$1', [tenantID]);
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
