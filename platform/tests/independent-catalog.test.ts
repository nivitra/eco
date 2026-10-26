import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { importIndependentCatalog, validateIndependentCatalog, isNewOfficialBranch } from '../scripts/import-independent-catalog.js';
import { upsertResearchPlace, upsertResearchMapPoint } from '../scripts/seed-catalog.js';

const place = (id:string) => ({id,name:'Import test venue',category:'cafes',neighborhood:'Jubilee Hills',
  address:'Test fixture address',summary:'Test public description',tags:['Coffee'],sourceURLs:['https://example.test/venue'],
  researchedAt:'2026-10-09',searchQuery:'Import test venue Jubilee Hills Hyderabad'});
const wikidata = (q:string) => ({...place(`wikidata-q${q}`),sourceURLs:[`https://www.wikidata.org/wiki/Q${q}`],
  latitude:17.43,longitude:78.40,coordinateSource:'Wikidata',coordinateKind:'poi'});

test('independent input requires bounded coordinates, exact matching Q identity and clean sources',()=>{
  const good=wikidata('123'); assert.equal(validateIndependentCatalog([good])[0].id,good.id);
  for(const bad of [
    {...good,id:'wikidata-q0123'}, {...good,sourceURLs:['https://www.wikidata.org/wiki/Q456']},
    {...good,sourceURLs:['https://www.wikidata.org.evil.test/wiki/Q123']},
    {...good,sourceURLs:['https://www.wikidata.org/wiki/Q123?x=1']},
    {...good,sourceURLs:['https://www.wikidata.org/wiki/Q123#x']},
    {...good,sourceURLs:['https://www.wikidata.org/wiki/Q123','https://www.openstreetmap.org/node/1']},
    {...good,latitude:19}, {...good,longitude:'78.40'}, {...good,coordinateKind:'entrance'},
    {...good,coordinateSource:undefined}, {...good,name:'Fictional test (Demo)'}, {...good,privateProof:'must not import'},
  ]) assert.throws(()=>validateIndependentCatalog([bad]));
  assert.throws(()=>validateIndependentCatalog([good,good]));
});

test('known photo and independent research provenance is retained without invented verification',()=>{
  const official={...place('existing-official-venue'),imageLicenseURL:'https://creativecommons.org/licenses/by-sa/4.0/',
    imageProvenance:{fileTitle:'Source photo',evidenceURL:'https://example.test/photo',checkedAt:'2026-10-09',remotePreviewOnly:true,reusePermission:'unknown',visualVerification:'Source image checked.'},
    discoveryProvenance:{source:'official-business-website',retrievedAt:'2026-10-09',method:'Official facts checked.',boundaryVerified:false,currentOperationVerified:false,
      renderingAssetURL:'https://example.test/app.js',renderingAssetSHA256:'a'.repeat(64)}};
  const wiki={...wikidata('123'),discoveryProvenance:{provider:'Wikidata',entityID:'Q123',classes:['metro station'],entityRevision:null,
    coordinateStatementID:'Q123$reference',coordinatePrecisionDegrees:0.00001,coordinateReferenceURLs:[],fetchedAt:'2026-10-09',review:'Source location; entrance unverified.',
    operatorSourceURL:'https://example.test/network.pdf'}};
  const result=validateIndependentCatalog([official,wiki]);
  assert.deepEqual(result[0].imageProvenance,official.imageProvenance);assert.deepEqual(result[0].discoveryProvenance,official.discoveryProvenance);
  assert.deepEqual(result[1].discoveryProvenance,wiki.discoveryProvenance);
  assert.throws(()=>validateIndependentCatalog([{...official,discoveryProvenance:{...official.discoveryProvenance,currentOperationVerified:true}}]));
  assert.throws(()=>validateIndependentCatalog([{...wiki,discoveryProvenance:{...wiki.discoveryProvenance,privateEvidenceURL:'https://example.test/private'}}]));
});

test('education locality reviews retain a narrow typed audit without granting entrance verification',()=>{
  const review={primarySourceURL:'https://example.test/university/contact',primaryAddress:'Source campus address',
    decision:'retain_area_consistent',reason:'The official locality is consistent with the approximate point.',
    reviewedAt:'2026-10-09',limitation:'No gate or independent GPS verification.'};
  const record={...wikidata('123'),category:'education',discoveryProvenance:{provider:'Wikidata',entityID:'Q123',classes:['university'],entityRevision:null,
    coordinateStatementID:'Q123$reference',coordinatePrecisionDegrees:0.00001,coordinateReferenceURLs:[],fetchedAt:'2026-10-09',review:'Source-backed point.',educationLocationReview:review}};
  assert.deepEqual((validateIndependentCatalog([record])[0].discoveryProvenance as any).educationLocationReview,review);
  for(const invalid of [{...review,decision:'verified_entrance'},{...review,primarySourceURL:'file:///private/evidence'},{...review,reviewedAt:'yesterday'},{...review,privateProof:'private'}])
    assert.throws(()=>validateIndependentCatalog([{...record,discoveryProvenance:{...record.discoveryProvenance,educationLocationReview:invalid}}]));
});

const official=(id:string)=>({...place(id),category:'business',address:'Unit 1, Jubilee Hills, Hyderabad',tags:['cleaning'],
 sourceURLs:['https://official.example/branches/hyderabad'],discoveryProvenance:{source:'official-business-website',retrievedAt:'2026-10-10',
 method:'Reviewed named branch address and explicit service type on operator website.',boundaryVerified:false,currentOperationVerified:false}});
test('official business admission is strict, opt-in and never supplies invented location/media',()=>{
 const good=validateIndependentCatalog([official('official-test-branch')])[0];assert(isNewOfficialBranch(good));
 assert.throws(()=>validateIndependentCatalog([{...official('official-test-branch'),discoveryProvenance:undefined}]));
 assert.throws(()=>validateIndependentCatalog([{...official('official-test-branch'),discoveryProvenance:{...official('x').discoveryProvenance,retrievedAt:'unknown'}}]));
 for(const patch of [{id:'unknown-branch'},{address:'Hyderabad'},{neighborhood:''},{tags:[]},{sourceURLs:['http://official.example/branch']},
  {sourceURLs:['https://maps.google.com/branch']},{sourceURLs:['https://official.example/branch#address']},{imageURL:'https://official.example/unlicensed.jpg'}])
  assert(!isNewOfficialBranch(validateIndependentCatalog([{...official('official-test-branch'),...patch}])[0]),JSON.stringify(patch));
});

test('independent import is dry by default, atomic, idempotent and protects customer/operator records',
  {skip:process.env.RUN_DB_TESTS!=='true'},async()=>{
  const realPool=new pg.Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1});
  const connection=await realPool.connect();
  await connection.query('BEGIN');
  // Keep the importer's real SQL and locking but wrap each batch in a savepoint.
  // The outer rollback restores even unrelated pre-existing OSM fixtures.
  const pool={
    query:connection.query.bind(connection),
    connect:async()=>({release(){},query:(sql:string,values?:any[])=>connection.query(
      sql==='BEGIN'?'SAVEPOINT independent_import_batch':sql==='COMMIT'?'RELEASE SAVEPOINT independent_import_batch':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT independent_import_batch':sql,values)}),
  } as unknown as pg.Pool;
  const suffix=randomUUID(),nonce=String(Date.now())+String(Math.floor(Math.random()*900)+100);
  const newPlace=wikidata(nonce),tenant=randomUUID();
  const ownedIDs:string[]=[newPlace.id];
  const input:any[]=[newPlace];
  const protectedSnapshots=new Map<string,unknown>();
  const snapshot=async(id:string)=>(await pool.query(`SELECT p.name,p.summary,p.source_urls,p.catalog_data,p.state,p.revision,p.consumer_eligible,
    p.point_source,p.point_kind,ST_X(p.point::geometry) longitude,ST_Y(p.point::geometry) latitude,p.updated_at,m.payload,m.updated_at map_updated_at
    FROM places p LEFT JOIN place_map_points m ON m.place_id=p.id WHERE p.id=$1`,[id])).rows[0];
  const old=async(id:string)=>{
    ownedIDs.push(id); const p={...place(id),sourceURLs:['https://www.openstreetmap.org/node/123'],latitude:17.398,longitude:78.338,coordinateSource:'OpenStreetMap',coordinateKind:'poi'};
    const db=await pool.connect();try{await upsertResearchPlace(db,p);await upsertResearchMapPoint(db,{placeID:id,latitude:17.398,longitude:78.338,sourceName:'OpenStreetMap',osmType:'node',osmID:123,sourceURL:p.sourceURLs[0]});}finally{db.release();}
    return p;
  };
  try {
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,'Independent import test','independent-test')",[tenant]);
    const clean=await old(`independent-clean-${suffix}`);input.push(place(clean.id));
    const retired=await old(`osm-node-${nonce}`);
    for(const kind of ['edited','claimed','hidden','published','closed','operator-source','operator-point']){
      const p=await old(`independent-${kind}-${suffix}`);input.push(place(p.id));
      if(kind==='edited')await pool.query('UPDATE places SET revision=2 WHERE id=$1',[p.id]);
      if(kind==='claimed')await pool.query("INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,'independent-test','{}')",[tenant,p.id]);
      if(kind==='hidden')await pool.query('UPDATE places SET consumer_eligible=false WHERE id=$1',[p.id]);
      if(kind==='published'||kind==='closed')await pool.query('UPDATE places SET state=$2 WHERE id=$1',[p.id,kind]);
      if(kind==='operator-source')await pool.query("UPDATE places SET point_source='operator' WHERE id=$1",[p.id]);
      if(kind==='operator-point')await pool.query('UPDATE places SET point=ST_SetSRID(ST_MakePoint(78.34,17.40),4326)::geography WHERE id=$1',[p.id]);
      protectedSnapshots.set(p.id,await snapshot(p.id));
    }
    const claimedOSM=await old(`osm-way-${nonce}`);
    await pool.query("INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,'independent-test','{}')",[tenant,claimedOSM.id]);
    protectedSnapshots.set(claimedOSM.id,await snapshot(claimedOSM.id));
    const beforeClean=await snapshot(clean.id), beforeRetired=await snapshot(retired.id);
    const branch=official(`official-import-${suffix}`);ownedIDs.push(branch.id);
    await assert.rejects(()=>importIndependentCatalog(pool,[branch],{allowNewOfficial:true}),/retireOSM:false/);
    await assert.rejects(()=>importIndependentCatalog(pool,[branch],{retireOSM:false}),/must already exist/);
    const branchDry=await importIndependentCatalog(pool,[branch],{allowNewOfficial:true,retireOSM:false});
    assert.deepEqual(branchDry.inserted,[branch.id]);assert.deepEqual(branchDry.retired,[]);assert.equal(await snapshot(branch.id),undefined);
    await importIndependentCatalog(pool,[branch],{apply:true,allowNewOfficial:true,retireOSM:false});
    const branchSaved=await snapshot(branch.id);assert.equal(branchSaved.latitude,null);assert.equal(branchSaved.payload,null);
    assert.deepEqual(await snapshot(retired.id),beforeRetired,'finite official batch leaves unrelated legacy records unchanged');
    const branchRepeat=await importIndependentCatalog(pool,[branch],{apply:true,allowNewOfficial:true,retireOSM:false});
    assert.deepEqual(branchRepeat.unchanged,[branch.id]);assert.deepEqual(branchRepeat.updated,[]);
    await pool.query('UPDATE places SET revision=2 WHERE id=$1',[branch.id]);
    const editedBranch=await snapshot(branch.id);
    const branchProtected=await importIndependentCatalog(pool,[{...branch,summary:'Changed source summary'}],{apply:true,allowNewOfficial:true,retireOSM:false});
    assert.deepEqual(branchProtected.protected,[{id:branch.id,reason:'edited revision'}]);assert.deepEqual(await snapshot(branch.id),editedBranch);

    const dry=await importIndependentCatalog(pool,input);
    assert.equal(dry.applied,false);assert(dry.inserted.includes(newPlace.id));assert(dry.updated.includes(clean.id));assert(dry.retired.includes(retired.id));
    assert.equal(await snapshot(newPlace.id),undefined);assert.deepEqual(await snapshot(clean.id),beforeClean);assert.deepEqual(await snapshot(retired.id),beforeRetired);
    // Unknown new seed identities fail before any mutation, including retirement.
    await assert.rejects(()=>importIndependentCatalog(pool,[...input,place(`unknown-${suffix}`)],{apply:true}),/must already exist/);
    assert.equal(await snapshot(newPlace.id),undefined);assert.deepEqual(await snapshot(retired.id),beforeRetired);
    const applied=await importIndependentCatalog(pool,input,{apply:true});assert.equal(applied.applied,true);
    const inserted=await snapshot(newPlace.id);assert.equal(inserted.point_source,'Wikidata');assert.equal(inserted.longitude,newPlace.longitude);
    assert.equal(inserted.payload.entranceVerified,false);assert.equal(inserted.payload.sourceURL,newPlace.sourceURLs[0]);
    const cleaned=await snapshot(clean.id);assert.equal(cleaned.latitude,null);assert.equal(cleaned.payload,null);assert.equal(cleaned.catalog_data.coordinateSource,undefined);
    assert.deepEqual(cleaned.source_urls,place(clean.id).sourceURLs);
    const hidden=await snapshot(retired.id);assert.equal(hidden.consumer_eligible,false);assert.deepEqual(hidden.payload,beforeRetired.payload,'retirement preserves direct-place identity and source record');
    for(const [id,before] of protectedSnapshots)assert.deepEqual(await snapshot(id),before,id);
    const repeat=await importIndependentCatalog(pool,input,{apply:true});assert.equal(repeat.inserted.length,0);assert.equal(repeat.updated.length,0);
    assert.deepEqual(await snapshot(newPlace.id),inserted);assert.deepEqual(await snapshot(clean.id),cleaned);
    const moved={...newPlace,latitude:17.431,longitude:78.401};await importIndependentCatalog(pool,[moved],{apply:true});
    const movedRow=await snapshot(newPlace.id);assert.equal(movedRow.latitude,moved.latitude);assert.equal(movedRow.payload.latitude,moved.latitude);assert.equal(movedRow.catalog_data.latitude,moved.latitude);
    await assert.rejects(()=>pool.query("UPDATE place_map_points SET payload=payload||'{\"entranceVerified\":true}'::jsonb WHERE place_id=$1",[newPlace.id]),/check constraint/);
  } finally {
    await connection.query('ROLLBACK');
    connection.release();await realPool.end();
  }
});
