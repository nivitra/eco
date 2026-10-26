import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const instant = z.iso.datetime({ offset: true });
const locales = z
  .record(
    z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
    z.string().trim().min(1).max(1000),
  )
  .refine((x) => Object.keys(x).length > 0 && Object.keys(x).length <= 12);
const point = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMetres: z.number().finite().positive().max(100),
    source: z.enum(['survey', 'owner_observation']),
    verifiedAt: instant,
    validUntil: instant,
  })
  .strict();
const evidence = z
  .object({
    id,
    source: z.enum(['owner_confirmed', 'independent']),
    confirmedAt: instant,
    validUntil: instant,
    note: z.string().max(1000),
  })
  .strict();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const interval = z
  .object({ start: clock, end: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/) })
  .strict()
  .refine((x) => x.start !== x.end, 'Equal start/end is ambiguous; use 00:00–24:00 for all day.');
export const scheduleSchema = z
  .object({
    timeZone: z
      .string()
      .max(80)
      .refine((s) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }),
    weekly: z
      .array(
        z
          .object({ day: z.number().int().min(0).max(6), intervals: z.array(interval).max(8) })
          .strict(),
      )
      .max(7),
    exceptions: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            intervals: z.array(interval).max(8),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.weekly.map((x) => x.day)).size !== s.weekly.length ||
      new Set(s.exceptions.map((x) => x.date)).size !== s.exceptions.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Schedule days and exception dates must be unique.',
      });
  });
const access = z
  .object({
    state: z.enum(['open', 'unknown', 'blocked']),
    evidenceID: id.nullable(),
    schedule: scheduleSchema.nullable(),
  })
  .strict();
export const graphSchema = z
  .object({
    schemaVersion: z.literal(2),
    graphID: id,
    buildingID: id,
    name: z.string().trim().min(1).max(160),
    sample: z.boolean(),
    floors: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1).max(60),
            order: z.number().finite(),
            planAssetID: z.uuid().nullable(),
            frame: z
              .object({
                units: z.enum(['percent', 'metres', 'pixels']),
                width: z.number().positive(),
                height: z.number().positive(),
                origin: z.literal('top-left'),
                xAxis: z.literal('right'),
                yAxis: z.literal('down'),
                calibrationRevision: z.number().int().nonnegative(),
                surveyed: z.boolean(),
              })
              .strict(),
            boundary: z
              .array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    nodes: z
      .array(
        z
          .object({
            id,
            floorID: id,
            type: z.enum([
              'approach',
              'entrance',
              'waypoint',
              'stairs',
              'lift',
              'ramp',
              'destination',
            ]),
            localPosition: z
              .object({ x: z.number().finite(), y: z.number().finite() })
              .strict()
              .nullable(),
            outdoorPoint: point.nullable(),
            labelByLocale: locales,
            permittedPhotoIDs: z.array(z.uuid()).max(5),
            evidenceID: id.nullable(),
            accessPolicy: access,
            connectorID: id.nullable(),
          })
          .strict(),
      )
      .min(2)
      .max(500),
    directedEdges: z
      .array(
        z
          .object({
            id,
            fromNodeID: id,
            toNodeID: id,
            traversalType: z.enum([
              'pavement',
              'crossing',
              'entrance',
              'corridor',
              'stairs',
              'lift',
              'ramp',
            ]),
            geometry: z
              .array(
                z.object({ x: z.number().finite(), y: z.number().finite(), floorID: id }).strict(),
              )
              .max(500)
              .nullable(),
            lengthMetres: z.number().finite().positive().max(10000).nullable(),
            baseDurationSeconds: z.number().finite().positive().max(7200).nullable(),
            costSource: z.enum(['measured', 'estimated', 'unknown']),
            steps: z.number().int().positive().nullable(),
            restrictionRefs: z.array(id).max(30),
            turnInstructionRefs: z.array(id).max(30),
            permittedModes: z
              .array(z.enum(['walking', 'driving']))
              .min(1)
              .max(2),
            openingSchedule: scheduleSchema.nullable(),
            instructionByLocale: locales,
            directionalPhotoIDs: z.array(z.uuid()).max(5),
            verificationRef: id.nullable(),
            accessibilityEvidence: z
              .object({
                stepFree: z.enum(['confirmed', 'unknown', 'no']),
                evidenceID: id.nullable(),
                clearWidthMm: z.number().positive().nullable(),
                slope: z.number().min(0).max(100).nullable(),
                surface: z.string().max(120).nullable(),
              })
              .strict(),
            liftID: id.nullable(),
            accessState: z.enum(['open', 'unknown', 'blocked']),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    entrances: z
      .array(
        z
          .object({
            id,
            nodeID: id,
            approachNodeID: id,
            permittedModes: z
              .array(z.enum(['walking', 'driving']))
              .min(1)
              .max(2),
            labelByLocale: locales,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    placeDestinationBindings: z
      .array(
        z
          .object({ placeID: id, destinationNodeID: id, entranceIDs: z.array(id).min(1).max(20) })
          .strict(),
      )
      .min(1)
      .max(100),
    turnInstructions: z
      .array(
        z
          .object({
            id,
            incomingEdgeID: id,
            outgoingEdgeID: id,
            instructionByLocale: locales,
            photoIDs: z.array(z.uuid()).max(5),
            verificationRef: id,
          })
          .strict(),
      )
      .max(1000),
    verificationRecords: z.array(evidence).max(2500),
  })
  .strict()
  .superRefine((g, ctx) => {
    const err = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const [label, values] of [
      ['floor', g.floors],
      ['node', g.nodes],
      ['edge', g.directedEdges],
      ['entrance', g.entrances],
      ['evidence', g.verificationRecords],
      ['turn', g.turnInstructions],
    ] as const)
      if (new Set(values.map((v) => v.id)).size !== values.length) err(`Duplicate ${label} ID.`);
    if (
      new Set(g.placeDestinationBindings.map((v) => v.placeID)).size !==
      g.placeDestinationBindings.length
    )
      err('One destination binding per branch is required.');
    const floors = new Map(g.floors.map((f) => [f.id, f])),
      nodes = new Map(g.nodes.map((n) => [n.id, n])),
      proof = new Map(g.verificationRecords.map((v) => [v.id, v]));
    const checkProof = (key: string | null) => {
      if (key && !proof.has(key)) err('Evidence reference does not exist.');
    };
    for (const v of g.verificationRecords)
      if (Date.parse(v.validUntil) <= Date.parse(v.confirmedAt))
        err('Evidence expiry must follow confirmation.');
    for (const n of g.nodes) {
      const f = floors.get(n.floorID);
      if (!f) err('Node floor does not exist.');
      if (
        n.localPosition &&
        f &&
        (n.localPosition.x < 0 ||
          n.localPosition.y < 0 ||
          n.localPosition.x > f.frame.width ||
          n.localPosition.y > f.frame.height)
      )
        err('Node lies outside its floor coordinate frame.');
      if (
        n.outdoorPoint &&
        Date.parse(n.outdoorPoint.validUntil) <= Date.parse(n.outdoorPoint.verifiedAt)
      )
        err('Outdoor evidence has invalid dates.');
      checkProof(n.evidenceID);
      checkProof(n.accessPolicy.evidenceID);
    }
    for (const e of g.directedEdges) {
      const a = nodes.get(e.fromNodeID),
        b = nodes.get(e.toNodeID);
      if (!a || !b || a.id === b.id) {
        err('Edges require distinct existing endpoints.');
        continue;
      }
      if (
        a.floorID !== b.floorID &&
        (!['stairs', 'lift', 'ramp'].includes(e.traversalType) ||
          !a.connectorID ||
          a.connectorID !== b.connectorID ||
          a.type !== e.traversalType ||
          b.type !== e.traversalType)
      )
        err('Floor transitions require matching explicit connector nodes.');
      if (e.traversalType === 'stairs' && e.accessibilityEvidence.stepFree === 'confirmed')
        err('Stairs cannot be step-free.');
      if (
        e.traversalType === 'lift' &&
        (!e.liftID || a.connectorID !== e.liftID || b.connectorID !== e.liftID)
      )
        err('Lift edges must reference their connector.');
      checkProof(e.verificationRef);
      checkProof(e.accessibilityEvidence.evidenceID);
    }
    for (const turn of g.turnInstructions) {
      const incoming = g.directedEdges.find((e) => e.id === turn.incomingEdgeID),
        outgoing = g.directedEdges.find((e) => e.id === turn.outgoingEdgeID);
      if (!incoming || !outgoing || incoming.toNodeID !== outgoing.fromNodeID)
        err('Turn instructions require adjacent directed edges.');
      checkProof(turn.verificationRef);
    }
    for (const e of g.directedEdges) {
      if (e.geometry?.some((p) => !floors.has(p.floorID)))
        err('Edge geometry references an unknown floor.');
      if (e.turnInstructionRefs.some((id) => !g.turnInstructions.some((t) => t.id === id)))
        err('Unknown turn instruction.');
      if (e.costSource === 'measured' && e.lengthMetres === null && e.baseDurationSeconds === null)
        err('Measured cost requires measured length or duration.');
    }
    for (const e of g.entrances) {
      if (
        nodes.get(e.nodeID)?.type !== 'entrance' ||
        nodes.get(e.approachNodeID)?.type !== 'approach'
      )
        err('Entrance requires entrance and approach nodes.');
    }
    for (const b of g.placeDestinationBindings)
      if (
        nodes.get(b.destinationNodeID)?.type !== 'destination' ||
        b.entranceIDs.some((id) => !g.entrances.some((e) => e.id === id))
      )
        err('Branch binding has an invalid destination or entrance.');
  });
export type Graph = z.infer<typeof graphSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type GraphNode = Graph['nodes'][number];
export type GraphEdge = Graph['directedEdges'][number];
export const label = (values: Record<string, string>, locale: string) =>
  values[locale] ?? values[locale.split('-')[0]] ?? values.en ?? Object.values(values)[0] ?? '';
export function graphAssetIDs(g: Graph): string[] {
  return [
    ...new Set([
      ...g.floors.flatMap((f) => (f.planAssetID ? [f.planAssetID] : [])),
      ...g.nodes.flatMap((n) => n.permittedPhotoIDs),
      ...g.directedEdges.flatMap((e) => e.directionalPhotoIDs),
      ...g.turnInstructions.flatMap((t) => t.photoIDs),
    ]),
  ];
}
export function releaseErrors(g: Graph, at = new Date()): string[] {
  const errors: string[] = [];
  if (g.sample) errors.push('Sample graphs cannot be publicly released.');
  const proof = new Map(g.verificationRecords.map((v) => [v.id, v]));
  const current = (id: string | null) =>
    !!id &&
    !!proof.get(id) &&
    Date.parse(proof.get(id)!.confirmedAt) <= at.getTime() &&
    Date.parse(proof.get(id)!.validUntil) > at.getTime();
  for (const n of g.nodes) {
    if (!current(n.evidenceID) || !current(n.accessPolicy.evidenceID))
      errors.push(`Node ${n.id} needs current verification.`);
    if (!n.permittedPhotoIDs.length)
      errors.push(`Node ${n.id} needs a permitted checkpoint photo.`);
  }
  for (const e of g.directedEdges) {
    if (e.restrictionRefs.length)
      errors.push(
        `Edge ${e.id} has unresolved restriction references; encode supported access and schedule constraints before publication.`,
      );
    if (
      Object.values(e.instructionByLocale).some((t) =>
        /^(instructions not recorded|new connection|todo)\.?$/i.test(t),
      )
    )
      errors.push(`Edge ${e.id} needs recorded directional instructions.`);
    if (!current(e.verificationRef)) errors.push(`Edge ${e.id} needs current verification.`);
    if (
      e.accessibilityEvidence.stepFree === 'confirmed' &&
      !current(e.accessibilityEvidence.evidenceID)
    )
      errors.push(`Edge ${e.id} needs current step-free evidence.`);
  }
  for (const t of g.turnInstructions)
    if (!current(t.verificationRef)) errors.push(`Turn ${t.id} needs current verification.`);
  for (const e of g.entrances) {
    const n = g.nodes.find((n) => n.id === e.approachNodeID);
    if (
      !n?.outdoorPoint ||
      Date.parse(n.outdoorPoint.verifiedAt) > at.getTime() ||
      Date.parse(n.outdoorPoint.validUntil) <= at.getTime()
    )
      errors.push(`Entrance ${e.id} needs a current surveyed/observed outdoor approach.`);
  }
  // Structural reachability is independent of today's opening hours. Time eligibility is evaluated per request.
  for (const b of g.placeDestinationBindings) {
    const reachable = b.entranceIDs.some((id) => {
      const e = g.entrances.find((e) => e.id === id)!;
      const queue: [string, boolean][] = [[e.approachNodeID, false]],
        seen = new Set<string>();
      while (queue.length) {
        const [node, entered] = queue.shift()!;
        const key = node + ':' + entered;
        if (seen.has(key)) continue;
        seen.add(key);
        if (node === b.destinationNodeID && entered) return true;
        for (const edge of g.directedEdges.filter(
          (x) => x.fromNodeID === node && x.permittedModes.includes('walking'),
        ))
          queue.push([edge.toNodeID, entered || edge.toNodeID === e.nodeID]);
      }
      return false;
    });
    if (!reachable)
      errors.push(
        `Branch ${b.placeID} has no directed pedestrian connection through a bound entrance to its destination.`,
      );
  }
  return [...new Set(errors)];
}
