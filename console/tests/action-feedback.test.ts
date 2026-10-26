import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSuccess } from '../src/action-feedback';

test('queued website operations never claim completed delivery or verification', () => {
  for (const name of ['Publish website', 'Queue domain migration', 'Check public access']) {
    const message = actionSuccess(name);
    assert.match(message, /queued/i);
    assert.doesNotMatch(message, /\b(?:completed|verified|published|live)\b/i);
  }
  assert.equal(actionSuccess('Save business draft'), 'Save business draft completed');
});
