import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planningCoordinate,selectNearbyPlanningStages} from '../src/modules/planning-geography.js';
import {allocatePlanningStages} from '../src/modules/ai-planning.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
import type {RankedPlace} from '../src/modules/recommender.js';

const venue=(id:string,latitude:number|undefined=17.4,longitude:number|undefined=78.4,score=30):RankedPlace=>({
  place:{id,name:`Venue ${id}`,category:'cafes',neighborhood:'Hyderabad',address:'Source-backed address',summary:'Public sourced venue',tags:[],
    sourceURLs:['https://www.wikidata.org/wiki/Q123'],researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research',
    latitude,longitude,coordinateSource:'Wikidata',coordinateKind:'coordinate_location'},score,reasons:['Sourced match'],cautions:[],
});
const unknown=(id:string,score=30)=>{const item=venue(id,17.4,78.4,score);delete item.place.latitude;delete item.place.longitude;return item;};
const ids=(items:readonly (RankedPlace|null)[])=>items.map(item=>item?.place.id??null);

test('equal-relevance geography groups known stops without changing stage order',()=>{
  const far=venue('far',17.4,78.65),near=venue('near',17.4,78.41),park=venue('park',17.4,78.4);
  const result=selectNearbyPlanningStages([[far,near],[park]],[far,park]);
  assert.deepEqual(ids(result.selected),['near','park']);assert.equal(result.diagnostics.applied,true);
  assert.equal(result.diagnostics.state,'grouped');assert.equal(result.diagnostics.reason,'closer_mapped_group');
  assert(result.diagnostics.straightLineMetres!<1200);assert(result.diagnostics.baselineStraightLineMetres!>26000);
});
test('an unknown baseline can yield to an equally relevant mapped nearby option; it is never zero',()=>{
  const missing=unknown('missing'),near=venue('near',17.4,78.41),park=venue('park');
  const result=selectNearbyPlanningStages([[missing,near],[park]],[missing,park]);
  assert.deepEqual(ids(result.selected),['near','park']);assert.equal(result.diagnostics.baselineStraightLineMetres,null);
  assert.equal(result.diagnostics.reason,'mapped_alternative');assert.equal(result.diagnostics.unknownLegCount,0);
  const far=venue('far',17.4,78.65),retained=selectNearbyPlanningStages([[missing,far],[park]],[missing,park]);
  assert.deepEqual(ids(retained.selected),['missing','park']);assert.equal(retained.diagnostics.straightLineMetres,null);
  assert.equal(retained.diagnostics.unknownLegCount,1);assert.equal(retained.diagnostics.state,'unavailable');
});
test('missing coordinates cannot beat a known baseline by creating free distance',()=>{
  const first=venue('first',17.4,78.6),missing=unknown('missing'),park=venue('park');
  const result=selectNearbyPlanningStages([[first,missing],[park]],[first,park]);
  assert.deepEqual(ids(result.selected),['first','park']);assert.equal(result.diagnostics.state,'retained');
});
test('meaningful name, preferred tag and explicit like scores cannot be traded for proximity',()=>{
  for(const gap of [5,6,7,25]){
    const wanted=venue('wanted',17.4,78.65,30+gap),near=venue('near',17.4,78.401,30),park=venue('park');
    assert.deepEqual(ids(selectNearbyPlanningStages([[wanted,near],[park]],[wanted,park]).selected),['wanted','park']);
  }
  const exact=unknown('named');exact.place.name='Bel Posto The Cafe';const alternate=venue('other'),park=venue('park',17.41,78.41);
  const locked=selectNearbyPlanningStages([[exact,alternate],[park]],[exact,park],{query:'Start at Bel Posto The Cafe, then a park.'});
  assert.deepEqual(ids(locked.selected),['named','park']);assert.equal(locked.diagnostics.straightLineMetres,null);
  assert.deepEqual(ids(selectNearbyPlanningStages([[exact,alternate],[park]],[exact,park],{query:'A cafe and park'}).selected),['other','park']);
});
test('small per-stage taste losses are bounded collectively and do not cancel with gains',()=>{
  const a=venue('a',17.4,78.6,33),b=venue('b',17.4,78.2,33),c=venue('c',17.4,78.4,33);
  const x=venue('x',17.4,78.401,30),y=venue('y',17.4,78.402,30),z=venue('z',17.4,78.403,60);
  const result=selectNearbyPlanningStages([[a,x],[b,y],[c,z]],[a,b,c]);
  assert(!(ids(result.selected).includes('x')&&ids(result.selected).includes('y')),'Two3-point losses exceed4 even if another candidate gains score.');
  assert.equal(result.selected.filter(Boolean).length,3);
});
test('a pin represented by one candidate stays in its own stage; other stages cannot consume it',()=>{
  const pin=venue('pin',17.4,78.4),a=venue('a',17.4,78.6),b=venue('b',17.4,78.402);
  const result=selectNearbyPlanningStages([[a,pin,b],[pin]],[a,pin]);
  assert.deepEqual(ids(result.selected),['b','pin']);
  assert.equal(new Set(ids(result.selected)).size,2);
});
test('maximum coverage survives scarce overlapping pools and null stages never bridge geography',()=>{
  const a=venue('a'),b=venue('b',17.4,78.41);
  const pools=[[a,b],[a]],baseline=allocatePlanningStages(pools);
  assert.deepEqual(ids(selectNearbyPlanningStages(pools,baseline).selected),['b','a']);
  const gap=selectNearbyPlanningStages([[a],[],[b]],[a,null,b]);
  assert.deepEqual(ids(gap.selected),['a',null,'b']);assert.equal(gap.diagnostics.straightLineMetres,null);
  assert.equal(gap.diagnostics.knownLegCount,0);assert.equal(gap.diagnostics.unknownLegCount,2);
  assert.equal(gap.diagnostics.reason,'missing_coordinates');
});
test('partial plans never advertise the measured portion as a complete outing distance',()=>{
  const far=venue('far',17.4,78.65),near=venue('near',17.4,78.401),park=venue('park');
  const result=selectNearbyPlanningStages([[far,near],[park],[]],[far,park,null]);
  assert.deepEqual(ids(result.selected),['far','park',null]);assert.equal(result.diagnostics.knownLegCount,1);
  assert.equal(result.diagnostics.unknownLegCount,1);assert.equal(result.diagnostics.straightLineMetres,null);
  assert.equal(result.diagnostics.applied,false);
  const empty=selectNearbyPlanningStages([[],[]],[null,null]);
  assert.equal(empty.diagnostics.unknownLegCount,1);assert.equal(empty.diagnostics.straightLineMetres,null);
  assert.equal(empty.diagnostics.reason,'no_adjacent_stops');
});
test('trivial geographic changes do not churn the ranked selection',()=>{
  const first=venue('first',17.4,78.41),closer=venue('closer',17.4,78.408),park=venue('park');
  assert.deepEqual(ids(selectNearbyPlanningStages([[first,closer],[park]],[first,park]).selected),['first','park']);
});
test('coordinate boundary rejects invalid, OSM, unproved or mismatched provenance',()=>{
  const source=venue('source').place;
  for(const changed of [
    {latitude:NaN},{longitude:Infinity},{latitude:0,longitude:0},{latitude:17.8},{longitude:79},
    {coordinateSource:'OpenStreetMap'},{coordinateKind:'bbox_center'},{sourceURLs:['https://www.wikidata.org/wiki/Q123?x=1']},
    {sourceURLs:['https://www.wikidata.org.evil.test/wiki/Q123']},{sourceURLs:['https://name@www.wikidata.org/wiki/Q123']},
    {sourceURLs:['https://www.wikidata.org/wiki/Q123\n']},{sourceURLs:['https://example.org/venue']},
    {name:'Fictional test venue'},
  ])assert.equal(planningCoordinate({...source,...changed} as CatalogPlace),null,JSON.stringify(changed));
  assert.deepEqual(planningCoordinate(source),[17.4,78.4]);
  const research:CatalogPlace={...source,coordinateSource:'EazyDiner',coordinateKind:'poi',sourceURLs:['https://www.eazydiner.com/hyderabad/cafe-123'],
    coordinateProvenance:{sourceURL:'https://www.eazydiner.com/hyderabad/cafe-123',method:'published_JSON-LD',retrievedAt:'2026-10-10',entranceVerified:false,independentlyVerified:false}};
  assert(planningCoordinate(research));assert.equal(planningCoordinate({...research,sourceURLs:['https://other.org/']}),null);
});
test('identical known feature coordinates really can have zero separation',()=>{
  const a=venue('a'),b=venue('b');const result=selectNearbyPlanningStages([[a],[b]],[a,b]);
  assert.equal(result.diagnostics.straightLineMetres,0);assert.equal(result.diagnostics.knownLegCount,1);
  assert.equal(result.diagnostics.state,'retained');
});
test('bounded inputs fail closed rather than silently truncate pools or fabricate eligibility',()=>{
  const a=venue('a'),b=venue('b');
  for(const [pools,baseline] of [
    [[[a]],[a]],[[[a],[b]],[a]],[[[a],[b]],[a,a]],[[[a],[b]],[a,venue('outside')]],
    [[[a,a],[b]],[a,b]],[[(Array.from({length:13},(_,i)=>venue(String(i)))),[b]],[a,b]],
  ] as [RankedPlace[][],(RankedPlace|null)[]][])
    assert.throws(()=>selectNearbyPlanningStages(pools,baseline),RangeError);
});
test('deterministic exhaustive cases preserve coverage, pins, eligibility and distinct identities',()=>{
  let seed=4783;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let trial=0;trial<60;trial++){
    const candidates=Array.from({length:6},(_,i)=>venue(`p${i}`,17.35+random()*.1,78.35+random()*.15));
    const pools=Array.from({length:4},()=>candidates.filter(()=>random()>.5));
    const baseline=allocatePlanningStages(pools),result=selectNearbyPlanningStages(pools,baseline);
    assert.deepEqual(result,selectNearbyPlanningStages(pools,baseline));
    assert.equal(result.selected.filter(Boolean).length,baseline.filter(Boolean).length);
    assert.equal(result.diagnostics.knownLegCount+result.diagnostics.unknownLegCount,3);
    assert.equal(new Set(result.selected.filter(Boolean).map(item=>item!.place.id)).size,result.selected.filter(Boolean).length);
    result.selected.forEach((item,stage)=>{
      assert.equal(item===null,baseline[stage]===null);
      if(item)assert(pools[stage].some(candidate=>candidate.place.id===item.place.id));
      if(pools[stage].length===1&&baseline[stage])assert.equal(item?.place.id,baseline[stage]?.place.id);
    });
  }
});
