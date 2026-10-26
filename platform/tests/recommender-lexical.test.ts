import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rankPlaces} from '../src/modules/recommender.js';
import {buildPlanningDraft,planningSchema} from '../src/modules/ai-planning.js';
import {selectDiscoveryCandidates} from '../src/modules/ai-discovery.js';
import {planningCoordinate} from '../src/modules/planning-geography.js';
import type {CatalogPlace} from '../src/modules/consumer.js';

const bundle=JSON.parse(await readFile(new URL('../../native/Sources/KultureKit/Resources/jubilee-places.json',import.meta.url),'utf8')) as CatalogPlace[];
const places=bundle.map(place=>({...place,status:'research',revision:1}));
// These checks isolate relevance from the separately tested nearby allocator.
const planning=planningSchema.parse({stages:[{id:'stop-1',categoryID:'cafes'},{id:'stop-2',categoryID:'parks'}],selectionMode:'relevance'});
const input=(prompt:string)=>({messages:[{role:'user' as const,content:prompt}],scope:'hyderabad',taste:{interests:[],avoidBars:false},savedIDs:[],discovery:{goal:'outing' as const,savedOnly:false}});
const fixture=(id:string,name:string,tags:string[]=[],category='parks',neighborhood='Jubilee Hills'):CatalogPlace=>({id,name,tags,category,neighborhood,address:neighborhood,summary:'Source-listed venue',sourceURLs:['https://source.example/'+id],researchedAt:'2026-10-10',searchQuery:name,status:'research',revision:1});

test('actual default planning prompt gives no name bonus for the memorial function word',()=>{
  const prompt='Find a place for each activity in this outing. Show any missing matches and what I should check.';
  const result=buildPlanningDraft(places,input(prompt),planning);
  const pool=result.pools[1].results;
  const memorial=pool.find(item=>item.place.id==='wikidata-q113559189');
  const indira=pool.find(item=>item.place.id==='wikidata-q11219005')!;
  assert.equal(memorial,undefined,'The source-classified memorial is no longer an ordinary park candidate');assert(indira);
  const lexical=rankPlaces([fixture('memorial','Hyderabad Green Memorial For Covid Martyrs'),fixture('park','Indira Park')],{intent:prompt,scope:'hyderabad',category:'parks'}).results;
  assert.equal(lexical[0].score,lexical[1].score);
  assert(lexical.every(item=>!item.reasons.includes('The place name matches your request.')));
  assert(pool.some(item=>item.place.id===result.plan.stages[1].placeID));
  assert.deepEqual(buildPlanningDraft([...places].reverse(),input(prompt),planning).plan,result.plan);
});

test('Hyderabad and conversational words cannot outweigh a meaningful park request',()=>{
  const base=buildPlanningDraft(places,input('Coffee then a park for friends'),planning);
  const city=buildPlanningDraft(places,input('Plan coffee then a park for friends in Hyderabad'),planning);
  const scores=(result:typeof base)=>Object.fromEntries(result.pools[1].results.map(item=>[item.place.id,item.score]));
  assert.deepEqual(scores(city),scores(base));
  assert.equal(scores(city)['wikidata-q113559189'],undefined);
  const lexical=rankPlaces([fixture('memorial','Hyderabad Green Memorial For Covid Martyrs'),fixture('park','Indira Park')],{intent:'Plan coffee then a park for friends in Hyderabad',scope:'hyderabad',category:'parks'}).results;
  assert.equal(lexical[0].place.id,'park');assert(lexical[0].score>lexical[1].score);
  assert(city.pools[1].results.find(item=>item.place.id==='wikidata-q11219005')?.reasons.includes('The place name matches your request.'));
});

test('meaningful venue names and activity tags retain their lexical influence',()=>{
  const records=[fixture('a','Hyderabad Green Memorial For Covid Martyrs'),fixture('b','Hyderabad Botanical Garden'),fixture('c','City Garden',['trail'])];
  assert.equal(rankPlaces(records,{intent:'Find Hyderabad Botanical Garden',scope:'hyderabad',category:'parks'}).results[0].place.id,'b');
  assert.equal(rankPlaces(records,{intent:'Find the memorial for Covid martyrs in Hyderabad',scope:'hyderabad',category:'parks'}).results[0].place.id,'a');
  const trail=rankPlaces(records,{intent:'Suggest a trail',scope:'hyderabad',category:'parks'});
  assert.equal(trail.results[0].place.id,'c');assert(trail.results[0].reasons.some(reason=>reason.includes('trail')));
  const hills=[fixture('a','Plain Cafe',[],'cafes'),fixture('b','Banjara Hills Cafe',[],'cafes')];
  assert.equal(rankPlaces(hills,{intent:'Coffee at Banjara Hills',scope:'hyderabad'}).results[0].place.id,'b');
});

test('scope terms and generic tag padding do not create lexical affinity',()=>{
  const records=[fixture('a','Plain Venue'),fixture('b','Jubilee Hills Venue',['for','Hyderabad','Jubilee Hills'])];
  const ranked=rankPlaces(records,{intent:'Find a place for me in Jubilee Hills, Hyderabad',scope:'hyderabad',category:'parks'});
  assert.equal(ranked.scope,'jubilee_hills');assert.equal(ranked.results.length,2);
  assert.equal(ranked.results[0].score,ranked.results[1].score);
  assert(ranked.results.every(item=>!item.reasons.some(reason=>reason.includes('name matches')||reason.includes('tags match'))));
});

test('lexical filtering leaves locality negation, no-bars, activity and unknown-fact gates intact',()=>{
  const records=[fixture('k','Kokapet Cafe',[],'cafes','Kokapet'),fixture('bar','Kokapet Cafe Bar',['bar'],'cafes','Kokapet'),fixture('j','Jubilee Cafe',[],'cafes')];
  const result=rankPlaces(records,{intent:'Cafes in Kokapet, not Jubilee Hills, no bars',scope:'hyderabad'});
  assert.equal(result.scope,'kokapet');assert.deepEqual(result.results.map(item=>item.place.id),['k']);
  assert.equal(rankPlaces(records,{intent:'Only wheelchair accessible cafes in Kokapet',scope:'hyderabad'}).results.length,0);
  const sports=[fixture('football','Football Court',['football'],'sports'),fixture('badminton','Badminton Court',['badminton'],'sports')];
  assert.deepEqual(rankPlaces(sports,{intent:'Find badminton, not football in Jubilee Hills',scope:'hyderabad'}).results.map(item=>item.place.id),['badminton']);
});

test('directory and service eligibility never claim an absent personal interest',()=>{
  const records=[fixture('park','City Park')];
  const request={...input('Find a place'),discovery:{goal:'discover' as const,categoryID:'parks' as const,savedOnly:false}};
  const plain=selectDiscoveryCandidates(records,request).results[0];
  assert(plain);assert(plain.reasons.length);assert(!plain.reasons.some(reason=>reason.includes('in your interests')));
  const personal=selectDiscoveryCandidates(records,{...request,taste:{interests:['parks'],avoidBars:false}}).results[0];
  assert.equal(personal.score,plain.score);assert(personal.reasons.includes('You selected parks in your interests.'));
  const service=selectDiscoveryCandidates([fixture('care','Care Clinic',[],'healthcare')],{...input('Find a place'),discovery:{goal:'service',savedOnly:false}}).results;
  assert.equal(service.length,1);assert(service[0].reasons.length);assert(!service[0].reasons.some(reason=>reason.includes('in your interests')));
  const planned=buildPlanningDraft(places,input('Find a place for each activity'),planning);
  assert(planned.plan.stages.every(stage=>!stage.reason.includes('in your interests')));
});

test('administrative source tags cannot turn boilerplate into a venue preference',()=>{
  const base=[fixture('plain','Corner Cafe',[],'cafes'),fixture('tagged','Corner Cafe',[],'cafes')];
  const withMetadata=[base[0],{...base[1],tags:['LISTING—SOURCED','Official branch source','access-unverified']}];
  const intent='Find cafes. Use sourced places; show the official branch source and unverified access.';
  const plain=rankPlaces(base,{intent,scope:'hyderabad'}).results;
  const ranked=rankPlaces(withMetadata,{intent,scope:'hyderabad'}).results;
  assert.deepEqual(ranked.map(item=>({id:item.place.id,score:item.score,reasons:item.reasons})),
    plain.map(item=>({id:item.place.id,score:item.score,reasons:item.reasons})));
  assert.deepEqual(ranked.find(item=>item.place.id==='tagged')!.place.tags,withMetadata[1].tags,'Source metadata remains available in the public record.');
});

test('metadata does not affect tag feedback or diversity while real preferences remain',()=>{
  const records=[fixture('a','Corner A',['Coffee'],'cafes'),fixture('b','Corner B',['Tea'],'cafes'),fixture('c','Corner C',['Coffee','Tea'],'cafes')];
  const decorated=records.map((place,index)=>({...place,tags:[...place.tags,...(index===1?['Listing-sourced']:['Listing-sourced','Official branch source','access-unverified'])]}));
  const preferences={intent:'Find cafes',scope:'hyderabad',positiveTags:['Coffee'],negativeTags:['Tea'],savedIDs:['b'],likedIDs:['c']};
  const shape=(rows:ReturnType<typeof rankPlaces>['results'])=>rows.map(item=>({id:item.place.id,score:item.score,reasons:item.reasons}));
  const expected=rankPlaces(records,preferences).results;
  assert.deepEqual(shape(rankPlaces(decorated,preferences).results),shape(expected));
  assert.deepEqual(shape(rankPlaces(decorated,{...preferences,positiveTags:['Coffee','Listing-sourced'],negativeTags:['Tea','access-unverified']}).results),shape(expected));
  assert(expected.some(item=>item.reasons.includes('Matches tags you explicitly prefer.')));
  assert(expected.some(item=>item.reasons.includes('Some source tags overlap your dislikes; ranked lower.')));
  assert(expected.find(item=>item.place.id==='b')!.reasons.includes('Already in your saved places.'));
  assert(expected.find(item=>item.place.id==='c')!.reasons.includes('You explicitly liked this place.'));
  const variety=[fixture('a','Corner',['Coffee'],'cafes'),fixture('b','Corner',['Coffee'],'cafes'),fixture('c','Corner',['Tea'],'cafes')];
  const administrative=['Listing-sourced','Official branch source','access-unverified'];
  const padded=variety.map(place=>({...place,tags:[...place.tags,...(place.id==='b'?[]:administrative)]}));
  const neutral={intent:'Find cafes',scope:'hyderabad'};
  assert.deepEqual(rankPlaces(variety,neutral).results.map(item=>item.place.id),['a','c','b']);
  assert.deepEqual(shape(rankPlaces(padded,neutral).results),shape(rankPlaces(variety,neutral).results),'Provenance labels cannot count as shared venue characteristics in diversity.');
  const usefulListing=[fixture('pet','Corner',['Pet-friendly listing'],'cafes')];
  assert.deepEqual(shape(rankPlaces(usefulListing,{...neutral,positiveTags:administrative,negativeTags:administrative}).results),shape(rankPlaces(usefulListing,neutral).results),'Administrative feedback is ignored as a complete label, not split into a preference for the word listing.');
});

test('source words in real venue names and useful tags remain semantic evidence',()=>{
  const records=[fixture('a','Corner Cafe',[],'cafes'),fixture('source','Source Cafe',['Pet-friendly listing','Coffee'],'cafes')];
  const named=rankPlaces(records,{intent:'Find Source Cafe',scope:'hyderabad'}).results;
  assert.equal(named[0].place.id,'source');assert(named[0].reasons.includes('The place name matches your request.'));
  const pets=rankPlaces(records,{intent:'Find pet-friendly coffee',scope:'hyderabad'}).results;
  assert.equal(pets[0].place.id,'source');
  assert(pets[0].reasons.some(reason=>reason.includes('Pet-friendly listing')));
  assert(pets[0].reasons.some(reason=>reason.includes('Coffee')));
});

test('the actual shared KBR outing chooses a mapped cafe without a provenance-label bonus',()=>{
  const brief=planningSchema.parse({stages:[{id:'stop-1',categoryID:'parks',pinnedPlaceID:'kbr-national-park'},{id:'stop-2',categoryID:'cafes'}],
    note:'Unverified inspiration: KBR National Park — Shared outing ABCD1234'});
  const base='Plan a visit to KBR National Park, then cafés, around Jubilee Hills / Banjara Hills edge. Keep KBR National Park first.';
  const suffix='\n\nMy saved note (unverified inspiration):\nKBR National Park — Shared outing ABCD1234';
  const run=(prompt:string)=>buildPlanningDraft(places,{...input(prompt),savedIDs:['kbr-national-park']},brief);
  const actual=run(base+' Use sourced places and flag anything that needs checking.'+suffix);
  const withoutBoilerplate=run(base+suffix);
  assert.deepEqual(actual.plan,withoutBoilerplate.plan);
  assert.equal(actual.plan.stages[0].placeID,'kbr-national-park');
  assert.equal(actual.plan.status,'complete');
  assert.equal(actual.plan.proximity?.unknownLegCount,0);
  assert.equal(actual.plan.proximity?.knownLegCount,1);
  assert(actual.selected.every(item=>planningCoordinate(item.place)!==null));
  assert(actual.selected.every(item=>!item.reasons.some(reason=>reason.includes('Listing-sourced'))));
  const tiger=places.find(place=>place.id==='tiger-lily-bistro-jubilee-hills')!;
  assert.equal(planningCoordinate(tiger),null,'Do not invent or copy a map point to make the test pass.');
  const neutralScore=rankPlaces([tiger],{intent:'Find cafes',scope:'hyderabad'}).results[0].score;
  assert.equal(rankPlaces([tiger],{intent:'Find cafes. Use sourced places and flag anything that needs checking.',scope:'hyderabad'}).results[0].score,neutralScore);
});
