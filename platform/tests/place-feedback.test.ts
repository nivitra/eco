import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {ZodError} from 'zod';
process.env.PUBLIC_URL??='https://kulture.example';
process.env.BETTER_AUTH_SECRET??='test-only-feedback-secret-never-production';
process.env.OPS_TOKEN??='test-only-feedback-token-never-production';
process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {feedbackSnapshot,feedbackPage,feedbackRequestSchema,feedbackPageQuerySchema,feedbackRowsSQL,MAX_FEEDBACK_SNAPSHOT_ROWS,applyFeedback}=await import('../src/modules/place-feedback.js');
const {HttpError,pool}=await import('../src/db.js');
const secret='test-only-feedback-cursor-secret';
const row=(placeID:string,kind:'liked'|'dismissed'='liked',updatedAt='2026-10-10T12:00:00.123456Z')=>({placeID,kind,updatedAt});
const throwsCode=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:unknown)=>e instanceof HttpError&&e.code===code);

test('snapshot includes all1,001 rows with deterministic timestamp ties and complete bounded pages',()=>{
 const rows=Array.from({length:1001},(_,i)=>row(`place-${String(i).padStart(4,'0')}`,i%2?'liked':'dismissed'));
 const snapshot=feedbackSnapshot('alice',[...rows].reverse());assert.deepEqual(snapshot.feedback,rows);
 assert.equal(feedbackSnapshot('alice',rows).snapshotRevision,snapshot.snapshotRevision);
 let cursor:string|undefined,all:typeof rows=[];let pages=0;
 do{const page=feedbackPage(snapshot,'alice',200,cursor,secret);assert.equal(page.snapshotRevision,snapshot.snapshotRevision);all.push(...page.feedback);cursor=page.nextCursor??undefined;pages++;if(cursor){assert.match(cursor,/^[A-Za-z0-9_-]+$/);assert(cursor.length<=1024);}}while(cursor);
 assert.equal(pages,6);assert.deepEqual(all,rows);assert.equal(new Set(all.map(x=>x.placeID)).size,1001);
 assert.equal(feedbackPage(feedbackSnapshot('alice',[]),'alice',200,undefined,secret).nextCursor,null);
});
test('snapshot revisions distinguish actors and microsecond edits rather than millisecond Date truncation',()=>{
 const first=feedbackSnapshot('alice',[row('a')]);
 for(const next of [feedbackSnapshot('bob',[row('a')]),feedbackSnapshot('alice',[row('a','dismissed')]),feedbackSnapshot('alice',[row('a','liked','2026-10-10T12:00:00.123457Z')]),feedbackSnapshot('alice',[])])assert.notEqual(next.snapshotRevision,first.snapshotRevision);
 assert.match(feedbackRowsSQL,/SS\.US/);assert.match(feedbackRowsSQL,/ORDER BY updated_at DESC,place_id COLLATE "C" ASC/);
});
test('pagination rejects mutation, other actors, changed page size, forged and oversized cursors',()=>{
 const snapshot=feedbackSnapshot('alice',[row('a'),row('b')]);
 const cursor=feedbackPage(snapshot,'alice',1,undefined,secret).nextCursor!;
 throwsCode(()=>feedbackPage(feedbackSnapshot('alice',[row('a','dismissed'),row('b')]),'alice',1,cursor,secret),'feedback_snapshot_changed');
 throwsCode(()=>feedbackPage(snapshot,'bob',1,cursor,secret),'invalid_feedback_cursor');
 throwsCode(()=>feedbackPage(snapshot,'alice',2,cursor,secret),'invalid_feedback_cursor');
 for(const value of [cursor.slice(0,-2)+'AA',Buffer.from(JSON.stringify({payload:'e30',signature:'0'.repeat(64)})).toString('base64url')])throwsCode(()=>feedbackPage(snapshot,'alice',1,value,secret),'invalid_feedback_cursor');
 for(const value of ['x'.repeat(1025),'../x'])assert.throws(()=>feedbackPage(snapshot,'alice',1,value,secret),ZodError);
});
test('invalid schemas and oversized histories fail explicitly; no complete partial snapshot',()=>{
 for(const body of [{placeID:'a',kind:'hidden'},{placeID:'a',kind:'clear',expectedRevision:'old'},{placeID:'a',kind:'liked',actorID:'bob'}])assert(!feedbackRequestSchema.safeParse(body).success);
 for(const input of [{pageSize:0},{pageSize:201},{pageSize:1.5},{cursor:'abc'},{pageSize:200,cursor:'..'}])assert(!feedbackPageQuerySchema.safeParse(input).success);
 assert(feedbackRequestSchema.safeParse({placeID:'a',kind:'clear'}).success);
 throwsCode(()=>feedbackSnapshot('alice',Array.from({length:MAX_FEEDBACK_SNAPSHOT_ROWS+1},(_,i)=>row(String(i)))),'feedback_snapshot_too_large');
 throwsCode(()=>feedbackSnapshot('alice',[row('a'),row('a')]),'invalid_feedback_snapshot');
});

function memoryDB(initial:ReturnType<typeof row>[]=[]){
 let rows=structuredClone(initial),tick=1;const calls:{sql:string;args:any[]}[]=[];
 const db={query:async(sql:string,args:any[]=[])=>{
  calls.push({sql,args});
  if(sql===feedbackRowsSQL)return {rows:structuredClone(rows)};
  if(sql.startsWith('SELECT id FROM places'))return {rows:args[0]==='missing'?[]:[{id:args[0]}]};
  if(sql.startsWith('INSERT INTO consumer_feedback')){rows=rows.filter(x=>x.placeID!==args[1]);rows.push(row(args[1],args[2],`2026-10-10T12:01:00.${String(tick++).padStart(6,'0')}Z`));}
  if(sql.startsWith('DELETE FROM consumer_feedback'))rows=rows.filter(x=>x.placeID!==args[1]);
  if(sql.includes('LIMIT 1000'))return {rows:structuredClone(rows.slice(0,1000))};
  return {rows:[]};
 },release:()=>{}};
 return {db:db as any,calls,current:()=>structuredClone(rows)};
}
test('guarded mutations return exact state and reject stale undo and lost-response replay before writing',async()=>{
 const memory=memoryDB([row('a','liked')]);const revision=feedbackSnapshot('alice',memory.current()).snapshotRevision;
 const changed=await applyFeedback(memory.db,'alice',{placeID:'a',kind:'dismissed',expectedRevision:revision});
 assert.equal(changed.kind,'dismissed');assert.equal(changed.updatedAt,memory.current()[0].updatedAt);assert.equal(changed.snapshotRevision,feedbackSnapshot('alice',memory.current()).snapshotRevision);
 const writes=()=>memory.calls.filter(c=>/^(INSERT|DELETE)/.test(c.sql)).length;
 assert.equal(writes(),1);
 for(const kind of ['dismissed','clear'] as const)await assert.rejects(applyFeedback(memory.db,'alice',{placeID:'a',kind,expectedRevision:revision}),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_revision_conflict');
 assert.equal(writes(),1);assert.equal(memory.current()[0].kind,'dismissed');
 const cleared=await applyFeedback(memory.db,'alice',{placeID:'a',kind:'clear',expectedRevision:changed.snapshotRevision});assert.equal(cleared.updatedAt,null);assert.deepEqual(memory.current(),[]);
 assert(memory.calls.filter(c=>c.sql.includes('pg_advisory_xact_lock')).every(c=>c.args[0]==='consumer-feedback:alice'));
 assert(memory.calls[0].sql.includes('pg_advisory_xact_lock'));
});
test('legacy writes also acquire account lock and invalidate guarded snapshots; unknown place cannot mutate',async()=>{
 const memory=memoryDB();const prior=feedbackSnapshot('alice',[]).snapshotRevision;
 await applyFeedback(memory.db,'alice',{placeID:'a',kind:'liked'});
 assert(memory.calls[0].sql.includes('pg_advisory_xact_lock'));
 await assert.rejects(applyFeedback(memory.db,'alice',{placeID:'a',kind:'clear',expectedRevision:prior}),(e:unknown)=>e instanceof HttpError&&e.code==='feedback_revision_conflict');
 await assert.rejects(applyFeedback(memory.db,'alice',{placeID:'missing',kind:'liked'}),(e:unknown)=>e instanceof HttpError&&e.code==='place_not_found');
 assert.equal(memory.current().length,1);
});
test('clear removes owned feedback when its place no longer resolves, without requiring public existence',async()=>{
 const memory=memoryDB([row('missing','dismissed')]);
 const revision=feedbackSnapshot('alice',memory.current()).snapshotRevision;
 const result=await applyFeedback(memory.db,'alice',{placeID:'missing',kind:'clear',expectedRevision:revision});
 assert.equal(result.updatedAt,null);assert.deepEqual(memory.current(),[]);
 assert(!memory.calls.some(call=>call.sql.startsWith('SELECT id FROM places')));
 assert.equal(result.snapshotRevision,feedbackSnapshot('alice',[]).snapshotRevision);
});

test('HTTP legacy and paged envelopes require actor authentication and return private no-store metadata',async()=>{
 const {auth,authPool}=await import('../src/auth.js');const {registerConsumer}=await import('../src/modules/consumer.js');
 const memory=memoryDB([row('a'),row('b','dismissed')]);
 const connect=mock.method(pool,'connect',async()=>memory.db);
 const session=mock.method(auth.api,'getSession',async({headers}:any)=>headers.get('Authorization')==='Bearer alice'?{user:{id:'alice',email:'test@example.test',name:'Test',emailVerified:true}}:null);
 const app=new Hono();registerConsumer(app);app.onError((e,c)=>e instanceof HttpError?c.json({error:{code:e.code}},e.status as 400):e instanceof ZodError?c.json({error:{code:'invalid_request'}},400):c.json({error:{code:'unexpected'}},500));
 const headers={Authorization:'Bearer alice','Content-Type':'application/json'};
 try{
  assert.equal((await app.request('/v1/feedback?pageSize=200')).status,401);
  assert.equal((await app.request('/v1/feedback',{method:'POST',body:'{}'})).status,401);
  const legacy=await app.request('/v1/feedback',{headers});assert.deepEqual(Object.keys(await legacy.json()),['feedback']);
  const page=await app.request('/v1/feedback?pageSize=1',{headers});assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'private, no-store');const body=await page.json() as any;assert(body.nextCursor);assert.equal(body.feedback.length,1);
  const post=await app.request('/v1/feedback',{method:'POST',headers,body:JSON.stringify({placeID:'a',kind:'clear',expectedRevision:body.snapshotRevision})});assert.equal(post.status,200);assert.equal(post.headers.get('cache-control'),'private, no-store');assert.equal((await post.json() as any).updatedAt,null);
  const mixed=await app.request('/v1/feedback?pageSize=1&cursor='+body.nextCursor,{headers});assert.equal(mixed.status,409);assert.equal((await mixed.json() as any).error.code,'feedback_snapshot_changed');
  assert.equal((await app.request('/v1/feedback?cursor='+body.nextCursor,{headers})).status,400);
  assert(memory.calls.filter(c=>c.sql===feedbackRowsSQL).every(c=>c.args[0]==='alice'));
 }finally{connect.mock.restore();session.mock.restore();await authPool.end();}
});
