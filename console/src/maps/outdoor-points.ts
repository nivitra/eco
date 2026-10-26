export type OutdoorCoordinate = { latitude: number; longitude: number };
export type OutdoorPin = OutdoorCoordinate & { id: string; label: string };

/** Invalid/empty input must never silently become the coordinate (0, 0). */
export function parseOutdoorCoordinate(latitude: string, longitude: string): OutdoorCoordinate | null {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85.051129 && Math.abs(lon) <= 180
    ? { latitude: lat, longitude: lon } : null;
}

export function outdoorPins(nodes: Array<{ id: string; labelByLocale: Record<string, string>; outdoorPoint?: OutdoorCoordinate | null }>): OutdoorPin[] {
  return nodes.flatMap(node => {
    const point = node.outdoorPoint && parseOutdoorCoordinate(String(node.outdoorPoint.latitude), String(node.outdoorPoint.longitude));
    return point ? [{ id: node.id, label: node.labelByLocale.en ?? node.id, ...point }] : [];
  });
}

export function mapboxConfiguration(value: unknown): { publicToken: string; styleURL: string } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.enabled !== true || typeof data.publicToken !== 'string' || !/^pk\.[A-Za-z0-9._-]{20,2048}$/.test(data.publicToken)) return null;
  // Keep provider URLs fixed; never load arbitrary scripts/styles supplied through configuration.
  return { publicToken: data.publicToken, styleURL: 'mapbox://styles/mapbox/dark-v11' };
}
