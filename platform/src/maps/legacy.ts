import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { graphSchema, type Graph } from './graph.js';
const legacySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    name: z.string(),
    address: z.string(),
    sample: z.boolean(),
    destinationId: z.string(),
    revision: z.number().optional(),
    floors: z.array(z.number()).optional(),
    floorPlans: z.record(z.string(), z.string()).optional(),
    boundaries: z
      .record(z.string(), z.array(z.object({ x: z.number(), y: z.number() }).strict()))
      .optional(),
    nodes: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            type: z.enum(['approach', 'entrance', 'waypoint', 'stairs', 'lift', 'destination']),
            floor: z.number(),
            x: z.number().min(0).max(100),
            y: z.number().min(0).max(100),
            lat: z.number(),
            lng: z.number(),
            instruction: z.string(),
            photoUrl: z.string().optional(),
            verified: z.boolean().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(500),
    edges: z
      .array(
        z
          .object({ id: z.string(), from: z.string(), to: z.string(), accessible: z.boolean() })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict();
/** A controlled v1 conversion, not evidence migration. Keep the original file for reconciliation.
 * Legacy undirected/boolean accessibility, default coordinates and private photo URLs are never certified.
 */
export function importLegacyGraph(input: unknown, placeID: string, buildingID: string) {
  const v = legacySchema.parse(input),
    floors = [...new Set(v.nodes.map((n) => n.floor))].sort((a, b) => a - b),
    floorID = (n: number) => `legacy-floor-${n}`;
  const connectors = new Map<string, string>();
  for (const node of v.nodes.filter((n) => ['stairs', 'lift'].includes(n.type))) {
    if (connectors.has(node.id)) continue;
    const connector = `legacy-connector-${connectors.size}`,
      queue = [node.id];
    while (queue.length) {
      const id = queue.shift()!;
      if (connectors.has(id)) continue;
      connectors.set(id, connector);
      for (const edge of v.edges) {
        const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (next && v.nodes.find((n) => n.id === next)?.type === node.type) queue.push(next);
      }
    }
  }
  const approach = v.nodes.find((n) => n.type === 'approach'),
    entrance = v.nodes.find((n) => n.type === 'entrance');
  if (!approach || !entrance)
    throw new Error('Legacy import requires explicit approach and entrance nodes.');
  const graph: Graph = {
    schemaVersion: 2,
    graphID: randomUUID(),
    buildingID,
    name: v.name,
    sample: true,
    floors: floors.map((f) => ({
      id: floorID(f),
      label: f === 0 ? 'G' : String(f),
      order: f,
      planAssetID: null,
      frame: {
        units: 'percent',
        width: 100,
        height: 100,
        origin: 'top-left',
        xAxis: 'right',
        yAxis: 'down',
        calibrationRevision: 0,
        surveyed: false,
      },
      boundary: v.boundaries?.[String(f)] ?? [],
    })),
    nodes: v.nodes.map((n) => ({
      id: n.id,
      floorID: floorID(n.floor),
      type: n.type,
      localPosition: { x: n.x, y: n.y },
      outdoorPoint: null,
      labelByLocale: { en: n.label },
      permittedPhotoIDs: [],
      evidenceID: null,
      accessPolicy: { state: 'unknown', evidenceID: null, schedule: null },
      connectorID: connectors.get(n.id) ?? null,
    })),
    directedEdges: v.edges.map((e) => {
      const a = v.nodes.find((n) => n.id === e.from)!,
        b = v.nodes.find((n) => n.id === e.to)!;
      if (!a || !b) throw new Error('Legacy edge endpoint is missing.');
      const traversal =
        a.floor !== b.floor && ['stairs', 'lift'].includes(a.type)
          ? (a.type as 'stairs' | 'lift')
          : 'corridor';
      return {
        id: e.id,
        fromNodeID: e.from,
        toNodeID: e.to,
        traversalType: traversal,
        geometry: null,
        lengthMetres: null,
        baseDurationSeconds: null,
        costSource: 'unknown',
        steps: null,
        restrictionRefs: [],
        turnInstructionRefs: [],
        permittedModes: ['walking'],
        openingSchedule: null,
        instructionByLocale: { en: 'Instructions not recorded.' },
        directionalPhotoIDs: [],
        verificationRef: null,
        accessibilityEvidence: {
          stepFree: 'unknown',
          evidenceID: null,
          clearWidthMm: null,
          slope: null,
          surface: null,
        },
        liftID: traversal === 'lift' ? connectors.get(a.id)! : null,
        accessState: 'unknown',
      };
    }),
    entrances: [
      {
        id: 'legacy-entrance',
        nodeID: entrance.id,
        approachNodeID: approach.id,
        permittedModes: ['walking'],
        labelByLocale: { en: entrance.label },
      },
    ],
    placeDestinationBindings: [
      { placeID, destinationNodeID: v.destinationId, entranceIDs: ['legacy-entrance'] },
    ],
    turnInstructions: [],
    verificationRecords: [],
  };
  return {
    graph: graphSchema.parse(graph),
    warnings: [
      'Draft/sample only; collect new authority and verification before publication.',
      'Legacy latitude/longitude and accessible booleans were not certified or imported as facts.',
      'Re-upload and review original checkpoint/floor-plan images. Private URLs are not public assets.',
      'Confirm every edge direction and rewrite directional instructions; legacy BFS traversed edges both ways.',
    ],
    legacySourceJSON: JSON.stringify(v),
  };
}
