import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('real catalog conditional reads, forced-RLS feedback isolation and concurrent profile edits',{skip:process.env.RUN_DB_TESTS!=='true'},async()=>{
 const {app}=await import('../src/app.js');const {pool,workerPool,withActor}=await import('../src/db.js');const {authPool}=await import('../src/auth.js');
 const suffix=randomUUID();let ip=1;
 const request=(path:string,method='GET',body?:unknown,token?:string,headers:Record<string,string>={})=>app.request('http://localhost:3000'+path,{method,headers:{'Content-Type':'application/json','X-Real-IP':`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4,8)}::${ip}`,...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function account(label:string){ip++;const r=await request('/api/auth/sign-up/email','POST',{name:label,email:`${label}-${suffix}@example.test`,password:'Consumer-test-only-long-password!'});assert.equal(r.status,200,await r.clone().text());const token=r.headers.get('set-auth-token');assert(token);return {token,user:(await r.json() as any).user};}
 try {
  const first=await request('/v1/catalog');assert.equal(first.status,200);const tag=first.headers.get('etag');assert(tag);
  const catalog=await first.json() as any;assert(catalog.places.length>=37);assert(catalog.mapPoints.length>=14);assert(catalog.places.some((p:any)=>!catalog.mapPoints.some((m:any)=>m.placeID===p.id)));
  assert.equal((await request('/v1/catalog','GET',undefined,undefined,{'If-None-Match':tag})).status,304);
  assert.equal((await request('/v1/profile')).status,401);assert.equal((await request('/v1/feedback')).status,401);
  const a=await account('consumer-a'),b=await account('consumer-b');const placeID='ironhill-roastery-jubilee-hills';
  assert.equal((await request('/v1/feedback','POST',{placeID,kind:'dismissed'},a.token)).status,200);
  assert.deepEqual((await (await request('/v1/feedback','GET',undefined,b.token)).json() as any).feedback,[]);
  assert.equal((await withActor(b.user.id,db=>db.query('SELECT * FROM consumer_feedback WHERE user_id=$1',[a.user.id]))).rowCount,0);
  const ranked=await (await request('/v1/recommendations','POST',{intent:'coffee',scope:'jubilee_hills',limit:20},a.token)).json() as any;
  assert(!ranked.results.some((r:any)=>r.placeID===placeID));assert(ranked.exclusions.some((r:any)=>r.placeID===placeID&&r.reasons.includes('explicitly_dismissed')));
  assert.equal((await request('/v1/feedback','POST',{placeID,kind:'clear'},a.token)).status,200);
  const loaded=await request('/v1/profile','GET',undefined,a.token);const profile=(await loaded.clone().json() as any).profile;
  const revision=loaded.headers.get('etag')!;const results=await Promise.all([request('/v1/profile','PUT',{...profile,savedIDs:[placeID]},a.token,{'If-Match':revision}),request('/v1/profile','PUT',{profile:{...profile,savedIDs:['kissa-coffee-house-jubilee-hills']}},a.token,{'If-Match':revision})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
  const current=await request('/v1/profile','GET',undefined,a.token);
  assert.equal((await request('/v1/profile','PUT',{...profile,savedIDs:['invented-place']},a.token,{'If-Match':current.headers.get('etag')!})).status,422);
  // A new native client saves a brief, then an older client updates the same
  // outing without understanding that additive field. Read/merge/write must
  // preserve the brief under the same actor's locked profile revision.
  const brief={stages:[{id:'coffee',categoryID:'cafes',scope:'jubilee_hills'},{id:'activity',categoryID:'games'}],company:'friends',budgetPerPersonINR:800,durationMinutes:120};
  const outing={id:randomUUID(),title:'An afternoon',placeIDs:[placeID],createdAt:Date.now(),brief};
  const latest=(await current.clone().json() as any).profile;
  const created=await request('/v1/profile','PUT',{...latest,outings:[outing]},a.token,{'If-Match':current.headers.get('etag')!});
  assert.equal(created.status,200,await created.clone().text());
  const createdBody=(await created.clone().json() as any).profile;
  const legacy=structuredClone(createdBody);delete legacy.outings[0].brief;legacy.outings[0].title='Renamed on an older device';
  const edited=await request('/v1/profile','PUT',legacy,a.token,{'If-Match':created.headers.get('etag')!});
  assert.equal(edited.status,200,await edited.clone().text());
  assert.deepEqual((await edited.clone().json() as any).profile.outings[0].brief,brief);
  assert.equal((await request('/v1/profile','PUT',{...legacy,outings:[]},a.token,{'If-Match':created.headers.get('etag')!})).status,412);
  const preserved=await request('/v1/profile','GET',undefined,a.token);
  const preservedBody=(await preserved.clone().json() as any).profile;
  assert.deepEqual(preservedBody.outings[0].brief,brief);assert.equal(preservedBody.outings[0].title,legacy.outings[0].title);
  const clearing={...preservedBody,outings:[{...preservedBody.outings[0],brief:null}]};
  const cleared=await request('/v1/profile','PUT',clearing,a.token,{'If-Match':preserved.headers.get('etag')!});
  assert.equal(cleared.status,200);assert.equal((await cleared.clone().json() as any).profile.outings[0].brief,null);
  const removed=await request('/v1/profile','PUT',{...clearing,outings:[]},a.token,{'If-Match':cleared.headers.get('etag')!});
  assert.equal(removed.status,200);assert.deepEqual((await removed.json() as any).profile.outings,[]);
 } finally {await Promise.all([pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);}
});
