import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { graphSchema, releaseErrors, type Graph } from '../src/maps/graph.js';
import { canonicalJSON, digest } from '../src/maps/canonical.js';
import {
  planRoute,
  scheduleOpen,
  availabilityExpiry,
  type RouteOptions,
} from '../src/maps/planner.js';
const raw = JSON.parse(
  await readFile(new URL('fixtures/arrival-graph-v2.json', import.meta.url), 'utf8'),
);
const graph = () => graphSchema.parse(structuredClone(raw));
const now = new Date('2026-09-29T04:00:00Z');
const opts: RouteOptions = {
  placeID: 'example-branch',
  mode: 'walking',
  stepFree: false,
  locale: 'en',
  now,
  departureAt: now,
};
test('graph v2 is lossless, strict and keeps indoor coordinates unknown', () => {
  const g = graph();
  assert.deepEqual(g, raw);
  assert.equal(g.nodes.find((n) => n.id === 'shop')!.outdoorPoint, null);
  assert.equal(canonicalJSON(g), canonicalJSON(JSON.parse(JSON.stringify(g))));
  assert.equal(digest(g), digest({ ...g, nodes: g.nodes }));
  const duplicate = graph();
  duplicate.nodes.push(duplicate.nodes[0]);
  assert.throws(() => graphSchema.parse(duplicate));
  const bad = graph();
  bad.directedEdges.find((e) => e.id === 'lift-up')!.traversalType = 'corridor';
  assert.throws(() => graphSchema.parse(bad));
  assert.throws(() => graphSchema.parse({ ...g, futureField: 'must not silently disappear' }));
  assert.equal(releaseErrors(g, now).length, 0);
  assert(releaseErrors({ ...g, sample: true }, now).some((e) => e.includes('Sample')));
});
test('directed weighted planning chooses the supported entrance and never invents reverse edges', () => {
  const g = graph(),
    r = planRoute(g, [], opts);
  assert(r.route);
  assert(r.route.edgeIDs.includes('lift-up'));
  assert.equal(r.selectedEntrance?.approach.nodeID, 'approach');
  assert.equal(r.route.checkpoints.at(-1)?.instruction, 'Proceed from lift-first to shop.');
  const reverse = graph(),
    e = reverse.directedEdges[0];
  [e.fromNodeID, e.toNodeID] = [e.toNodeID, e.fromNodeID];
  assert.equal(planRoute(reverse, [], opts).route, null);
  assert(
    planRoute(g, [], { ...opts, mode: 'driving' }).route,
    'Driving chooses its approach, then offers pedestrian indoor steps.',
  );
  assert.equal(planRoute(g, [], { ...opts, entranceID: 'another-door' }).route, null);
});
test('closed lift gives a stair alternative only when allowed; stale/unknown accessibility never passes', () => {
  const g = graph(),
    closures = [
      {
        id: 'close',
        targetType: 'lift' as const,
        targetID: 'lift-a',
        startsAt: '2026-09-29T00:00:00Z',
        endsAt: null,
        reason: 'Service closure',
        revision: 1,
        status: 'active' as const,
      },
    ];
  assert(planRoute(g, closures, opts).route?.edgeIDs.includes('stairs-up'));
  assert.equal(planRoute(g, closures, { ...opts, stepFree: true }).route, null);
  const unknown = graph();
  unknown.directedEdges[0].accessibilityEvidence.stepFree = 'unknown';
  assert.equal(planRoute(unknown, [], { ...opts, stepFree: true }).route, null);
  const stale = graph();
  stale.verificationRecords[0].validUntil = '2026-01-02T00:00:00Z';
  assert.equal(planRoute(stale, [], opts).route, null);
});
test('Asia/Kolkata schedules handle overnight intervals, exceptions and traversal-time closure', () => {
  const overnight = {
    timeZone: 'Asia/Kolkata',
    weekly: [{ day: 1, intervals: [{ start: '22:00', end: '02:00' }] }],
    exceptions: [],
  };
  assert(scheduleOpen(overnight, new Date('2026-09-28T20:00:00Z')));
  assert(!scheduleOpen(overnight, new Date('2026-09-28T21:00:00Z')));
  assert(
    !scheduleOpen(
      { ...overnight, exceptions: [{ date: '2026-09-29', intervals: [] }] },
      new Date('2026-09-28T20:00:00Z'),
    ),
  );
  const g = graph();
  g.directedEdges[0].openingSchedule = {
    timeZone: 'Asia/Kolkata',
    weekly: [{ day: 2, intervals: [{ start: '09:00', end: '09:31' }] }],
    exceptions: [],
  };
  g.directedEdges[0].baseDurationSeconds = 90;
  assert.equal(
    planRoute(g, [], opts).route,
    null,
    'Cannot traverse after the gate closes; no invented wait.',
  );
  assert.equal(availabilityExpiry(g, [], now).toISOString(), '2026-09-29T04:01:00.000Z');
});
test('unmeasured photo paths omit distance/ETA, and cannot predict an hours-dependent passage', () => {
  const g = graph();
  g.directedEdges[0].baseDurationSeconds = null;
  g.directedEdges[0].lengthMetres = null;
  const r = planRoute(g, [], opts);
  assert(r.route);
  assert.equal(r.route.durationSeconds, null);
  assert.equal(r.route.lengthMetres, null);
  assert.equal(r.route.costKind, 'estimated');
  g.directedEdges[1].openingSchedule = {
    timeZone: 'Asia/Kolkata',
    weekly: [{ day: 2, intervals: [{ start: '00:00', end: '24:00' }] }],
    exceptions: [],
  };
  assert.equal(planRoute(g, [], opts).route, null);
});
test('direction-specific turns use their own photo and text, and expired turn evidence cannot be traversed', () => {
  const g = graph(),
    incoming = g.directedEdges[0],
    outgoing = g.directedEdges.find((e) => e.fromNodeID === incoming.toNodeID)!;
  g.verificationRecords.push({ ...g.verificationRecords[0], id: 'turn-proof' });
  g.turnInstructions = [
    {
      id: 'right-turn',
      incomingEdgeID: incoming.id,
      outgoingEdgeID: outgoing.id,
      instructionByLocale: { en: 'At the sign, turn right toward the lift.' },
      photoIDs: ['99999999-9999-4999-8999-999999999999'],
      verificationRef: 'turn-proof',
    },
  ];
  incoming.turnInstructionRefs = ['right-turn'];
  const r = planRoute(graphSchema.parse(g), [], opts);
  assert.equal(
    r.route?.checkpoints.find((c) => c.nodeID === incoming.toNodeID)?.instruction,
    'At the sign, turn right toward the lift.',
  );
  assert.deepEqual(r.route?.checkpoints.find((c) => c.nodeID === incoming.toNodeID)?.photoIDs, [
    '99999999-9999-4999-8999-999999999999',
  ]);
  g.verificationRecords.find((v) => v.id === 'turn-proof')!.validUntil = '2026-09-28T00:00:00Z';
  assert.equal(planRoute(g, [], opts).route, null);
});
test('release rejects disconnected branch paths and unsupported restriction references rather than ignoring them', () => {
  const g = graph();
  g.directedEdges[0].restrictionRefs = ['unresolved-turn-prohibition'];
  assert(releaseErrors(g, now).some((e) => e.includes('unresolved')));
  assert.equal(planRoute(g, [], opts).route, null);
  const disconnected = graph();
  disconnected.directedEdges = disconnected.directedEdges.filter((e) => e.toNodeID !== 'shop');
  assert(releaseErrors(disconnected, now).some((e) => e.includes('directed pedestrian')));
  const placeholder = graph();
  placeholder.directedEdges[0].instructionByLocale.en = 'Instructions not recorded.';
  assert(releaseErrors(placeholder, now).some((e) => e.includes('recorded directional')));
});
test('evidence and closures stay valid over the segment, while unused expired alternatives do not invalidate a valid path', () => {
  const g = graph();
  g.verificationRecords.push({
    ...g.verificationRecords[0],
    id: 'access-short',
    validUntil: '2026-09-29T04:00:01Z',
  });
  g.directedEdges[0].accessibilityEvidence.evidenceID = 'access-short';
  assert.equal(
    planRoute(g, [], { ...opts, stepFree: true }).route,
    null,
    'Evidence expiring mid-segment cannot certify it.',
  );
  const alternative = graph();
  alternative.verificationRecords.push({
    ...alternative.verificationRecords[0],
    id: 'old-stairs',
    validUntil: '2026-09-28T00:00:00Z',
  });
  alternative.directedEdges.find((e) => e.id === 'stairs-up')!.verificationRef = 'old-stairs';
  assert(planRoute(alternative, [], opts).route);
  assert(availabilityExpiry(alternative, [], now) > now);
  const closures = [
    {
      id: 'later',
      targetType: 'edge' as const,
      targetID: g.directedEdges[0].id,
      startsAt: '2026-09-29T04:00:01Z',
      endsAt: null,
      reason: 'Starts while walking',
      revision: 1,
      status: 'active' as const,
    },
  ];
  assert.equal(planRoute(graph(), closures, opts).route, null);
  assert.equal(
    availabilityExpiry(graph(), closures, now).toISOString(),
    '2026-09-29T04:00:01.000Z',
  );
});
test('v1 conversion preserves diagram coordinates but never promotes defaults, booleans or private photos to evidence', async () => {
  const { importLegacyGraph } = await import('../src/maps/legacy.js');
  const legacy = {
    schemaVersion: 1,
    id: 'old',
    name: 'Legacy synthetic map',
    address: 'Test',
    sample: false,
    destinationId: 'door',
    nodes: [
      {
        id: 'road',
        label: 'Road',
        type: 'approach',
        floor: 0,
        x: 10,
        y: 50,
        lat: 17,
        lng: 78,
        instruction: 'Old left/right text',
        verified: true,
        photoUrl: '/private/photo',
      },
      {
        id: 'entry',
        label: 'Entry',
        type: 'entrance',
        floor: 0,
        x: 30,
        y: 50,
        lat: 17,
        lng: 78,
        instruction: 'Old',
      },
      {
        id: 'door',
        label: 'Door',
        type: 'destination',
        floor: 0,
        x: 80,
        y: 50,
        lat: 17,
        lng: 78,
        instruction: 'Old',
      },
    ],
    edges: [
      { id: 'one', from: 'road', to: 'entry', accessible: true },
      { id: 'two', from: 'entry', to: 'door', accessible: true },
    ],
  };
  const converted = importLegacyGraph(legacy, 'example-branch', 'legacy-building');
  assert.equal(converted.graph.sample, true);
  assert.equal(converted.graph.nodes[0].localPosition?.x, 10);
  assert(
    converted.graph.nodes.every(
      (n) => n.outdoorPoint === null && n.evidenceID === null && n.permittedPhotoIDs.length === 0,
    ),
  );
  assert(
    converted.graph.directedEdges.every((e) => e.accessibilityEvidence.stepFree === 'unknown'),
  );
  assert.equal(planRoute(converted.graph, [], opts).route, null);
  assert(releaseErrors(converted.graph, now).length > 0);
  assert.equal(JSON.parse(converted.legacySourceJSON).id, 'old');
});
