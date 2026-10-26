import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

// Opt-in isolated database test. No Razorpay account or outbound payment request is used.
test(
  'billing webhook signatures, mandate state, immutable captured periods and refund replay',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async (t) => {
    const { app } = await import('../src/app.js');
    const { pool, workerPool } = await import('../src/db.js');
    const { authPool } = await import('../src/auth.js');
    const { config } = await import('../src/config.js');
    const {
      processBillingJob,
      reconcileSubscription,
      updateFirstDeliveryEvidence,
      processBillingCommand,
      reconcilePendingRefunds,
    } = await import('../src/modules/billing.js');
    const originalFetch = globalThis.fetch;
    const originalConfig = {
      razorpayKey: config.razorpayKey,
      razorpaySecret: config.razorpaySecret,
      razorpayWebhookSecret: config.razorpayWebhookSecret,
      razorpayPlanID: config.razorpayPlanID,
    };
    const suffix = randomUUID(),
      compact = suffix.replaceAll('-', ''),
      placeID = 'billing-test-' + suffix;
    const subscriptionID = randomUUID(),
      providerID = 'sub_' + compact,
      paymentID = 'pay_' + compact,
      invoiceID = 'inv_' + compact;
    const secret = 'billing-integration-webhook-secret',
      now = Math.floor(Date.now() / 1000);
    const periodStart = now - 86400,
      periodEnd = now + 29 * 86400;
    const fixturePlanID = 'plan_BillingIntegration';
    let tenantID = '',
      token = '',
      userID = '';
    const extraPayments = new Map<string, any>(),
      extraInvoices = new Map<string, any>(),
      disputes = new Map<string, any>(),
      refundLists = new Map<string, any[]>(),
      refundRecords = new Map<string, any>();
    let expectedRefundCommand: string | null = null,
      refundPosts = 0;
    let subscriptionReadHook: (() => Promise<void>) | undefined;
    const providerCalls: string[] = [];
    let providerSubscription: Record<string, unknown> = {};
    let hasCapturedInvoice = false;
    let providerPayment: Record<string, unknown> = {
      id: paymentID,
      status: 'captured',
      amount: 29900,
      currency: 'INR',
      invoice_id: invoiceID,
      amount_refunded: 0,
    };
    let providerInvoice: Record<string, unknown> = {
      id: invoiceID,
      subscription_id: providerID,
      payment_id: paymentID,
      status: 'paid',
      amount_paid: 29900,
      paid_at: now - 2 * 86400,
      billing_start: periodStart,
      billing_end: periodEnd,
    };
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      authenticated = false,
      headers: Record<string, string> = {},
    ) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': `2001:db8:${compact.slice(0, 4)}:${compact.slice(4, 8)}::1`,
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const expect = async (response: Response, status: number) => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const eventBody = (event: string, includePayment = true) => ({
      event,
      payload: {
        subscription: { entity: { id: providerID } },
        ...(includePayment ? { payment: { entity: { id: paymentID } } } : {}),
      },
    });
    const sign = (raw: string) => createHmac('sha256', secret).update(raw).digest('hex');
    const webhook = (id: string, raw: string, signature = sign(raw)) =>
      app.request('http://localhost:3000/v1/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-event-id': id,
          'x-razorpay-signature': signature,
        },
        body: raw,
      });
    const subscription = async () =>
      (
        await workerPool.query('SELECT status,paid_until FROM subscriptions WHERE id=$1', [
          subscriptionID,
        ])
      ).rows[0];
    const ledger = async () =>
      (
        await workerPool.query(
          'SELECT payment_id,paid_until,period_start,invoice_id,refunded_at FROM payment_ledger WHERE subscription_id=$1',
          [subscriptionID],
        )
      ).rows;
    const billing = async () => {
      const result = await expect(
        await request(`/v1/tenants/${tenantID}/billing`, 'GET', undefined, true),
        200,
      );
      return result.subscriptions.find((s: any) => s.id === subscriptionID);
    };
    async function processEvent(id: string) {
      // Prioritize only this test's event; never remove or rewrite unrelated inbox records.
      await workerPool.query(
        "UPDATE billing_inbox SET created_at=(SELECT min(created_at)-interval '1 second' FROM billing_inbox),available_at=now() WHERE event_id=$1",
        [id],
      );
      assert.equal(await processBillingJob(), true);
      return (
        await workerPool.query(
          'SELECT status,attempts,error_code FROM billing_inbox WHERE event_id=$1',
          [id],
        )
      ).rows[0];
    }
    try {
      Object.assign(config, {
        razorpayKey: 'rzp_test_local_fixture',
        razorpaySecret: 'local-fixture-only',
        razorpayWebhookSecret: secret,
        razorpayPlanID: fixturePlanID,
      });
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        assert.equal(
          url.origin,
          'https://api.razorpay.com',
          'This test permits only mocked Razorpay requests',
        );
        if (init?.method === 'POST') {
          assert(
            expectedRefundCommand,
            'Unexpected provider mutation outside the controlled refund command test',
          );
          assert.equal(url.pathname, `/v1/payments/${paymentID}B/refund`);
          const body = JSON.parse(init.body as string);
          assert.equal(body.amount, 29800);
          assert.equal(body.receipt, expectedRefundCommand);
          assert.equal(
            new Headers(init.headers).get('X-Refund-Idempotency'),
            expectedRefundCommand,
          );
          refundPosts++;
          const result = {
            id: 'rfnd_' + compact + 'Remaining',
            payment_id: paymentID + 'B',
            amount: body.amount,
            currency: 'INR',
            status: 'pending',
            receipt: body.receipt,
            notes: body.notes,
          };
          refundRecords.set('/v1/refunds/' + result.id, result);
          return Response.json(result);
        }
        assert.equal(init?.method, 'GET', 'Only the explicit refund test permits a mocked POST');
        providerCalls.push(url.pathname);
        if (url.pathname === `/v1/subscriptions/${providerID}`) await subscriptionReadHook?.();
        const evidence =
          url.pathname === `/v1/subscriptions/${providerID}`
            ? providerSubscription
            : url.pathname === `/v1/payments/${paymentID}`
              ? providerPayment
              : url.pathname === `/v1/invoices/${invoiceID}`
                ? providerInvoice
                : url.pathname === '/v1/invoices'
                  ? {
                      items: [
                        ...(hasCapturedInvoice ? [providerInvoice] : []),
                        ...extraInvoices.values(),
                      ],
                    }
                  : extraPayments.get(url.pathname) ||
                    extraInvoices.get(url.pathname) ||
                    disputes.get(url.pathname) ||
                    refundRecords.get(url.pathname) ||
                    (refundLists.has(url.pathname)
                      ? { items: refundLists.get(url.pathname) }
                      : undefined);
        assert(evidence, `Unexpected mocked provider path: ${url.pathname}`);
        return Response.json(evidence);
      };
      await workerPool.query(
        `INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query)
   VALUES($1,$1,'Billing integration fixture','cafes','Jubilee Hills','Test address','Isolated billing test fixture','2026-09-26','Fixture Hyderabad')`,
        [placeID],
      );
      const signup = await request('/api/auth/sign-up/email', 'POST', {
        name: 'Billing integration',
        email: `billing-${suffix}@example.test`,
        password: 'Billing-integration-only-password!',
      });
      userID = (await expect(signup, 200)).user.id;
      token = signup.headers.get('set-auth-token')!;
      assert(token);
      const tenant = await expect(
        await request('/v1/tenants', 'POST', { name: 'Billing integration workspace' }, true, {
          'Idempotency-Key': randomUUID(),
        }),
        201,
      );
      tenantID = tenant.id;
      await workerPool.query(
        "INSERT INTO subscriptions(id,tenant_id,place_id,provider_id,status) VALUES($1,$2,$3,$4,'created')",
        [subscriptionID, tenantID, placeID, providerID],
      );
      providerSubscription = {
        id: providerID,
        plan_id: fixturePlanID,
        status: 'active',
        current_end: periodEnd,
        notes: { kulture_subscription_id: subscriptionID, tenant_id: tenantID, place_id: placeID },
      };

      await t.test(
        'raw signature validation precedes enqueue; duplicate ID changes conflict',
        async () => {
          const id = 'evt_activation_' + compact,
            raw = JSON.stringify(eventBody('subscription.activated', false));
          assert.equal((await webhook(id, raw, '0'.repeat(64))).status, 401);
          assert.equal(
            (await webhook(id, raw + ' ', sign(raw))).status,
            401,
            'Whitespace changes signed raw bytes',
          );
          assert.equal(
            (await workerPool.query('SELECT 1 FROM billing_inbox WHERE event_id=$1', [id]))
              .rowCount,
            0,
          );
          await expect(await webhook(id, raw), 202);
          await expect(await webhook(id, raw), 202);
          const changed = JSON.stringify(eventBody('subscription.cancelled', false));
          await expect(await webhook(id, changed), 409);
          const stored = (
            await workerPool.query('SELECT payload FROM billing_inbox WHERE event_id=$1', [id])
          ).rows;
          assert.equal(stored.length, 1);
          assert.equal(stored[0].payload.event, 'subscription.activated');
          assert.equal((await processEvent(id)).status, 'processed');
          assert.equal((await subscription()).status, 'active');
          assert.equal((await subscription()).paid_until, null);
          assert.equal((await ledger()).length, 0);
          assert.equal(
            (await billing()).entitled,
            false,
            'Mandate activation is not a captured payment',
          );
        },
      );

      await t.test(
        'verified captured invoice grants only its immutable billing period',
        async () => {
          hasCapturedInvoice = true;
          providerPayment = { ...providerPayment, amount_refunded: 100, refund_status: 'partial' };
          const id = 'evt_charged_' + compact;
          await expect(await webhook(id, JSON.stringify(eventBody('subscription.charged'))), 202);
          assert.equal((await processEvent(id)).status, 'processed');
          assert.equal((await subscription()).paid_until.getTime(), periodEnd * 1000);
          const rows = await ledger();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].payment_id, paymentID);
          assert.equal(rows[0].period_start.getTime(), periodStart * 1000);
          assert.equal(rows[0].invoice_id, invoiceID);
          assert.equal(
            (await billing()).entitled,
            true,
            'First observation after a partial service credit preserves paid coverage',
          );
          const due = (
            await workerPool.query('SELECT first_delivery_due_at FROM subscriptions WHERE id=$1', [
              subscriptionID,
            ])
          ).rows[0].first_delivery_due_at;
          assert.equal(
            due.getTime(),
            (now - 2 * 86400 + 72 * 3600) * 1000,
            'Provider paid_at, not processing time, starts the delivery clock',
          );
          providerPayment = { ...providerPayment, amount_refunded: 0, refund_status: null };
          await reconcileSubscription(providerID);
          providerPayment = { ...providerPayment, amount_refunded: 100, refund_status: 'partial' };
          await reconcileSubscription(providerID);
          assert.equal(
            (await billing()).entitled,
            true,
            'Capture followed by partial credit has the same outcome',
          );
        },
      );

      await t.test(
        'same payment under a new event ID cannot inherit a later subscription end',
        async () => {
          providerSubscription = { ...providerSubscription, current_end: periodEnd + 30 * 86400 };
          const id = 'evt_replay_' + compact;
          await expect(await webhook(id, JSON.stringify(eventBody('subscription.charged'))), 202);
          assert.equal((await processEvent(id)).status, 'processed');
          assert.equal((await subscription()).paid_until.getTime(), periodEnd * 1000);
          const rows = await ledger();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].paid_until.getTime(), periodEnd * 1000);
          // Even a later provider representation of this invoice cannot rewrite an existing ledger entry.
          providerInvoice = {
            ...providerInvoice,
            billing_start: periodStart + 30 * 86400,
            billing_end: periodEnd + 30 * 86400,
          };
          const changedID = 'evt_changed_evidence_' + compact;
          await expect(
            await webhook(changedID, JSON.stringify(eventBody('subscription.charged'))),
            202,
          );
          assert.equal(
            (await processEvent(changedID)).status,
            'pending',
            'Conflicting immutable invoice evidence requires reconciliation',
          );
          assert.equal((await subscription()).paid_until.getTime(), periodEnd * 1000);
          assert.equal((await ledger())[0].period_start.getTime(), periodStart * 1000);
          providerInvoice = {
            ...providerInvoice,
            billing_start: periodStart,
            billing_end: periodEnd,
          };
        },
      );

      await t.test(
        'full refund revokes access and stale charged evidence cannot resurrect it',
        async () => {
          providerPayment = {
            ...providerPayment,
            refunded: true,
            amount_refunded: 29900,
            refund_status: 'full',
          };
          const id = 'evt_refund_' + compact;
          await expect(await webhook(id, JSON.stringify(eventBody('payment.refunded'))), 202);
          assert.equal((await processEvent(id)).status, 'processed');
          assert.equal((await subscription()).paid_until, null);
          assert.equal((await billing()).entitled, false);
          const refundedAt = (await ledger())[0].refunded_at;
          assert(refundedAt instanceof Date);
          // Simulate stale upstream captured evidence after a confirmed refund: the append-only ledger wins.
          providerPayment = {
            ...providerPayment,
            refunded: false,
            amount_refunded: 0,
            refund_status: null,
          };
          const replayID = 'evt_post_refund_' + compact;
          await expect(
            await webhook(replayID, JSON.stringify(eventBody('subscription.charged'))),
            202,
          );
          assert.equal((await processEvent(replayID)).status, 'processed');
          assert.equal((await subscription()).paid_until, null);
          assert.equal((await billing()).entitled, false);
          const rows = await ledger();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].refunded_at.getTime(), refundedAt.getTime());
        },
      );

      await t.test(
        'first dispute before ledger is atomic; known dispute polling repairs a missing won webhook',
        async () => {
          const pid = paymentID + 'B',
            iid = invoiceID + 'B',
            did = 'disp_' + compact,
            otherDID = did + 'B';
          extraPayments.set('/v1/payments/' + pid, {
            id: pid,
            status: 'captured',
            amount: 29900,
            currency: 'INR',
            invoice_id: iid,
            amount_refunded: 0,
          });
          extraInvoices.set('/v1/invoices/' + iid, {
            ...providerInvoice,
            id: iid,
            payment_id: pid,
            paid_at: now,
          });
          disputes.set('/v1/disputes/' + did, {
            id: did,
            payment_id: pid,
            status: 'open',
            amount: 29900,
            currency: 'INR',
          });
          await reconcileSubscription(providerID, {
            payload: { dispute: { entity: { id: did } } },
          });
          const disputed = async () =>
            (
              await workerPool.query('SELECT disputed_at FROM payment_ledger WHERE payment_id=$1', [
                pid,
              ])
            ).rows[0].disputed_at;
          assert(
            await disputed(),
            'New captured evidence and its earlier-arriving dispute are committed together',
          );
          assert.equal((await billing()).entitled, false);
          disputes.set('/v1/disputes/' + otherDID, {
            id: otherDID,
            payment_id: pid,
            status: 'under_review',
            amount: 100,
            currency: 'INR',
          });
          await reconcileSubscription(providerID, {
            payload: { dispute: { entity: { id: otherDID } } },
          });
          disputes.get('/v1/disputes/' + did).status = 'won';
          await reconcileSubscription(providerID);
          assert(
            await disputed(),
            'One won dispute cannot clear another unresolved dispute on the payment',
          );
          disputes.get('/v1/disputes/' + otherDID).status = 'won';
          await reconcileSubscription(providerID);
          assert.equal(await disputed(), null);
          assert.equal(
            (await billing()).entitled,
            true,
            'No won webhook was supplied; routine polling restores paid access',
          );
          const wrong = 'disp_' + compact + 'Wrong';
          disputes.set('/v1/disputes/' + wrong, {
            id: wrong,
            payment_id: 'pay_Unrelated',
            status: 'open',
            amount: 29900,
            currency: 'INR',
          });
          await assert.rejects(
            reconcileSubscription(providerID, { payload: { dispute: { entity: { id: wrong } } } }),
            /dispute_payment_mismatch/,
          );
          assert.equal(
            (await workerPool.query('SELECT 1 FROM billing_disputes WHERE provider_id=$1', [wrong]))
              .rowCount,
            0,
          );
          await reconcileSubscription(providerID);
          assert.equal((await billing()).entitled, true, 'Rejected evidence releases its lock');
        },
      );

      await t.test(
        'concurrent reconciliation cannot read and commit an older provider snapshot',
        async () => {
          let release!: () => void, entered!: () => void;
          const enteredPromise = new Promise<void>((r) => (entered = r)),
            gate = new Promise<void>((r) => (release = r));
          subscriptionReadHook = async () => {
            entered();
            await gate;
          };
          const first = reconcileSubscription(providerID);
          await enteredPromise;
          try {
            const calls = providerCalls.length;
            await assert.rejects(
              reconcileSubscription(providerID),
              (e: any) => e.code === 'billing_reconciliation_busy',
            );
            assert.equal(
              providerCalls.length,
              calls,
              'Busy invocation must not start a stale provider read',
            );
          } finally {
            subscriptionReadHook = undefined;
            release();
            await first;
          }
          providerSubscription = { ...providerSubscription, status: 'cancelled' };
          await reconcileSubscription(providerID);
          assert.equal((await subscription()).status, 'cancelled');
          providerSubscription = { ...providerSubscription, status: 'active' };
          await reconcileSubscription(providerID);
        },
      );

      await t.test(
        'full refund after a prior partial credit submits once and waits for actual provider completion',
        async () => {
          const pid = paymentID + 'B',
            cmd = randomUUID();
          expectedRefundCommand = cmd;
          extraPayments.get('/v1/payments/' + pid).amount_refunded = 100;
          refundLists.set('/v1/payments/' + pid + '/refunds', [
            {
              id: 'rfnd_' + compact + 'Credit',
              payment_id: pid,
              amount: 100,
              currency: 'INR',
              status: 'processed',
              receipt: 'prior-service-credit',
            },
          ]);
          await workerPool.query(
            "INSERT INTO billing_commands(id,subscription_id,kind,payload,created_at) VALUES($1,$2,'refund',$3,coalesce((SELECT min(created_at)-interval '1 second' FROM billing_commands),now()))",
            [
              cmd,
              subscriptionID,
              JSON.stringify({ paymentID: pid, reason: 'Controlled approved full-refund test' }),
            ],
          );
          assert.equal(await processBillingCommand(), true);
          const state = async () =>
            (
              await workerPool.query(
                'SELECT state,error_code,provider_reference,payload FROM billing_commands WHERE id=$1',
                [cmd],
              )
            ).rows[0];
          assert.equal((await state()).state, 'reconciliation_required');
          assert.equal((await state()).error_code, 'refund_pending');
          assert.equal((await state()).payload.refundRequest.amount, 29800);
          assert.equal(refundPosts, 1);
          await workerPool.query(
            "UPDATE billing_commands SET lease_until=now()-interval '1 second' WHERE id=$1",
            [cmd],
          );
          await reconcilePendingRefunds();
          assert.equal(
            (await state()).state,
            'reconciliation_required',
            'Accepted pending refund is not reported completed',
          );
          assert.equal(refundPosts, 1);
          const refund = refundRecords.get('/v1/refunds/' + (await state()).provider_reference);
          refund.status = 'processed';
          extraPayments.get('/v1/payments/' + pid).amount_refunded = 29900;
          await workerPool.query(
            "UPDATE billing_commands SET lease_until=now()-interval '1 second' WHERE id=$1",
            [cmd],
          );
          await reconcilePendingRefunds();
          assert.equal((await state()).state, 'succeeded');
          assert.equal(refundPosts, 1);
          await reconcileSubscription(providerID);
          assert.equal(
            (await billing()).entitled,
            false,
            'Full processed refund updates the corresponding paid interval',
          );
          expectedRefundCommand = null;
        },
      );

      await t.test(
        'delivery SLA requires the current selected binding and a post-payment public verification',
        async () => {
          const target = randomUUID(),
            binding = randomUUID(),
            claim = randomUUID(),
            draft = randomUUID(),
            publication = randomUUID(),
            firstPreview = randomUUID(),
            secondPreview = randomUUID();
          await workerPool.query(
            "INSERT INTO merchant_claims(id,tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,$4,'{}','approved',now())",
            [claim, tenantID, placeID, userID],
          );
          await workerPool.query(
            "INSERT INTO merchant_drafts(id,tenant_id,place_id,claim_id,base_place_revision,profile,created_by) VALUES($1,$2,$3,$4,1,'{}',$5)",
            [draft, tenantID, placeID, claim, userID],
          );
          await workerPool.query(
            "INSERT INTO publications(id,tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path) VALUES($1,$2,$3,$4,1,1,'{}',$5,'test','/test')",
            [publication, tenantID, placeID, draft, 'a'.repeat(64)],
          );
          await workerPool.query(
            "INSERT INTO publication_destinations(id,tenant_id,place_id,kind,binding_id,public_url,canonical_url,state,last_applied_hash,last_sequence,last_success_at) VALUES($1,$2,$3,'hosted',$4,'https://fixture.invalid','https://fixture.invalid','verified_live','hash',2,now())",
            [target, tenantID, placeID, binding],
          );
          for (const [preview, sequence] of [
            [firstPreview, 1],
            [secondPreview, 2],
          ]) {
            await workerPool.query(
              "INSERT INTO destination_previews(id,destination_id,tenant_id,place_id,draft_id,draft_version,target_version,sequence,snapshot,fragment,html,metadata,base_content_hash,artifact_digest,metadata_digest,digest,renderer_version,template_hash,expires_at) VALUES($1,$2,$3,$4,$5,1,1,$6,'{}','test','test','{}','hash','hash','hash','hash','test','hash',now()+interval '1 day')",
              [preview, target, tenantID, placeID, draft, sequence],
            );
            await workerPool.query(
              "INSERT INTO target_deliveries(tenant_id,place_id,destination_id,publication_id,preview_id,sequence,state,verified_at,applied_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()-interval '3 days',now()-interval '3 days')",
              [
                tenantID,
                placeID,
                target,
                publication,
                preview,
                sequence,
                sequence === 1 ? 'verified_live' : 'delayed',
              ],
            );
          }
          await workerPool.query(
            'UPDATE subscriptions SET first_website_destination_id=$2,first_website_binding_id=$3,first_selected_at=now(),first_delivery_verified_at=NULL WHERE id=$1',
            [subscriptionID, target, binding],
          );
          const verified = async () =>
            (
              await workerPool.query(
                'SELECT first_delivery_verified_at FROM subscriptions WHERE id=$1',
                [subscriptionID],
              )
            ).rows[0].first_delivery_verified_at;
          await updateFirstDeliveryEvidence();
          assert.equal(
            await verified(),
            null,
            'Old successful sequence must not mask current failed delivery',
          );
          await workerPool.query(
            "UPDATE target_deliveries SET state='verified_live' WHERE destination_id=$1 AND sequence=2",
            [target],
          );
          await updateFirstDeliveryEvidence();
          assert.equal(await verified(), null, 'Current but pre-selection proof must be refreshed');
          await workerPool.query(
            'UPDATE target_deliveries SET verified_at=now() WHERE destination_id=$1 AND sequence=2',
            [target],
          );
          await workerPool.query(
            'UPDATE publication_destinations SET last_success_at=now(),binding_id=$2 WHERE id=$1',
            [target, randomUUID()],
          );
          await updateFirstDeliveryEvidence();
          assert.equal(
            await verified(),
            null,
            'A replacement binding cannot fulfil the selected website',
          );
          await workerPool.query('UPDATE publication_destinations SET binding_id=$2 WHERE id=$1', [
            target,
            binding,
          ]);
          await updateFirstDeliveryEvidence();
          assert(await verified());
        },
      );
      assert(
        providerCalls.includes(`/v1/invoices/${invoiceID}`),
        'Entitlement used verified invoice evidence',
      );
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(config, originalConfig);
      await workerPool
        .query(
          "UPDATE subscriptions SET status='abandoned',provider_id=NULL,next_reconcile_at='infinity' WHERE id=$1",
          [subscriptionID],
        )
        .catch(() => {});
      await workerPool
        .query("UPDATE places SET state='withdrawn',revision=revision+1 WHERE id=$1", [placeID])
        .catch(() => {});
      await workerPool
        .query(
          "UPDATE publication_destinations SET state='revoked' WHERE tenant_id=$1 AND place_id=$2",
          [tenantID || null, placeID],
        )
        .catch(() => {});
      await workerPool
        .query(
          "UPDATE billing_inbox SET status='dead',error_code='test_fixture_finished' WHERE event_id LIKE $1 AND status='pending'",
          ['%' + compact],
        )
        .catch(() => {});
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
