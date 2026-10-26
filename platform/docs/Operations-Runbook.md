# Kulture production operations

This runbook covers the supplied single-VPS platform, worker and WordPress adapter. Commands assume the `platform/` directory of a reviewed release and its private `.env`. They do not authorize arbitrary payment refunds or deletion of another business's data. Use a disposable database for tests. Record the operator, release commit, affected location IDs, reason and outcome in the incident or change record; application commands also write audit events.

The [software acceptance ledger](../../docs/Software-Acceptance.md) records executed checks. [Launch gates](../../docs/Launch-Gates.md) distinguish those checks from live SMTP, Razorpay, DNS/TLS, merchant permission, field walkthroughs and the twenty-install WordPress pilot. An accessible page, an organic crawler request, indexing, AI citation and a conversion are separate outcomes.

## Deployment and upgrades

Follow the [platform README](../README.md) for the initial Compose deployment. Before public access, set the actual HTTPS `PUBLIC_URL`, `DOMAIN` and `NODE_ENV=production`; configure verified mail delivery and required providers. Keep database ports private. Never use `compose.local.yaml` on a public VPS. Only the worker/private operator receives the worker database credential; only migrations receive the administrator credential. The isolated domain-authority service uses ordinary database credentials.

1. Record the current image/release and save a matched database, media and retention-journal backup. Copy recovery material off-host and verify a restore before an irreversible upgrade.
2. Review all new migrations and provider/protocol compatibility. Applied migrations are immutable: the runner checks their SHA-256 hashes and takes a database advisory lock. Each SQL file is transactional. Do not edit old files, skip a failing migration or use the `--through` option as a downgrade.
3. Pull or unpack the reviewed release. Run `docker compose build`, then `docker compose up -d`. Migration and seed services must finish successfully before the new API/worker is accepted. The seed does not overwrite merchant edits.
4. Check `docker compose ps`, public `GET /health/ready`, API/container health and a worker heartbeat newer than 90 seconds. Database health uses TCP readiness; an init-time local socket alone is insufficient. HTTP health checks must use the configured Host. Unknown public Host values correctly return 421. The dedicated domain-authority service permits only its health and certificate-authorization paths.
5. Smoke sign-in/recovery, a tenant-scoped read, public directory/hosted/media URLs, a controlled preview and the worker. Confirm migration ledger and image version. Do not create real financial commands as a smoke test.
6. Roll back application images only if the prior version is compatible with the migrated schema and stored bundle format. Otherwise repair forward or rehearse a separate restored-database cutover. Never overwrite production with a backup merely because startup failed.

`ops/setup.sh` preserves an existing `.env`. Its migration bootstrap creates missing roles; changing an existing role password in `.env` does **not** rotate the database role. Rotate the actual PostgreSQL role through a private administrative session, update every dependent service and restart in a coordinated change. Do not print `.env`, expanded Compose configuration, database URLs or recovery tokens in tickets.

## Private operator workflow

```sh
docker compose --profile ops up -d ops
docker compose exec -T ops node ops/operator.mjs GET /v1/ops/claims
# Stop after the reviewed operator work is complete.
docker compose --profile ops stop ops
```

`operator.mjs` sends local HTTP with the correct Host and privately supplies `X-Ops-Token`. Caddy blocks operator routes; never expose the ops service or copy its token into the web/native client. Claim responses contain private evidence: use a restricted terminal, not a recorded public support session.

For a claim, inspect independent evidence of control of the exact physical branch. Payment, a familiar brand name, a screenshot from the app or another branch's approval is insufficient. Resolve competing claims before approval; only one approved claim per location is allowed. Use the actual claim UUID in this example:

```sh
docker compose exec -T ops node ops/operator.mjs POST /v1/ops/claims/CLAIM_UUID/review \
  '{"decision":"approved","reason":"Control of this exact branch was independently reviewed under case CASE_ID."}'
```

Supported decisions are `approved`, `rejected`, `disputed`, `revoked`. A non-approved decision withdraws the affected Kulture public projection and stops queued writes. It cannot recall already saved external WordPress HTML. Put a legal hold in place before resolving a dispute when evidence must survive its normal expiry. Avoid putting document numbers, passwords or full evidence in review-reason text: the audit history is retained.

An explicit pilot is separate from ownership and billing:

```sh
docker compose exec -T ops node ops/operator.mjs POST /v1/ops/pilot-grants \
  '{"tenantID":"TENANT_UUID","placeID":"PLACE_ID","startsAt":"2026-10-01T00:00:00Z","endsAt":"2026-10-15T00:00:00Z","reason":"Time-limited approved pilot under case CASE_ID."}'
docker compose exec -T ops node ops/operator.mjs POST /v1/ops/pilot-grants/GRANT_UUID/revoke '{}'
```

Replace the sample dates; a grant must have a defined start/end and be no longer than 90 days. The location needs an approved claim. Never fabricate a subscription or payment ledger entry to enable a pilot. For ordinary support, inspect `/v1/ops/service-requests` and record an honest `in_review`, `resolved` or `declined` outcome with `PATCH /v1/ops/service-requests/{id}` and `{state,resolution}`. Mark a deletion/export request resolved only after its actual work is complete. See [Merchant API](Merchant-API.md), [Maps and media](Maps-and-Media.md) and [billing procedures](Billing-Reconciliation.md).

## Publication signing keys

Publication signing is Ed25519 over exact serialized payload bytes. WordPress pins public keys during pairing; a new public key is not silently trusted. The online worker has the private key. The API and plugin need only the trusted public keyring. `ops/generate-signing-key.sh` creates an initial key and deliberately refuses to replace an existing active key.

For a planned rotation:

1. Inventory connected installations, outstanding deliveries, the active `PUBLICATION_SIGNING_KEY_ID`, and bundle `installBefore` deadlines. Back up the current private key separately under restricted access. Do not rotate by deleting `.env` or rerunning setup.
2. Generate a new Ed25519 pair into **new** 0600 files with a distinct non-secret key ID. For example, after choosing unused file names:

   ```sh
   umask 077
   openssl genpkey -algorithm ED25519 -out .secrets/publication-next-private.pem
   openssl pkey -in .secrets/publication-next-private.pem -pubout -out .secrets/publication-next-public.pem
   ```

3. Through the private configuration editor, append the new **public** PEM to `PUBLICATION_TRUSTED_KEYS_JSON`, preserving the old public key. Keep the active private key/ID unchanged. PEM and JSON escaping must match the existing setup format. Recreate the API and worker so they advertise the staged keyring.
4. Have each participating WordPress administrator use **Review & accept current server signing keys** on the already authenticated, fixed Kulture connection. Compare the displayed key ID with the release/change record. Track confirmations explicitly; this release does not provide a fleet-wide trust-acknowledgement dashboard. Unconfirmed installations must stay pending and must not be called successfully migrated.
5. Switch the worker's `PUBLICATION_SIGNING_PRIVATE_KEY` and `PUBLICATION_SIGNING_KEY_ID` to the new pair, recreate the worker, and publish one controlled, freshly approved revision. Confirm the received key ID, receipt, exact artifact and independent access observation. A mismatched key/private-key pair fails closed.
6. Retain the old trusted public key until all old queued deliveries have completed or their actual `installBefore` times have expired. Bundles currently last at most 24 hours; also allow the 15-second apply lease and clock-skew margin. Then remove the old public key from the advertised trusted ring, refresh installation trust and archive/destroy the obsolete private key according to the recovery policy. Never reissue an old signed bundle under a new ID.

For compromise, stop signing, put the compromised ID in comma-separated `PUBLICATION_REVOKED_KEY_IDS`, remove it from the trusted ring, deploy the revocation to the API and worker, and rotate to a fresh key. Keep the revoked ID recorded. Fresh apply leases recheck server-side revocation; offline installations cannot obtain a new lease. An already-issued 15-second lease is a bounded in-flight window, not instantaneous recall. Already published content needs a separate withdrawal/local site response. Investigate installation credentials and host integrity as well as the signing key. Resume affected delivery only with a new review/approval and valid signature; do not reset failed old bundles to queued by SQL.

## WordPress distribution and updates

From the repository root, build the dependency-free installable package:

```sh
node wordpress/package.mjs
shasum -a 256 wordpress/dist/kulture-publisher.zip
```

The package contains only `kulture-business/`; the deployed server serves `/downloads/kulture-publisher.zip`. Record the ZIP hash, source commit, plugin version, renderer version and template hash in the approved release record. Compare the downloaded ZIP with that trusted record before upload. HTTPS and a hash shown beside the same potentially compromised download are not an independent signature.

This repository builds the ZIP; it does **not** implement a signed automatic WordPress-update feed. If signed distribution is required, release operations must sign the hash manifest with a separate offline release key and distribute its verification key through an existing trusted channel. Do not reuse the online publication signing private key as the release key or represent this manual step as built automation.

Back up the WordPress database/content, test on a staging clone with the supported PHP sodium/DOM and transactional-table prerequisites, then upload through the site's authorized administrator. Verify plugin version, fixed origin, pinned keys, branch/page bindings and metadata permissions. Run a fresh preview/apply/access check. Renderer/template changes require compatible server/plugin versions and fresh approval; an incompatible bundle must remain blocked. The plugin changes only the explicitly paired managed page, and local edits produce a conflict. Rollback is a new reviewed higher-sequence delivery, not replay of an old signature. Deactivation/disconnect retains saved HTML and stops managed metadata hooks; follow [the adapter README](../../wordpress/README.md) and [protocol details](Website-Delivery-API.md).

## Queues, notifications and uncertain financial commands

Inspect the specific publication/delivery/access job, its error code, lease and attempt history before retrying. Expired leases are recovered by the worker. A timeout is not proof that a remote write failed. Owner-facing destination `/retry` accepts a failed/delayed delivery ID and revalidates authority, media and bundle expiry; an expired signature or changed local hash requires a new preview and approval. Do not bulk-reset job states or alter artifact hashes. A late WordPress receipt triggers reconciliation against the public artifact.

Notifications always have a durable in-app row. Email is supplemental. Missing SMTP marks a row `unconfigured`; send failures retry on a bounded schedule and eventually become `failed`. Fix SMTP and verified owner recipients first. There is no public “retry all email” endpoint: a private, narrowly scoped administrative repair may requeue specifically reviewed `failed`/`unconfigured` IDs to `pending`, set `next_attempt_at=now()` and reset attempts, with an audit record. Never requeue `sent` rows blindly. A lost SMTP acknowledgement may produce duplicate mail; do not promise exactly-once email.

For payments, use [Billing reconciliation](Billing-Reconciliation.md). A queued cancellation/pause/refund is not provider completion. A `reconciliation_required` command means its outcome is uncertain: inspect the provider subscription/payment/refund using its recorded reference, then resolve the **same** command with the verified result and case reason. Do not issue a second refund or fabricate a captured interval. The private command-resolution endpoint records the operator's verified provider reference; it does not perform an independent human investigation. Disputes first missed by webhooks require an operator-triggered provider reconciliation. Treat every money-moving action as its own explicitly approved operation.

## Domains, service pause and shutdown

Custom-domain onboarding requires TXT control, routing of every public A/AAAA address to the serving host, valid HTTPS, an exact canonical migration preview, and approval. The private certificate-authority endpoint authorizes only current verified bindings. Do not turn it into a public wildcard issuer or trust arbitrary `X-Forwarded-Host`. See [Website delivery](Website-Delivery-API.md) for requests and states.

An entitlement pause retains the hosted website for 90 days. The default platform site then redirects to the basic listing; a custom domain displays a further 30-day migration notice before its binding/certificate authorization is removed. A disconnected but retained hosted target also receives a pause timestamp and deadline, even if the location remains paid. Durable notifications are emitted at pause, days 60/83/90/113/120; delivery depends on the configured channels. Retention changes serving behavior and does not erase shared building data.

For a contested/unsafe publication, use the private publication withdrawal or claim revocation command and verify that its public projection is no longer served. A normal disconnect deliberately retains content; it is not an emergency takedown. For routine migration, let the customer export and move content before the deadline, change their DNS, and verify the replacement canonical. Removal of a database binding stops Kulture routing and future certificate authorization; it does not erase every certificate copy or external WordPress page immediately.

Before planned platform shutdown: announce a real timeline through durable in-app notices and configured email; stop new sales/renewals through verified provider commands; resolve uncertain charges/refunds; keep sign-in and unpaid export available during migration; provide the actual downloadable [portable archive](Portable-Export-API.md), not only links. Exported public derivatives must be moved to new hosting before Kulture media URLs cease working. Arrange continued ownership/redirects for public domains and arrival QR links if continuity is promised. Take the final database/media/journal backup, export the latest holds, revoke adapter credentials/signing authority, and close ingress only after the migration window. Local third-party copies cannot be remotely guaranteed deleted.

## Private retention, holds and restore replay

`CLAIM_PROOF_RETENTION_DAYS` defaults to 180 and accepts integers 30–3650. The worker redacts private evidence and review text only for approved/rejected/revoked claims older than that reviewed-at window. Submitted/disputed cases remain for operator handling. The claim identity/status remains; audit and financial history are not erased by this job. Evidence referenced on another system is not deleted from that external system automatically.

Unused private merchant drafts and unused private business-photo assets become eligible only after **both** 90 days without changes and 90 days of observed location-service pause. Renewed paid/pilot access is rechecked before deletion. Any publication history protects its draft. Public-approved media, assets in website previews, referenced arrival material, checkpoint/floor-plan assets and shared building graphs are excluded from automatic removal, including revoked public derivatives. Their removal requires separate scoped review. Interrupted/failed private uploads have shorter recovery windows, but use the same hold/journal boundary.

Create an operator hold before a review/appeal deadline:

```sh
docker compose exec -T ops node ops/operator.mjs POST /v1/ops/retention/holds \
  '{"tenantID":"TENANT_UUID","placeID":"PLACE_ID","reason":"Preserve this branch material while case CASE_ID is reviewed."}'
```

Omit `placeID` for a workspace-wide hold. Optional paired `entityType` and `entityID` restrict it to `claim_proof`, `merchant_draft` or `media_asset`. Releasing a hold requires `/v1/ops/retention/holds/{id}/release` with a substantive `{reason}`. Holds and deletion share a database lock; attaching arrival photos shares that boundary too. A hold created after logical deletion cannot recreate erased data; it can stop pending physical cleanup.

The deletion worker first commits a minimal `retention_tombstones` record, then unlinks only validated keys under the exact asset UUID. A crash resumes from `files_deleted_at IS NULL`. The journal contains identity/reason/object keys, not the removed proof or original image bytes. Keep it encrypted off-host beyond the oldest recoverable backup; deleting it earlier would permit restored private material to reappear. Journal durability on the same disk is not off-host replication: operate and monitor the export/copy schedule and its recovery-point objective.

Private inspection/export contracts:

- `GET /v1/ops/retention/journal?after=0&limit=1000` returns `{entries,nextCursor}`; continue until an empty page.
- `GET /v1/ops/retention/holds?after=UUID` returns all active **and released** hold records, ordered by UUID, plus `nextCursor`; the recovery helper takes a consistent complete snapshot.
- `GET /v1/ops/retention/status` reports pending physical deletion count, oldest pending time and active hold count.
- Replay is restricted to the private operator boundary. The recovery helper imports the latest holds first, then tombstones, and drains deletions against the **isolated restored database/media**, before any public serving.

A scope mismatch, a newer conflicting object, a restored public/shared reference, an active hold, or a post-snapshot hold whose tenant/location is absent quarantines the restore for operator reconciliation. Never suppress the error or silently discard a newer hold to make a drill pass. Preserve the backup and journal inputs and resolve the specific conflict with a review record.

## Backup and disaster recovery

```sh
./ops/backup.sh
./ops/restore-check.sh backups/EXACT_BACKUP_NAME.dump recovery/latest.retention.json recovery/latest.retention.sha256
```

Export a fresh complete journal/hold snapshot between full backups:

```sh
./ops/backup.sh --journal-only
```

Encrypt and copy the resulting journal and trusted checksum off-host using versioned names; do not overwrite the only recovery copy. Full backups include their own consistent journal snapshot. The three-argument restore command requires a supplied journal no older than that backup; the older deletion state inside the database dump is insufficient.

The compiled helper supports `node dist/scripts/retention-recovery.js export` and `replay --database kulture_restore_YYYYMMDDHHMMSS_HEX8 --journal FILE --sha256 HEX64 --media-root DIR`. Prefer the shell wrapper: it creates and validates `.kulture-restore.json`, mounts only the isolated media copy, imports all holds before deletion with draining disabled, and records `RECOVERY-CHECKED` or `QUARANTINED`. The replay helper validates the dedicated worker role and database name before importing application/database/storage modules. It never starts the general worker or provider jobs.

The helper pauses the deletion worker while taking the database snapshot and immutable media copy, then restarts it if it was running. Keep the matching dump, media archive, retention/holds snapshot, checksums and manifest together. Backups contain private accounts and business information. `BACKUP_AGE_RECIPIENT` produces an encrypted age bundle when age is installed; confirm the off-host copy and apply the plaintext-file retention policy separately. The helper does not make your VPS an off-host backup service.

Back up deployment secrets separately with narrower access: database role credentials, Better Auth secret, operator secret, publication private/public key history, provider credentials and any required certificate recovery state. The ordinary data bundle excludes `.env` and signing private keys. Preserve the reviewed source release and migration hashes with the recovery record. A suspected compromise requires credential rotation, not automatic reuse of a recovered secret.

`restore-check.sh` creates a new `kulture_restore_*` database and separate media directory; it never overwrites the live database. It verifies archive hashes, rejects unsafe media archive entries, checks public derivative hashes, and requires deletion/hold replay before a restored service can be accepted. Use the **latest** off-host journal/hold snapshot in addition to the backup's snapshot so deletions after the database backup remain effective. The recovery CLI refuses a non-restore database and validates the extracted media directory before importing any module that can delete data.

After replay reaches zero pending deletion (or all conflicts are independently resolved), smoke the restored release privately: auth isolation, catalog/public projections, media hashes, expired claims/rights, canonical bindings and worker state. Do not let the isolated worker send email, charge/refund money or sync external sites during a drill. Keep provider adapters disabled and queues paused. Record restore duration and data-loss window from actual measurements. A disaster cutover is a separately reviewed change of database/media endpoints and secrets; the check helper does not perform it automatically.

## Operational alerts and evidence

These are starting alert thresholds to tune after measurement, not promised SLOs:

| Signal                                                                                                          | Initial response                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Public ready check or container unhealthy; worker heartbeat older than 90 seconds                               | Page the operator; inspect database/worker/configuration before accepting queued work.                                 |
| Publication/access queue age above 5 minutes, WordPress awaiting sync above 15 minutes, repeated lease recovery | Inspect destination-specific failure and WordPress cron/availability; avoid blind retries.                             |
| Signing mismatch, untrusted/revoked-key errors or unexpected template version                                   | Stop affected writes; verify release/key staging and installed trust.                                                  |
| `reconciliation_required`, dead billing inbox, unresolved refund or first-delivery incident                     | Review provider evidence promptly using the billing runbook.                                                           |
| Email unconfigured/failed, unverified owner recipients                                                          | Keep in-app notice visible; fix configuration and requeue only reviewed IDs.                                           |
| Pending physical deletion increasing, hold conflict, overdue claim-proof cleanup                                | Review retention status and worker errors; never override holds automatically.                                         |
| Backup older than the agreed recovery objective; journal export/copy lag; restore drill overdue                 | Treat as a recovery incident; verify off-host readability rather than file existence alone.                            |
| Missing/changed media bytes, checksum failure, unexpected disk growth; less than 20% disk free                  | Investigate storage and backups; critical below 10%. Preserve evidence and avoid deleting public assets to free space. |
| Custom-domain DNS drift, TLS renewal failure, upcoming retention/domain removal                                 | Contact the owner through the configured channels and verify the actual hostname.                                      |
| Crawler log cursor lag or lost rotated input                                                                    | Mark coverage partial; never manufacture missing requests.                                                             |

The Caddy discovery log excludes authentication, account, plans and GPS paths and redacts query/header secrets. It still temporarily contains source IPs needed for bot verification. Rotation is configured at 20 MiB, seven retained files and 168 hours. This is **not a strict seven-day purge guarantee for a low-volume active file**: operate a reviewed age/purge policy for raw input and verify it, recording any resulting coverage gap. Never archive raw IP logs with a public report. Crawler observations/coverage are retained for 35 days; expired unreferenced verification snapshots are pruned after that window. Quota buckets expire after two days and idempotency rows after 30 days. Do not replay expired client mutation keys as if their original response were still guaranteed.

Only provider-verified requests observed at the trusted edge count as verified crawls. Caddy/collector synthetic access checks stay excluded; training/search/user-fetch roles stay separate. A CDN or reverse proxy added later changes the source-IP trust boundary and requires an explicit proxy/logging review. No request counter proves indexing, recommendation or revenue.
