# Kulture — self-hosted platform

The native Android and iPhone consumer apps, Swift Mac dashboard and responsive web business console share this API. The full server runs on one Linux VPS using Docker Compose: Caddy, a TypeScript API, a durable background worker, and PostgreSQL/PostGIS. No Vercel or Neon account is required.

## Start locally

Requirements: Docker Engine/Desktop with Compose v2 and an x86-64 Linux container engine. The supplied PostGIS image is the x86-64 build. The native client builds need their own Android/Xcode toolchains.

```sh
cd platform
./ops/setup.sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d api worker
curl http://localhost:3000/health/ready
curl http://localhost:3000/v1/catalog
```

First startup creates separate database roles, applies checked migrations and seeds the bundled research catalog (150 places and 121 separately sourced OSM features). Data persists in the `database` volume across restarts. Repeated startup does not overwrite merchant edits. The local override binds development ports only to loopback. Never use it on a public VPS.

## Start on a VPS

Use an x86-64 Linux VPS with Docker and Compose. Start with 2 vCPU, 4 GB RAM and SSD storage; this is an initial sizing assumption, not a verified capacity guarantee. Set up firewall access for SSH and ports 80/443 only. Point your domain's DNS A/AAAA records at the VPS first.

```sh
git clone --branch codex/unified-business-platform git@github.com:nivitra/kulture-android.git
cd kulture-android/platform
./ops/setup.sh
# Edit .env privately: PUBLIC_URL=https://your-domain, DOMAIN=your-domain, NODE_ENV=production.
docker compose up --build -d
curl https://your-domain/health/ready
```

Until this branch is pushed, extract the supplied source archive and start from its `platform/` directory instead of cloning. Caddy obtains and renews HTTPS certificates. PostgreSQL and the private operator service have no published ports. The public API does not receive the migration or worker database credentials. Configure native apps with this HTTPS origin using their account/server settings. iPhone and Mac remain native Swift; Android remains native Kotlin.

Open `/console/` to create an account, workspace and private location draft, or use the native Mac dashboard. Claims require a separate operator review. Publishing requires a captured paid period, a qualifying failed-renewal grace period, or an explicit expiring operator pilot grant. A mandate authorization never grants paid access; payment never approves ownership. Essential factual corrections to an existing delivered destination and export remain available after expiry. ₹299/month is per physical location. Live collection remains gated on merchant activation.

## Connections to activate

| Connection             | Configuration                                                                                           | Behavior without it                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek               | `DEEPSEEK_API_KEY`, configurable `DEEPSEEK_MODEL`                                                       | AI returns an explicit unavailable state; discovery still works                                                                    |
| Email                  | `SMTP_URL`, `EMAIL_FROM`; configuring SMTP enables required email verification and password-reset email | Accounts remain unverified; no password-reset email or verification email is promised                                              |
| Server/Android routing | Operated/contracted OSRM-compatible gateway at `ROUTING_BASE_URL`                                       | No server-calculated route; map/address handoff remains available. Apple clients retain native MapKit route previews independently |
| Live traffic           | No adapter selected or activated                                                                        | Always reported unavailable; no inferred ETAs from live traffic                                                                    |
| Razorpay               | Merchant KYC/Subscriptions activation, key ID/secret, webhook secret, ₹299 INR monthly plan ID          | Checkout returns a configuration error; no payment collected                                                                       |
| Business photos        | Upload with rights and explicit public review                                                           | Originals stay private; only approved, current derivatives can be included in a website or arrival guide                           |
| Live events            | No contracted feed activated                                                                            | No invented live-event inventory                                                                                                   |

Copy the authorized DeepSeek key into the private server environment, never source or release mobile binaries. The live provider check on 29 September returned a validated response; an operator must maintain the account and quota. `ops/setup.sh` generates unique database, session and operator secrets plus an Ed25519 publication signing key. For an existing installation, run `ops/generate-signing-key.sh` once before deploying the WordPress adapter. Keep the private signing key only on the worker; the API and plugin use the public keyring. Protect `.env`; do not paste it into logs or tickets.

The routing gateway must expose `/routed-car/route/v1/driving/...` and `/routed-foot/route/v1/driving/...` beneath the configured base URL, each backed by the matching driving or walking profile. A stock single-profile OSRM endpoint does not provide both paths automatically. Shared routing does not use the public demo server. These previews use sourced POI nodes, not verified entrances, and contain no live-traffic claim.

## Operator access

```sh
docker compose --profile ops up -d ops
# Execute commands inside the container; it injects the operator token privately.
docker compose exec ops node ops/operator.mjs GET /v1/ops/claims
```

See [Merchant API](docs/Merchant-API.md) for claim decisions, publishing and withdrawal commands. Operator access is intentionally separate from merchant sign-in. Stop the service with `docker compose --profile ops stop ops` when finished. Caddy refuses operator and internal routes even if a caller knows a token.

## Verification and recovery

Host-side npm commands require Node.js 24 or newer. Docker supplies its own Node runtime.

```sh
npm ci
npm run check
# Supply the private environment before npm test. DB tests are enabled by RUN_DB_TESTS=true.
npm test
./ops/backup.sh
./ops/backup.sh --journal-only
./ops/restore-check.sh backups/<snapshot>.dump backups/<latest>.retention.json backups/<latest>.retention.sha256
```

The backup includes the database and media volume. The restore drill creates a **new** isolated database and media directory, validates checksums, replays the latest separately preserved holds/deletion journal and verifies current public derivatives against database SHA-256 hashes; it never overwrites live data. Set `BACKUP_AGE_RECIPIENT` to produce an encrypted age archive, and actually copy it off-host. Signing keys and deployment secrets are separate restricted recovery assets. Backups include private account and business information. Encrypt and copy them off the VPS with access controls and retention appropriate to your operation. Monitor `/health/ready`, container health, worker heartbeats, disk usage, failed publication jobs and payment reconciliation failures. Do a restore drill before launch and after database upgrades.

Updates: back up first, pull the reviewed commit, then `docker compose up --build -d`. Migrations hold an advisory lock, reject changed applied files and run in transactions. Never edit an already applied migration. Application rollback may need a forward-compatible database migration; do not restore production automatically.

A single VPS is not high availability. Scale the API and worker horizontally after load testing; move PostgreSQL to an independently managed primary/replica setup when recovery and availability requirements demand it. Outbox locking and per-user quotas are database backed, rather than process memory.

## API and source map

- `src/auth.ts`: Better Auth sessions and secure bearer tokens for native clients.
- `src/db.ts`, `migrations/`: tenant isolation, row-level security, quotas and durable commands.
- `src/modules/consumer.ts`, `ai.ts`, `routes.ts`: catalog, saved plans, taste, recommendations, grounded AI and routing.
- `src/modules/merchant.ts`, `publishing.ts`, `public.ts`: claims, reviewed drafts, publication jobs, public HTML/JSON-LD and sitemaps.
- `src/modules/telemetry.ts`: authenticated crawler observations and separate verification categories.
- `src/modules/billing.ts`: Razorpay activation boundary, raw-signature validation, duplicate-event inbox and captured-payment reconciliation.
- [Unified software acceptance](../docs/Software-Acceptance.md): completed checks and outstanding activation gates.

Paid plans buy maintenance and tools, not guaranteed search ranking or AI recommendations. Published, crawled, indexed, cited, referred and paid are distinct events. A missing measurement remains unavailable.

## GitHub automation activation

The checked-in workflow template is `ops/ci/github-actions.yml`. Copy it to `.github/workflows/platform.yml` at the repository root using a GitHub credential with workflow permission. GitHub authentication is not available to this local checkout in the current session; the workflow is supplied as a template and is not represented as running CI. It builds the Linux stack, validates Caddy, runs real database tests and performs backup/restore. Run integration tests against a disposable database, never the live production catalogue.

## Unified product and handover

- [Implemented architecture and Mermaid diagrams](../docs/UNIFIED-ARCHITECTURE.md)
- [Software acceptance ledger](../docs/Software-Acceptance.md) and [external launch gates](../docs/Launch-Gates.md)
- [Frozen specification](../docs/specs/Kulture-Business-Production-v1.md)
- [Website delivery and WordPress](docs/Website-Delivery-API.md), [Maps and media](docs/Maps-and-Media.md), [portable archive](docs/Portable-Export-API.md), [billing reconciliation](docs/Billing-Reconciliation.md)
- Shared request schemas/taxonomy and route inventory: `docs/contracts/`. Generate with `node --import tsx scripts/generate-contracts.ts` in a configured environment.

The platform-hosted website is an exact approved artifact. Custom domains require TXT control, routed DNS, valid HTTPS and separate canonical-migration approval. WordPress uses the downloadable `/downloads/kulture-publisher.zip`, outbound signed bundles, scoped control proof, a short live apply lease, replay-resistant receipts, local conflict protection and independent access verification. Plugin deactivation does not erase the saved page.

A single VPS does not constitute city-wide field coverage or high availability. Follow the external gates before public launch.

The [operations runbook](docs/Operations-Runbook.md) contains key rotation, private operator commands, queue/financial failure handling, and retention-safe disaster recovery.
