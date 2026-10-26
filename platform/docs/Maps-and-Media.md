# Maps Plus and permitted media implementation

This is a working, tested software path, not verification of a real building. No catalog venue acquired a verified entrance by this change. The synthetic contract fixture must never be used for field navigation.

## Client contract

`GET /v1/places/{stablePlaceID}/arrival?mode=walking&stepFree=false&locale=en` is anonymous. Optional `entranceID` pins the chosen entrance; optional ISO `departureAt` supports the next seven days. A past time within two minutes is normalized to now for clock skew, never used to bypass a current closure. Older times are rejected.

The v2 envelope exposes `status` (`listing_only`, `available`, `unavailable`, `expired`), `capability`, graph/place/asset/closure revisions, verification, computedAt/expiresAt, the selected entrance and exact WGS84 approach, nullable route and distance/duration, checkpoint instructions, approved assets and graph. A driving request chooses a compatible outdoor approach; graph traversal remains pedestrian. `costKind` is `measured` or `estimated`; unknown aggregate distances/durations remain null. Step-free is not a blanket wheelchair-suitability assertion.

`manifestJSON` is the exact canonical UTF-8 string of `{graph,assets}`; `manifestDigest` is its lowercase SHA-256. Verify those bytes rather than reserializing a client model. Then confirm parsed graph/assets equal the envelope. Each image has a separate SHA-256. The schema in `contracts/arrival-graph-v2.schema.json` describes wire fields; relational/evidence checks in `src/maps/graph.ts` remain authoritative because JSON Schema cannot express them all. `contracts/arrival-available.fixture.json` is synthetic, date-fixed test data.

Pin the route's release and entrance during progress. Refresh before gates/connectors; if route/entrance/release changes, require explicit rerouting. Expiry or unknown closure status disables confident guidance. Indoor checkpoints require manual confirmation, never GPS inference. The HTML equivalent `/places/{placeID}/arrival` renders instructions and approved photos without JavaScript and hands the exact approach to external maps. This implementation does not promise an internal road-routing engine.

## Authoring and publication

Tenant paths share `/v1/tenants/{tenantID}/places/{placeID}`:

- `GET/POST /arrival-drafts`: list/create complete graph drafts.
- `POST /arrival-drafts/import-v1`: authorized conversion preview with legacy graph and explicit buildingID; always sample/draft, unknown evidence/accessibility, no inherited outdoor coordinates or private image URLs. Keep returned legacySourceJSON to reconcile omitted legacy assumptions before saving v2.
- `PUT /arrival-drafts/{graphID}`: complete strict v2 replacement, `If-Match: "arrival:N"`; edits invalidate approval.
- `POST /arrival-drafts/{graphID}/submit`: current revision and idempotency key; validates evidence, connectivity, permitted assets and branch bindings.
- `POST /arrival-drafts/{graphID}/publish`: current revision, `{digest}`, idempotency key, current operator review, approved claim, publish permission and location entitlement.
- `POST /arrival-drafts/{graphID}/withdraw`: `{reason}` plus idempotency key. Safety withdrawal does not require an active paid plan.
- `POST /arrival-closures`: graphID, targetType (`entrance/node/edge/lift`), targetID, startsAt, nullable endsAt, reason. Resolution is `/arrival-closures/{id}/resolve`; repeated resolution does not increment revision.
- Anonymous `POST /v1/places/{placeID}/arrival/issues` is a bounded moderation submission and cannot change routes.

Private operator routes list `/v1/ops/arrival-reviews` and decide `/v1/ops/arrival-reviews/{graphID}` using the exact submitted digest, reason, confirmed building authority/walkthrough, source and validity. Ownership alone is not building mapping authority. `/v1/ops/arrival-sites/{siteID}/grants` assigns a separately claimed branch to a building; `/revoke` removes building authority. Shared-site grants permit explicit shared graph bindings; ordinary branch owners cannot silently edit another building. Authoring a single graph remains through its owning workspace/location; assigned editors need that workspace's scoped permission.

Dijkstra uses directed edges, nonnegative explicit duration, else estimated length/1.2 m/s, else a 60-second optimization cost; stairs add a 20-second preference penalty. Unmeasured estimates are not returned as a precise ETA. Time labels preserve alternatives where the earlier arrival is closed; waiting is not invented. Schedules support IANA timezone, weekly/overnight intervals and dated exceptions. Each traversal must remain open and evidenced through its endpoint. Every offered step-free segment requires current evidence; stairs never qualify. Expansion is bounded at 10,000 states. Unsupported `restrictionRefs` remain in a draft but block publication/planning until represented by supported access/schedule constraints.

## Media and operations

Reserve with `POST /v1/media/uploads` (tenantID/placeID/purpose/alt/rights). Upload raw JPEG/PNG/WebP bytes with `PUT {uploadPath}`. Originals are private; decode is limited to 40 MP and 5 MiB input, rotates EXIF orientation, removes metadata, and creates at most 2048×2048 WebP. Decode concurrency is bounded to two active images and eight waiting jobs per process. Authenticated `/v1/media/{id}/preview` displays the derivative. `POST /v1/media/{id}/approve-public` requires an explicit privacy/rights review before any public URL exists. Revocation is `DELETE /v1/media/{id}`. Operator derivative inspection/revocation is `/v1/ops/media/{id}/preview` and `/revoke`.

`resolvePublicAssets(db,tenantID,placeID,ids)` is the publication adapter boundary. Invoke it during preview and immediately before delivery. It rejects private, unreviewed, expired, revoked and foreign-location assets. The returned public URL has an immutable checksum in its path; new requests recheck revocation/expiry. Public caches have a 60-second maximum freshness, so recall is not instantaneous for already downloaded bytes.

`MEDIA_ROOT` is a persistent private volume shared by API and worker, included in backup/restore. Safe generated paths prevent traversal. Quotas serialize per location: 100 active reservations/images and 250 MiB retained bytes; revoking cannot evade storage limits. `maintainMedia()` recovers interrupted uploads after an hour, reservations after a day and removes revoked files after 30 days. Public delivery stops immediately on revocation; physical recovery retention is separate. Originals have no HTTP route. A future object-store adapter must preserve these boundaries.

The web mapper retains complete graph fields, debounces draft saves, encrypts device recovery with AES-GCM/nonextractable IndexedDB keys, preserves edits during an in-flight save, and merges independent stable-ID changes while requiring explicit choices on conflicts. This protects disk recovery, not a compromised same-origin script. The advanced document editor remains necessary for detailed schedules, turn pairs and uncommon graph attributes; field usability and accessibility remain release gates.

## Evidence and remaining gates

Pure planner tests cover directionality, weighted alternatives, expiry during traversal, overnight exceptions, closures, unknown accessibility, turn photos/instructions, disconnected routes and unresolved constraints. Real PostgreSQL tests cover accounts, private-media RLS, EXIF/orientation, review/digest/version/replay, shared-building authorization, closure variants, quotas and revocation/withdrawal. Web merge tests cover independent changes and delete-vs-edit conflicts.

Before a real building is enabled: establish mapping authority, collect permitted checkpoint/approach photos and measured facts, review each entrance and direction, test connectivity in the premises, calibrate accessibility attributes, exercise closure operations, test screen readers/phones/offline recovery and restore media backups. The API intentionally returns listing-only until those facts have been reviewed and published.
