import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapsClientConfig } from '../src/modules/maps-client.js';

test('maps client receives only a public token and fixed Mapbox style', () => {
  const publicToken = 'pk.' + 'test-only-public-token-'.repeat(3);
  assert.deepEqual(mapsClientConfig(publicToken), {
    enabled: true,
    publicToken,
    styleURL: 'mapbox://styles/mapbox/dark-v11',
  });
  for (const value of [
    '',
    'sk.' + 'private-test-token-'.repeat(3),
    'pk.short',
    publicToken + '\n',
    'https://example.test/token',
    'Bearer ' + publicToken,
  ]) {
    const result = mapsClientConfig(value);
    assert.equal(result.enabled, false);
    assert.equal(result.publicToken, '');
    assert.equal(result.styleURL, 'mapbox://styles/mapbox/dark-v11');
  }
});
