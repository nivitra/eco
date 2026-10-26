import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { claimProofRetentionDays, validateReplayEntry } from '../src/modules/retention.js';
test('retention durations fail closed and storage replay is restricted to the exact private object', () => {
  assert.equal(claimProofRetentionDays(''), 180);
  assert.equal(claimProofRetentionDays('365'), 365);
  for (const value of ['0', '29', '3651', 'NaN', '90.5'])
    assert.throws(() => claimProofRetentionDays(value));
  const id = randomUUID(),
    e = {
      id: randomUUID(),
      tenantID: randomUUID(),
      placeID: 'fixture',
      entityType: 'media_asset',
      entityID: id,
      deletedAt: new Date().toISOString(),
      reason: 'private_upload_recovery',
      objectKeys: [`private/${id}/original`],
    };
  assert.deepEqual(validateReplayEntry(e), e);
  for (const key of [
    `private/${randomUUID()}/original`,
    `private/${id}/../x`,
    `/private/${id}/original`,
    `private/${id}/original?x`,
  ])
    assert.throws(() => validateReplayEntry({ ...e, objectKeys: [key] }));
  assert.throws(() => validateReplayEntry({ ...e, entityType: 'claim_proof' }));
});
