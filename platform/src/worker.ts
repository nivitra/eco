import { setTimeout as delay } from 'node:timers/promises';
import { processPublishingJob } from './modules/publishing.js';
import { processTelemetry } from './modules/telemetry.js';
import { processTargetPublicationJob } from './modules/publication-targets.js';
import { processAccessCheckJob } from './modules/access-checks.js';
import { processWebsiteLifecycle } from './modules/website-domains.js';
import { processRetention } from './modules/retention.js';
import { maintainMedia } from './storage/maintenance.js';
import { processNotification } from './modules/notifications.js';
import {
  processBillingCommand,
  processBillingMaintenance,
  processBillingJob,
} from './modules/billing.js';
import { workerPool, pool } from './db.js';
import { authPool } from './auth.js';
if (!process.env.WORKER_DATABASE_URL)
  throw new Error('Worker requires a dedicated WORKER_DATABASE_URL');
let running = true;
let lastCleanup = 0;
let lastMaintenance = 0;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    running = false;
  });
while (running) {
  try {
    const published = await processPublishingJob();
    const delivered = await processTargetPublicationJob();
    const checked = await processAccessCheckJob();
    const billed = await processBillingJob();
    const command = await processBillingCommand();
    const notified = await processNotification();
    await processTelemetry();
    if (Date.now() - lastMaintenance > 60000) {
      await processBillingMaintenance();
      await processWebsiteLifecycle();
      await maintainMedia();
      await processRetention();
      lastMaintenance = Date.now();
    }
    await workerPool.query(
      "INSERT INTO worker_heartbeats(name,last_seen) VALUES('main',now()) ON CONFLICT(name) DO UPDATE SET last_seen=now(),last_error=NULL",
    );
    if (Date.now() - lastCleanup > 3600000) {
      await workerPool.query(
        "DELETE FROM quota_buckets WHERE window_start<now()-interval '2 days'",
      );
      await workerPool.query("DELETE FROM idempotency WHERE created_at<now()-interval '30 days'");
      await workerPool.query(
        "DELETE FROM crawler_events WHERE observed_at<now()-interval '35 days'",
      );
      await workerPool.query(
        "DELETE FROM edge_ingest_batches WHERE window_end<now()-interval '35 days'",
      );
      await workerPool.query(
        "DELETE FROM crawler_rule_snapshots r WHERE r.expires_at<now()-interval '35 days' AND NOT EXISTS(SELECT 1 FROM crawler_events e WHERE e.rule_snapshot_id=r.id)",
      );
      lastCleanup = Date.now();
    }
    if (!published && !billed && !delivered && !checked && !command && !notified) await delay(2000);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: 'worker_iteration_failed',
        errorType: e instanceof Error ? e.name : 'unknown',
      }),
    );
    await delay(5000);
  }
}
await Promise.all([pool.end(), workerPool.end(), authPool.end()]);
