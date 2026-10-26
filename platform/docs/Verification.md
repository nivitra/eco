> Historical checkpoint. Current unified release checks and limits are recorded in [Software acceptance](../../docs/Software-Acceptance.md).

# Verification — 26 September 2026

This record describes executed checks, not a production certification or a claim of superior recommendation quality. No public VPS was supplied or deployed.

## Server and data

- TypeScript typecheck and production compilation passed on Node.js 24.
- The Linux application image built successfully. Docker Compose started PostgreSQL 17/PostGIS 3.5, migrations, seed, API and worker; the database, API and worker reported healthy. Ten migrations applied successfully. A second isolated project also passed first startup from an empty database with the production network configuration.
- The exact Caddy configuration passed validation in the Linux Caddy 2.10 container. Public certificate issuance was not tested because no public domain was supplied. Docker Desktop required a temporary Rosetta setting change and a restart to clear a later container-start stall; this was a local host issue, not an application entrypoint failure.
- All **29 backend tests passed, zero skipped**, against the actual container database. They cover signed/revoked sessions, non-bypass runtime roles, tenant isolation, quotas, idempotency, concurrent profile conflicts, private feedback, ownership review, exact-version publishing, withdrawal/recovery, durable webhook processing and crawler proof windows.
- A separate HTTP check exercised the built container: sign-up, signed bearer session, catalogue, private profile, sign-out and subsequent 401 rejection.
- The shipped backup and restore scripts passed against that container. Restoration created a separate database with ten migration records. Extra places in this test dump are integration fixtures; the release seed remains 37 places.
- Production dependency audit reported **zero known vulnerabilities** at verification time. This is a point-in-time package audit, not a penetration test.
- Source credential scan found no embedded supplied provider key or GitHub token. A decompressed scan of all three delivered native artifacts also found no supplied provider credential. Deployment secrets remain in an ignored private environment file.

## Recommendations and AI

- **23/23 curated scenarios passed** category coverage, stable-ID, scope and no-bars assertions. The report is [Recommendation-Evaluation.json](Recommendation-Evaluation.json), with a catalogue checksum.
- Additional tests cover negation, dismissals, explicit taste feedback, diversity, deterministic ordering, optional measured distance, and unknown hours, dietary, accessibility and price facts. The policy is an explainable heuristic ranker; these fixtures are neither model fine-tuning nor a user relevance study.
- One authenticated live DeepSeek request completed successfully in approximately 6.3 seconds with validated catalogue IDs and a completed response. It used the private server credential. Unit tests also reject malformed, oversized or out-of-scope provider responses.
- The server validates the complete provider result before emitting its response stream. It does not claim to relay unvalidated provider tokens live.
- The seed contains **37 places, 14 OSM feature observations (4 nodes and 10 bounding-box centres), 23 places without mapped coordinates, and zero verified entrances**. Bounding-box centres are not accepted as route destinations. Coverage is not exhaustive Jubilee Hills or Hyderabad mapping.

## Native clients

| Target              | Executed evidence                                                                                                                 | Limits                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Android Kotlin      | Core suite: 34 tests, zero failures, one legacy direct-provider live test skipped; debug and instrumentation APK targets compiled | No new connected-device or visual acceptance run                                 |
| Swift shared/native | 39 tests executed: 38 passed, one opt-in HTTP test skipped; separate live HTTP test passed                                        | Live check covers account/catalogue/recommendations/profile conflicts/revocation |
| iPhone              | Unsigned simulator build succeeded for arm64 and x86_64                                                                           | Simulator build is not a signed physical-iPhone distribution                     |
| Mac business        | Native app compiled for arm64                                                                                                     | Unsigned; no new visual/device acceptance run                                    |

Android sign-in and cloud inspection preserve device edits. Cloud Load and Upload are explicit; version conflicts do not silently overwrite either copy. Native clients use signed session tokens in platform secure storage. Release clients contain no DeepSeek credential.

## Payments, discovery and operations

- Razorpay tests use a strict mocked provider with the real database. They verify raw signatures, event-content conflicts, mandate activation without entitlement, captured invoice periods, immutable replay behavior and refund revocation. **No merchant account was activated and no live charge was made.**
- Crawls are counted only from captured public-page requests and reported with coverage limits. User-Agent claims, IP-verified observations, 200 responses, 304 responses and synthetic traffic remain distinct. Historical gaps cannot be filled by a later IP proof snapshot. No million-crawl or search-ranking guarantee is made.
- The workflow in `ops/ci/github-actions.yml` is an installation template. GitHub Actions was not activated because the available repository credential lacks workflow permission. The local container checks above were actually executed.

## Before a public launch

Supply a Linux x86-64 VPS, HTTPS domain and secured server environment. Activate SMTP and the merchant payment account as required. Operate or contract the routing gateway before enabling server/Android route previews. Live-traffic and live-event adapters, complete city coverage, field-verified entrances, third-party listing connectors, professional media rights, automated multi-stop route optimization, large-scale load tests, independent security review and multi-region recovery are not delivered by these checks.

Run real-user relevance evaluations and native device UX acceptance before describing this as the world's best recommendation system. The current implementation gives those evaluations a working, inspectable baseline.
