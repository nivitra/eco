import type {Context,Hono} from 'hono';
import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireUser} from '../auth.js';
import {config} from '../config.js';
import {consumeQuota,HttpError,pool,withActor} from '../db.js';
import {mobilePlace,type CatalogPlace} from './consumer.js';
import {canCreateDiscoveryOuting,sourceBackedDiscoveryPlace} from './ai-discovery.js';
import {renderSharedOuting,renderUnavailableSharedOuting} from './outing-share-page.js';

const uuidV4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier=z.string().regex(uuidV4,'Use a canonical UUIDv4.');
const cleanText=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Control characters are not allowed.');
export const outingShareRequestSchema=z.object({requestID:identifier,title:cleanText(120),placeIDs:z.array(cleanText(160)).min(1).max(8).refine(ids=>new Set(ids).size===ids.length,'Each stop must have a distinct place ID.')}).strict();
export type OutingShareRequest=z.infer<typeof outingShareRequestSchema>;
export type SharedOutingSnapshot={version:1,id:string,title:string,createdAt:string,expiresAt:string,stops:{placeID:string,place:CatalogPlace|null}[]};
export type OwnedOutingShare={id:string,title:string,createdAt:string,expiresAt:string,revokedAt:string|null,placeIDs:string[],url:string};
export const OUTING_SHARE_ACTIVE_LIMIT=20;
export const OUTING_SHARE_LIST_LIMIT=100;
type ShareRow={id:string,title:string,place_ids:string[],created_at:Date|string,expires_at:Date|string,revoked_at:Date|string|null};
const columns='id,title,place_ids,created_at,expires_at,revoked_at';
const iso=(value:Date|string)=>new Date(value).toISOString();
const missing=()=>new HttpError(404,'outing_share_not_found','This shared outing is unavailable.');
const urlFor=(origin:string,id:string)=>new URL('/outings/'+id,origin).toString();

/** The share boundary is narrower than general discovery: no demo, OSM or care/service stops. */
export function shareableOutingPlace(place:CatalogPlace):boolean {
 if(!['research','published'].includes(place.status)||!sourceBackedDiscoveryPlace(place)||!canCreateDiscoveryOuting(place))return false;
 const osm=(value:string)=>{try{const host=new URL(value).hostname.toLowerCase().replace(/\.$/,'');return host==='openstreetmap.org'||host.endsWith('.openstreetmap.org');}catch{return false;}};
 return !['osm','openstreetmap'].includes((place.coordinateSource??'').trim().toLowerCase())&&!osm(place.coordinateSource??'')&&!place.sourceURLs.some(osm);
}

/** Bounded lookup under the current transaction; public-only predicates apply even for an owner. */
export async function currentSharedPlaces(db:PoolClient,ids:readonly string[]):Promise<Map<string,CatalogPlace>> {
 const {rows}=await db.query(`SELECT p.* FROM places p
  WHERE p.id=ANY($1::text[]) AND p.consumer_eligible AND p.state IN ('research','published')
  AND NOT EXISTS(SELECT 1 FROM public_pages page WHERE page.place_id=p.id AND page.withdrawn_at IS NULL
    AND page.snapshot->'profile'->>'status' IN ('temporarily_closed','permanently_closed'))
  LIMIT 8`,[ids]);
 return new Map(rows.map(mobilePlace).filter(shareableOutingPlace).map(place=>[place.id,place]));
}
export async function outingSnapshot(db:PoolClient,row:ShareRow):Promise<SharedOutingSnapshot> {
 const places=await currentSharedPlaces(db,row.place_ids);
 return {version:1,id:row.id,title:row.title,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),stops:row.place_ids.map(placeID=>({placeID,place:places.get(placeID)??null}))};
}

/** Called inside withActor: one owner lock serializes idempotency and the active-link quota. */
export async function createOutingShare(db:PoolClient,owner:string,body:OutingShareRequest):Promise<SharedOutingSnapshot> {
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['outing-shares:'+owner]);
 const existing=await db.query(`SELECT ${columns},revoked_at IS NULL AND expires_at>now() AS active FROM outing_shares WHERE owner_id=$1 AND request_id=$2 LIMIT 1`,[owner,body.requestID]);
 if(existing.rows[0]){
  const row=existing.rows[0];
  if(row.title!==body.title||JSON.stringify(row.place_ids)!==JSON.stringify(body.placeIDs))throw new HttpError(409,'idempotency_conflict','This request ID was already used for a different outing.');
  if(!row.active)throw new HttpError(409,'share_unavailable','This request created a link that has expired or been revoked. Review the outing and use a new request ID to share again.');
  return outingSnapshot(db,row);
 }
 const count=await db.query('SELECT count(*)::int AS count FROM outing_shares WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>now()',[owner]);
 if(count.rows[0].count>=OUTING_SHARE_ACTIVE_LIMIT)throw new HttpError(429,'outing_share_limit','You have 20 active shared outings. Revoke an existing link before creating another.');
 const places=await currentSharedPlaces(db,body.placeIDs);
 if(body.placeIDs.some(id=>!places.has(id)))throw new HttpError(422,'outing_stops_unavailable','Every stop must be a current source-backed leisure place. Review unavailable stops before sharing.');
 const result=await db.query(`INSERT INTO outing_shares(id,owner_id,request_id,title,place_ids) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,[randomUUID(),owner,body.requestID,body.title,body.placeIDs]);
 return outingSnapshot(db,result.rows[0]);
}

export type OutingShareRepository={
 create(owner:string,body:OutingShareRequest):Promise<SharedOutingSnapshot>;
 list(owner:string):Promise<ShareRow[]>;
 revoke(owner:string,id:string):Promise<void>;
 read(id:string):Promise<SharedOutingSnapshot|null>;
};
export const outingShareRepository:OutingShareRepository={
 create:(owner,body)=>withActor(owner,db=>createOutingShare(db,owner,body)),
 list:owner=>withActor(owner,async db=>(await db.query(`SELECT ${columns} FROM outing_shares WHERE owner_id=$1 ORDER BY (revoked_at IS NULL AND expires_at>now()) DESC,created_at DESC,id LIMIT 100`,[owner])).rows),
 revoke:(owner,id)=>withActor(owner,async db=>{
  const result=await db.query('UPDATE outing_shares SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING id',[id,owner]);
  if(!result.rowCount)throw missing();
 }),
 read:async id=>{
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   await db.query("SELECT set_config('app.actor_id','',true),set_config('app.outing_share_id',$1,true)",[id]);
   const result=await db.query(`SELECT ${columns} FROM outing_shares WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() LIMIT 1`,[id]);
   const snapshot=result.rows[0]?await outingSnapshot(db,result.rows[0]):null;
   await db.query('COMMIT');return snapshot;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
};

type Dependencies={repository:OutingShareRepository,authenticate:(c:Context)=>Promise<{id:string}>,quota:typeof consumeQuota,publicURL:string};
/** Both routes are capabilities; raw token paths must never enter request logs. */
export function redactOutingSharePath(path:string):string {
 if(/^\/v1\/outing-shares(?:\/|$)/.test(path))return '/v1/outing-shares/[redacted]';
 if(/^\/outings(?:\/|$)/.test(path))return '/outings/[redacted]';
 return path;
}
export function registerOutingShares(app:Hono,overrides:Partial<Dependencies>={}) {
 const dependencies:Dependencies={repository:outingShareRepository,authenticate:requireUser,quota:consumeQuota,publicURL:config.publicURL,...overrides};
 const headers=(c:Context)=>{
  c.header('Cache-Control','private, no-store');c.header('Referrer-Policy','no-referrer');
  c.header('X-Robots-Tag','noindex, nofollow, nosnippet');
  c.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 };
 app.use('/v1/outing-shares',async(c,next)=>{headers(c);await next();});
 app.use('/v1/outing-shares/*',async(c,next)=>{headers(c);await next();});
 app.use('/outings/*',async(c,next)=>{headers(c);await next();});
 const publicRate=async(c:Context)=>{
  const key=createHash('sha256').update(c.req.header('x-real-ip')??'unknown').digest('hex');
  await dependencies.quota('outing-share-read:'+key,120,60);
 };
 app.post('/v1/outing-shares',async c=>{
  const user=await dependencies.authenticate(c);
  await dependencies.quota('outing-share-create:'+user.id,30,3600);
  const body=outingShareRequestSchema.parse(await c.req.json());
  const share=await dependencies.repository.create(user.id,body);
  return c.json({share,url:urlFor(dependencies.publicURL,share.id)},201);
 });
 app.get('/v1/outing-shares',async c=>{
  const user=await dependencies.authenticate(c);await dependencies.quota('outing-share-owner-read:'+user.id,60,60);
  const records=await dependencies.repository.list(user.id);
  const shares:OwnedOutingShare[]=records.map(row=>({id:row.id,title:row.title,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),revokedAt:row.revoked_at?iso(row.revoked_at):null,placeIDs:row.place_ids,url:urlFor(dependencies.publicURL,row.id)}));
  return c.json({shares});
 });
 app.delete('/v1/outing-shares/:id',async c=>{
  const user=await dependencies.authenticate(c);await dependencies.quota('outing-share-revoke:'+user.id,60,60);
  const id=c.req.param('id');if(!uuidV4.test(id))throw missing();
  await dependencies.repository.revoke(user.id,id);return c.json({revoked:true});
 });
 app.get('/v1/outing-shares/:id',async c=>{
  await publicRate(c);const id=c.req.param('id');if(!uuidV4.test(id))throw missing();
  const share=await dependencies.repository.read(id);if(!share)throw missing();
  return c.json({share});
 });
 app.get('/outings/:id',async c=>{
  await publicRate(c);const id=c.req.param('id');
  const share=uuidV4.test(id)?await dependencies.repository.read(id):null;
  return share?c.html(renderSharedOuting(share,urlFor(dependencies.publicURL,id))):c.html(renderUnavailableSharedOuting(),404);
 });
}
