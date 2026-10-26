import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  'failed and partial uploads preserve held bytes until journaled worker cleanup',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kulture-held-upload-'));
    process.env.MEDIA_ROOT = root;
    const priorInternal = process.env.INTERNAL_API;
    process.env.INTERNAL_API = 'true';
    const { app } = await import('../src/app.js'),
      { pool, workerPool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js');
    const { mediaStorage } = await import('../src/storage/filesystem.js'),
      { recoverPrivateMedia } = await import('../src/modules/retention.js');
    const suffix = randomUUID(),
      tenant = randomUUID(),
      place = `held-upload-${suffix}`;
    const req = (path: string, method = 'GET', body?: unknown, token?: string, ops = false) =>
      app.request('http://localhost:3000' + path, {
        method,
        headers: {
          'Content-Type': body instanceof Uint8Array ? 'image/png' : 'application/json',
          'X-Real-IP': `2001:db8:${suffix.slice(0, 4)}::2`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(ops ? { 'X-Ops-Token': process.env.OPS_TOKEN! } : {}),
          'Idempotency-Key': randomUUID(),
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof Uint8Array ? (body as any) : JSON.stringify(body) }),
      });
    try {
      const signup = await req('/api/auth/sign-up/email', 'POST', {
        name: 'Hold upload test',
        email: `held-upload-${suffix}@example.test`,
        password: 'Controlled-held-upload-only-password!',
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      const token = signup.headers.get('set-auth-token')!,
        user = ((await signup.json()) as any).user;
      await workerPool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [
        tenant,
        'Held upload test',
        user.id,
      ]);
      await workerPool.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        [tenant, user.id],
      );
      await workerPool.query(
        "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Held upload fixture','cafes','Jubilee Hills','Synthetic fixture','Synthetic fixture','2026-09-29','fixture')",
        [place],
      );
      await workerPool.query(
        "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{}','approved',now())",
        [tenant, place, user.id],
      );
      async function reserve() {
        const response = await req(
          '/v1/media/uploads',
          'POST',
          {
            tenantID: tenant,
            placeID: place,
            purpose: 'business_photo',
            alt: 'Synthetic invalid upload fixture',
            rights: {
              basis: 'owned',
              holder: 'Test',
              publicUse: true,
              permissionNote: 'Controlled synthetic test bytes',
              expiresAt: null,
            },
          },
          token,
        );
        assert.equal(response.status, 201, await response.clone().text());
        return (await response.json()) as any;
      }
      async function hold(id: string) {
        const response = await req(
          '/v1/ops/retention/holds',
          'POST',
          {
            tenantID: tenant,
            placeID: place,
            entityType: 'media_asset',
            entityID: id,
            reason: 'Preserve failed upload during a controlled investigation',
          },
          undefined,
          true,
        );
        assert.equal(response.status, 201, await response.clone().text());
        return ((await response.json()) as any).hold.id as string;
      }
      async function release(id: string) {
        const response = await req(
          `/v1/ops/retention/holds/${id}/release`,
          'POST',
          { reason: 'Controlled investigation completed; release retained test bytes' },
          undefined,
          true,
        );
        assert.equal(response.status, 200, await response.clone().text());
      }

      const bad = await reserve(),
        holdID = await hold(bad.id),
        bytes = Buffer.from('Private invalid image evidence: must survive decoding failure.');
      const failed = await req(bad.uploadPath, 'PUT', new Uint8Array(bytes), token);
      assert.equal(failed.status, 422, await failed.clone().text());
      const row = (await workerPool.query('SELECT * FROM media_assets WHERE id=$1', [bad.id]))
        .rows[0];
      assert.equal(row.state, 'failed');
      assert.equal(Number(row.stored_bytes), bytes.length);
      assert.equal(row.original_key, `private/${bad.id}/original`);
      assert.equal(row.derivative_key, `derivatives/${bad.id}/image.webp`);
      assert.deepEqual(await mediaStorage.read(row.original_key), bytes);
      assert.equal(
        (await req(`/v1/media/${bad.id}/preview`, 'GET', undefined, token)).status,
        404,
        'Failed bytes are never exposed by private image preview',
      );
      await workerPool.query(
        "UPDATE media_assets SET updated_at=now()-interval '2 days' WHERE id=$1",
        [bad.id],
      );
      await recoverPrivateMedia(100);
      assert.deepEqual(
        await mediaStorage.read(row.original_key),
        bytes,
        'Aged failed bytes survive an active hold',
      );
      assert.equal(
        (await workerPool.query('SELECT 1 FROM retention_tombstones WHERE entity_id=$1', [bad.id]))
          .rowCount,
        0,
      );
      await release(holdID);
      await recoverPrivateMedia(100);
      await assert.rejects(mediaStorage.read(row.original_key), { code: 'ENOENT' });
      const tombstone = (
        await workerPool.query('SELECT * FROM retention_tombstones WHERE entity_id=$1', [bad.id])
      ).rows[0];
      assert(tombstone.files_deleted_at);
      assert.deepEqual(tombstone.object_keys, [row.original_key, row.derivative_key]);

      // Simulate interruption after partial bytes reached disk but before their keys were recorded.
      const partial = await reserve(),
        partialHold = await hold(partial.id),
        partialKey = `private/${partial.id}/original`;
      await workerPool.query(
        "UPDATE media_assets SET state='processing',updated_at=now()-interval '2 hours' WHERE id=$1",
        [partial.id],
      );
      let emitted = false;
      const interrupted = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new Uint8Array(Buffer.from('partial evidence')));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          controller.error(new Error('Simulated interrupted upload'));
        },
      });
      await assert.rejects(
        mediaStorage.write(partialKey, interrupted, 1024),
        /Simulated interrupted upload/,
      );
      assert.equal(
        (await mediaStorage.read(partialKey)).toString(),
        'partial evidence',
        'Storage must not unlink a failed partial stream',
      );
      await recoverPrivateMedia(100);
      assert.equal((await mediaStorage.read(partialKey)).toString(), 'partial evidence');
      await release(partialHold);
      await recoverPrivateMedia(100);
      await assert.rejects(mediaStorage.read(partialKey), { code: 'ENOENT' });
      assert(
        (
          await workerPool.query(
            'SELECT files_deleted_at FROM retention_tombstones WHERE entity_id=$1',
            [partial.id],
          )
        ).rows[0].files_deleted_at,
      );
    } finally {
      await workerPool
        .query("UPDATE places SET state='withdrawn' WHERE id=$1", [place])
        .catch(() => {});
      process.env.INTERNAL_API = priorInternal;
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
