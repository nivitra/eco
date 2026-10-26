import {z} from 'zod';
import type {CatalogPlace} from './consumer.js';
import {rankPlaces, recommendationScope, recommendationIntent, equivalentActivities, excludedAreaScopes, words, negatedTerm, type RankInput, type RecommendationIntent} from './recommender.js';

// Exact source categories/tags, mirrored by native DiscoveryCategories.swift.
export const discoveryAliases = {
  "cafes": [
    "cafes",
    "cafe",
    "café",
    "coffee shop",
    "coffeehouse"
  ],
  "food": [
    "food",
    "restaurant",
    "restaurants",
    "dining",
    "bakery",
    "bakeries",
    "dessert shop"
  ],
  "nightlife": [
    "nightlife",
    "bar",
    "bars",
    "pub",
    "pubs",
    "brewery",
    "breweries",
    "nightclub"
  ],
  "nature": [
    "nature",
    "lake",
    "lakes",
    "botanical garden",
    "forest",
    "wildlife sanctuary"
  ],
  "parks": [
    "parks",
    "park",
    "public park",
    "urban park",
    "eco park",
    "national park"
  ],
  "heritage": [
    "heritage",
    "historic site",
    "monument",
    "fort",
    "palace"
  ],
  "art": [
    "art",
    "art gallery",
    "gallery",
    "galleries",
    "pottery",
    "art workshop"
  ],
  "culture": [
    "culture",
    "museum",
    "museums",
    "cinema",
    "theatre",
    "theater",
    "performing arts",
    "cultural centre",
    "cultural center"
  ],
  "shopping": [
    "shopping",
    "mall",
    "market",
    "bookshop",
    "bookstore",
    "retail"
  ],
  "sports": [
    "sports",
    "sport",
    "badminton",
    "cricket",
    "football",
    "tennis",
    "swimming",
    "basketball",
    "volleyball",
    "table tennis",
    "squash",
    "skating",
    "pickleball",
    "golf"
  ],
  "games": [
    "games",
    "gaming",
    "gaming cafe",
    "gaming venue",
    "board games",
    "bowling",
    "snooker",
    "billiards",
    "arcade",
    "escape room",
    "virtual reality",
    "go karting"
  ],
  "community": [
    "community",
    "community centre",
    "community center",
    "public library",
    "gathering place"
  ],
  "stationery": [
    "stationery",
    "stationery store",
    "stationery shop",
    "art supplies"
  ],
  "b2b": [
    "b2b",
    "wholesale",
    "wholesaler",
    "manufacturer",
    "industrial supplier",
    "business services"
  ],
  "doctors": [
    "doctor",
    "doctors",
    "physician",
    "dentist",
    "pediatrician",
    "dermatologist"
  ],
  "hospitals": [
    "healthcare",
    "hospital",
    "hospitals",
    "clinic",
    "clinics",
    "medical clinic"
  ],
  "travel": [
    "travel",
    "travel agency",
    "travel agent",
    "tour operator"
  ],
  "car_hire": [
    "car hire",
    "car rental",
    "taxi service",
    "cab service"
  ],
  "beauty": [
    "beauty",
    "beauty salon",
    "salon",
    "barber",
    "nail salon",
    "spa"
  ],
  "astrology": [
    "astrology",
    "astrologer",
    "astrology service"
  ],
  "wedding_planning": [
    "wedding planning",
    "wedding planner",
    "wedding planners"
  ],
  "education": [
    "education",
    "school",
    "college",
    "university",
    "coaching centre",
    "coaching center",
    "training institute"
  ],
  "packers_movers": [
    "packers movers",
    "packers and movers",
    "moving company",
    "removal service"
  ],
  "gyms": [
    "gym",
    "gyms",
    "gymnasium",
    "fitness centre",
    "fitness center",
    "health club"
  ],
  "rent_hire": [
    "rent hire",
    "equipment rental",
    "rental service",
    "tool hire",
    "furniture rental"
  ],
  "jobs": [
    "jobs",
    "recruitment agency",
    "employment agency",
    "placement agency",
    "career centre",
    "career center"
  ],
  "loans": [
    "loans",
    "loan provider",
    "loan agency",
    "mortgage lender",
    "loan broker"
  ],
  "real_estate": [
    "real estate",
    "real estate agency",
    "real estate agent",
    "property agent"
  ],
  "pg_hostel": [
    "pg hostel",
    "pg",
    "paying guest",
    "hostel",
    "hostels"
  ],
  "movies": [
    "movies",
    "movie theatre",
    "movie theater",
    "cinema",
    "multiplex"
  ],
  "events": [
    "events",
    "event venue",
    "concert venue",
    "live music venue"
  ],
  "hotels": [
    "hotels",
    "hotel",
    "lodging",
    "resort"
  ],
  "flights": [
    "flights",
    "airline office",
    "airline ticket agency",
    "flight booking"
  ],
  "bus": [
    "bus",
    "bus station",
    "bus terminal",
    "bus ticket agency",
    "bus operator"
  ],
  "taxis": [
    "taxis",
    "taxi",
    "taxi service",
    "cab service",
    "taxi stand"
  ],
  "train_meals": [
    "train meals",
    "railway catering",
    "train food delivery"
  ],
  "bills_recharge": [
    "bills recharge",
    "bill payment",
    "mobile recharge",
    "recharge service"
  ],
  "chemists": [
    "chemists",
    "chemist",
    "pharmacy",
    "pharmacies",
    "medical store"
  ],
  "grocery": [
    "grocery",
    "grocery store",
    "supermarket",
    "grocer"
  ],
  "books": [
    "books",
    "bookshop",
    "bookstore",
    "book store",
    "public library"
  ],
  "repairs": [
    "repairs",
    "repair service",
    "appliance repair",
    "electronic repair",
    "mobile phone repair",
    "computer repair"
  ],
  "automobile": [
    "automobile",
    "car dealer",
    "motorcycle dealer",
    "auto repair",
    "car service centre",
    "car service center"
  ],
  "florists": [
    "florists",
    "florist",
    "flower shop"
  ],
  "acting": [
    "acting",
    "acting classes",
    "acting school",
    "film school"
  ],
  "dance": [
    "dance",
    "dance classes",
    "dance school",
    "dance studio"
  ],
  "aerobics": [
    "aerobics",
    "aerobic classes",
    "aerobics classes",
    "aerobics studio"
  ],
  "apparel": [
    "apparel",
    "clothing store",
    "clothes shop",
    "fashion store"
  ],
  "atms": [
    "atms",
    "atm",
    "automated teller machine"
  ],
  "auditoriums": [
    "auditoriums",
    "auditorium",
    "concert hall",
    "performance hall"
  ],
  "auto_accessories": [
    "auto accessories",
    "car accessories",
    "automotive parts",
    "auto parts store"
  ],
  "banquets": [
    "banquets",
    "banquet hall",
    "function hall",
    "wedding venue"
  ],
  "cleaning": [
    "cleaning",
    "cleaning service",
    "house cleaning",
    "dry cleaning",
    "laundry"
  ],
  "computers": [
    "computers",
    "computer store",
    "computer shop",
    "computer repair",
    "laptop store"
  ],
  "consultants": [
    "consultants",
    "consultant",
    "consultancy",
    "consulting firm"
  ],
  "dietitians": [
    "dietitians",
    "dietitian",
    "dietician",
    "nutritionist",
    "nutrition clinic"
  ],
  "dth": [
    "dth",
    "dth service",
    "satellite television service",
    "dth dealer"
  ]
} as const;
export type DiscoveryCategoryID = keyof typeof discoveryAliases;
export const discoveryCategoryIDs = Object.keys(discoveryAliases) as [DiscoveryCategoryID, ...DiscoveryCategoryID[]];
export const discoverySchema = z.object({goal:z.enum(['discover','outing','service']), categoryID:z.enum(discoveryCategoryIDs).optional(), query:z.string().trim().max(160).optional(), savedOnly:z.boolean().default(false),selectedPlaceIDs:z.array(z.string().trim().min(1).max(160)).min(1).max(8).refine(ids=>new Set(ids).size===ids.length,'Selected place IDs must be unique.').optional()}).strict();
export type DiscoveryBrief = z.infer<typeof discoverySchema>;

const outingIDs = new Set<DiscoveryCategoryID>(['cafes','food','nightlife','nature','parks','heritage','art','culture','shopping','sports','games','community','movies','events','books','apparel','auditoriums']);
export const outingCategoryIDs=discoveryCategoryIDs.filter(id=>outingIDs.has(id)) as [DiscoveryCategoryID,...DiscoveryCategoryID[]];
const normalize = (value:string) => [...words(value)].join(' ');
const sourceCategoryIndex=new Map<string,Set<DiscoveryCategoryID>>();
const specialistParkTags=new Set(['zoo','zoological park','water park','waterpark','amusement park','theme park','memorial garden']);
for(const id of discoveryCategoryIDs)for(const alias of discoveryAliases[id]){
  const token=normalize(alias),categories=sourceCategoryIndex.get(token)??new Set<DiscoveryCategoryID>();
  categories.add(id);sourceCategoryIndex.set(token,categories);
}
export function discoveryCategories(place:CatalogPlace):DiscoveryCategoryID[] {
  const found=new Set<DiscoveryCategoryID>();
  const evidence=[place.category,...place.tags].map(normalize);
  for(const token of evidence)for(const id of sourceCategoryIndex.get(token)??[])found.add(id);
  // Specialist attractions must not fill an ordinary park stage just because
  // an older import used the broad parks category. Identity and other sourced
  // categories remain searchable; names cannot invent a subtype.
  if(evidence.some(token=>specialistParkTags.has(token)))found.delete('parks');
  return discoveryCategoryIDs.filter(id=>found.has(id));
}
export function canCreateDiscoveryOuting(place:CatalogPlace):boolean {
  const categories=discoveryCategories(place);
  return categories.some(id=>outingIDs.has(id))&&!categories.some(id=>!outingIDs.has(id));
}
function webSource(value:string):URL|undefined {
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password?url:undefined;}catch{return undefined;}
}
export function sourceBackedDiscoveryPlace(place:CatalogPlace):boolean {
  const sources=place.sourceURLs.map(webSource).filter((value):value is URL=>!!value);
  const osm=(url:URL)=>url.hostname==='openstreetmap.org'||url.hostname.endsWith('.openstreetmap.org');
  const coordinateSourceURL=place.coordinateSource?webSource(place.coordinateSource):undefined;
  const osmCoordinate=['osm','openstreetmap'].includes((place.coordinateSource??'').trim().toLowerCase())||!!(coordinateSourceURL&&osm(coordinateSourceURL));
  const descriptionWords=words([place.name,place.summary,...place.tags].join(' '));
  return sources.length>0&&!place.id.toLowerCase().startsWith('osm-')&&
    !((osmCoordinate||sources.some(osm))&&!sources.some(url=>!osm(url)))&&
    !['demo','fictional','synthetic'].some(word=>descriptionWords.has(word));
}
export function matchesDiscoveryQuery(place:CatalogPlace,query=''):boolean {
  const categoryTitle=({cafes:'Cafés',healthcare:'Healthcare',stationery:'Stationery',community:'Community',transport:'Transit',education:'Campus',parks:'Parks'} as Record<string,string>)[place.category]??place.category;
  const text=[place.name,place.category,categoryTitle,place.summary,place.address,place.neighborhood,...place.tags].join(' ').normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase();
  return [...words(query)].every(token=>text.includes(token));
}
export type DiscoveryMessage={role:'user'|'assistant',content:string};
const resetTurn=(text:string)=>/^\s*(?:new search|start over|reset (?:the )?search)\b/i.test(text);
const barWords=['bar','bars','pub','pubs','brewery','breweries','nightlife','alcohol','cocktails'];
// This explicit whole-turn command is offered by the empty reply. A vague "yes"
// or a negated reference to unverified facts must never relax a hard requirement.
const allowsUnverifiedFacts=(text:string)=>/^(?:yes )?show (?:me )?(?:source backed )?listings with unverified facts$/.test(normalize(text));

// Exact counterpart of native AskParkIntent. Keep duplicates in normalized
// phrases and negation windows: words() is a scoring set, not a phrase parser.
const parkNormalize=(value:string)=>(value.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).join(' ');
type ParkSubtype='waterPark'|'amusementPark'|'zoo'|'memorialGarden'|'nationalPark'|'ecoPark'|'urbanPark';
const parkSubtypeEvidence:[ParkSubtype,readonly string[]][]=[
  ['waterPark',['water park','waterpark']],['amusementPark',['amusement park','theme park']],
  ['zoo',['zoo','zoological park']],['memorialGarden',['memorial garden']],
  ['nationalPark',['national park']],['ecoPark',['eco park']],['urbanPark',['urban park']]
];
const parkSpecialistPhrases:Partial<Record<ParkSubtype,readonly string[]>>={
  waterPark:['water park','water parks','waterpark','waterparks'],
  amusementPark:['amusement park','amusement parks','theme park','theme parks'],
  zoo:['zoo','zoos','zoological park','zoological parks'],
  memorialGarden:['memorial','memorials','memorial garden','memorial gardens']
};
// Additional topic vocabulary from native JubileeRecommender.categories and
// AskParkIntent.everyday. Exact category aliases above supply the shared rest.
const parkTopicPhrases=new Set([
  ...Object.values(discoveryAliases).flat().map(parkNormalize),...Object.values(parkSpecialistPhrases).flat(),
  'coffee','espresso','cappuccino','eat','lunch','dinner','biryani','exhibition','history','historic','temple','temples',
  'walk','greenery','outdoors','drinks','cocktails','padel','game','escape','shop','boutique','clothes','wellness','yoga','fitness',
  'pharmacy','pharmacies','pens','pencils','notebooks','printing','centre','center','library','libraries',
  'transport','transit','railway','rail','train','trains','metro','station','stations','universities','colleges','campus','institute',
  'walking','dessert','desserts','breakfast','exhibitions','cocktail','books','bookshops','bookstores','markets',
  'soccer','paintball','karting','esports','cinemas','movie','movies','film','airport','airports','bus','schools','institutes'
]);
type ParkTopic={text:string,normalized:string};
function parkNegated(term:string,text:string):boolean {
  return text.toLowerCase().replaceAll('’',"'").replace(/\bbut\b/g,'.').split(/[.;!?,]/).some(clause=>{
    const list=clause.match(/[\p{L}\p{N}]+/gu)??[];
    return list.some((word,index)=>{
      if(word!==term)return false;
      const prior=list.slice(Math.max(0,index-6),index).join(' ').replace(/\bnot (only|just)\b/g,'also').replace(/\b(don t|do not) mind\b/g,'accept');
      return /\b(no|not|without|avoid|skip|exclude|never|nothing|don t)\b/.test(prior);
    });
  });
}
const positiveParkPhrase=(phrase:string,topic:ParkTopic)=>topic.normalized.includes(' '+phrase+' ')&&!parkNegated(phrase.split(' ')[0],topic.text);
function unquoteParkRequest(value:string):string {
  return value.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\p{L})'[^'\n]+'(?!\p{L})/gu,(quote:string,offset:number)=>{
    const prefix=value.slice(0,offset);
    return /\b(find|show|visit|try|choose|recommend|suggest|compare|go to)\s+(?:me\s+)?$/i.test(prefix)?quote.slice(1,-1):' ';
  });
}
/** Only a positive, retained ordinary-park request activates this safety guard.
 * Other requested categories stay eligible. A positive matching specialist
 * request or full sourced venue name permits that record, never another type.
 * The caller passes USER turns only; explicit directories remain authoritative.
 */
export function discoveryParkIntent(userTurns:string[],places:CatalogPlace[]) {
  const names=places.filter(sourceBackedDiscoveryPlace).map(place=>({id:place.id,name:parkNormalize(place.name)})).filter(place=>place.name.length>0);
  let latest:ParkTopic|undefined;
  for(const input of userTurns){
    const text=unquoteParkRequest(input),turn={text,normalized:' '+parkNormalize(text)+' '};
    if(resetTurn(text))latest=undefined;
    if([...parkTopicPhrases].some(phrase=>positiveParkPhrase(phrase,turn))||names.some(place=>positiveParkPhrase(place.name,turn)))latest=turn;
  }
  const topic=latest,ordinary=!!topic&&['park','parks','walk','walking'].some(phrase=>positiveParkPhrase(phrase,topic));
  const named=new Set(topic?names.filter(place=>positiveParkPhrase(place.name,topic)).map(place=>place.id):[]);
  return {permits(place:CatalogPlace):boolean {
    if(!ordinary||!topic)return true;
    const evidence=new Set([place.category,...place.tags].map(parkNormalize));
    const subtype=parkSubtypeEvidence.find(([,aliases])=>aliases.some(alias=>evidence.has(alias)))?.[0];
    const specialist=subtype?parkSpecialistPhrases[subtype]:undefined;
    return !specialist||named.has(place.id)||specialist.some(phrase=>positiveParkPhrase(phrase,topic));
  }};
}

function serviceCategoriesInTurn(turn:string):DiscoveryCategoryID[] {
  const text=' '+normalize(turn)+' ';
  return discoveryCategoryIDs.filter(id=>!outingIDs.has(id)&&discoveryAliases[id].some(alias=>{
    const phrase=normalize(alias);return text.includes(' '+phrase+' ')&&!negatedTerm(turn,phrase.split(' ')[0]);
  }));
}
function isPositiveBarRequest(turn:string):boolean {
  const text=normalize(turn),target='(?:bars?|pubs?|nightlife|alcohol|cocktails?|breweries|brewery)';
  return new RegExp('^(?:(?:actually|instead|now|please) )*(?:include|allow|add|want|find|show|choose|recommend|suggest|try|visit) (?:(?:me|some|a|few) ){0,2}'+target+'\\b').test(text)
    ||new RegExp('^(?:actually |instead )?'+target+' instead$').test(text)
    ||new RegExp('^'+target+' (?:are )?(?:okay|ok|fine)$').test(text);
}

/** Bounded refinement memory: user turns only; UI brief changes clear history.
 * Latest explicit locality/topic wins; vague turns preserve resolved constraints.
 * Positive category/activity requests remove an older same-axis exclusion;
 * current-turn exclusions and the saved avoidBars taste remain authoritative.
 * A user can explicitly start a new search to discard prior chat constraints.
 */
export function discoveryConversation(messages:DiscoveryMessage[],scope='jubilee_hills',tasteAvoidBars=false) {
  let turns=messages.filter(message=>message.role==='user').map(message=>message.content);
  const reset=turns.findLastIndex(resetTurn);if(reset>=0)turns=turns.slice(reset);
  let effectiveScope=scope as 'jubilee_hills'|'kokapet'|'hyderabad',noBars=false;
  let requestedCategories:string[]=[],requestedActivities:string[]=[],serviceCategories:DiscoveryCategoryID[]=[];
  let requiresVerifiedFacts=false;
  const excludedCategories=new Set<string>(),excludedActivities=new Set<string>();
  const excludedAreas=new Set<'jubilee_hills'|'kokapet'>();
  for(const turn of turns){
    const topicTurn=unquoteParkRequest(turn);
    const intent=recommendationIntent(topicTurn),services=serviceCategoriesInTurn(topicTurn);
    effectiveScope=recommendationScope(turn,effectiveScope) as typeof effectiveScope;
    const exclusions=excludedAreaScopes(turn),tokens=words(turn);
    for(const area of ['jubilee_hills','kokapet'] as const){
      if(exclusions.includes(area))excludedAreas.add(area);
      else if(tokens.has(area==='kokapet'?'kokapet':'jubilee'))excludedAreas.delete(area);
    }
    const excludes=barWords.some(word=>negatedTerm(turn,word))||/\b(?:alcohol[- ]free|non[- ]alcoholic)\b/i.test(turn);
    if(excludes)noBars=true;
    else if(isPositiveBarRequest(turn))noBars=false;
    if(intent.requestedCategories.length||services.length){
      requestedCategories=intent.requestedCategories;
      requestedActivities=intent.requestedActivities;
      serviceCategories=services;
      for(const category of intent.requestedCategories)excludedCategories.delete(category);
      for(const activity of intent.requestedActivities)for(const alias of equivalentActivities(activity))excludedActivities.delete(alias);
    }
    for(const category of intent.excludedCategories)excludedCategories.add(category);
    for(const activity of intent.excludedActivities)for(const alias of equivalentActivities(activity))excludedActivities.add(alias);
    requestedCategories=requestedCategories.filter(category=>!excludedCategories.has(category));
    requestedActivities=requestedActivities.filter(activity=>!excludedActivities.has(activity));
    if(allowsUnverifiedFacts(turn))requiresVerifiedFacts=false;
    // Quotation marks can distinguish an earlier topic, but never weaken a
    // hard requirement such as only "wheelchair accessible" places.
    if(recommendationIntent(turn).requiresVerifiedFacts)requiresVerifiedFacts=true;
  }
  const resolvedIntent:RecommendationIntent={requestedCategories,excludedCategories:[...excludedCategories],requestedActivities,excludedActivities:[...excludedActivities],requiresVerifiedFacts};
  return {turns,intent:turns.join('. '),scope:effectiveScope,avoidBars:tasteAvoidBars||noBars,requestedCategories,serviceCategories,resolvedIntent,excludedAreas:[...excludedAreas]};
}
export function selectDiscoveryCandidates(places:CatalogPlace[],input:{messages:DiscoveryMessage[],scope:string,taste:{interests:string[],avoidBars:boolean},savedIDs:string[],discovery?:DiscoveryBrief},feedback:Pick<RankInput,'likedIDs'|'dismissedIDs'>={},limit=65) {
  const brief=input.discovery;
  const conversation=discoveryConversation(input.messages,input.scope,input.taste.avoidBars);
  const selected=brief?.categoryID?[brief.categoryID]:brief?conversation.serviceCategories:[];
  const selectedService=selected.some(id=>!outingIDs.has(id));
  const goal=selectedService?'service':brief?.goal??'discover';
  const parkIntent=discoveryParkIntent([...(brief?.query?[brief.query]:[]),...conversation.turns],places);
  const saved=new Set(input.savedIDs),selectedIDs=brief?.selectedPlaceIDs?new Set(brief.selectedPlaceIDs):undefined,seen=new Set<string>();
  const filtered=places.filter(place=>{
    if(!seen.has(place.id))seen.add(place.id);else return false;
    if(selectedIDs&&!selectedIDs.has(place.id))return false;
    if(brief&&!sourceBackedDiscoveryPlace(place))return false;
    const categories=discoveryCategories(place);
    if(selected.length&&!categories.some(id=>selected.includes(id)))return false;
    if(!selected.length&&!parkIntent.permits(place))return false;
    if(!selected.length&&goal==='outing'&&!canCreateDiscoveryOuting(place))return false;
    if(!selected.length&&goal==='service'&&!categories.some(id=>!outingIDs.has(id)))return false;
    if(brief?.savedOnly&&!saved.has(place.id))return false;
    return matchesDiscoveryQuery(place,brief?.query);
  });
  const canonicalCategories=selected.length?[...new Set(filtered.map(place=>place.category))]:undefined;
  const categories=canonicalCategories??(conversation.requestedCategories.length?conversation.requestedCategories:undefined);
  const purposefulCategories=canonicalCategories??(goal==='service'?[...new Set(filtered.map(place=>place.category))]:[]);
  const ranking=rankPlaces(filtered,{intent:conversation.intent,scope:conversation.scope,resolvedScope:conversation.scope,resolvedExcludedAreas:conversation.excludedAreas,
    avoidBars:input.taste.avoidBars,resolvedAvoidBars:conversation.avoidBars,resolvedIntent:conversation.resolvedIntent,categories,
    interests:[...new Set([...input.taste.interests,...purposefulCategories])],savedIDs:input.savedIDs,...feedback,limit});
  // Purpose eligibility shares the ranker's category signal, but a requested
  // directory is not evidence of a stored personal preference.
  const results=ranking.results.map(item=>{
    if(input.taste.interests.includes(item.place.category))return item;
    const reasons=item.reasons.filter(reason=>reason!==`You selected ${item.place.category} in your interests.`);
    return {...item,reasons:reasons.length?reasons:[goal==='service'?'A sourced listing matching the service discovery goal.':'Matches the selected discovery category.']};
  });
  return {...ranking,results,goal,categoryIDs:selected,brief,conversation,candidateCount:filtered.length};
}
export function emptyDiscoveryReply(result:ReturnType<typeof selectDiscoveryCandidates>) {
  const area=({jubilee_hills:'Jubilee Hills',kokapet:'Kokapet',hyderabad:'Hyderabad'} as Record<string,string>)[result.scope]??'the selected area';
  const requiredUnknown=result.exclusions.some(item=>item.reasons.includes('required_fact_unverified')||item.reasons.includes('verified_hours_unavailable'));
  const answer=requiredUnknown
    ? 'The sourced collection does not verify the facts this request requires. I cannot confirm a matching listing or substitute an unverified option.'
    : `No sourced listings match these filters in ${area}${result.brief?.savedOnly?' among your saved places':''}. Your category, area and exclusions have been kept; no other provider or category has been substituted.`;
  return {answer,recommendations:[],followUp:requiredUnknown?'To include listings with unverified facts, say “Show listings with unverified facts”.':'Would you like to change the area or search filter?'};
}
