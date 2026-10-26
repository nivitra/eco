import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const enabled=process.env.RUN_DB_TESTS==='true';
test('real auth, tenant RLS, quotas, idempotency, profile conflicts and revocation', {skip:!enabled},async()=>{
 const {app}=await import('../src/app.js');const {pool,workerPool,withActor,consumeQuota}=await import('../src/db.js');const {authPool}=await import('../src/auth.js');
 const suffix=randomUUID();let ip=100;const ipPrefix=`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4,8)}`;
 const request=(path:string,method='GET',body?:unknown,token?:string,extra:Record<string,string>={})=>app.request('http://localhost:3000'+path,{method,headers:{'Content-Type':'application/json','X-Real-IP':`${ipPrefix}::${ip}`,...(token?{Authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const signup=async(label:string)=>{ip++;const response=await request('/api/auth/sign-up/email','POST',{name:label,email:`${label}-${suffix}@example.test`,password:'Kulture-test-long-secret!'});assert.equal(response.status,200,await response.clone().text());const token=response.headers.get('set-auth-token');assert.ok(token,'signed bearer token issued');return token;};
 try{
  const a=await signup('alice'),b=await signup('bob');const meA=await (await request('/v1/me','GET',undefined,a)).json() as any;const meB=await (await request('/v1/me','GET',undefined,b)).json() as any;
  assert.equal((await request('/v1/me','GET',undefined,'forged')).status,401);
  const key=randomUUID();const tenant=await request('/v1/tenants','POST',{name:'Tenant A'},a,{'Idempotency-Key':key});assert.equal(tenant.status,201,await tenant.clone().text());const ta=await tenant.json() as any;
  const replay=await (await request('/v1/tenants','POST',{name:'Tenant A'},a,{'Idempotency-Key':key})).json() as any;assert.equal(replay.id,ta.id);
  assert.equal((await request('/v1/tenants','POST',{name:'Different'},a,{'Idempotency-Key':key})).status,409);
  assert.equal((await request(`/v1/tenants/${ta.id}/members`,'GET',undefined,b)).status,404);
  const isolation=await withActor(meB.user.id,db=>db.query('SELECT id FROM tenants WHERE id=$1',[ta.id]));assert.equal(isolation.rowCount,0);
  const role=await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');assert.equal(role.rows[0].rolsuper,false);assert.equal(role.rows[0].rolbypassrls,false);
  const catalog=await (await request('/v1/catalog')).json() as any;assert.ok(catalog.places.length>=37);assert.equal(catalog.coverage.verifiedEntrances,0);
  const ga=await request('/v1/profile','GET',undefined,a),gb=await request('/v1/profile','GET',undefined,b);const profile=(await ga.clone().json() as any).profile;profile.savedIDs=[catalog.places[0].id];
  const saved=await request('/v1/profile','PUT',profile,a,{'If-Match':ga.headers.get('etag')!});assert.equal(saved.status,200,await saved.clone().text());
  assert.equal((await request('/v1/profile','PUT',profile,a,{'If-Match':ga.headers.get('etag')!})).status,412);
  assert.deepEqual((await gb.json() as any).profile.savedIDs,[]);
  assert.equal((await request('/v1/profile','PUT',profile,a)).status,428);
  await consumeQuota('test:'+suffix,1,60);await assert.rejects(consumeQuota('test:'+suffix,1,60),{code:'rate_limited'});
  assert.equal((await request('/v1/routes','POST',{origin:{latitude:17.4,longitude:78.4},destinationPlaceID:catalog.places[0].id,mode:'driving'},a)).status,503);
  const billing=await request(`/v1/tenants/${ta.id}/billing/checkout`,'POST',{placeID:catalog.places[0].id},a,{'Idempotency-Key':randomUUID()});assert.equal(billing.status,503);
  const logout=await request('/api/auth/sign-out','POST',{},a);assert.equal(logout.status,200);assert.equal((await request('/v1/me','GET',undefined,a)).status,401);
 }finally{await Promise.all([pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);}
});
