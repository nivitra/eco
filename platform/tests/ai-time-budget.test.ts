import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planningSchema,planningStayContext,buildPlanningDraft} from '../src/modules/ai-planning.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='http://localhost:3000';
process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {profileSchema,prepareProfileUpdate}=await import('../src/modules/consumer.js');
const {aiRequestSchema}=await import('../src/modules/ai.js');
const stages=[{id:'coffee',categoryID:'cafes'},{id:'park',categoryID:'parks'}];
const startAtEpochMs=Date.UTC(2026,9,11,13,0);
const input={messages:[{role:'user' as const,content:'Find places for my activities'}],scope:'hyderabad',taste:{interests:[],avoidBars:false},savedIDs:[],discovery:{goal:'outing' as const,savedOnly:false}};
const place=(id:string,category:string):CatalogPlace=>({id,name:'Source '+id,category,neighborhood:'Jubilee Hills',
  address:'Public address',summary:'Source-listed venue',tags:[],sourceURLs:['https://example.org/'+id],
  researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});
const places=[place('coffee','cafes'),place('park','parks')];
const outing={id:'c7d7be68-407d-429b-97cb-a8790c85ca1a',title:'Chosen activities',placeIDs:['coffee','park'],createdAt:1791580800000};
const profile=(brief:unknown)=>profileSchema.parse({savedIDs:[],taste:{interests:[],pace:'Unhurried',avoidBars:false},outings:[{...outing,brief}]});
const allowed=new Set(['coffee','park']);

test('stage stays accept legacy omission and explicit null but only bounded integer minutes',()=>{
  const legacy=planningSchema.parse({stages});assert(!Object.hasOwn(legacy.stages[0],'visitMinutes'));
  for(const value of [null,5,30,480]){
    const parsed=aiRequestSchema.parse({...input,planning:{stages:[{...stages[0],visitMinutes:value},stages[1]],startAtEpochMs}});
    assert.equal(parsed.planning?.stages[0].visitMinutes,value);assert.equal(parsed.planning?.startAtEpochMs,startAtEpochMs);
    assert.equal(planningSchema.parse(JSON.parse(JSON.stringify(parsed.planning))).stages[0].visitMinutes,value);
  }
  for(const value of [-1,0,4,481,15.5,'30',true,{},NaN,Infinity])
    assert.throws(()=>planningSchema.parse({stages:[{...stages[0],visitMinutes:value},stages[1]]}));
});

test('partial stay context keeps unknown activities unknown and does not convert residual budget to travel time',()=>{
  const planning=planningSchema.parse({stages:[{...stages[0],visitMinutes:30},{...stages[1],visitMinutes:null}],durationMinutes:120});
  assert.deepEqual(planningStayContext(planning),{
    stages:[{id:'coffee',categoryID:'cafes',visitMinutes:30},{id:'park',categoryID:'parks',visitMinutes:null}],
    specifiedStageCount:1,requestedStageCount:2,desiredStayMinutes:30,allStaysSpecified:false,
    overallBudgetMinutes:120,budgetStatus:'fit_unverified',meaning:'user_preference',travelAndWaitingVerified:false,
  });
  const plan=buildPlanningDraft(places,input,planning).plan;
  assert(plan.checks.some(check=>check.includes('30 min across 1 of 2 activities')&&check.includes('Remaining stays')));
  assert.equal(planningStayContext(undefined),undefined);
  assert.equal(planningStayContext(planningSchema.parse({stages:stages.map(stage=>({...stage,visitMinutes:null}))})),undefined);
});

test('stays exceeding total budget are explicitly impossible before travel without changing sourced stop coverage',()=>{
  const legacy=buildPlanningDraft(places,input,planningSchema.parse({stages})).plan;
  const planning=planningSchema.parse({stages:stages.map(stage=>({...stage,visitMinutes:90})),durationMinutes:120,company:'friends',startAtEpochMs});
  const result=buildPlanningDraft(places,input,planning).plan;
  assert.deepEqual(result.stages,legacy.stages);
  assert.equal(result.status,'complete','status measures sourced coverage, not schedule feasibility');
  assert.equal(planningStayContext(planning)?.budgetStatus,'known_stays_exceed_budget');
  assert(result.checks.some(check=>check.includes('180 min, exceeding your 120 min budget before travel')));
  assert(result.checks.some(check=>check.includes('Target start:')));
  assert.equal(result.checks.length,8);assert(result.checks.every(check=>check.length<=220));
});

test('equal or lower chosen stays never claim a complete time fit and unspecified stages are never filled',()=>{
  for(const durationMinutes of [60,120]){
    const planning=planningSchema.parse({stages:stages.map(stage=>({...stage,visitMinutes:30})),durationMinutes});
    const result=buildPlanningDraft(places,input,planning).plan;
    assert.equal(planningStayContext(planning)?.budgetStatus,'fit_unverified');
    assert(result.checks.some(check=>durationMinutes===60?check.includes('full 60 min budget')&&check.includes('additional time'):
      check.includes('chosen stays total 60 min')&&check.includes('fit is unverified')));
    assert(result.stages.every(stage=>!Object.hasOwn(stage,'arrivalTime')&&!Object.hasOwn(stage,'visitMinutes')));
  }
  const partial=planningSchema.parse({stages:[{...stages[0],visitMinutes:180},stages[1]],durationMinutes:120});
  assert.equal(planningStayContext(partial)?.budgetStatus,'known_stays_exceed_budget','known subtotal already proves overrun');
});

test('an all-flexible legacy brief retains existing selection and checks exactly',()=>{
  const legacy=buildPlanningDraft(places,input,planningSchema.parse({stages})).plan;
  const flexible=buildPlanningDraft(places,input,planningSchema.parse({stages:stages.map(stage=>({...stage,visitMinutes:null}))})).plan;
  assert.deepEqual(flexible,legacy);
});

test('legacy stage omissions preserve matching stage identities through reordering and preserve prior start time',()=>{
  const prior=profile({stages:[{...stages[0],visitMinutes:30,pinnedPlaceID:'coffee'},{...stages[1],visitMinutes:60}],startAtEpochMs,durationMinutes:120});
  const echoed=profile({stages:[{...stages[1]},{...stages[0],pinnedPlaceID:'coffee'}],durationMinutes:180});
  const original=JSON.stringify(prior),originalEcho=JSON.stringify(echoed);
  const updated=prepareProfileUpdate(echoed,{revision:5,body:JSON.parse(original)},5,allowed);
  assert.deepEqual(updated.outings[0].brief?.stages.map(stage=>[stage.id,stage.visitMinutes]),[['park',60],['coffee',30]]);
  assert.equal(updated.outings[0].brief?.startAtEpochMs,startAtEpochMs);
  assert.equal(updated.outings[0].brief?.durationMinutes,180);
  assert.equal(JSON.stringify(prior),original);assert.equal(JSON.stringify(echoed),originalEcho);
});

test('changed stage identity category or pin cannot inherit an omitted old duration',()=>{
  const prior=profile({stages:[{...stages[0],visitMinutes:30,pinnedPlaceID:'coffee'},{...stages[1],visitMinutes:60}],startAtEpochMs});
  for(const changed of [
    {...stages[0],id:'new-coffee',pinnedPlaceID:'coffee'},
    {...stages[0],categoryID:'food',pinnedPlaceID:'coffee'},
    {...stages[0],pinnedPlaceID:'other-coffee'},
    {...stages[0]},
  ]){
    const updated=prepareProfileUpdate(profile({stages:[changed,stages[1]]}),{revision:5,body:prior},5,allowed);
    assert.equal(updated.outings[0].brief?.stages[0].visitMinutes,undefined);
    assert.equal(updated.outings[0].brief?.stages[1].visitMinutes,60);
  }
  const newPin=prepareProfileUpdate(profile({stages:[{...stages[0],pinnedPlaceID:'other-coffee',visitMinutes:45},stages[1]]}),{revision:5,body:prior},5,allowed);
  assert.equal(newPin.outings[0].brief?.stages[0].visitMinutes,45,'explicit reviewed preference survives a changed pin');
});

test('explicit stage null clears durably and explicit start clearing is independent of old stage preservation',()=>{
  const prior=profile({stages:stages.map(stage=>({...stage,visitMinutes:30})),startAtEpochMs});
  const clear=prepareProfileUpdate(profile({stages:[{...stages[0],visitMinutes:null},stages[1]],startAtEpochMs:null}),{revision:1,body:prior},1,allowed);
  assert.equal(clear.outings[0].brief?.startAtEpochMs,null);
  assert.deepEqual(clear.outings[0].brief?.stages.map(stage=>stage.visitMinutes),[null,30]);
  const echo=prepareProfileUpdate(profile({stages}),{revision:2,body:JSON.parse(JSON.stringify(clear))},2,allowed);
  assert.equal(echo.outings[0].brief?.startAtEpochMs,null);
  assert.deepEqual(echo.outings[0].brief?.stages.map(stage=>stage.visitMinutes),[null,30]);
});

test('deleted stages and outings stay deleted, invalid inherited duration fails, and stale revision fails before merge',()=>{
  const third={id:'other',categoryID:'games',visitMinutes:45};
  const prior=profile({stages:[...stages.map(stage=>({...stage,visitMinutes:30})),third]});
  const updated=prepareProfileUpdate(profile({stages}),{revision:1,body:prior},1,allowed);
  assert.deepEqual(updated.outings[0].brief?.stages.map(stage=>stage.id),['coffee','park']);
  assert.deepEqual(prepareProfileUpdate({...profile({stages}),outings:[]},{revision:1,body:prior},1,allowed).outings,[]);
  const corrupt={...prior,outings:[{...outing,brief:{stages:[{...stages[0],visitMinutes:481},stages[1]]}}]};
  assert.throws(()=>prepareProfileUpdate(profile({stages}),{revision:1,body:corrupt},1,allowed));
  assert.throws(()=>prepareProfileUpdate(profile({stages}),{revision:2,body:corrupt},1,allowed),error=>(error as {code?:string}).code==='version_conflict');
});
