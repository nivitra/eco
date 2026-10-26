import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {canvasSchema,canvasMatchesRecommendations,CANVAS_SYSTEM} from '../src/modules/ai-canvas.js';
import {planningSchema,buildPlanningDraft,planningReply} from '../src/modules/ai-planning.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
process.env.PUBLIC_URL??='https://kulture.example';process.env.BETTER_AUTH_SECRET??='test-only-canvas-auth-secret-never-production';process.env.OPS_TOKEN??='test-only-canvas-token-never-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {aiRequestSchema,validateReply,validatedAnswerStream}=await import('../src/modules/ai.js');
const canvas=(extra={})=>({version:1,layout:'collection',title:'A few options',refinements:['narrow','checks'],...extra});
const reply=(extra={})=>({answer:'These are sourced options.',recommendations:[{placeID:'cafe',reason:'Matches the selected category.'},{placeID:'park',reason:'Matches the selected category.'}],followUp:null,...extra});
const allowed=new Set(['cafe','park']);
const errorCode=(code:string)=>(error:any)=>error?.code===code;

test('presentation is opt-in and versioned without changing legacy request or reply',()=>{
 const old={messages:[{role:'user',content:'Coffee'}]};assert.equal(aiRequestSchema.parse(old).presentationVersion,undefined);
 assert.equal(aiRequestSchema.parse({...old,presentationVersion:1}).presentationVersion,1);
 for(const version of [0,2,'1',null])assert(!aiRequestSchema.safeParse({...old,presentationVersion:version}).success);
 assert.deepEqual(validateReply(reply(),allowed),reply());
});
test('canvas permits only a bounded native vocabulary and no executable actions or arbitrary place data',()=>{
 assert(canvasSchema.safeParse(canvas()).success);
 for(const extra of [{version:2},{layout:'html'},{title:''},{title:'a'.repeat(81)},{title:'😀'.repeat(41)},
  {refinements:['checks','checks']},{refinements:['book']},{refinements:['narrow','checks','alternatives','checks']},
  {actions:[{url:'javascript:alert(1)'}]},{html:'<script>alert(1)</script>'},{url:'https://attacker.example'},
  {places:[{id:'invented',latitude:17.4,longitude:78.4}]}])assert(!canvasSchema.safeParse(canvas(extra)).success,JSON.stringify(extra));
 assert(canvasSchema.safeParse(canvas({title:'😀'.repeat(40)})).success);
 assert(CANVAS_SYSTEM.includes('Never generate code, URLs'));
});
test('each layout checks membership against the actual recommendation cards',()=>{
 assert(canvasMatchesRecommendations(canvasSchema.parse(canvas()),['cafe']));
 assert(!canvasMatchesRecommendations(canvasSchema.parse(canvas()),[]));
 assert(canvasMatchesRecommendations(canvasSchema.parse(canvas({layout:'comparison'})),['cafe','park']));
 assert(!canvasMatchesRecommendations(canvasSchema.parse(canvas({layout:'comparison'})),['cafe']));
 assert(canvasMatchesRecommendations(canvasSchema.parse(canvas({layout:'spotlight',focusPlaceID:'park'})),['cafe','park']));
 for(const focusPlaceID of [undefined,'outside'])assert(!canvasMatchesRecommendations(canvasSchema.parse(canvas({layout:'spotlight',focusPlaceID})),['cafe','park']));
 for(const layout of ['collection','comparison'])assert(!canvasMatchesRecommendations(canvasSchema.parse(canvas({layout,focusPlaceID:'cafe'})),['cafe','park']));
});
test('model canvas cannot bypass hard ID allowlist, duplication checks, or empty collection',()=>{
 for(const recommendations of [[{placeID:'outside',reason:'x'}],[{placeID:'cafe',reason:'x'},{placeID:'cafe',reason:'y'}]])
  assert.throws(()=>validateReply(reply({recommendations,canvas:canvas()}),allowed),errorCode('invalid_ai_recommendation'));
 assert.throws(()=>validateReply(reply({recommendations:[],canvas:canvas()}),allowed),errorCode('invalid_ai_canvas'));
 assert.throws(()=>validateReply(reply({canvas:canvas({layout:'spotlight',focusPlaceID:'outside'})}),allowed),errorCode('invalid_ai_canvas'));
 assert.throws(()=>validateReply(reply({recommendations:[{placeID:'cafe',reason:'x'}],canvas:canvas({layout:'comparison'})}),allowed),errorCode('invalid_ai_canvas'));
 const valid=validateReply(reply({canvas:canvas({layout:'spotlight',focusPlaceID:'park'})}),allowed);
 assert.equal(valid.canvas?.focusPlaceID,'park');assert.deepEqual(valid.recommendations.map(p=>p.placeID),['cafe','park']);
});
test('provider cannot add a plan and a valid canvas does not survive server-owned plan normalization',()=>{
 assert.throws(()=>validateReply(reply({plan:{stages:[]}}),allowed),errorCode('invalid_ai_response'));
 const place=(id:string,category:string):CatalogPlace=>({id,name:id,category,neighborhood:'Jubilee Hills',address:'Hyderabad',summary:'A sourced public listing',tags:[],sourceURLs:['https://source.example/'+id],researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});
 const request={messages:[{role:'user' as const,content:'Help plan this outing'}],scope:'hyderabad',taste:{interests:[],avoidBars:false},savedIDs:[],discovery:{goal:'outing' as const,savedOnly:false}};
 const brief=planningSchema.parse({stages:[{id:'coffee',categoryID:'cafes'},{id:'outside',categoryID:'parks'}]});
 const draft=buildPlanningDraft([place('cafe','cafes'),place('park','parks')],request,brief);
 const normalized=planningReply(draft.plan,validateReply(reply({canvas:canvas({layout:'comparison'})}),allowed));
 assert(!('canvas' in normalized));assert.deepEqual(normalized.recommendations.map(card=>card.placeID),['cafe','park']);assert.deepEqual(normalized.plan.stages.map(stage=>stage.placeID),['cafe','park']);
});
test('validated canvas is emitted as inert JSON inside complete private SSE, never provider code',async()=>{
 const data=validateReply(reply({canvas:canvas({title:'<script>alert(1)</script>'})}),allowed),app=new Hono();
 app.get('/fixture',c=>validatedAnswerStream(c,data));const response=await app.request('/fixture');
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert(response.headers.get('content-type')?.startsWith('text/event-stream'));
 const events=(await response.text()).split('\n\n').map(event=>event.trim()).filter(Boolean);
 assert.equal(events.at(-1),'data: [DONE]');const chunks=events.slice(0,-1).map(event=>JSON.parse(event.replace(/^data: /,'')));
 assert.equal(chunks[1].choices[0].finish_reason,'stop');const decoded=JSON.parse(chunks[0].choices[0].delta.content);
 assert.deepEqual(decoded,data);assert(decoded.canvas);assert.deepEqual(Object.keys(decoded.canvas).sort(),['layout','refinements','title','version']);
});
