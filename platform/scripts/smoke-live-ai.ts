/** Opt-in: consumes one configured provider request. Run only in an isolated acceptance database. */
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {app} from '../src/app.js';
import {pool,workerPool} from '../src/db.js';
import {authPool} from '../src/auth.js';
if(process.env.RUN_LIVE_AI!=='true')throw new Error('Set RUN_LIVE_AI=true to allow one live DeepSeek request');
try{
 const auth=await app.request('http://localhost:3000/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json','X-Real-IP':'192.0.2.249'},body:JSON.stringify({name:'Provider acceptance',email:`provider-${randomUUID()}@example.test`,password:'One-live-provider-acceptance!'})});
 assert.equal(auth.status,200);const token=auth.headers.get('set-auth-token');assert.ok(token);
 const start=Date.now();const response=await app.request('http://localhost:3000/v1/ai/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({messages:[{role:'user',content:'I want coffee and an art stop in Jubilee Hills. No bars. Give me a short plan and explain what I should confirm before going.'}],taste:{interests:['cafes','art'],pace:'Unhurried',avoidBars:true},scope:'jubilee_hills'})});
 const text=await response.text();assert.equal(response.status,200,text);assert.ok(text.includes('[DONE]'));
 const frames=text.split('\n').filter(s=>s.startsWith('data: ')&&!s.includes('[DONE]')).map(s=>JSON.parse(s.slice(6)));
 const content=frames.map(f=>f.choices?.[0]?.delta?.content||'').join('');const reply=JSON.parse(content);assert.ok(reply.answer.length>0);assert.ok(reply.recommendations.length>0);assert.ok(reply.recommendations.every((r:any)=>typeof r.placeID==='string'));
 console.log(JSON.stringify({provider:'DeepSeek',authenticated:true,status:response.status,terminalMarker:true,elapsedMs:Date.now()-start,recommendationIDs:reply.recommendations.map((r:any)=>r.placeID)},null,2));
}finally{await Promise.all([pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);}
