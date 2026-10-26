/** Bounded research importer. No database writes, credentials, web scraping or live app queries.
 * Default: cached review artifacts. --apply explicitly merges additions into the bundled seeds.
 * OSM-derived records are ODbL-1.0; source facts and image rights remain separate.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REGIONS = [
  { id: 'kokapet', name: 'Kokapet', bbox: [17.375, 78.315, 17.419, 78.363] },
  { id: 'jubilee-hills', name: 'Jubilee Hills', bbox: [17.411, 78.388, 17.449, 78.429] },
] as const;
type Region = (typeof REGIONS)[number];
export type OSMElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};
type Catalog = Record<string, any> & { id: string; name: string; sourceURLs: string[] };
type MapPoint = Record<string, any> & { placeID: string; latitude: number; longitude: number };
type Extract = {
  endpoint: string;
  fetchedAt: string;
  query: string;
  querySha256: string;
  sourcePolicy?: { kind: string; url: string; robotsScope: string };
  robots: { url: string; status: number; text: string; checkedAt: string };
  data: { elements: OSMElement[]; osm3s?: { timestamp_osm_base?: string }; remark?: string };
};
const AGENT = 'KultureDiscovery/1.0 (+https://kulture.mitwpu.work; bounded research import)';
const LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/';
const ENDPOINT = 'https://overpass.private.coffee/api/interpreter';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

export function buildQuery(region: Region): string {
  const b = region.bbox.join(',');
  return (
    `[out:json][timeout:45][maxsize:16777216];(\n` +
    `nwr["amenity"~"^(cafe|hospital|clinic|doctors|dentist|pharmacy|community_centre|arts_centre|library|marketplace|townhall|social_centre)$"](${b});\n` +
    `nwr["healthcare"](${b});\n` +
    `nwr["shop"~"^(stationery|copyshop|books)$"](${b});\n` +
    `nwr["leisure"~"^(park|garden|playground|recreation_ground|common)$"](${b});\n` +
    `nwr["place"="square"](${b});\n` +
    `nwr["natural"="water"]["name"](${b});\n);out tags center;`
  );
}

/** robots longest matching rule, allow wins ties; most-specific UA group wins. */
export function robotsAllows(text: string, path: string, agent = 'KultureDiscovery'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group = { agents: [] as string[], rules: [] as { allow: boolean; path: string }[] };
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:#]+):\s*([^#]*)/.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(),
      value = match[2].trim();
    if (key === 'user-agent') {
      if (group.rules.length) {
        groups.push(group);
        group = { agents: [], rules: [] };
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && group.agents.length && value) {
      group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  groups.push(group);
  const scored = groups.map((g) => ({
    ...g,
    score: Math.max(
      -1,
      ...g.agents.map((a) => (a === '*' ? 0 : agent.toLowerCase().includes(a) ? a.length : -1)),
    ),
  }));
  const best = Math.max(-1, ...scored.map((g) => g.score));
  const matching = scored
    .filter((g) => g.score === best && best >= 0)
    .flatMap((g) => g.rules)
    .filter((rule) => {
      const end = rule.path.endsWith('$'),
        value = end ? rule.path.slice(0, -1) : rule.path;
      const regex = value
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp('^' + regex + (end ? '$' : '')).test(path);
    })
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

async function download(url: string, maxBytes: number) {
  await pause(Math.max(0, 2100 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, {
    headers: { 'User-Agent': AGENT, Accept: 'application/json,text/plain;q=0.8' },
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Source returned no body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) throw new Error('Source response exceeded the byte limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadExtract(
  region: Region,
  cacheDir: string,
  endpoint: string,
  refresh: boolean,
  documentedAPI: boolean,
): Promise<Extract> {
  const path = resolve(cacheDir, region.id + '.extract.json'),
    query = buildQuery(region);
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8')) as Extract;
      if (
        cached.endpoint === endpoint &&
        cached.querySha256 === sha256(query) &&
        Array.isArray(cached.data?.elements)
      )
        return cached;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const robotsURL = new URL('/robots.txt', endpoint).href;
  let robots = '',
    status = 200;
  try {
    robots = await download(robotsURL, 256000);
  } catch (e: any) {
    status = e.status;
    if (![404, 410].includes(status)) throw e;
  }
  const directAPI = documentedAPI && endpoint === 'https://overpass-api.de/api/interpreter';
  if (documentedAPI && !directAPI)
    throw new Error(
      'Documented API policy acknowledgement is restricted to the reviewed official endpoint',
    );
  if (!directAPI && !robotsAllows(robots, new URL(endpoint).pathname))
    throw new Error('Source robots.txt disallows this importer');
  const url = new URL(endpoint);
  url.searchParams.set('data', query);
  // One request per region. On throttling/failure stop; no endpoint-hopping or parallel retries.
  const data = JSON.parse(await download(url.href, 5_000_000));
  if (!Array.isArray(data.elements) || data.elements.length > 5000 || data.remark)
    throw new Error('Incomplete or oversized Overpass response; not applying partial data');
  const fetchedAt = new Date().toISOString();
  const result: Extract = {
    endpoint,
    fetchedAt,
    query,
    querySha256: sha256(query),
    sourcePolicy: directAPI
      ? {
          kind: 'direct-public-api',
          url: 'https://dev.overpass-api.de/overpass-doc/en/preface/commons.html',
          robotsScope:
            'Website crawl exclusions recorded; documented developer API request uses the explicit API resource policy.',
        }
      : {
          kind: 'robots-allowed-api',
          url: 'https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances',
          robotsScope:
            'Endpoint permitted by robots response; public API usage policy also applies.',
        },
    robots: { url: robotsURL, status, text: robots, checkedAt: fetchedAt },
    data,
  };
  await writeJSON(path, result);
  return result;
}

export function categoryFor(tags: Record<string, string>): string | undefined {
  if (
    ['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy'].includes(tags.amenity) ||
    (tags.healthcare && !['no', 'yes'].includes(tags.healthcare))
  )
    return 'healthcare';
  if (['stationery', 'copyshop'].includes(tags.shop)) return 'stationery';
  if (tags.amenity === 'cafe') return 'cafes';
  if (['park', 'garden', 'playground', 'recreation_ground', 'common'].includes(tags.leisure))
    return 'parks';
  if (
    [
      'community_centre',
      'arts_centre',
      'library',
      'marketplace',
      'townhall',
      'social_centre',
    ].includes(tags.amenity) ||
    tags.place === 'square'
  )
    return 'community';
  if (tags.shop === 'books') return 'shopping';
  if (tags.natural === 'water') return 'nature';
  return undefined;
}

export function candidateFrom(
  element: OSMElement,
  region: Region,
  extract: Pick<Extract, 'fetchedAt' | 'querySha256' | 'data'>,
): { place: Catalog; point: MapPoint } | { skipped: string } {
  const t = element.tags ?? {},
    name = (t['name:en'] ?? t.name ?? '').trim(),
    category = categoryFor(t);
  if (
    !['node', 'way', 'relation'].includes(element.type) ||
    !Number.isSafeInteger(element.id) ||
    element.id <= 0
  )
    return { skipped: 'invalid_identity' };
  if (!name || !category) return { skipped: 'unnamed_or_unsupported' };
  if (
    ['yes', 'true'].includes(t.disused) ||
    ['yes', 'true'].includes(t.abandoned) ||
    t['disused:amenity'] ||
    t['abandoned:amenity']
  )
    return { skipped: 'closed_or_disused' };
  if (
    ['parks', 'community'].includes(category) &&
    ['private', 'no', 'customers', 'residents'].includes(t.access)
  )
    return { skipped: 'restricted_access' };
  const lat = element.type === 'node' ? element.lat : element.center?.lat;
  const lon = element.type === 'node' ? element.lon : element.center?.lon;
  const [south, west, north, east] = region.bbox;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat! < south ||
    lat! > north ||
    lon! < west ||
    lon! > east
  )
    return { skipped: 'missing_or_outside_point' };
  const id = `osm-${element.type}-${element.id}`,
    sourceURL = `https://www.openstreetmap.org/${element.type}/${element.id}`;
  const kind = element.type === 'node' ? 'poi' : 'bbox_center';
  const addressParts = [
    t['addr:housenumber'],
    t['addr:street'],
    t['addr:place'],
    t['addr:suburb'],
    t['addr:city'],
    t['addr:postcode'],
  ].filter(Boolean);
  const neighborhood = t['addr:suburb']
    ? `${t['addr:suburb']} · ${region.name} search area (boundary unverified)`
    : `${region.name} area · boundary unverified`;
  const mappedKind = (
    t.amenity ??
    t.healthcare ??
    t.shop ??
    t.leisure ??
    t.place ??
    t.water ??
    t.natural
  ).replaceAll('_', ' ');
  const summary = `OpenStreetMap identifies this mapped feature as ${mappedKind} in the ${region.name} search area. Current operation, hours and exact neighborhood boundary have not been independently checked.${['parks', 'community'].includes(category) ? ' Public access and any entry conditions must be confirmed.' : ''}`;
  const place: Catalog = {
    id,
    name,
    category,
    neighborhood,
    address:
      t['addr:full'] ??
      (addressParts.length
        ? addressParts.join(', ')
        : 'Street address not provided in OpenStreetMap; see mapped location.'),
    summary,
    tags: [mappedKind, region.name + ' search area', 'OpenStreetMap research'],
    sourceURLs: [sourceURL],
    researchedAt: extract.fetchedAt.slice(0, 10),
    searchQuery: `${name} ${region.name} Hyderabad`,
    latitude: lat,
    longitude: lon,
    coordinateSource: 'OpenStreetMap',
    coordinateKind: kind,
    dataLicense: 'ODbL-1.0',
    dataLicenseURL: LICENSE,
    dataAttribution: '© OpenStreetMap contributors',
    discoveryProvenance: {
      sourceURL,
      osmType: element.type,
      osmID: element.id,
      retrievedAt: extract.fetchedAt,
      sourceTimestamp: extract.data.osm3s?.timestamp_osm_base ?? null,
      querySha256: extract.querySha256,
      region: region.id,
      regionBBox: [...region.bbox],
      boundaryVerified: false,
      currentOperationVerified: false,
    },
  };
  const point: MapPoint = {
    placeID: id,
    latitude: lat!,
    longitude: lon!,
    sourceURL,
    sourceName: 'OpenStreetMap',
    osmType: element.type,
    osmID: element.id,
    checkedAt: extract.fetchedAt,
    coordinateKind: kind,
    confidenceNote: `${element.type === 'node' ? 'OSM mapped feature point' : 'Overpass bounding-box center; may not lie inside the feature'}. Not an entrance survey or a legal access route. Current operation and neighborhood boundary unverified.`,
  };
  return { place, point };
}

function nameKey(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
function distance(a: MapPoint, b: MapPoint) {
  const dy = (a.latitude - b.latitude) * 111320,
    dx = (a.longitude - b.longitude) * 106000;
  return Math.hypot(dx, dy);
}
export function mergeResearch(
  existing: Catalog[],
  points: MapPoint[],
  incoming: { place: Catalog; point: MapPoint }[],
  aliases: Record<string, string> = {},
) {
  const catalog = existing.map((p) => ({ ...p })),
    maps = points.map((p) => ({ ...p }));
  const held: { id: string; reason: string; possibleExistingID: string }[] = [];
  const added: string[] = [],
    enriched: string[] = [];
  for (const point of maps) {
    const place = catalog.find((p) => p.id === point.placeID);
    if (
      !place ||
      place.merchantMaintained ||
      place.latitude != null ||
      place.longitude != null ||
      !/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(point.sourceURL ?? '')
    )
      continue;
    place.latitude = point.latitude;
    place.longitude = point.longitude;
    place.coordinateSource = 'OpenStreetMap';
    place.coordinateKind = point.osmType === 'node' ? 'poi' : 'bbox_center';
    if (!place.sourceURLs.includes(point.sourceURL))
      place.sourceURLs = [...place.sourceURLs, point.sourceURL];
    enriched.push(place.id);
  }
  for (const item of incoming) {
    const source = item.point.sourceURL;
    const mappedID =
      aliases[item.place.id] ??
      maps.find((m) => m.sourceURL === source)?.placeID ??
      catalog.find((p) => p.sourceURLs?.includes(source))?.id;
    const exact = catalog.find((p) => p.id === (mappedID ?? item.place.id));
    if (mappedID && !exact)
      throw new Error(`Reviewed alias has no existing destination: ${mappedID}`);
    if (exact) {
      if (exact.merchantMaintained) continue;
      // Existing editorial/merchant fields and IDs win. Only fill absent coordinate provenance.
      if (!exact.merchantMaintained && exact.latitude == null && exact.longitude == null) {
        for (const key of ['latitude', 'longitude', 'coordinateSource', 'coordinateKind'])
          exact[key] = item.place[key];
        if (!exact.sourceURLs.includes(source)) exact.sourceURLs = [...exact.sourceURLs, source];
        enriched.push(exact.id);
      }
      if (!maps.some((m) => m.placeID === exact.id))
        maps.push({ ...item.point, placeID: exact.id });
      continue;
    }
    const possible = catalog.find((p) => {
      const a = nameKey(p.name),
        b = nameKey(item.place.name);
      const point = maps.find((m) => m.placeID === p.id);
      return a === b && (!point || distance(point, item.point) < 250);
    });
    if (possible) {
      held.push({
        id: item.place.id,
        reason: 'same_name_nearby_or_unlocated_requires_review',
        possibleExistingID: possible.id,
      });
      continue;
    }
    catalog.push(item.place);
    maps.push(item.point);
    added.push(item.place.id);
  }
  return { catalog, maps, held, added, enriched };
}

export function approvedImage(value: any): boolean {
  try {
    return (
      new URL(value.imageURL).protocol === 'https:' &&
      ['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(new URL(value.imageURL).hostname) &&
      new URL(value.imageSourceURL).hostname === 'commons.wikimedia.org' &&
      new URL(value.imageLicenseURL).hostname === 'creativecommons.org' &&
      /^(CC BY(?:-SA)? [1-4]\.0|CC0 1\.0|Public domain)$/i.test(value.imageRights) &&
      typeof value.imageCredit === 'string' &&
      value.imageCredit.length > 2 &&
      !!value.fileTitle &&
      !!value.evidenceURL &&
      !!value.checkedAt
    );
  } catch {
    return false;
  }
}

export function applyReview(incoming: { place: Catalog; point: MapPoint }[], review: any) {
  const held: { id: string; reason: string }[] = [];
  const items = incoming
    .filter(({ place }) => {
      const reason = review.exclude?.[place.id];
      if (reason) {
        held.push({ id: place.id, reason });
        return false;
      }
      return true;
    })
    .map(({ place, point }) => {
      const patch = review.patches?.[place.id];
      if (!patch) return { place, point };
      if (!patch.reason || !patch.sourceURL)
        throw new Error('Review patches need factual source and explanation');
      const updated: Catalog = {
        ...place,
        sourceURLs: [...new Set([...place.sourceURLs, patch.sourceURL])],
      };
      for (const key of ['name', 'neighborhood', 'address', 'summary'])
        if (typeof patch[key] === 'string') updated[key] = patch[key];
      updated.reviewProvenance = {
        sourceURL: patch.sourceURL,
        reason: patch.reason,
        reviewedAt: review.reviewedAt,
      };
      return { place: updated, point };
    });
  return { items, held };
}

export function reviewedOfficialImage(value: any): boolean {
  try {
    const source = new URL(value.imageSourceURL),
      image = new URL(value.imageURL);
    return (
      value.imageRights === 'official-public-preview' &&
      value.branchVerified === true &&
      value.reusePermission === 'unknown' &&
      source.protocol === 'https:' &&
      image.protocol === 'https:' &&
      !/(^|\.)(instagram\.com|google\.com|googleusercontent\.com)$/.test(image.hostname) &&
      !!value.imageCredit &&
      !!value.evidenceURL &&
      !!value.checkedAt
    );
  } catch {
    return false;
  }
}

async function writeJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'cache-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      endpoint: { type: 'string', default: ENDPOINT },
      aliases: { type: 'string' },
      images: { type: 'string' },
      'acknowledge-api-policy': { type: 'boolean', default: false },
      'review-rules': { type: 'string' },
      'allow-official-previews': { type: 'boolean', default: false },
    },
  });
  const platform = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    monorepo = resolve(platform, '..');
  const cacheDir = resolve(values['cache-dir'] ?? resolve(platform, 'data/discovery/cache'));
  const outputDir = resolve(values['output-dir'] ?? resolve(platform, 'data/discovery/review'));
  const endpoint = new URL(values.endpoint!);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new Error('Use a public HTTPS Overpass endpoint without embedded credentials');
  const existing: Catalog[] = JSON.parse(
    await readFile(resolve(platform, 'data/places.json'), 'utf8'),
  );
  const points: MapPoint[] = JSON.parse(
    await readFile(resolve(platform, 'data/map-points.json'), 'utf8'),
  );
  const aliases = values.aliases ? JSON.parse(await readFile(values.aliases, 'utf8')) : {};
  const review = values['review-rules']
    ? JSON.parse(await readFile(values['review-rules'], 'utf8'))
    : {};
  if (values.apply && (!review.reviewedAt || !review.exclude))
    throw new Error('--apply requires --review-rules with explicit review date and exclusions');
  const incoming: { place: Catalog; point: MapPoint }[] = [],
    skipped: Record<string, number> = {},
    sources: any[] = [];
  for (const region of REGIONS) {
    const extract = await loadExtract(
      region,
      cacheDir,
      endpoint.href,
      values.refresh!,
      values['acknowledge-api-policy']!,
    );
    sources.push({
      region: region.id,
      bbox: region.bbox,
      fetchedAt: extract.fetchedAt,
      sourceTimestamp: extract.data.osm3s?.timestamp_osm_base,
      querySha256: extract.querySha256,
      endpoint: extract.endpoint,
      sourcePolicy: extract.sourcePolicy,
      received: extract.data.elements.length,
    });
    for (const element of extract.data.elements) {
      const item = candidateFrom(element, region, extract);
      if ('skipped' in item) skipped[item.skipped] = (skipped[item.skipped] ?? 0) + 1;
      else incoming.push(item);
    }
  }
  const reviewed = applyReview(incoming, review);
  const merged = mergeResearch(existing, points, reviewed.items, aliases);
  for (const place of review.additions ?? []) {
    if (
      !place.id ||
      !place.name ||
      !place.sourceURLs?.length ||
      !place.discoveryProvenance?.retrievedAt
    )
      throw new Error('Official addition lacks identity or reviewed source provenance');
    if (!merged.catalog.some((p) => p.id === place.id)) {
      merged.catalog.push(place);
      merged.added.push(place.id);
    }
  }
  let licensedImagesApplied = 0,
    officialPreviewsApplied = 0;
  if (values.images) {
    const images = JSON.parse(await readFile(values.images, 'utf8'));
    for (const image of images) {
      const licensed = approvedImage(image);
      if (!licensed && !(values['allow-official-previews'] && reviewedOfficialImage(image)))
        throw new Error(
          'Image metadata is missing approved license or explicit exact-branch preview evidence',
        );
      const id =
        image.existingID ??
        aliases[`osm-${image.osmType}-${image.osmID}`] ??
        `osm-${image.osmType}-${image.osmID}`;
      const place = merged.catalog.find((p) => p.id === id);
      if (!place || place.merchantMaintained) continue;
      if (!licensed && /^(CC BY|CC0|Public domain)/i.test(place.imageRights ?? '')) continue;
      for (const key of [
        'imageURL',
        'imageSourceURL',
        'imageCredit',
        'imageRights',
        'imageLicenseURL',
      ])
        place[key] = image[key];
      place.imageProvenance = {
        fileTitle: image.fileTitle,
        evidenceURL: image.evidenceURL,
        checkedAt: image.checkedAt,
        ...(image.visualVerification ? { visualVerification: image.visualVerification } : {}),
        ...(!licensed ? { reusePermission: 'unknown', remotePreviewOnly: true } : {}),
      };
      if (licensed) licensedImagesApplied++;
      else officialPreviewsApplied++;
    }
  }
  const count = (items: Catalog[], key: string) =>
    items.reduce<Record<string, number>>((r, p) => {
      const k = String(
        key === 'region'
          ? (p.discoveryProvenance?.region ??
              (p.discoveryProvenance ? 'official-source-supplement' : 'existing'))
          : p[key],
      );
      r[k] = (r[k] ?? 0) + 1;
      return r;
    }, {});
  const additions = merged.catalog.filter((p) => merged.added.includes(p.id));
  const report = {
    generatedAt: new Date().toISOString(),
    applied: values.apply,
    sources,
    priorPlaces: existing.length,
    totalPlaces: merged.catalog.length,
    totalMapped: merged.maps.length,
    added: merged.added.length,
    enriched: merged.enriched.length,
    categoriesAdded: count(additions, 'category'),
    regionsAdded: count(additions, 'region'),
    newRecordsWithImages: additions.filter((p) => p.imageURL).length,
    licensedImagesApplied,
    officialPreviewsApplied,
    totalWithImages: merged.catalog.filter((p) => p.imageURL).length,
    totalMissingImages: merged.catalog.filter((p) => !p.imageURL).length,
    categoriesTotal: count(merged.catalog, 'category'),
    imageRightsTotal: count(
      merged.catalog.filter((p) => p.imageURL),
      'imageRights',
    ),
    healthcareKinds: count(
      merged.catalog
        .filter((p) => p.category === 'healthcare')
        .map((p) => ({ ...p, kind: p.tags?.[0] ?? 'unknown' })),
      'kind',
    ),
    missingImages: additions.filter((p) => !p.imageURL).map((p) => p.id),
    held: [...merged.held, ...reviewed.held],
    skipped,
    coverage:
      'Bounded OSM research extract. Not a complete inventory, current-operation verification, boundary verification, or verified entrance dataset.',
    license: {
      data: 'ODbL-1.0',
      url: LICENSE,
      attribution: '© OpenStreetMap contributors',
      source: 'https://www.openstreetmap.org/copyright',
    },
    preservedLegacyImageCaveat:
      'Existing official-public-preview fields are preserved; they are not asserted to be openly licensed.',
  };
  await writeJSON(resolve(outputDir, 'places.json'), merged.catalog);
  await writeJSON(resolve(outputDir, 'map-points.json'), merged.maps);
  await writeJSON(resolve(outputDir, 'report.json'), report);
  if (values.apply) {
    await writeJSON(resolve(platform, 'data/places.json'), merged.catalog);
    await writeJSON(resolve(platform, 'data/map-points.json'), merged.maps);
    await writeJSON(
      resolve(monorepo, 'native/Sources/KultureKit/Resources/jubilee-places.json'),
      merged.catalog,
    );
  }
  console.log(JSON.stringify({ ...report, missingImages: report.missingImages.length }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('Discovery stopped:', e.message);
    process.exitCode = 1;
  });
}
