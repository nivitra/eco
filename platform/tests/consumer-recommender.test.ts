import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {rankPlaces,recommendationScope,belongsToArea} from '../src/modules/recommender.js';
const raw=await readFile(new URL('../data/places.json',import.meta.url),'utf8');
const places=JSON.parse(raw).map((p:any)=>({...p,status:'research',revision:1}));
const scenarios=JSON.parse(await readFile(new URL('../data/recommendation-scenarios.json',import.meta.url),'utf8'));
const allIDs=new Set(places.map((p:any)=>p.id));

test('23 curated scenarios: category coverage, real IDs, scope and no-bars gates',async()=>{
 const records=scenarios.map((scenario:any)=>{
  const ranked=rankPlaces(places,{intent:scenario.prompt,limit:5});
  const categories=new Set(ranked.results.map(r=>r.place.category));
  const categoryCoverage=scenario.expectedCategories.every((c:string)=>categories.has(c)||(c==='nature'&&categories.has('parks')));
  const validIDs=ranked.results.every(r=>allIDs.has(r.place.id));
  const scopePass=ranked.scope!=='jubilee_hills'||ranked.results.every(r=>r.place.neighborhood.toLowerCase().includes('jubilee hills')&&!r.place.neighborhood.toLowerCase().includes('outside jubilee'));
  const barsPass=!ranked.avoidBars||ranked.results.every(r=>r.place.category!=='nightlife'&&!/\b(bars?|pubs?|brewpub|brewery|brewing|cocktails?)\b/i.test([r.place.name,...r.place.tags].join(' ')));
  assert(categoryCoverage,`${scenario.id}: missing expected category`);assert(validIDs&&scopePass&&barsPass,`${scenario.id}: hard gate violation`);
  return {id:scenario.id,expectedCategories:scenario.expectedCategories,resultIDs:ranked.results.map(r=>r.place.id),categoryCoverage,validIDs,scopePass,barsPass,cautions:ranked.results[0]?.cautions??[]};
 });
 const report={evaluatedAt:new Date().toISOString(),policy:'intent-evidence-diversity-1',catalogSHA256:createHash('sha256').update(raw).digest('hex'),scenarios:23,passed:records.filter((r:any)=>r.categoryCoverage&&r.validIDs&&r.scopePass&&r.barsPass).length,method:'Deterministic fixture assertions, not a human preference or real-world success study',records};
 await writeFile(new URL('../docs/Recommendation-Evaluation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
});
test('explicit dismissals are hard exclusions; positive feedback and negative tags change ranking transparently',()=>{
 const base=rankPlaces(places,{intent:'coffee',limit:10});const first=base.results[0].place;
 const dismissed=rankPlaces(places,{intent:'coffee',dismissedIDs:[first.id],limit:10});assert(!dismissed.results.some(r=>r.place.id===first.id));assert(dismissed.exclusions.some(x=>x.placeID===first.id&&x.reasons.includes('explicitly_dismissed')));
 const saved=rankPlaces(places,{intent:'coffee',likedIDs:[first.id],limit:10}).results.find(r=>r.place.id===first.id)!;assert(saved.score>base.results[0].score);assert(saved.reasons.some(x=>x.includes('explicitly liked')));
 const negative=rankPlaces(places,{intent:'coffee',negativeTags:first.tags,limit:65}).results.find(r=>r.place.id===first.id)!;assert(negative.score<=base.results[0].score);
});
test('strict unknown hours returns no invented availability; closed records never rank',()=>{
 assert.equal(rankPlaces(places,{intent:'coffee open now',requireVerifiedOpen:true}).results.length,0);
 const closed=places.map((p:any)=>({...p,status:'closed'}));assert.equal(rankPlaces(closed,{}).results.length,0);
});
test('measured distance is optional and not represented as travel time; diversity and tie order stable',()=>{
 const missing=rankPlaces(places,{intent:'coffee'});assert(missing.results.every(r=>r.distanceMetres===undefined&&!r.reasons.some(x=>x.includes('metres away'))));
 const id=missing.results[0].place.id;const measured=rankPlaces(places,{intent:'coffee',distances:{[id]:123}}).results.find(r=>r.place.id===id)!;assert.equal(measured.distanceMetres,123);assert(measured.reasons.some(x=>x.includes('straight line')));
 const multi=rankPlaces(places,{intent:'art and coffee and nature in Jubilee Hills',limit:3});assert.equal(new Set(multi.results.map(r=>r.place.category)).size,3);
 assert.deepEqual(rankPlaces(places,{intent:'For you'}).results.map(r=>r.place.id),rankPlaces([...places].reverse(),{intent:'For you'}).results.map(r=>r.place.id));
});

test('adversarial negations cannot widen locality or reintroduce barred categories',()=>{
 for(const intent of ["I don't want bars",'not interested in nightlife','no noisy bars','Food and coffee, without any bars']){
   const r=rankPlaces(places,{intent,limit:20});assert(r.avoidBars,intent);assert(r.results.every(x=>x.place.category!=='nightlife'&&!/\b(bars?|pubs?|brewpub|brewery|brewing|cocktails?)\b/i.test([x.place.name,...x.place.tags].join(' '))),intent);
 }
 const local=rankPlaces(places,{intent:'stay in Jubilee, nothing outside Jubilee',scope:'hyderabad',limit:20});assert.equal(local.scope,'jubilee_hills');assert(local.results.every(x=>!x.place.neighborhood.toLowerCase().includes('outside')));
 const food=rankPlaces(places,{intent:'no cafes; dinner only',limit:20});assert(food.results.length>0);assert(food.results.every(x=>x.place.category==='food'));
 assert.equal(rankPlaces(places,{intent:'Explore outside Jubilee across Hyderabad',scope:'jubilee_hills'}).scope,'hyderabad');
});
test('dietary, access and budget requirements are unknown, never certified by category',()=>{
 for(const intent of ['vegan cafes','wheelchair accessible coffee','coffee under ₹500']){
   const r=rankPlaces(places,{intent});assert(r.results.length>0);assert(r.results.every(x=>x.cautions.some(y=>/unverified|cannot be guaranteed/.test(y))),intent);
 }
 assert.equal(rankPlaces(places,{intent:'Only wheelchair accessible cafes'}).results.length,0);
 assert.equal(rankPlaces(places,{intent:'Only vegan restaurants'}).results.length,0);
});


test('Kokapet and expanded categories honor explicit scopes, source labels and literal locality restrictions',()=>{
 const p={id:'park',name:'Test Park',category:'parks',neighborhood:'Kokapet area',address:'Kokapet',summary:'Source description',tags:[],sourceURLs:[],researchedAt:'',searchQuery:'',revision:1,status:'research'};
 const records=[p,{...p,id:'near',neighborhood:'Near Kokapet'},{...p,id:'outside',neighborhood:'Narsingi · outside Kokapet'},{...p,id:'demo',name:'Test Park (Demo)'},{...p,id:'jubilee',neighborhood:'Jubilee Hills area'}];
 assert.deepEqual(rankPlaces(records,{intent:'parks',scope:'kokapet'}).results.map(x=>x.place.id),['park']);
 assert.equal(recommendationScope('Stay in Kokapet, nothing outside Kokapet','hyderabad'),'kokapet');
 assert.equal(recommendationScope('Explore outside Kokapet across Hyderabad','kokapet'),'hyderabad');
 assert.equal(recommendationScope('Coffee in Kokapet','jubilee_hills'),'kokapet');
 assert.equal(recommendationScope('Jubilee Hills and Kokapet','kokapet'),'hyderabad');
 assert.equal(belongsToArea({...p,neighborhood:'Kokapetville'},'kokapet'),false);
 for(const [category,intent] of [['healthcare','hospitals'],['stationery','pens'],['community','libraries'],['parks','outdoors']]) {
   const r=rankPlaces([{...p,id:category,category}],{intent,scope:'kokapet'});assert.equal(r.results[0]?.place.id,category);
 }
});

test('negated area wins over two-area mentions while a positive cross-area trip still widens',()=>{
 const base={name:'Coffee',category:'cafes',address:'',summary:'Source',tags:[],sourceURLs:[],researchedAt:'',searchQuery:'',revision:1,status:'research'};
 const records=[{...base,id:'k',neighborhood:'Kokapet'},{...base,id:'j',neighborhood:'Jubilee Hills'},{...base,id:'city',neighborhood:'Old City'}];
 for(const intent of ['Cafes in Kokapet, not Jubilee Hills','Only Kokapet, no Jubilee Hills','Kokapet, excluding places in Jubilee Hills']) {
   const result=rankPlaces(records,{intent,scope:'hyderabad'});assert.equal(result.scope,'kokapet');assert.deepEqual(result.results.map(x=>x.place.id),['k']);
 }
 assert.deepEqual(rankPlaces(records,{intent:'Coffee in Jubilee Hills, not Kokapet',scope:'kokapet'}).results.map(x=>x.place.id),['j']);
 assert.deepEqual(rankPlaces(records,{intent:'No Kokapet and no Jubilee Hills',scope:'hyderabad'}).results.map(x=>x.place.id),['city']);
 assert.equal(recommendationScope('Kokapet to Jubilee Hills','kokapet'),'hyderabad');
 assert.equal(recommendationScope('No bars in Kokapet','kokapet'),'kokapet');
});
