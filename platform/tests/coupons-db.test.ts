import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('coupon RLS and public projection follow approval, publication and on/off state',
  { skip: process.env.RUN_DB_TESTS !== 'true' }, async () => {
    const connectionString = process.env.ADMIN_DATABASE_URL;
    assert(connectionString, 'ADMIN_DATABASE_URL is required');
    const db = new pg.Client({ connectionString });
    await db.connect();
    const suffix = randomUUID();
    const tenant = randomUUID(), claim = randomUUID(), draft = randomUUID(), publication = randomUUID();
    const place = `coupon-test-${suffix}`;
    const actor = `coupon-fixture-${suffix}`;
    const profile = { name: 'Coupon fixture', offerings: [
      { id: 'tea', name: 'Tea', kind: 'product' }, { id: 'delivery', name: 'Delivery', kind: 'service' },
    ] };
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [tenant, 'Coupon fixture', actor]);
      await db.query("INSERT INTO memberships(tenant_id,user_id,role,state,scope_mode) VALUES($1,$2,'owner','active','all')", [tenant, actor]);
      await db.query(`INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query,state)
        VALUES($1,$1,'Coupon fixture','business','Test locality','Test address','Test business only','2026-10-27','Coupon fixture','published')`, [place]);
      await db.query(`INSERT INTO merchant_claims(id,tenant_id,place_id,submitted_by,evidence,state,reviewed_at)
        VALUES($1,$2,$3,$4,'{}','approved',now())`, [claim, tenant, place, actor]);
      await db.query(`INSERT INTO merchant_drafts(id,tenant_id,place_id,claim_id,base_place_revision,profile,created_by)
        VALUES($1,$2,$3,$4,1,$5,$6)`, [draft, tenant, place, claim, JSON.stringify(profile), actor]);
      await db.query(`INSERT INTO publications(id,tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,status,published_at)
        VALUES($1,$2,$3,$4,1,1,$5,$6,'<html></html>',$7,'live',now())`,
        [publication, tenant, place, draft, JSON.stringify({ profile }), 'a'.repeat(64), `/hyderabad/places/${place}`]);
      await db.query(`INSERT INTO public_pages(place_id,publication_id,canonical_path,revision,snapshot,html,digest,published_at)
        VALUES($1,$2,$3,1,$4,'<html></html>',$5,now())`,
        [place, publication, `/hyderabad/places/${place}`, JSON.stringify({ profile }), 'a'.repeat(64)]);
      await db.query(`INSERT INTO merchant_coupons(tenant_id,place_id,claim_id,code,title,discount_kind,discount_value,scope,enabled,created_by)
        VALUES($1,$2,$3,'TEST20','Test product offer','percent',20,'all_products',true,$4)`, [tenant, place, claim, actor]);

      await db.query('SET LOCAL ROLE kulture_app');
      await db.query("SELECT set_config('app.actor_id',$1,true)", [actor]);
      assert.equal((await db.query('SELECT id FROM merchant_coupons WHERE place_id=$1', [place])).rowCount, 1);
      assert.equal((await db.query('SELECT id FROM public_active_coupons($1)', [place])).rowCount, 1);
      await db.query("SELECT set_config('app.actor_id','other-user',true)");
      assert.equal((await db.query('SELECT id FROM merchant_coupons WHERE place_id=$1', [place])).rowCount, 0);
      assert.equal((await db.query('SELECT id FROM public_active_coupons($1)', [place])).rowCount, 1);
      await db.query("SELECT set_config('app.actor_id',$1,true)", [actor]);
      await db.query('UPDATE merchant_coupons SET enabled=false WHERE place_id=$1', [place]);
      assert.equal((await db.query('SELECT id FROM public_active_coupons($1)', [place])).rowCount, 0);
    } finally {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    }
  });
