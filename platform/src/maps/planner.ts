import { type Graph, type Schedule, type GraphEdge, label } from './graph.js';
export interface Closure {
  id: string;
  targetType: 'entrance' | 'node' | 'edge' | 'lift';
  targetID: string;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  revision: number;
  status: 'active' | 'resolved';
}
export interface RouteOptions {
  placeID: string;
  mode: 'walking' | 'driving';
  stepFree: boolean;
  locale: string;
  entranceID?: string;
  departureAt: Date;
  now: Date;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function local(at: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    day: new Date(date + 'T12:00:00Z').getUTCDay(),
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function intervals(s: Schedule, date: string, day: number) {
  return (
    s.exceptions.find((x) => x.date === date)?.intervals ??
    s.weekly.find((x) => x.day === day)?.intervals ??
    []
  );
}
/** Weekly overnight intervals belong to the day on which they start. Explicit exceptions override that date. */
export function scheduleOpen(s: Schedule | null, at: Date): boolean {
  if (!s) return true;
  const t = local(at, s.timeZone),
    today = intervals(s, t.date, t.day);
  if (
    today.some((x) => {
      const a = minute(x.start),
        b = minute(x.end);
      return b > a ? t.minute >= a && t.minute < b : t.minute >= a;
    })
  )
    return true;
  if (s.exceptions.some((e) => e.date === t.date)) return false;
  const prevDate = new Date(new Date(t.date + 'T12:00:00Z').getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  return intervals(s, prevDate, (t.day + 6) % 7).some(
    (x) => minute(x.end) < minute(x.start) && t.minute < minute(x.end),
  );
}
function intervalOpen(s: Schedule | null, start: Date, seconds: number): boolean {
  if (!s) return true;
  if (!scheduleOpen(s, start)) return false;
  const end = start.getTime() + seconds * 1000;
  for (let ms = Math.floor(start.getTime() / 60000) * 60000 + 60000; ms <= end; ms += 60000)
    if (!scheduleOpen(s, new Date(ms))) return false;
  return scheduleOpen(s, new Date(end));
}
function closureApplies(
  closures: Closure[],
  type: Closure['targetType'],
  id: string,
  start: number,
  end: number,
): boolean {
  return closures.some(
    (c) =>
      c.status === 'active' &&
      c.targetType === type &&
      c.targetID === id &&
      Date.parse(c.startsAt) <= end &&
      (!c.endsAt || Date.parse(c.endsAt) > start),
  );
}
export function planRoute(g: Graph, closures: Closure[], o: RouteOptions) {
  const binding = g.placeDestinationBindings.find((b) => b.placeID === o.placeID);
  if (!binding)
    return { route: null, reason: 'No published destination is bound to this business.' };
  const nodes = new Map(g.nodes.map((n) => [n.id, n])),
    proof = new Map(g.verificationRecords.map((p) => [p.id, p]));
  const valid = (id: string | null, at: number) => {
    const p = id ? proof.get(id) : null;
    return (
      !!p &&
      Date.parse(p.confirmedAt) <= o.now.getTime() &&
      Date.parse(p.validUntil) > Math.max(at, o.now.getTime())
    );
  };
  const candidates = g.entrances
    .filter(
      (e) =>
        binding.entranceIDs.includes(e.id) &&
        e.permittedModes.includes(o.mode) &&
        (!o.entranceID || e.id === o.entranceID),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  let best: {
    cost: number;
    entrance: Graph['entrances'][number];
    path: string[];
    edges: GraphEdge[];
    seconds: number;
    timeKnown: boolean;
  } | null = null;
  for (const entrance of candidates) {
    const start = nodes.get(entrance.approachNodeID)!;
    const p = start.outdoorPoint;
    const departure = o.departureAt.getTime();
    if (
      !p ||
      Date.parse(p.verifiedAt) > o.now.getTime() ||
      Date.parse(p.validUntil) <= Math.max(departure, o.now.getTime()) ||
      closureApplies(closures, 'entrance', entrance.id, departure, departure)
    )
      continue;
    type State = {
      node: string;
      path: string[];
      edges: GraphEdge[];
      cost: number;
      seconds: number;
      timeKnown: boolean;
      passedEntrance: boolean;
    };
    const pending: State[] = [
      {
        node: start.id,
        path: [start.id],
        edges: [],
        cost: 0,
        seconds: 0,
        timeKnown: true,
        passedEntrance: false,
      },
    ];
    // Arrival-time labels are required: an earlier path may be time-ineligible where a later path is open.
    const seen = new Map<string, number>();
    let expanded = 0;
    while (pending.length && expanded++ < 10000) {
      pending.sort((a, b) => a.cost - b.cost || a.path.join('/').localeCompare(b.path.join('/')));
      const s = pending.shift()!;
      const at = departure + s.seconds * 1000,
        key = `${s.node}:${s.passedEntrance}:${s.timeKnown}:${at}:${s.edges.at(-1)?.id ?? ''}:${[...s.path].sort().join(',')}`;
      if ((seen.get(key) ?? Infinity) <= s.cost) continue;
      seen.set(key, s.cost);
      const n = nodes.get(s.node)!;
      if (
        n.accessPolicy.state !== 'open' ||
        !valid(n.evidenceID, at) ||
        !valid(n.accessPolicy.evidenceID, at) ||
        closureApplies(closures, 'node', n.id, at, at) ||
        (!s.timeKnown && n.accessPolicy.schedule) ||
        !scheduleOpen(n.accessPolicy.schedule, new Date(at))
      )
        continue;
      if (s.node === binding.destinationNodeID && s.passedEntrance) {
        if (!best || s.cost < best.cost) best = { ...s, entrance };
        break;
      }
      for (const e of g.directedEdges
        .filter((e) => e.fromNodeID === s.node)
        .sort((a, b) => a.id.localeCompare(b.id))) {
        if (s.path.includes(e.toNodeID) || e.accessState !== 'open' || e.restrictionRefs.length)
          continue;
        const incoming = s.edges.at(-1);
        const turn = incoming
          ? g.turnInstructions.find(
              (t) => t.incomingEdgeID === incoming.id && t.outgoingEdgeID === e.id,
            )
          : null;
        if (turn && !valid(turn.verificationRef, at)) continue;
        // Driving selects a vehicle-compatible approach; the entrance-to-door journey remains pedestrian.
        const segmentMode = 'walking';
        if (!e.permittedModes.includes(segmentMode)) continue;
        if (
          o.stepFree &&
          (e.traversalType === 'stairs' ||
            e.accessibilityEvidence.stepFree !== 'confirmed' ||
            !valid(e.accessibilityEvidence.evidenceID, at))
        )
          continue;
        const seconds =
            e.baseDurationSeconds ?? (e.lengthMetres !== null ? e.lengthMetres / 1.2 : 60),
          end = at + seconds * 1000;
        if (
          (o.stepFree && !valid(e.accessibilityEvidence.evidenceID, end)) ||
          !valid(e.verificationRef, end) ||
          closureApplies(closures, 'edge', e.id, at, end) ||
          (e.liftID && closureApplies(closures, 'lift', e.liftID, at, end)) ||
          (!s.timeKnown && e.openingSchedule) ||
          !intervalOpen(e.openingSchedule, new Date(at), seconds)
        )
          continue;
        if (
          e.toNodeID === entrance.nodeID &&
          closureApplies(closures, 'entrance', entrance.id, at, end)
        )
          continue;
        // Unknown durations cannot predict passage through a time-limited gate. No waiting is invented.
        if (e.openingSchedule && e.baseDurationSeconds === null) continue;
        pending.push({
          node: e.toNodeID,
          path: [...s.path, e.toNodeID],
          edges: [...s.edges, e],
          cost: s.cost + seconds + (e.traversalType === 'stairs' ? 20 : 0),
          seconds: s.seconds + seconds,
          timeKnown: s.timeKnown && e.baseDurationSeconds !== null,
          passedEntrance: s.passedEntrance || e.toNodeID === entrance.nodeID,
        });
      }
    }
  }
  if (!best)
    return {
      route: null,
      reason: o.stepFree
        ? 'No verified step-free route is currently available.'
        : 'No verified route is currently available for this entrance, mode and time.',
    };
  const b = best as NonNullable<typeof best>,
    entranceNode = nodes.get(b.entrance.nodeID)!,
    approach = nodes.get(b.entrance.approachNodeID)!,
    destination = nodes.get(binding.destinationNodeID)!;
  const checkpoints = b.path.map((nodeID, i) => {
    const n = nodes.get(nodeID)!,
      edge = i ? b.edges[i - 1] : null,
      outgoing = b.edges[i];
    const turn =
      edge && outgoing
        ? g.turnInstructions.find(
            (t) => t.incomingEdgeID === edge.id && t.outgoingEdgeID === outgoing.id,
          )
        : null;
    return {
      nodeID,
      floorID: n.floorID,
      floorLabel: g.floors.find((f) => f.id === n.floorID)!.label,
      label: label(n.labelByLocale, o.locale),
      instruction: turn
        ? label(turn.instructionByLocale, o.locale)
        : edge
          ? label(edge.instructionByLocale, o.locale)
          : 'Confirm this approach point before starting.',
      photoIDs: turn?.photoIDs.length
        ? turn.photoIDs
        : edge?.directionalPhotoIDs.length
          ? edge.directionalPhotoIDs
          : n.permittedPhotoIDs,
      requiresConfirmation: true as const,
      traversalType: edge?.traversalType ?? 'approach',
    };
  });
  const lengths = b.edges.map((e) => e.lengthMetres),
    durations = b.edges.map((e) => e.baseDurationSeconds);
  return {
    reason: null,
    selectedEntrance: {
      id: b.entrance.id,
      nodeID: entranceNode.id,
      label: label(b.entrance.labelByLocale, o.locale),
      approach: { nodeID: approach.id, ...approach.outdoorPoint! },
    },
    destination: {
      nodeID: destination.id,
      floorID: destination.floorID,
      label: label(destination.labelByLocale, o.locale),
    },
    route: {
      nodeIDs: b.path,
      edgeIDs: b.edges.map((e) => e.id),
      checkpoints,
      lengthMetres: lengths.every((x) => x !== null)
        ? lengths.reduce<number>((a, b) => a + b!, 0)
        : null,
      durationSeconds: durations.every((x) => x !== null)
        ? durations.reduce<number>((a, b) => a + b!, 0)
        : null,
      costKind:
        b.edges.every((e) => e.costSource === 'measured') && b.timeKnown
          ? 'measured'
          : ('estimated' as string),
    },
  };
}
/** Availability expires before any scheduled transition encountered in the next five minutes. */
export function availabilityExpiry(g: Graph, closures: Closure[], now: Date): Date {
  let end = now.getTime() + 300000;
  for (const p of g.verificationRecords)
    if (Date.parse(p.validUntil) > now.getTime()) end = Math.min(end, Date.parse(p.validUntil));
  for (const n of g.nodes)
    if (n.outdoorPoint && Date.parse(n.outdoorPoint.validUntil) > now.getTime())
      end = Math.min(end, Date.parse(n.outdoorPoint.validUntil));
  for (const c of closures)
    if (c.status === 'active')
      for (const t of [c.startsAt, c.endsAt])
        if (t && Date.parse(t) > now.getTime()) end = Math.min(end, Date.parse(t));
  const schedules = [
    ...g.nodes.map((n) => n.accessPolicy.schedule),
    ...g.directedEdges.map((e) => e.openingSchedule),
  ].filter((s): s is Schedule => !!s);
  for (const s of schedules) {
    const initial = scheduleOpen(s, now);
    for (let ms = Math.floor(now.getTime() / 60000) * 60000 + 60000; ms < end; ms += 60000)
      if (scheduleOpen(s, new Date(ms)) !== initial) {
        end = ms;
        break;
      }
  }
  return new Date(Math.max(now.getTime(), end));
}
