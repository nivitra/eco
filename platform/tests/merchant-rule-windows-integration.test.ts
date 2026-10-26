import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
test(
  'delayed crawler records preserve original proof windows and never fill expired gaps',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { pool, workerPool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js'),
      { ingestEdgeBatch } = await import('../src/modules/telemetry.js');
    const id = randomUUID(),
      now = Date.now(),
      hour = 3600_000,
      at = (hours: number) => new Date(now + hours * hour).toISOString();
    const checksum = 'test-window-' + id,
      ip = '2001:db8:ffff:' + id.slice(0, 4) + ':' + id.slice(4, 8) + '::1';
    try {
      const insert = async (start: number, end: number) =>
        (
          await workerPool.query(
            "INSERT INTO crawler_rule_snapshots(provider,role,user_agent_token,source_url,ranges,checksum,first_seen_at,fetched_at,expires_at) VALUES('OpenAI','search','OAI-SearchBot','https://openai.com/searchbot.json',$1,$2,$3,$3,$4) RETURNING *",
            [JSON.stringify([ip + '/128']), checksum, at(start), at(end)],
          )
        ).rows[0];
      const old = await insert(-20, -12),
        fresh = await insert(-2, 46);
      assert.notEqual(old.id, fresh.id);
      assert.equal(old.checksum, fresh.checksum);
      const preserved = (
        await workerPool.query(
          'SELECT first_seen_at,fetched_at,expires_at FROM crawler_rule_snapshots WHERE id=$1',
          [old.id],
        )
      ).rows[0];
      assert.equal(new Date(preserved.first_seen_at).toISOString(), at(-20));
      assert.equal(new Date(preserved.expires_at).toISOString(), at(-12));
      const records = [
        ['original', -16],
        ['gap', -8],
        ['expiry', -12],
        ['fresh', -1],
      ].map(([label, hours]) => ({
        host: 'localhost:3000',
        requestID: id + '-' + label,
        observedAt: at(Number(hours)),
        path: '/hyderabad/places/proof-window-fixture',
        method: 'GET',
        clientIP: ip,
        userAgent: 'OAI-SearchBot/1.0',
        status: 200,
        contentType: 'text/html',
        synthetic: false,
      }));
      await ingestEdgeBatch({
        source: 'caddy-access',
        batchID: id,
        windowStart: at(-21),
        windowEnd: at(0),
        coverage: 'partial',
        expectedRecords: records.length,
        records,
      });
      const events = (
        await workerPool.query(
          'SELECT request_id,verification,rule_snapshot_id FROM crawler_events WHERE source=$1 AND request_id=ANY($2::text[])',
          ['caddy-access', records.map((r) => r.requestID)],
        )
      ).rows;
      const event = (label: string) => events.find((e) => e.request_id === id + '-' + label);
      assert.equal(event('original').verification, 'verified');
      assert.equal(event('original').rule_snapshot_id, old.id);
      assert.equal(event('gap').verification, 'claimed');
      assert.equal(event('gap').rule_snapshot_id, null);
      assert.equal(event('expiry').verification, 'claimed');
      assert.equal(event('fresh').rule_snapshot_id, fresh.id);
    } finally {
      await workerPool.query('DELETE FROM crawler_events WHERE source=$1 AND request_id LIKE $2', [
        'caddy-access',
        id + '-%',
      ]);
      await workerPool.query('DELETE FROM edge_ingest_batches WHERE source=$1 AND batch_id=$2', [
        'caddy-access',
        id,
      ]);
      await workerPool.query('DELETE FROM crawler_rule_snapshots WHERE checksum=$1', [checksum]);
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
