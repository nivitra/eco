import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

test('authenticated planning HTTP keeps stage identity, explicit selection and deterministic provider fallback',{skip:process.env.RUN_DB_TESTS!=='true'},async()=>{
 const {app}=await import('../src/app.js');
 const {config}=await import('../src/config.js');
 const {pool,workerPool}=await import('../src/db.js');const {authPool}=await import('../src/auth.js');
 const {publicPlaces}=await import('../src/modules/consumer.js');
 const {sourceBackedDiscoveryPlace,canCreateDiscoveryOuting,discoveryCategories}=await import('../src/modules/ai-discovery.js');
 const oldFetch=globalThis.fetch,oldKey=config.deepseekKey;let calls=0,invalidModel=false;
 const startAtEpochMs=Date.UTC(2026,9,11,13,0);
 const adminURL=new URL(process.env.ADMIN_DATABASE_URL!);
 assert(['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname),'Planning fixtures require a local database');
 const fixturePool=new pg.Pool({connectionString:adminURL.toString(),max:1});const fixtureIDs:string[]=[];
 const suffix=randomUUID(),ip=`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4,8)}::75`;
 const request=(path:string,body:unknown,token?:string)=>app.request('http://localhost:3000'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Real-IP':ip,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 const decode=async(response:Response)=>{
  assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'private, no-store');
  const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6));
  assert.equal(events.at(-1),'[DONE]');assert.equal(JSON.parse(events[1]).choices[0].finish_reason,'stop');
  return JSON.parse(JSON.parse(events[0]).choices[0].delta.content);
 };
 globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),'https://api.deepseek.com/chat/completions','test must never call another external service');calls++;
  const body=JSON.parse(String(init?.body));const context=JSON.parse(body.messages[1].content);
  assert.equal(context.plan.stages.length,2);assert.equal(context.catalog.length,2);
  assert.equal(context.planning.startAtEpochMs,startAtEpochMs);
  assert.deepEqual(context.planningTiming,{startAtEpochMs,timeZone:'Asia/Kolkata',targetStartLocal:'11 Oct 2026, 18:30 IST',
    meaning:'user_preference',hoursAvailabilityVerified:false,futureTrafficVerified:false});
  assert.deepEqual(context.planningStays,{stages:[{id:'first',categoryID:'cafes',visitMinutes:30},{id:'second',categoryID:'cafes',visitMinutes:45}],
    specifiedStageCount:2,requestedStageCount:2,desiredStayMinutes:75,allStaysSpecified:true,overallBudgetMinutes:120,
    budgetStatus:'fit_unverified',meaning:'user_preference',travelAndWaitingVerified:false});
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'Model described the checked draft.',recommendations:invalidModel?[{placeID:'invented-provider-id',reason:'invalid'}]:[],followUp:null})}}]});
 };
 try{
  assert.equal((await request('/v1/ai/chat',{})).status,401);assert.equal(calls,0);
  const signup=await request('/api/auth/sign-up/email',{name:'Planning acceptance',email:`planning-${suffix}@example.test`,password:'Planning-acceptance-long-password!'});
  assert.equal(signup.status,200,await signup.clone().text());const token=signup.headers.get('set-auth-token');assert(token);
  const selected=(await publicPlaces()).filter(place=>sourceBackedDiscoveryPlace(place)&&canCreateDiscoveryOuting(place)&&discoveryCategories(place).includes('cafes')).slice(0,2).map(place=>place.id);
  assert.equal(selected.length,2,'test seed needs two sourced cafes');
  const body={messages:[{role:'user',content:'Make a draft from my selected cafes'}],scope:'hyderabad',savedIDs:selected,
   discovery:{goal:'outing',savedOnly:true,selectedPlaceIDs:selected},planning:{stages:[{id:'first',categoryID:'cafes',visitMinutes:30},{id:'second',categoryID:'cafes',visitMinutes:45}],company:'friends',budgetPerPersonINR:500,durationMinutes:120,startAtEpochMs}};
  config.deepseekKey='test-only-planning-provider-key';
  const success=await decode(await request('/v1/ai/chat',body,token));assert.equal(calls,1);assert.equal(success.answer,'Model described the checked draft.');
  assert.equal(success.plan.status,'complete');assert.deepEqual(success.plan.stages.map((stage:any)=>stage.id),['first','second']);
  assert.deepEqual(new Set(success.recommendations.map((card:any)=>card.placeID)),new Set(selected));
  assert.deepEqual(success.recommendations.map((card:any)=>card.placeID),success.plan.stages.map((stage:any)=>stage.placeID));
  const invalid=await request('/v1/ai/chat',{...body,discovery:{...body.discovery,selectedPlaceIDs:[selected[0],selected[0]]}},token);
  assert.equal(invalid.status,400);assert.equal(calls,1);
  config.deepseekKey='';const noKey=await decode(await request('/v1/ai/chat',body,token));assert.equal(calls,1);assert.deepEqual(noKey.plan,success.plan);
  config.deepseekKey='test-only-planning-provider-key';invalidModel=true;
  const invalidReply=await decode(await request('/v1/ai/chat',body,token));assert.equal(calls,2);assert.deepEqual(invalidReply.plan,success.plan);
  assert(!JSON.stringify(invalidReply).includes('invented-provider-id'));
  const empty=await decode(await request('/v1/ai/chat',{...body,messages:[{role:'user',content:'Only wheelchair accessible places'}]},token));
  assert.equal(calls,2);assert.equal(empty.plan.status,'empty');assert.deepEqual(empty.recommendations,[]);assert(empty.plan.stages.every((stage:any)=>stage.placeID===null));
  config.deepseekKey='';
  // Keep each independent acceptance journey below the production five/minute
  // limit; never relax quota enforcement to make the test pass.
  const refinementSignup=await request('/api/auth/sign-up/email',{name:'Refinement acceptance',email:`refinement-${suffix}@example.test`,password:'Refinement-acceptance-long-password!'});
  assert.equal(refinementSignup.status,200,await refinementSignup.clone().text());const refinementToken=refinementSignup.headers.get('set-auth-token');assert(refinementToken);
  const pinned={...body,planning:{...body.planning,stages:[{id:'first',categoryID:'cafes',pinnedPlaceID:selected[1]},{id:'second',categoryID:'cafes',pinnedPlaceID:selected[0]}]}};
  const pinnedReply=await decode(await request('/v1/ai/chat',pinned,refinementToken));
  assert.deepEqual(pinnedReply.plan.stages.map((stage:any)=>stage.placeID),[selected[1],selected[0]]);assert.equal(calls,2);
  const replacing={...pinned,planning:{...pinned.planning,stages:[{id:'first',categoryID:'cafes',excludedPlaceIDs:[selected[1]]},pinned.planning.stages[1]]}};
  const replacement=await decode(await request('/v1/ai/chat',replacing,refinementToken));
  assert.deepEqual(replacement.plan.stages.map((stage:any)=>stage.placeID),[null,selected[0]]);assert.equal(replacement.plan.status,'partial');
  assert.deepEqual(replacement.recommendations.map((card:any)=>card.placeID),[selected[0]]);
  // The default groups comparable sourced places; explicit relevance keeps the
  // original order of preference. Exercise actual persisted catalogue rows.
  const nearbySignup=await request('/api/auth/sign-up/email',{name:'Nearby acceptance',email:`nearby-${suffix}@example.test`,password:'Nearby-acceptance-long-password!'});
  assert.equal(nearbySignup.status,200,await nearbySignup.clone().text());const nearbyToken=nearbySignup.headers.get('set-auth-token');assert(nearbyToken);
  const sourceIDs=['bel-posto-the-cafe-jubilee-hills','eazydiner-649841','wikidata-q11219005'];
  const research=JSON.parse(await readFile(new URL('../data/research-places.json',import.meta.url),'utf8'));
  const independent=JSON.parse(await readFile(new URL('../data/independent-places.json',import.meta.url),'utf8'));
  const {upsertResearchPlace}=await import('../scripts/seed-catalog.js');
  const fixtureDB=await fixturePool.connect();
  try{
    for(const [index,sourceID] of sourceIDs.entries()){
      const source=[...research,...independent].find(place=>place.id===sourceID);assert(source,'sourced venue fixture must exist');
      const id=`nearby-http-${index}-${suffix}`;fixtureIDs.push(id);
      await upsertResearchPlace(fixtureDB,{...source,id});
    }
  }finally{fixtureDB.release();}
  const nearbyIDs=fixtureIDs;
  const catalogueIDs=new Set((await publicPlaces()).map(place=>place.id));assert(nearbyIDs.every(id=>catalogueIDs.has(id)),'local scoped fixtures must be visible');
  const nearbyBody={messages:[{role:'user',content:'Find a place for each activity in this outing. Show any missing matches and what I should check.'}],scope:'hyderabad',
    discovery:{goal:'outing',selectedPlaceIDs:nearbyIDs},planning:{stages:[{id:'coffee',categoryID:'cafes'},{id:'park',categoryID:'parks'}]}};
  const grouped=await decode(await request('/v1/ai/chat',nearbyBody,nearbyToken));
  assert.deepEqual(grouped.plan.stages.map((stage:any)=>stage.placeID),[nearbyIDs[1],nearbyIDs[2]]);
  assert.equal(grouped.plan.proximity.state,'grouped');assert.equal(grouped.plan.proximity.knownLegCount,1);assert.equal(grouped.plan.proximity.unknownLegCount,0);
  assert(grouped.plan.proximity.straightLineMetres>2700&&grouped.plan.proximity.straightLineMetres<2750);
  const relevance=await decode(await request('/v1/ai/chat',{...nearbyBody,planning:{...nearbyBody.planning,selectionMode:'relevance'}},nearbyToken));
  assert.deepEqual(relevance.plan.stages.map((stage:any)=>stage.placeID),[nearbyIDs[0],nearbyIDs[2]]);assert.equal(relevance.plan.proximity,undefined);
  const incomplete=await decode(await request('/v1/ai/chat',{...nearbyBody,planning:{...nearbyBody.planning,stages:[...nearbyBody.planning.stages,{id:'second-park',categoryID:'parks'}]}},nearbyToken));
  assert.equal(incomplete.plan.status,'partial');assert.equal(incomplete.plan.proximity.state,'unavailable');assert.equal(incomplete.plan.proximity.straightLineMetres,undefined);
  assert.equal(incomplete.plan.proximity.knownLegCount+incomplete.plan.proximity.unknownLegCount,2);
  for(const reply of [grouped,relevance,incomplete]){
    const ids=reply.plan.stages.flatMap((stage:any)=>stage.placeID?[stage.placeID]:[]);
    assert.equal(new Set(ids).size,ids.length);assert(ids.every((id:string)=>nearbyIDs.includes(id)));
    assert.deepEqual(reply.recommendations.map((card:any)=>card.placeID),ids);
  }
  assert.equal(calls,2,'geographic grouping must not make extra provider calls');
  const duplicatePins={...pinned,planning:{...pinned.planning,stages:pinned.planning.stages.map(stage=>({...stage,pinnedPlaceID:selected[0]}))}};
  assert.equal((await request('/v1/ai/chat',duplicatePins,refinementToken)).status,400);
  const conflictingPin={...pinned,planning:{...pinned.planning,stages:[{...pinned.planning.stages[0],excludedPlaceIDs:[selected[1]]},pinned.planning.stages[1]]}};
  assert.equal((await request('/v1/ai/chat',conflictingPin,refinementToken)).status,400);
 } finally {
  globalThis.fetch=oldFetch;config.deepseekKey=oldKey;
  try{if(fixtureIDs.length)await fixturePool.query('DELETE FROM places WHERE id=ANY($1::text[])',[fixtureIDs]);}
  finally{await Promise.all([fixturePool.end(),pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);}
 }
});
