import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import pg from 'pg';

test('real PostgreSQL shortlists isolate accounts, guard versions, cap concurrent creates and retain private tombstones',{skip:!process.env.SHORTLIST_TEST_DATABASE_URL},async t=>{
 const adminURL=new URL(process.env.SHORTLIST_TEST_DATABASE_URL!);assert.match(adminURL.pathname,/^\/kulture_shortlist_test_[a-z0-9_]+$/);assert(['localhost','127.0.0.1','[::1]'].includes(adminURL.hostname));
 const admin=new pg.Pool({connectionString:adminURL.toString(),max:2}),role='shortlist_test_'+randomUUID().replaceAll('-',''),password='fixture-only-'+randomUUID();let runtime:pg.Pool|undefined,authPool:pg.Pool|undefined,created=false;
 const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 try{
  for(const table of ['consumer_shortlists','places','public_pages'])assert.equal((await admin.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name,null,'Use a fresh test database.');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${quote(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);created=true;
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.query("CREATE TABLE places(id text PRIMARY KEY,name text NOT NULL,category text NOT NULL,neighborhood text NOT NULL,summary text NOT NULL,tags jsonb NOT NULL DEFAULT '[]',source_urls jsonb NOT NULL,state text NOT NULL DEFAULT 'research',consumer_eligible boolean NOT NULL DEFAULT true,catalog_data jsonb NOT NULL DEFAULT '{}')");
  await admin.query("ALTER TABLE places ENABLE ROW LEVEL SECURITY;ALTER TABLE places FORCE ROW LEVEL SECURITY;CREATE POLICY visible ON places FOR SELECT USING(consumer_eligible AND state IN ('research','published'))");
  await admin.query('CREATE TABLE public_pages(place_id text PRIMARY KEY,snapshot jsonb NOT NULL,withdrawn_at timestamptz)');
  await admin.query(await readFile(new URL('../migrations/024-consumer-shortlists.sql',import.meta.url),'utf8'));
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role};GRANT SELECT ON places,public_pages TO ${role};GRANT SELECT,INSERT,UPDATE,DELETE ON consumer_shortlists TO ${role}`);
  await admin.query("INSERT INTO places(id,name,category,neighborhood,summary,source_urls) VALUES('cafe','Corner Cafe','cafes','Jubilee Hills','Sourced listing','[\"https://venue.example/cafe\"]'),('park','Green Park','parks','Jubilee Hills','Sourced listing','[\"https://venue.example/park\"]'),('clinic','Neighbourhood Clinic','healthcare','Kokapet','Sourced listing','[\"https://venue.example/clinic\"]')");
  const runtimeURL=new URL(adminURL);runtimeURL.username=role;runtimeURL.password=password;process.env.PUBLIC_URL='https://kulture.example';process.env.BETTER_AUTH_SECRET='test-only-shortlist-auth-secret-never-production';process.env.OPS_TOKEN='test-only-shortlist-token-never-production';process.env.DATABASE_URL=runtimeURL.toString();process.env.AUTH_DATABASE_URL=runtimeURL.toString();
  const db=await import('../src/db.js');runtime=db.pool;authPool=(await import('../src/auth.js')).authPool;const {shortlistRepository:repo}=await import('../src/modules/shortlists.js');
  const input=(expectedVersion=0,placeIDs=['cafe','park'],title='Weekend picks')=>({title,placeIDs,expectedVersion});
  const id=randomUUID(),first=await repo.put('alice',id,input());
  await t.test('owner RLS hides collection and mutations; same UUID in another account is independent',async()=>{
   assert.equal((await runtime!.query('SELECT * FROM consumer_shortlists')).rowCount,0);assert.deepEqual(await repo.list('bob'),[]);
   await assert.rejects(repo.put('bob',id,input(1)),(e:any)=>e.status===404);await assert.rejects(repo.delete('bob',id,1),(e:any)=>e.status===404);
   assert.equal((await db.withActor('bob',client=>client.query("UPDATE consumer_shortlists SET title='Wrong',version=version+1 WHERE user_id='alice'"))).rowCount,0);
   await assert.rejects(db.withActor('bob',client=>client.query('INSERT INTO consumer_shortlists(user_id,id,title,place_ids) VALUES($1,$2,$3,$4)',['alice',randomUUID(),'Wrong owner',['cafe']])),(e:any)=>e.code==='42501');
   const other=await repo.put('bob',id,input(0,['clinic'],'Services'));assert.equal(other.version,1);assert.equal((await repo.list('alice'))[0].title,first.title);
  });
  await t.test('eight simultaneous edits against one version have one winner, no silent merge',async()=>{
   const results=await Promise.allSettled(Array.from({length:8},(_,i)=>repo.put('alice',id,input(1,['park','cafe'],'Edit '+i))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'shortlist_version_conflict');
   const current=(await repo.list('alice'))[0];assert.equal(current.version,2);assert.deepEqual(current.placeIDs,['park','cafe']);assert.equal(current.createdAt,first.createdAt);
  });
  await t.test('withdrawn members can stay during rename/removal but cannot be re-added once removed',async()=>{
   await admin.query("UPDATE places SET state='withdrawn' WHERE id='park'");
   const retained=await repo.put('alice',id,input(2,['park','cafe'],'Keep old reference'));assert.equal(retained.version,3);
   await assert.rejects(repo.put('alice',randomUUID(),input(0,['park'])),(e:any)=>e.code==='shortlist_places_unavailable');
   await repo.put('alice',id,input(3,['cafe'],'Remove unavailable'));
   await assert.rejects(repo.put('alice',id,input(4,['cafe','park'])),(e:any)=>e.code==='shortlist_places_unavailable');
   await admin.query("UPDATE places SET state='research' WHERE id='park'");
   await admin.query("INSERT INTO public_pages VALUES('park','{\"profile\":{\"status\":\"temporarily_closed\"}}',NULL)");
   await assert.rejects(repo.put('alice',randomUUID(),input(0,['park'])),(e:any)=>e.code==='shortlist_places_unavailable');
   await admin.query("UPDATE public_pages SET withdrawn_at=now() WHERE place_id='park'");
  });
  await t.test('deletion scrubs current title/members and tombstone cannot be resurrected or physically deleted by runtime',async()=>{
   await assert.rejects(repo.delete('alice',id,3),(e:any)=>e.code==='shortlist_version_conflict');const deleted=await repo.delete('alice',id,4);assert.deepEqual(deleted,{id,version:5,deleted:true});assert.deepEqual(await repo.list('alice'),[]);
   const row=(await admin.query('SELECT * FROM consumer_shortlists WHERE user_id=$1 AND id=$2',['alice',id])).rows[0];assert.equal(row.title,'');assert.deepEqual(row.place_ids,[]);assert(row.deleted_at);
   for(const expected of [0,4,5])await assert.rejects(repo.put('alice',id,input(expected)),(e:any)=>e.status===410);
   await assert.rejects(repo.delete('alice',id,5),(e:any)=>e.status===410);
   assert.equal((await db.withActor('alice',client=>client.query('DELETE FROM consumer_shortlists WHERE id=$1',[id]))).rowCount,0);
   await assert.rejects(db.withActor('alice',client=>client.query("UPDATE consumer_shortlists SET title='Resurrected',place_ids=ARRAY['cafe'],deleted_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1",[id])),(e:any)=>e.code==='23514');
  });
  await t.test('account lock and database trigger enforce100 active lists across simultaneous creates; deleting frees one slot',async()=>{
   const results=await Promise.allSettled(Array.from({length:105},(_,i)=>repo.put('quota',randomUUID(),input(0,['cafe'],'List '+i))));assert.equal(results.filter(r=>r.status==='fulfilled').length,100);
   for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'shortlist_limit');
   const lists=await repo.list('quota');assert.equal(lists.length,100);
   await assert.rejects(db.withActor('quota',client=>client.query('INSERT INTO consumer_shortlists(user_id,id,title,place_ids) VALUES($1,$2,$3,$4)',['quota',randomUUID(),'Bypass',['cafe']])),(e:any)=>e.code==='23514');
   await repo.delete('quota',lists[0].id,1);await repo.put('quota',randomUUID(),input(0,['cafe'],'Replacement'));assert.equal((await repo.list('quota')).length,100);
   assert.equal(Number((await admin.query("SELECT count(*) FROM consumer_shortlists WHERE user_id='quota' AND deleted_at IS NOT NULL")).rows[0].count),1);
  });
  await t.test('database enforces UTF16 title bounds, duplicate members, identity and exact version increments',async()=>{
   const value=await repo.put('constraints',randomUUID(),input(0,['cafe'],'😀'.repeat(40)));
   for(const [set,params] of [["title=$2,version=version+1,updated_at=clock_timestamp()",['😀'.repeat(41)]],["place_ids=ARRAY['cafe','cafe'],version=version+1,updated_at=clock_timestamp()",[]],["title='Changed',updated_at=clock_timestamp()",[]],["id=$2,version=version+1,updated_at=clock_timestamp()",[randomUUID()]],["created_at=created_at-interval '1 day',version=version+1,updated_at=clock_timestamp()",[]]] as [string,unknown[]][])
    await assert.rejects(db.withActor('constraints',client=>client.query('UPDATE consumer_shortlists SET '+set+' WHERE id=$1',[value.id,...params])),(e:any)=>e.code==='23514');
   assert.equal((await repo.list('constraints'))[0].version,1);
  });
 }finally{
  await Promise.all([runtime?.end(),authPool?.end()]);
  if(created){await admin.query('DROP TABLE IF EXISTS consumer_shortlists,public_pages,places');await admin.query('DROP FUNCTION IF EXISTS preserve_consumer_shortlist_identity(),consumer_shortlist_ids_valid(text[]),consumer_shortlist_text_valid(text,integer),consumer_shortlist_utf16_length(text)');await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);}await admin.end();
 }
});
