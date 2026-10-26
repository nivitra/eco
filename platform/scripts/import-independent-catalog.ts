import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import { z } from 'zod';

const categories = ['cafes','food','art','heritage','nature','nightlife','shopping','wellness','healthcare','stationery','community','parks','education','transport','business'] as const;
const optionalText = z.string().max(4000).nullable().optional();
function publicURL(value: string): boolean {
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
function osmURL(value: string): boolean {
  try { return /(^|\.)(openstreetmap\.org|osm\.org)$/i.test(new URL(value).hostname); } catch { return false; }
}
const placeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/), name: z.string().trim().min(1).max(240),
  category: z.enum(categories), neighborhood: z.string().max(240), address: z.string().max(1200),
  summary: z.string().max(4000), tags: z.array(z.string().max(160)).max(60),
  sourceURLs: z.array(z.string().max(2048).refine(publicURL)).min(1).max(30),
  researchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/), searchQuery: z.string().max(1200),
  imageURL: optionalText, imageSourceURL: optionalText, imageCredit: optionalText, imageRights: optionalText,
  imageLicenseURL: z.string().max(2048).refine(publicURL).optional(),
  imageProvenance: z.object({
    fileTitle:z.string().max(1000), evidenceURL:z.string().max(2048).refine(publicURL), checkedAt:z.string().max(64),
    remotePreviewOnly:z.boolean().optional(), reusePermission:z.string().max(240).optional(),
    visualVerification:z.string().max(2000).optional(),
  }).strict().optional(),
  dataLicense: z.string().max(120).optional(), dataLicenseURL: z.string().max(2048).refine(publicURL).optional(),
  dataAttribution: z.string().max(1000).optional(),
  discoveryProvenance: z.union([z.object({
    provider: z.literal('Wikidata'), entityID: z.string().regex(/^Q[1-9][0-9]*$/),
    classes: z.array(z.string().max(160)).max(60), entityRevision: z.number().int().positive().nullable(),
    coordinateStatementID: z.string().max(200), coordinatePrecisionDegrees: z.number().finite().nonnegative().nullable(),
    coordinateReferenceURLs: z.array(z.string().max(2048).refine(publicURL)).max(30),
    fetchedAt: z.string().max(64), review: z.string().max(2000), officialWebsiteClaim: z.string().max(2048).refine(publicURL).nullable().optional(),
    operatorSourceURL:z.string().max(2048).refine(publicURL).optional(),
    educationLocationReview:z.object({
      primarySourceURL:z.string().max(2048).refine(publicURL),primaryAddress:z.string().min(1).max(1200),
      decision:z.literal('retain_area_consistent'),reason:z.string().min(1).max(2000),
      reviewedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),limitation:z.string().min(1).max(2000),
    }).strict().optional(),
  }).strict(),z.object({
    source:z.literal('official-business-website'),retrievedAt:z.string().max(64),method:z.string().max(2000),
    boundaryVerified:z.literal(false),currentOperationVerified:z.literal(false),
    renderingAssetURL:z.string().max(2048).refine(publicURL).optional(),renderingAssetSHA256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict()]).optional(),
  latitude: z.number().finite().min(17.15).max(17.75).optional(),
  longitude: z.number().finite().min(78.10).max(78.80).optional(),
  coordinateSource: z.literal('Wikidata').optional(), coordinateKind: z.enum(['poi','coordinate_location']).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.category === 'business' && (!p.discoveryProvenance || !('source' in p.discoveryProvenance) ||
      p.discoveryProvenance.source !== 'official-business-website' || !/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(p.discoveryProvenance.retrievedAt) ||
      !Number.isFinite(Date.parse(p.discoveryProvenance.retrievedAt))))
    ctx.addIssue({code:'custom',message:'Business directory records require dated official website provenance.'});
  if (p.id.startsWith('osm-') || p.sourceURLs.some(osmURL) || (p.imageSourceURL && osmURL(p.imageSourceURL)))
    ctx.addIssue({ code: 'custom', message: 'Independent input cannot include OSM records or source links.' });
  if (/\b(demo|fictional|synthetic)\b/i.test([p.name,p.summary,...p.tags].join(' ')))
    ctx.addIssue({ code: 'custom', message: 'Demonstration records are not independently sourced venues.' });
  for (const key of ['imageURL','imageSourceURL'] as const) {
    if (p[key] && !publicURL(p[key]!)) ctx.addIssue({code:'custom',path:[key],message:'Expected a public HTTP(S) URL.'});
  }
  const hasCoordinates = [p.latitude,p.longitude,p.coordinateSource,p.coordinateKind].some(v => v !== undefined);
  if (hasCoordinates && [p.latitude,p.longitude,p.coordinateSource,p.coordinateKind].some(v => v === undefined))
    ctx.addIssue({ code: 'custom', message: 'Coordinates require a complete provenance tuple.' });
  if (hasCoordinates && !p.sourceURLs.some(v => /^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9][0-9]*$/.test(v)))
    ctx.addIssue({code:'custom',message:'Wikidata coordinates require an exact source item URL.'});
  if (p.id.startsWith('wikidata-')) {
    const id = /^wikidata-q([1-9][0-9]*)$/.exec(p.id)?.[1];
    if (!id || !p.sourceURLs.includes(`https://www.wikidata.org/wiki/Q${id}`) || !hasCoordinates)
      ctx.addIssue({code:'custom',message:'New Wikidata identity must match its source item and coordinates.'});
    if (p.discoveryProvenance && 'entityID' in p.discoveryProvenance && p.discoveryProvenance.entityID !== `Q${id}`)
      ctx.addIssue({code:'custom',message:'Provenance entity must match the place identity.'});
  }
  if (p.discoveryProvenance && 'coordinateReferenceURLs' in p.discoveryProvenance && p.discoveryProvenance.coordinateReferenceURLs.some(osmURL))
    ctx.addIssue({code:'custom',message:'An OSM-referenced coordinate is not eligible for this independent import.'});
});
export type IndependentPlace = z.infer<typeof placeSchema>;
export function validateIndependentCatalog(value: unknown): IndependentPlace[] {
  const records = z.array(placeSchema).min(1).max(2000).parse(value);
  if (new Set(records.map(p => p.id)).size !== records.length) throw new Error('Catalogue IDs must be unique.');
  return records;
}

/** Explicit operator admission for a reviewed official branch, not a claim of
 * field verification. New source types never inherit Wikidata coordinates/photos.
 */
export function isNewOfficialBranch(p: IndependentPlace): boolean {
  const evidence = p.discoveryProvenance;
  return /^official-[a-z0-9][a-z0-9-]{0,150}$/.test(p.id) && !!evidence && 'source' in evidence &&
    evidence.source === 'official-business-website' && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(evidence.retrievedAt) &&
    Number.isFinite(Date.parse(evidence.retrievedAt)) && evidence.method.trim().length > 0 &&
    p.neighborhood.trim().length > 0 && /\b(Hyderabad|Secunderabad)\b/i.test(p.address) &&
    p.address.trim().length > 20 && p.tags.some(tag=>tag.trim().length>0) &&
    p.sourceURLs.every(value => {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443') &&
        !/(^|\.)(google\.[a-z.]+|googleapis\.com|gstatic\.com|goo\.gl|maps\.app\.goo\.gl)$/i.test(u.hostname);
    }) && p.latitude === undefined && p.longitude === undefined && !p.imageURL && !p.imageSourceURL && !p.imageProvenance;
}

type Existing = Record<string, any>;
export interface ImportReport {
  applied: boolean; inputSHA256: string; inputCount: number; inserted: string[]; updated: string[];
  unchanged: string[]; retired: string[]; protected: {id:string;reason:string}[];
}
function sourceOwnedPoint(row: Existing): boolean {
  if (row.latitude == null && row.longitude == null) return (row.point_source == null || ['OpenStreetMap','Wikidata'].includes(row.point_source)) &&
    (row.map_payload == null || ['OpenStreetMap','Wikidata'].includes(row.map_payload.sourceName));
  const p = row.map_payload;
  if (!p || !['OpenStreetMap','Wikidata'].includes(row.point_source) || p.sourceName !== row.point_source ||
      typeof p.latitude !== 'number' || typeof p.longitude !== 'number' ||
      p.latitude !== row.latitude || p.longitude !== row.longitude) return false;
  const kind = p.sourceName === 'OpenStreetMap' ? (p.osmType === 'node' ? 'poi' : ['way','relation'].includes(p.osmType) ? 'bbox_center' : null) : p.coordinateKind;
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
function pointFor(p: IndependentPlace) {
  if (p.latitude === undefined) return null;
  const sourceURL = p.sourceURLs.find(v => /^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9][0-9]*$/.test(v))!;
  const identityURL = p.id.startsWith('wikidata-q') ? `https://www.wikidata.org/wiki/Q${p.id.slice('wikidata-q'.length)}` : sourceURL;
  return {placeID:p.id,latitude:p.latitude,longitude:p.longitude,sourceName:'Wikidata',
    wikidataID:identityURL.split('/').at(-1),sourceURL:identityURL,coordinateKind:p.coordinateKind,
    entranceVerified:false,checkedAt:p.researchedAt};
}
function stable(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',') + '}';
}
function same(row: Existing, p: IndependentPlace): boolean {
  const fields = ['name','category','neighborhood','address','summary'] as const;
  return fields.every(k => row[k] === p[k]) && stable(row.tags) === stable(p.tags) && stable(row.source_urls) === stable(p.sourceURLs) &&
    row.researched_at === p.researchedAt && row.search_query === p.searchQuery && stable(row.catalog_data) === stable(p) &&
    stable(row.map_payload) === stable(pointFor(p)) && (p.latitude === undefined ? row.latitude == null && row.longitude == null && row.point_source == null && row.point_kind == null :
      row.latitude === p.latitude && row.longitude === p.longitude && row.point_source === 'Wikidata' && row.point_kind === p.coordinateKind);
}
async function writePlace(db: PoolClient, p: IndependentPlace): Promise<void> {
  await db.query(`INSERT INTO places(id,slug,name,category,city,neighborhood,address,summary,tags,source_urls,researched_at,search_query,catalog_data,state)
    VALUES($1,$1,$2,$3,'Hyderabad',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,'research')
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,neighborhood=EXCLUDED.neighborhood,
      address=EXCLUDED.address,summary=EXCLUDED.summary,tags=EXCLUDED.tags,source_urls=EXCLUDED.source_urls,
      researched_at=EXCLUDED.researched_at,search_query=EXCLUDED.search_query,catalog_data=EXCLUDED.catalog_data,updated_at=now()`,
    [p.id,p.name,p.category,p.neighborhood,p.address,p.summary,JSON.stringify(p.tags),JSON.stringify(p.sourceURLs),p.researchedAt,p.searchQuery,JSON.stringify(p)]);
  const point = pointFor(p);
  if (point) {
    await db.query(`INSERT INTO place_map_points(place_id,payload) VALUES($1,$2::jsonb)
      ON CONFLICT(place_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now() WHERE place_map_points.payload IS DISTINCT FROM EXCLUDED.payload`, [p.id,JSON.stringify(point)]);
    await db.query(`UPDATE places SET point=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,point_source='Wikidata',point_kind=$4 WHERE id=$1`, [p.id,p.longitude,p.latitude,p.coordinateKind]);
  } else {
    await db.query('DELETE FROM place_map_points WHERE place_id=$1', [p.id]);
    await db.query('UPDATE places SET point=NULL,point_source=NULL,point_kind=NULL WHERE id=$1', [p.id]);
  }
}

/** Dry run performs no INSERT/UPDATE/DELETE. Apply is atomic; claims/coordinates are
 * checked while their tables are locked so a concurrent customer write cannot race
 * the eligibility check. A protected row is skipped in its entirety, not half-cleaned.
 */
export async function importIndependentCatalog(pool: Pool, input: unknown, options: {apply?:boolean;allowNewOfficial?:boolean;retireOSM?:boolean} = {}): Promise<ImportReport> {
  // Official branch batches are finite admissions, never a retirement/seed run.
  if (options.allowNewOfficial && options.retireOSM !== false)
    throw new Error('Official branch imports require retireOSM:false to preserve unrelated records.');
  const records = validateIndependentCatalog(input), db = await pool.connect();
  const report: ImportReport = {applied:options.apply === true,inputSHA256:createHash('sha256').update(stable(records)).digest('hex'),
    inputCount:records.length,inserted:[],updated:[],unchanged:[],retired:[],protected:[]};
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
      WHERE p.id=ANY($1::text[]) OR ($2::boolean AND p.id ~ '^osm-(node|way|relation)-[1-9][0-9]*$')`, [records.map(p=>p.id),options.retireOSM !== false])).rows;
    const existing = new Map(rows.map(row => [row.id,row]));
    // Reject unknown identities before any mutation; official branches require
    // the explicit operator option and stronger evidence/absence-of-assets checks.
    for (const p of records) if (!existing.has(p.id) && !/^wikidata-q[1-9][0-9]*$/.test(p.id) &&
        !(options.allowNewOfficial && isNewOfficialBranch(p)))
      throw new Error('A new record must use validated Wikidata identity or explicitly admitted official branch evidence; other independent seed IDs must already exist.');
    for (const p of records) {
      const row = existing.get(p.id), reason = row ? protectedReason(row) : undefined;
      if (reason) { report.protected.push({id:p.id,reason}); continue; }
      if (row && same(row,p)) { report.unchanged.push(p.id); continue; }
      (row ? report.updated : report.inserted).push(p.id);
      if (options.apply) await writePlace(db,p);
    }
    for (const row of rows.filter(r => options.retireOSM !== false && /^osm-(node|way|relation)-[1-9][0-9]*$/.test(r.id))) {
      // ID prefix alone does not establish seed ownership.
      const importedOSM = row.catalog_data?.coordinateSource === 'OpenStreetMap' || row.map_payload?.sourceName === 'OpenStreetMap';
      if (!importedOSM) { report.protected.push({id:row.id,reason:'OSM import provenance missing'}); continue; }
      const reason = protectedReason(row);
      if (reason) { report.protected.push({id:row.id,reason}); continue; }
      report.retired.push(row.id);
      if (options.apply) await db.query('UPDATE places SET consumer_eligible=false,updated_at=now() WHERE id=$1', [row.id]);
    }
    await db.query('COMMIT');
    return report;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

async function main() {
  const args = process.argv.slice(2), inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex+1] || args.some((arg,i) => i !== inputIndex+1 && !['--input','--apply','--allow-new-official','--keep-existing-osm'].includes(arg)))
    throw new Error('Usage: node --import tsx scripts/import-independent-catalog.ts --input /path/catalog.json [--apply] [--allow-new-official --keep-existing-osm]');
  const path = args[inputIndex+1], bytes = await readFile(path);
  if (bytes.byteLength > 15_000_000) throw new Error('Input exceeds the catalogue size limit.');
  if (!process.env.ADMIN_DATABASE_URL) throw new Error('Import requires ADMIN_DATABASE_URL bootstrap credentials.');
  const pool = new pg.Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1,connectionTimeoutMillis:5000,application_name:'kulture-independent-import'});
  try { console.log(JSON.stringify(await importIndependentCatalog(pool,JSON.parse(bytes.toString('utf8')),{apply:args.includes('--apply'),allowNewOfficial:args.includes('--allow-new-official'),retireOSM:!args.includes('--keep-existing-osm')}),null,2)); }
  finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Catalogue import failed; no batch committed. Check input validation, migration 021, privileges and lock availability.'); process.exitCode=1; });
}
