import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  'private retention preserves holds and public/shared history, journals deletion and safely replays an old restore',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kulture-retention-'));
    process.env.MEDIA_ROOT = root;
    const { workerPool, pool } = await import('../src/db.js'),
      { authPool } = await import('../src/auth.js');
    const {
      processRetention,
      recoverPrivateMedia,
      replayRetention,
      retirePrivateMedia,
      RETENTION_LOCK,
    } = await import('../src/modules/retention.js');
    const { mediaStorage } = await import('../src/storage/filesystem.js');
    const tenant = randomUUID(),
      place = 'retention-' + randomUUID(),
      actor = 'retention-test';
    const data = Buffer.from('Private retention fixture; not an image');
    try {
      await workerPool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [
        tenant,
        'Retention fixture',
        actor,
      ]);
      await workerPool.query(
        "INSERT INTO places(id,slug,name,category,neighborhood,address,summary,researched_at,search_query) VALUES($1,$1,'Fixture','cafes','Jubilee Hills','Fixture','Fixture only','2026-09-29','Fixture')",
        [place],
      );
      const claim = (
        await workerPool.query(
          "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{\"secret\":\"private ownership evidence\"}','approved',now()-interval '200 days') RETURNING id",
          [tenant, place, actor],
        )
      ).rows[0];
      const heldClaim = (
        await workerPool.query(
          "INSERT INTO merchant_claims(tenant_id,place_id,submitted_by,evidence,state,reviewed_at) VALUES($1,$2,$3,'{\"secret\":\"appeal material\"}','rejected',now()-interval '200 days') RETURNING id",
          [tenant, place, actor],
        )
      ).rows[0];
      const hold = (
        await workerPool.query(
          "INSERT INTO retention_holds(tenant_id,place_id,entity_type,entity_id,reason,created_by) VALUES($1,$2,'claim_proof',$3,'Active appeal requires private evidence','test') RETURNING id,created_at",
          [tenant, place, heldClaim.id],
        )
      ).rows[0];
      await workerPool.query(
        "INSERT INTO retention_location_clocks(tenant_id,place_id,paused_at) VALUES($1,$2,now()-interval '100 days')",
        [tenant, place],
      );
      const draft = async () =>
        (
          await workerPool.query(
            'INSERT INTO merchant_drafts(tenant_id,place_id,claim_id,base_place_revision,profile,created_by,updated_at) VALUES($1,$2,$3,1,\'{"name":"Private unused draft"}\',$4,now()-interval \'100 days\') RETURNING *',
            [tenant, place, claim.id, actor],
          )
        ).rows[0];
      const unused = await draft(),
        published = await draft();
      await workerPool.query(
        "INSERT INTO publications(tenant_id,place_id,draft_id,draft_version,revision,snapshot,digest,html,canonical_path,status) VALUES($1,$2,$3,1,1,'{}',$4,'Fixture','/fixture','withdrawn')",
        [tenant, place, published.id, 'a'.repeat(64)],
      );
      const assets: Record<string, any> = {};
      for (const label of ['unused', 'held', 'public', 'building', 'recovery']) {
        const id = randomUUID(),
          key = `private/${id}/original`,
          derivative = `derivatives/${id}/image.webp`;
        await mediaStorage.write(key, new Response(data).body!, 1024);
        await mediaStorage.write(derivative, new Response(data).body!, 1024);
        const row = (
          await workerPool.query(
            "INSERT INTO media_assets(id,tenant_id,place_id,purpose,alt,rights,state,original_key,derivative_key,stored_bytes,created_by,updated_at) VALUES($1,$2,$3,$4,'Fixture','{\"publicUse\":true}',$5,$6,$7,100,$8,now()-interval '100 days') RETURNING *",
            [
              id,
              tenant,
              place,
              label === 'building' ? 'floor_plan' : 'business_photo',
              label === 'recovery' ? 'failed' : 'ready',
              key,
              derivative,
              actor,
            ],
          )
        ).rows[0];
        assets[label] = row;
        if (label === 'public')
          await workerPool.query(
            "INSERT INTO public_media(id,tenant_id,place_id,derivative_key,sha256,mime,alt,width,height,revision,revoked_at) VALUES($1,$2,$3,$4,$5,'image/webp','Fixture',1,1,1,now())",
            [id, tenant, place, derivative, 'a'.repeat(64)],
          );
        if (label === 'held')
          await workerPool.query(
            "INSERT INTO retention_holds(tenant_id,place_id,entity_type,entity_id,reason,created_by) VALUES($1,$2,'media_asset',$3,'Preserve image during active appeal','test')",
            [tenant, place, id],
          );
      }
      await recoverPrivateMedia();
      assert.equal(
        (
          await workerPool.query('SELECT retention_deleted_at FROM media_assets WHERE id=$1', [
            assets.recovery.id,
          ])
        ).rows[0].retention_deleted_at !== null,
        true,
      );
      await processRetention();
      const claims = (
        await workerPool.query(
          'SELECT id,evidence,evidence_deleted_at FROM merchant_claims WHERE tenant_id=$1',
          [tenant],
        )
      ).rows;
      assert.equal(claims.find((c) => c.id === claim.id).evidence.retained, false);
      assert.equal(claims.find((c) => c.id === heldClaim.id).evidence.secret, 'appeal material');
      assert.equal(
        (await workerPool.query('SELECT id FROM merchant_drafts WHERE id=$1', [unused.id]))
          .rowCount,
        0,
      );
      assert.equal(
        (await workerPool.query('SELECT id FROM merchant_drafts WHERE id=$1', [published.id]))
          .rowCount,
        1,
        'Even withdrawn publication history protects its draft',
      );
      await assert.rejects(mediaStorage.read(assets.unused.original_key), { code: 'ENOENT' });
      for (const label of ['held', 'public', 'building'])
        assert.deepEqual(
          await mediaStorage.read(assets[label].original_key),
          data,
          label + ' remains available',
        );
      const journal = (
        await workerPool.query(
          'SELECT * FROM retention_tombstones WHERE tenant_id=$1 ORDER BY sequence',
          [tenant],
        )
      ).rows;
      assert(journal.every((j) => j.files_deleted_at));
      assert.equal(journal.filter((j) => j.entity_type === 'media_asset').length, 2);
      const toEntry = (r: any) => ({
        id: r.id,
        tenantID: r.tenant_id,
        placeID: r.place_id,
        entityType: r.entity_type,
        entityID: r.entity_id,
        deletedAt: new Date(r.deleted_at).toISOString(),
        reason: r.reason,
        objectKeys: r.object_keys,
      });
      // Simulate an isolated old snapshot: old evidence/bytes reappear, but the separately preserved journal does not vanish.
      await workerPool.query(
        'UPDATE merchant_claims SET evidence=\'{"secret":"restored secret"}\',evidence_deleted_at=NULL WHERE id=$1',
        [claim.id],
      );
      await workerPool.query(
        "UPDATE media_assets SET state='ready',original_key=$2,derivative_key=$3,stored_bytes=100,retention_deleted_at=NULL,updated_at=now()-interval '100 days' WHERE id=$1",
        [assets.unused.id, assets.unused.original_key, assets.unused.derivative_key],
      );
      await mediaStorage.write(assets.unused.original_key, new Response(data).body!, 1024);
      const replay = journal
        .filter((j) => j.entity_type === 'claim_proof' || j.entity_id === assets.unused.id)
        .map(toEntry);
      await replayRetention(replay);
      await replayRetention(replay);
      assert.equal(
        (await workerPool.query('SELECT evidence FROM merchant_claims WHERE id=$1', [claim.id]))
          .rows[0].evidence.retained,
        false,
      );
      await assert.rejects(mediaStorage.read(assets.unused.original_key), { code: 'ENOENT' });
      const fake = toEntry({
        ...journal[0],
        id: randomUUID(),
        entity_type: 'media_asset',
        entity_id: assets.public.id,
        object_keys: [assets.public.original_key],
        deleted_at: new Date(),
      });
      await assert.rejects(replayRetention([fake]), { code: 'replay_public_asset' });
      await assert.rejects(replayRetention([{ ...fake, objectKeys: ['../../outside'] }]), {
        code: 'invalid_tombstone',
      });
      const held = toEntry({
        ...journal[0],
        id: randomUUID(),
        entity_type: 'claim_proof',
        entity_id: heldClaim.id,
        object_keys: [],
        deleted_at: new Date(),
      });
      await assert.rejects(replayRetention([held]), { code: 'retention_hold' });
      // Newer exported hold release can be restored first; an older active snapshot cannot undo it.
      const holdSnapshot = {
        id: hold.id,
        tenantID: tenant,
        placeID: place,
        entityType: 'claim_proof',
        entityID: heldClaim.id,
        reason: 'Active appeal requires private evidence',
        createdAt: new Date(hold.created_at).toISOString(),
        releasedAt: new Date().toISOString(),
        releaseReason: 'Appeal complete after independent operator review',
      };
      await assert.rejects(replayRetention([], [{ ...holdSnapshot, entityID: claim.id }]), {
        code: 'hold_replay_conflict',
      });
      await replayRetention([], [holdSnapshot]);
      await replayRetention([], [{ ...holdSnapshot, releasedAt: null, releaseReason: null }]);
      assert(
        (await workerPool.query('SELECT released_at FROM retention_holds WHERE id=$1', [hold.id]))
          .rows[0].released_at,
      );
      // An approval that commits between candidate discovery and acquiring its row lock must win.
      const approvalRow = assets.public;
      const approvalDB = await workerPool.connect();
      try {
        await approvalDB.query('BEGIN');
        await approvalDB.query('SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [
          approvalRow.id,
        ]);
        assert.equal(
          await retirePrivateMedia(approvalDB, approvalRow, 'test_candidate_before_approval'),
          false,
        );
        await approvalDB.query('COMMIT');
      } finally {
        approvalDB.release();
      }
      assert.deepEqual(await mediaStorage.read(approvalRow.original_key), data);
      // Attachment waits for the deletion boundary, then rejects the newly retired image.
      const { lockArrivalDraftAssets } = await import('../src/modules/arrival.js');
      const { readFile } = await import('node:fs/promises');
      const graph = JSON.parse(
        await readFile(new URL('fixtures/arrival-graph-v2.json', import.meta.url), 'utf8'),
      );
      graph.nodes[0].permittedPhotoIDs = [assets.unused.id];
      const deletionDB = await workerPool.connect(),
        attachmentDB = await workerPool.connect();
      try {
        await deletionDB.query('BEGIN');
        await deletionDB.query('SELECT pg_advisory_xact_lock($1)', [RETENTION_LOCK]);
        await attachmentDB.query('BEGIN');
        const attachment = lockArrivalDraftAssets(attachmentDB, graph, tenant, place);
        let complete = false;
        void attachment.then(
          () => {
            complete = true;
          },
          () => {
            complete = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(complete, false, 'Attachment waits for retention serialization');
        await deletionDB.query('COMMIT');
        await assert.rejects(attachment, { code: 'arrival_media_unavailable' });
        await attachmentDB.query('ROLLBACK');
      } finally {
        deletionDB.release();
        attachmentDB.release();
      }
      // Paid reactivation protects unused private content even with an old pause clock.
      const paidDraft = await draft();
      await workerPool.query(
        "INSERT INTO service_grants(tenant_id,place_id,starts_at,ends_at,reason,issued_by) VALUES($1,$2,now(),now()+interval '1 day','Retention fixture active plan','test')",
        [tenant, place],
      );
      await processRetention();
      assert.equal(
        (await workerPool.query('SELECT id FROM merchant_drafts WHERE id=$1', [paidDraft.id]))
          .rowCount,
        1,
      );
    } finally {
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
