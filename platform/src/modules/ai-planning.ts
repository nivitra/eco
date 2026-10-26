import {z} from 'zod';
import type {CatalogPlace} from './consumer.js';
import {belongsToArea,type RankedPlace,type RankInput} from './recommender.js';
import {canCreateDiscoveryOuting,discoveryCategories,outingCategoryIDs,selectDiscoveryCandidates} from './ai-discovery.js';
import {selectNearbyPlanningStages} from './planning-geography.js';

const scopeSchema=z.enum(['jubilee_hills','kokapet','hyderabad']);
export const planningStageSchema=z.object({
  id:z.string().trim().min(1).max(40),categoryID:z.enum(outingCategoryIDs),scope:scopeSchema.optional(),
  visitMinutes:z.number().int().min(5).max(480).nullable().optional(),
  pinnedPlaceID:z.string().trim().min(1).max(160).optional(),
  excludedPlaceIDs:z.array(z.string().trim().min(1).max(160)).max(12)
    .refine(ids=>new Set(ids).size===ids.length,'Excluded place IDs must be unique.').optional(),
}).strict().refine(stage=>!stage.pinnedPlaceID||!stage.excludedPlaceIDs?.includes(stage.pinnedPlaceID),'A pinned place cannot also be excluded from its stage.');
export const planningSchema=z.object({
  stages:z.array(planningStageSchema).min(2).max(4)
    .refine(stages=>new Set(stages.map(stage=>stage.id)).size===stages.length,'Stage IDs must be unique.')
    .refine(stages=>{const pins=stages.flatMap(stage=>stage.pinnedPlaceID?[stage.pinnedPlaceID]:[]);return new Set(pins).size===pins.length;},'Pinned place IDs must be unique.'),
  company:z.enum(['solo','friends','date','family','any']).default('any'),
  budgetPerPersonINR:z.number().int().min(1).max(100000).optional(),
  durationMinutes:z.number().int().min(15).max(1440).optional(),
  // Omission comes from older clients; null explicitly chooses a flexible time.
  // This is a user preference, never an opening-hours or routing observation.
  startAtEpochMs:z.number().int().min(0).max(4102444799999).nullable().optional(),
  note:z.string().trim().max(500).optional(),
  selectionMode:z.enum(['nearby','relevance']).default('nearby'),
}).strict();
export type PlanningRequest=z.infer<typeof planningSchema>;

const indiaVisitFormatter=new Intl.DateTimeFormat('en-GB',{
  timeZone:'Asia/Kolkata',calendar:'gregory',day:'2-digit',month:'short',year:'numeric',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
/** Explicit timing context is separate from venue facts and live observations. */
export function planningTimingContext(planning:PlanningRequest|undefined){
  const start=planning?.startAtEpochMs;
  if(start===undefined||start===null)return undefined;
  return {startAtEpochMs:start,timeZone:'Asia/Kolkata' as const,
    targetStartLocal:indiaVisitFormatter.format(new Date(start))+' IST',
    meaning:'user_preference' as const,hoursAvailabilityVerified:false,futureTrafficVerified:false};
}
/** Desired dwell allocations are user input, never sourced venue durations.
 * A known subtotal can prove a budget is already exceeded; it cannot prove fit
 * while travel, waiting or any other requested stay remains unknown.
 */
export function planningStayContext(planning:PlanningRequest|undefined){
  if(!planning)return undefined;
  const specified=planning.stages.filter(stage=>typeof stage.visitMinutes==='number');
  if(!specified.length)return undefined;
  const desiredStayMinutes=specified.reduce((total,stage)=>total+stage.visitMinutes!,0);
  return {stages:planning.stages.map(stage=>({id:stage.id,categoryID:stage.categoryID,visitMinutes:stage.visitMinutes??null})),
    specifiedStageCount:specified.length,requestedStageCount:planning.stages.length,desiredStayMinutes,
    allStaysSpecified:specified.length===planning.stages.length,overallBudgetMinutes:planning.durationMinutes??null,
    budgetStatus:planning.durationMinutes!==undefined&&desiredStayMinutes>planning.durationMinutes?'known_stays_exceed_budget' as const:'fit_unverified' as const,
    meaning:'user_preference' as const,travelAndWaitingVerified:false};
}

function planningStayCheck(planning:PlanningRequest):string|undefined {
  const stay=planningStayContext(planning);if(!stay)return undefined;
  if(stay.budgetStatus==='known_stays_exceed_budget')return `Your chosen stays total ${stay.desiredStayMinutes} min, exceeding your ${stay.overallBudgetMinutes} min budget before travel. Shorten activities or increase your budget.`;
  if(!stay.allStaysSpecified)return `You set ${stay.desiredStayMinutes} min across ${stay.specifiedStageCount} of ${stay.requestedStageCount} activities. Remaining stays, travel and waiting are unplanned; total duration fit is unverified.`;
  if(stay.overallBudgetMinutes===stay.desiredStayMinutes)return `Your chosen stays use the full ${stay.desiredStayMinutes} min budget. Travel and waiting need additional time; this is not a confirmed schedule.`;
  return `Your chosen stays total ${stay.desiredStayMinutes} min. Travel, waiting and venue timing have not been checked; overall duration fit is unverified.`;
}
export const planSchema=z.object({
  stages:z.array(z.object({id:z.string().min(1).max(40),categoryID:z.enum(outingCategoryIDs),placeID:z.string().min(1).max(160).nullable(),reason:z.string().min(1).max(350)}).strict()).min(2).max(4),
  checks:z.array(z.string().min(1).max(220)).max(8),status:z.enum(['complete','partial','empty']),
  proximity:z.object({state:z.enum(['grouped','retained','unavailable']),straightLineMetres:z.number().int().min(0).max(500000).optional(),
    knownLegCount:z.number().int().min(0).max(3),unknownLegCount:z.number().int().min(0).max(3),summary:z.string().trim().min(1).max(220)}).strict().optional(),
}).strict().superRefine((plan,context)=>{
  const proximity=plan.proximity;if(!proximity)return;
  const missingLegs=plan.stages.slice(1).filter((stage,index)=>stage.placeID===null||plan.stages[index].placeID===null).length;
  const complete=proximity.unknownLegCount===0;
  if(proximity.knownLegCount+proximity.unknownLegCount!==plan.stages.length-1||
     proximity.unknownLegCount<missingLegs||
     (complete?(proximity.state==='unavailable'||proximity.straightLineMetres===undefined):
       (proximity.state!=='unavailable'||proximity.straightLineMetres!==undefined))){
    context.addIssue({code:'custom',path:['proximity'],message:'Distance coverage must account for every requested leg; missing stops or positions cannot have a complete total.'});
  }
});
export type PlanningDraft=z.infer<typeof planSchema>;
type ChatInput=Parameters<typeof selectDiscoveryCandidates>[1];
type Feedback=Pick<RankInput,'likedIDs'|'dismissedIDs'>;

type Edge={to:number,reverse:number,capacity:number,cost:number};
/** Maximum coverage before ranking quality. Residual edges let a later scarce
 * stage reclaim a shared venue; a greedy first-choice assignment cannot do that.
 * At most4 stages x12 ranked candidates makes this bounded and deterministic.
 */
export function allocatePlanningStages(pools:readonly (readonly RankedPlace[])[]):(RankedPlace|null)[]{
  const ids=[...new Set(pools.flatMap(pool=>pool.map(item=>item.place.id)))].sort();
  const source=0,placeOffset=1+pools.length,sink=placeOffset+ids.length;
  const graph:Edge[][]=Array.from({length:sink+1},()=>[]);
  const idIndex=new Map(ids.map((id,index)=>[id,index]));
  const add=(from:number,to:number,cost:number)=>{
    const forward:Edge={to,reverse:graph[to].length,capacity:1,cost};
    graph[from].push(forward);graph[to].push({to:from,reverse:graph[from].length-1,capacity:0,cost:-cost});
    return forward;
  };
  const choices=pools.map((pool,index)=>{
    add(source,index+1,0);
    return pool.map((item,rank)=>({item,edge:add(index+1,placeOffset+idIndex.get(item.place.id)!,rank*1000+idIndex.get(item.place.id)!)}));
  });
  ids.forEach((_,index)=>add(placeOffset+index,sink,0));
  for(let flow=0;flow<pools.length;flow++){
    const distance=Array(graph.length).fill(Infinity),previous:(readonly [number,number]|undefined)[]=Array(graph.length);
    distance[source]=0;
    for(let pass=0;pass<graph.length-1;pass++){
      let changed=false;
      for(let node=0;node<graph.length;node++)if(Number.isFinite(distance[node])){
        graph[node].forEach((edge,index)=>{
          if(edge.capacity>0&&distance[edge.to]>distance[node]+edge.cost){
            distance[edge.to]=distance[node]+edge.cost;previous[edge.to]=[node,index];changed=true;
          }
        });
      }
      if(!changed)break;
    }
    if(!previous[sink])break;
    for(let node=sink;node!==source;){
      const [from,index]=previous[node]!;const edge=graph[from][index];
      edge.capacity--;graph[node][edge.reverse].capacity++;node=from;
    }
  }
  return choices.map(pool=>pool.find(choice=>choice.edge.capacity===0)?.item??null);
}

export function buildPlanningDraft(places:CatalogPlace[],input:ChatInput,planning:PlanningRequest,feedback:Feedback={}){
  const effectiveInput=planning.note?{...input,messages:[...input.messages,{role:'user' as const,content:planning.note}]}:input;
  // A global directory remains an intersection. Stage controls must never erase
  // an explicit user's selected category, selected IDs or saved-only choice.
  const leisure=places.filter(place=>canCreateDiscoveryOuting(place)&&
    (!input.discovery?.categoryID||discoveryCategories(place).includes(input.discovery.categoryID)));
  const pinnedIDs=new Set(planning.stages.flatMap(stage=>stage.pinnedPlaceID?[stage.pinnedPlaceID]:[]));
  const pools=planning.stages.map(stage=>{
    const narrowed=leisure.filter(place=>(!stage.scope||stage.scope==='hyderabad'||belongsToArea(place,stage.scope))&&!stage.excludedPlaceIDs?.includes(place.id));
    // Check a requested pin before the rank limit, through the same hard gates.
    // Reserve even an ineligible pin: another stage must not silently move it.
    const eligibleIDs=stage.pinnedPlaceID?narrowed.filter(place=>place.id===stage.pinnedPlaceID):narrowed.filter(place=>!pinnedIDs.has(place.id));
    return selectDiscoveryCandidates(eligibleIDs,{...effectiveInput,discovery:{...input.discovery,goal:'outing',categoryID:stage.categoryID,savedOnly:input.discovery?.savedOnly??false}},feedback,12);
  });
  const baseline=allocatePlanningStages(pools.map(pool=>pool.results));
  const nearby=planning.selectionMode==='relevance'?undefined:selectNearbyPlanningStages(pools.map(pool=>pool.results),baseline,
    {query:effectiveInput.messages.filter(message=>message.role==='user').map(message=>message.content).join('. ')});
  const selected=nearby?.selected??baseline;
  const stages=planning.stages.map((stage,index)=>{
    const match=selected[index],pool=pools[index];
    const requiresUnknown=pool.exclusions.some(item=>item.reasons.includes('required_fact_unverified'));
    const reason=match?((stage.pinnedPlaceID?'Kept your pinned place. ':'')+match.reasons.slice(0,2).join(' ')).slice(0,350):
      stage.pinnedPlaceID?(requiresUnknown?'Your pinned place needs facts that the collection does not verify. It was not replaced with an unverified option.':
        'Your pinned place is unavailable or does not match this activity and the current filters. Unpin it or change the filters; no replacement was selected.'):
      requiresUnknown?'This stage needs facts that the collection does not verify. No unverified match was substituted.':
      pool.results.length?'No distinct venue remains for this stage under the current filters. Choose another category or widen your selection.':
      'No sourced leisure listing matches this stage and the current area, selected places and exclusions. No other category was substituted.';
    return {id:stage.id,categoryID:stage.categoryID,placeID:match?.place.id??null,reason};
  });
  const count=selected.filter(Boolean).length;
  const timing=planningTimingContext(planning);
  const stayCheck=planningStayCheck(planning);
  const checks=[
    'Stage order follows your choices; it is not a calculated or optimized route.',
    timing?`Target start: ${timing.targetStartLocal}. This is your preference; hours, events, availability and future traffic are unverified.`:
      'Current opening hours, events and availability are unverified. Confirm with each venue.',
    'Travel times, traffic and exact entrances have not been checked.',
    'Prices are unverified; no total cost or budget fit has been confirmed.',
    'Dietary needs, accessibility and public access are unverified; confirm directly.',
    ...(planning.durationMinutes!==undefined?['Your duration is a preference; no schedule or travel-time fit has been confirmed.']:[]),
    ...(planning.company!=='any'?['Company is a preference; group capacity, suitability and access are not verified.']:[]),
    ...(stayCheck?[stayCheck]:[]),
  ];
  const geography=nearby?.diagnostics;
  const proximity=geography?{state:geography.state,
    ...(geography.straightLineMetres!==null?{straightLineMetres:geography.straightLineMetres}:{}),
    knownLegCount:geography.knownLegCount,unknownLegCount:geography.unknownLegCount,
    summary:geography.state==='grouped'?'Grouped similarly relevant places using published map positions. Your activity order and kept places are preserved.':
      geography.state==='unavailable'?'Some stops lack a sourced map position or a matching place. A complete distance comparison is unavailable.':
      'Kept these matches within your preferences. Published positions are approximate; check the actual journeys before going.'}:undefined;
  const plan=planSchema.parse({stages,checks,status:count===stages.length?'complete':count?'partial':'empty',proximity});
  return {plan,selected:selected.filter((item):item is RankedPlace=>!!item),pools};
}

/** Server-owned plan fields and flat cards always agree, including fallback.
 * The model may describe a draft but may not reassign or invent its stops.
 */
export function planningReply(plan:PlanningDraft,prose?:{answer:string,followUp?:string|null}){
  const matched=plan.stages.filter(stage=>stage.placeID!==null);
  return {
    answer:prose?.answer??(plan.status==='complete'
      ?'Each stage has a distinct sourced match. This is a draft in your chosen order; hours, prices and travel still need checking.'
      :plan.status==='partial'?`${matched.length} of ${plan.stages.length} stages have a sourced match. The missing stages are kept visible so you can change them; no substitutes were invented.`
      :'No stages have a sourced match under the current filters. The requested stages are kept so you can revise them.'),
    recommendations:matched.map(stage=>({placeID:stage.placeID!,reason:stage.reason})),
    followUp:prose?.followUp??(plan.status==='complete'?'Would you like to change a stage before saving this draft?':'Change a missing stage or a filter to look for another match.'),
    plan,
  };
}
