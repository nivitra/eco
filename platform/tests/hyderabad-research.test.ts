import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {importResearchCatalog,validateResearchCatalog,researchPointFor} from '../scripts/import-hyderabad-research.js';
import {validResearchCoordinateSource,trustedResearchCoordinates} from '../src/research-provenance.js';
const input=JSON.parse(await readFile(new URL('../data/research-places.json',import.meta.url),'utf8'));
const base=input.find((p:any)=>p.coordinateSource==='EazyDiner');
const fixture=(id=`official-import-${randomUUID()}`)=>({...structuredClone(base),id,name:'Source import fixture',research:{...structuredClone(base.research),recordID:id,sourceRecordIDs:[id]}});

test('frozen editorial dataset validates 1000 stable IDs, reference pairs and licensed-only public imagery',()=>{
 const rows=validateResearchCatalog(input);assert.equal(rows.length,1000);assert.equal(rows.filter(p=>p.latitude!==undefined).length,975);
 assert.equal(rows.filter(p=>p.imageURL).length,41);assert.equal(rows.reduce((n,p)=>n+(p.publicImages?.length??0),0),70);
 for(const id of ['zythum-brewing-jubilee-hills','bel-posto-the-cafe-jubilee-hills','kortyard-cafe-jubilee-hills','wikidata-q6466530'])assert(rows.some(p=>p.id===id));
 assert(rows.every(p=>p.research.photoReferences.length===2));
 assert(rows.every(p=>p.coordinateSource!=='EazyDiner'||p.coordinateProvenance?.method==='published_JSON-LD'));
 assert(rows.filter(p=>p.publicImages).every(p=>p.publicImages!.every(im=>im.venueAssociationVerified&&im.sourceURL.startsWith('https://commons.wikimedia.org/wiki/File:'))));
 assert(!rows.find(p=>p.id==='eazydiner-701659')?.latitude,'source-path locality mismatch must not become a pin');
});
test('research provenance rejects host spoofing, geographic errors, partial proofs and verified-entrance claims',()=>{
 assert(validResearchCoordinateSource('Playo','https://playo.co/venues/L.B-Nagar/test-@-court','public_venue_data'));
 assert(validResearchCoordinateSource('EazyDiner','https://www.eazydiner.com/kokapet/test-123','published_JSON-LD'));
 for(const url of ['https://www.eazydiner.com.evil.test/hyderabad/test-123','https://user@www.eazydiner.com/hyderabad/test-123','https://www.eazydiner.com:443/hyderabad/test-123','https://www.eazydiner.com/hyderabad/test-123?x=1','https://www.eazydiner.com/mysuru/test-123','https://playo.co/venues/a/b/extra','https://playo.co/venues/a/%2e%2e'])
  assert(!validResearchCoordinateSource(url.includes('playo.co')?'Playo':'EazyDiner',url,url.includes('playo.co')?'public_venue_data':'published_JSON-LD'),url);
 for(const changes of [{latitude:19},{longitude:Infinity},{coordinateKind:'entrance'},{coordinateProvenance:undefined},
  {coordinateProvenance:{...base.coordinateProvenance,entranceVerified:true}},
  {coordinateProvenance:{...base.coordinateProvenance,independentlyVerified:true}},
  {coordinateProvenance:{...base.coordinateProvenance,sourceURL:'https://www.eazydiner.com/hyderabad/other-123'}},
  {name:'Fictional demo venue'},{privateProof:'no'}])assert.throws(()=>validateResearchCatalog([{...base,...changes}]));
 assert(!trustedResearchCoordinates({...base,latitude:'17.4'},base.sourceURLs));
 assert.throws(()=>validateResearchCatalog([{...base,imageURL:'https://playo.gumlet.io/unlicensed.jpg'}]));
 const withPhoto=input.find((p:any)=>p.publicImages);assert.throws(()=>validateResearchCatalog([{...withPhoto,publicImages:[{...withPhoto.publicImages[0],license:'Unverified'}]}]));
 assert.throws(()=>validateResearchCatalog([base,base]));
});

test('real research import is dry by default, atomic and idempotent; claims/edits/closed/hidden/operator points remain exact',
 {skip:process.env.RUN_DB_TESTS!=='true'},async()=>{
 const realPool=new pg.Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1});const db=await realPool.connect();await db.query('BEGIN');
 const pool={connect:async()=>({release(){},query:(sql:string,args?:any[])=>db.query(sql==='BEGIN'?'SAVEPOINT research_batch':sql==='COMMIT'?'RELEASE SAVEPOINT research_batch':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT research_batch':sql,args)})} as unknown as pg.Pool;
 const snapshot=async(id:string)=>(await db.query(`SELECT p.*,ST_Y(point::geometry) latitude,ST_X(point::geometry) longitude,m.payload map_payload,m.updated_at map_updated_at FROM places p LEFT JOIN place_map_points m ON m.place_id=p.id WHERE p.id=$1`,[id])).rows[0];
 const tenant=randomUUID();
 try{
  await db.query("INSERT INTO tenants(id,name,created_by) VALUES($1,'Research import fixture','research-test')",[tenant]);
  const fresh=fixture();let dry=await importResearchCatalog(pool,[fresh]);assert.deepEqual(dry.inserted,[fresh.id]);assert.equal(await snapshot(fresh.id),undefined);
  const applied=await importResearchCatalog(pool,[fresh],{apply:true});assert.deepEqual(applied.inserted,[fresh.id]);const before=await snapshot(fresh.id);
  assert.equal(before.point_source,'EazyDiner');assert.deepEqual(before.map_payload,researchPointFor(fresh));
  const repeat=await importResearchCatalog(pool,[fresh],{apply:true});assert.deepEqual(repeat.unchanged,[fresh.id]);assert.deepEqual(await snapshot(fresh.id),before);
  const protectedRows:any[]=[];const snapshots=new Map<string,unknown>();
  for(const kind of ['edited','claimed','closed','published','hidden','operator','point-mismatch']){
   const p=fixture();await importResearchCatalog(pool,[p],{apply:true});protectedRows.push({...p,name:'Must not overwrite'});
   if(kind==='edited')await db.query('UPDATE places SET revision=2 WHERE id=$1',[p.id]);
   if(kind==='claimed')await db.query("INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,'research-test','{}')",[tenant,p.id]);
   if(['closed','published'].includes(kind))await db.query('UPDATE places SET state=$2 WHERE id=$1',[p.id,kind]);
   if(kind==='hidden')await db.query('UPDATE places SET consumer_eligible=false WHERE id=$1',[p.id]);
   if(kind==='operator')await db.query("UPDATE places SET point_source='operator' WHERE id=$1",[p.id]);
   if(kind==='point-mismatch')await db.query('UPDATE places SET point=ST_SetSRID(ST_MakePoint(78.34,17.4),4326)::geography WHERE id=$1',[p.id]);
   snapshots.set(p.id,await snapshot(p.id));
  }
  const protect=await importResearchCatalog(pool,protectedRows,{apply:true});assert.equal(protect.protected.length,7);
  for(const[id,value]of snapshots)assert.deepEqual(await snapshot(id),value);
  const moved={...fresh,latitude:17.44,longitude:78.41};await importResearchCatalog(pool,[moved],{apply:true});const after=await snapshot(fresh.id);
  assert.equal(after.latitude,17.44);assert.equal(after.catalog_data.latitude,17.44);assert.equal(after.map_payload.latitude,17.44);
  const failure=fixture();await assert.rejects(()=>importResearchCatalog(pool,[failure,fixture('unknown-identity')],{apply:true}));assert.equal(await snapshot(failure.id),undefined);
  await db.query('SAVEPOINT reject_bad_source');await assert.rejects(()=>db.query("UPDATE place_map_points SET payload=payload||'{\"entranceVerified\":true}'::jsonb WHERE place_id=$1",[fresh.id]),/check constraint/);await db.query('ROLLBACK TO SAVEPOINT reject_bad_source');
 }finally{await db.query('ROLLBACK');db.release();await realPool.end();}
});

test('public catalogue and AI inventory expose records beyond the former 500 limit with explicit coverage',
 {skip:process.env.RUN_DB_TESTS!=='true'},async()=>{
 const admin=new pg.Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1});const prefix=`000-research-cap-${randomUUID()}-`;
 const {app}=await import('../src/app.js');const {publicPlaces}=await import('../src/modules/consumer.js');const {pool,workerPool}=await import('../src/db.js');const {authPool}=await import('../src/auth.js');
 try{
  await admin.query(`INSERT INTO places(id,slug,name,category,city,neighborhood,address,summary,tags,source_urls,researched_at,search_query,state)
    SELECT $1||lpad(n::text,4,'0'),$1||lpad(n::text,4,'0'),'Catalogue capacity fixture','sports','Hyderabad','Hyderabad','Fixture address','Local test only','["Badminton"]','["https://example.test/source"]','2026-10-10','Catalogue capacity fixture','research'
    FROM generate_series(1,510) n`,[prefix]);
  const response=await app.request('http://localhost:3000/v1/catalog');assert.equal(response.status,200);const data=await response.json() as any;
  assert(data.places.length>500);assert(data.places.some((p:any)=>p.id===prefix+'0510'));
  assert.equal(data.coverage.limit,2000);assert.equal(typeof data.coverage.truncated,'boolean');
  assert((await publicPlaces()).some(p=>p.id===prefix+'0510'),'AI retrieval uses the same expanded inventory');
 }finally{
  await admin.query('DELETE FROM places WHERE id LIKE $1',[prefix+'%']);await admin.end();
  await Promise.all([pool.end(),authPool.end(),...(workerPool===pool?[]:[workerPool.end()])]);
 }
});
