import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {Hono} from 'hono';import {ZodError} from 'zod';import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='https://kulture.example';process.env.BETTER_AUTH_SECRET??='test-only-shortlist-secret-never-production';process.env.OPS_TOKEN??='test-only-shortlist-token-never-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {shortlistPutSchema,shortlistDeleteSchema,shortlistIDSchema,shortlistMemberEligible,listShortlists,putShortlist,deleteShortlist,registerShortlists}=await import('../src/modules/shortlists.js');const {HttpError}=await import('../src/db.js');
const place=(id='cafe',extra:Partial<CatalogPlace>={}):CatalogPlace=>({id,name:'Corner Cafe',category:'cafes',neighborhood:'Jubilee Hills',address:'Road36',summary:'A sourced listing.',tags:['Coffee'],sourceURLs:['https://venue.example/cafe'],researchedAt:'2026-10-10',searchQuery:'Corner Cafe',revision:1,status:'research',...extra});
const body=(extra={})=>({title:'My places',placeIDs:['cafe','park'],expectedVersion:0,...extra});const code=(expected:string)=>(error:unknown)=>error instanceof HttpError&&error.code===expected;
test('strict request preserves order, trims title, counts UTF16, and rejects duplicate or oversized members',()=>{
 assert.deepEqual(shortlistPutSchema.parse(body({title:' Next weekend ',placeIDs:['park','cafe']})),body({title:'Next weekend',placeIDs:['park','cafe']}));assert(shortlistPutSchema.safeParse(body({title:'😀'.repeat(40)})).success);
 for(const patch of [{title:'😀'.repeat(41)},{title:' '},{title:'a\u0085b'},{placeIDs:[]},{placeIDs:['a','a']},{placeIDs:Array.from({length:9},(_,i)=>String(i))},{placeIDs:['a'.repeat(161)]},{expectedVersion:-1},{expectedVersion:0.5},{expectedVersion:Number.MAX_SAFE_INTEGER+1},{note:'private'},{userID:'another'}])assert(!shortlistPutSchema.safeParse(body(patch)).success);
 assert(!shortlistDeleteSchema.safeParse({expectedVersion:0}).success);assert(!shortlistDeleteSchema.safeParse({expectedVersion:1,title:'extra'}).success);assert(shortlistIDSchema.safeParse(randomUUID()).success);assert(!shortlistIDSchema.safeParse(randomUUID().toUpperCase()).success);
});
test('source-backed services can be shortlisted, but demo, OSM, unsourced and closed records cannot',()=>{
 assert(shortlistMemberEligible(place()));assert(shortlistMemberEligible(place('clinic',{category:'healthcare',tags:['Clinic']})));
 for(const p of [place('osm-1'),place('unsourced',{sourceURLs:[]}),place('closed',{status:'closed'}),place('fiction',{name:'Fictional Cafe'}),place('osm',{sourceURLs:['https://openstreetmap.org./node/1','https://venue.example']}),place('external',{coordinateSource:'OSM'})])assert(!shortlistMemberEligible(p),p.id);
});
function memory({row=null,count=0,visible=['cafe','park'],rows=[]}:{row?:any,count?:number,visible?:string[],rows?:any[]}={}){
 const calls:{sql:string,args:any[]}[]=[];let current=row;
 const db={query:async(sql:string,args:any[]=[])=>{calls.push({sql,args});
 if(sql.includes('FROM consumer_shortlists')&&sql.includes('LIMIT 101'))return {rows};
 if(sql.includes('FROM consumer_shortlists')&&sql.includes('FOR UPDATE'))return {rows:current?[current]:[]};
 if(sql.startsWith('SELECT count'))return {rows:[{count}]};
 if(sql.includes('FROM places p'))return {rows:visible.filter(id=>args[0].includes(id)).map(id=>({id,name:id,category:'cafes',neighborhood:'Jubilee Hills',summary:'Sourced listing',tags:[],source_urls:['https://venue.example/'+id],state:'research',consumer_eligible:true}))};
 if(sql.startsWith('INSERT INTO consumer_shortlists')){current={id:args[1],title:args[2],place_ids:args[3],version:'1',created_at:'2026-10-10T13:00:00Z',updated_at:'2026-10-10T13:00:00Z',deleted_at:null};return {rows:[current]};}
 if(sql.startsWith('UPDATE consumer_shortlists')){current={...current,title:args[2],place_ids:args[3],version:String(Number(current.version)+1),updated_at:'2026-10-10T13:01:00Z'};return {rows:[current]};}
 if(sql.startsWith('WITH stamp')){current={...current,title:'',place_ids:[],version:String(Number(current.version)+1),deleted_at:'2026-10-10T13:01:00Z'};return {rows:[current]};}return {rows:[]};}};
 return {db:db as any,calls,current:()=>current};
}
const stored=(id=randomUUID(),extra={})=>({id,title:'Before',place_ids:['withdrawn','cafe'],version:'3',created_at:'2026-10-10T13:00:00Z',updated_at:'2026-10-10T13:00:00Z',deleted_at:null,...extra});
test('create validates current public new members and exposes only the shortlist contract',async()=>{
 const m=memory(),id=randomUUID(),result=await putShortlist(m.db,'alice',id,body({placeIDs:['park','cafe']}));assert.equal(result.id,id);assert.deepEqual(result.placeIDs,['park','cafe']);assert.equal(result.version,1);assert.deepEqual(Object.keys(result).sort(),['createdAt','id','placeIDs','title','updatedAt','version']);assert(m.calls[0].sql.includes('pg_advisory_xact_lock'));assert.equal(m.calls[0].args[0],'consumer-shortlists:alice');
 const source=m.calls.find(c=>c.sql.includes('FROM places p'))!;assert(source.sql.includes('p.consumer_eligible'));assert(source.sql.includes('withdrawn_at IS NULL'));assert(source.sql.includes('temporarily_closed'));
 for(const placeIDs of [['hidden'],['cafe','hidden']]){const m=memory();await assert.rejects(putShortlist(m.db,'alice',randomUUID(),body({placeIDs})),code('shortlist_places_unavailable'));assert(!m.calls.some(c=>c.sql.startsWith('INSERT')));}
});
test('retained withdrawn IDs can be reordered; removing then reintroducing a hidden ID is rejected',async()=>{
 const prior=stored(),m=memory({row:prior,visible:['cafe']});const renamed=await putShortlist(m.db,'alice',prior.id,body({title:'Renamed',placeIDs:['cafe','withdrawn'],expectedVersion:3}));assert.equal(renamed.version,4);assert.deepEqual(renamed.placeIDs,['cafe','withdrawn']);assert(!m.calls.some(c=>c.sql.includes('FROM places p')));
 const removed=await putShortlist(m.db,'alice',prior.id,body({placeIDs:['cafe'],expectedVersion:4}));assert.equal(removed.version,5);await assert.rejects(putShortlist(m.db,'alice',prior.id,body({placeIDs:['cafe','withdrawn'],expectedVersion:5})),code('shortlist_places_unavailable'));
});
test('stale, unknown, capacity and deleted-identity writes fail before private fields change',async()=>{
 const id=randomUUID(),prior=stored(id);const cases=[{m:memory({row:prior}),request:body({expectedVersion:2}),error:'shortlist_version_conflict'},{m:memory(),request:body({expectedVersion:1}),error:'shortlist_not_found'},{m:memory({count:100}),request:body(),error:'shortlist_limit'},{m:memory({row:stored(id,{title:'',place_ids:[],deleted_at:'2026-10-10T13:01:00Z'})}),request:body(),error:'shortlist_deleted'}];
 for(const {m,request,error} of cases){await assert.rejects(putShortlist(m.db,'alice',id,request),code(error));assert(!m.calls.some(c=>/^(INSERT|UPDATE|WITH stamp)/.test(c.sql)));}
});
test('delete clears private title and membership while retaining an irreversible versioned tombstone',async()=>{
 const prior=stored(),m=memory({row:prior});await assert.rejects(deleteShortlist(m.db,'alice',prior.id,2),code('shortlist_version_conflict'));assert.deepEqual(await deleteShortlist(m.db,'alice',prior.id,3),{id:prior.id,version:4,deleted:true});assert.equal(m.current().title,'');assert.deepEqual(m.current().place_ids,[]);await assert.rejects(deleteShortlist(m.db,'alice',prior.id,4),code('shortlist_deleted'));await assert.rejects(putShortlist(m.db,'alice',prior.id,body()),code('shortlist_deleted'));
});
test('list uses one bounded complete read and rejects101 rows rather than silently truncating',async()=>{
 const rows=Array.from({length:101},()=>stored());await assert.rejects(listShortlists(memory({rows}).db,'alice'),code('shortlist_collection_too_large'));const m=memory({rows:rows.slice(0,100)});assert.equal((await listShortlists(m.db,'alice')).length,100);assert.equal(m.calls.length,1);assert.deepEqual(m.calls[0].args,['alice']);
});
test('HTTP CRUD requires authentication and returns exact private no-store envelopes',async()=>{
 const calls:any[]=[],id=randomUUID(),record={id,title:'Places',placeIDs:['cafe'],version:1,createdAt:'2026-10-10T13:00:00Z',updatedAt:'2026-10-10T13:00:00Z'};const app=new Hono();
 registerShortlists(app,{authenticate:async c=>{if(c.req.header('Authorization')!=='Bearer alice')throw new HttpError(401,'sign_in_required','Sign in');return {id:'alice'};},repository:{list:async owner=>{calls.push(['list',owner]);return [record];},put:async(owner,id,body)=>{calls.push(['put',owner,id,body]);return record;},delete:async(owner,id,version)=>{calls.push(['delete',owner,id,version]);return {id,version:2,deleted:true};}}});
 app.onError((e,c)=>e instanceof HttpError?c.json({error:{code:e.code}},e.status as 400):e instanceof ZodError?c.json({error:{code:'invalid_request'}},400):c.json({error:{code:'unexpected'}},500));
 for(const [method,path] of [['GET','/v1/shortlists'],['PUT','/v1/shortlists/'+id],['DELETE','/v1/shortlists/'+id]])assert.equal((await app.request(path,{method})).status,401);
 const headers={Authorization:'Bearer alice','Content-Type':'application/json'},read=await app.request('/v1/shortlists',{headers});assert.deepEqual(await read.json(),{shortlists:[record],limit:100});assert.equal(read.headers.get('cache-control'),'private, no-store');
 const put=await app.request('/v1/shortlists/'+id,{method:'PUT',headers,body:JSON.stringify(body({placeIDs:['cafe']}))});assert.equal(put.status,200);assert.equal(put.headers.get('cache-control'),'private, no-store');assert.equal((await app.request('/v1/shortlists/'+id,{method:'PUT',headers,body:JSON.stringify({...body(),privateNote:'never store'})})).status,400);
 const deleted=await app.request('/v1/shortlists/'+id,{method:'DELETE',headers,body:JSON.stringify({expectedVersion:1})});assert.deepEqual(await deleted.json(),{id,version:2,deleted:true});assert.equal(deleted.headers.get('cache-control'),'private, no-store');assert.deepEqual(calls.map(c=>c[1]),['alice','alice','alice']);
});
