# Website delivery API and evidence

All business endpoints use the existing signed-in session, tenant ID and location ID. The server rechecks the actor’s selected-location scope. Editors may edit, viewers may review, and publication/destination operations require the corresponding explicit grant or ownership role. Ownership approval and service entitlement are independent requirements.

Base: `/v1/tenants/{tenantID}/places/{placeID}`. Mutating commands require `Idempotency-Key`; publication also requires `If-Match` containing the reviewed draft version. Errors contain `{error:{code,message}}`. Treat unfamiliar states as unresolved.

| Endpoint                                  | Input                                                                                            | Response                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /destinations`                       | —                                                                                                | `{destinations,nextCursor:null}`                                                                                                      |
| `POST /destinations`                      | `{kind:"hosted"}` or `{kind:"wordpress",pairingCode,metadataPermissions:["canonical","schema"]}` | 201 `{destination}`                                                                                                                   |
| `GET /destinations/{id}`                  | —                                                                                                | `{destination}` including optional domain                                                                                             |
| `POST /destinations/{id}/preview`         | `{draftID,assetIDs?:[]}`                                                                         | `{preview}`                                                                                                                           |
| `POST /destinations/{id}/publish`         | `{previewID,previewDigest,approval:true}` + `If-Match`                                           | 202 `{publication,delivery}`                                                                                                          |
| `GET /deliveries`                         | optional `destinationID`, timestamp `cursor`                                                     | `{deliveries,nextCursor}`                                                                                                             |
| `GET /destinations/{id}/access`           | —                                                                                                | `{observations,nextCursor:null}`                                                                                                      |
| `POST /destinations/{id}/check`           | `{}`                                                                                             | 202 `{queued:true}`                                                                                                                   |
| `POST /destinations/{id}/retry`           | `{deliveryID}`                                                                                   | 202 `{queued:true}`; expired signatures require fresh review                                                                          |
| `POST /destinations/{id}/rollback`        | `{deliveryID}`                                                                                   | 201 `{draft,assetIDs}`; the caller must preview and approve a new higher sequence                                                     |
| `POST /destinations/{id}/disconnect`      | `{retainContent:true}`                                                                           | `{destination}`; queued writes stop, persisted content remains                                                                        |
| `POST /destinations/{id}/domain`          | `{hostname}`                                                                                     | 201 `{domain,challenge:{name,type:"TXT",value,expiresAt}}`                                                                            |
| `POST /destinations/{id}/domain/verify`   | `{}`                                                                                             | 202 `{queued:true}`                                                                                                                   |
| `POST /destinations/{id}/domain/preview`  | `{}`                                                                                             | `{preview:{digest,html,managedArtifactDigest,canonicalAndSchemaDigest,publicURL,previousURL,targetVersion,blockingIssues,expiresAt}}` |
| `POST /destinations/{id}/domain/activate` | `{previewDigest,approval:true}`                                                                  | 202 `{queued:true,deliveryID,publicURL}`                                                                                              |

Omitting `assetIDs` preserves the latest applied asset selection. Passing `[]` explicitly removes website photos. Revoked, expired or unapproved images block preparation until the owner removes or replaces them. Rollback returns the historical asset IDs, which still require current public-use permission.

A preview contains `id,draftID,draftVersion,digest,html,managedFragment,managedArtifactDigest,canonicalAndSchemaDigest,baseContentHash,sequence,rendererVersion,publicURL,blockingIssues,expiresAt`. `html` is complete hosted HTML or a complete review wrapper around the exact WordPress fragment. `managedArtifactDigest` hashes only that fragment; it is not a hash of the WordPress theme. The overall digest binds destination, version, immutable facts, sequence, local base hash, metadata, asset manifest and renderer/template. The managed artifact and metadata digests bind the bytes approved by the publisher. Expiry is15minutes.

Destination DTO: `id,tenantID,placeID,kind,pageID,metadataPermissions,state,version,publicURL,canonicalURL,installationID,bindingID,lastSequence,lastSuccessAt,lastError,pausedAt,domain`. Domain DTO: `hostname,state,expiresAt,activatedAt`. Delivery: `id,destinationID,publicationID,sequence,state,errorCode,createdAt,appliedAt,verifiedAt`.

State progression normally is `awaiting_confirmation → awaiting_control → connected → awaiting_sync → applied_unverified → verified_live`. Additional states include `applying`, `reconciling`, `conflict`, `delayed`, `failed`, `revoked`. Hosted connections begin connected. Domain progression is `requested → ownership_verified → dns_routed → tls_ready → activating → live`. A valid TLS connection alone never activates a new canonical.

## WordPress machine protocol

`POST /v1/adapter/pairings` accepts `{origin,pageID,pageURL,baseContentHash,pluginVersion:"1.0.0",rendererVersion:"kulture-static-fragment-v1",templateHash}`. It returns `installationID,credential,pairingID,code,challenge,expiresAt,publicKeys,revokedKeyIDs`. The credential is shown once, then stored only on that installation; the platform stores its hash. A human code expires after10minutes and is single-use.

Installation base: `/v1/adapter/installations/{installationID}` with its installation bearer credential:

- `POST /pairings`: create an additional branch binding, `{pageID,pageURL,baseContentHash}`.
- `GET /pairings/{pairingID}`: `{pairingID,approved,expiresAt,destination}`.
- `POST /pairings/{pairingID}/confirm`: WordPress explicitly confirms the approved binding, then the worker fetches `/wp-json/kulture/v1/control/{pairingID}` on the fixed origin.
- `GET /bundles`: `{bundles,bindings,publicKeys,revokedKeyIDs}`. Bundles are signed exact-byte envelopes, not executable PHP.
- `POST /apply-leases`: `{bundleID,payloadDigest}` →201 `{token,expiresAt,bundleID,payloadDigest,bindingID}`. The server rechecks current claim, approving actor’s current publication authority, paid/pilot/essential-correction policy, image rights and revocation. The lease lasts15seconds.
- `POST /receipts`: `{bundleID,payloadDigest,state:"applied"|"conflict"|"failed",leaseToken?,contentHash,reason?}`. Repeating identical bytes is idempotent; reusing an installation/bundle receipt with different content returns409. Late acknowledgements enter `reconciling` and require an independent exact public artifact check before the base hash/sequence advances.
- `POST /bindings/{bindingID}/disconnect` revokes one binding; `POST /disconnect` revokes the installation. Saved local HTML is retained.

An envelope contains `algorithm:"Ed25519",keyID,payloadBytes,payloadDigest,detachedSignature`. `payloadBytes` is base64 of the signed UTF-8 serialized JSON; verification occurs before parsing. The signed payload binds tenant/place/destination/installation/binding/origin, allowed page IDs, metadata permission, sequence, prior content hash, exact artifact and metadata digests, approval and publication IDs, issued/expiry times, facts and permitted assets. `metadataBytes` carries exact canonical metadata bytes; PHP does not guess a JavaScript JSON serialization order.

The fragment is written in the exact wrapper `<!-- wp:html -->\n{fragment}\n<!-- /wp:html -->`. The complete managed `post_content` hash is the next base hash. Local changes produce a conflict, and a fresh owner-approved preview binds the reported changed hash. Arbitrary origin/path/page changes require a new connection; no automatic privilege expansion occurs.

## Independent observations and lifecycle

An observation contains `id,destinationID,deliveryID,outcome,checks:[{name,status,detail}],observedURL,observedAt,synthetic:true`. Public HTTPS requests validate DNS and pin the TLS connection to a public resolved address, revalidating each bounded redirect. No credentials, cookies or transparent decompression are sent. Time, body and redirect counts are bounded. Checks cover the exact artifact, name/address in structural HTML, robots/meta/X-Robots, canonical, parseable JSON-LD, arrival link, conventional sitemap/homepage discovery and a bounded image sample. CSS/theme visual appearance, unvisited sitemap indexes and indexing eligibility remain explicitly unknown.

`verified_live` means the exact approved managed HTML was independently observed as accessible, with a timestamp. It does not mean organic crawling, indexing, a search position, AI citation, lead or sale. Simulated transports are used only in isolated integration tests. Production checks use the guarded network transport.

Jobs are durable, leased, retried with bounded backoff and inspectable failures. Each delivery’s page check has a separate coalescing key, so an older in-flight check cannot swallow a newer revision. Network IO occurs outside database transactions. The worker rechecks authority and the approver’s current role before writes.

The lifecycle worker records the actual entitlement pause, emits durable notifications at pause/day60/day83/day90/day113/day120, and preserves the hosted site for90days. The platform URL then redirects to the basic Kulture listing. A custom hostname shows a migration notice for30more days, then the binding and certificate authorization are removed. Shared arrival/building data is never erased by website retention. No claim is made that disconnected external WordPress content can be remotely removed.

Subscriptions record `first_website_destination_id` and `first_selected_at`. Billing’s72-hour first-delivery check must use that selected destination and a `target_deliveries.state='verified_live'` row with `verified_at`, backed by an `access_observations.outcome='accessible'` observation for that delivery. It must not substitute an unrelated later website or count a queued job as fulfillment.

Custom TLS authorization runs in a separate `DOMAIN_AUTHORITY_ONLY=true` service with ordinary database credentials and no public port. Only `/internal/caddy/ask` and health routes are served. The certificate predicate admits a verified, routed, unremoved hostname; arbitrary Host/X-Forwarded-Host values cannot select another tenant’s private content.

## Executed and external acceptance

Executed locally: TypeScript checks; renderer/escaping/India facts/robots/SSRF/signature fixtures; PostgreSQL tenant/entitlement/approval/hosted/control/pull/lease/conflict/rollback/receipt/revocation workflow; PHP byte-parity fixture; actual WordPress7.1.2/PHP8.3.35/MariaDB11.4 plugin runtime with declared injected HTTP transport. The latter verifies exact saved bytes, WordPress revisions, scoped metadata, durable lost-ack retry, local conflict, revocation and deactivation retention.

Not certified by those tests: real merchant authorization, twenty timed installs, public domain DNS/TLS, CDN/theme matrix, real emails or payment captures/refunds, actual crawler requests or citations. Keep those release gates pending until independent evidence is recorded.
