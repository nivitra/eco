# Billing evidence and operational runbook

This module is implemented against Razorpay's documented contracts and exercised with a real local PostgreSQL database and a mocked provider. No live merchant charge, refund, UPI mandate or settlement has been tested. Production billing must remain disabled until merchant activation and the acceptance checks below are complete.

## Evidence and entitlement

- One physical location costs ₹299 total per month. Provider plan period, interval, amount and currency must match before creating checkout.
- Mandate authorization or `subscription.status=active` alone grants nothing. A captured ₹299 INR payment must match the configured plan, local checkout notes, subscription, paid invoice, payment ID and invoice billing interval.
- The invoice billing interval is immutable. Future periods do not activate early. Full refunds remain terminal on that payment's ledger row; stale capture evidence cannot restore them. Partial service credits preserve coverage whether first seen before or after the capture event. An unrelated paid interval is preserved.
- Every known dispute is fetched again during subscription reconciliation, even without a webhook. An initial dispute can be recorded atomically with its newly discovered captured payment. All disputes on a payment must be `won` before its dispute hold clears. `closed` remains conservative/manual review because the provider definition covers both supplied transaction details and refunds; it is not proof of an undisputed payment.
- A PostgreSQL session advisory lock covers provider reads and the short ledger transaction. A concurrent attempt gets `billing_reconciliation_busy` without starting provider I/O, then retries through the inbox/maintenance. No transaction stays open during network I/O. Requests have a 12-second timeout and each reconciliation a 60-second provider budget. The lock is released in `finally`; a failed unlock destroys the connection.
- The periodic job checks due subscriptions, normally every six hours. A failure retains previous evidence and exposes a reconciliation error; it does not manufacture a successful payment. Raw webhook signatures and event-content hashes are verified before queuing; duplicate IDs cannot change their payload.

Sources: [Razorpay payment entity](https://razorpay.com/docs/api/payments/entity/), [invoice entity](https://razorpay.com/docs/api/payments/invoices/entity/), [dispute entity](https://razorpay.com/docs/api/disputes/entity/).

## Refund commands

A full refund after earlier partial credits uses the verified remaining balance. The worker reconciles the captured payment and up to 200 refund records, checks payment/currency/amount associations and processed-refund totals, and refuses a new mutation while another refund is pending or evidence disagrees. It persists the exact refund request before sending it and uses the command UUID as `X-Refund-Idempotency`. A timeout stays uncertain for operator review; it is not blindly repeated with a recalculated amount.

A provider response of `pending` is stored with its refund ID and shown as `refund_pending`, not completed. The maintenance loop polls accepted pending refunds at 15-minute intervals until `processed` or `failed`. Failed lookups keep the reference and retry. A failed refund is surfaced as failed; a processed full refund is reflected in payment coverage on the next reconciliation. A refund already fully processed is an evidence-backed no-op.

These rules follow the documented [idempotent normal-refund API](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent) and [refund states](https://razorpay.com/docs/api/refunds/entity/). Provider sandbox mutation testing remains required.

## First website delivery

Migration 018 adds `payment_ledger.captured_at`, populated only from the matched provider invoice's `paid_at`. It also records the originally selected website binding. The first delivery deadline is the earliest verified payment timestamp plus 72 hours, not local webhook receipt or processing time.

The provider invoice payment timestamp must be a valid, nonfuture Unix timestamp. Missing or conflicting evidence produces a reconciliation error and needs investigation; the code does not substitute local time. The migration invalidates older local-time delivery deadlines and historical-success markers for selected websites so reconciliation and current external checks can establish proper evidence.

A successful delivery requires the originally selected destination and binding, matching tenant/location, its currently applied sequence, current `verified_live` state, and an external verification after both payment and selection. An old successful sequence, another destination, a replacement binding or a currently failed public check does not fulfil it. Expired deadlines open a delivery incident, queue renewal pause, and notify the owner. Pause completion is the provider command's actual state, not the fact that it was queued.

## Operations

Use only the private operator service and operator credential. Neither a native client nor a browser receives the operator token or Razorpay secret.

1. Inspect the owner-visible billing error and the provider dashboard. Confirm the physical location, checkout ID, provider subscription ID, captured invoice/payment IDs, refund state and dispute IDs.
2. For an uncertain checkout, use `POST /v1/ops/billing/:localSubscriptionID/reconcile` with `{ "providerID": "sub_..." }`. The handler fetches and validates the actual provider relationship; it never grants access from supplied status/amount fields.
3. If a new dispute's original webhook was missed, add `"disputeID": "disp_..."` to that same request. The server fetches the dispute and accepts it only for an existing or newly verified captured payment belonging to the subscription. Subsequent reconciliations poll it automatically.
4. Inspect dead billing inbox events and `reconciliation_required` provider commands. Verify the provider outcome before resolving a command; do not blindly repeat a payment mutation after a timeout. The private command-resolution endpoint records a provider reference and operator reason.
5. Investigate delivery incidents using the selected website's current external access check, then repair or handle the owner's cancellation/refund request. A queued pause is not proof that future provider renewals stopped.

The provider's [dispute collection API](https://razorpay.com/docs/api/disputes/fetch-all/) is account-wide. This implementation does **not** claim automatic discovery of every entirely missed first dispute webhook. An operator must compare dashboard disputes and use the explicit reconciliation path, or a separately designed account-wide cursor job must be added before operating without that review. It deliberately does not scan the entire merchant account once per subscription.

## Verification performed

On 2026-09-29, `npm run check` passed and the billing command below passed all 12 checks with a real local database and strict mocked-provider reads and one explicitly allowed mocked refund POST:

```sh
RUN_DB_TESTS=true node --import tsx --test --test-concurrency=1 tests/billing-integration.test.ts tests/billing.test.ts
```

Supply the usual private server environment through the deployment's secret loader; do not paste credentials into the command or shell history. The tests cover exact signatures/replay, immutable invoiced periods, partial-credit order invariance, full refund/stale capture, dispute-before-ledger, missing won updates, multiple disputes, unrelated payment rejection, concurrency/lock cleanup, selected-binding/current-sequence/post-payment delivery evidence, remaining-balance refund calculation, provider idempotency header/body persistence, and pending-to-processed refund tracking. They do not test a live provider mutation.

## Activation gates and remaining limits

- Activate the actual Razorpay merchant account, recurring payment methods and final ₹299 monthly INR plan; configure server-only keys, the correct webhook secret and public HTTPS webhook URL.
- Run provider sandbox checkout, authorization-without-capture, capture, renewal, cancellation, partial/full refund and dispute cases, including dropped and reordered webhooks. No production money should be used merely to validate a mock.
- Confirm actual subscription invoices populate `paid_at`, `billing_start` and `billing_end` as documented. Verify the provider's account-specific limits and reconciliation budget for historical subscriptions.
- Exercise pause/resume/refund commands against the sandbox and inspect uncertain outcomes. Remaining-balance refunds are implemented; inconsistent or incomplete prior-refund evidence and uncertain network outcomes require operator reconciliation. Refund completion is provider-backed, not inferred from request acceptance.
- Configure operational monitoring of dead inbox events, uncertain commands, missing provider timestamps, delayed public checks and delivery incidents. The periodic worker must run continuously.
- Staff missed-dispute reconciliation until an account-wide incremental discovery job exists. This is distinct from the implemented automatic polling of disputes already known to Kulture.
- Activate SMTP, public HTTPS, the selected website or WordPress adapter, backups and tested restore. Billing test success alone is not a production launch.
