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

First startup creates separate database roles, applies checked migrations and seeds the bundled catalog. Data persists in the `database` volume across restarts. Repeated startup does not overwrite merchant edits. The local override binds development ports only to loopback. Never use it on a public VPS. On this Windows workspace, port 54329 is occupied, so add `-f compose.dev.yaml` to the Compose command to bind PostgreSQL to loopback port 54330 instead.

## Start on a VPS

Use an x86-64 Linux VPS with Docker and Compose. Start with 2 vCPU, 4 GB RAM and SSD storage; this is an initial sizing assumption, not a verified capacity guarantee. Set up firewall access for SSH and ports 80/443 only. Point your domain's DNS A/AAAA records at the VPS first.

```sh
# Check out the reviewed console commit together with this platform/ directory.
cd <checkout>/platform
./ops/setup.sh
# Edit .env privately: PUBLIC_URL=https://your-domain, DOMAIN=your-domain, NODE_ENV=production.
docker compose up --build -d
curl https://your-domain/health/ready
```

Caddy obtains and renews HTTPS certificates. PostgreSQL and the private operator service have no published ports. The public API does not receive the migration or worker database credentials. Configure native apps with this HTTPS origin using their account/server settings. iPhone and Mac remain native Swift; Android remains native Kotlin. See [launch readiness](docs/Launch-Readiness.md) before accepting real customers.

Open `/console/` to create an account, workspace and private location draft, or use the native Mac dashboard. Claims require a separate operator review. Publishing requires a captured paid period, a qualifying failed-renewal grace period, or an explicit expiring operator pilot grant. A mandate authorization never grants paid access; payment never approves ownership. Essential factual corrections to an existing delivered destination and export remain available after expiry. ₹299/month is per physical location. Live collection remains gated on merchant activation.

The Products & services editor can scan owner-uploaded menu or product images with DeepSeek Flash and return categorized, editable suggestions. Scans are limited and scan images are not stored by Kulture. The owner must add reviewed suggestions to a private draft and publish it separately. Visibility displays GEO and SEO readiness checklists for that draft, with a manual recalculation button and links to the live public page, sitemap and Search Console when applicable. These scores are not observed search rankings or AI citations.

The Coupons page lets a business create percentage or fixed-amount codes for selected offerings, all products, all services or all offerings, then switch each code on or off. Coupons are public only for approved, published businesses, and the shareable page lists only currently eligible published items. Redemption and payment remain with the business; there is no checkout or point-of-sale integration.

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

Copy any authorized DeepSeek key into the private server environment, never source or release mobile binaries. `ops/setup.sh` generates unique database, session and operator secrets plus an Ed25519 publication signing key. Keep the private signing key only on the worker. Protect `.env`; do not paste it into logs or tickets. The WordPress adapter source is absent from this checkout, so its downloadable zip is unavailable; the hosted business website remains supported.

The routing gateway must expose `/routed-car/route/v1/driving/...` and `/routed-foot/route/v1/driving/...` beneath the configured base URL, each backed by the matching driving or walking profile. A stock single-profile OSRM endpoint does not provide both paths automatically. Shared routing does not use the public demo server. These previews use sourced POI nodes, not verified entrances, and contain no live-traffic claim.

## Operator access

The web review queue is at `/admin/`. Set `ADMIN_USER_IDS` in the private server `.env` to a comma-separated list of Better Auth user IDs before starting the stack. Only those signed-in accounts can read submissions or approve/reject claims. In production, an admin account must also have a verified email. Record an independent evidence check in the review reason; a submission alone is not proof of ownership. The browser never receives `OPS_TOKEN` or worker database credentials. The always-on `admin-review` container has no published host port and accepts only claim queue/review and health routes.

```sh
docker compose --profile ops up -d ops
# Execute commands inside the container; it injects the operator token privately.
docker compose exec ops node ops/operator.mjs GET /v1/ops/claims
```

See [Merchant API](docs/Merchant-API.md) for claim decisions, publishing and withdrawal commands. The optional `ops` profile remains available for private maintenance actions. Stop it with `docker compose --profile ops stop ops` when finished. Caddy refuses operator and internal routes even if a caller knows a token.

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
- [Launch readiness](docs/Launch-Readiness.md): verified local behavior and outstanding activation gates.

Paid plans buy maintenance and tools, not guaranteed search ranking or AI recommendations. Published, crawled, indexed, cited, referred and paid are distinct events. A missing measurement remains unavailable.

## GitHub automation activation

The repository-root workflow is `.github/workflows/platform.yml`. Once this combined checkout is committed and pushed, GitHub Actions can build the Linux stack, validate Caddy, run real database tests and perform backup/restore. The workflow has not run on GitHub from this local checkout. Run integration tests against a disposable database, never the live production catalogue.

## Product and handover

- [Launch readiness](docs/Launch-Readiness.md), [website delivery](docs/Website-Delivery-API.md), [maps and media](docs/Maps-and-Media.md), [portable archive](docs/Portable-Export-API.md), [billing reconciliation](docs/Billing-Reconciliation.md).
- Shared request schemas/taxonomy and route inventory: `docs/contracts/`. Generate with `node --import tsx scripts/generate-contracts.ts` in a configured environment.

The platform-hosted website is an exact approved artifact. Custom domains require TXT control, routed DNS, valid HTTPS and separate canonical-migration approval. The WordPress adapter package is not included in this checkout and must be supplied and reviewed before enabling WordPress delivery.

A single VPS does not constitute city-wide field coverage or high availability. Follow the external gates before public launch.

The [operations runbook](docs/Operations-Runbook.md) contains key rotation, private operator commands, queue/financial failure handling, and retention-safe disaster recovery.
