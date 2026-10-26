import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGIONS,
  candidateFrom,
  mergeResearch,
  robotsAllows,
  approvedImage,
  reviewedOfficialImage,
  applyReview,
  categoryFor,
  type OSMElement,
} from '../scripts/discover-city-places.js';
const region = REGIONS[0];
const extract = {
  fetchedAt: '2026-09-19T13:39:14.472Z',
  querySha256: 'a'.repeat(64),
  data: { elements: [], osm3s: { timestamp_osm_base: '2026-09-19T13:37:21Z' } },
};
const node: OSMElement = {
  type: 'node',
  id: 42,
  lat: 17.39,
  lon: 78.34,
  tags: { name: 'Example Clinic', amenity: 'clinic' },
};
function candidate(e: OSMElement = node) {
  const result = candidateFrom(e, region, extract);
  assert('place' in result);
  return result;
}
test('source date and exact feature identity survive; absent address, hours, ratings and entrance are not invented', () => {
  const { place, point } = candidate();
  assert.equal(place.id, 'osm-node-42');
  assert.equal(place.category, 'healthcare');
  assert.equal(place.researchedAt, '2026-09-19');
  assert.equal(place.coordinateKind, 'poi');
  assert.match(place.address, /not provided/);
  assert.match(place.neighborhood, /boundary unverified/);
  assert.equal(place.openingHours, undefined);
  assert.equal(place.rating, undefined);
  assert.equal(place.dataLicense, 'ODbL-1.0');
  assert.match(point.confidenceNote, /Not an entrance/);
  assert.deepEqual(place.sourceURLs, ['https://www.openstreetmap.org/node/42']);
});
test('bounding box centers stay distinct from POI nodes and outside/invalid points are excluded', () => {
  const way = candidate({
    type: 'way',
    id: 43,
    center: { lat: 17.39, lon: 78.34 },
    tags: { name: 'Example Park', leisure: 'park' },
  });
  assert.equal(way.place.coordinateKind, 'bbox_center');
  assert.match(way.point.confidenceNote, /may not lie inside/);
  assert('skipped' in candidateFrom({ ...node, lat: 18 }, region, extract));
  assert('skipped' in candidateFrom({ ...node, lat: NaN }, region, extract));
});
test('unnamed, disused and restricted gathering spaces are withheld; bookstore is not falsely stationery', () => {
  for (const tags of [
    { amenity: 'clinic' },
    { name: 'Old clinic', amenity: 'clinic', disused: 'yes' },
    { name: 'Residents garden', leisure: 'garden', access: 'private' },
  ] as Record<string, string>[])
    assert('skipped' in candidateFrom({ ...node, tags }, region, extract));
  assert.equal(categoryFor({ shop: 'books' }), 'shopping');
  assert.equal(categoryFor({ shop: 'stationery' }), 'stationery');
  assert.equal(categoryFor({ amenity: 'community_centre' }), 'community');
});
test('merge is repeatable, preserves editorial IDs and never overwrites a merchant-maintained record', () => {
  const item = candidate();
  const existing = {
    id: 'stable-branch',
    name: 'Owner edited name',
    sourceURLs: [],
    summary: 'Owner facts',
    merchantMaintained: true,
  };
  const held = mergeResearch([existing], [], [item], { 'osm-node-42': existing.id });
  assert.deepEqual(held.catalog, [existing]);
  assert.equal(held.maps.length, 0);
  const first = mergeResearch([], [], [item]);
  const second = mergeResearch(first.catalog, first.maps, [item]);
  assert.deepEqual(second.catalog, first.catalog);
  assert.deepEqual(second.maps, first.maps);
  assert.equal(second.added.length, 0);
  const editorial = {
    id: 'stable-editorial',
    name: 'Curated Clinic',
    sourceURLs: [],
    summary: 'Preserved editorial description',
  };
  const merged = mergeResearch([editorial], [], [item], { 'osm-node-42': editorial.id });
  assert.equal(merged.catalog.length, 1);
  assert.equal(merged.catalog[0].id, editorial.id);
  assert.equal(merged.catalog[0].summary, editorial.summary);
  assert.equal(merged.maps[0].placeID, editorial.id);
});
test('same unlocated business name is held for review instead of silently creating a duplicate branch', () => {
  const item = candidate();
  const merged = mergeResearch(
    [{ id: 'existing', name: 'Example Clinic', sourceURLs: [] }],
    [],
    [item],
  );
  assert.equal(merged.added.length, 0);
  assert.equal(merged.held.length, 1);
});
test('robots respects specific agent policy, wildcards and longest allow exception', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /api/\n', '/api/interpreter'), false);
  assert.equal(
    robotsAllows('User-agent: *\nDisallow: /\nAllow: /api/interpreter\n', '/api/interpreter'),
    true,
  );
  assert.equal(
    robotsAllows(
      'User-agent: *\nAllow: /\nUser-agent: KultureDiscovery\nDisallow: /\n',
      '/api/interpreter',
    ),
    false,
  );
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*private$\n', '/path/private'), false);
});
test('image candidates require reusable license, attribution, Commons source and exact-place evidence', () => {
  const valid = {
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg',
    imageSourceURL: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
    imageCredit: 'Named author',
    imageRights: 'CC BY-SA 4.0',
    imageLicenseURL: 'https://creativecommons.org/licenses/by-sa/4.0/',
    fileTitle: 'File:Test.jpg',
    evidenceURL: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
    checkedAt: '2026-10-01',
  };
  assert(approvedImage(valid));
  assert(!approvedImage({ ...valid, imageRights: 'official-public-preview' }));
  assert(!approvedImage({ ...valid, imageCredit: '' }));
  assert(!approvedImage({ ...valid, imageURL: 'https://instagram.com/image.jpg' }));
});
test('review explicitly withholds address conflicts and preserves coordinate evidence when correcting branch facts', () => {
  const item = candidate();
  assert.equal(
    applyReview([item], { exclude: { 'osm-node-42': 'Address conflicts with mapped locality' } })
      .items.length,
    0,
  );
  const reviewed = applyReview([item], {
    reviewedAt: '2026-10-01',
    patches: {
      'osm-node-42': {
        name: 'Corrected Clinic',
        sourceURL: 'https://clinic.example/contact',
        reason: 'Official branch page',
      },
    },
  });
  assert.equal(reviewed.items[0].place.name, 'Corrected Clinic');
  assert.equal(reviewed.items[0].place.coordinateSource, 'OpenStreetMap');
  assert.deepEqual(reviewed.items[0].point, item.point);
  assert.throws(() =>
    applyReview([item], { patches: { 'osm-node-42': { name: 'Unsupported change' } } }),
  );
});
test('official photos are separately labelled previews, never converted into licensed assets', () => {
  const preview = {
    imageURL: 'https://hospital.example/exterior.jpg',
    imageSourceURL: 'https://hospital.example/branch',
    imageCredit: 'Hospital official branch page; photographer unspecified',
    imageRights: 'official-public-preview',
    branchVerified: true,
    reusePermission: 'unknown',
    evidenceURL: 'https://hospital.example/branch',
    checkedAt: '2026-10-01',
  };
  assert(reviewedOfficialImage(preview));
  assert(!approvedImage(preview));
  assert(!reviewedOfficialImage({ ...preview, branchVerified: false }));
  assert(!reviewedOfficialImage({ ...preview, imageURL: 'https://instagram.com/image.jpg' }));
});
