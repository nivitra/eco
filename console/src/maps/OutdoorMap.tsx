import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxConfiguration, type OutdoorCoordinate, type OutdoorPin } from './outdoor-points';

type Props = {
  points: OutdoorPin[];
  selectedID: string;
  candidate: OutdoorCoordinate | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onCandidate: (point: OutdoorCoordinate) => void;
};

/** Outdoor context only. Local floor-plan coordinates and observed evidence remain separate. */
export default function OutdoorMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const latest = useRef(props);
  latest.current = props;
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let instance: mapboxgl.Map | null = null;
    let resize: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setError(null);
    async function start() {
      try {
        const response = await fetch('/v1/maps/client-config', { credentials: 'omit', signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Map configuration is unavailable. Your coordinate fields still work.');
        const config = mapboxConfiguration(await response.json());
        if (!config) throw new Error('Mapbox is not configured. You can still enter an observed coordinate below.');
        if (abort.signal.aborted || !host.current) return;
        if (!mapboxgl.supported()) throw new Error('This browser cannot display the map. Use the coordinate fields below.');
        const initial = latest.current.candidate ?? latest.current.points[0];
        instance = new mapboxgl.Map({
          container: host.current, accessToken: config.publicToken, style: config.styleURL,
          center: initial ? [initial.longitude, initial.latitude] : [78.405, 17.432],
          zoom: initial ? 17 : 11, pitch: 0, bearing: 0, maxPitch: 0,
          dragRotate: false, touchPitch: false, attributionControl: true,
          cooperativeGestures: true, projection: 'mercator',
        });
        map.current = instance;
        instance.touchZoomRotate.disableRotation();
        instance.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
        instance.on('style.load', () => {
          if (!instance || abort.signal.aborted) return;
          // Preserve provider labels and attribution, while keeping all geometry flat and forest-toned.
          for (const layer of instance.getStyle().layers ?? []) {
            const id = layer.id;
            if (layer.type === 'fill-extrusion') instance.setLayoutProperty(id, 'visibility', 'none');
            else if (layer.type === 'background') instance.setPaintProperty(id, 'background-color', '#10241c');
            else if (layer.type === 'fill') instance.setPaintProperty(id, 'fill-color', /water/.test(id) ? '#081511' : /park|landuse|wood|scrub/.test(id) ? '#214936' : '#18362a');
            else if (layer.type === 'line' && /road|street|bridge|tunnel/.test(id)) instance.setPaintProperty(id, 'line-color', /case/.test(id) ? '#10241c' : '#456453');
            else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
              instance.setPaintProperty(id, 'text-color', '#c9d7c9');
              instance.setPaintProperty(id, 'text-halo-color', '#10241c');
            }
          }
          setError(null);
          setReady(true);
          if (timer) clearTimeout(timer);
        });
        instance.on('error', () => {
          if (!abort.signal.aborted) setError('Some Mapbox content could not load. Retry the map or use the coordinate fields.');
        });
        instance.on('click', (event) => {
          if (latest.current.editable) latest.current.onCandidate({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
        });
        resize = new ResizeObserver(() => instance?.resize());
        resize.observe(host.current);
        timer = setTimeout(() => {
          if (!abort.signal.aborted) setError('Map loading timed out. Your draft and coordinate fields are still available.');
        }, 20000);
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'The map could not load.');
      }
    }
    void start();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      resize?.disconnect();
      markers.current.forEach(marker => marker.remove());
      markers.current = [];
      instance?.remove();
      map.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    markers.current.forEach(marker => marker.remove());
    const pins = props.points.filter(point => !(props.candidate && point.id === props.selectedID));
    if (props.candidate) pins.push({ ...props.candidate, id: props.selectedID, label: 'Selected approach coordinate' });
    markers.current = pins.map(point => {
      const selected = point.id === props.selectedID;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'map-outdoor-pin' + (selected ? ' is-selected' : '');
      element.setAttribute('aria-label', `${point.label}${selected && props.editable ? '. Drag to choose a candidate coordinate' : ''}`);
      element.dataset.pointId = point.id;
      element.textContent = selected ? '●' : '•';
      element.addEventListener('click', event => { event.stopPropagation(); latest.current.onSelect(point.id); });
      const marker = new mapboxgl.Marker({ element, draggable: selected && props.editable }).setLngLat([point.longitude, point.latitude]).addTo(instance);
      marker.on('dragend', () => {
        const position = marker.getLngLat();
        if (latest.current.editable) latest.current.onCandidate({ latitude: position.lat, longitude: position.lng });
      });
      return marker;
    });
  }, [props.points, props.candidate, props.selectedID, props.editable, ready]);

  function focusSelected() {
    const point = props.candidate ?? props.points.find(p => p.id === props.selectedID) ?? props.points[0];
    if (point) map.current?.jumpTo({ center: [point.longitude, point.latitude], zoom: 17, pitch: 0, bearing: 0 });
  }
  return <section className="map-outdoor" aria-label="Outdoor approach map">
    <div className="map-outdoor-heading"><div><h3>Outdoor approach</h3><small>Mapbox · 2D street context</small></div><button type="button" disabled={!ready || (!props.candidate && !props.points.length)} onClick={focusSelected}>Show selected point</button></div>
    <div className="map-outdoor-canvas" ref={host} aria-label="Interactive Mapbox street map" />
    {error ? <div role="status" className="map-outdoor-status"><span>{error}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry map</button></div> : !ready ? <p role="status">Loading Mapbox…</p> : null}
    <p className="map-outdoor-note">{props.editable ? 'Click the map or drag the orange pin to choose a candidate. Confirm its accuracy on site before recording an observation.' : 'Select an approach checkpoint to edit its outdoor coordinate. Indoor checkpoints stay in the floor diagram.'}</p>
  </section>;
}
