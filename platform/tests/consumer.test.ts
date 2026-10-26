import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Explicit test-only defaults; no connection is made by the pure domain tests.
process.env.PUBLIC_URL??='http://localhost:3000';process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {eligiblePlaces,mobilePlace,normalizeProfile,profileSchema,profileRevision,tasteSchema,catalogAttributions}=await import('../src/modules/consumer.js');
const {validateReply,boundedJSON,aiRequestSchema}=await import('../src/modules/ai.js');
const {parseRoute}=await import('../src/modules/routes.js');
const {rankPlaces}=await import('../src/modules/recommender.js');
const seed=JSON.parse(await readFile(new URL('../data/places.json',import.meta.url),'utf8'));

test('sourced catalog IDs stay unique; unknown map coordinates are not invented',()=>{
  assert(seed.length>=37);assert.equal(new Set(seed.map((p:any)=>p.id)).size,seed.length);
  const row={id:seed[0].id,name:'Published name',category:'cafes',neighborhood:'Jubilee Hills',address:'Sourced address',summary:'Approved summary',tags:[],source_urls:['https://example.com'],researched_at:'2026-09-19',search_query:'Specific branch',revision:2,state:'active',catalog_data:{...seed[0],privateEvidenceURL:'secret',tenantID:'private'},private_owner:'secret'};
  const dto=mobilePlace(row);assert.equal(dto.name,'Published name');assert.equal(dto.id,seed[0].id);assert.equal('privateEvidenceURL' in dto,false);assert.equal('point' in dto,false);assert.equal('private_owner' in dto,false);
});
test('catalog map attributions match actual point sources without assuming OSM',()=>{
 assert.deepEqual(catalogAttributions([]),[]);
 assert.deepEqual(catalogAttributions([{sourceName:'Unknown'}]),[]);
 const wiki=catalogAttributions([{sourceName:'Wikidata'},{sourceName:'Wikidata'}]);
 assert.equal(wiki.length,1);assert.equal(wiki[0].license,'CC0-1.0');assert(!wiki[0].text.includes('OpenStreetMap'));
 const osm=catalogAttributions([{sourceName:'OpenStreetMap'}]);assert.equal(osm.length,1);assert.equal(osm[0].license,'ODbL-1.0');
 assert.deepEqual(catalogAttributions([{sourceName:'Wikidata'},{sourceName:'OpenStreetMap'}]).map(x=>x.license),['CC0-1.0','ODbL-1.0']);
});
test('local scope excludes explicit outside neighborhood and no-bars excludes name/tag bars',()=>{
  const records=seed.map((p:any)=>({...p,revision:1,status:'research'}));
  const local=eligiblePlaces(records,'jubilee_hills',true);
  assert(local.length>10);assert(!local.some(p=>p.id==='roast-ccx-banjara-hills'));
  assert(local.every(p=>p.category!=='nightlife'&&!/\b(bar|pub|brewery|brewing)\b/i.test([p.name,...p.tags].join(' '))));
  assert(eligiblePlaces(records,'hyderabad',false).some(p=>p.id==='charminar-old-city'));
});
test('profile rejects unknown places and duplicate outing identities; versions require preconditions',()=>{
  const profile=profileSchema.parse({savedIDs:['a','a'],taste:{interests:['cafes'],pace:'Unhurried',avoidBars:false},outings:[{id:'o',title:'Plan',placeIDs:['a','a'],createdAt:1}]});
  assert.deepEqual(normalizeProfile(profile,new Set(['a'])).savedIDs,['a']);
  assert.throws(()=>normalizeProfile(profile,new Set(['b'])),/not in this catalog/);
  assert.throws(()=>normalizeProfile({...profile,outings:[profile.outings[0],profile.outings[0]]},new Set(['a'])),/unique/);
  assert.equal(profileRevision('"profile:4"'),4);assert.equal(profileRevision('"4"'),4);assert.throws(()=>profileRevision(undefined));assert.throws(()=>profileRevision('*'));assert.throws(()=>profileRevision('0'));
});
test('AI validator rejects out-of-scope recommendations, duplicate cards and oversized prose',()=>{
  const valid={answer:'A sourced option.',recommendations:[{placeID:'a',reason:'A cafe.'}],followUp:null};
  assert.equal(validateReply(valid,new Set(['a'])).recommendations.length,1);
  assert.throws(()=>validateReply(valid,new Set(['b'])));
  assert.throws(()=>validateReply({...valid,recommendations:[...valid.recommendations,...valid.recommendations]},new Set(['a'])));
  assert.throws(()=>validateReply({...valid,answer:'x'.repeat(3001)},new Set(['a'])));
});
test('provider decoder bounds streaming body and rejects invalid JSON',async()=>{
  await assert.rejects(()=>boundedJSON(new Response('x'.repeat(21)),20));
  await assert.rejects(()=>boundedJSON(new Response('not json')));
  assert.deepEqual(await boundedJSON(new Response('{"ok":true}')),{ok:true});
  const interrupted=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('provider transport interrupted'));}});
  await assert.rejects(()=>boundedJSON(new Response(interrupted)),(error:any)=>error.status===503&&error.code==='provider_stream_unavailable');
});
const from={latitude:17.4306,longitude:78.4072},to={latitude:17.431,longitude:78.408};
const fixture=()=>({code:'Ok',waypoints:[{distance:0,location:[from.longitude,from.latitude]},{distance:0,location:[to.longitude,to.latitude]}],routes:[{distance:100,duration:30,geometry:{type:'LineString',coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]]}}]});
test('route parser checks real geometry and rejects large snapping, reversed coordinates and missing segments',()=>{
  assert.equal(parseRoute(fixture(),from,to).durationSeconds,30);
  const snap=fixture();snap.waypoints[1].distance=201;assert.throws(()=>parseRoute(snap,from,to),/too far/);
  const switched=fixture();switched.routes[0].geometry.coordinates.reverse();assert.throws(()=>parseRoute(switched,from,{latitude:18,longitude:79}));
  const bad=fixture();bad.routes[0].duration=-1;assert.throws(()=>parseRoute(bad,from,to));
  assert.throws(()=>parseRoute({code:'NoRoute'},from,to),/No route/);
  const many=fixture();many.routes[0].geometry.coordinates=Array(20001).fill([78.4072,17.4306]);assert.throws(()=>parseRoute(many,from,to));
});


test('public coordinate projection requires OSM provenance, bounds, kind and non-demo identity',()=>{
  const row={id:'osm-node-1',name:'Test Supplies',category:'stationery',neighborhood:'Kokapet area',address:'Kokapet',summary:'Source text',tags:[],source_urls:['https://www.openstreetmap.org/node/1'],revision:1,state:'research',catalog_data:{latitude:17.3978,longitude:78.337,coordinateSource:'OpenStreetMap',coordinateKind:'poi'}};
  const good=mobilePlace(row);assert.equal(good.latitude,17.3978);assert.equal(good.coordinateKind,'poi');
  for(const bad of [{...row,name:'Supplies (Demo)'},{...row,source_urls:['https://openstreetmap.org.evil.test/node/1']},{...row,catalog_data:{...row.catalog_data,latitude:19.076}},{...row,catalog_data:{...row.catalog_data,latitude:'17.3978'}},{...row,catalog_data:{...row.catalog_data,longitude:Infinity}},{...row,catalog_data:{...row.catalog_data,coordinateKind:'entrance'}},{...row,catalog_data:{...row.catalog_data,coordinateKind:'bbox_center'}}])assert.equal(mobilePlace(bad).latitude,undefined);
  assert.equal(mobilePlace({...row,source_urls:['https://openstreetmap.org/way/2'],catalog_data:{...row.catalog_data,coordinateKind:'bbox_center'}}).coordinateKind,'bbox_center');
});
test('expanded interests and Kokapet eligibility retain strict local boundaries',()=>{
  const taste=tasteSchema.parse({interests:['healthcare','stationery','community','parks']});assert.equal(taste.interests.length,4);
  const record={id:'local',name:'Supplies',category:'stationery',neighborhood:'Kokapet area',address:'',summary:'',tags:[],sourceURLs:[],researchedAt:'',searchQuery:'',revision:1,status:'research'};
  const records=[record,{...record,id:'near',neighborhood:'Narsingi near Kokapet'},{...record,id:'outside',neighborhood:'Outside of Kokapet'},{...record,id:'demo',name:'Supplies (Demo)'},{...record,id:'other',neighborhood:'Jubilee Hills'}];
  assert.deepEqual(eligiblePlaces(records,'kokapet',false).map(p=>p.id),['local']);
});

test('public Wikidata coordinates require strict Q URLs and never imply an entrance',()=>{
 const row={id:'wikidata-q123',name:'Test Venue',category:'cafes',neighborhood:'Hyderabad',address:'Source address',summary:'Source text',tags:[],source_urls:['https://www.wikidata.org/wiki/Q123'],revision:1,state:'research',catalog_data:{latitude:17.43,longitude:78.40,coordinateSource:'Wikidata',coordinateKind:'poi'}};
 assert.equal(mobilePlace(row).latitude,17.43);
 assert.equal(mobilePlace({...row,catalog_data:{...row.catalog_data,coordinateKind:'coordinate_location'}}).coordinateKind,'coordinate_location');
 for(const url of ['http://www.wikidata.org/wiki/Q123','https://wikidata.org.evil.test/wiki/Q123','https://user@www.wikidata.org/wiki/Q123','https://www.wikidata.org:443/wiki/Q123','https://www.wikidata.org:444/wiki/Q123','https://www.wikidata.org/wiki/Q0','https://www.wikidata.org/wiki/Q0123','https://www.wikidata.org/wiki/Q123?x=1','https://www.wikidata.org/wiki/Q123?','https://www.wikidata.org/wiki/Q123#x','https://www.wikidata.org/wiki/Q１２３','https://www.wikidata.org/wiki/Q123\n'])assert.equal(mobilePlace({...row,source_urls:[url]}).latitude,undefined,url);
 for(const data of [{...row.catalog_data,latitude:'17.43'},{...row.catalog_data,longitude:Infinity},{...row.catalog_data,latitude:19},{...row.catalog_data,coordinateKind:'entrance'}])assert.equal(mobilePlace({...row,catalog_data:data}).latitude,undefined);
 assert.equal(mobilePlace({...row,name:'Venue (Demo)'}).latitude,undefined);
});

test('AI request accepts Kokapet and expanded interests but rejects unknown scope',()=>{
 const input={messages:[{role:'user',content:'Find stationery in Kokapet'}],scope:'kokapet',taste:{interests:['stationery','community'],pace:'Unhurried',avoidBars:false}};
 assert.equal(aiRequestSchema.parse(input).scope,'kokapet');
 assert.throws(()=>aiRequestSchema.parse({...input,scope:'invented-neighborhood'}));
});

test('universities and stations require purpose-specific intent, interest or a saved target',()=>{
 const base={id:'coffee',name:'Test Coffee',category:'cafes',neighborhood:'Jubilee Hills',address:'',summary:'',tags:[],sourceURLs:[],researchedAt:'',searchQuery:'',revision:1,status:'research'};
 const records=[base,{...base,id:'campus',name:'Example University',category:'education'},
   {...base,id:'station',name:'Example Metro Station',category:'transport'}, {...base,id:'hospital',name:'Example Hospital',category:'healthcare'}];
 assert.deepEqual(rankPlaces(records,{intent:'Plan a relaxed outing',scope:'hyderabad'}).results.map(r=>r.place.id),['coffee']);
 assert.deepEqual(rankPlaces(records,{intent:'Suggest a cafe',scope:'hyderabad',savedIDs:['campus']}).results.map(r=>r.place.id),['coffee']);
 assert.deepEqual(rankPlaces(records,{intent:'Find a university',scope:'hyderabad'}).results.map(r=>r.place.id),['campus']);
 assert.deepEqual(rankPlaces(records,{intent:'Find a metro station',scope:'hyderabad'}).results.map(r=>r.place.id),['station']);
 assert(rankPlaces(records,{scope:'hyderabad',interests:['education']}).results.some(r=>r.place.id==='campus'));
 assert(rankPlaces(records,{scope:'hyderabad',savedIDs:['station']}).results.some(r=>r.place.id==='station'));
 assert(!rankPlaces(records,{intent:'No universities',scope:'hyderabad',interests:['education'],savedIDs:['campus']}).results.some(r=>r.place.id==='campus'));
 const withArt=[...records,{...base,id:'gallery',name:'Test Gallery',category:'art'}];
 const excluded=rankPlaces(withArt,{intent:'Coffee and art, no metro stations and no colleges',scope:'hyderabad',
   interests:['education','transport'],savedIDs:['campus','station'],likedIDs:['campus','station']});
 assert.deepEqual(new Set(excluded.results.map(r=>r.place.id)),new Set(['coffee','gallery']));
 for(const id of ['campus','station'])assert(excluded.exclusions.find(r=>r.placeID===id)?.reasons.includes('excluded_category_or_bar'));
 assert.deepEqual(tasteSchema.parse({interests:['education','transport']}).interests,['education','transport']);
});

test('research coordinate projection carries complete source provenance; photo reference data stays private',()=>{
 const sourceURL='https://playo.co/venues/L.B-Nagar/test-@-court';const proof={sourceURL,method:'public_venue_data',retrievedAt:'2026-10-10',entranceVerified:false,independentlyVerified:false};
 const row={id:'playo-123',name:'Test Court',category:'sports',neighborhood:'Hyderabad',address:'Source address',summary:'Source-listed court',tags:['Badminton'],source_urls:[sourceURL],revision:1,state:'research',catalog_data:{latitude:17.43,longitude:78.4,coordinateSource:'Playo',coordinateKind:'poi',coordinateProvenance:proof,research:{photoReferences:['not a public photo']}}};
 assert.deepEqual(mobilePlace(row).coordinateProvenance,proof);assert.equal(mobilePlace(row).latitude,17.43);assert.equal('research' in mobilePlace(row),false);
 for(const patch of [{entranceVerified:true},{independentlyVerified:true},{method:'published_JSON-LD'},{sourceURL:'https://playo.co.evil.test/venues/a/b'}])assert.equal(mobilePlace({...row,catalog_data:{...row.catalog_data,coordinateProvenance:{...proof,...patch}}}).latitude,undefined);
 assert.equal(mobilePlace({...row,source_urls:[]}).latitude,undefined);
 assert.deepEqual(tasteSchema.parse({interests:['sports','games']}).interests,['sports','games']);
});

test('sports/games match source activities and explicit exclusion wins over saved interests',()=>{
 const base={id:'badminton',name:'A Court',category:'sports',neighborhood:'Hyderabad',address:'',summary:'',tags:['Badminton'],sourceURLs:[],researchedAt:'',searchQuery:'',revision:1,status:'research'};
 const records=[base,{...base,id:'cricket',name:'Cricket Venue',tags:['Cricket']},{...base,id:'snooker',name:'Cue Venue',category:'games',tags:['Snooker']},{...base,id:'coffee',name:'Coffee Venue',category:'cafes',tags:['Coffee']}];
 assert.deepEqual(rankPlaces(records,{intent:'Badminton with friends',scope:'hyderabad'}).results.map(r=>r.place.id),['badminton']);
 assert.deepEqual(rankPlaces(records,{intent:'Cricket, no badminton',scope:'hyderabad',savedIDs:['badminton'],interests:['sports']}).results.map(r=>r.place.id),['cricket']);
 assert.deepEqual(rankPlaces(records,{intent:'Snooker games',scope:'hyderabad'}).results.map(r=>r.place.id),['snooker']);
 assert.deepEqual(new Set(rankPlaces(records,{intent:'Coffee and badminton',scope:'hyderabad'}).results.map(r=>r.place.id)),new Set(['coffee','badminton']));
 assert(!rankPlaces(records,{intent:'No sports or games',scope:'hyderabad',savedIDs:['badminton','snooker'],interests:['sports','games']}).results.some(r=>r.place.id!=='coffee'));
});
