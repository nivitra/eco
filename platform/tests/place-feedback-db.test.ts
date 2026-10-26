import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

test('real PostgreSQL feedback snapshot: forced RLS, complete pagination and atomic conditional updates',
 {skip:!process.env.FEEDBACK_TEST_DATABASE_URL},async t=>{
 const adminURL=new URL(process.env.FEEDBACK_TEST_DATABASE_URL!);
 assert.match(adminURL.pathname,/^\/kulture_feedback_test_[a-z0-9_]+$/);
 assert(['localhost','127.0.0.1','[::1]'].includes(adminURL.hostname),'Use only a disposable local database.');
 const admin=new pg.Pool({connectionString:adminURL.toString(),max:2});
 const role='feedback_test_'+randomUUID().replaceAll('-',''),password='fixture-only-'+randomUUID();let runtime:pg.Pool|undefined;
 const q=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 try{
  assert.equal((await admin.query("SELECT to_regclass('public.consumer_feedback') AS name")).rows[0].name,null);
  assert.equal((await admin.query("SELECT to_regclass('public.places') AS name")).rows[0].name,null);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${q(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.query('CREATE TABLE places(id text PRIMARY KEY)');
  await admin.query(await readFile(new URL('../migrations/006-consumer-feedback.sql',import.meta.url),'utf8'));
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role};GRANT SELECT ON places TO ${role};GRANT SELECT,INSERT,UPDATE,DELETE ON consumer_feedback TO ${role}`);
  await admin.query("INSERT INTO places SELECT 'place-'||lpad(n::text,4,'0') FROM generate_series(1,1005) n");
  await admin.query("INSERT INTO consumer_feedback SELECT 'alice',id,CASE WHEN id='place-0001' THEN 'dismissed' ELSE 'liked' END,'2026-10-10T12:00:00.123456Z'::timestamptz FROM places WHERE id<='place-1001'");
  const runtimeURL=new URL(adminURL);runtimeURL.username=role;runtimeURL.password=password;
  process.env.PUBLIC_URL='https://kulture.example';process.env.BETTER_AUTH_SECRET='test-only-feedback-auth-secret-never-production';process.env.OPS_TOKEN='test-only-feedback-ops-token-never-production';process.env.DATABASE_URL=runtimeURL.toString();process.env.AUTH_DATABASE_URL=runtimeURL.toString();
  const {pool,withActor,HttpError}=await import('../src/db.js');runtime=pool;
  const {readFeedbackSnapshot,feedbackPage,lockFeedback,applyFeedback}=await import('../src/modules/place-feedback.js');
  const snapshot=(actor:string)=>withActor(actor,async db=>{await lockFeedback(db,actor);return readFeedbackSnapshot(db,actor);});
  const apply=(actor:string,body:Parameters<typeof applyFeedback>[2])=>withActor(actor,db=>applyFeedback(db,actor,body));
  await t.test('non-bypass actor cannot read or modify another account; exact UTC microseconds survive',async()=>{
   assert.equal((await pool.query('SELECT * FROM consumer_feedback')).rowCount,0);
   assert.equal((await snapshot('alice')).feedback.length,1001);assert.equal((await snapshot('alice')).feedback[0].updatedAt,'2026-10-10T12:00:00.123456Z');
   assert.equal((await snapshot('bob')).feedback.length,0);
   assert.equal((await withActor('bob',db=>db.query("DELETE FROM consumer_feedback WHERE user_id='alice'"))).rowCount,0);
   await assert.rejects(withActor('bob',db=>db.query("INSERT INTO consumer_feedback(user_id,place_id,kind) VALUES('alice','place-1005','liked')")),(e:any)=>e.code==='42501');
  });
  await t.test('six pages include all1,001 entries; write between pages conflicts instead of mixing',async()=>{
   const first=await snapshot('alice');let cursor:string|undefined,ids:string[]=[];
   do{const page=feedbackPage(await snapshot('alice'),'alice',200,cursor,'fixture-secret');ids.push(...page.feedback.map(x=>x.placeID));cursor=page.nextCursor??undefined;}while(cursor);
   assert.equal(ids.length,1001);assert.equal(new Set(ids).size,1001);
   const page=feedbackPage(first,'alice',200,undefined,'fixture-secret');
   await apply('alice',{placeID:'place-1002',kind:'liked',expectedRevision:first.snapshotRevision});
   assert.throws(()=>feedbackPage({feedback:[],snapshotRevision:'0'.repeat(64)},'alice',200,page.nextCursor!,'fixture-secret'),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_snapshot_changed');
   const changed=await snapshot('alice');assert.notEqual(changed.snapshotRevision,first.snapshotRevision);
   assert.throws(()=>feedbackPage(changed,'alice',200,page.nextCursor!,'fixture-secret'),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_snapshot_changed');
  });
  await t.test('eight simultaneous guarded choices have one winner; stale undo and replay cannot overwrite it',async()=>{
   const prior=await snapshot('racer');
   const results=await Promise.allSettled(Array.from({length:8},(_,i)=>apply('racer',{placeID:`place-${String(i+1).padStart(4,'0')}`,kind:i%2?'liked':'dismissed',expectedRevision:prior.snapshotRevision})));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   for(const result of results)if(result.status==='rejected')assert(result.reason instanceof HttpError&&result.reason.code==='feedback_revision_conflict');
   const current=await snapshot('racer');assert.equal(current.feedback.length,1);
   const placeID=current.feedback[0].placeID;
   for(const kind of ['clear','liked'] as const)await assert.rejects(apply('racer',{placeID,kind,expectedRevision:prior.snapshotRevision}),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_revision_conflict');
   assert.deepEqual(await snapshot('racer'),current);
   const cleared=await apply('racer',{placeID,kind:'clear',expectedRevision:current.snapshotRevision});assert.equal(cleared.updatedAt,null);assert.equal((await snapshot('racer')).feedback.length,0);
  });
  await t.test('legacy choice invalidates new-client revision, and independent accounts remain independent',async()=>{
   const prior=await snapshot('legacy');await apply('legacy',{placeID:'place-0001',kind:'dismissed'});
   await assert.rejects(apply('legacy',{placeID:'place-0001',kind:'clear',expectedRevision:prior.snapshotRevision}),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_revision_conflict');
   const other=await snapshot('another');await apply('another',{placeID:'place-0001',kind:'liked',expectedRevision:other.snapshotRevision});
   assert.equal((await snapshot('legacy')).feedback[0].kind,'dismissed');assert.equal((await snapshot('another')).feedback[0].kind,'liked');
  });
 }finally{
  await runtime?.end();await admin.query('DROP TABLE IF EXISTS consumer_feedback,places');
  await admin.query(`DROP OWNED BY ${role};DROP ROLE IF EXISTS ${role}`);await admin.end();
 }
});
