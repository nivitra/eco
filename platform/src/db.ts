import pg, {type PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {config} from './config.js';
export class HttpError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }
function makePool(url:string,max=10){return new pg.Pool({connectionString:url,max,idleTimeoutMillis:30000,connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'kulture'});}
export const pool=makePool(config.databaseURL);
// HTTP processes do not receive this credential. Worker imports use it only when configured.
export const workerPool=config.workerDatabaseURL?makePool(config.workerDatabaseURL,4):pool;
export const query=(sql:string,params?:unknown[])=>pool.query(sql,params);
export async function withActor<T>(actorID:string,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.actor_id',$1,true)",[actorID]);const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
export async function requireRole(db:PoolClient,tenantID:string,roles:string[]=['owner','editor']):Promise<void>{
 const {rows}=await db.query("SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=current_setting('app.actor_id',true) AND state='active'",[tenantID]);
 if(!rows[0])throw new HttpError(404,'tenant_not_found','Workspace not found');
 if(!roles.includes(rows[0].role))throw new HttpError(403,'role_required','Your workspace role does not permit this action');
}
export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
export async function idempotent<T>(db:PoolClient,actorID:string,key:string,scope:string,body:unknown,fn:()=>Promise<T>):Promise<T>{
 if(!key||!/^[A-Za-z0-9_.:-]{16,128}$/.test(key))throw new HttpError(400,'idempotency_key_required','Provide a unique Idempotency-Key (16–128 characters)');
 const hash=createHash('sha256').update(canonical(body)).digest('hex');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${actorID}:${scope}:${key}`]);
 const existing=await db.query('SELECT request_hash,response FROM idempotency WHERE actor_id=$1 AND scope=$2 AND key=$3',[actorID,scope,key]);
 if(existing.rows[0]){if(existing.rows[0].request_hash!==hash)throw new HttpError(409,'idempotency_conflict','This key was already used with different content');return existing.rows[0].response as T;}
 const result=await fn(); await db.query('INSERT INTO idempotency(actor_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actorID,scope,key,hash,JSON.stringify(result)]);return result;
}
export async function audit(db:PoolClient,actor:string,tenant:string|null,action:string,target:string,data:unknown={}){await db.query('INSERT INTO audit_log(actor_id,tenant_id,action,target_id,data) VALUES($1,$2,$3,$4,$5)',[actor,tenant,action,target,JSON.stringify(data)]);}
export async function consumeQuota(key:string,max:number,windowSeconds:number):Promise<void>{
 const {rows}=await pool.query('SELECT consume_quota($1,$2,$3) AS allowed',[key,max,windowSeconds]);
 if(!rows[0].allowed)throw new HttpError(429,'rate_limited','You have reached this request limit. Please try again later.');
}
