import type { CatalogPlace } from './consumer.js';

export const RECOMMENDATION_POLICY='intent-evidence-diversity-1';
const terms:Record<string,string[]>={cafes:['cafe','cafes','coffee','espresso','cappuccino','dessert','desserts'],food:['food','dinner','lunch','restaurant','restaurants','biryani','breakfast'],art:['art','gallery','galleries','exhibition','exhibitions','culture'],heritage:['heritage','history','historic','culture','temple','temples'],nature:['nature','park','parks','walk','walking','outdoors','greenery'],nightlife:['nightlife','bar','bars','cocktail','cocktails','brewery','breweries','drinks'],shopping:['shopping','shop','boutique','leather','retail'],wellness:['wellness','spa','yoga','fitness'],parks:['nature','park','parks','walk','walking','outdoors','greenery'],healthcare:['healthcare','hospital','hospitals','clinic','clinics','pharmacy','pharmacies'],stationery:['stationery','pens','pencils','notebooks','printing'],community:['community','centre','center','library','libraries']};
export type RecommendationIntent={requestedCategories:string[],excludedCategories:string[],requestedActivities:string[],excludedActivities:string[],requiresVerifiedFacts:boolean};
export type RankInput={intent?:string,scope?:string,interests?:string[],avoidBars?:boolean,savedIDs?:string[],likedIDs?:string[],dismissedIDs?:string[],positiveTags?:string[],negativeTags?:string[],excludedCategories?:string[],category?:string,categories?:string[],resolvedScope?:'jubilee_hills'|'kokapet'|'hyderabad',resolvedAvoidBars?:boolean,resolvedExcludedAreas?:('jubilee_hills'|'kokapet')[],resolvedIntent?:RecommendationIntent,limit?:number,distances?:Record<string,number>,requireVerifiedOpen?:boolean};
terms.education=['education','university','universities','college','colleges','campus','campuses','school','schools','institute'];
terms.transport=['transport','transit','metro','station','stations','railway','train','trains','airport','airports','bus'];
terms.sports=['sports','sport','badminton','cricket','football','soccer','tennis','basketball','swimming','volleyball','pickleball','skating'];
terms.games=['games','gaming','game','arcade','bowling','snooker','billiards','paintball','karting','esports'];
terms.shopping.push('bookshop','bookshops','bookstore','bookstores','books','market','markets');
terms.community.push('cinema','cinemas','movie','movies','film');
const activities=Object.fromEntries(['badminton','cricket','football','soccer','tennis','basketball','swimming','volleyball','pickleball','skating','arcade','bowling','snooker','billiards','paintball','karting','esports'].map(v=>[v,v==='soccer'?['football','soccer']:v==='football'?['football','soccer']:[v]]));
export type RankedPlace={place:CatalogPlace,score:number,reasons:string[],cautions:string[],distanceMetres?:number};
export function words(value:string):Set<string>{return new Set(value.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]);}
const normalized=(s:string)=>[...words(s)].join(' ');
// These describe collection provenance, not a reason to visit. Keep the tags
// available to source/eligibility code but out of every tag-affinity score.
// Use exact labels: "Pet-friendly listing" and names such as "Source Cafe"
// still carry their ordinary semantic meaning.
const administrativeTags=new Set(['listing sourced','official branch source','access unverified']);
const semanticTags=(tags:readonly string[])=>tags.filter(tag=>!administrativeTags.has(normalized(tag)));
const lexicalStopWords=new Set(['a','an','the','and','or','but','for','to','of','in','on','at','from','with','by','as','is','are','was','were','be','been','being','it','its','this','that','these','those','i','me','my','we','our','us','you','your','they','their','them','please','find','show','suggest','recommend','plan','each','any','some','all','then','can','could','would','should','do','does','did','help','what','which','where','when','how']);
/** Lexical affinity is separate from intent parsing. Function words must not
 * make a memorial win because its name contains "for". These location terms
 * already define this catalogue or its explicit area/exclusion constraints.
 */
function lexicalTokens(tokens:Set<string>):Set<string> {
  const localities=new Set(['hyderabad','telangana','india','kokapet','jubilee']);
  if(tokens.has('jubilee'))localities.add('hills');
  return new Set([...tokens].filter(word=>!lexicalStopWords.has(word)&&!localities.has(word)));
}
const bars=(p:CatalogPlace)=>p.category==='nightlife'||/\b(bars?|pubs?|brewpub|brewery|brewing|cocktails?)\b/i.test([p.name,...p.tags].join(' '));
export function belongsToArea(p:CatalogPlace,area:'jubilee_hills'|'kokapet'):boolean {
  if(/\b(demo|fictional|synthetic)\b/i.test([p.name,p.summary,...p.tags].join(' ')))return false;
  const text=' '+[...p.neighborhood.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]].join(' ')+' ';
  const name=area==='kokapet'?'kokapet':'jubilee hills',short=area==='kokapet'?'kokapet':'jubilee';
  return text.includes(' '+name+' ')&&!['outside','outside of','near','near to','not in','adjacent to','close to','beyond'].some(prefix=>text.includes(' '+prefix+' '+short+' '));
}
export function excludedAreaScopes(intent:string):('jubilee_hills'|'kokapet')[] {
  const text=intent.normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase().replace(/[’']/g,' ');
  const negation='(?:not|never|exclude|excluding|skip|avoid|without|except|no|do not want|don t want)';
  const prefix='\\b'+negation+'\\s+(?:(?:any|places?|stops?|venues?|options?)\\s+)*(?:(?:in|from)\\s+)?';
  return (['jubilee_hills','kokapet'] as const).filter(scope=>new RegExp(prefix+(scope==='kokapet'?'kokapet':'jubilee(?:\\s+hills)?')+'\\b').test(text));
}
export function recommendationScope(intent:string,requested='jubilee_hills'):string {
  const text=normalized(intent), tokens=words(intent);
  const excluded=new Set(excludedAreaScopes(intent));
  if(excluded.size===2)return 'hyderabad';
  if(excluded.has('jubilee_hills'))return tokens.has('kokapet')?'kokapet':requested==='jubilee_hills'?'hyderabad':requested;
  if(excluded.has('kokapet'))return tokens.has('jubilee')?'jubilee_hills':requested==='kokapet'?'hyderabad':requested;
  const restricted=(area:string)=>new RegExp('\\b(nothing|not|never|no places) outside '+area+'\\b').test(text)||new RegExp('\\b(stay|remain|only|keep)\\b.{0,30}\\b'+area+'\\b').test(text);
  if(restricted('kokapet')&&!restricted('jubilee'))return 'kokapet';
  if(restricted('jubilee')&&!restricted('kokapet'))return 'jubilee_hills';
  const wider=/\b(all hyderabad|across hyderabad|whole city|wider hyderabad)\b/.test(text)||/\b(go|explore|search|include|suggest|find|try|visit)\b.{0,18}\b(outside|beyond) (jubilee|kokapet)\b/.test(text);
  if(wider&&!negatedTerm(intent,'hyderabad')&&!negatedTerm(intent,'outside')&&!negatedTerm(intent,'beyond'))return 'hyderabad';
  if(tokens.has('jubilee')&&tokens.has('kokapet'))return 'hyderabad';
  if(tokens.has('kokapet'))return 'kokapet';
  if(tokens.has('jubilee'))return 'jubilee_hills';
  return ['jubilee_hills','kokapet','hyderabad'].includes(requested)?requested:'jubilee_hills';
}
function overlap(a:Set<string>,b:Set<string>){return [...a].filter(x=>b.has(x)).length;}
function jaccard(a:Set<string>,b:Set<string>){const common=overlap(a,b);return common/Math.max(1,a.size+b.size-common);}

/** Negation applies within a clause and a short preceding window; "not just" is additive. */
export function negatedTerm(intent:string,term:string):boolean {
  return intent.toLowerCase().split(/[.;!?]|,|\bbut\b/).some(clause=>{
    const list=[...words(clause)];
    return list.some((word,index)=>{
      if(word!==term)return false;
      const prior=list.slice(Math.max(0,index-6),index).join(' ').replace(/\bnot (only|just)\b/g,'also').replace(/\b(don t|do not) mind\b/g,'accept');
      return /\b(no|not|without|avoid|skip|exclude|never|nothing|don t)\b/.test(prior);
    });
  });
}

/** Parse one user turn only. Conversation callers resolve these axes before ranking. */
export function recommendationIntent(intent:string):RecommendationIntent {
  const tokens=words(intent),wanted=new Set<string>(),excluded=new Set<string>();
  for(const [category,aliases] of Object.entries(terms)) {
    if(aliases.some(x=>tokens.has(x)))wanted.add(category);
    const relevant=aliases.filter(x=>!['sports','games'].includes(category)||!(x in activities));
    if(relevant.some(x=>negatedTerm(intent,x))){excluded.add(category);wanted.delete(category);}
    if(['sports','games'].includes(category)&&!aliases.some(x=>tokens.has(x)&&!negatedTerm(intent,x)))wanted.delete(category);
  }
  return {requestedCategories:[...wanted],excludedCategories:[...excluded],
    requestedActivities:Object.keys(activities).filter(term=>tokens.has(term)&&!negatedTerm(intent,term)),
    excludedActivities:Object.keys(activities).filter(term=>negatedTerm(intent,term)),
    requiresVerifiedFacts:/\b(only|must|require|required)\b.{0,40}\b(vegan|wheelchair|accessible|gluten free|allergen|open now|under \d|below \d)/.test(normalized(intent))};
}
export function equivalentActivities(term:string):string[]{return activities[term]??[term];}

/** Hard eligibility precedes bounded scoring; feedback is explicit, never inferred from location history. */
export function rankPlaces(places:CatalogPlace[],input:RankInput={}) {
  const intent=input.intent?.trim()??'';const text=normalized(intent);const tokens=words(intent);
  const scoringTokens=lexicalTokens(tokens);
  const scope=input.resolvedScope??recommendationScope(intent,input.scope);
  const excludedAreas=input.resolvedExcludedAreas??excludedAreaScopes(intent);
  const avoidBars=!!input.avoidBars||(input.resolvedAvoidBars??(['bar','bars','pub','pubs','nightlife','alcohol'].some(t=>negatedTerm(intent,t))||/\b(alcohol free|non alcoholic)\b/.test(text)));
  const resolved=input.resolvedIntent??recommendationIntent(intent);
  const wanted=new Set(resolved.requestedCategories);
  const excluded=new Set([...(input.excludedCategories??[]),...resolved.excludedCategories.filter(category=>!(category==='nightlife'&&input.resolvedAvoidBars===false))]);
  if(avoidBars){excluded.add('nightlife');wanted.delete('nightlife');}
  if(input.category){wanted.clear();wanted.add(input.category);}
  else if(input.categories){wanted.clear();for(const category of input.categories)wanted.add(category);}
  const dismissed=new Set(input.dismissedIDs??[]),liked=new Set(input.likedIDs??[]),saved=new Set(input.savedIDs??[]);
  const interests=new Set(input.interests??[]),positive=words(semanticTags(input.positiveTags??[]).join(' ')),negative=words(semanticTags(input.negativeTags??[]).join(' '));
  const affinity=new Map<string,number>();for(const p of places)if(saved.has(p.id)||liked.has(p.id))affinity.set(p.category,(affinity.get(p.category)??0)+1);
  const cautions:string[]=[];
  if(/\b(open|now|today|tonight|late|hours)\b/.test(text))cautions.push('Current hours and availability are unverified; check the venue before going.');
  if(/\b(budget|cheap|price|under|affordable|rupees)\b/.test(text)||intent.includes('₹'))cautions.push('Prices are unverified; the budget cannot be guaranteed.');
  if(/\b(quiet|conversation|crowd|crowds|crowded|busy|footfall|popular|best)\b/.test(text))cautions.push('No live noise, crowd or measured popularity information is available.');
  if(/\b(walk|walking|nearby|closest|route|traffic|minutes)\b/.test(text))cautions.push('Map distance is not walking or driving time. Obtain a route before travelling.');
  if(wanted.has('sports')||wanted.has('games'))cautions.push('Booking slots, equipment, entry requirements and public access are unverified; confirm with the venue.');
  if(avoidBars)cautions.push('Bars and nightlife are excluded; alcohol-free service is not certified.');
  if(/\b(vegan|vegetarian|allergen|allergies|gluten|halal)\b/.test(text))cautions.push('Dietary suitability and allergen handling are unverified. Confirm with the venue directly.');
  if(/\b(accessible|accessibility|wheelchair|step free)\b/.test(text))cautions.push('Step-free access and accessible entrances are unverified. Confirm access before going.');
  const strictUnknown=input.requireVerifiedOpen||resolved.requiresVerifiedFacts;
  const exclusions:{placeID:string,reasons:string[]}[]=[];
  const candidates:RankedPlace[]=[];
  const tagEvidence=new Map<CatalogPlace,Set<string>>();
  for(const p of places) {
    const deny:string[]=[];
    if(['closed','withdrawn','merged'].includes(p.status))deny.push('inactive');
    if((scope==='jubilee_hills'||scope==='kokapet')&&!belongsToArea(p,scope))deny.push('outside_scope');
    if(excludedAreas.some(area=>belongsToArea(p,area)))deny.push('explicitly_excluded_area');
    if(excluded.has(p.category)||(avoidBars&&bars(p)))deny.push('excluded_category_or_bar');
    if(wanted.size&&!wanted.has(p.category))deny.push('intent_category_mismatch');
    if(['sports','games'].includes(p.category)){
      const placeTerms=words([p.name,...p.tags].join(' '));
      if(resolved.requestedActivities.length&&!resolved.requestedActivities.some(term=>equivalentActivities(term).some(alias=>placeTerms.has(alias))))deny.push('requested_activity_not_sourced');
      if(resolved.excludedActivities.some(term=>equivalentActivities(term).some(alias=>placeTerms.has(alias))))deny.push('explicitly_excluded_activity');
    }
    const namedTarget=normalized(p.name).length>3&&(' '+text+' ').includes(' '+normalized(p.name)+' ');
    if(['healthcare','education','transport'].includes(p.category)&&!wanted.has(p.category)&&!interests.has(p.category)&&!saved.has(p.id)&&!namedTarget)
      deny.push('purpose_specific_category_requires_intent');
    if(dismissed.has(p.id))deny.push('explicitly_dismissed');
    if(strictUnknown)deny.push(input.requireVerifiedOpen?'verified_hours_unavailable':'required_fact_unverified');
    if(deny.length){exclusions.push({placeID:p.id,reasons:deny});continue;}
    let score=0;const reasons:string[]=[];
    if(wanted.has(p.category)){score+=24;reasons.push(`Matches your request for ${p.category}.`);}
    if(interests.has(p.category)){score+=6;reasons.push(`You selected ${p.category} in your interests.`);}
    const nameWords=words(p.name);const nameMatches=overlap(scoringTokens,nameWords);score+=Math.min(25,nameMatches*7);
    if(nameMatches)reasons.push('The place name matches your request.');
    const scoringTags=semanticTags(p.tags);
    const matchingTags=scoringTags.filter(t=>overlap(words(t),scoringTokens)>0);score+=Math.min(18,matchingTags.length*6);
    if(matchingTags.length)reasons.push(`Source/editorial tags match: ${matchingTags.slice(0,2).join(', ')}.`);
    const tagWords=words(scoringTags.join(' '));tagEvidence.set(p,tagWords);
    const positiveMatches=overlap(tagWords,positive),negativeMatches=overlap(tagWords,negative);
    score+=Math.min(12,positiveMatches*4)-Math.min(18,negativeMatches*6);
    if(positiveMatches)reasons.push('Matches tags you explicitly prefer.');
    if(negativeMatches)reasons.push('Some source tags overlap your dislikes; ranked lower.');
    const prior=affinity.get(p.category)??0;if(prior){score+=Math.min(3,prior)*1.5;reasons.push(`Inspired by your explicitly saved or liked ${p.category} places.`);}
    if(liked.has(p.id)){score+=5;reasons.push('You explicitly liked this place.');}
    if(saved.has(p.id)){score+=1;reasons.push('Already in your saved places.');}
    if(tokens.has('date')&&['cafes','food','art','nature','parks'].includes(p.category)){score+=p.category==='cafes'?5:3;reasons.push('An editorial date option based on its category; availability is unconfirmed.');}
    if(tokens.has('friends')&&['cafes','food','nightlife'].includes(p.category)){score+=3;reasons.push('An editorial meeting option; group capacity is not verified.');}
    if((tokens.has('landmarks')||tokens.has('iconic')||tokens.has('sightseeing'))&&['heritage','nature','parks'].includes(p.category)){score+=8;reasons.push('A sourced city landmark or nature stop.');}
    const distance=input.distances?.[p.id];const measured=distance!==undefined&&Number.isFinite(distance)&&distance>=0;
    if(measured){score+=4/(1+distance/1500);reasons.push(`Mapped feature is ${Math.round(distance)} metres away in a straight line; this is not route distance.`);}
    if(!reasons.length)reasons.push(`A sourced ${p.category} option in ${p.neighborhood}.`);
    candidates.push({place:p,score,reasons,cautions:[...cautions],...(measured?{distanceMetres:distance}:{})});
  }
  const selected:RankedPlace[]=[];const remaining=[...candidates];const requested=new Set([...wanted].filter(c=>remaining.some(x=>x.place.category===c)));
  const limit=Math.max(1,Math.min(65,Math.floor(input.limit??12)));
  while(remaining.length&&selected.length<limit) {
    const unseen=remaining.filter(x=>requested.has(x.place.category));const pool=unseen.length?unseen:remaining;
    const utility=(candidate:RankedPlace)=> {
      const categoryCount=selected.filter(x=>x.place.category===candidate.place.category).length;
      const neighborhoodCount=selected.filter(x=>normalized(x.place.neighborhood)===normalized(candidate.place.neighborhood)).length;
      const redundancy=selected.reduce((max,x)=>Math.max(max,jaccard(tagEvidence.get(x.place)!,tagEvidence.get(candidate.place)!)),0);
      return candidate.score-categoryCount*5-neighborhoodCount*0.75-redundancy*5;
    };
    pool.sort((a,b)=>utility(b)-utility(a)||a.place.id.localeCompare(b.place.id));
    const best=pool[0];remaining.splice(remaining.indexOf(best),1);requested.delete(best.place.category);
    selected.push({...best,reasons:[...best.reasons,...(selected.length?['Selection balances category and source-tag variety.']:[])]});
  }
  return {policyVersion:RECOMMENDATION_POLICY,scope,avoidBars,requestedCategories:[...wanted],results:selected,exclusions,unavailableChecks:['current_hours','live_traffic','live_crowds','prices','verified_entrances']};
}
