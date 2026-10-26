import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

// An explicitly disposable database only. No seeds, profile tables, production role or service are touched.
test('real PostgreSQL outing links: RLS, capability isolation, atomic retry/quota, immutability, expiry and revocation',
 {skip:!process.env.OUTING_SHARE_TEST_DATABASE_URL},async t=>{
 const adminURL=new URL(process.env.OUTING_SHARE_TEST_DATABASE_URL!);
 assert.match(adminURL.pathname,/^\/kulture_outing_test_[a-z0-9_]+$/,'Use an isolated database created for these tests.');
 assert(['localhost','127.0.0.1','[::1]'].includes(adminURL.hostname),'Integration tests require a local PostgreSQL fixture.');
 const admin=new pg.Pool({connectionString:adminURL.toString(),max:2});
 const suffix=randomUUID().replaceAll('-',''),role='outing_test_'+suffix,password='fixture-only-'+randomUUID();
 let runtimePool:pg.Pool|undefined,authPool:pg.Pool|undefined;
 const q=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 try{
  assert.equal((await admin.query("SELECT to_regclass('public.outing_shares') AS table_name")).rows[0].table_name,null,'Fixture database must be fresh.');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${q(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.query(`CREATE TABLE places(id text PRIMARY KEY,name text NOT NULL,category text NOT NULL,neighborhood text NOT NULL,address text NOT NULL,summary text NOT NULL,tags jsonb NOT NULL,source_urls jsonb NOT NULL,researched_at text NOT NULL,search_query text NOT NULL,revision integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'research',consumer_eligible boolean NOT NULL DEFAULT true,catalog_data jsonb NOT NULL DEFAULT '{}')`);
  await admin.query("ALTER TABLE places ENABLE ROW LEVEL SECURITY;ALTER TABLE places FORCE ROW LEVEL SECURITY;CREATE POLICY public_read ON places FOR SELECT USING(state IN ('research','published'))");
  await admin.query("CREATE TABLE public_pages(place_id text PRIMARY KEY,snapshot jsonb NOT NULL,withdrawn_at timestamptz);ALTER TABLE public_pages ENABLE ROW LEVEL SECURITY;ALTER TABLE public_pages FORCE ROW LEVEL SECURITY;CREATE POLICY public_page_read ON public_pages FOR SELECT USING(withdrawn_at IS NULL)");
  await admin.query(await readFile(new URL('../migrations/023-outing-shares.sql',import.meta.url),'utf8'));
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role};GRANT SELECT ON places,public_pages TO ${role};GRANT SELECT,INSERT,UPDATE,DELETE ON outing_shares TO ${role}`);
  await admin.query("INSERT INTO places(id,name,category,neighborhood,address,summary,tags,source_urls,researched_at,search_query) VALUES('cafe','Corner Cafe','cafes','Jubilee Hills','Road 36','Source-listed café','[\"Coffee\"]','[\"https://venue.example/cafe\"]','2026-10-10','Corner Cafe'),('park','Central Park','parks','Jubilee Hills','Road 45','Source-listed park','[\"Urban park\"]','[\"https://venue.example/park\"]','2026-10-10','Central Park')");
  const runtimeURL=new URL(adminURL);runtimeURL.username=role;runtimeURL.password=password;
  process.env.PUBLIC_URL='https://kulture.example';process.env.BETTER_AUTH_SECRET='test-only-outing-auth-secret-never-production';process.env.OPS_TOKEN='test-only-outing-ops-token-never-production';
  process.env.DATABASE_URL=runtimeURL.toString();process.env.AUTH_DATABASE_URL=runtimeURL.toString();
  const dbModule=await import('../src/db.js');runtimePool=dbModule.pool;authPool=(await import('../src/auth.js')).authPool;
  const {withActor,HttpError}=dbModule;
  const {outingShareRepository:repository}=await import('../src/modules/outing-shares.js');
  const request=(title='Afternoon',placeIDs=['cafe','park'])=>({requestID:randomUUID(),title,placeIDs});
  const body=request(),first=await repository.create('alice',body);
  await t.test('only owner and exact live token can read; token transaction cannot persist authority',async()=>{
   assert.equal((await runtimePool!.query('SELECT id FROM outing_shares')).rowCount,0);
   assert.equal(await withActor('alice',async db=>(await db.query('SELECT id FROM outing_shares')).rowCount),1);
   assert.equal(await withActor('bob',async db=>(await db.query('SELECT id FROM outing_shares')).rowCount),0);
   assert.equal(await withActor('bob',async db=>(await db.query('UPDATE outing_shares SET revoked_at=now() WHERE id=$1',[first.id])).rowCount),0);
   assert.equal(await withActor('alice',async db=>(await db.query('DELETE FROM outing_shares WHERE id=$1',[first.id])).rowCount),0);
   await assert.rejects(withActor('bob',db=>db.query('INSERT INTO outing_shares(owner_id,request_id,title,place_ids) VALUES($1,$2,$3,$4)',['alice',randomUUID(),'Wrong owner',['cafe']])),(e:any)=>e.code==='42501');
   const publicShare=await repository.read(first.id);assert.deepEqual(publicShare,first);assert(!JSON.stringify(publicShare).includes('alice'));
   assert.equal(await repository.read(randomUUID()),null);
   assert.equal((await runtimePool!.query('SELECT id FROM outing_shares')).rowCount,0);
   const client=await runtimePool!.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.outing_share_id',$1,true)",[first.id]);assert.equal((await client.query('SELECT id FROM outing_shares')).rowCount,1);await client.query('COMMIT');assert.equal((await client.query('SELECT id FROM outing_shares')).rowCount,0);}finally{client.release();}
  });
  await t.test('same request has one winner across concurrent attempts; changed content conflicts',async()=>{
   const simultaneous=request('Concurrent');const results=await Promise.all(Array.from({length:12},()=>repository.create('retry-owner',simultaneous)));
   assert.equal(new Set(results.map(r=>r.id)).size,1);assert(results.every(r=>r.id!==first.id));
   assert.equal(Number((await admin.query('SELECT count(*) FROM outing_shares WHERE owner_id=$1',['retry-owner'])).rows[0].count),1);
   await assert.rejects(repository.create('retry-owner',{...simultaneous,placeIDs:['park','cafe']}),(e:unknown)=>e instanceof HttpError&&e.status===409&&e.code==='idempotency_conflict');
  });
  await t.test('active20 quota survives concurrent different request IDs without truncation',async()=>{
   const results=await Promise.allSettled(Array.from({length:25},(_,i)=>repository.create('quota-owner',request('Outing '+i))));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,20);assert.equal(results.filter(r=>r.status==='rejected').length,5);
   for(const result of results)if(result.status==='rejected')assert(result.reason instanceof HttpError&&result.reason.status===429&&result.reason.code==='outing_share_limit');
   const listed=await repository.list('quota-owner');assert.equal(listed.length,20);
   await repository.revoke('quota-owner',listed[0].id);await repository.create('quota-owner',request('Replacement'));
   assert.equal(Number((await admin.query('SELECT count(*) FROM outing_shares WHERE owner_id=$1 AND revoked_at IS NULL',['quota-owner'])).rows[0].count),20);
  });
  await t.test('database rejects forged timestamps, duplicate IDs and edits to reviewed content',async()=>{
   for(const sql of ["UPDATE outing_shares SET title='Changed' WHERE id=$1","UPDATE outing_shares SET place_ids=ARRAY['park','cafe'] WHERE id=$1","UPDATE outing_shares SET expires_at=expires_at+interval '1 day' WHERE id=$1","UPDATE outing_shares SET request_id=gen_random_uuid() WHERE id=$1"])
    await assert.rejects(withActor('alice',db=>db.query(sql,[first.id])),(e:any)=>e.code==='23514');
   await assert.rejects(withActor('alice',db=>db.query("INSERT INTO outing_shares(owner_id,request_id,title,place_ids) VALUES('alice',$1,'Duplicates',ARRAY['cafe','cafe'])",[randomUUID()])),(e:any)=>e.code==='23514');
   await assert.rejects(withActor('alice',db=>db.query("INSERT INTO outing_shares(owner_id,request_id,title,place_ids,created_at,expires_at) VALUES('alice',$1,'Future',ARRAY['cafe'],now()+interval '1 day',now()+interval '31 days')",[randomUUID()])),(e:any)=>e.code==='42501');
  });
  await t.test('current public corrections refresh facts; withdrawn stop keeps its ID and becomes null',async()=>{
   await admin.query("UPDATE places SET name='Corrected Cafe',revision=2,catalog_data='{\"note\":\"private fact\"}' WHERE id='cafe'");
   const corrected=await repository.read(first.id);assert.equal(corrected!.stops[0].place?.name,'Corrected Cafe');assert(!JSON.stringify(corrected).includes('private fact'));
   await admin.query("UPDATE places SET state='withdrawn' WHERE id='park'");
   const withdrawn=await repository.read(first.id);assert.deepEqual(withdrawn!.stops.map(s=>s.placeID),['cafe','park']);assert.equal(withdrawn!.stops[1].place,null);
   await assert.rejects(repository.create('alice',request()),(e:unknown)=>e instanceof HttpError&&e.status===422);
   await admin.query("UPDATE places SET state='research' WHERE id='park'");
   await admin.query("UPDATE places SET consumer_eligible=false WHERE id='park'");assert.equal((await repository.read(first.id))!.stops[1].place,null);
   await admin.query("UPDATE places SET consumer_eligible=true,category='healthcare',tags='[\"Cafe\"]' WHERE id='park'");assert.equal((await repository.read(first.id))!.stops[1].place,null);
   await admin.query("UPDATE places SET category='parks',tags='[\"Urban park\"]' WHERE id='park'");
  });
  await t.test('revoke is owner-only, idempotent, irreversible; expired links remain uniform unavailable',async()=>{
   await assert.rejects(repository.revoke('bob',first.id),(e:unknown)=>e instanceof HttpError&&e.status===404);
   await repository.revoke('alice',first.id);await repository.revoke('alice',first.id);assert.equal(await repository.read(first.id),null);
   await assert.rejects(withActor('alice',db=>db.query('UPDATE outing_shares SET revoked_at=NULL WHERE id=$1',[first.id])),(e:any)=>e.code==='23514');
   await assert.rejects(repository.create('alice',body),(e:unknown)=>e instanceof HttpError&&e.status===409&&e.code==='share_unavailable');
   const expired=request('Expired'),expiredID=randomUUID();
   await admin.query("INSERT INTO outing_shares(id,owner_id,request_id,title,place_ids,created_at,expires_at) VALUES($1,'alice',$2,$3,$4,now()-interval '31 days',now()-interval '1 day')",[expiredID,expired.requestID,expired.title,expired.placeIDs]);
   assert.equal(await repository.read(expiredID),null);assert.equal(await repository.read(randomUUID()),null);
   await assert.rejects(repository.create('alice',expired),(e:unknown)=>e instanceof HttpError&&e.status===409&&e.code==='share_unavailable');
   assert((await repository.list('alice')).some(r=>r.id===expiredID));
  });
  await t.test('published closure status nulls the exact stop and prevents new shares without exporting the profile',async()=>{
   const body=request('Public closure');const shared=await repository.create('closure-owner',body);
   for(const status of ['temporarily_closed','permanently_closed']){
    await admin.query("INSERT INTO public_pages(place_id,snapshot) VALUES('park',$1) ON CONFLICT(place_id) DO UPDATE SET snapshot=excluded.snapshot,withdrawn_at=NULL",[JSON.stringify({profile:{status,note:'never share this note'}})]);
    const closed=await repository.read(shared.id);assert.deepEqual(closed!.stops.map(s=>s.placeID),body.placeIDs);assert.equal(closed!.stops[1].place,null);
    await assert.rejects(repository.create('closure-owner',request()),(e:unknown)=>e instanceof HttpError&&e.status===422);
    assert(!JSON.stringify(closed).includes('never share'));
   }
   await admin.query("UPDATE public_pages SET withdrawn_at=now() WHERE place_id='park'");
   assert((await repository.read(shared.id))!.stops[1].place,'A withdrawn historical publication cannot create a current closure claim.');
   await admin.query("UPDATE public_pages SET withdrawn_at=NULL,snapshot='{\"profile\":{\"status\":\"open\",\"note\":\"never share this note\"}}' WHERE place_id='park'");
   const open=await repository.read(shared.id);assert(open!.stops[1].place);assert(!JSON.stringify(open).includes('never share'));
  });
 }finally{
  await Promise.all([runtimePool?.end(),authPool?.end()]);
  await admin.query('DROP TABLE IF EXISTS outing_shares,public_pages,places CASCADE');
  await admin.query('DROP FUNCTION IF EXISTS preserve_outing_share_snapshot(),outing_share_ids_valid(text[])');
  await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);await admin.end();
 }
});
