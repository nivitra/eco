import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {ZodError} from 'zod';
import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='https://kulture.example';
process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {outingShareRequestSchema,shareableOutingPlace,redactOutingSharePath,registerOutingShares,createOutingShare,outingShareRepository}=await import('../src/modules/outing-shares.js');
const {HttpError,pool}=await import('../src/db.js');
const fixture=(id='cafe',extra:Partial<CatalogPlace>={}):CatalogPlace=>({id,name:'Corner Cafe',category:'cafes',neighborhood:'Jubilee Hills',address:'Road 36',summary:'Source-listed café.',tags:['Coffee'],sourceURLs:['https://venue.example/cafe'],researchedAt:'2026-10-10',searchQuery:'Corner Cafe',revision:1,status:'research',...extra});

test('reviewed request contains only a title, unique ordered IDs and canonical v4 retry ID',()=>{
 const body={requestID:randomUUID(),title:'  Sunday afternoon  ',placeIDs:['cafe','park']};
 assert.deepEqual(outingShareRequestSchema.parse(body),{...body,title:'Sunday afternoon'});
 for(const change of [{note:'private'}, {brief:{}}, {profile:{}}, {latitude:17.4}, {placeIDs:['cafe','cafe']},{placeIDs:[]},{placeIDs:Array.from({length:9},(_,i)=>String(i))},{title:'\u0000secret'},{title:'x'.repeat(121)},{requestID:body.requestID.toUpperCase()},{requestID:'00000000-0000-1000-8000-000000000000'}])assert.equal(outingShareRequestSchema.safeParse({...body,...change}).success,false);
});
test('sharing excludes demo, mixed OSM, inactive, unbacked and service places without guessing from a name',()=>{
 assert(shareableOutingPlace(fixture()));assert(shareableOutingPlace(fixture('park',{category:'nature',tags:['National park']})));
 for(const place of [fixture('demo',{name:'Fictional Cafe'}),fixture('osm-1'),fixture('mixed',{sourceURLs:['https://venue.example','https://openstreetmap.org/node/123']}),fixture('osm-dot',{sourceURLs:['https://openstreetmap.org./node/123']}),fixture('legacy',{coordinateSource:'OpenStreetMap'}),fixture('missing',{sourceURLs:[]}),fixture('closed',{status:'closed'}),fixture('clinic',{category:'healthcare',tags:['Cafe']}),fixture('unknown',{category:'services',tags:[]})])assert.equal(shareableOutingPlace(place),false,place.id);
});
test('all capability path shapes are redacted without hiding ordinary public discovery paths',()=>{
 for(const path of ['/outings/'+randomUUID(),'/outings/not-a-token/extra'])assert.equal(redactOutingSharePath(path),'/outings/[redacted]');
 for(const path of ['/v1/outing-shares/'+randomUUID(),'/v1/outing-shares'])assert.equal(redactOutingSharePath(path),'/v1/outing-shares/[redacted]');
 assert.equal(redactOutingSharePath('/v1/places/cafe'),'/v1/places/cafe');
 assert.equal(redactOutingSharePath('/outings-archive'),'/outings-archive');
});

function testApp(){
 const id=randomUUID(),now=Date.now(),share={version:1 as const,id,title:'An afternoon',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),stops:[{placeID:'cafe',place:fixture()}]};
 const calls:{operation:string,owner?:string,id?:string,body?:unknown}[]=[];let available=true;
 const app=new Hono();
 registerOutingShares(app,{publicURL:'https://kulture.example',quota:async()=>{},authenticate:async c=>{if(c.req.header('Authorization')!=='Bearer owner')throw new HttpError(401,'sign_in_required','Sign in');return {id:'owner'};},repository:{
  create:async(owner,body)=>{calls.push({operation:'create',owner,body});return share;},
  list:async owner=>{calls.push({operation:'list',owner});return [{id,title:share.title,place_ids:['cafe'],created_at:share.createdAt,expires_at:share.expiresAt,revoked_at:null}];},
  revoke:async(owner,value)=>{calls.push({operation:'revoke',owner,id:value});if(value!==id)throw new HttpError(404,'outing_share_not_found','This shared outing is unavailable.');available=false;},
  read:async value=>{calls.push({operation:'read',id:value});return value===id&&available?share:null;}
 }});
 app.onError((e,c)=>e instanceof HttpError?c.json({error:{code:e.code,message:e.message}},e.status as 400):e instanceof ZodError?c.json({error:{code:'invalid_request'}},400):c.json({error:{code:'unexpected'}},500));
 return {app,id,share,calls};
}
const authHeaders={'Content-Type':'application/json',Authorization:'Bearer owner'};
test('anonymous capability reads work without authentication; owner operations stay authenticated',async()=>{
 const {app,id,share,calls}=testApp();
 const read=await app.request('/v1/outing-shares/'+id);assert.equal(read.status,200);assert.deepEqual(await read.json(),{share});
 for(const [path,method] of [['/v1/outing-shares','GET'],['/v1/outing-shares','POST'],['/v1/outing-shares/'+id,'DELETE']])assert.equal((await app.request(path,{method})).status,401);
 assert.deepEqual(calls.map(x=>x.operation),['read']);
});
test('POST cannot leak private fields and owner listing omits owner/request identifiers',async()=>{
 const {app,id,calls}=testApp();
 const body={requestID:randomUUID(),title:'An afternoon',placeIDs:['cafe']};
 const invalid=await app.request('/v1/outing-shares',{method:'POST',headers:authHeaders,body:JSON.stringify({...body,note:'Private inspiration'})});assert.equal(invalid.status,400);assert.equal(calls.length,0);
 const created=await app.request('/v1/outing-shares',{method:'POST',headers:authHeaders,body:JSON.stringify(body)});assert.equal(created.status,201);assert.equal((await created.json()).url,'https://kulture.example/outings/'+id);
 assert.deepEqual(calls[0],{operation:'create',owner:'owner',body});
 const listing=await app.request('/v1/outing-shares',{headers:authHeaders});assert.equal(listing.status,200);
 const result=await listing.json();assert.deepEqual(Object.keys(result.shares[0]).sort(),['createdAt','expiresAt','id','placeIDs','revokedAt','title','url']);assert.equal(result.shares[0].revokedAt,null);
});
test('unknown, malformed and revoked JSON links use one unavailable response; owner revoke is idempotent',async()=>{
 const {app,id}=testApp();
 const unknown=await app.request('/v1/outing-shares/'+randomUUID());assert.equal(unknown.status,404);const expected=await unknown.json();
 for(const value of ['not-a-uuid',id.toUpperCase()]){const response=await app.request('/v1/outing-shares/'+value);assert.equal(response.status,404);assert.deepEqual(await response.json(),expected);}
 for(let i=0;i<2;i++){const response=await app.request('/v1/outing-shares/'+id,{method:'DELETE',headers:authHeaders});assert.equal(response.status,200);assert.deepEqual(await response.json(),{revoked:true});}
 const revoked=await app.request('/v1/outing-shares/'+id);assert.equal(revoked.status,404);assert.deepEqual(await revoked.json(),expected);
});
test('live and invalid link HTML and JSON forbid caching, indexing and referrer disclosure',async()=>{
 const {app,id}=testApp();
 for(const path of ['/outings/'+id,'/outings/invalid','/outings/'+randomUUID(),'/v1/outing-shares/'+id,'/v1/outing-shares/invalid']){
  const response=await app.request(path);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow, nosnippet');assert(response.headers.get('content-security-policy')?.includes("img-src 'none'"));
  if(path.startsWith('/outings/')){assert(response.headers.get('content-type')?.includes('text/html'));const html=await response.text();assert(!/<script|<img|<iframe/i.test(html));}
 }
});
test('full application middleware preserves capability privacy headers and redacts live request logs',async()=>{
 const {share}=testApp();const {app}=await import('../src/app.js');
 const logs:unknown[]=[];const previousQuiet=process.env.QUIET_LOGS;process.env.QUIET_LOGS='false';
 const logger=mock.method(console,'log',(value:unknown)=>{logs.push(value);});
 const quota=mock.method(pool,'query',async()=>({rows:[{allowed:true}]} as any));
 const read=mock.method(outingShareRepository,'read',async (id:string)=>id===share.id?share:null);
 try{
  for(const path of ['/outings/'+share.id,'/outings/invalid','/v1/outing-shares/'+share.id,'/v1/outing-shares/'+randomUUID()]){
   const response=await app.request(process.env.PUBLIC_URL+path);assert.equal(response.status,path.includes(share.id)?200:404);
   assert.match(response.headers.get('content-security-policy')??'',/(?:^|;)\s*img-src 'none'(?:;|$)/);
   assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow, nosnippet');
  }
  assert.equal(logs.length,4);assert(!JSON.stringify(logs).includes(share.id));
  assert(logs.every(value=>JSON.parse(String(value)).path.endsWith('/[redacted]')));
 }finally{logger.mock.restore();quota.mock.restore();read.mock.restore();if(previousQuiet===undefined)delete process.env.QUIET_LOGS;else process.env.QUIET_LOGS=previousQuiet;}
});

test('retry and validation use current public projection, preserving IDs with null gaps',async()=>{
 const id=randomUUID(),body={requestID:randomUUID(),title:'Outing',placeIDs:['cafe','withdrawn']};
 const row={id,title:body.title,place_ids:body.placeIDs,created_at:new Date(),expires_at:new Date(Date.now()+86400000),revoked_at:null,active:true};
 const publicRow={id:'cafe',name:'Updated Cafe',category:'cafes',neighborhood:'Jubilee Hills',address:'Address',summary:'Source-listed café',tags:['Coffee'],source_urls:['https://venue.example/cafe'],researched_at:'2026-10-10',search_query:'Updated Cafe',revision:2,state:'published',catalog_data:{note:'private data must not be projected'}};
 const queries:string[]=[];const db={query:async(sql:string)=>{queries.push(sql);return {rows:sql.startsWith('SELECT id,title')?[row]:sql.includes('FROM places')?[publicRow]:[]};}} as any;
 const snapshot=await createOutingShare(db,'owner',body);
 assert.deepEqual(snapshot.stops.map(s=>s.placeID),body.placeIDs);assert.equal(snapshot.stops[1].place,null);assert.equal(snapshot.stops[0].place?.name,'Updated Cafe');assert(!JSON.stringify(snapshot).includes('private data'));assert(!queries.some(sql=>sql.startsWith('INSERT')));
 row.active=false;await assert.rejects(createOutingShare(db,'owner',body),(e:unknown)=>e instanceof HttpError&&e.status===409&&e.code==='share_unavailable');
 await assert.rejects(createOutingShare(db,'owner',{...body,placeIDs:['withdrawn','cafe']}),(e:unknown)=>e instanceof HttpError&&e.code==='idempotency_conflict');
});
