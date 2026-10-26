import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutdoorCoordinate, outdoorPins, mapboxConfiguration } from '../src/maps/outdoor-points.ts';

test('empty, non-finite and non-projectable coordinates never produce a map pin', () => {
  for (const pair of [['', '78'], ['17', ' '], ['NaN', '78'], ['Infinity', '78'], ['86', '78'], ['17', '181']]) {
    assert.equal(parseOutdoorCoordinate(pair[0], pair[1]), null);
  }
  assert.deepEqual(parseOutdoorCoordinate('17.432', '78.405'), { latitude: 17.432, longitude: 78.405 });
  assert.deepEqual(parseOutdoorCoordinate('0', '0'), { latitude: 0, longitude: 0 });
});

test('only actual outdoor coordinates become pins, never local floor positions', () => {
  const nodes = [
    { id: 'approach', labelByLocale: { en: 'Street approach' }, outdoorPoint: { latitude: 17.432, longitude: 78.405 } },
    { id: 'indoor', labelByLocale: { en: 'Lift' }, outdoorPoint: null, localPosition: { x: 25, y: 50 } },
    { id: 'broken', labelByLocale: { en: 'Bad data' }, outdoorPoint: { latitude: NaN, longitude: 78 } },
  ];
  assert.deepEqual(outdoorPins(nodes), [{ id: 'approach', label: 'Street approach', latitude: 17.432, longitude: 78.405 }]);
});

test('configuration permits only an enabled public token and the fixed Mapbox style', () => {
  assert.equal(mapboxConfiguration({ enabled: true, publicToken: 'sk.' + 'a'.repeat(40) }), null);
  assert.equal(mapboxConfiguration({ enabled: false, publicToken: 'pk.' + 'a'.repeat(40) }), null);
  assert.equal(mapboxConfiguration(null), null);
  const publicToken = 'pk.' + 'a'.repeat(40);
  assert.deepEqual(mapboxConfiguration({ enabled: true, publicToken, styleURL: 'https://example.invalid/evil' }), {
    publicToken, styleURL: 'mapbox://styles/mapbox/dark-v11',
  });
});
