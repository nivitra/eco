import { test } from 'node:test';
import assert from 'node:assert/strict';
import { couponInputSchema, couponScopeIssue, eligibleOfferings } from '../src/modules/coupon-contract.js';

const offerings = [
  { id: 'tea', name: 'Tea', kind: 'product' as const },
  { id: 'delivery', name: 'Delivery', kind: 'service' as const },
  { id: 'legacy', name: 'Untyped legacy item' },
  { id: 'old', name: 'Unavailable item', kind: 'product' as const, availability: 'unavailable' },
];
const input = {
  code: '  save20 ', title: 'Welcome discount', description: '', terms: '',
  discountKind: 'percent' as const, discountValue: 20, scope: 'all_products' as const,
  offeringIDs: [], startsOn: null, endsOn: null, enabled: false,
};
test('coupon scope only includes the requested available offering type', () => {
  assert.deepEqual(eligibleOfferings('all_products', [], offerings).map((item) => item.id), ['tea']);
  assert.deepEqual(eligibleOfferings('all_services', [], offerings).map((item) => item.id), ['delivery']);
  assert.deepEqual(eligibleOfferings('selected', ['legacy', 'tea'], offerings).map((item) => item.id), ['tea', 'legacy']);
  assert.deepEqual(eligibleOfferings('all_offerings', [], offerings).map((item) => item.id), ['tea', 'delivery', 'legacy']);
});
test('coupon validation rejects invalid discounts, dates and empty selected scope', () => {
  assert.equal(couponInputSchema.parse(input).code, 'SAVE20');
  assert.equal(couponInputSchema.safeParse({ ...input, discountValue: 101 }).success, false);
  assert.equal(couponInputSchema.safeParse({ ...input, startsOn: '2026-11-02', endsOn: '2026-11-01' }).success, false);
  assert.equal(couponInputSchema.safeParse({ ...input, scope: 'selected' }).success, false);
  assert.equal(couponScopeIssue({ ...couponInputSchema.parse(input), scope: 'selected', offeringIDs: ['missing'] }, offerings) !== null, true);
  assert.equal(couponScopeIssue(couponInputSchema.parse(input), offerings), null);
});
