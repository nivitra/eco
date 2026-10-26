import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export interface ResearchSeedPlace {
  id: string; name: string; category: string; neighborhood: string;
  address: string; summary: string; tags: string[]; sourceURLs: string[];
  researchedAt: string; searchQuery: string;
  [key: string]: unknown;
}

export interface ResearchSeedPoint {
  placeID: string; latitude: number; longitude: number;
  sourceName: 'OpenStreetMap'; osmType: 'node' | 'way' | 'relation'; osmID: number;
  sourceURL: string; [key: string]: unknown;
}

// An OSM point is still seed-owned only while it matches the last imported payload.
// A coordinate changed by an operator without a revision bump must also win.
const sourceOwnedPoint = `(places.point IS NULL OR (
  places.point_source='OpenStreetMap' AND EXISTS (
    SELECT 1 FROM place_map_points previous WHERE previous.place_id=places.id
      AND previous.payload->>'sourceName'='OpenStreetMap'
      AND places.point_kind=CASE WHEN previous.payload->>'osmType'='node' THEN 'poi' ELSE 'bbox_center' END
      AND ST_Equals(places.point::geometry, ST_SetSRID(ST_MakePoint(
        (previous.payload->>'longitude')::double precision,
        (previous.payload->>'latitude')::double precision),4326))
  )))`;

/** Refresh our unclaimed research records; a customer or operator's record wins. */
export async function upsertResearchPlace(db: PoolClient, p: ResearchSeedPlace): Promise<void> {
  await db.query(`INSERT INTO places(id,slug,name,category,city,neighborhood,address,summary,tags,source_urls,researched_at,search_query,catalog_data,state)
    VALUES($1,$1,$2,$3,'Hyderabad',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,'research')
    ON CONFLICT(id) DO UPDATE SET
      name=EXCLUDED.name,category=EXCLUDED.category,neighborhood=EXCLUDED.neighborhood,
      address=EXCLUDED.address,summary=EXCLUDED.summary,tags=EXCLUDED.tags,
      source_urls=EXCLUDED.source_urls,researched_at=EXCLUDED.researched_at,
      search_query=EXCLUDED.search_query,catalog_data=EXCLUDED.catalog_data,updated_at=now()
    WHERE places.state='research' AND places.revision=1 AND places.consumer_eligible
      AND NOT EXISTS(SELECT 1 FROM merchant_claims WHERE place_id=places.id)
      AND ${sourceOwnedPoint}
      AND (places.name,places.category,places.neighborhood,places.address,places.summary,
        places.tags,places.source_urls,places.researched_at,places.search_query,places.catalog_data)
        IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.category,EXCLUDED.neighborhood,EXCLUDED.address,EXCLUDED.summary,
        EXCLUDED.tags,EXCLUDED.source_urls,EXCLUDED.researched_at,EXCLUDED.search_query,EXCLUDED.catalog_data)`,
    [p.id,p.name,p.category,p.neighborhood,p.address,p.summary,JSON.stringify(p.tags),JSON.stringify(p.sourceURLs),p.researchedAt,p.searchQuery,JSON.stringify(p)]);
}

/** Keep public coordinates, spatial queries and route payloads on the same source revision.
 * Call in the seed transaction. The locked eligibility CTE reads the old payload before
 * either representation changes, so protected records cannot be partially refreshed.
 */
export async function upsertResearchMapPoint(db: PoolClient, p: ResearchSeedPoint): Promise<void> {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180
      || p.sourceName !== 'OpenStreetMap' || !['node','way','relation'].includes(p.osmType)
      || !Number.isSafeInteger(p.osmID) || p.osmID <= 0
      || p.sourceURL !== `https://www.openstreetmap.org/${p.osmType}/${p.osmID}`) {
    throw new Error('Invalid source-owned seed point');
  }
  await db.query(`WITH eligible AS MATERIALIZED (
      SELECT places.id FROM places
      WHERE places.id=$1 AND places.state='research' AND places.revision=1 AND places.consumer_eligible
        AND NOT EXISTS(SELECT 1 FROM merchant_claims WHERE place_id=places.id)
        AND ${sourceOwnedPoint}
      FOR UPDATE OF places
    ), map_refresh AS (
      INSERT INTO place_map_points(place_id,payload)
      SELECT id,$2::jsonb FROM eligible
      ON CONFLICT(place_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
        WHERE place_map_points.payload IS DISTINCT FROM EXCLUDED.payload
      RETURNING place_id
    )
    UPDATE places SET point=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
      point_kind=$5,point_source='OpenStreetMap',
      catalog_data=catalog_data || jsonb_build_object('latitude',$4::double precision,'longitude',$3::double precision,
        'coordinateSource','OpenStreetMap','coordinateKind',$5::text),updated_at=now()
    WHERE id IN (SELECT id FROM eligible)
      AND (point IS NULL OR NOT ST_Equals(point::geometry,ST_SetSRID(ST_MakePoint($3,$4),4326))
        OR point_kind IS DISTINCT FROM $5 OR point_source IS DISTINCT FROM 'OpenStreetMap'
        OR catalog_data IS DISTINCT FROM catalog_data || jsonb_build_object('latitude',$4::double precision,'longitude',$3::double precision,
          'coordinateSource','OpenStreetMap','coordinateKind',$5::text))`,
    [p.placeID,JSON.stringify(p),p.longitude,p.latitude,p.osmType==='node'?'poi':'bbox_center']);
}

/** Run with bootstrap/worker credentials. Re-running never overwrites merchant edits. */
export async function seedCatalog(pool: Pool): Promise<void> {
  const places = JSON.parse(await readFile(new URL('../data/places.json', import.meta.url), 'utf8'));
  const points = JSON.parse(await readFile(new URL('../data/map-points.json', import.meta.url), 'utf8'));
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kulture-catalog-seed-v1'))");
    for (const p of places) await upsertResearchPlace(db, p);
    for (const p of points) {
      if (!places.some((x: {id:string})=>x.id===p.placeID)) throw new Error('Invalid seed identity/point');
      await upsertResearchMapPoint(db, p);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
