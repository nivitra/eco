import {withPlaceImage} from '../place-images.js';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { query, withActor, HttpError } from '../db.js';
import { requireUser } from '../auth.js';
import {trustedResearchCoordinates, type ResearchCoordinateProvenance, publicResearchPhotoSchema} from '../research-provenance.js';
import { rankPlaces, belongsToArea } from './recommender.js';
import { planningSchema } from './ai-planning.js';
import {config} from '../config.js';
import {projectPlaceContact,publicContactProjectionSQL,type ContactDetails} from './place-contacts.js';
import {feedbackPageQuerySchema,feedbackRequestSchema,feedbackPage,readFeedbackSnapshot,lockFeedback,applyFeedback} from './place-feedback.js';
import {registerShortlists} from './shortlists.js';

export const categoryIDs = [
  'cafes',
  'food',
  'art',
  'heritage',
  'nature',
  'nightlife',
  'shopping',
  'wellness',
  'healthcare',
  'stationery',
  'community',
  'parks',
  'education',
  'transport',
  'sports',
  'games',
] as const;
export const tasteSchema = z
  .object({
    interests: z.array(z.enum(categoryIDs)).max(categoryIDs.length).default([]),
    pace: z.enum(['Unhurried', 'A little of everything']).default('Unhurried'),
    avoidBars: z.boolean().default(false),
  })
  .strict();
export const profileSchema = z
  .object({
    savedIDs: z.array(z.string().min(1).max(160)).max(1000),
    taste: tasteSchema,
    outings: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            title: z.string().trim().min(1).max(120),
            placeIDs: z.array(z.string().min(1).max(160)).min(1).max(8),
            createdAt: z.number().int().nonnegative().max(8640000000000000),
            brief: planningSchema.nullable().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const emptyProfile = {
  savedIDs: [],
  taste: { interests: [], pace: 'Unhurried', avoidBars: false },
  outings: [],
};
export type CatalogPlace = {
  id: string;
  name: string;
  category: string;
  neighborhood: string;
  address: string;
  summary: string;
  tags: string[];
  sourceURLs: string[];
  contactDetails?:ContactDetails|null;
  researchedAt: string;
  searchQuery: string;
  imageURL?: string;
  imageSourceURL?: string;
  imageCredit?: string;
  imageRights?: string;
  imageLicenseURL?:string;
  publicImages?:z.infer<typeof publicResearchPhotoSchema>[];
  coordinateProvenance?:ResearchCoordinateProvenance;
  latitude?: number;
  longitude?: number;
  coordinateSource?: string;
  coordinateKind?: 'poi' | 'bbox_center' | 'coordinate_location';
  revision: number;
  status: string;
};

/** Whitelist only public catalog fields. No arbitrary snapshot/private row serialization. */
export function mobilePlace(row: Record<string, any>): CatalogPlace {
  const data = row.catalog_data ?? {};
  const result: CatalogPlace = {
    id: row.id,
    name: row.name,
    category: row.category,
    neighborhood: row.neighborhood,
    address: row.address,
    summary: row.summary,
    tags: Array.isArray(row.tags) ? row.tags : [],
    sourceURLs: Array.isArray(row.source_urls) ? row.source_urls : [],
    researchedAt: row.researched_at ?? '',
    searchQuery: row.search_query ?? '',
    revision: row.revision,
    status: row.state,
    contactDetails:projectPlaceContact(row,config.publicURL),
  };
  for (const key of ['imageURL', 'imageSourceURL', 'imageCredit', 'imageRights', 'imageLicenseURL'] as const)
    if (typeof data[key] === 'string') result[key] = data[key];
  if(Array.isArray(data.publicImages)){const photos=z.array(publicResearchPhotoSchema).max(6).safeParse(data.publicImages);if(photos.success)result.publicImages=photos.data;}
  const researchCoordinate=trustedResearchCoordinates(data,result.sourceURLs);
  const demo = /\b(demo|fictional|synthetic)\b/i.test([result.name,result.summary,...result.tags].join(' '));
  const source = result.sourceURLs.some(value => {
    try { const url=new URL(value); return url.protocol==='https:'&&['openstreetmap.org','www.openstreetmap.org'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&
      (data.coordinateKind==='poi'?/^\/node\/\d+$/:/^\/(way|relation)\/\d+$/).test(url.pathname); } catch { return false; }
  });
  const wikidataSource = result.sourceURLs.some(value => {
    try {
      const url = new URL(value);
      return value === url.href && /^https:\/\/(?:www\.)?wikidata\.org\/wiki\/Q[1-9][0-9]*$/.test(value) &&
        url.protocol === 'https:' && ['wikidata.org', 'www.wikidata.org'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/wiki\/Q[1-9][0-9]*$/.test(url.pathname);
    } catch { return false; }
  });
  const trustedCoordinate = researchCoordinate || (source && data.coordinateSource === 'OpenStreetMap' && ['poi', 'bbox_center'].includes(data.coordinateKind)) ||
    (wikidataSource && data.coordinateSource === 'Wikidata' && ['poi', 'coordinate_location'].includes(data.coordinateKind));
  if(!demo&&trustedCoordinate&&
     typeof data.latitude==='number'&&Number.isFinite(data.latitude)&&data.latitude>=17.15&&data.latitude<=17.75&&
     typeof data.longitude==='number'&&Number.isFinite(data.longitude)&&data.longitude>=78.10&&data.longitude<=78.80) {
    result.latitude=data.latitude; result.longitude=data.longitude;
    result.coordinateSource=data.coordinateSource; result.coordinateKind=data.coordinateKind;
    if(researchCoordinate)result.coordinateProvenance=data.coordinateProvenance;
  }
  return withPlaceImage(result);
}
export const CATALOG_LIMIT=2000;
export async function publicPlaceInventory(): Promise<{places:CatalogPlace[];truncated:boolean}> {
  const result = await query(
    `SELECT places.*,${publicContactProjectionSQL} FROM places WHERE consumer_eligible AND state IN ('research','published') ORDER BY id LIMIT 2001`,
  );
  return {places:result.rows.slice(0,CATALOG_LIMIT).map(mobilePlace),truncated:result.rows.length>CATALOG_LIMIT};
}
export async function publicPlaces():Promise<CatalogPlace[]>{return (await publicPlaceInventory()).places;}
export function isLocal(place: CatalogPlace): boolean {
  return belongsToArea(place, 'jubilee_hills');
}
export function isBar(place: CatalogPlace): boolean {
  return (
    place.category === 'nightlife' ||
    /\b(bar|bars|pub|pubs|brewpub|brewery|brewing|cocktails?)\b/i.test(
      [place.name, ...place.tags].join(' '),
    )
  );
}
export function eligiblePlaces(
  places: CatalogPlace[],
  scope: string,
  avoidBars: boolean,
): CatalogPlace[] {
  return places.filter(
    (p) => (!['jubilee_hills','kokapet'].includes(scope) || belongsToArea(p, scope as 'jubilee_hills'|'kokapet')) && (!avoidBars || !isBar(p)),
  );
}
export function normalizeProfile(body: z.infer<typeof profileSchema>, validIDs: Set<string>) {
  // Also validate briefs copied from the locked stored profile, not just the
  // incoming HTTP body. Invalid constraints must not become durable data.
  body = profileSchema.parse(body);
  const referenced = [...body.savedIDs, ...body.outings.flatMap((x) => x.placeIDs)];
  if (referenced.some((id) => !validIDs.has(id)))
    throw new HttpError(
      422,
      'unknown_place',
      'A saved place is not in this catalog. Refresh the catalog before syncing.',
    );
  if (new Set(body.outings.map((x) => x.id)).size !== body.outings.length)
    throw new HttpError(400, 'duplicate_outing', 'Outing IDs must be unique.');
  return {
    ...body,
    savedIDs: [...new Set(body.savedIDs)],
    taste: { ...body.taste, interests: [...new Set(body.taste.interests)] },
    outings: body.outings.map((x) => ({ ...x, placeIDs: [...new Set(x.placeIDs)] })),
  };
}

type ConsumerProfile = z.infer<typeof profileSchema>;

/** Old clients omit fields they do not understand. Preserve only the brief of
 * a still-present outing with the same identity; null is an intentional clear.
 * An older client may echo a brief but omit newer timing fields. Stage duration
 * follows the same activity identity and pin, never array position alone.
 * Do not carry deleted outings back into the profile or merge by array order.
 */
export function mergeOmittedOutingBriefs(incoming: ConsumerProfile, stored: unknown): ConsumerProfile {
  const priorOutings = stored && typeof stored === 'object' && 'outings' in stored && Array.isArray(stored.outings)
    ? stored.outings : [];
  const priorByID = new Map(priorOutings.filter((value): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && typeof value.id === 'string').map(value => [value.id, value]));
  return { ...incoming, outings: incoming.outings.map(outing => {
    const prior = priorByID.get(outing.id);
    if (!prior || prior.brief === undefined) return { ...outing };
    if (outing.brief === undefined) return { ...outing, brief: planningSchema.nullable().parse(prior.brief) };
    if (outing.brief === null) return { ...outing };
    const incomingBrief = outing.brief;
    if (incomingBrief.startAtEpochMs !== undefined && incomingBrief.stages.every(stage => stage.visitMinutes !== undefined)) return { ...outing };
    const priorBrief = planningSchema.nullable().parse(prior.brief);
    if (!priorBrief) return { ...outing };
    const priorStages = new Map(priorBrief.stages.map(stage => [stage.id, stage]));
    const stages = incomingBrief.stages.map(stage => {
      const previous = priorStages.get(stage.id);
      if (stage.visitMinutes !== undefined || !previous || previous.categoryID !== stage.categoryID ||
          previous.pinnedPlaceID !== stage.pinnedPlaceID || previous.visitMinutes === undefined) return { ...stage };
      return { ...stage, visitMinutes: previous.visitMinutes };
    });
    return { ...outing, brief: { ...incomingBrief, stages,
      ...(incomingBrief.startAtEpochMs === undefined && priorBrief.startAtEpochMs !== undefined
        ? { startAtEpochMs: priorBrief.startAtEpochMs } : {}) } };
  }) };
}

/** Call only after selecting this actor's profile FOR UPDATE. The revision
 * guard precedes any merge so a stale writer cannot recover then overwrite
 * another device's updated brief.
 */
export function prepareProfileUpdate(incoming: ConsumerProfile,
  stored: { revision: number; body: unknown } | undefined, expected: number, validIDs: Set<string>): ConsumerProfile {
  if (!stored || stored.revision !== expected)
    throw new HttpError(412, 'version_conflict', 'The profile changed. Load it and reconcile before saving.');
  return normalizeProfile(mergeOmittedOutingBriefs(incoming, stored.body), validIDs);
}
export function profileRevision(tag: string | undefined): number {
  if (!tag) throw new HttpError(428, 'version_required', 'Load the profile before changing it.');
  const match = /^(?:"profile:(\d+)"|"(\d+)"|(\d+))$/.exec(tag);
  const version = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new HttpError(400, 'invalid_version', 'Use the exact profile ETag.');
  return version;
}

export function catalogAttributions(points: readonly {sourceName?:unknown}[]) {
  const sources = new Set(points.map(point => point.sourceName));
  return [
    ...(sources.has('Wikidata') ? [{text:'Wikidata contributors',url:'https://www.wikidata.org/wiki/Wikidata:Licensing',license:'CC0-1.0'}] : []),
    ...(sources.has('EazyDiner') ? [{text:'EazyDiner venue listings (source-reported POIs)',url:'https://www.eazydiner.com/hyderabad',license:'Source reference; reuse rights unverified'}] : []),
    ...(sources.has('Playo') ? [{text:'Playo venue listings (source-reported POIs)',url:'https://playo.co/venues/hyderabad',license:'Source reference; reuse rights unverified'}] : []),
    ...(sources.has('OpenStreetMap') ? [{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright',license:'ODbL-1.0'}] : []),
  ];
}

export function registerConsumer(app: Hono) {
  registerShortlists(app);
  app.get('/v1/catalog', async (c) => {
    const {places,truncated} = await publicPlaceInventory();
    const maps = await query(
      'SELECT payload FROM place_map_points WHERE place_id=ANY($1::text[]) ORDER BY place_id',
      [places.map((p) => p.id)],
    );
    const mapPoints = maps.rows.map((r) => r.payload);
    const attributions = catalogAttributions(mapPoints);
    const version = createHash('sha256')
      .update(JSON.stringify({ places, mapPoints, attributions, truncated }))
      .digest('hex')
      .slice(0, 24);
    const tag = `"catalog:${version}"`;
    c.header('ETag', tag);
    c.header('Cache-Control', 'public, max-age=60, must-revalidate');
    if (c.req.header('If-None-Match') === tag) return c.body(null, 304);
    return c.json({
      version,
      places,
      mapPoints,
      coverage: {
        places: places.length,
        mapped: mapPoints.length,
        verifiedEntrances: 0,
        seedResearchDate: places.map((place) => place.researchedAt).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1) ?? null,
        completeCityInventory: false,
        limit: CATALOG_LIMIT,
        truncated,
      },
      attributions,
    });
  });
  app.get('/v1/places', async (c) => {
    const input = z
      .object({
        q: z.string().max(200).optional(),
        category: z.enum(categoryIDs).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lon: z.coerce.number().min(-180).max(180).optional(),
        radius: z.coerce.number().int().min(100).max(10000).default(3000),
      })
      .parse(c.req.query());
    if ((input.lat === undefined) !== (input.lon === undefined))
      throw new HttpError(400, 'coordinate_pair_required', 'Supply both latitude and longitude.');
    const params: unknown[] = [];
    const filters = ["consumer_eligible AND state IN ('research','published')"];
    // Every word must match a public field, but words can span name and products.
    // Only the live public projection supplies offerings; never inspect drafts or
    // arbitrary catalog_data (which may contain non-public or stale fields).
    const terms = [...new Set((input.q ?? '').trim().split(/\s+/u).filter(Boolean))];
    for (const term of terms) {
      params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
      const parameter = `$${params.length}`;
      filters.push(`(name ILIKE ${parameter} OR address ILIKE ${parameter}
        OR summary ILIKE ${parameter} OR neighborhood ILIKE ${parameter} OR category ILIKE ${parameter}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(places.tags)='array' THEN places.tags ELSE '[]'::jsonb END
        ) AS tag(value) WHERE tag.value ILIKE ${parameter})
        OR EXISTS (
          SELECT 1 FROM public_pages AS page
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(page.snapshot->'profile'->'offerings')='array'
              THEN page.snapshot->'profile'->'offerings' ELSE '[]'::jsonb END
          ) AS offering(value)
          WHERE page.place_id=places.id AND page.withdrawn_at IS NULL
            AND (offering.value->>'name' ILIKE ${parameter}
              OR offering.value->>'description' ILIKE ${parameter})
        ))`);
    }
    if (input.category) {
      params.push(input.category);
      filters.push(`category=$${params.length}`);
    }
    let distance = 'NULL::double precision';
    if (input.lat !== undefined) {
      params.push(input.lon, input.lat, input.radius);
      const n = params.length;
      const origin = `ST_SetSRID(ST_MakePoint($${n - 2},$${n - 1}),4326)::geography`;
      filters.push(`point IS NOT NULL AND ST_DWithin(point,${origin},$${n})`);
      distance = `ST_Distance(point,${origin})`;
    }
    const rows = await query(
      `SELECT places.*,${publicContactProjectionSQL},${distance} AS distance_metres FROM places WHERE ${filters.join(' AND ')} ORDER BY distance_metres NULLS LAST,id LIMIT 50`,
      params,
    );
    return c.json({
      places: rows.rows.map((row) => ({
        ...mobilePlace(row),
        distanceMetres: row.distance_metres,
      })),
      distanceKind: 'straight_line_to_feature',
      truncated: rows.rows.length === 50,
    });
  });
  app.get('/v1/places/:id', async (c) => {
    const result = await query(
      `SELECT places.*,${publicContactProjectionSQL} FROM places WHERE id=$1 AND state IN ('research','published','closed')`,
      [c.req.param('id')],
    );
    if (!result.rows[0])
      throw new HttpError(404, 'place_not_found', 'This place is not available.');
    const entrances = await query(
      "SELECT id,kind,modes,revision,verified_at,valid_until,ST_Y(point::geometry) AS latitude,ST_X(point::geometry) AS longitude FROM entrances WHERE place_id=$1 AND status='verified' AND valid_until>now()",
      [c.req.param('id')],
    );
    const facts=result.rows[0].public_contact_snapshot?.profile??null;
    const place=mobilePlace(result.rows[0]);
    // Registry/withdrawal updates can change public facts without place.revision.
    const factsVersion=createHash('sha256').update(JSON.stringify({contactDetails:place.contactDetails,publishedFacts:facts})).digest('hex').slice(0,20);
    c.header('ETag', `"place:${place.id}:${place.revision}:${factsVersion}"`);
    return c.json({
      ...place,
      businessType: result.rows[0].business_type ?? null,
      publishedFacts: facts,
      entrances: entrances.rows,
    });
  });
  app.get('/v1/profile', async (c) => {
    const user = await requireUser(c);
    c.header('Cache-Control', 'private, no-store');
    const result = await withActor(user.id, async (db) => {
      await db.query(
        'INSERT INTO profiles(user_id,body) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
        [user.id, JSON.stringify(emptyProfile)],
      );
      return (await db.query('SELECT revision,body FROM profiles WHERE user_id=$1', [user.id]))
        .rows[0];
    });
    c.header('ETag', `"profile:${result.revision}"`);
    return c.json({ revision: result.revision, profile: result.body });
  });
  app.put('/v1/profile', async (c) => {
    const user = await requireUser(c);
    const raw = await c.req.json();
    const body = profileSchema.parse(raw?.profile ?? raw);
    const expected = profileRevision(c.req.header('If-Match'));
    const known = await query('SELECT id FROM places');
    const validIDs = new Set(known.rows.map((r) => r.id));
    const result = await withActor(user.id, async (db) => {
      const row = (
        await db.query('SELECT revision,body FROM profiles WHERE user_id=$1 FOR UPDATE', [user.id])
      ).rows[0];
      const profile = prepareProfileUpdate(body, row, expected, validIDs);
      return (
        await db.query(
          'UPDATE profiles SET body=$2::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 RETURNING revision,body',
          [user.id, JSON.stringify(profile)],
        )
      ).rows[0];
    });
    c.header('Cache-Control', 'private, no-store');
    c.header('ETag', `"profile:${result.revision}"`);
    return c.json({ revision: result.revision, profile: result.body });
  });
  app.get('/v1/feedback', async (c) => {
    const user = await requireUser(c);
    const pageSize = c.req.query('pageSize'), cursor = c.req.query('cursor');
    c.header('Cache-Control', 'private, no-store');
    if (pageSize === undefined && cursor === undefined) {
      // Preserve the original envelope for clients that do not understand pages.
      const rows = await withActor(user.id, async (db) => (
        await db.query('SELECT place_id AS "placeID",kind,updated_at AS "updatedAt" FROM consumer_feedback WHERE user_id=$1 ORDER BY updated_at DESC,place_id COLLATE "C" ASC LIMIT 1000', [user.id])
      ).rows);
      return c.json({ feedback: rows });
    }
    const request = feedbackPageQuerySchema.parse({pageSize,cursor});
    const result = await withActor(user.id, async (db) => {
      await lockFeedback(db,user.id);
      return feedbackPage(await readFeedbackSnapshot(db,user.id),user.id,request.pageSize,request.cursor,config.authSecret);
    });
    return c.json(result);
  });
  app.post('/v1/feedback', async (c) => {
    const user = await requireUser(c);
    const body = feedbackRequestSchema.parse(await c.req.json());
    const result = await withActor(user.id, db => applyFeedback(db,user.id,body));
    c.header('Cache-Control', 'private, no-store');
    return c.json(result);
  });
  app.post('/v1/recommendations', async (c) => {
    const body = z
      .object({
        scope: z.enum(['jubilee_hills', 'kokapet', 'hyderabad']).default('jubilee_hills'),
        taste: tasteSchema.default({ interests: [], pace: 'Unhurried', avoidBars: false }),
        category: z.enum(categoryIDs).optional(),
        limit: z.number().int().min(1).max(20).default(12),
        intent: z.string().max(2000).default('For you'),
        savedIDs: z.array(z.string().max(160)).max(1000).default([]),
        positiveTags: z.array(z.string().max(80)).max(20).default([]),
        negativeTags: z.array(z.string().max(80)).max(20).default([]),
        excludedCategories: z.array(z.enum(categoryIDs)).max(categoryIDs.length).default([]),
        requireVerifiedOpen: z.boolean().default(false),
        origin: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
          })
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    let feedback: { place_id: string; kind: string }[] = [];
    if (c.req.header('Authorization')) {
      const user = await requireUser(c);
      feedback = await withActor(
        user.id,
        async (db) =>
          (
            await db.query('SELECT place_id,kind FROM consumer_feedback WHERE user_id=$1', [
              user.id,
            ])
          ).rows,
      );
    }
    const distances: Record<string, number> = {};
    if (body.origin) {
      const result = await query(
        'SELECT id,ST_Distance(point,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS metres FROM places WHERE point IS NOT NULL',
        [body.origin.longitude, body.origin.latitude],
      );
      for (const row of result.rows) distances[row.id] = row.metres;
    }
    const ranked = rankPlaces(await publicPlaces(), {
      ...body,
      interests: body.taste.interests,
      avoidBars: body.taste.avoidBars,
      likedIDs: feedback.filter((f) => f.kind === 'liked').map((f) => f.place_id),
      dismissedIDs: feedback.filter((f) => f.kind === 'dismissed').map((f) => f.place_id),
      distances,
    });
    return c.json({
      ...ranked,
      results: ranked.results.map(({ place, ...result }) => ({
        ...result,
        placeID: place.id,
        placeRevision: place.revision,
        reason: result.reasons[0],
      })),
    });
  });
}
