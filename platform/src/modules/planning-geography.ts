import type {CatalogPlace} from './consumer.js';
import type {RankedPlace} from './recommender.js';
import {trustedResearchCoordinates} from '../research-provenance.js';

/** Editorial grouping policy, not a route or a suitability/availability claim.
 * Hard filtering and maximum-coverage assignment happen before this helper.
 */
export const PLANNING_GEOGRAPHY_POLICY='hyderabad-bounded-nearby-1';
export const planningGeographyLimits=Object.freeze({
  maxStages:4,maxCandidatesPerStage:12,maxStageScoreLoss:3,maxTotalScoreLoss:4,
  rankPositionMetres:250,minimumImprovementMetres:500,maxUnknownReplacementLegMetres:8000,
});
export type PlanningGeographyDiagnostics={
  policyVersion:typeof PLANNING_GEOGRAPHY_POLICY;
  applied:boolean;
  state:'grouped'|'retained'|'unavailable';
  straightLineMetres:number|null;
  baselineStraightLineMetres:number|null;
  knownLegCount:number;
  unknownLegCount:number;
  reason:'closer_mapped_group'|'mapped_alternative'|'baseline_kept'|'missing_coordinates'|'no_adjacent_stops';
};
type Coordinate=readonly [number,number];
type Choice={item:RankedPlace,rank:number,coordinate:Coordinate|null};
type Geometry={total:number|null,known:number,unknown:number,longest:number};

/** Recheck the public coordinate provenance at this boundary. Feature points
 * are never described as verified entrances. OSM and unproved points are not
 * accepted even if finite; numeric missing values never become (0,0).
 */
export function planningCoordinate(place:CatalogPlace):Coordinate|null {
  if(typeof place.latitude!=='number'||!Number.isFinite(place.latitude)||place.latitude<17.15||place.latitude>17.75||
     typeof place.longitude!=='number'||!Number.isFinite(place.longitude)||place.longitude<78.10||place.longitude>78.80||
     /\b(demo|fictional|synthetic)\b/i.test([place.name,place.summary,...place.tags].join(' ')))return null;
  const wikidata=place.coordinateSource==='Wikidata'&&['poi','coordinate_location'].includes(place.coordinateKind??'')&&
    place.sourceURLs.some(value=>{
      try{return value===new URL(value).href&&/^https:\/\/(?:www\.)?wikidata\.org\/wiki\/Q[1-9][0-9]*$/.test(value);}
      catch{return false;}
    });
  if(!trustedResearchCoordinates(place,place.sourceURLs)&&!wikidata)return null;
  return [place.latitude,place.longitude];
}

function distance(a:Coordinate,b:Coordinate):number {
  const rad=Math.PI/180,lat=(b[0]-a[0])*rad,lon=(b[1]-a[1])*rad;
  const hav=Math.sin(lat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(lon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.max(0,Math.min(1,hav))));
}
function geometry(choices:readonly (Choice|null)[]):Geometry {
  let total=0,known=0,unknown=0,longest=0;
  for(let i=1;i<choices.length;i++){
    const prior=choices[i-1],current=choices[i];
    // Every requested adjacent leg is accounted for. A missing activity makes
    // that leg unknown; never bridge the gap or publish a partial total.
    if(!prior||!current){unknown++;continue;}
    if(!prior.coordinate||!current.coordinate){unknown++;continue;}
    const metres=distance(prior.coordinate,current.coordinate);
    total+=metres;longest=Math.max(longest,metres);known++;
  }
  return {total:known&&!unknown?total:null,known,unknown,longest};
}
const normalized=(text:string)=>text.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function exactNameRequested(place:CatalogPlace,query:string):boolean {
  const name=normalized(place.name);
  // Whole phrases only; "coffee" must not lock every café containing that
  // word. Raw score margins additionally protect partial relevant name hits.
  return name.length>=5&&(' '+normalized(query)+' ').includes(' '+name+' ');
}

/** Among already-eligible pools, find a geographically coherent assignment.
 * - Preserve the baseline's maximum coverage, stage order and null positions.
 * - Preserve any one-item pool (pins), distinct IDs and explicit named choice.
 * - Lose at most3 raw score points per stage and4 in total. One meaningful
 *   name hit(+7), sourced tag(+6), or explicit like(+5) cannot be traded away.
 * - Known geography must improve by >=500m after a250m/rank-position penalty.
 * - Unknown baseline geometry may yield to a fully measurable alternative
 *   only when each adjacent leg is <=8km. Unknown is never zero or a free win.
 * There are <=12^4=20,736 combinations; provenance is checked once per pool
 * item, outside enumeration. No network/DB access or candidate invention.
 */
export function selectNearbyPlanningStages(
  pools:readonly (readonly RankedPlace[])[],baseline:readonly (RankedPlace|null)[],
  options:{query?:string}={},
):{selected:(RankedPlace|null)[],diagnostics:PlanningGeographyDiagnostics} {
  if(pools.length<2||pools.length>4||baseline.length!==pools.length||pools.some(pool=>pool.length>12))
    throw new RangeError('Nearby planning needs 2–4 stage pools of at most12 candidates and a matching baseline.');
  const usedBaseline=new Set<string>();
  const choices=pools.map(pool=>{
    const ids=new Set<string>();
    return pool.map((item,rank)=>{
      if(ids.has(item.place.id)||!Number.isFinite(item.score))throw new RangeError('Candidate IDs must be distinct within each pool and scores finite.');
      ids.add(item.place.id);return {item,rank,coordinate:planningCoordinate(item.place)};
    });
  });
  const initial=baseline.map((item,stage)=>{
    if(!item)return null;
    const found=choices[stage].find(choice=>choice.item.place.id===item.place.id);
    if(!found||usedBaseline.has(item.place.id))throw new RangeError('Baseline must be a distinct assignment from the supplied pools.');
    usedBaseline.add(item.place.id);return found;
  });
  const initialGeometry=geometry(initial);
  const rankSum=(items:readonly (Choice|null)[])=>items.reduce((sum,item)=>sum+(item?.rank??0),0);
  const baselineRanks=rankSum(initial);
  const candidates=choices.map((pool,stage)=>{
    const first=initial[stage];if(!first)return [];
    if(pool.length===1||exactNameRequested(first.item.place,options.query??''))return [first];
    return pool.filter(choice=>first.item.score-choice.item.score<=planningGeographyLimits.maxStageScoreLoss);
  });
  let best: {items:(Choice|null)[],geography:Geometry,objective:number,ranks:number,key:string}|undefined;
  const chosen:(Choice|null)[]=[],used=new Set<string>();
  function visit(stage:number,scoreLoss:number):void {
    if(scoreLoss>planningGeographyLimits.maxTotalScoreLoss)return;
    if(stage===choices.length){
      const measured=geometry(chosen);if(measured.total===null)return;
      if(initialGeometry.total===null&&measured.longest>planningGeographyLimits.maxUnknownReplacementLegMetres)return;
      const ranks=rankSum(chosen),objective=measured.total+ranks*planningGeographyLimits.rankPositionMetres;
      const key=JSON.stringify(chosen.map(choice=>choice?.item.place.id??null));
      if(!best||objective<best.objective||(objective===best.objective&&(ranks<best.ranks||(ranks===best.ranks&&key<best.key))))
        best={items:[...chosen],geography:measured,objective,ranks,key};
      return;
    }
    if(!initial[stage]){chosen.push(null);visit(stage+1,scoreLoss);chosen.pop();return;}
    for(const candidate of candidates[stage]){
      if(used.has(candidate.item.place.id))continue;
      used.add(candidate.item.place.id);chosen.push(candidate);
      visit(stage+1,scoreLoss+Math.max(0,initial[stage]!.item.score-candidate.item.score));
      chosen.pop();used.delete(candidate.item.place.id);
    }
  }
  visit(0,0);
  const minimum=planningGeographyLimits.minimumImprovementMetres;
  const baselineObjective=initialGeometry.total===null?null:initialGeometry.total+baselineRanks*planningGeographyLimits.rankPositionMetres;
  const useAlternative=best!==undefined&&(baselineObjective===null||
    (best.objective+minimum<=baselineObjective&&best.geography.total!+minimum<=initialGeometry.total!));
  const result=useAlternative?best!.items:initial,measured=useAlternative?best!.geography:initialGeometry;
  const applied=result.some((choice,index)=>choice?.item.place.id!==initial[index]?.item.place.id);
  return {
    selected:result.map(choice=>choice?.item??null),
    diagnostics:{policyVersion:PLANNING_GEOGRAPHY_POLICY,applied,
      state:measured.total===null?'unavailable':applied?'grouped':'retained',
      straightLineMetres:measured.total===null?null:Math.round(measured.total),
      baselineStraightLineMetres:initialGeometry.total===null?null:Math.round(initialGeometry.total),
      knownLegCount:measured.known,unknownLegCount:measured.unknown,
      reason:applied?(initialGeometry.total===null?'mapped_alternative':'closer_mapped_group'):
        !initial.some(Boolean)?'no_adjacent_stops':measured.total===null?'missing_coordinates':'baseline_kept',
    },
  };
}
