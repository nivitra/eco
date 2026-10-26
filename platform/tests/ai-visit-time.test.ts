import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {planningSchema,planningTimingContext,buildPlanningDraft,planningReply} from '../src/modules/ai-planning.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='http://localhost:3000';
process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {aiRequestSchema,validatedAnswerStream}=await import('../src/modules/ai.js');
const brief={stages:[{id:'coffee',categoryID:'cafes'},{id:'park',categoryID:'parks'}]};
const startAtEpochMs=Date.UTC(2026,9,11,13,0);
const input={messages:[{role:'user' as const,content:'Find places for this draft'}],scope:'hyderabad',taste:{interests:[],avoidBars:false},savedIDs:[],discovery:{goal:'outing' as const,savedOnly:false}};
const place=(id:string,category:string):CatalogPlace=>({id,name:'Source '+id,category,neighborhood:'Jubilee Hills',
  address:'Public address',summary:'Source-listed venue',tags:[],sourceURLs:['https://example.org/'+id],
  researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});

test('selected start accepts bounded integer milliseconds, legacy omission and explicit flexible null',()=>{
  assert(!Object.hasOwn(planningSchema.parse(brief),'startAtEpochMs'));
  assert.equal(planningSchema.parse({...brief,startAtEpochMs:null}).startAtEpochMs,null);
  for(const value of [0,startAtEpochMs,4102444799999]){
    const parsed=aiRequestSchema.parse({messages:input.messages,planning:{...brief,startAtEpochMs:value}});
    assert.equal(parsed.planning?.startAtEpochMs,value);
    assert.equal(planningSchema.parse(JSON.parse(JSON.stringify(parsed.planning))).startAtEpochMs,value);
  }
  for(const value of [-1,4102444800000,0.5,Infinity,NaN,'2026-10-11',String(startAtEpochMs),{},true]){
    assert.throws(()=>planningSchema.parse({...brief,startAtEpochMs:value}));
  }
});

test('timing context uses fixed IST across date rollover and does not assert observations',()=>{
  const context=planningTimingContext(planningSchema.parse({...brief,startAtEpochMs}));
  assert.deepEqual(context,{startAtEpochMs,timeZone:'Asia/Kolkata',targetStartLocal:'11 Oct 2026, 18:30 IST',
    meaning:'user_preference',hoursAvailabilityVerified:false,futureTrafficVerified:false});
  const rollover=planningTimingContext(planningSchema.parse({...brief,startAtEpochMs:Date.UTC(2026,9,10,19,15)}));
  assert.equal(rollover?.targetStartLocal,'11 Oct 2026, 00:45 IST');
  assert.equal(planningTimingContext(planningSchema.parse({...brief,startAtEpochMs:0}))?.targetStartLocal,'01 Jan 1970, 05:30 IST');
  assert.equal(planningTimingContext(planningSchema.parse({...brief,startAtEpochMs:4102444799999}))?.targetStartLocal,'01 Jan 2100, 05:29 IST');
  assert.equal(planningTimingContext(undefined),undefined);
  assert.equal(planningTimingContext(planningSchema.parse(brief)),undefined);
  assert.equal(planningTimingContext(planningSchema.parse({...brief,startAtEpochMs:null})),undefined);
});

test('chosen time adds an honest mandatory check without changing coverage or inventing a timetable',()=>{
  const places=[place('coffee','cafes'),place('park','parks')];
  const baseline=buildPlanningDraft(places,input,planningSchema.parse(brief));
  for(const value of [0,startAtEpochMs]){
    const timed=buildPlanningDraft(places,input,planningSchema.parse({...brief,startAtEpochMs:value,durationMinutes:120,company:'friends'}));
    assert.deepEqual(timed.plan.stages,baseline.plan.stages);
    const timingChecks=timed.plan.checks.filter(check=>check.startsWith('Target start:'));
    assert.equal(timingChecks.length,1);
    assert(timingChecks[0].includes('This is your preference'));
    assert(timingChecks[0].includes('availability and future traffic are unverified'));
    assert(!timed.plan.checks.some(check=>check.startsWith('Current opening hours')));
    assert(timed.plan.checks.some(check=>check.includes('no schedule or travel-time fit')));
    assert(timed.plan.checks.length<=8&&timed.plan.checks.every(check=>check.length<=220));
    assert.equal(timed.plan.status,'complete');
    assert.equal(Object.hasOwn(timed.plan.stages[0],'arrivalTime'),false);
  }
  const flexible=buildPlanningDraft(places,input,planningSchema.parse({...brief,startAtEpochMs:null}));
  assert.deepEqual(flexible.plan,baseline.plan);
});

test('timing preference cannot bypass missing stages, selected IDs or unavailable factual requirements',()=>{
  const planning=planningSchema.parse({...brief,startAtEpochMs});
  const places=[place('coffee','cafes'),place('park','parks')];
  const onlyCoffee=buildPlanningDraft(places,{...input,discovery:{...input.discovery,selectedPlaceIDs:['coffee']}},planning);
  assert.equal(onlyCoffee.plan.status,'partial');
  assert.deepEqual(onlyCoffee.plan.stages.map(stage=>stage.placeID),['coffee',null]);
  const strict=buildPlanningDraft(places,{...input,messages:[{role:'user',content:'Only places open now'}]},planning);
  assert.equal(strict.plan.status,'empty');
  assert(strict.plan.checks.some(check=>check.includes('Target start:')));
});

test('deterministic provider fallback retains selected-time warning in complete SSE',async()=>{
  const draft=buildPlanningDraft([place('coffee','cafes'),place('park','parks')],input,planningSchema.parse({...brief,startAtEpochMs})).plan;
  const app=new Hono();app.get('/fixture',c=>validatedAnswerStream(c,planningReply(draft)));
  const response=await app.request('/fixture');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6));
  assert.equal(events.at(-1),'[DONE]');
  const reply=JSON.parse(JSON.parse(events[0]).choices[0].delta.content);
  assert.deepEqual(reply.plan,draft);
  assert(reply.plan.checks.some((check:string)=>check.includes('11 Oct 2026, 18:30 IST')));
});
