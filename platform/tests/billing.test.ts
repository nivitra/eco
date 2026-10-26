import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyWebhook,
  capturedEntitlement,
  remainingRefundDecision,
} from '../src/modules/billing.js';
test('Razorpay verifies exact raw bytes and rejects missing secret or truncated signatures', () => {
  const raw = '{"event":"subscription.charged"}',
    secret = 'test-secret',
    signature = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyWebhook(raw, signature, secret), true);
  assert.equal(verifyWebhook(raw + ' ', signature, secret), false);
  assert.equal(verifyWebhook(raw, signature.slice(2), secret), false);
  assert.equal(verifyWebhook(raw, signature, ''), false);
});
test('mandate activation, unrelated invoices and underpaid payments never create entitlement', () => {
  const expected = {
    providerID: 'sub_1',
    localID: 'local',
    tenantID: 'tenant',
    placeID: 'place',
    planID: 'plan_1',
  };
  const sub = {
    id: 'sub_1',
    plan_id: 'plan_1',
    notes: { kulture_subscription_id: 'local', tenant_id: 'tenant', place_id: 'place' },
    current_end: 2000000000,
  };
  const payment = {
    id: 'pay_1',
    status: 'captured',
    amount: 29900,
    currency: 'INR',
    invoice_id: 'inv_1',
  };
  const invoice = {
    id: 'inv_1',
    subscription_id: 'sub_1',
    payment_id: 'pay_1',
    status: 'paid',
    amount_paid: 29900,
    billing_start: 1997408000,
    billing_end: 2000000000,
  };
  assert.equal(capturedEntitlement(sub, payment, invoice, expected)?.getTime(), 2000000000000);
  // A freshly fetched subscription may have moved to a later cycle: the original invoice wins.
  assert.equal(
    capturedEntitlement({ ...sub, current_end: 2200000000 }, payment, invoice, expected)?.getTime(),
    2000000000000,
  );
  assert.equal(
    capturedEntitlement(sub, payment, { ...invoice, billing_end: null }, expected),
    null,
  );
  assert.equal(
    capturedEntitlement(sub, payment, { ...invoice, billing_end: 2200000000 }, expected),
    null,
  );
  for (const patch of [
    { status: 'authorized' },
    { amount: 100 },
    { currency: 'USD' },
    { invoice_id: 'other' },
    { refunded: true },
    { amount_refunded: 29900 },
    { refund_status: 'full' },
    { amount_refunded: -1 },
  ])
    assert.equal(capturedEntitlement(sub, { ...payment, ...patch }, invoice, expected), null);
  assert.equal(
    capturedEntitlement(
      sub,
      { ...payment, amount_refunded: 100, refund_status: 'partial' },
      invoice,
      expected,
    )?.getTime(),
    2000000000000,
    'A partial service credit retains the captured billing interval',
  );
  assert.equal(
    capturedEntitlement(sub, payment, { ...invoice, subscription_id: 'sub_other' }, expected),
    null,
  );
  assert.equal(
    capturedEntitlement(
      { ...sub, notes: { ...sub.notes, tenant_id: 'other' } },
      payment,
      invoice,
      expected,
    ),
    null,
  );
});

test('full refund after partial credits uses remaining balance and rejects pending or inconsistent evidence', () => {
  const payment = {
    id: 'pay_1',
    status: 'captured',
    amount: 29900,
    currency: 'INR',
    amount_refunded: 100,
  };
  const credit = {
    id: 'rfnd_1',
    payment_id: 'pay_1',
    amount: 100,
    currency: 'INR',
    status: 'processed',
    receipt: 'earlier-credit',
  };
  assert.deepEqual(remainingRefundDecision(payment, [credit], 'new-command'), {
    remaining: 29800,
    existing: null,
  });
  assert.throws(
    () => remainingRefundDecision(payment, [{ ...credit, status: 'pending' }], 'new-command'),
    /prior_refund_pending/,
  );
  assert.throws(
    () => remainingRefundDecision(payment, [{ ...credit, amount: 99 }], 'new-command'),
    /refund_total_mismatch/,
  );
  assert.throws(
    () => remainingRefundDecision(payment, [{ ...credit, payment_id: 'pay_other' }], 'new-command'),
    /refund_collection_invalid/,
  );
  assert.throws(
    () => remainingRefundDecision(payment, [credit, credit], 'new-command'),
    /refund_collection_invalid/,
  );
  const priorCommand = {
    ...credit,
    id: 'rfnd_2',
    receipt: 'new-command',
    amount: 29800,
    status: 'pending',
  };
  assert.equal(
    remainingRefundDecision(payment, [credit, priorCommand], 'new-command').existing.id,
    'rfnd_2',
    'The same command never creates a second refund',
  );
  const complete = { ...priorCommand, status: 'processed' };
  assert.equal(
    remainingRefundDecision(
      { ...payment, status: 'refunded', amount_refunded: 29900 },
      [credit, complete],
      'later-command',
    ).remaining,
    0,
  );
});
