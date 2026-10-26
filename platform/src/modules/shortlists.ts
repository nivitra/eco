import type {Context,Hono} from 'hono';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireUser} from '../auth.js';
import {HttpError,withActor} from '../db.js';
import {mobilePlace,type CatalogPlace} from './consumer.js';
import {sourceBackedDiscoveryPlace} from './ai-discovery.js';

export const SHORTLIST_LIMIT=100;
const safeVersion=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const shortlistIDSchema=z.uuid().refine(value=>value===value.toLowerCase(),'Use a lowercase UUID.');
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>value.length<=max,`Use at most ${max} UTF-16 code units.`).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/.test(value),'Control characters are not allowed.');
export const shortlistPutSchema=z.object({title:text(80),placeIDs:z.array(text(160)).min(1).max(8).refine(ids=>new Set(ids).size===ids.length,'Keep distinct place IDs.'),expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const shortlistDeleteSchema=z.object({expectedVersion:safeVersion}).strict();
export type ShortlistPut=z.infer<typeof shortlistPutSchema>;
export type ConsumerShortlist={id:string,title:string,placeIDs:string[],version:number,createdAt:string,updatedAt:string};
export type DeletedShortlist={id:string,version:number,deleted:true};
type ShortlistRow={id:string,title:string,place_ids:string[],version:number|string,created_at:Date|string,updated_at:Date|string,deleted_at:Date|string|null};
const columns='id,title,place_ids,version,created_at,updated_at,deleted_at';
const missing=()=>new HttpError(404,'shortlist_not_found','This shortlist is unavailable to your account.');
const conflict=()=>new HttpError(409,'shortlist_version_conflict','This shortlist changed. Reload it before applying your edits.');
const gone=()=>new HttpError(410,'shortlist_deleted','This shortlist was deleted. It cannot be restored by a stale device.');
const version=(value:unknown)=>{const parsed=safeVersion.safeParse(Number(value));if(!parsed.success)throw new HttpError(500,'invalid_shortlist_version','The shortlist could not be read.');return parsed.data;};
const publicRecord=(row:ShortlistRow):ConsumerShortlist=>({id:row.id,title:row.title,placeIDs:row.place_ids,version:version(row.version),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()});
async function lock(db:PoolClient,userID:string){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['consumer-shortlists:'+userID]);}

/** Lists can hold service and leisure places. They imply no visit, quality or
 * appointment, and must not turn an external map result into a permanent ID. */
export function shortlistMemberEligible(place:CatalogPlace):boolean {
 const osm=(value:string)=>{try{const host=new URL(value).hostname.toLowerCase().replace(/\.$/,'');return host==='openstreetmap.org'||host.endsWith('.openstreetmap.org');}catch{return false;}};
 return ['research','published'].includes(place.status)&&sourceBackedDiscoveryPlace(place)&&
  !['osm','openstreetmap'].includes((place.coordinateSource??'').trim().toLowerCase())&&!osm(place.coordinateSource??'')&&!place.sourceURLs.some(osm);
}
export async function validNewShortlistIDs(db:PoolClient,ids:string[]):Promise<Set<string>>{
 if(!ids.length)return new Set();
 const {rows}=await db.query(`SELECT p.* FROM places p WHERE p.id=ANY($1::text[])
  AND p.consumer_eligible AND p.state IN ('research','published')
  AND NOT EXISTS(SELECT 1 FROM public_pages page WHERE page.place_id=p.id AND page.withdrawn_at IS NULL
   AND page.snapshot->'profile'->>'status' IN ('temporarily_closed','permanently_closed')) LIMIT 8`,[ids]);
 return new Set(rows.map(mobilePlace).filter(shortlistMemberEligible).map(place=>place.id));
}
export async function listShortlists(db:PoolClient,userID:string):Promise<ConsumerShortlist[]>{
 // One statement is a complete snapshot, including same-timestamp ties.
 const {rows}=await db.query(`SELECT ${columns} FROM consumer_shortlists WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id ASC LIMIT 101`,[userID]);
 if(rows.length>SHORTLIST_LIMIT)throw new HttpError(409,'shortlist_collection_too_large','The shortlist collection is too large for this app version. No partial list was loaded.');
 return rows.map(publicRecord);
}
export async function putShortlist(db:PoolClient,userID:string,id:string,input:ShortlistPut):Promise<ConsumerShortlist>{
 id=shortlistIDSchema.parse(id);const body=shortlistPutSchema.parse(input);await lock(db,userID);
 const row=(await db.query(`SELECT ${columns} FROM consumer_shortlists WHERE user_id=$1 AND id=$2 FOR UPDATE`,[userID,id])).rows[0] as ShortlistRow|undefined;
 if(row?.deleted_at)throw gone();
 if(row?version(row.version)!==body.expectedVersion:body.expectedVersion!==0)throw row?conflict():missing();
 if(row&&version(row.version)===Number.MAX_SAFE_INTEGER)throw new HttpError(409,'shortlist_version_exhausted','Create a new shortlist after reviewing this list.');
 if(!row){
  const count=Number((await db.query('SELECT count(*) AS count FROM consumer_shortlists WHERE user_id=$1 AND deleted_at IS NULL',[userID])).rows[0].count);
  if(count>=SHORTLIST_LIMIT)throw new HttpError(409,'shortlist_limit','You have 100 shortlists. Delete one before creating another.');
 }
 // Existing unavailable references can be retained/reordered/removed, but
 // removing one does not authorize later adding that hidden place again.
 const prior=new Set(row?.place_ids??[]),added=body.placeIDs.filter(placeID=>!prior.has(placeID));
 const visible=await validNewShortlistIDs(db,added);
 if(added.some(placeID=>!visible.has(placeID)))throw new HttpError(422,'shortlist_places_unavailable','New shortlist members must be current sourced public listings. Existing unavailable entries can be removed.');
 const result=row?await db.query(`UPDATE consumer_shortlists SET title=$3,place_ids=$4,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 RETURNING ${columns}`,[userID,id,body.title,body.placeIDs]):
  await db.query(`INSERT INTO consumer_shortlists(user_id,id,title,place_ids) VALUES($1,$2,$3,$4) RETURNING ${columns}`,[userID,id,body.title,body.placeIDs]);
 return publicRecord(result.rows[0]);
}
export async function deleteShortlist(db:PoolClient,userID:string,id:string,expectedVersion:number):Promise<DeletedShortlist>{
 id=shortlistIDSchema.parse(id);safeVersion.parse(expectedVersion);await lock(db,userID);
 const row=(await db.query(`SELECT ${columns} FROM consumer_shortlists WHERE user_id=$1 AND id=$2 FOR UPDATE`,[userID,id])).rows[0] as ShortlistRow|undefined;
 if(!row)throw missing();if(row.deleted_at)throw gone();if(version(row.version)!==expectedVersion)throw conflict();
 if(expectedVersion===Number.MAX_SAFE_INTEGER)throw new HttpError(409,'shortlist_version_exhausted','This shortlist needs support before another change.');
 const result=await db.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE consumer_shortlists SET title='',place_ids=ARRAY[]::text[],version=version+1,updated_at=stamp.at,deleted_at=stamp.at FROM stamp WHERE user_id=$1 AND id=$2 RETURNING id,version`,[userID,id]);
 return {id:result.rows[0].id,version:version(result.rows[0].version),deleted:true};
}
export type ShortlistRepository={list:(userID:string)=>Promise<ConsumerShortlist[]>,put:(userID:string,id:string,body:ShortlistPut)=>Promise<ConsumerShortlist>,delete:(userID:string,id:string,expectedVersion:number)=>Promise<DeletedShortlist>};
export const shortlistRepository:ShortlistRepository={list:userID=>withActor(userID,db=>listShortlists(db,userID)),put:(userID,id,body)=>withActor(userID,db=>putShortlist(db,userID,id,body)),delete:(userID,id,expected)=>withActor(userID,db=>deleteShortlist(db,userID,id,expected))};
type Dependencies={repository:ShortlistRepository,authenticate:(c:Context)=>Promise<{id:string}>};
export function registerShortlists(app:Hono,overrides:Partial<Dependencies>={}){
 const dependencies:Dependencies={repository:shortlistRepository,authenticate:requireUser,...overrides};
 const privacy=async(c:Context,next:()=>Promise<void>)=>{c.header('Cache-Control','private, no-store');await next();};
 app.use('/v1/shortlists',privacy);app.use('/v1/shortlists/*',privacy);
 app.get('/v1/shortlists',async c=>{const user=await dependencies.authenticate(c);return c.json({shortlists:await dependencies.repository.list(user.id),limit:SHORTLIST_LIMIT});});
 app.put('/v1/shortlists/:id',async c=>{const user=await dependencies.authenticate(c),id=shortlistIDSchema.parse(c.req.param('id')),body=shortlistPutSchema.parse(await c.req.json());return c.json(await dependencies.repository.put(user.id,id,body));});
 app.delete('/v1/shortlists/:id',async c=>{const user=await dependencies.authenticate(c),id=shortlistIDSchema.parse(c.req.param('id')),body=shortlistDeleteSchema.parse(await c.req.json());return c.json(await dependencies.repository.delete(user.id,id,body.expectedVersion));});
}
