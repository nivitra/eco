import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {HttpError,canonical} from '../db.js';

export const MAX_FEEDBACK_SNAPSHOT_ROWS=20_000;
const revisionSchema=z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema=z.object({placeID:z.string().min(1).max(160),kind:z.enum(['liked','dismissed']),updatedAt:z.iso.datetime()}).strict();
export const feedbackRequestSchema=z.object({placeID:z.string().min(1).max(160),kind:z.enum(['liked','dismissed','clear']),expectedRevision:revisionSchema.optional()}).strict();
export const feedbackPageQuerySchema=z.object({pageSize:z.coerce.number().int().min(1).max(200),cursor:z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional()}).strict();
export type PlaceFeedback=z.infer<typeof recordSchema>;
export type FeedbackSnapshot={feedback:PlaceFeedback[];snapshotRevision:string};
type FeedbackDB=Pick<PoolClient,'query'>;
type FeedbackChange=z.infer<typeof feedbackRequestSchema>;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

/** Exact timestamps are read as UTC text, not pg's millisecond Date conversion.
 * Snapshot pagination cannot mistake two rapid changes for the same version. */
export const feedbackRowsSQL=`SELECT place_id AS "placeID",kind,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
  FROM consumer_feedback WHERE user_id=$1 ORDER BY updated_at DESC,place_id COLLATE "C" ASC LIMIT $2`;

export function feedbackSnapshot(actorID:string,rows:unknown[]):FeedbackSnapshot {
  if(rows.length>MAX_FEEDBACK_SNAPSHOT_ROWS)throw new HttpError(409,'feedback_snapshot_too_large','Your feedback history is too large for this app version. No partial history was applied.');
  const feedback=rows.map(row=>recordSchema.parse(row)).sort((a,b)=>compare(b.updatedAt,a.updatedAt)||compare(a.placeID,b.placeID));
  if(new Set(feedback.map(row=>row.placeID)).size!==feedback.length)throw new HttpError(500,'invalid_feedback_snapshot','Feedback could not be read completely. Please retry.');
  return {feedback,snapshotRevision:createHash('sha256').update(canonical({actorID,feedback})).digest('hex')};
}
export async function readFeedbackSnapshot(db:FeedbackDB,actorID:string):Promise<FeedbackSnapshot> {
  return feedbackSnapshot(actorID,(await db.query(feedbackRowsSQL,[actorID,MAX_FEEDBACK_SNAPSHOT_ROWS+1])).rows);
}
/** All feedback writes, including old clients, acquire this account lock.
 * GET uses it too, keeping snapshot validation and the read one atomic unit. */
export async function lockFeedback(db:FeedbackDB,actorID:string):Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`consumer-feedback:${actorID}`]);
}

const cursorPayloadSchema=z.object({version:z.literal(1),actor:z.string().regex(/^[a-f0-9]{64}$/),revision:revisionSchema,offset:z.number().int().min(1).max(MAX_FEEDBACK_SNAPSHOT_ROWS),pageSize:z.number().int().min(1).max(200)}).strict();
const cursorEnvelopeSchema=z.object({payload:z.string().max(800).regex(/^[A-Za-z0-9_-]+$/),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const actorDigest=(actorID:string)=>createHash('sha256').update(actorID).digest('hex');
const signature=(value:string,secret:string)=>createHmac('sha256',secret).update('kulture-feedback-cursor-v1:'+value).digest('hex');
function encodeCursor(actorID:string,revision:string,offset:number,pageSize:number,secret:string):string {
  const payload=Buffer.from(JSON.stringify({version:1,actor:actorDigest(actorID),revision,offset,pageSize})).toString('base64url');
  return Buffer.from(JSON.stringify({payload,signature:signature(payload,secret)})).toString('base64url');
}
function decodeCursor(cursor:string,secret:string) {
  try {
    if(cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor)||Buffer.from(cursor,'base64url').toString('base64url')!==cursor)throw new Error();
    const envelope=cursorEnvelopeSchema.parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));
    if(!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(signature(envelope.payload,secret),'hex')))throw new Error();
    return cursorPayloadSchema.parse(JSON.parse(Buffer.from(envelope.payload,'base64url').toString('utf8')));
  } catch {throw new HttpError(400,'invalid_feedback_cursor','This feedback page is invalid. Reload feedback from the beginning.');}
}
export function feedbackPage(snapshot:FeedbackSnapshot,actorID:string,pageSize:number,cursor:string|undefined,secret:string) {
  feedbackPageQuerySchema.parse({pageSize,cursor});
  let offset=0;
  if(cursor){
    const prior=decodeCursor(cursor,secret);
    if(prior.actor!==actorDigest(actorID))throw new HttpError(400,'invalid_feedback_cursor','This feedback page belongs to a different account. Reload feedback.');
    if(prior.pageSize!==pageSize)throw new HttpError(400,'invalid_feedback_cursor','Keep the same feedback page size while loading.');
    if(prior.revision!==snapshot.snapshotRevision)throw new HttpError(409,'feedback_snapshot_changed','Your feedback changed while loading. Reload the complete history.');
    offset=prior.offset;
    if(offset>=snapshot.feedback.length)throw new HttpError(400,'invalid_feedback_cursor','This feedback page is no longer available. Reload feedback.');
  }
  const feedback=snapshot.feedback.slice(offset,offset+pageSize),nextOffset=offset+feedback.length;
  return {feedback,snapshotRevision:snapshot.snapshotRevision,nextCursor:nextOffset<snapshot.feedback.length?encodeCursor(actorID,snapshot.snapshotRevision,nextOffset,pageSize,secret):null};
}

/** Call inside withActor. A guarded retry can never overwrite a newer decision.
 * A transport failure is an unknown outcome: read again before another write. */
export async function applyFeedback(db:FeedbackDB,actorID:string,body:FeedbackChange) {
  body=feedbackRequestSchema.parse(body);
  await lockFeedback(db,actorID);
  const prior=await readFeedbackSnapshot(db,actorID);
  if(body.expectedRevision!==undefined&&body.expectedRevision!==prior.snapshotRevision)
    throw new HttpError(409,'feedback_revision_conflict','Your feedback changed. Reload it before applying this choice.');
  // Clearing an owned choice must remain possible after a place is withdrawn
  // or hidden by public-place RLS. It cannot create a new place reference.
  if(body.kind!=='clear'&&!(await db.query('SELECT id FROM places WHERE id=$1',[body.placeID])).rows.length)
    throw new HttpError(404,'place_not_found','Place not found.');
  if(body.kind==='clear')await db.query('DELETE FROM consumer_feedback WHERE user_id=$1 AND place_id=$2',[actorID,body.placeID]);
  else await db.query(`INSERT INTO consumer_feedback(user_id,place_id,kind) VALUES($1,$2,$3)
    ON CONFLICT(user_id,place_id) DO UPDATE SET kind=EXCLUDED.kind,updated_at=clock_timestamp()`,[actorID,body.placeID,body.kind]);
  const current=await readFeedbackSnapshot(db,actorID);
  return {placeID:body.placeID,kind:body.kind,updatedAt:current.feedback.find(row=>row.placeID===body.placeID)?.updatedAt??null,snapshotRevision:current.snapshotRevision};
}
