import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { upsertResearchPlace, upsertResearchMapPoint, type ResearchSeedPlace, type ResearchSeedPoint } from '../scripts/seed-catalog.js';

test('research refresh is idempotent and cannot overwrite edited, claimed, hidden or published places',
  { skip: process.env.RUN_DB_TESTS !== 'true' }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  const db = await pool.connect();
  const suffix = randomUUID();
  const place = (kind: string): ResearchSeedPlace => ({
    id: `seed-refresh-${kind}-${suffix}`, name: 'Research stationery fixture', category: 'stationery',
    neighborhood: 'Kokapet', address: 'Synthetic test address', summary: 'Original research',
    tags: ['pens'], sourceURLs: ['https://example.test/source'], researchedAt: '2026-10-01',
    searchQuery: 'Research stationery fixture Kokapet',
  });
  try {
    await db.query('BEGIN');
    const initial = place('unclaimed');
    await upsertResearchPlace(db, initial);
    const revised = { ...initial, summary: 'Refreshed public research', tags: ['pens', 'notebooks'], imageURL: 'https://example.test/photo.jpg' };
    await upsertResearchPlace(db, revised);
    const refreshed = (await db.query('SELECT summary,tags,catalog_data,revision,updated_at FROM places WHERE id=$1', [initial.id])).rows[0];
    assert.equal(refreshed.summary, revised.summary);
    assert.deepEqual(refreshed.tags, revised.tags);
    assert.equal(refreshed.catalog_data.imageURL, revised.imageURL);
    assert.equal(refreshed.revision, 1, 'research refresh does not impersonate a merchant revision');
    await upsertResearchPlace(db, revised);
    const repeated = (await db.query('SELECT updated_at FROM places WHERE id=$1', [initial.id])).rows[0];
    assert.equal(repeated.updated_at.toISOString(), refreshed.updated_at.toISOString());

    const tenant = randomUUID();
    await db.query("INSERT INTO tenants(id,name,created_by) VALUES($1,'Seed test tenant','seed-test')", [tenant]);
    for (const kind of ['edited', 'claimed', 'hidden', 'published', 'closed']) {
      const original = place(kind);
      await upsertResearchPlace(db, original);
      if (kind === 'edited') await db.query('UPDATE places SET revision=2 WHERE id=$1', [original.id]);
      if (kind === 'hidden') await db.query('UPDATE places SET consumer_eligible=false WHERE id=$1', [original.id]);
      if (kind === 'published' || kind === 'closed') await db.query('UPDATE places SET state=$2 WHERE id=$1', [original.id, kind]);
      if (kind === 'claimed') await db.query("INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,'seed-test','{}')", [tenant, original.id]);
      await upsertResearchPlace(db, { ...original, name: 'Must not replace customer record', summary: 'New scraper data' });
      const row = (await db.query('SELECT name,summary FROM places WHERE id=$1', [original.id])).rows[0];
      assert.equal(row.name, original.name, kind);
      assert.equal(row.summary, original.summary, kind);
    }
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});


test('source coordinate refresh keeps catalog, spatial point and route payload aligned without replacing protected coordinates',
  { skip: process.env.RUN_DB_TESTS !== 'true' }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  const db = await pool.connect();
  const suffix = randomUUID();
  const fixture = (kind: string): ResearchSeedPlace => ({
    id: `seed-point-${kind}-${suffix}`, name: 'Coordinate test fixture', category: 'stationery',
    neighborhood: 'Kokapet', address: 'Synthetic test address', summary: 'Synthetic coordinate fixture',
    tags: [], sourceURLs: ['https://www.openstreetmap.org/node/123'], researchedAt: '2026-10-01',
    searchQuery: 'Coordinate test fixture Kokapet', latitude: 17.398, longitude: 78.338,
    coordinateSource: 'OpenStreetMap', coordinateKind: 'poi',
  });
  const point = (placeID: string): ResearchSeedPoint => ({ placeID, latitude: 17.398, longitude: 78.338,
    sourceName: 'OpenStreetMap', osmType: 'node', osmID: 123,
    sourceURL: 'https://www.openstreetmap.org/node/123', checkedAt: '2026-10-01T00:00:00Z' });
  const snapshot = async (id: string) => (await db.query(`SELECT p.catalog_data,p.revision,p.point_kind,p.point_source,
    ST_X(p.point::geometry) AS longitude,ST_Y(p.point::geometry) AS latitude,p.updated_at,
    m.payload,m.updated_at AS map_updated_at FROM places p JOIN place_map_points m ON m.place_id=p.id WHERE p.id=$1`, [id])).rows[0];
  try {
    await db.query('BEGIN');
    const original = fixture('move'), initialPoint = point(original.id);
    await upsertResearchPlace(db, original);
    await upsertResearchMapPoint(db, initialPoint);
    const moved = { ...initialPoint, latitude: 17.399, longitude: 78.339, osmType: 'way' as const,
      osmID: 456, sourceURL: 'https://www.openstreetmap.org/way/456', checkedAt: '2026-10-02T00:00:00Z' };
    const refreshed = { ...original, latitude: moved.latitude, longitude: moved.longitude,
      coordinateKind: 'bbox_center', sourceURLs: [moved.sourceURL] };
    await upsertResearchPlace(db, refreshed);
    await upsertResearchMapPoint(db, moved);
    const row = await snapshot(original.id);
    assert.equal(row.latitude, moved.latitude);
    assert.equal(row.longitude, moved.longitude);
    assert.equal(row.point_kind, 'bbox_center');
    assert.equal(row.point_source, 'OpenStreetMap');
    assert.equal(row.catalog_data.latitude, moved.latitude);
    assert.equal(row.catalog_data.longitude, moved.longitude);
    assert.equal(row.catalog_data.coordinateKind, 'bbox_center');
    assert.deepEqual(row.payload, moved);
    assert.equal(row.revision, 1);

    // now() is constant inside this transaction, so use an earlier timestamp to
    // prove identical refreshes really avoid both UPDATE paths.
    await db.query("UPDATE places SET updated_at='2000-01-01T00:00:00Z' WHERE id=$1", [original.id]);
    await db.query("UPDATE place_map_points SET updated_at='2000-01-01T00:00:00Z' WHERE place_id=$1", [original.id]);
    const beforeRepeat = await snapshot(original.id);
    await upsertResearchPlace(db, refreshed);
    await upsertResearchMapPoint(db, moved);
    assert.deepEqual(await snapshot(original.id), beforeRepeat);

    const tenant = randomUUID();
    await db.query("INSERT INTO tenants(id,name,created_by) VALUES($1,'Coordinate test tenant','seed-test')", [tenant]);
    for (const kind of ['edited', 'claimed', 'hidden', 'published', 'closed', 'operator-source', 'operator-coordinate']) {
      const protectedPlace = fixture(kind), protectedPoint = point(protectedPlace.id);
      await upsertResearchPlace(db, protectedPlace);
      await upsertResearchMapPoint(db, protectedPoint);
      if (kind === 'edited') await db.query('UPDATE places SET revision=2 WHERE id=$1', [protectedPlace.id]);
      if (kind === 'hidden') await db.query('UPDATE places SET consumer_eligible=false WHERE id=$1', [protectedPlace.id]);
      if (kind === 'published' || kind === 'closed') await db.query('UPDATE places SET state=$2 WHERE id=$1', [protectedPlace.id,kind]);
      if (kind === 'claimed') await db.query("INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence) VALUES($1,$2,'seed-test','{}')", [tenant,protectedPlace.id]);
      if (kind === 'operator-source') await db.query("UPDATE places SET point_source='operator' WHERE id=$1", [protectedPlace.id]);
      if (kind === 'operator-coordinate') await db.query('UPDATE places SET point=ST_SetSRID(ST_MakePoint(78.34,17.40),4326)::geography WHERE id=$1', [protectedPlace.id]);
      const before = await snapshot(protectedPlace.id);
      await upsertResearchPlace(db, { ...protectedPlace, latitude: moved.latitude, longitude: moved.longitude });
      await upsertResearchMapPoint(db, { ...moved, placeID: protectedPlace.id });
      assert.deepEqual(await snapshot(protectedPlace.id), before, kind);
    }
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
