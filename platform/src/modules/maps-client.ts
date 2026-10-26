/** Only a public Mapbox token may be distributed to native clients. */
export function mapsClientConfig(value: string) {
  const publicToken = /^pk\.[A-Za-z0-9._-]{20,2048}$/.test(value) ? value : '';
  return {
    enabled: publicToken.length > 0,
    publicToken,
    styleURL: 'mapbox://styles/mapbox/dark-v11',
  };
}
