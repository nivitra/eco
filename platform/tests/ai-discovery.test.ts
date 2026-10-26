import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Hono} from 'hono';
import {discoveryAliases,discoverySchema,discoveryCategories,discoveryConversation,discoveryParkIntent,selectDiscoveryCandidates,emptyDiscoveryReply,type DiscoveryBrief} from '../src/modules/ai-discovery.js';
import {rankPlaces} from '../src/modules/recommender.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='http://localhost:3000';process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {aiRequestSchema,validateReply,validatedAnswerStream}=await import('../src/modules/ai.js');
const place=(id:string,category='cafes',tags:string[]=[],neighborhood='Jubilee Hills'):CatalogPlace=>({id,name:`Place ${id}`,category,tags,neighborhood,address:neighborhood,summary:'Sourced public listing',sourceURLs:['https://source.org/places/'+id],researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});
const input=(prompts:string[],discovery?:DiscoveryBrief):Parameters<typeof selectDiscoveryCandidates>[1]=>({messages:prompts.map(content=>({role:'user' as const,content})),scope:'hyderabad',taste:{interests:[],avoidBars:false},savedIDs:[],discovery});
const brief=(extra:Partial<DiscoveryBrief>={}):DiscoveryBrief=>({goal:'discover',savedOnly:false,...extra});

test('structured discovery remains additive, strict and bounded',()=>{
 const legacy={messages:[{role:'user',content:'Find coffee'}]};assert.equal(aiRequestSchema.parse(legacy).discovery,undefined);
 const accepted=aiRequestSchema.parse({...legacy,discovery:{goal:'service',categoryID:'doctors',query:'  Jubilee  ',savedOnly:true}});
 assert.equal(accepted.discovery?.query,'Jubilee');assert.equal(accepted.discovery?.savedOnly,true);
 for(const invalid of [{goal:'unknown'},{goal:'service',categoryID:'invented'},{goal:'service',query:'x'.repeat(161)},{goal:'service',savedOnly:'true'},{goal:'service',force:true}])assert.throws(()=>discoverySchema.parse(invalid));
});
test('backend taxonomy exactly mirrors all56 native source alias arrays',async()=>{
 const source=await readFile(new URL('../../native/Sources/KultureKit/DiscoveryCategories.swift',import.meta.url),'utf8');
 const aliases=source.slice(source.indexOf('var evidenceTokens'),source.indexOf('private static let tokenIndex'));
 const raw:Record<string,string>={carHire:'car_hire',weddingPlanning:'wedding_planning',packersMovers:'packers_movers',rentHire:'rent_hire',realEstate:'real_estate',pgHostel:'pg_hostel',trainMeals:'train_meals',billsRecharge:'bills_recharge',autoAccessories:'auto_accessories'};
 const native=Object.fromEntries([...aliases.matchAll(/case \.(\w+): aliases = (\[[^\n]+\])/g)].map(match=>[raw[match[1]]??match[1],JSON.parse(match[2])]));
 assert.equal(Object.keys(native).length,56);assert.deepEqual(discoveryAliases,native);
 assert(!discoveryCategories({...place('a','sports'),name:'Great Gym and Doctors',summary:'A gym'}).includes('gyms'));
 assert(discoveryCategories(place('b','sports',['gym'])).includes('gyms'));
});
test('category query and saved-only are intersections before ranking65, never substitutions',()=>{
 const cafes=Array.from({length:100},(_,i)=>place('cafe-'+i));
 const doctor={...place('doctor','healthcare',['doctor']),name:'Nila Dermatology',address:'Road 45, Jubilee Hills',tags:['doctor','dermatologist']};
 const hospital=place('hospital','healthcare',['hospital']);
 const all=[...cafes,doctor,hospital];
 const request={...input(['Compare coffee after my visit'],brief({goal:'service',categoryID:'doctors',query:'Nila Road 45',savedOnly:true})),savedIDs:['doctor','cafe-0']};
 const result=selectDiscoveryCandidates(all,request);
 assert.deepEqual(result.results.map(x=>x.place.id),['doctor']);assert.equal(result.goal,'service');
 assert.deepEqual(selectDiscoveryCandidates(all,{...request,savedIDs:['cafe-0']}).results,[]);
 assert.deepEqual(selectDiscoveryCandidates(all,{...request,discovery:{...request.discovery!,query:'Missing name'}}).results,[]);
 assert.deepEqual(selectDiscoveryCandidates(all,input(['coffee'],brief({categoryID:'loans'}))).results,[]);
});
test('source specialist park subtypes cannot fill ordinary Parks, but remain discoverable by name',()=>{
 const zoo={...place('zoo','parks',['nature','Zoo']),name:'Nehru Zoological Park'};
 const water={...place('water','parks',['nature','Water park','Amusement park']),name:'Jalavihar'};
 const memorial={...place('memorial','parks',['nature','Memorial garden']),name:'Hyderabad Green Memorial'};
 const urban=place('urban','nature',['Urban park']),national=place('national','nature',['National park']);
 const records=[zoo,water,memorial,urban,national];
 assert.deepEqual(new Set(selectDiscoveryCandidates(records,input(['Find a park'],brief({categoryID:'parks'}))).results.map(x=>x.place.id)),new Set(['urban','national']));
 for(const specialist of [zoo,water,memorial]){
  assert(!discoveryCategories(specialist).includes('parks'));assert(discoveryCategories(specialist).includes('nature'));
  assert(selectDiscoveryCandidates(records,input([specialist.name],brief({query:specialist.name}))).results.some(x=>x.place.id===specialist.id));
 }
 assert(discoveryCategories({...place('unclassified','parks'),name:'Zoo Park',summary:'Water park mention without source classification'}).includes('parks'));
});

const parkIntentRecords=()=>[
 {...place('coffee','cafes'),name:'Source Coffee'},
 {...place('park','parks',['Urban park','nature']),name:'Indira Park'},
 {...place('lake','nature',['Lake']),name:'Durgam Cheruvu'},
 {...place('zoo','parks',['Zoo','nature']),name:'Nehru Zoological Park'},
 {...place('water','parks',['Water park','Amusement park','nature']),name:'Jalavihar'},
 {...place('memorial','parks',['Memorial garden','nature']),name:'Hyderabad Green Memorial For Covid Martyrs'}
];
const permittedParks=(turns:string[])=>{const places=parkIntentRecords(),guard=discoveryParkIntent(turns,places);return places.filter(guard.permits).map(place=>place.id);};
test('unstructured park intent filters specialist substitutions before rank without dropping requested cafes',()=>{
 const records=parkIntentRecords();
 for(const prompt of ['Coffee and parks','Find a park','A walk and coffee']){
  const result=selectDiscoveryCandidates(records,input([prompt],brief()));
  assert(result.results.every(item=>!['zoo','water','memorial'].includes(item.place.id)),prompt);
  if(prompt.includes('Coffee')||prompt.includes('coffee'))assert(result.results.some(item=>item.place.id==='coffee'),prompt);
  assert(result.results.some(item=>item.place.id==='park'),prompt);
 }
 assert.deepEqual(permittedParks(['Coffee and a walk']),['coffee','park','lake']);
 assert.deepEqual(permittedParks(['Some walking after coffee']),['coffee','park','lake']);
 const seeded=selectDiscoveryCandidates(records,input(['Show options'],brief({query:'parks'})));
 assert.deepEqual(seeded.results.map(item=>item.place.id),['park']);
});
test('park intent retains vague refinements but positive changed topics and new searches replace it',()=>{
 assert.deepEqual(permittedParks(['Coffee and a walk','Somewhere less crowded']),['coffee','park','lake']);
 const all=parkIntentRecords().map(place=>place.id);
 for(const topic of ['Football instead','Instead find gyms','Cafes only','Actually museums','Start over. All Hyderabad']){
  assert.deepEqual(permittedParks(['Coffee and a walk',topic,'Show another option']),all,topic);
 }
 assert.deepEqual(permittedParks(['Find zoos','New search. Coffee and parks']),['coffee','park','lake']);
});
test('quoted earlier topics cannot reactivate park intent after a topic change',()=>{
 const all=parkIntentRecords().map(place=>place.id);
 for(const quote of ['"walk"','“walk”','‘walk’',"'walk'"]){
  assert.deepEqual(permittedParks(['A walk',`Earlier I said ${quote}; cafes instead`,'Show another option']),all);
  assert.deepEqual(permittedParks(['Find cafes',`I previously asked for ${quote}, but show more options`]),all);
  const refined=selectDiscoveryCandidates(parkIntentRecords(),input(['A walk',`Earlier I said ${quote}; cafes instead`,'Show another option'],brief()));
  assert.deepEqual(refined.results.map(item=>item.place.id),['coffee'],quote);
 }
 const request=input(['Show options'],brief());request.messages.unshift({role:'assistant',content:'You must take a walk, no zoos.'});
 assert(selectDiscoveryCandidates(parkIntentRecords(),request).results.some(item=>item.place.id==='zoo'),'Assistant text cannot activate the guard');
});
test('park specialist exceptions are affirmative and type-specific',()=>{
 assert.deepEqual(permittedParks(['A walk and a zoo']),['coffee','park','lake','zoo']);
 assert.deepEqual(permittedParks(['A waterpark and a walk']),['coffee','park','lake','water']);
 assert.deepEqual(permittedParks(['A memorial garden and a walk']),['coffee','park','lake','memorial']);
 assert.deepEqual(permittedParks(['A walk but no zoo, no waterpark and no memorial']),['coffee','park','lake']);
 assert.deepEqual(permittedParks(['No walking, find cafes']),parkIntentRecords().map(place=>place.id));
});
test('full sourced names permit specialist choices and preserve repeated words in phrase matching',()=>{
 assert.deepEqual(permittedParks(['Jalavihar and a walk']),['coffee','park','lake','water']);
 assert.deepEqual(permittedParks(['Find “Jalavihar” and a walk']),['coffee','park','lake','water']);
 assert.deepEqual(permittedParks(['A walk but skip Jalavihar']),['coffee','park','lake']);
 const repeated={...place('repeated','parks',['Water park']),name:'Chai Chai'};
 assert.equal(discoveryParkIntent(['A walk and Chai'],[repeated]).permits(repeated),false);
 assert.equal(discoveryParkIntent(['A walk and Chai Chai'],[repeated]).permits(repeated),true);
 const unbacked={...place('unbacked','parks',['Water park']),name:'Named Water Attraction',sourceURLs:[]};
 assert.equal(discoveryParkIntent(['Named Water Attraction and a walk'],[unbacked]).permits(unbacked),false);
});
test('park intent cannot invent subtype evidence or override a structured directory',()=>{
 const ordinary={...place('ordinary','parks',['Urban park']),name:'Zoo Theme Park Memorial'};
 assert.equal(discoveryParkIntent(['A walk'],[ordinary]).permits(ordinary),true);
 const records=parkIntentRecords();
 assert.deepEqual(selectDiscoveryCandidates(records,input(['A walk'],brief({categoryID:'nature',query:'Jalavihar'}))).results.map(item=>item.place.id),['water']);
 assert.equal(selectDiscoveryCandidates(records,input(['Jalavihar and a walk'],brief({categoryID:'parks',query:'Jalavihar'}))).results.length,0);
});

test('source-only filtering excludes imported OSM demo missing and duplicate identities',()=>{
 const valid=place('valid');
 const bad=[{...place('no-source'),sourceURLs:[]},{...place('osm-x'),sourceURLs:['https://openstreetmap.org/node/1']},{...place('fictional'),summary:'A fictional listing'}];
 const result=selectDiscoveryCandidates([valid,...bad,valid],input(['coffee'],brief({categoryID:'cafes'})));
 assert.deepEqual(result.results.map(x=>x.place.id),['valid']);
 assert.equal(selectDiscoveryCandidates([{...valid,id:'closed',status:'closed'}],input(['coffee'],brief())).results.length,0);
});
test('selected service cannot become an outing; unrestricted service/outing goals remain separate',()=>{
 const records=[place('cafe'),place('doctor','healthcare',['doctor']),place('sports','sports'),place('gym','sports',['gym'])];
 assert.deepEqual(new Set(selectDiscoveryCandidates(records,input(['Help me choose'],brief({goal:'outing'}))).results.map(x=>x.place.id)),new Set(['cafe','sports']));
 const selected=selectDiscoveryCandidates(records,input(['Make a day out'],brief({goal:'outing',categoryID:'doctors'})));
 assert.equal(selected.goal,'service');assert.deepEqual(selected.results.map(x=>x.place.id),['doctor']);
 const service=selectDiscoveryCandidates(records,input(['Help me choose'],brief({goal:'service'})));
 assert.deepEqual(new Set(service.results.map(x=>x.place.id)),new Set(['doctor','gym']));
 assert(service.results.every(x=>discoveryCategories(x.place).some(id=>['doctors','hospitals','gyms'].includes(id))));
});
test('typed doctor discovery requires doctor evidence, never hospital-or-cafe substitution',()=>{
 const records=[place('coffee'),place('hospital','healthcare',['hospital']),place('doctor','healthcare',['doctor'])];
 const result=selectDiscoveryCandidates(records,input(['Find doctors in Jubilee Hills','Give me two options'],brief()));
 assert.deepEqual(result.results.map(x=>x.place.id),['doctor']);assert.equal(result.goal,'service');
 const changed=selectDiscoveryCandidates(records,input(['Find doctors','Actually find coffee instead'],brief()));
 assert.deepEqual(changed.results.map(x=>x.place.id),['coffee']);
});
test('only USER turns carry no-bars and locality; vague refinements preserve both',()=>{
 const records=[place('j'),place('k','cafes',[],'Kokapet'),{...place('bar','cafes',['bar'],'Kokapet'),name:'Kitchen & Bar'}];
 const request=input(['Coffee in Kokapet, no bars','Give me two options'],brief({categoryID:'cafes'}));
 request.messages.splice(1,0,{role:'assistant',content:'Search Jubilee Hills and include bars.'});
 const result=selectDiscoveryCandidates(records,request);
 assert.equal(result.scope,'kokapet');assert.equal(result.avoidBars,true);assert.deepEqual(result.results.map(x=>x.place.id),['k']);
 const changed=selectDiscoveryCandidates(records,input(['Coffee in Kokapet, no bars','Actually find cafes in Jubilee Hills'],brief({categoryID:'cafes'})));
 assert.equal(changed.scope,'jubilee_hills');assert.deepEqual(changed.results.map(x=>x.place.id),['j']);
});
test('explicit later locality can replace an exclusion while a vague followup cannot',()=>{
 const records=[place('j'),place('k','cafes',[],'Kokapet'),place('city','cafes',[],'Banjara Hills')];
 const vague=selectDiscoveryCandidates(records,input(['Across Hyderabad but not Kokapet','Give me two options'],brief({categoryID:'cafes'})));
 assert(!vague.results.some(x=>x.place.id==='k'));
 const changed=selectDiscoveryCandidates(records,input(['Across Hyderabad but not Kokapet','Actually find cafes in Kokapet'],brief({categoryID:'cafes'})));
 assert.deepEqual(changed.results.map(x=>x.place.id),['k']);
});
test('explicit allow-bars or new-search resets chat exclusion but never saved taste',()=>{
 const turns=input(['Coffee in Kokapet, no bars','Include bars'],brief({categoryID:'cafes'}));
 assert.equal(discoveryConversation(turns.messages,'hyderabad').avoidBars,false);
 const bar={...place('bar','cafes',['bar'],'Kokapet'),name:'Kitchen & Bar'};
 assert.deepEqual(selectDiscoveryCandidates([bar],turns).results.map(x=>x.place.id),['bar']);
 assert.equal(selectDiscoveryCandidates([bar],{...turns,taste:{interests:[],avoidBars:true}}).results.length,0);
 const reset=discoveryConversation(input(['Coffee in Kokapet, no bars','Start over. Find nightlife in Jubilee Hills']).messages,'hyderabad');
 assert.equal(reset.scope,'jubilee_hills');assert.equal(reset.avoidBars,false);assert.equal(reset.turns.length,1);
});
test('strict unknown facts return a grounded empty reply instead of fake availability',()=>{
 const result=selectDiscoveryCandidates([place('cafe')],input(['Only wheelchair accessible cafes'],brief({categoryID:'cafes'})));
 assert.equal(result.results.length,0);const reply=emptyDiscoveryReply(result);
 assert.deepEqual(validateReply(reply,new Set()).recommendations,[]);assert.match(reply.answer,/does not verify/);
});
test('quoted hard facts stay mandatory even when quoted topic references are removed',()=>{
 const records=[place('cafe')];
 for(const request of ['Only "wheelchair accessible" places','Only ‘vegan’ cafes','Must be “open now”','Only \'gluten free\' cafes']){
  const strict=selectDiscoveryCandidates(records,input([request],brief({categoryID:'cafes'})));
  assert.equal(strict.conversation.resolvedIntent.requiresVerifiedFacts,true,request);
  assert.equal(strict.results.length,0,request);
  assert.match(emptyDiscoveryReply(strict).answer,/does not verify/);
 }
 const renewed=selectDiscoveryCandidates(records,input(['Only wheelchair accessible cafes','Show listings with unverified facts','Only "wheelchair accessible" places'],brief({categoryID:'cafes'})));
 assert.equal(renewed.conversation.resolvedIntent.requiresVerifiedFacts,true);
 assert.equal(renewed.results.length,0);
});
test('latest explicit topic replaces earlier positive categories and same-axis exclusions',()=>{
 const records=[place('cafe'),place('dinner','food'),place('park','parks')];
 const changed=selectDiscoveryCandidates(records,input(['No cafes, dinner only','Actually cafes instead'],brief()));
 assert.deepEqual(changed.results.map(x=>x.place.id),['cafe']);
 const inherited=selectDiscoveryCandidates(records,input(['No cafes, dinner only','Give me two options'],brief()));
 assert.deepEqual(inherited.results.map(x=>x.place.id),['dinner']);
 const currentNegative=selectDiscoveryCandidates(records,input(['Find cafes','Find dinner, no cafes'],brief()));
 assert.deepEqual(currentNegative.results.map(x=>x.place.id),['dinner']);
});
test('latest activity replaces prior activity while unrelated exclusions persist',()=>{
 const records=[place('badminton','sports',['badminton']),place('football','sports',['football']),place('both','sports',['football','badminton'])];
 const changed=selectDiscoveryCandidates(records,input(['Find badminton','Actually football instead'],brief()));
 assert.deepEqual(new Set(changed.results.map(x=>x.place.id)),new Set(['football','both']));
 const excluded=selectDiscoveryCandidates(records,input(['No badminton, find football','Give me two options'],brief()));
 assert.deepEqual(excluded.results.map(x=>x.place.id),['football']);
 const restored=selectDiscoveryCandidates(records,input(['No badminton, find football','Actually badminton instead'],brief()));
 assert.deepEqual(new Set(restored.results.map(x=>x.place.id)),new Set(['badminton','both']));
 const synonym=selectDiscoveryCandidates(records,input(['No soccer, find badminton','Actually football instead'],brief()));
 assert.deepEqual(new Set(synonym.results.map(x=>x.place.id)),new Set(['football','both']));
});
test('service replacement clears prior sports requirement without widening explicit directory filters',()=>{
 const records=[place('badminton','sports',['badminton']),place('gym','sports',['gym']),place('cafe')];
 const gym=selectDiscoveryCandidates(records,input(['Find badminton','Instead find gyms','Give me two options'],brief({goal:'outing'})));
 assert.equal(gym.goal,'service');assert.deepEqual(gym.results.map(x=>x.place.id),['gym']);
 assert.deepEqual(gym.conversation.resolvedIntent.requestedActivities,[]);
 const selected=selectDiscoveryCandidates(records,input(['Find badminton','Instead find gyms'],brief({categoryID:'cafes'})));
 assert.deepEqual(selected.results.map(x=>x.place.id),['cafe']);
});
test('fact requirements survive vague replies; offered explicit relaxation works without certifying facts',()=>{
 const records=[place('cafe')];
 const first='Only wheelchair accessible cafes in Kokapet, no bars';
 const local=records.map(p=>({...p,neighborhood:'Kokapet'}));
 for(const refinement of ['Yes','Give me two options','Do not show listings with unverified facts']){
  const result=selectDiscoveryCandidates(local,input([first,refinement],brief()));
  assert.equal(result.results.length,0);assert.equal(result.conversation.resolvedIntent.requiresVerifiedFacts,true);
 }
 const empty=selectDiscoveryCandidates(local,input([first],brief()));
 const followUp=emptyDiscoveryReply(empty).followUp!;
 const command=followUp.match(/“([^”]+)”/)?.[1];assert.equal(command,'Show listings with unverified facts');
 const relaxed=selectDiscoveryCandidates(local,input([first,command!],brief()));
 assert.deepEqual(relaxed.results.map(x=>x.place.id),['cafe']);assert.equal(relaxed.scope,'kokapet');assert.equal(relaxed.avoidBars,true);
 assert(relaxed.results[0].cautions.some(caution=>caution.includes('accessible entrances are unverified')));
 assert.equal(relaxed.conversation.resolvedIntent.requiresVerifiedFacts,false);
 const renewed=selectDiscoveryCandidates(local,input([first,command!,'Must be wheelchair accessible'],brief()));
 assert.equal(renewed.results.length,0);
});
test('questions about existing bars exclusion do not silently clear it; explicit replacements do',()=>{
 for(const refinement of ['Are bars still excluded?','Why did you recommend bars?']){
  assert.equal(discoveryConversation(input(['No bars',refinement]).messages,'hyderabad').avoidBars,true);
 }
 for(const refinement of ['Actually bars instead','Find bars','Bars are okay']){
  assert.equal(discoveryConversation(input(['No bars',refinement]).messages,'hyderabad').avoidBars,false);
  assert.equal(discoveryConversation(input(['No bars',refinement]).messages,'hyderabad',true).avoidBars,true);
 }
});
test('explicit multi-category ranking retains hard bar and dismissed exclusions',()=>{
 const records=[place('a'),place('b','parks'),{...place('bar','food'),name:'Kitchen & Bar'},place('c','food')];
 const result=rankPlaces(records,{intent:'coffee',categories:['parks','food'],avoidBars:true,dismissedIDs:['c'],scope:'hyderabad'});
 assert.deepEqual(result.results.map(x=>x.place.id),['b']);
});
test('empty and populated replies share strict private SSE completion and reject invalid IDs',async()=>{
 const empty=emptyDiscoveryReply(selectDiscoveryCandidates([],input(['Find a doctor'],brief({categoryID:'doctors'}))));
 const app=new Hono();app.get('/empty',c=>validatedAnswerStream(c,validateReply(empty,new Set())));
 const response=await app.request('/empty');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6));
 assert.equal(events.at(-1),'[DONE]');assert.equal(JSON.parse(events[1]).choices[0].finish_reason,'stop');
 assert.deepEqual(JSON.parse(JSON.parse(events[0]).choices[0].delta.content).recommendations,[]);
 const valid={answer:'Sourced place',recommendations:[{placeID:'a',reason:'Source category'}],followUp:null};
 assert.throws(()=>validateReply(valid,new Set(['b'])));
 assert.throws(()=>validateReply({...valid,recommendations:[...valid.recommendations,...valid.recommendations]},new Set(['a'])));
});
