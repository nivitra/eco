import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {coordinateProvenanceSchema,publicResearchPhotoSchema,trustedResearchCoordinates,publicHTTPURL} from '../src/research-provenance.js';
const url=z.string().max(2048).refine(publicHTTPURL);
const placeSchema=z.object({
 id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),name:z.string().trim().min(1).max(240),
 category:z.enum(['cafes','food','art','heritage','nature','nightlife','shopping','wellness','healthcare','stationery','community','parks','education','transport','sports','games']),
 neighborhood:z.string().max(240),address:z.string().max(1200),summary:z.string().max(4000),tags:z.array(z.string().max(160)).max(60),
 sourceURLs:z.array(url).min(1).max(30),researchedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),searchQuery:z.string().max(1200),
 latitude:z.number().finite().min(17.15).max(17.75).optional(),longitude:z.number().finite().min(78.1).max(78.8).optional(),
 coordinateSource:z.enum(['EazyDiner','Playo','Wikidata']).optional(),coordinateKind:z.enum(['poi','coordinate_location']).optional(),
 coordinateProvenance:coordinateProvenanceSchema.optional(),publicImages:z.array(publicResearchPhotoSchema).min(1).max(6).optional(),
 imageURL:url.optional(),imageSourceURL:url.optional(),imageCredit:z.string().max(2000).optional(),imageRights:z.string().max(120).optional(),imageLicenseURL:url.optional(),
 research:z.object({datasetID:z.literal('hyderabad-editorial-1000-2026-10-10'),recordID:z.string().max(160),sourceRecordIDs:z.array(z.string().max(160)).min(1).max(40),
  category:z.string().max(100),fieldSources:z.array(z.object({field:z.string().max(100),sourceURLs:z.array(url).min(1).max(30),method:z.string().max(240)}).strict()).max(40),
  photoReferences:z.array(z.object({url,sourceURL:url,reusePermission:z.string().max(240),license:z.string().max(240).nullable(),sha256:z.string().regex(/^[a-f0-9]{64}$/),checkedAt:z.string().max(64),venueAssociationVerified:z.boolean()}).strict()).length(2),
  currentOperationVerified:z.literal(false),admissionVerified:z.literal(false),selectionBasis:z.string().max(1000),coordinateWithheldReason:z.string().max(1000).optional(),
 }).strict(),
}).strict().superRefine((p,ctx)=>{
 const partial=[p.latitude,p.longitude,p.coordinateSource,p.coordinateKind,p.coordinateProvenance].some(v=>v!==undefined);
 if(partial&&!trustedResearchCoordinates(p,p.sourceURLs))ctx.addIssue({code:'custom',message:'Coordinates require a complete, source-specific, bounded observation tuple.'});
 if(p.id.startsWith('osm-')||p.sourceURLs.some(s=>/(^|\.)(openstreetmap\.org|osm\.org)$/.test(new URL(s).hostname)))ctx.addIssue({code:'custom',message:'OSM sources are not accepted for this import.'});
 if(/\b(demo|fictional|synthetic)\b/i.test([p.name,p.summary,...p.tags].join(' ')))ctx.addIssue({code:'custom',message:'Research candidates must not be fictional.'});
 if(!p.research.sourceRecordIDs.includes(p.id)||!p.research.sourceRecordIDs.includes(p.research.recordID))ctx.addIssue({code:'custom',message:'Stable source and canonical identities are required.'});
 if(p.research.photoReferences[0].sha256===p.research.photoReferences[1].sha256)ctx.addIssue({code:'custom',message:'Photo references must contain two distinct files.'});
 const photo=p.publicImages?.[0];
 if(photo? p.imageURL!==photo.url||p.imageSourceURL!==photo.sourceURL||p.imageCredit!==photo.credit||p.imageRights!==photo.license||p.imageLicenseURL!==photo.licenseURL:
   [p.imageURL,p.imageSourceURL,p.imageCredit,p.imageRights,p.imageLicenseURL].some(v=>v!==undefined))ctx.addIssue({code:'custom',message:'Public image fields must match an explicitly licensed, associated Commons photo.'});
});
export type ResearchPlace=z.infer<typeof placeSchema>;
export function validateResearchCatalog(value:unknown):ResearchPlace[]{
 const rows=z.array(placeSchema).min(1).max(2000).parse(value);
 if(new Set(rows.map(p=>p.id)).size!==rows.length)throw new Error('Research place IDs must be unique.');
 const refs=new Set<string>();for(const p of rows)for(const id of p.research.sourceRecordIDs){if(refs.has(id))throw new Error('Source identities must not describe multiple places.');refs.add(id);}
 return rows;
}

type Existing = Record<string, any>;
export interface ResearchImportReport {
  applied: boolean; inputSHA256: string; inputCount: number; inserted: string[]; updated: string[];
  unchanged: string[]; protected: {id:string;reason:string}[];
}
function sourceOwnedPoint(row: Existing): boolean {
  if (row.latitude == null && row.longitude == null) return (row.point_source == null || ['Wikidata','EazyDiner','Playo'].includes(row.point_source)) &&
    (row.map_payload == null || ['Wikidata','EazyDiner','Playo'].includes(row.map_payload.sourceName));
  const p = row.map_payload;
  if (!p || !['Wikidata','EazyDiner','Playo'].includes(row.point_source) || p.sourceName !== row.point_source ||
      typeof p.latitude !== 'number' || typeof p.longitude !== 'number' ||
      p.latitude !== row.latitude || p.longitude !== row.longitude) return false;
  const kind = p.coordinateKind;
  return kind != null && row.point_kind === kind;
}
function protectedReason(row: Existing): string | undefined {
  if (row.state !== 'research') return 'non-research state';
  if (row.revision !== 1) return 'edited revision';
  if (row.claimed) return 'merchant claim exists';
  if (!row.consumer_eligible) return 'already hidden';
  if (row.catalog_data?.id !== row.id) return 'not an imported research identity';
  if (!sourceOwnedPoint(row)) return 'operator or unrecognized coordinate';
  return undefined;
}
export function researchPointFor(p: ResearchPlace) {
  if (p.latitude === undefined) return null;
  const proof=p.coordinateProvenance!;
  return {placeID:p.id,latitude:p.latitude,longitude:p.longitude,sourceName:p.coordinateSource,
    ...(p.coordinateSource==='Wikidata'?{wikidataID:proof.sourceURL.split('/').at(-1)}:{}),
    sourceURL:proof.sourceURL,coordinateKind:p.coordinateKind,coordinateProvenance:proof,
    entranceVerified:false,checkedAt:proof.retrievedAt};
}
function stable(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',') + '}';
}
function same(row: Existing, p: ResearchPlace): boolean {
  const fields = ['name','category','neighborhood','address','summary'] as const;
  return fields.every(k => row[k] === p[k]) && stable(row.tags) === stable(p.tags) && stable(row.source_urls) === stable(p.sourceURLs) &&
    row.researched_at === p.researchedAt && row.search_query === p.searchQuery && stable(row.catalog_data) === stable(p) &&
    stable(row.map_payload) === stable(researchPointFor(p)) && (p.latitude === undefined ? row.latitude == null && row.longitude == null && row.point_source == null && row.point_kind == null :
      row.latitude === p.latitude && row.longitude === p.longitude && row.point_source === p.coordinateSource && row.point_kind === p.coordinateKind);
}
async function writePlace(db: PoolClient, p: ResearchPlace): Promise<void> {
  await db.query(`INSERT INTO places(id,slug,name,category,city,neighborhood,address,summary,tags,source_urls,researched_at,search_query,catalog_data,state)
    VALUES($1,$1,$2,$3,'Hyderabad',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,'research')
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,neighborhood=EXCLUDED.neighborhood,
      address=EXCLUDED.address,summary=EXCLUDED.summary,tags=EXCLUDED.tags,source_urls=EXCLUDED.source_urls,
      researched_at=EXCLUDED.researched_at,search_query=EXCLUDED.search_query,catalog_data=EXCLUDED.catalog_data,updated_at=now()`,
    [p.id,p.name,p.category,p.neighborhood,p.address,p.summary,JSON.stringify(p.tags),JSON.stringify(p.sourceURLs),p.researchedAt,p.searchQuery,JSON.stringify(p)]);
  const point = researchPointFor(p);
  if (point) {
    await db.query(`INSERT INTO place_map_points(place_id,payload) VALUES($1,$2::jsonb)
      ON CONFLICT(place_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now() WHERE place_map_points.payload IS DISTINCT FROM EXCLUDED.payload`, [p.id,JSON.stringify(point)]);
    await db.query(`UPDATE places SET point=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,point_source=$4,point_kind=$5 WHERE id=$1`, [p.id,p.longitude,p.latitude,p.coordinateSource,p.coordinateKind]);
  } else {
    await db.query('DELETE FROM place_map_points WHERE place_id=$1', [p.id]);
    await db.query('UPDATE places SET point=NULL,point_source=NULL,point_kind=NULL WHERE id=$1', [p.id]);
  }
}

/** Dry run performs no INSERT/UPDATE/DELETE. Apply is atomic; claims/coordinates are
 * checked while their tables are locked so a concurrent customer write cannot race
 * the eligibility check. A protected row is skipped in its entirety, not half-cleaned.
 */
export async function importResearchCatalog(pool: Pool, input: unknown, options: {apply?:boolean} = {}): Promise<ResearchImportReport> {
  const records = validateResearchCatalog(input), db = await pool.connect();
  const report: ResearchImportReport = {applied:options.apply === true,inputSHA256:createHash('sha256').update(stable(records)).digest('hex'),
    inputCount:records.length,inserted:[],updated:[],unchanged:[],protected:[]};
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kulture-catalog-seed-v1'))");
    // Also blocks non-seed operator/claim writes until the checked batch commits.
    await db.query('LOCK TABLE places,merchant_claims,place_map_points IN SHARE ROW EXCLUSIVE MODE');
    const rows = (await db.query(`SELECT p.*,ST_X(p.point::geometry) AS longitude,ST_Y(p.point::geometry) AS latitude,
      m.payload AS map_payload,EXISTS(SELECT 1 FROM merchant_claims c WHERE c.place_id=p.id) AS claimed
      FROM places p LEFT JOIN place_map_points m ON m.place_id=p.id
      WHERE p.id=ANY($1::text[])`, [records.map(p=>p.id)])).rows;
    const existing = new Map(rows.map(row => [row.id,row]));
    // Existing seed/alias IDs must already exist; never mint a new claimed identity.
    for (const p of records) if (!existing.has(p.id) && !/^(eazydiner-[1-9][0-9]*|playo-[a-f0-9-]{36}|culture-[a-z0-9-]+|official-[a-z0-9-]+)$/.test(p.id))
      throw new Error('New research IDs must use a stable source identity; reused seed IDs must already exist.');
    for (const p of records) {
      const row = existing.get(p.id), reason = row ? protectedReason(row) : undefined;
      if (reason) { report.protected.push({id:p.id,reason}); continue; }
      if (row && same(row,p)) { report.unchanged.push(p.id); continue; }
      (row ? report.updated : report.inserted).push(p.id);
      if (options.apply) await writePlace(db,p);
    }
    await db.query('COMMIT');
    return report;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}


async function main(){
 const args=process.argv.slice(2),at=args.indexOf('--input');
 if(at<0||!args[at+1]||args.some((arg,i)=>i!==at+1&&!['--input','--apply'].includes(arg)))throw new Error('Usage: node --import tsx scripts/import-hyderabad-research.ts --input data/research-places.json [--apply]');
 const bytes=await readFile(args[at+1]);if(bytes.byteLength>20_000_000)throw new Error('Research input exceeds size limit.');
 const input=validateResearchCatalog(JSON.parse(bytes.toString('utf8')));
 if(!process.env.ADMIN_DATABASE_URL)throw new Error('Requires ADMIN_DATABASE_URL.');
 const pool=new pg.Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1,connectionTimeoutMillis:5000,application_name:'kulture-research-import'});
 try{console.log(JSON.stringify(await importResearchCatalog(pool,input,{apply:args.includes('--apply')}),null,2));}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Research import failed; no batch committed. Check validation, migration 022, privileges and locks.');process.exitCode=1;});
