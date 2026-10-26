import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { requireUser, requireOps } from '../auth.js';
import { withActor, requireRole, idempotent, HttpError, query, workerPool, audit } from '../db.js';
import { locationEntitlement } from './entitlements.js';
export const billingConfigured = () =>
  !!(
    config.razorpayKey &&
    config.razorpaySecret &&
    config.razorpayWebhookSecret &&
    config.razorpayPlanID
  );
export const PLAN_TERMS = {
  version: 'location-plan-v1',
  priceMinor: 29900,
  currency: 'INR',
  interval: 'monthly',
  unit: 'physical_location',
  graceDays: 7,
  hostedRetentionDays: 90,
  customDomainMigrationDays: 30,
  essentialCorrectionsAfterExpiry: true,
  exportAfterExpiry: true,
  firstDeliveryHours: 72,
  summary:
    '₹299 total each month per physical location. Cancellation keeps paid access through the paid period. Failed paid renewals receive seven days of grace. Premium publishing then pauses; factual corrections and export remain available. Hosted content is retained for 90 days, then the Kulture address redirects to the basic listing. A custom domain gets a further 30-day migration notice. If your first selected website is not verifiably usable within 72 hours of first payment, we open an incident and pause renewals; you can request cancellation and a first-charge refund for Kulture-caused or undisclosed compatibility failures.',
} as const;
export function verifyWebhook(raw: string, signature: string, secret: string) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
async function provider(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  const r = await fetch('https://api.razorpay.com/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization:
        'Basic ' + Buffer.from(config.razorpayKey + ':' + config.razorpaySecret).toString('base64'),
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
  });
  if (!r.ok)
    throw new HttpError(
      502,
      'payment_provider_error',
      'The payment provider could not complete the request',
    );
  return r.json();
}
const providerID = z.string().regex(/^sub_[A-Za-z0-9]+$/);
const providerStatuses = new Set([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
  'paused',
]);
function bound(sub: any, row: any) {
  return (
    sub.id === row.provider_id &&
    sub.plan_id === config.razorpayPlanID &&
    sub.notes?.kulture_subscription_id === row.id &&
    sub.notes?.tenant_id === row.tenant_id &&
    sub.notes?.place_id === row.place_id &&
    providerStatuses.has(sub.status)
  );
}
function available() {
  if (!billingConfigured())
    throw new HttpError(
      503,
      'billing_not_configured',
      'Razorpay merchant activation and plan configuration are required',
    );
}
async function command(db: PoolClient, id: string, kind: string, payload: unknown = {}) {
  const r = (
    await db.query(
      'INSERT INTO billing_commands(subscription_id,kind,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,state',
      [id, kind, JSON.stringify(payload)],
    )
  ).rows[0];
  return (
    r ??
    (
      await db.query(
        "SELECT id,state FROM billing_commands WHERE subscription_id=$1 AND kind=$2 AND state IN('queued','running','reconciliation_required')",
        [id, kind],
      )
    ).rows[0]
  );
}
export function registerBilling(app: Hono) {
  app.get('/v1/billing/terms', (c) => c.json(PLAN_TERMS));
  app.get('/v1/tenants/:tenantId/billing', async (c) => {
    const u = await requireUser(c),
      tid = z.uuid().parse(c.req.param('tenantId'));
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        const rows = (
          await db.query(
            'SELECT id,place_id AS "placeID",provider_id AS "providerID",status,checkout_url AS "checkoutURL",paid_until AS "paidUntil",cancel_at_period_end AS "cancelAtPeriodEnd",renewals_paused_at AS "renewalsPausedAt",first_delivery_due_at AS "firstDeliveryDueAt",first_delivery_verified_at AS "firstDeliveryVerifiedAt",reconcile_error AS "reconcileError" FROM subscriptions WHERE tenant_id=$1 ORDER BY created_at DESC',
            [tid],
          )
        ).rows;
        const subscriptions = [];
        for (const r of rows) {
          const entitlement = await locationEntitlement(db, {
            tenantID: tid,
            placeID: r.placeID,
            capability: 'publish',
          });
          subscriptions.push({ ...r, entitled: entitlement.allowed, entitlement });
        }
        const commands = (
          await db.query(
            'SELECT c.id,c.subscription_id AS "subscriptionID",c.kind,c.state,c.error_code AS "errorCode",c.created_at AS "createdAt" FROM billing_commands c JOIN subscriptions s ON s.id=c.subscription_id WHERE s.tenant_id=$1 ORDER BY c.created_at DESC LIMIT 100',
            [tid],
          )
        ).rows;
        return {
          configured: billingConfigured(),
          ...PLAN_TERMS,
          policy: PLAN_TERMS,
          publishingMode: 'location_entitlement',
          subscriptions,
          commands,
        };
      }),
    );
  });
  app.post('/v1/tenants/:tenantId/billing/checkout', async (c) => {
    const u = await requireUser(c),
      tid = z.uuid().parse(c.req.param('tenantId'));
    available();
    const body = z
      .object({
        placeID: z.string().min(1).max(160),
        destinationID: z.uuid(),
        termsVersion: z.literal(PLAN_TERMS.version),
        termsAccepted: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    const row = await withActor(u.id, async (db) => {
      await requireRole(db, tid, ['owner']);
      return idempotent(
        db,
        u.id,
        c.req.header('Idempotency-Key') || '',
        `checkout:${tid}`,
        body,
        async () => {
          if (
            !(
              await db.query(
                "SELECT 1 FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 AND state='approved'",
                [tid, body.placeID],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              'ownership_required',
              'Verify this business before subscribing',
            );
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `billing:${tid}:${body.placeID}`,
          ]);
          const active = (
            await db.query(
              "SELECT id FROM subscriptions WHERE tenant_id=$1 AND place_id=$2 AND status NOT IN('cancelled','completed','expired','abandoned')",
              [tid, body.placeID],
            )
          ).rows[0];
          if (active)
            throw new HttpError(
              409,
              'subscription_exists',
              'Inspect the existing checkout or plan before starting another',
            );
          const destination = (
            await db.query(
              "SELECT id,binding_id FROM publication_destinations WHERE id=$1 AND tenant_id=$2 AND place_id=$3 AND state='connected'",
              [body.destinationID, tid, body.placeID],
            )
          ).rows[0];
          if (!destination)
            throw new HttpError(
              422,
              'website_selection_required',
              'Choose a connected website for this location',
            );
          if (
            !(
              await db.query(
                'SELECT 1 FROM destination_previews WHERE destination_id=$1 AND expires_at>now()',
                [body.destinationID],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              'website_preview_required',
              'Review your first website preview before activating payment',
            );
          const r = (
            await db.query(
              'INSERT INTO subscriptions(tenant_id,place_id,plan_terms_version,plan_terms_accepted_at,first_website_destination_id,first_selected_at,first_website_binding_id) VALUES($1,$2,$3,now(),$4,now(),$5) RETURNING id',
              [tid, body.placeID, body.termsVersion, body.destinationID, destination.binding_id],
            )
          ).rows[0];
          await audit(db, u.id, tid, 'billing.terms_accepted', r.id, {
            version: body.termsVersion,
            priceMinor: 29900,
          });
          return r;
        },
      );
    });
    const existing = await withActor(
      u.id,
      async (db) =>
        (
          await db.query('SELECT provider_id,checkout_url,status FROM subscriptions WHERE id=$1', [
            row.id,
          ])
        ).rows[0],
    );
    if (existing.provider_id)
      return c.json({ id: row.id, checkoutURL: existing.checkout_url, status: existing.status });
    const reserved = await withActor(
      u.id,
      async (db) =>
        (
          await db.query(
            "UPDATE subscriptions SET status='contacting' WHERE id=$1 AND status='creating' RETURNING id",
            [row.id],
          )
        ).rowCount,
    );
    if (!reserved)
      throw new HttpError(
        409,
        'checkout_reconciliation_required',
        'The previous provider request needs reconciliation; a duplicate checkout was not created',
      );
    try {
      const plan = await provider('plans/' + encodeURIComponent(config.razorpayPlanID));
      if (
        plan.period !== 'monthly' ||
        plan.interval !== 1 ||
        plan.item?.amount !== 29900 ||
        plan.item?.currency !== 'INR'
      )
        throw new HttpError(
          503,
          'plan_mismatch',
          'Configure the monthly plan with a final total of ₹299 INR',
        );
      const sub = await provider('subscriptions', {
        plan_id: config.razorpayPlanID,
        total_count: 120,
        quantity: 1,
        customer_notify: 1,
        notes: {
          kulture_subscription_id: row.id,
          tenant_id: tid,
          place_id: body.placeID,
          terms_version: PLAN_TERMS.version,
        },
      });
      if (
        !providerID.safeParse(sub.id).success ||
        !sub.short_url ||
        new URL(sub.short_url).protocol !== 'https:' ||
        !providerStatuses.has(sub.status)
      )
        throw new Error('invalid_subscription_response');
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        await db.query(
          'UPDATE subscriptions SET provider_id=$2,checkout_url=$3,status=$4,updated_at=now() WHERE id=$1',
          [row.id, sub.id, sub.short_url, sub.status],
        );
        await audit(db, u.id, tid, 'billing.checkout_created', row.id);
      });
      return c.json({ id: row.id, checkoutURL: sub.short_url, status: sub.status }, 201);
    } catch (e) {
      await withActor(u.id, (db) =>
        db.query(
          "UPDATE subscriptions SET status='reconciliation_required',updated_at=now() WHERE id=$1 AND provider_id IS NULL",
          [row.id],
        ),
      );
      throw e;
    }
  });
  for (const kind of ['cancel', 'resume'] as const)
    app.post(`/v1/tenants/:tenantId/billing/:id/${kind}`, async (c) => {
      const u = await requireUser(c),
        tid = z.uuid().parse(c.req.param('tenantId')),
        id = z.uuid().parse(c.req.param('id'));
      available();
      const body = z
        .object({ approval: z.literal(true) })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await withActor(u.id, async (db) => {
          await requireRole(db, tid, ['owner']);
          return idempotent(
            db,
            u.id,
            c.req.header('Idempotency-Key') || '',
            `billing-${kind}:${id}`,
            body,
            async () => {
              const r = (
                await db.query(
                  'SELECT * FROM subscriptions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
                  [id, tid],
                )
              ).rows[0];
              if (!r?.provider_id)
                throw new HttpError(404, 'subscription_not_found', 'Subscription not found');
              if (
                kind === 'resume' &&
                (!r.renewals_paused_at ||
                  (!r.first_delivery_verified_at &&
                    (
                      await db.query(
                        "SELECT 1 FROM service_requests WHERE tenant_id=$1 AND place_id=$2 AND kind='delivery_incident' AND state<>'resolved'",
                        [tid, r.place_id],
                      )
                    ).rowCount))
              )
                throw new HttpError(
                  409,
                  'delivery_resolution_required',
                  'Resolve first delivery before resuming renewals',
                );
              const cmd = await command(db, id, kind);
              await audit(db, u.id, tid, `billing.${kind}_requested`, id);
              return { command: cmd, paidUntil: r.paid_until };
            },
          );
        }),
        202,
      );
    });
  app.post('/v1/ops/billing/:id/reconcile', async (c) => {
    requireOps(c);
    available();
    const id = z.uuid().parse(c.req.param('id')),
      b = z
        .object({
          providerID,
          disputeID: z
            .string()
            .regex(/^disp_[A-Za-z0-9]+$/)
            .optional(),
        })
        .strict()
        .parse(await c.req.json()),
      row = (await workerPool.query('SELECT * FROM subscriptions WHERE id=$1', [id])).rows[0];
    if (!row) throw new HttpError(404, 'subscription_not_found', 'Subscription not found');
    const sub = await provider('subscriptions/' + b.providerID);
    if (!bound(sub, { ...row, provider_id: b.providerID }))
      throw new HttpError(
        409,
        'provider_binding_mismatch',
        'Provider checkout does not belong to this location',
      );
    await workerPool.query(
      'UPDATE subscriptions SET provider_id=$2,next_reconcile_at=now(),updated_at=now() WHERE id=$1',
      [id, sub.id],
    );
    await reconcileSubscription(
      sub.id,
      b.disputeID ? { payload: { dispute: { entity: { id: b.disputeID } } } } : undefined,
    );
    return c.json({ reconciled: true });
  });
  app.post('/v1/ops/billing/commands/:id/resolve', async (c) => {
    requireOps(c);
    const id = z.uuid().parse(c.req.param('id')),
      b = z
        .object({
          state: z.enum(['succeeded', 'failed']),
          providerReference: z.string().min(3).max(200),
          reason: z.string().min(20).max(2000),
        })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const row = (
        await db.query(
          "SELECT c.*,s.tenant_id FROM billing_commands c JOIN subscriptions s ON s.id=c.subscription_id WHERE c.id=$1 AND c.state='reconciliation_required' FOR UPDATE OF c",
          [id],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, 'command_state', 'Command is not awaiting reconciliation');
      await db.query(
        'UPDATE billing_commands SET state=$2,provider_reference=$3,error_code=NULL,completed_at=now() WHERE id=$1',
        [id, b.state, b.providerReference],
      );
      await db.query('UPDATE subscriptions SET next_reconcile_at=now() WHERE id=$1', [
        row.subscription_id,
      ]);
      await audit(db, 'ops', row.tenant_id, 'billing.command_resolved', id, b);
      await db.query('COMMIT');
      return c.json({ resolved: true });
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/ops/billing/:id/refund', async (c) => {
    requireOps(c);
    available();
    const id = z.uuid().parse(c.req.param('id')),
      b = z
        .object({
          paymentID: z.string().regex(/^pay_[A-Za-z0-9]+$/),
          reason: z.string().trim().min(20).max(2000),
          approval: z.literal(true),
        })
        .strict()
        .parse(await c.req.json());
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      const row = (
        await db.query(
          'SELECT s.tenant_id FROM subscriptions s JOIN payment_ledger l ON l.subscription_id=s.id WHERE s.id=$1 AND l.payment_id=$2 AND l.refunded_at IS NULL FOR UPDATE OF s',
          [id, b.paymentID],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, 'payment_not_found', 'Captured, unrefunded payment not found');
      const cmd = await command(db, id, 'refund', b);
      await audit(db, 'ops', row.tenant_id, 'billing.refund_approved', id, b);
      await db.query('COMMIT');
      return c.json({ command: cmd }, 202);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  });
  app.post('/v1/webhooks/razorpay', async (c) => {
    if (!config.razorpayWebhookSecret)
      throw new HttpError(503, 'billing_not_configured', 'Billing is not activated');
    const raw = await c.req.text();
    if (
      !verifyWebhook(raw, c.req.header('x-razorpay-signature') || '', config.razorpayWebhookSecret)
    )
      throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature');
    const id = z.string().min(1).max(160).parse(c.req.header('x-razorpay-event-id')),
      payload = JSON.parse(raw);
    const { rows } = await query('SELECT enqueue_billing($1,$2,$3) AS status', [
      id,
      payload,
      createHash('sha256').update(raw).digest('hex'),
    ]);
    if (rows[0].status === 'conflict')
      throw new HttpError(409, 'event_conflict', 'Duplicate event ID contains different content');
    return c.json({ accepted: true }, 202);
  });
}
function fullyRefunded(payment: any): boolean {
  return (
    payment.refunded === true ||
    payment.refund_status === 'full' ||
    (Number.isInteger(payment.amount_refunded) && payment.amount_refunded >= payment.amount)
  );
}
// Only captured recurring payments with matching provider invoice/subscription establish paid access.
export function capturedEntitlement(
  sub: any,
  payment: any,
  invoice: any,
  expected: {
    providerID: string;
    localID: string;
    tenantID: string;
    placeID: string;
    planID: string;
  },
) {
  if (
    sub.id !== expected.providerID ||
    sub.plan_id !== expected.planID ||
    sub.notes?.kulture_subscription_id !== expected.localID ||
    sub.notes?.tenant_id !== expected.tenantID ||
    sub.notes?.place_id !== expected.placeID ||
    payment.status !== 'captured' ||
    payment.amount !== 29900 ||
    payment.currency !== 'INR' ||
    fullyRefunded(payment) ||
    !Number.isInteger(payment.amount_refunded ?? 0) ||
    (payment.amount_refunded ?? 0) < 0 ||
    payment.invoice_id !== invoice.id ||
    invoice.subscription_id !== sub.id ||
    invoice.payment_id !== payment.id ||
    invoice.status !== 'paid' ||
    invoice.amount_paid !== 29900 ||
    !Number.isInteger(invoice.billing_start) ||
    !Number.isInteger(invoice.billing_end) ||
    invoice.billing_start <= 0 ||
    invoice.billing_end <= invoice.billing_start ||
    invoice.billing_end - invoice.billing_start > 35 * 86400
  )
    return null;
  return new Date(invoice.billing_end * 1000);
}

/** A session advisory lock serializes evidence reads and commits without an open transaction during I/O.
 * A busy subscription retries through the existing queue; the 60s provider budget and cleanup bound lock use. */
export async function reconcileSubscription(sid: string, event?: any) {
  providerID.parse(sid);
  const db = await workerPool.connect(),
    lockKey = `billing-reconcile:${sid}`;
  let locked = false,
    destroy = false;
  try {
    locked = (
      await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey])
    ).rows[0].locked;
    if (!locked)
      throw new HttpError(
        409,
        'billing_reconciliation_busy',
        'This subscription is already being reconciled',
      );
    const deadline = AbortSignal.timeout(60000),
      readProvider = (path: string) => provider(path, undefined, deadline);
    const sub = await readProvider('subscriptions/' + sid);
    let row = (await db.query('SELECT * FROM subscriptions WHERE provider_id=$1', [sid])).rows[0];
    if (!row && z.uuid().safeParse(sub.notes?.kulture_subscription_id).success) {
      const candidate = (
        await db.query('SELECT * FROM subscriptions WHERE id=$1 AND provider_id IS NULL', [
          sub.notes.kulture_subscription_id,
        ])
      ).rows[0];
      if (candidate && bound(sub, { ...candidate, provider_id: sid })) {
        await db.query(
          'UPDATE subscriptions SET provider_id=$2 WHERE id=$1 AND provider_id IS NULL',
          [candidate.id, sid],
        );
        row = { ...candidate, provider_id: sid };
      }
    }
    if (!row || !bound(sub, row))
      throw new HttpError(
        409,
        'provider_binding_mismatch',
        'Payment event is not bound to an authorized checkout',
      );
    const evidence = new Map<string, { p: any; invoice: any; until: Date; capturedAt: Date }>(),
      payments = new Map<string, any>();
    const readPayment = async (id: string) => {
      if (!payments.has(id)) {
        const p = await readProvider('payments/' + encodeURIComponent(id));
        if (p.id !== id) throw new Error('payment_identity_mismatch');
        payments.set(id, p);
      }
      return payments.get(id);
    };
    const inspect = async (invoice: any, payment?: any) => {
      if (!invoice?.payment_id) return;
      const p = payment ?? (await readPayment(invoice.payment_id)),
        until = capturedEntitlement(sub, p, invoice, {
          providerID: sid,
          localID: row.id,
          tenantID: row.tenant_id,
          placeID: row.place_id,
          planID: config.razorpayPlanID,
        });
      if (until) {
        if (
          !Number.isInteger(invoice.paid_at) ||
          invoice.paid_at <= 0 ||
          invoice.paid_at * 1000 > Date.now() + 300000
        )
          throw new Error('payment_timestamp_missing');
        const prior = evidence.get(p.id);
        if (
          prior &&
          (prior.invoice.id !== invoice.id ||
            prior.invoice.billing_start !== invoice.billing_start ||
            prior.invoice.billing_end !== invoice.billing_end ||
            prior.invoice.paid_at !== invoice.paid_at)
        )
          throw new Error('conflicting_invoice_collection');
        evidence.set(p.id, { p, invoice, until, capturedAt: new Date(invoice.paid_at * 1000) });
      } else if (invoice.status === 'paid' && p.status === 'captured' && !fullyRefunded(p))
        throw new Error('payment_evidence_mismatch');
    };
    const eventPID = event?.payload?.payment?.entity?.id;
    if (eventPID) {
      const p = await readPayment(eventPID);
      if (p.invoice_id)
        await inspect(await readProvider('invoices/' + encodeURIComponent(p.invoice_id)), p);
    }
    // Bound pagination covers the configured 120-cycle plan; duplicated invoices are harmless.
    for (let skip = 0; skip < 200; skip += 100) {
      const list = await readProvider(`invoices?subscription_id=${sid}&count=100&skip=${skip}`);
      if (!Array.isArray(list.items)) throw new Error('invoice_collection_invalid');
      for (const invoice of list.items) {
        if (invoice.subscription_id !== sid) throw new Error('invoice_subscription_mismatch');
        if (invoice.status === 'paid') await inspect(invoice);
      }
      if (list.items.length < 100) break;
    }
    const known = (
      await db.query('SELECT payment_id FROM payment_ledger WHERE subscription_id=$1', [row.id])
    ).rows;
    const paymentIDs = new Set<string>([...known.map((k) => k.payment_id), ...evidence.keys()]);
    const refundStates: any[] = [];
    for (const id of paymentIDs) refundStates.push(await readPayment(id));
    const knownDisputes = (
      await db.query(
        'SELECT d.provider_id FROM billing_disputes d JOIN payment_ledger l ON l.payment_id=d.payment_id WHERE l.subscription_id=$1',
        [row.id],
      )
    ).rows;
    const disputeIDs = new Set<string>(knownDisputes.map((d) => d.provider_id));
    const did = event?.payload?.dispute?.entity?.id;
    if (did) disputeIDs.add(did);
    const disputes: any[] = [];
    for (const id of disputeIDs) {
      if (!/^disp_[A-Za-z0-9]+$/.test(id)) throw new Error('dispute_identity_invalid');
      const d = await readProvider('disputes/' + encodeURIComponent(id));
      if (
        d.id !== id ||
        !paymentIDs.has(d.payment_id) ||
        !['open', 'under_review', 'won', 'lost', 'closed'].includes(d.status) ||
        d.currency !== 'INR' ||
        !Number.isInteger(d.amount) ||
        d.amount <= 0 ||
        d.amount > 29900
      )
        throw new Error('dispute_payment_mismatch');
      disputes.push(d);
    }
    await db.query('BEGIN');
    try {
      const current = (
        await db.query('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [row.id])
      ).rows[0];
      if (current.provider_id !== sid) throw new Error('subscription_binding_changed');
      await db.query(
        `UPDATE subscriptions SET status=$2,checkout_url=coalesce($3,checkout_url),renewal_failed_at=CASE WHEN $2 IN('pending','halted') THEN coalesce(renewal_failed_at,now()) WHEN $2='active' THEN NULL ELSE renewal_failed_at END,next_reconcile_at=now()+interval '6 hours',reconcile_error=NULL,updated_at=now() WHERE id=$1`,
        [row.id, sub.status, sub.short_url || null],
      );
      for (const e of evidence.values()) {
        const prior = (
          await db.query(
            'SELECT subscription_id,invoice_id,period_start,paid_until,captured_at FROM payment_ledger WHERE payment_id=$1',
            [e.p.id],
          )
        ).rows[0];
        if (
          prior &&
          (prior.subscription_id !== row.id ||
            prior.invoice_id !== e.invoice.id ||
            new Date(prior.period_start).getTime() !== e.invoice.billing_start * 1000 ||
            new Date(prior.paid_until).getTime() !== e.until.getTime() ||
            (prior.captured_at && new Date(prior.captured_at).getTime() !== e.capturedAt.getTime()))
        )
          throw new Error('immutable_payment_conflict');
        await db.query(
          "INSERT INTO payment_ledger(payment_id,subscription_id,amount_minor,currency,paid_until,period_start,invoice_id,captured_at) VALUES($1,$2,29900,'INR',$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            e.p.id,
            row.id,
            e.until,
            new Date(e.invoice.billing_start * 1000),
            e.invoice.id,
            e.capturedAt,
          ],
        );
        await db.query(
          'UPDATE payment_ledger SET captured_at=$2 WHERE payment_id=$1 AND captured_at IS NULL',
          [e.p.id, e.capturedAt],
        );
      }
      for (const p of refundStates)
        if (fullyRefunded(p))
          await db.query(
            'UPDATE payment_ledger SET refunded_at=coalesce(refunded_at,now()) WHERE payment_id=$1',
            [p.id],
          );
      for (const d of disputes)
        await db.query(
          'INSERT INTO billing_disputes(provider_id,payment_id,status,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(provider_id) DO UPDATE SET status=EXCLUDED.status,evidence=EXCLUDED.evidence,updated_at=now() WHERE billing_disputes.payment_id=EXCLUDED.payment_id',
          [
            d.id,
            d.payment_id,
            d.status,
            JSON.stringify({ status: d.status, amount: d.amount, currency: d.currency }),
          ],
        );
      // One won dispute must not clear another unresolved dispute for the same payment.
      await db.query(
        "UPDATE payment_ledger l SET disputed_at=CASE WHEN EXISTS(SELECT 1 FROM billing_disputes d WHERE d.payment_id=l.payment_id AND d.status<>'won') THEN coalesce(disputed_at,now()) ELSE NULL END WHERE subscription_id=$1",
        [row.id],
      );
      await db.query(
        "UPDATE subscriptions SET paid_until=(SELECT max(paid_until) FROM payment_ledger WHERE subscription_id=$1 AND refunded_at IS NULL AND disputed_at IS NULL AND period_start<=now()),first_delivery_due_at=(SELECT min(captured_at)+interval '72 hours' FROM payment_ledger WHERE subscription_id=$1),updated_at=now() WHERE id=$1",
        [row.id],
      );
      await db.query(
        "INSERT INTO audit_log(actor_id,tenant_id,action,target_id,data) VALUES('worker',$1,'billing.reconciled',$2,$3)",
        [
          row.tenant_id,
          row.id,
          JSON.stringify({
            providerID: sid,
            invoices: evidence.size,
            disputes: disputes.length,
            status: sub.status,
          }),
        ],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    if (locked) {
      try {
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
      } catch {
        destroy = true;
      }
    }
    db.release(destroy);
  }
}

export async function processBillingJob(): Promise<boolean> {
  if (!billingConfigured()) return false;
  // Lease via available_at without a network call inside an open transaction.
  const event = (
    await workerPool.query(
      "UPDATE billing_inbox SET available_at=now()+interval '10 minutes' WHERE event_id=(SELECT event_id FROM billing_inbox WHERE status='pending' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
    )
  ).rows[0];
  if (!event) return false;
  try {
    let sid = event.payload.payload?.subscription?.entity?.id,
      pid = event.payload.payload?.payment?.entity?.id;
    if (!pid && event.payload.payload?.refund?.entity?.payment_id)
      pid = event.payload.payload.refund.entity.payment_id;
    if (!pid && event.payload.payload?.dispute?.entity?.payment_id)
      pid = event.payload.payload.dispute.entity.payment_id;
    if (!sid && pid) {
      const payment = await provider('payments/' + encodeURIComponent(pid));
      if (payment.invoice_id)
        sid = (await provider('invoices/' + encodeURIComponent(payment.invoice_id)))
          .subscription_id;
    }
    if (sid) await reconcileSubscription(sid, event.payload);
    else if (/^(subscription|payment|refund|dispute)\./.test(event.payload.event ?? ''))
      throw new Error('unbound_billing_event');
    await workerPool.query(
      "UPDATE billing_inbox SET status='processed',error_code=NULL WHERE event_id=$1",
      [event.event_id],
    );
  } catch (e) {
    await workerPool.query(
      "UPDATE billing_inbox SET attempts=attempts+1,status=CASE WHEN attempts>=7 THEN 'dead' ELSE 'pending' END,available_at=now()+interval '5 minutes',error_code=$2 WHERE event_id=$1",
      [event.event_id, e instanceof HttpError ? e.code : 'reconciliation_failed'],
    );
  }
  return true;
}
function validRefund(refund: any, paymentID: string): boolean {
  return (
    /^rfnd_[A-Za-z0-9]+$/.test(refund?.id ?? '') &&
    refund.payment_id === paymentID &&
    refund.currency === 'INR' &&
    Number.isInteger(refund.amount) &&
    refund.amount > 0 &&
    refund.amount <= 29900 &&
    ['pending', 'processed', 'failed'].includes(refund.status)
  );
}
/** A full refund after earlier credits refunds only the reconciled remaining balance. Pending or inconsistent evidence refuses mutation. */
export function remainingRefundDecision(
  payment: any,
  refunds: any[],
  commandID: string,
): { remaining: number; existing: any | null } {
  if (
    !/^pay_[A-Za-z0-9]+$/.test(payment?.id ?? '') ||
    !['captured', 'refunded'].includes(payment.status) ||
    payment.amount !== 29900 ||
    payment.currency !== 'INR' ||
    !Number.isInteger(payment.amount_refunded) ||
    payment.amount_refunded < 0 ||
    payment.amount_refunded > payment.amount
  )
    throw new Error('refund_payment_evidence_invalid');
  if (
    refunds.some((r) => !validRefund(r, payment.id)) ||
    new Set(refunds.map((r) => r.id)).size !== refunds.length
  )
    throw new Error('refund_collection_invalid');
  const matching = refunds.filter(
    (r) => r.receipt === commandID || r.notes?.kulture_command_id === commandID,
  );
  if (matching.length > 1) throw new Error('refund_command_conflict');
  if (matching.length) {
    if (matching[0].status === 'failed') throw new Error('refund_failed');
    return { remaining: 0, existing: matching[0] };
  }
  if (refunds.some((r) => r.status === 'pending')) throw new Error('prior_refund_pending');
  if (
    refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount, 0) !==
    payment.amount_refunded
  )
    throw new Error('refund_total_mismatch');
  const remaining = payment.amount - payment.amount_refunded;
  return {
    remaining,
    existing: remaining === 0 ? (refunds.find((r) => r.status === 'processed') ?? null) : null,
  };
}
async function refundRemaining(c: any, row: any) {
  const pid = z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .parse(c.payload.paymentID),
    deadline = AbortSignal.timeout(60000);
  const ledger = (
    await workerPool.query(
      'SELECT invoice_id FROM payment_ledger WHERE subscription_id=$1 AND payment_id=$2',
      [row.id, pid],
    )
  ).rows[0];
  if (!ledger) throw new Error('refund_payment_binding');
  const payment = await provider('payments/' + pid, undefined, deadline);
  if (payment.id !== pid || payment.invoice_id !== ledger.invoice_id)
    throw new Error('refund_payment_binding');
  const refunds: any[] = [];
  let complete = false;
  for (let skip = 0; skip < 200; skip += 100) {
    const list = await provider(
      `payments/${pid}/refunds?count=100&skip=${skip}`,
      undefined,
      deadline,
    );
    if (!Array.isArray(list.items)) throw new Error('refund_collection_invalid');
    refunds.push(...list.items);
    if (list.items.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('refund_collection_requires_review');
  const decision = remainingRefundDecision(payment, refunds, c.id);
  if (decision.existing) return decision.existing;
  if (decision.remaining <= 0) throw new Error('refund_evidence_missing');
  const body = {
    amount: decision.remaining,
    speed: 'normal',
    receipt: c.id,
    notes: { kulture_command_id: c.id },
  };
  // Persist the exact body before the only mutation. An uncertain outcome is never blindly replayed.
  await workerPool.query(
    "UPDATE billing_commands SET payload=jsonb_set(payload,'{refundRequest}',$2::jsonb) WHERE id=$1 AND state='running'",
    [c.id, JSON.stringify(body)],
  );
  const result = await provider(`payments/${pid}/refund`, body, deadline, {
    'X-Refund-Idempotency': c.id,
  });
  if (
    !validRefund(result, pid) ||
    result.amount !== body.amount ||
    (result.receipt !== c.id && result.notes?.kulture_command_id !== c.id)
  )
    throw new Error('refund_response_mismatch');
  return result;
}
/** Poll accepted refund requests to their actual provider completion state; acceptance is not completion. */
export async function reconcilePendingRefunds(): Promise<number> {
  if (!billingConfigured()) return 0;
  const rows = (
    await workerPool.query(
      "UPDATE billing_commands SET lease_until=now()+interval '15 minutes' WHERE id IN(SELECT id FROM billing_commands WHERE kind='refund' AND state='reconciliation_required' AND error_code='refund_pending' AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *",
    )
  ).rows;
  const deadline = AbortSignal.timeout(60000);
  for (const c of rows) {
    try {
      if (!/^rfnd_[A-Za-z0-9]+$/.test(c.provider_reference ?? ''))
        throw new Error('refund_reference_invalid');
      const result = await provider('refunds/' + c.provider_reference, undefined, deadline);
      if (
        result.id !== c.provider_reference ||
        !validRefund(result, c.payload.paymentID) ||
        result.amount !== c.payload.refundRequest?.amount ||
        (result.receipt !== c.id && result.notes?.kulture_command_id !== c.id)
      )
        throw new Error('refund_response_mismatch');
      if (result.status === 'pending') continue;
      const state = result.status === 'processed' ? 'succeeded' : 'failed';
      await workerPool.query(
        "UPDATE billing_commands SET state=$2,error_code=$3,completed_at=now(),lease_until=NULL WHERE id=$1 AND state='reconciliation_required' AND error_code='refund_pending' AND provider_reference=$4",
        [c.id, state, state === 'failed' ? 'refund_failed' : null, result.id],
      );
      await workerPool.query('UPDATE subscriptions SET next_reconcile_at=now() WHERE id=$1', [
        c.subscription_id,
      ]);
    } catch {
      /* Keep the known pending command and its reference; retry after its bounded lease. */
    }
  }
  return rows.length;
}
export async function processBillingCommand(): Promise<boolean> {
  if (!billingConfigured()) return false;
  // An expired in-flight payment command requires inspection, never a blind repeat.
  await workerPool.query(
    "UPDATE billing_commands SET state='reconciliation_required',error_code='provider_outcome_uncertain' WHERE state='running' AND lease_until<now()",
  );
  const c = (
    await workerPool.query(
      "UPDATE billing_commands SET state='running',attempts=attempts+1,lease_until=now()+interval '2 minutes' WHERE id=(SELECT id FROM billing_commands WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
    )
  ).rows[0];
  if (!c) return false;
  try {
    const row = (
        await workerPool.query('SELECT * FROM subscriptions WHERE id=$1', [c.subscription_id])
      ).rows[0],
      sub = await provider('subscriptions/' + providerID.parse(row.provider_id));
    if (!bound(sub, row)) throw new Error('binding_changed');
    let result: any;
    if (c.kind === 'cancel') {
      result = ['cancelled', 'completed', 'expired'].includes(sub.status)
        ? sub
        : await provider(`subscriptions/${sub.id}/cancel`, {
            cancel_at_cycle_end: sub.status === 'active' ? 1 : 0,
          });
      await workerPool.query('UPDATE subscriptions SET cancel_at_period_end=true WHERE id=$1', [
        row.id,
      ]);
    } else if (c.kind === 'pause') {
      result =
        sub.status === 'paused'
          ? sub
          : await provider(`subscriptions/${sub.id}/pause`, { pause_at: 'now' });
      await workerPool.query(
        'UPDATE subscriptions SET renewals_paused_at=coalesce(renewals_paused_at,now()) WHERE id=$1',
        [row.id],
      );
    } else if (c.kind === 'resume') {
      result =
        sub.status === 'active'
          ? sub
          : await provider(`subscriptions/${sub.id}/resume`, { resume_at: 'now' });
      await workerPool.query('UPDATE subscriptions SET renewals_paused_at=NULL WHERE id=$1', [
        row.id,
      ]);
    } else {
      result = await refundRemaining(c, row);
      if (result.status === 'pending') {
        await workerPool.query(
          "UPDATE billing_commands SET state='reconciliation_required',provider_reference=$2,error_code='refund_pending',lease_until=now()+interval '15 minutes' WHERE id=$1",
          [c.id, result.id],
        );
        return true;
      }
      if (result.status === 'failed') {
        await workerPool.query(
          "UPDATE billing_commands SET state='failed',provider_reference=$2,error_code='refund_failed',completed_at=now(),lease_until=NULL WHERE id=$1",
          [c.id, result.id],
        );
        return true;
      }
    }
    await workerPool.query(
      "UPDATE billing_commands SET state='succeeded',provider_reference=$2,completed_at=now(),lease_until=NULL WHERE id=$1",
      [c.id, result.id],
    );
    await workerPool.query('UPDATE subscriptions SET next_reconcile_at=now() WHERE id=$1', [
      row.id,
    ]);
  } catch (e) {
    await workerPool.query(
      "UPDATE billing_commands SET state='reconciliation_required',error_code=$2,lease_until=NULL WHERE id=$1",
      [c.id, e instanceof HttpError ? e.code : 'provider_outcome_uncertain'],
    );
  }
  return true;
}
export async function processBillingMaintenance(): Promise<boolean> {
  if (!billingConfigured()) return false;
  const row = (
    await workerPool.query(
      "UPDATE subscriptions SET next_reconcile_at=now()+interval '15 minutes' WHERE id=(SELECT id FROM subscriptions WHERE provider_id IS NOT NULL AND next_reconcile_at<=now() ORDER BY next_reconcile_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
    )
  ).rows[0];
  if (row) {
    try {
      await reconcileSubscription(row.provider_id);
    } catch {
      await workerPool.query(
        "UPDATE subscriptions SET reconcile_error='provider_reconciliation_failed' WHERE id=$1",
        [row.id],
      );
    }
  }
  const pendingRefunds = await reconcilePendingRefunds();
  await updateFirstDeliveryEvidence();
  const late = (
    await workerPool.query(
      "SELECT * FROM subscriptions WHERE first_delivery_due_at<now() AND first_delivery_verified_at IS NULL AND status NOT IN('cancelled','completed','expired') LIMIT 50",
    )
  ).rows;
  for (const s of late) {
    const db = await workerPool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `delivery-incident:${s.id}`,
      ]);
      const prior = (
        await db.query(
          "SELECT id FROM service_requests WHERE kind='delivery_incident' AND body->>'subscriptionID'=$1",
          [s.id],
        )
      ).rows[0];
      if (!prior) {
        await db.query(
          "INSERT INTO service_requests(tenant_id,actor_id,place_id,kind,body) VALUES($1,'system',$2,'delivery_incident',$3)",
          [
            s.tenant_id,
            s.place_id,
            JSON.stringify({
              subscriptionID: s.id,
              message:
                'No independently verified usable website delivery within 72 hours of first captured payment. Renewal pause queued; owner can request repair or cancellation/refund.',
            }),
          ],
        );
        await command(db, s.id, 'pause');
        await db.query(
          "INSERT INTO business_notifications(tenant_id,place_id,event_key,kind,title,body) VALUES($1,$2,$3,'delivery_incident','Your first website needs attention',$4) ON CONFLICT DO NOTHING",
          [
            s.tenant_id,
            s.place_id,
            `first-delivery:${s.id}`,
            'Your website has not passed independent delivery checks within 72 hours. We opened a support incident and queued a pause of renewals. You can choose continued repair or request cancellation and a first-charge refund. Review Plan & billing for the actual provider pause status.',
          ],
        );
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  return !!row || late.length > 0 || pendingRefunds > 0;
}

/** Only the currently applied sequence on the originally selected binding, freshly checked after payment, fulfils delivery. */
export async function updateFirstDeliveryEvidence() {
  await workerPool.query(`UPDATE subscriptions s SET first_delivery_verified_at=t.verified_at
  FROM publication_destinations d JOIN target_deliveries t ON t.destination_id=d.id AND t.sequence=d.last_sequence
  WHERE s.first_delivery_verified_at IS NULL AND s.first_delivery_due_at IS NOT NULL
   AND d.id=s.first_website_destination_id AND d.binding_id=s.first_website_binding_id
   AND d.tenant_id=s.tenant_id AND d.place_id=s.place_id AND d.state='verified_live'
   AND t.state='verified_live' AND t.verified_at>=GREATEST(s.first_selected_at,s.first_delivery_due_at-interval '72 hours')
   AND d.last_success_at>=t.verified_at`);
}
