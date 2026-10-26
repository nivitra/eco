import React, { useEffect, useState, useRef, Suspense, lazy } from 'react';
import { graphSchema, type Graph } from '../../../platform/src/maps/graph.js';
import './maps.css';
import { saveMapRecovery, loadMapRecovery } from './draft-cache';
import { mergeDocument } from './merge';
import { outdoorPins, parseOutdoorCoordinate } from './outdoor-points';
const OutdoorMap = lazy(() => import('./OutdoorMap'));
type Draft = {
  graph: Graph;
  revision: number;
  state: string;
  approvedDigest: string | null;
  reviewNote: string | null;
};
type Asset = { id: string; alt: string; state: string; purpose: string };
type Props = { tenantID: string; placeID: string; readOnly?: boolean; onPublished?: () => void };
async function send(path: string, method = 'GET', body?: unknown, revision?: number) {
  const r = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': body instanceof File ? body.type : 'application/json',
      ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
      ...(revision ? { 'If-Match': '"arrival:' + revision + '"' } : {}),
    },
    ...(body === undefined ? {} : { body: body instanceof File ? body : JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(result.error?.message ?? 'The request failed. Your draft is still here.');
  return result;
}
function newGraph(placeID: string): Graph {
  const edge = (id: string, from: string, to: string): Graph['directedEdges'][number] => ({
    id,
    fromNodeID: from,
    toNodeID: to,
    traversalType: 'corridor',
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
    liftID: null,
    accessState: 'unknown',
  });
  return {
    schemaVersion: 2,
    graphID: crypto.randomUUID(),
    buildingID: crypto.randomUUID(),
    name: 'New arrival guide',
    sample: false,
    floors: [
      {
        id: 'ground',
        label: 'G',
        order: 0,
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
        boundary: [],
      },
    ],
    nodes: ['approach', 'entrance', 'destination'].map((id, i) => ({
      id,
      floorID: 'ground',
      type: id as 'approach' | 'entrance' | 'destination',
      localPosition: { x: 20 + i * 30, y: 50 },
      outdoorPoint: null,
      labelByLocale: { en: id },
      permittedPhotoIDs: [],
      evidenceID: null,
      accessPolicy: { state: 'unknown', evidenceID: null, schedule: null },
      connectorID: null,
    })),
    directedEdges: [
      edge('to-entry', 'approach', 'entrance'),
      edge('to-door', 'entrance', 'destination'),
    ],
    entrances: [
      {
        id: 'main',
        nodeID: 'entrance',
        approachNodeID: 'approach',
        permittedModes: ['walking'],
        labelByLocale: { en: 'Main entrance' },
      },
    ],
    placeDestinationBindings: [
      { placeID, destinationNodeID: 'destination', entranceIDs: ['main'] },
    ],
    turnInstructions: [],
    verificationRecords: [],
  };
}
/** First-party graph document remains complete through every edit; no prototype authentication. */
export function MapEditor({ tenantID, placeID, readOnly = false, onPublished }: Props) {
  const prefix =
    '/v1/tenants/' + encodeURIComponent(tenantID) + '/places/' + encodeURIComponent(placeID);
  const context = useRef(prefix),
    changeVersion = useRef(0),
    baseGraph = useRef<Graph | null>(null);
  context.current = prefix;
  async function api(...args: Parameters<typeof send>) {
    const key = prefix;
    const value = await send(...args);
    if (context.current !== key)
      throw new Error('Location changed; the previous response was discarded.');
    return value;
  }
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [graph, setGraph] = useState<Graph | null>(null),
    [assets, setAssets] = useState<Asset[]>([]),
    [selected, setSelected] = useState(''),
    [floor, setFloor] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [raw, setRaw] = useState(''),
    [advanced, setAdvanced] = useState(false);
  const [lat, setLat] = useState(''),
    [lon, setLon] = useState(''),
    [accuracy, setAccuracy] = useState(''),
    [expiry, setExpiry] = useState(''),
    [observed, setObserved] = useState(false),
    [alt, setAlt] = useState(''),
    [rights, setRights] = useState(false),
    [reason, setReason] = useState('');
  const [recovery, setRecovery] = useState<{ graph: Graph; revision: number | null } | null>(null),
    [saveBlocked, setSaveBlocked] = useState(false),
    [serverConflict, setServerConflict] = useState<Draft | null>(null),
    [conflictChoices, setConflictChoices] = useState<Record<string, 'local' | 'remote'>>({});
  const reconciliation =
    serverConflict && graph
      ? mergeDocument(baseGraph.current, graph, serverConflict.graph, conflictChoices)
      : null;
  const node = graph?.nodes.find((n) => n.id === selected),
    level = graph?.floors.find((f) => f.id === floor);
  function choose(d: Draft) {
    baseGraph.current = d.graph;
    setServerConflict(null);
    setConflictChoices({});
    changeVersion.current++;
    setSaveBlocked(false);
    setDraft(d);
    setGraph(d.graph);
    setRaw(JSON.stringify(d.graph, null, 2));
    setSelected(d.graph.nodes[0]?.id ?? '');
    setFloor(d.graph.floors[0]?.id ?? '');
    setDirty(false);
  }
  async function refresh() {
    const [d, m] = await Promise.all([api(prefix + '/arrival-drafts'), api(prefix + '/media')]);
    setDrafts(d.drafts);
    setAssets(m.assets);
    if (d.drafts[0])
      choose(d.drafts.find((x: Draft) => x.graph.graphID === graph?.graphID) ?? d.drafts[0]);
  }
  useEffect(() => {
    let alive = true;
    changeVersion.current++;
    setDraft(null);
    setGraph(null);
    setDirty(false);
    setBusy(false);
    setSaveBlocked(false);
    setRecovery(null);
    setServerConflict(null);
    setConflictChoices({});
    baseGraph.current = null;
    setMessage('');
    Promise.all([api(prefix + '/arrival-drafts'), api(prefix + '/media')])
      .then(([d, m]) => {
        if (alive) {
          setDrafts(d.drafts);
          setAssets(m.assets);
          if (d.drafts[0]) choose(d.drafts[0]);
          loadMapRecovery<{ graph: Graph; revision: number | null }>(prefix)
            .then((cached) => {
              if (
                alive &&
                cached &&
                (!d.drafts[0] ||
                  JSON.stringify(cached.graph) !==
                    JSON.stringify(
                      d.drafts.find((x: Draft) => x.graph.graphID === cached.graph.graphID)?.graph,
                    ))
              )
                setRecovery({ ...cached, graph: graphSchema.parse(cached.graph) });
            })
            .catch(() => {});
        }
      })
      .catch((e) => {
        if (alive) setMessage(e.message);
      });
    return () => {
      alive = false;
    };
  }, [prefix]);
  useEffect(() => {
    setLat(node?.outdoorPoint?.latitude.toString() ?? '');
    setLon(node?.outdoorPoint?.longitude.toString() ?? '');
    setAccuracy(node?.outdoorPoint?.accuracyMetres.toString() ?? '');
    setObserved(false);
  }, [selected]);
  function edit(fn: (g: Graph) => void) {
    if (readOnly || !graph) return;
    changeVersion.current++;
    setSaveBlocked(false);
    const g = structuredClone(graph);
    fn(g);
    setGraph(g);
    setRaw(JSON.stringify(g, null, 2));
    setDirty(true);
  }
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    const key = prefix;
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      if (context.current === key) {
        setSaveBlocked(true);
        setMessage(e instanceof Error ? e.message : 'Request failed.');
      }
    } finally {
      if (context.current === key) setBusy(false);
    }
  }
  async function save() {
    if (!graph) return;
    if (serverConflict) throw new Error('Resolve every map conflict before saving.');
    graphSchema.parse(graph);
    const changes = changeVersion.current;
    const d = await api(
      prefix + '/arrival-drafts' + (draft ? '/' + encodeURIComponent(graph.graphID) : ''),
      draft ? 'PUT' : 'POST',
      { graph },
      draft?.revision,
    );
    if (changes === changeVersion.current) choose(d);
    else {
      baseGraph.current = d.graph;
      setDraft(d);
    }
    setDrafts((v) => [d, ...v.filter((x) => x.graph.graphID !== d.graph.graphID)]);
    setMessage('Draft saved; published directions are unchanged.');
  }
  useEffect(() => {
    if (!graph || !dirty) return;
    const timer = setTimeout(() => {
      saveMapRecovery(prefix, { graph, revision: draft?.revision ?? null }).catch(() => {
        if (context.current === prefix)
          setMessage(
            'Device recovery unavailable; keep this tab open or copy the complete graph document.',
          );
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [graph, dirty, prefix, draft?.revision]);
  useEffect(() => {
    if (!graph || !dirty || busy || readOnly || saveBlocked) return;
    const timer = setTimeout(() => {
      void work(save);
    }, 1400);
    return () => clearTimeout(timer);
  }, [graph, dirty, busy, readOnly, saveBlocked, prefix]);
  function restore() {
    if (!recovery) return;
    const known = drafts.find((d) => d.graph.graphID === recovery.graph.graphID);
    if (known && known.revision !== recovery.revision) {
      setMessage(
        'Recovered document uses an older server revision. Copy the complete document and reconcile it with the current server map before saving.',
      );
      setSaveBlocked(true);
    } else setSaveBlocked(false);
    setDraft(known ?? null);
    if (known && known.revision !== recovery.revision) {
      baseGraph.current = null;
      setServerConflict(known);
    }
    setGraph(recovery.graph);
    setRaw(JSON.stringify(recovery.graph, null, 2));
    setSelected(recovery.graph.nodes[0]?.id ?? '');
    setFloor(recovery.graph.floors[0]?.id ?? '');
    changeVersion.current++;
    setDirty(true);
    setRecovery(null);
  }
  function observation() {
    if (!node || !observed || !expiry) return;
    const validUntil = new Date(expiry).toISOString(),
      confirmedAt = new Date().toISOString(),
      latitude = Number(lat),
      longitude = Number(lon),
      metres = Number(accuracy);
    if (
      Date.parse(validUntil) <= Date.now() ||
      (node.type === 'approach' &&
        (!lat ||
          !lon ||
          !accuracy ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180 ||
          metres <= 0 ||
          metres > 100))
    ) {
      setMessage('Provide valid observed coordinates, uncertainty and a future evidence expiry.');
      return;
    }
    edit((g) => {
      const n = g.nodes.find((n) => n.id === selected)!,
        id = crypto.randomUUID();
      g.verificationRecords.push({
        id,
        source: 'owner_confirmed',
        confirmedAt,
        validUntil,
        note: 'Mapper explicitly recorded an on-site observation. Independent review remains separate.',
      });
      n.evidenceID = id;
      n.accessPolicy = { ...n.accessPolicy, state: 'open', evidenceID: id };
      if (n.type === 'approach')
        n.outdoorPoint = {
          latitude,
          longitude,
          accuracyMetres: metres,
          source: 'owner_observation',
          verifiedAt: confirmedAt,
          validUntil,
        };
    });
    setObserved(false);
  }
  async function upload(file: File) {
    const r = await api('/v1/media/uploads', 'POST', {
      tenantID,
      placeID,
      purpose: 'checkpoint',
      alt,
      rights: {
        basis: 'owned',
        holder: 'Authorized mapper',
        publicUse: true,
        permissionNote: 'Uploader confirms authority to publish the photograph and depicted area.',
        expiresAt: null,
      },
    });
    await api(r.uploadPath, 'PUT', file);
    setAssets((await api(prefix + '/media')).assets);
    setMessage('Processed privately. Inspect the image before approving public use.');
  }
  if (!graph)
    return (
      <section className="map-editor">
        <h2>Entrance & directions</h2>
        <p>{placeID}</p>
        <p>Photos and checkpoints first. No assumed coordinates or independently verified paths.</p>
        {message && <p role="status">{message}</p>}
        {recovery && (
          <button disabled={readOnly} onClick={restore}>
            Restore encrypted device draft
          </button>
        )}
        <button
          disabled={readOnly || busy}
          onClick={() => {
            const g = newGraph(placeID);
            setGraph(g);
            setRaw(JSON.stringify(g, null, 2));
            setSelected('approach');
            setFloor('ground');
            setDirty(true);
          }}
        >
          Create arrival draft
        </button>
      </section>
    );
  return (
    <section className="map-editor">
      <header>
        <div>
          <h2>Entrance & directions</h2>
          <small>
            {placeID} · {draft ? draft.state + ' / revision ' + draft.revision : 'New draft'}
            {dirty
              ? busy
                ? ' · Saving'
                : saveBlocked
                  ? ' · Save paused — review error'
                  : ' · Waiting to save'
              : ' · Saved'}
          </small>
        </div>
        <div className="map-actions">
          <button disabled={busy || readOnly || !dirty} onClick={() => work(save)}>
            Save draft
          </button>
          <button
            disabled={busy || readOnly || dirty || !draft}
            onClick={() =>
              work(async () => {
                const r = await api(
                  prefix + '/arrival-drafts/' + graph.graphID + '/submit',
                  'POST',
                  {},
                  draft!.revision,
                );
                setDraft({ ...draft!, state: r.state, approvedDigest: r.digest });
                setMessage('Submitted for independent review.');
              })
            }
          >
            Submit for review
          </button>
          <button
            disabled={busy || readOnly || dirty || draft?.state !== 'approved'}
            onClick={() =>
              work(async () => {
                await api(
                  prefix + '/arrival-drafts/' + graph.graphID + '/publish',
                  'POST',
                  { digest: draft!.approvedDigest },
                  draft!.revision,
                );
                await refresh();
                onPublished?.();
                setMessage('Approved guide published.');
              })
            }
          >
            Publish approved guide
          </button>
        </div>
      </header>
      {recovery && (
        <p>
          An unsaved device copy is available.{' '}
          <button disabled={readOnly || busy} onClick={restore}>
            Restore device draft
          </button>
        </p>
      )}
      {message && (
        <p className="map-status" role="status">
          {message}
        </p>
      )}
      {draft?.reviewNote && <p>Review: {draft.reviewNote}</p>}
      <div className="map-actions">
        <select
          aria-label="Select arrival draft"
          disabled={dirty || busy}
          value={draft?.graph.graphID ?? ''}
          onChange={(e) => {
            const d = drafts.find((d) => d.graph.graphID === e.target.value);
            if (d) choose(d);
          }}
        >
          <option value="">New draft</option>
          {drafts.map((d) => (
            <option value={d.graph.graphID} key={d.graph.graphID}>
              {d.graph.name} · {d.state}
            </option>
          ))}
        </select>
        <button disabled={busy || dirty} onClick={() => work(refresh)}>
          Refresh review
        </button>
        {dirty && draft && (
          <button
            disabled={busy}
            onClick={() =>
              work(async () => {
                const r = await api(prefix + '/arrival-drafts'),
                  current = r.drafts.find((x: Draft) => x.graph.graphID === graph.graphID);
                if (!current) throw new Error('Server draft not found. Keep your device copy.');
                setServerConflict(current);
                setConflictChoices({});
                setSaveBlocked(true);
                setMessage('Review local and server changes before merging.');
              })
            }
          >
            Reconcile with server
          </button>
        )}
        <a
          href={'/places/' + encodeURIComponent(placeID) + '/arrival'}
          target="_blank"
          rel="noreferrer"
        >
          Published visitor guide
        </a>
      </div>
      {serverConflict && reconciliation && (
        <aside className="map-conflicts">
          <h3>Resolve changes · server revision {serverConflict.revision}</h3>
          <p>
            Non-conflicting fields are combined. Choose each conflicting value; publication remains
            separate.
          </p>
          {reconciliation.conflicts.map((conflict) => (
            <fieldset key={conflict.path}>
              <legend>
                {conflict.path || 'Whole recovered document — original baseline unavailable'}
              </legend>
              <pre>Device: {JSON.stringify(conflict.local, null, 2)}</pre>
              <pre>Server: {JSON.stringify(conflict.remote, null, 2)}</pre>
              <button
                onClick={() => setConflictChoices((c) => ({ ...c, [conflict.path]: 'local' }))}
              >
                Keep device value
              </button>
              <button
                onClick={() => setConflictChoices((c) => ({ ...c, [conflict.path]: 'remote' }))}
              >
                Keep server value
              </button>
            </fieldset>
          ))}
          <button
            disabled={readOnly || reconciliation.conflicts.length > 0}
            onClick={() => {
              try {
                const merged = graphSchema.parse(reconciliation.value);
                baseGraph.current = serverConflict.graph;
                setDraft(serverConflict);
                setGraph(merged);
                setRaw(JSON.stringify(merged, null, 2));
                setServerConflict(null);
                setConflictChoices({});
                changeVersion.current++;
                setDirty(true);
                setSaveBlocked(false);
                setMessage(
                  'Merged locally. The merged draft will be saved against this server revision.',
                );
              } catch (e) {
                setMessage(
                  e instanceof Error
                    ? e.message
                    : 'Merged graph is invalid. Reconcile the complete graph document.',
                );
              }
            }}
          >
            Accept merged draft
          </button>
          <button
            onClick={() => {
              setServerConflict(null);
              setConflictChoices({});
              setSaveBlocked(true);
            }}
          >
            Cancel reconciliation
          </button>
        </aside>
      )}
      <label>
        Guide name
        <input
          disabled={readOnly}
          value={graph.name}
          onChange={(e) =>
            edit((g) => {
              g.name = e.target.value;
            })
          }
        />
      </label>
      <Suspense fallback={<p role="status">Loading outdoor map…</p>}>
        <OutdoorMap
          key={prefix + '/' + graph.graphID}
          points={outdoorPins(graph.nodes)}
          selectedID={selected}
          candidate={node?.type === 'approach' ? parseOutdoorCoordinate(lat, lon) : null}
          editable={!readOnly && node?.type === 'approach'}
          onSelect={(id) => {
            const point = graph.nodes.find(item => item.id === id);
            if (point) { setSelected(id); setFloor(point.floorID); }
          }}
          onCandidate={(point) => {
            setLat(point.latitude.toFixed(7));
            setLon(point.longitude.toFixed(7));
            setAccuracy('');
            setObserved(false);
          }}
        />
      </Suspense>
      <div className="map-grid">
        <div>
          <select aria-label="Floor" value={floor} onChange={(e) => setFloor(e.target.value)}>
            {graph.floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <svg
            viewBox={'0 0 ' + (level?.frame.width ?? 100) + ' ' + (level?.frame.height ?? 100)}
            role="img"
            aria-label="Floor diagram; not surveyed geometry"
            className="map-floor"
          >
            {level?.planAssetID && (
              <image
                href={'/v1/media/' + level.planAssetID + '/preview'}
                width={level.frame.width}
                height={level.frame.height}
                preserveAspectRatio="xMidYMid meet"
              />
            )}
            {graph.directedEdges.map((e) => {
              const a = graph.nodes.find((n) => n.id === e.fromNodeID),
                b = graph.nodes.find((n) => n.id === e.toNodeID);
              return a?.floorID === floor &&
                b?.floorID === floor &&
                a.localPosition &&
                b.localPosition ? (
                <line
                  key={e.id}
                  x1={a.localPosition.x}
                  y1={a.localPosition.y}
                  x2={b.localPosition.x}
                  y2={b.localPosition.y}
                  stroke="var(--accent)"
                  strokeWidth=".8"
                />
              ) : null;
            })}
            {graph.nodes
              .filter((n) => n.floorID === floor && n.localPosition)
              .map((n) => (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={n.labelByLocale.en ?? n.id}
                  onClick={() => setSelected(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(n.id);
                  }}
                >
                  <circle
                    cx={n.localPosition!.x}
                    cy={n.localPosition!.y}
                    r="3"
                    fill={selected === n.id ? 'var(--accent)' : 'var(--action)'}
                  />
                  <text
                    x={n.localPosition!.x}
                    y={n.localPosition!.y - 5}
                    fontSize="3"
                    textAnchor="middle"
                    fill="currentColor"
                  >
                    {n.labelByLocale.en ?? n.id}
                  </text>
                </g>
              ))}
          </svg>
          <small>
            {level?.frame.units} diagram · calibration {level?.frame.calibrationRevision} · no
            indoor GPS
          </small>
          <div className="map-node-list">
            {graph.nodes.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  setSelected(n.id);
                  setFloor(n.floorID);
                }}
              >
                {n.labelByLocale.en ?? n.id}
                <small>{n.type}</small>
              </button>
            ))}
          </div>
          <button
            disabled={readOnly}
            onClick={() =>
              edit((g) => {
                const id = crypto.randomUUID();
                g.nodes.push({
                  id,
                  floorID: floor,
                  type: 'waypoint',
                  localPosition: { x: 50, y: 50 },
                  outdoorPoint: null,
                  labelByLocale: { en: 'New checkpoint' },
                  permittedPhotoIDs: [],
                  evidenceID: null,
                  accessPolicy: { state: 'unknown', evidenceID: null, schedule: null },
                  connectorID: null,
                });
                setSelected(id);
              })
            }
          >
            Add checkpoint
          </button>
        </div>
        {node && (
          <div className="map-inspector">
            <h3>Checkpoint</h3>
            <label>
              Label
              <input
                disabled={readOnly}
                value={node.labelByLocale.en ?? ''}
                onChange={(e) =>
                  edit((g) => {
                    g.nodes.find((n) => n.id === selected)!.labelByLocale.en = e.target.value;
                  })
                }
              />
            </label>
            <label>
              Type
              <select
                disabled={readOnly}
                value={node.type}
                onChange={(e) =>
                  edit((g) => {
                    g.nodes.find((n) => n.id === selected)!.type = e.target
                      .value as typeof node.type;
                  })
                }
              >
                {['approach', 'entrance', 'waypoint', 'stairs', 'lift', 'ramp', 'destination'].map(
                  (x) => (
                    <option key={x}>{x}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              Floor
              <select
                disabled={readOnly}
                value={node.floorID}
                onChange={(e) =>
                  edit((g) => {
                    g.nodes.find((n) => n.id === selected)!.floorID = e.target.value;
                  })
                }
              >
                {graph.floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Connector ID
              <input
                disabled={readOnly}
                value={node.connectorID ?? ''}
                onChange={(e) =>
                  edit((g) => {
                    g.nodes.find((n) => n.id === selected)!.connectorID = e.target.value || null;
                  })
                }
              />
            </label>
            <div className="map-actions">
              {(['x', 'y'] as const).map((axis) => (
                <label key={axis}>
                  Diagram {axis}
                  <input
                    type="number"
                    disabled={readOnly}
                    value={node.localPosition?.[axis] ?? ''}
                    onChange={(e) =>
                      edit((g) => {
                        const n = g.nodes.find((n) => n.id === selected)!;
                        n.localPosition = {
                          ...(n.localPosition ?? { x: 0, y: 0 }),
                          [axis]: Number(e.target.value),
                        };
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              Photo
              <select
                disabled={readOnly}
                value={node.permittedPhotoIDs[0] ?? ''}
                onChange={(e) =>
                  edit((g) => {
                    g.nodes.find((n) => n.id === selected)!.permittedPhotoIDs = e.target.value
                      ? [e.target.value]
                      : [];
                  })
                }
              >
                <option value="">Choose processed photo</option>
                {assets
                  .filter((a) => a.state === 'ready')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.alt}
                    </option>
                  ))}
              </select>
            </label>
            {node.type === 'approach' && (
              <fieldset>
                <legend>Observed approach</legend>
                <label>
                  Latitude
                  <input
                    value={lat}
                    disabled={readOnly}
                    onChange={(e) => { setLat(e.target.value); setObserved(false); }}
                    placeholder="No assumed coordinate"
                  />
                </label>
                <label>
                  Longitude
                  <input disabled={readOnly} value={lon} onChange={(e) => { setLon(e.target.value); setObserved(false); }} />
                </label>
                <label>
                  Uncertainty, metres
                  <input
                    type="number"
                    value={accuracy}
                    onChange={(e) => setAccuracy(e.target.value)}
                  />
                </label>
              </fieldset>
            )}
            <label>
              Evidence expires
              <input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={observed}
                onChange={(e) => setObserved(e.target.checked)}
              />{' '}
              I observed this checkpoint and its permitted access on site.
            </label>
            <button disabled={readOnly || !observed || !expiry} onClick={observation}>
              Record owner observation
            </button>
            <small>This is not independent verification.</small>
          </div>
        )}
      </div>
      <h3>Directed connections</h3>
      <p>Reverse journeys need their own connections and instructions.</p>
      {graph.directedEdges.map((edge, i) => (
        <fieldset key={edge.id}>
          <legend>Segment {i + 1}</legend>
          <div className="map-actions">
            {(['fromNodeID', 'toNodeID'] as const).map((key) => (
              <label key={key}>
                {key === 'fromNodeID' ? 'From' : 'To'}
                <select
                  disabled={readOnly}
                  value={edge[key]}
                  onChange={(e) =>
                    edit((g) => {
                      g.directedEdges[i][key] = e.target.value;
                    })
                  }
                >
                  {graph.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.labelByLocale.en ?? n.id}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label>
            Instruction
            <textarea
              disabled={readOnly}
              value={edge.instructionByLocale.en ?? ''}
              onChange={(e) =>
                edit((g) => {
                  g.directedEdges[i].instructionByLocale.en = e.target.value;
                })
              }
            />
          </label>
          <label>
            Observation evidence
            <select
              disabled={readOnly}
              value={edge.verificationRef ?? ''}
              onChange={(e) =>
                edit((g) => {
                  g.directedEdges[i].verificationRef = e.target.value || null;
                  g.directedEdges[i].accessState = e.target.value ? 'open' : 'unknown';
                })
              }
            >
              <option value="">Unverified</option>
              {graph.verificationRecords.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.source} · {v.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      ))}
      <button
        disabled={readOnly}
        onClick={() =>
          edit((g) => {
            const e = structuredClone(g.directedEdges[0]);
            e.id = crypto.randomUUID();
            e.verificationRef = null;
            e.accessState = 'unknown';
            g.directedEdges.push(e);
          })
        }
      >
        Add directed connection
      </button>
      <h3>Permitted photos</h3>
      <label>
        Alt text
        <input value={alt} onChange={(e) => setAlt(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I
        have permission to publish this photograph and depicted area.
      </label>
      <input
        aria-label="Upload checkpoint image"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={readOnly || busy || !rights || !alt.trim()}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) work(() => upload(file));
          e.currentTarget.value = '';
        }}
      />
      <div className="map-media">
        {assets
          .filter((a) => a.state === 'ready')
          .map((a) => (
            <article key={a.id}>
              <img src={'/v1/media/' + a.id + '/preview'} alt={a.alt} />
              <p>{a.alt}</p>
              <button
                disabled={busy || readOnly}
                onClick={() =>
                  work(async () => {
                    await api('/v1/media/' + a.id + '/approve-public', 'POST', {
                      reviewed: true,
                      permissionConfirmed: true,
                    });
                    setMessage('Public derivative approved. Original remains private.');
                  })
                }
              >
                I reviewed privacy and rights — approve public image
              </button>
            </article>
          ))}
      </div>
      <h3>Complete graph document</h3>
      <p>
        Floors, schedules, step-free evidence, directional photos and turn instructions round-trip
        without dropping fields.
      </p>
      <button onClick={() => setAdvanced(!advanced)}>
        {advanced ? 'Hide' : 'Edit'} complete graph
      </button>
      {advanced && (
        <>
          <textarea
            className="map-json"
            disabled={readOnly}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <button
            disabled={readOnly}
            onClick={() => {
              try {
                const g = graphSchema.parse(JSON.parse(raw));
                if (
                  g.schemaVersion !== 2 ||
                  g.graphID !== graph.graphID ||
                  g.buildingID !== graph.buildingID ||
                  !Array.isArray(g.nodes) ||
                  !Array.isArray(g.floors) ||
                  !Array.isArray(g.directedEdges)
                )
                  throw new Error('Keep graph identity/version and required arrays.');
                changeVersion.current++;
                setGraph(g);
                setDirty(true);
                setMessage('Applied locally. Save runs complete server validation.');
              } catch (e) {
                setMessage(e instanceof Error ? e.message : 'Invalid JSON.');
              }
            }}
          >
            Apply document to draft
          </button>
        </>
      )}
      {draft?.state === 'published' && (
        <>
          <h3>Close an unsafe checkpoint</h3>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            disabled={busy || readOnly || reason.trim().length < 5 || !node}
            onClick={() =>
              work(async () => {
                await api(prefix + '/arrival-closures', 'POST', {
                  graphID: graph.graphID,
                  targetType: 'node',
                  targetID: selected,
                  startsAt: new Date().toISOString(),
                  endsAt: null,
                  reason,
                });
                setMessage('Checkpoint closed; affected public routes are invalidated.');
              })
            }
          >
            Close selected checkpoint
          </button>
        </>
      )}
    </section>
  );
}
