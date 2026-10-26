import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {planningSchema,planSchema,buildPlanningDraft,allocatePlanningStages,planningReply,type PlanningRequest} from '../src/modules/ai-planning.js';
import {discoverySchema,selectDiscoveryCandidates,type DiscoveryBrief} from '../src/modules/ai-discovery.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
import type {RankedPlace} from '../src/modules/recommender.js';
process.env.PUBLIC_URL??='http://localhost:3000';process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {aiRequestSchema,validatedAnswerStream}=await import('../src/modules/ai.js');
const p=(id:string,category='cafes',tags:string[]=[],neighborhood='Jubilee Hills'):CatalogPlace=>({id,name:`Place ${id}`,category,tags,neighborhood,address:neighborhood,summary:'Sourced public listing',sourceURLs:['https://source.org/'+id],researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});
const input=(extra:Partial<DiscoveryBrief>={},scope='hyderabad',prompt='Help plan this time out')=>({messages:[{role:'user' as const,content:prompt}],scope,taste:{interests:[],avoidBars:false},savedIDs:[] as string[],discovery:{goal:'outing' as const,savedOnly:false,...extra}});
const brief=(categories=['cafes','parks']):PlanningRequest=>planningSchema.parse({stages:categories.map((categoryID,index)=>({id:'stop-'+(index+1),categoryID}))});
const ranked=(place:CatalogPlace):RankedPlace=>({place,score:1,reasons:['Sourced category match.'],cautions:[]});
const mapped=(id:string,category:string,longitude:number,tags:string[]=[]):CatalogPlace=>({...p(id,category,tags),latitude:17.4,longitude,
 coordinateSource:'Wikidata',coordinateKind:'coordinate_location',sourceURLs:['https://www.wikidata.org/wiki/Q123']});

test('planning is additive, bounded and restricted to explicit leisure stages',()=>{
 const old={messages:[{role:'user',content:'Coffee'}]};assert.equal(aiRequestSchema.parse(old).planning,undefined);
 assert.equal(aiRequestSchema.parse({...old,planning:brief()}).planning?.stages.length,2);
 assert.equal(brief().company,'any');assert(brief(['cafes','cafes']));
 for(const invalid of [
  {stages:[{id:'1',categoryID:'cafes'}]},
  {stages:[{id:'1',categoryID:'cafes'},{id:'1',categoryID:'parks'}]},
  {stages:[{id:'1',categoryID:'doctors'},{id:'2',categoryID:'cafes'}]},
  {...brief(),stages:Array.from({length:5},(_,i)=>({id:String(i),categoryID:'cafes'}))},
  {...brief(),budgetPerPersonINR:0},{...brief(),durationMinutes:1},{...brief(),note:'x'.repeat(501)},
  {...brief(),company:'guaranteed family safe'},{...brief(),stages:[{id:'1',categoryID:'cafes',scope:'invented'},{id:'2',categoryID:'parks'}]},
 ])assert.throws(()=>planningSchema.parse(invalid));
});
test('selected IDs are a unique1–8 hard intersection independent from saved taste IDs',()=>{
 for(const selectedPlaceIDs of [[],['a','a'],[''],Array.from({length:9},(_,i)=>String(i))])assert.throws(()=>discoverySchema.parse({goal:'discover',selectedPlaceIDs}));
 const places=[p('a'),p('b'),p('c')];const request={...input({selectedPlaceIDs:['b']}),savedIDs:['a','c']};
 assert.deepEqual(selectDiscoveryCandidates(places,request).results.map(item=>item.place.id),['b']);
 assert.equal(selectDiscoveryCandidates(places,{...request,discovery:{...request.discovery,savedOnly:true}}).results.length,0);
 assert.equal(selectDiscoveryCandidates(places,input({selectedPlaceIDs:['missing']})).results.length,0);
});
test('two stages retain order and sourced coverage independent of model prose',()=>{
 const result=buildPlanningDraft([p('park','parks'),p('coffee')],input(),brief());
 assert.equal(result.plan.status,'complete');assert.deepEqual(result.plan.stages.map(stage=>stage.placeID),['coffee','park']);
 const reply=planningReply(result.plan,{answer:'Here is the draft.',followUp:null});
 assert.deepEqual(reply.recommendations.map(card=>card.placeID),['coffee','park']);assert(planSchema.parse(reply.plan));
 assert(reply.plan.checks.some(check=>check.includes('not a calculated')));
});
test('allocation reassigns shared first choice to cover a scarce later stage',()=>{
 const a=ranked(p('a')),b=ranked(p('b'));
 const result=allocatePlanningStages([[a,b],[a]]);
 assert.deepEqual(result.map(item=>item?.place.id),['b','a']);
 assert.deepEqual(allocatePlanningStages([[a,b],[a]]).map(item=>item?.place.id),['b','a']);
});
test('bounded allocation matches exhaustive maximum coverage and rank cost across varied overlaps',()=>{
 let seed=1493;
 const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 for(let trial=0;trial<64;trial++){
  const pools=Array.from({length:4},()=>Array.from({length:5},(_,i)=>ranked(p(String(i)))).filter(()=>random()>.45));
  const ids=[...new Set(pools.flatMap(pool=>pool.map(item=>item.place.id)))].sort();
  let bestCount=-1,bestCost=Infinity;
  const visit=(stage:number,used:Set<string>,cost:number)=>{
   if(stage===pools.length){if(used.size>bestCount||(used.size===bestCount&&cost<bestCost)){bestCount=used.size;bestCost=cost;}return;}
   visit(stage+1,used,cost);
   pools[stage].forEach((item,rank)=>{if(!used.has(item.place.id)){used.add(item.place.id);visit(stage+1,used,cost+rank*1000+ids.indexOf(item.place.id));used.delete(item.place.id);}});
  };
  visit(0,new Set(),0);
  const actual=allocatePlanningStages(pools);assert.equal(actual.filter(Boolean).length,bestCount);
  const cost=actual.reduce((sum,item,stage)=>sum+(item?pools[stage].findIndex(candidate=>candidate.place.id===item.place.id)*1000+ids.indexOf(item.place.id):0),0);
  assert.equal(cost,bestCost);
 }
});
test('repeated categories require distinct places and missing stages remain explicit',()=>{
 const full=buildPlanningDraft([p('a'),p('b')],input(),brief(['cafes','cafes']));
 assert.equal(full.plan.status,'complete');assert.equal(new Set(full.plan.stages.map(stage=>stage.placeID)).size,2);
 const partial=buildPlanningDraft([p('a')],input(),brief(['cafes','cafes']));
 assert.equal(partial.plan.status,'partial');assert.equal(partial.plan.stages.filter(stage=>stage.placeID===null).length,1);
 assert.equal(planningReply(partial.plan).recommendations.length,1);
 const empty=buildPlanningDraft([],input(),brief());assert.equal(empty.plan.status,'empty');assert.deepEqual(planningReply(empty.plan).recommendations,[]);
});
test('stage areas narrow the global scope and never create cross-area substitutions',()=>{
 const request=planningSchema.parse({stages:[{id:'coffee',categoryID:'cafes',scope:'jubilee_hills'},{id:'meal',categoryID:'food',scope:'kokapet'}]});
 const records=[p('cafe-j'),p('cafe-k','cafes',[],'Kokapet'),p('food-j','food'),p('food-k','food',[],'Kokapet')];
 assert.deepEqual(buildPlanningDraft(records,input(),request).plan.stages.map(stage=>stage.placeID),['cafe-j','food-k']);
 const narrow=buildPlanningDraft(records,input({},'jubilee_hills'),request);
 assert.equal(narrow.plan.status,'partial');assert.deepEqual(narrow.plan.stages.map(stage=>stage.placeID),['cafe-j',null]);
});
test('global directory saved-only selected IDs and feedback all constrain stage candidates',()=>{
 const records=[p('cafe'),p('other'),p('park','parks')];
 const selected=buildPlanningDraft(records,{...input({savedOnly:true,selectedPlaceIDs:['cafe','park']}),savedIDs:['cafe','other','park']},brief(),{dismissedIDs:['park']});
 assert.deepEqual(selected.plan.stages.map(stage=>stage.placeID),['cafe',null]);
 const directory=buildPlanningDraft(records,input({categoryID:'cafes'}),brief());
 assert.deepEqual(directory.plan.stages.map(stage=>stage.placeID),['cafe',null]);
});
test('no-bars taste and explicit planning note remain hard before allocation',()=>{
 const records=[p('bar','cafes',['bar']),p('park','parks')];
 const hard={...input(),taste:{interests:[],avoidBars:true}};
 assert.equal(buildPlanningDraft(records,hard,brief()).plan.stages[0].placeID,null);
 const note=planningSchema.parse({...brief(),note:'No bars'});
 assert.equal(buildPlanningDraft(records,input(),note).plan.stages[0].placeID,null);
});
test('only sourced active leisure venues can become plan stops',()=>{
 const records=[{...p('no-source'),sourceURLs:[]},{...p('closed'),status:'closed'},p('osm-1'),p('care','cafes',['doctor']),p('gym','sports',['gym']),p('park','parks')];
 const result=buildPlanningDraft(records,input(),brief());
 assert.deepEqual(result.plan.stages.map(stage=>stage.placeID),[null,'park']);
 assert.equal(buildPlanningDraft(records,input(),brief(['sports','parks'])).plan.stages[0].placeID,null);
});
test('hard unverified facts keep stages empty until explicit relaxation; budgets are preferences only',()=>{
 const records=[p('coffee'),p('park','parks')];
 const request=input({},'hyderabad','Only wheelchair accessible places');
 const denied=buildPlanningDraft(records,request,brief());assert.equal(denied.plan.status,'empty');
 const relaxed={...request,messages:[...request.messages,{role:'user' as const,content:'Show listings with unverified facts'}]};
 const preferences=planningSchema.parse({...brief(),budgetPerPersonINR:500,durationMinutes:120,company:'friends',note:'An afternoon together'});
 const result=buildPlanningDraft(records,relaxed,preferences);
 assert.equal(result.plan.status,'complete');assert(result.plan.checks.some(check=>check.includes('no total cost')));
 assert(result.plan.checks.some(check=>check.includes('no schedule')));assert(result.plan.checks.some(check=>check.includes('group capacity')));
});
test('server-owned plan is retained in a private, complete SSE reply without model output',async()=>{
 const draft=buildPlanningDraft([p('coffee'),p('park','parks')],input(),brief()).plan;
 const app=new Hono();app.get('/plan',c=>validatedAnswerStream(c,planningReply(draft)));
 const response=await app.request('/plan');assert.equal(response.headers.get('cache-control'),'private, no-store');
 const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6));
 const reply=JSON.parse(JSON.parse(events[0]).choices[0].delta.content);
 assert.deepEqual(reply.plan,draft);assert.deepEqual(reply.recommendations.map((card:{placeID:string})=>card.placeID),['coffee','park']);
 assert.equal(JSON.parse(events[1]).choices[0].finish_reason,'stop');assert.equal(events[2],'[DONE]');
});

test('stage pins are additive, bounded and unique after identifier normalization',()=>{
 const legacy=brief();assert.equal(legacy.stages[0].pinnedPlaceID,undefined);
 const withPin=(id:unknown)=>({...legacy,stages:[{...legacy.stages[0],pinnedPlaceID:id},legacy.stages[1]]});
 assert.equal(planningSchema.parse(withPin(' coffee ')).stages[0].pinnedPlaceID,'coffee');
 for(const id of ['', ' ', 'x'.repeat(161), null, 42])assert.throws(()=>planningSchema.parse(withPin(id)));
 assert.throws(()=>planningSchema.parse({...legacy,stages:legacy.stages.map(stage=>({...stage,pinnedPlaceID:'same'}))}));
 assert.throws(()=>planningSchema.parse({...legacy,stages:[{...legacy.stages[0],pinnedPlaceID:'same'}, {...legacy.stages[1],pinnedPlaceID:' same '}]}));
 assert.equal(aiRequestSchema.parse({messages:[{role:'user',content:'Keep my first stop'}],planning:withPin('coffee')}).planning?.stages[0].pinnedPlaceID,'coffee');
});

test('an eligible pin stays exact even outside the normal candidate rank limit',()=>{
 const request=planningSchema.parse({...brief(),stages:[{id:'stop-1',categoryID:'cafes',pinnedPlaceID:'z-pin'},{id:'stop-2',categoryID:'parks'}]});
 const records=[...Array.from({length:80},(_,index)=>p('a-'+index.toString().padStart(2,'0'))),p('z-pin'),p('park','parks')];
 assert(!selectDiscoveryCandidates(records,input({categoryID:'cafes'})).results.some(item=>item.place.id==='z-pin'));
 const result=buildPlanningDraft(records,input(),request);
 assert.deepEqual(result.plan.stages.map(stage=>stage.placeID),['z-pin','park']);assert.equal(result.plan.status,'complete');
 assert(result.plan.stages[0].reason.startsWith('Kept your pinned place.'));
 assert.deepEqual(planningReply(result.plan).recommendations.map(card=>card.placeID),['z-pin','park']);
});

test('pinned stage failures never substitute another venue across all hard gates',()=>{
 const pinned=planningSchema.parse({...brief(),stages:[{id:'stop-1',categoryID:'cafes',pinnedPlaceID:'pin'},{id:'stop-2',categoryID:'parks'}]});
 const park=p('park','parks'),alternative=p('alternative');
 const cases:[string,CatalogPlace[],ReturnType<typeof input>,PlanningRequest,{dismissedIDs?:string[]}][]=[
  ['missing',[alternative,park],input(),pinned,{}],
  ['category',[p('pin','food'),alternative,park],input(),pinned,{}],
  ['source',[{...p('pin'),sourceURLs:[]},alternative,park],input(),pinned,{}],
  ['inactive',[{...p('pin'),status:'closed'},alternative,park],input(),pinned,{}],
  ['global area',[p('pin','cafes',[],'Kokapet'),alternative,park],input({},'jubilee_hills'),pinned,{}],
  ['stage area',[p('pin','cafes',[],'Kokapet'),alternative,park],input(),{...pinned,stages:[{...pinned.stages[0],scope:'jubilee_hills'},pinned.stages[1]]},{}],
  ['area exclusion',[p('pin','cafes',[],'Kokapet'),alternative,park],input({},'hyderabad','No places in Kokapet'),pinned,{}],
  ['taste no-bars',[p('pin','cafes',['bar']),alternative,park],{...input(),taste:{interests:[],avoidBars:true}},pinned,{}],
  ['saved-only',[p('pin'),alternative,park],{...input({savedOnly:true}),savedIDs:['alternative','park']},pinned,{}],
  ['selected IDs',[p('pin'),alternative,park],input({selectedPlaceIDs:['alternative','park']}),pinned,{}],
  ['global directory',[p('pin'),alternative,park],input({categoryID:'parks'}),pinned,{}],
  ['query',[p('pin'),alternative,park],input({query:'alternative'}),pinned,{}],
  ['dismissed',[p('pin'),alternative,park],input(),pinned,{dismissedIDs:['pin']}],
  ['verified facts',[p('pin'),alternative,park],input({},'hyderabad','Only wheelchair accessible places'),pinned,{}],
  ['planning note',[p('pin','cafes',['bar']),alternative,park],input(),{...pinned,note:'No bars'},{}],
 ];
 for(const [name,records,request,planning,feedback] of cases){
  const result=buildPlanningDraft(records,request,planning,feedback);
  assert.equal(result.plan.stages[0].placeID,null,name);assert.match(result.plan.stages[0].reason,/pinned place/i,name);
  assert(!planningReply(result.plan).recommendations.some(card=>card.placeID==='pin'),name);
  assert.notEqual(result.plan.status,'complete',name);
 }
});

test('repeated categories reserve pins and residual assignment still covers scarce stages',()=>{
 const request=planningSchema.parse({stages:[{id:'first',categoryID:'cafes',pinnedPlaceID:'a'},{id:'second',categoryID:'cafes'},{id:'third',categoryID:'parks'}]});
 const records=[p('a'),p('b','cafes',['park']),p('c')];
 const result=buildPlanningDraft(records,input(),request);
 assert.deepEqual(result.plan.stages.map(stage=>stage.placeID),['a','c','b']);
 assert.equal(result.plan.status,'complete');assert.equal(new Set(result.selected.map(item=>item.place.id)).size,3);
 assert(result.pools.slice(1).every(pool=>pool.results.every(item=>item.place.id!=='a')));
 assert.deepEqual(buildPlanningDraft([...records].reverse(),input(),request).plan,result.plan);
});

test('an ineligible pin is not reassigned to another stage; unpinning is explicit',()=>{
 const pinned=planningSchema.parse({...brief(),stages:[{id:'stop-1',categoryID:'cafes',pinnedPlaceID:'park'},{id:'stop-2',categoryID:'parks'}]});
 const records=[p('coffee'),p('park','parks')];
 assert.deepEqual(buildPlanningDraft(records,input(),pinned).plan.stages.map(stage=>stage.placeID),[null,null]);
 assert.deepEqual(buildPlanningDraft(records,input(),brief()).plan.stages.map(stage=>stage.placeID),['coffee','park']);
 const full=planningSchema.parse({...brief(),stages:[{id:'stop-1',categoryID:'cafes',pinnedPlaceID:'coffee'},{id:'stop-2',categoryID:'parks',pinnedPlaceID:'park'}]});
 assert.deepEqual(buildPlanningDraft(records,input(),full).plan.stages.map(stage=>stage.placeID),['coffee','park']);
});

test('stage replacement exclusions are bounded unique and cannot contradict a pin',()=>{
 const original=brief();
 const excluding=(excludedPlaceIDs:unknown,pinnedPlaceID?:string)=>({...original,stages:[{...original.stages[0],excludedPlaceIDs,pinnedPlaceID},original.stages[1]]});
 assert.deepEqual(planningSchema.parse(excluding([])).stages[0].excludedPlaceIDs,[]);
 assert.deepEqual(planningSchema.parse(excluding([' coffee '])).stages[0].excludedPlaceIDs,['coffee']);
 assert.equal(planningSchema.parse(excluding(Array.from({length:12},(_,i)=>String(i)))).stages[0].excludedPlaceIDs?.length,12);
 for(const ids of [[''],[' '],['x'.repeat(161)],['a','a'],['a',' a '],Array.from({length:13},(_,i)=>String(i)),null])assert.throws(()=>planningSchema.parse(excluding(ids)));
 assert.throws(()=>planningSchema.parse(excluding(['coffee'],' coffee ')));
});

test('find another excludes only its stage while preserving other eligible pinned stops',()=>{
 const original=planningSchema.parse({stages:[{id:'first',categoryID:'cafes',pinnedPlaceID:'a'},{id:'second',categoryID:'cafes',pinnedPlaceID:'b'}]});
 const records=[p('a'),p('b'),p('c')];
 assert.deepEqual(buildPlanningDraft(records,input(),original).plan.stages.map(stage=>stage.placeID),['a','b']);
 const replace=planningSchema.parse({...original,stages:[{id:'first',categoryID:'cafes',excludedPlaceIDs:['a']},original.stages[1]]});
 assert.deepEqual(buildPlanningDraft(records,input(),replace).plan.stages.map(stage=>stage.placeID),['c','b']);
 assert.deepEqual(buildPlanningDraft(records.slice(0,2),input(),replace).plan.stages.map(stage=>stage.placeID),[null,'b']);
 const stageLocal=planningSchema.parse({stages:[{id:'first',categoryID:'cafes',excludedPlaceIDs:['a']},{id:'second',categoryID:'cafes',excludedPlaceIDs:['b']}]});
 assert.deepEqual(buildPlanningDraft(records.slice(0,2),input(),stageLocal).plan.stages.map(stage=>stage.placeID),['b','a']);
});

test('profile brief JSON retains stage pins and replacement exclusions',async()=>{
 const {profileSchema,normalizeProfile,prepareProfileUpdate}=await import('../src/modules/consumer.js');
 const planning=planningSchema.parse({stages:[{id:'coffee',categoryID:'cafes',pinnedPlaceID:'coffee',excludedPlaceIDs:['old-coffee']},{id:'park',categoryID:'parks',excludedPlaceIDs:['old-park']}]});
 const profile=profileSchema.parse({savedIDs:[],taste:{interests:[],pace:'Unhurried',avoidBars:false},outings:[{id:'e5aab24c-865a-4139-b629-38ce6aa87784',title:'Refined draft',placeIDs:['coffee','park'],createdAt:1791580800000,brief:planning}]});
 const validIDs=new Set(['coffee','park']);
 const stored=JSON.parse(JSON.stringify(normalizeProfile(profile,validIDs)));
 assert.deepEqual(stored.outings[0].brief,planning);
 const legacy=JSON.parse(JSON.stringify(stored));delete legacy.outings[0].brief;
 assert.deepEqual(prepareProfileUpdate(profileSchema.parse(legacy),{revision:4,body:stored},4,validIDs).outings[0].brief,planning);
});

test('nearby is the additive default; explicit relevance keeps the ranked baseline and omits geography',()=>{
 const stages=[{id:'coffee',categoryID:'cafes'},{id:'park',categoryID:'parks'}];
 const nearby=planningSchema.parse({stages}),relevance=planningSchema.parse({stages,selectionMode:'relevance'});
 assert.equal(nearby.selectionMode,'nearby');assert.throws(()=>planningSchema.parse({stages,selectionMode:'fastest-route'}));
 assert.equal(aiRequestSchema.parse({...input(),planning:{stages}}).planning?.selectionMode,'nearby');
 const records=[mapped('a-far','cafes',78.65),mapped('b-near','cafes',78.41),mapped('park','parks',78.4)];
 const closer=buildPlanningDraft(records,input(),nearby),preferred=buildPlanningDraft(records,input(),relevance);
 assert.deepEqual(closer.plan.stages.map(stage=>stage.placeID),['b-near','park']);
 assert.deepEqual(preferred.plan.stages.map(stage=>stage.placeID),['a-far','park']);assert.equal(preferred.plan.proximity,undefined);
 assert.deepEqual(closer.plan.stages.map(stage=>stage.id),['coffee','park']);assert.equal(closer.plan.status,'complete');
 assert.equal(closer.plan.proximity?.state,'grouped');assert.equal(closer.plan.proximity?.knownLegCount,1);assert.equal(closer.plan.proximity?.unknownLegCount,0);
 assert(closer.plan.proximity!.straightLineMetres!>1000&&closer.plan.proximity!.straightLineMetres!<1200);
 assert.deepEqual(planningReply(closer.plan).recommendations.map(item=>item.placeID),['b-near','park']);
 assert(closer.plan.checks.some(check=>check.includes('not a calculated or optimized route')));
});

test('nearby candidate assignment respects explicit pins, named venues and selected-place hard filters',()=>{
 const far=mapped('a-far','cafes',78.65),near=mapped('b-near','cafes',78.401),park=mapped('park','parks',78.4);
 const records=[far,near,park],planning=brief();
 const pinned=planningSchema.parse({...planning,stages:[{...planning.stages[0],pinnedPlaceID:far.id},planning.stages[1]]});
 assert.deepEqual(buildPlanningDraft(records,input(),pinned).plan.stages.map(stage=>stage.placeID),[far.id,park.id]);
 assert.deepEqual(buildPlanningDraft(records,input({},'hyderabad',`Start at ${far.name}, then visit a park.`),planning).plan.stages.map(stage=>stage.placeID),[far.id,park.id]);
 const restricted=buildPlanningDraft(records,input({selectedPlaceIDs:[far.id,park.id]}),planning);
 assert.deepEqual(restricted.plan.stages.map(stage=>stage.placeID),[far.id,park.id]);assert.equal(restricted.plan.proximity?.state,'retained');
 const replace=planningSchema.parse({...planning,stages:[{...planning.stages[0],excludedPlaceIDs:[near.id]},planning.stages[1]]});
 assert.deepEqual(buildPlanningDraft(records,input(),replace).plan.stages.map(stage=>stage.placeID),[far.id,park.id]);
});

test('generic park planning excludes sourced specialist attractions before proximity and never substitutes an ineligible pin',()=>{
 const cafe=mapped('cafe','cafes',78.4),kbr=mapped('kbr','nature',78.42,['national park']);
 const memorial=mapped('a-memorial','parks',78.4001,['memorial garden']);
 const zoo=mapped('a-zoo','parks',78.4002,['zoological park']);
 const waterpark=mapped('a-waterpark','parks',78.4003,['water park']);
 const records=[cafe,memorial,zoo,waterpark,kbr],planning=brief();
 const result=buildPlanningDraft(records,input(),planning);
 assert.deepEqual(result.plan.stages.map(stage=>stage.placeID),[cafe.id,kbr.id]);
 assert.deepEqual(result.pools[1].results.map(item=>item.place.id),[kbr.id]);
 const pinned=planningSchema.parse({...planning,stages:[planning.stages[0],{...planning.stages[1],pinnedPlaceID:memorial.id}]});
 const unavailable=buildPlanningDraft(records,input(),pinned);
 assert.deepEqual(unavailable.plan.stages.map(stage=>stage.placeID),[cafe.id,null]);assert.equal(unavailable.plan.status,'partial');
 assert.equal(unavailable.plan.proximity?.state,'unavailable');assert.equal(unavailable.plan.proximity?.straightLineMetres,undefined);
 assert.equal(unavailable.plan.proximity?.unknownLegCount,1);assert.match(unavailable.plan.stages[1].reason,/no replacement was selected/);
});

test('partial and empty drafts report every requested leg as known or unknown without a partial distance total',()=>{
 const records=[mapped('cafe','cafes',78.4),mapped('park','parks',78.41)];
 const result=buildPlanningDraft(records,input(),brief(['cafes','parks','parks']));
 assert.equal(result.plan.status,'partial');assert.equal(result.selected.length,2);
 assert.equal(result.plan.proximity?.state,'unavailable');assert.equal(result.plan.proximity?.straightLineMetres,undefined);
 assert.equal(result.plan.proximity!.knownLegCount+result.plan.proximity!.unknownLegCount,2);
 const missingLegs=result.plan.stages.slice(1).filter((stage,index)=>stage.placeID===null||result.plan.stages[index].placeID===null).length;
 assert(result.plan.proximity!.unknownLegCount>=missingLegs);
 const empty=buildPlanningDraft(records,input({},'hyderabad','Only wheelchair accessible places'),brief());
 assert.equal(empty.plan.status,'empty');assert.equal(empty.plan.proximity?.knownLegCount,0);assert.equal(empty.plan.proximity?.unknownLegCount,1);
 assert.equal(empty.plan.proximity?.straightLineMetres,undefined);assert.deepEqual(planningReply(empty.plan).recommendations,[]);
});

test('plan proximity schema rejects contradictory coverage and incomplete totals while retaining legacy replies',()=>{
 const plan=buildPlanningDraft([mapped('cafe','cafes',78.4),mapped('park','parks',78.41)],input(),brief()).plan;
 const complete={state:'retained',knownLegCount:1,unknownLegCount:0,straightLineMetres:1000,summary:'Published feature positions only.'};
 assert(planSchema.parse({...plan,proximity:complete}));assert(planSchema.parse({...plan,proximity:{...complete,straightLineMetres:0}}));
 const {proximity:_,...legacy}=plan;assert(planSchema.parse(legacy));
 for(const proximity of [
  {...complete,knownLegCount:0},{...complete,knownLegCount:4},{...complete,knownLegCount:-1},{...complete,knownLegCount:0.5},
  {...complete,knownLegCount:Number.MAX_SAFE_INTEGER,unknownLegCount:1},{...complete,state:'unavailable'},
  {...complete,straightLineMetres:undefined},{...complete,straightLineMetres:-1},{...complete,straightLineMetres:500001},
  {...complete,knownLegCount:0,unknownLegCount:1},{...complete,knownLegCount:0,unknownLegCount:1,state:'grouped'},
  {...complete,knownLegCount:0,unknownLegCount:1,state:'unavailable'},{...complete,summary:'   '},
 ])assert.throws(()=>planSchema.parse({...plan,proximity}),JSON.stringify(proximity));
 const missing={...plan,status:'partial',stages:[plan.stages[0],{...plan.stages[1],placeID:null}]};
 assert.throws(()=>planSchema.parse({...missing,proximity:{...complete,state:'grouped'}}));
 assert(planSchema.parse({...missing,proximity:{state:'unavailable',knownLegCount:0,unknownLegCount:1,summary:'The second stop has no match.'}}));
 const middleGap={...plan,status:'partial',stages:[plan.stages[0],{id:'missing',categoryID:'art',placeID:null,reason:'No match'},plan.stages[1]]};
 assert.throws(()=>planSchema.parse({...middleGap,proximity:{state:'unavailable',knownLegCount:1,unknownLegCount:1,summary:'Incorrectly bridged gap.'}}));
 assert(planSchema.parse({...middleGap,proximity:{state:'unavailable',knownLegCount:0,unknownLegCount:2,summary:'Both requested legs include the missing stop.'}}));
});

test('profile brief stores explicit relevance mode through JSON and legacy omission updates',async()=>{
 const {profileSchema,normalizeProfile,prepareProfileUpdate}=await import('../src/modules/consumer.js');
 const planning=planningSchema.parse({...brief(),selectionMode:'relevance'});
 const profile=profileSchema.parse({savedIDs:[],taste:{interests:[],pace:'Unhurried',avoidBars:false},outings:[{
  id:'80f25ad6-0a38-48d8-a65b-4b06873d9d03',title:'Preferences first',placeIDs:['cafe','park'],createdAt:1791580800000,brief:planning}]});
 const allowed=new Set(['cafe','park']),stored=JSON.parse(JSON.stringify(normalizeProfile(profile,allowed)));
 assert.equal(stored.outings[0].brief.selectionMode,'relevance');
 const legacy=JSON.parse(JSON.stringify(stored));delete legacy.outings[0].brief;
 assert.equal(prepareProfileUpdate(profileSchema.parse(legacy),{revision:7,body:stored},7,allowed).outings[0].brief?.selectionMode,'relevance');
});
