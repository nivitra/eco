# Merchant publication and discovery API

This is an implemented, self-hosted pilot workflow: an authenticated merchant claims an existing branch, an operator reviews ownership evidence, the merchant reviews exact public HTML, and a durable worker publishes that approved revision to both the public website and native catalog. Publication is a **free pilot**. It does not create an active ₹299 subscription or promise placement in an external search engine. Billing activation is a separate capability.

The native Mac workspace uses these endpoints with a signed Better Auth session. Local demo actions cannot approve ownership, activate billing or publish a production page. No operator credential belongs in either native app.

## Authentication and conventions

Create or sign in to an account through `/api/auth/sign-up/email` or `/api/auth/sign-in/email`. The response `set-auth-token` header supplies a signed session token; send `Authorization: Bearer <session>` on private requests. `GET /v1/me` returns the account and tenant memberships. `POST /v1/tenants` with `{ "name": "Business workspace" }` and a fresh `Idempotency-Key` creates a workspace. The session, membership and database row policies all apply; possession of a tenant UUID is insufficient.

All endpoint paths below begin with `/v1/tenants/{tenantID}` unless shown otherwise. Tenant IDs, claim IDs, draft IDs and publication IDs are UUIDs. Place IDs remain the existing stable catalog strings. Times are ISO 8601 strings. Owner and editor roles can write; viewers can inspect private read endpoints. Preview is part of the write workflow and requires owner/editor access.

Create claim, create draft and publish requests require `Idempotency-Key` with 16–128 characters. Retry uncertain outcomes with the same key and identical body. Reusing a key for different content returns a conflict. Draft edits and publication require `If-Match: "<draft version>"`; the version is independent of the live place revision.

Errors use `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Common workflow responses are 403 for a missing approved claim, 404 for inaccessible resources, 409 for an invalid workflow state or conflicting retry, 412 for a stale draft version, and 428 for missing `If-Match`. The caller should preserve unsaved edits and reload the server state after a conflict. Private API responses and previews are not publicly cacheable.

## Claim and workspace endpoints

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /places` | — | `{places:[{id,name,category,neighborhood,revision,claimState,claimID}]}` |
| `POST /claims` | `{placeID,evidence:{description,url?}}` plus idempotency key | 202 `{claim}` |
| `GET /claims/{claimID}` | — | `{claim}` |
| `GET /places/{placeID}` | — | `{place,claim,draft,latestPublication}`; last two may be null |

Evidence description is 30–4000 characters; optional URL is a bounded HTTP(S) URL. The API stores evidence for private operator inspection and does not fetch arbitrary evidence URLs. This first vertical has no document-upload or automatic ownership-verification service. Submitting text, knowing a place ID, or confirming rights never confers an approved claim. Only one claim can be approved for a place at a time.

`claim` is `{id,placeID,tenantID,state,submittedAt,reviewedAt,reviewReason}`. State is `submitted`, `approved`, `rejected`, `revoked` or `disputed`. Review fields may be null. Raw proof is omitted from merchant response DTOs; the isolated operator review queue contains it.

The workspace `place` is `{id,name,category,neighborhood,address,summary,tags,revision,city}`. The latest draft preserves the editable contact, hours and arrival fields. `latestPublication` lets a relaunched app recover a queued, live, failed or withdrawn outcome. A withdrawn place remains inspectable by its claimant tenant members while anonymous public routes continue to hide it. A still-approved merchant can prepare a corrected draft; a revoked or disputed claim must be reviewed before editing resumes.

This API claims **existing catalog branches**. Creating new branches, merging duplicates and establishing new city coverage remain operator/data-import work; there is no unimplemented self-service onboarding endpoint implied here.

## Edit, preview and publish

Let `P = /places/{placeID}`. The editable `profile` is:

```json
{
  "name": "The business's actual name",
  "category": "cafes",
  "neighborhood": "Jubilee Hills",
  "address": "The actual branch address",
  "summary": "Accurate, useful information supplied by the business.",
  "tags": ["Coffee"],
  "phone": null,
  "website": null,
  "hoursText": null,
  "entranceNote": null
}
```

Category is one of `cafes`, `food`, `art`, `heritage`, `nature`, `nightlife`, `shopping`, `wellness`. Name is 2–200 characters, neighborhood 2–180, address 5–600, summary 10–2000, and at most 15 tags of 1–60 characters. Optional/null contact fields have bounded lengths; websites must be HTTP(S) without embedded credentials. All-zero demonstration phone numbers are rejected. The profile schema rejects unknown fields. This publication version does not accept merchant media uploads, provider coordinates, ratings or independently verified entrance assertions.

| Method and path | Request and preconditions | Response |
| --- | --- | --- |
| `POST P/drafts` | `{basePlaceRevision,profile,rightsConfirmed}`; idempotency key; approved ownership | 201 `{draft}`, draft `ETag` |
| `GET P/drafts/{draftID}` | Member access | `{draft}`, `ETag` |
| `PATCH P/drafts/{draftID}` | `{profile,rightsConfirmed}`; exact `If-Match`; editable draft | `{draft}`, incremented `ETag` |
| `GET P/drafts/{draftID}/preview` | Approved ownership, owner/editor | Exact preview described below |
| `POST P/drafts/{draftID}/publish` | `{approval:true,previewDigest}`; `If-Match`; idempotency key | 202 `{publication}` |
| `GET P/publications/{publicationID}` | Member access | `{publication}` |

`draft` is `{id,placeID,tenantID,basePlaceRevision,version,state,profile,rightsConfirmed,updatedAt}`. State is `draft`, `queued` or `published`. A new draft starts at version 1. Each edit invalidates its earlier preview. A queued or published draft is immutable through the API; start a fresh draft against the current place revision to make another change. If the live place changed since a draft started, create a new draft after reconciling the changes.

Preview returns `{draftID,draftVersion,digest,html,publicURL,blockingIssues,expiresAt}`. The digest covers both the normalized snapshot and the exact escaped HTML. Preview authorization expires after 15 minutes. Display the human-readable page, disclose any blocking issues, and submit that exact digest only after the merchant approves. A changed draft, expired preview, missing rights confirmation or stale base place revision fails publication. Merely opening the preview never publishes anything.

`publication` is `{id,placeID,tenantID,draftID,draftVersion,revision,status,publicURL,digest,createdAt,publishedAt,error}`. Status is `queued`, `live`, `failed` or `withdrawn`; publication time and error may be null. `live` records an accomplished publication, while the current `public_pages` pointer determines the presently served version. A newer live revision can supersede an older historical publication. Do not label `queued` as live.

The queue and immutable publication are created in one PostgreSQL transaction. The separate worker locks a job, rechecks approved ownership, rights, draft version and base place revision, verifies the digest, and commits the public page and native catalog projection atomically. It preserves stable place IDs, source metadata and existing photo-rights metadata. Failures leave the previous public page intact; transient processing failures receive bounded retries, then a durable failure state. Place-level advisory locks keep operator review, draft commands and publication in a consistent order.

## Public website behavior

The server renders crawlable HTML without requiring the Swift or Kotlin app:

- `/hyderabad/places/{slug}` and `/mumbai/places/{slug}` serve the current published snapshot.
- City pages list published branches with pagination; an empty city page returns 404 rather than a fabricated inventory.
- `/sitemap.xml` includes live public pages and city collections with meaningful publication dates. This pilot has a 45,000-page limit; sitemap sharding is required before growing past it.
- `/robots.txt` exposes the sitemap and discourages private route crawling. Authentication, not robots directives, protects private data.
- `/discovery-methodology` explains evidence and limits without invented performance numbers.

Pages have a canonical URL, description, JSON-LD and safe escaping. Contact facts are optional. Free-form hours and arrival notes remain visibly owner supplied; they are not converted into verified `openingHours`, exact entrance coordinates or legal routing promises. Ownership approval does not independently verify all business facts. No reviews, ratings, live availability or photographic entrance proof are manufactured. This first public-page template publishes no venue images; source-preview photo metadata in the native research catalog is not a commercial image license.

The response includes ETag, Last-Modified and `X-Kulture-Page-Revision`. Conditional reads can return 304. `Cache-Control: public, max-age=0, must-revalidate` requires revalidation; Caddy is not configured as a CDN cache. Withdrawal removes the current page from public HTML, native public detail/list results and the sitemap. Already downloaded copies outside this system cannot be recalled.

## Discovery evidence

`GET /places/{placeID}/visibility` requires the current approved claim. It returns `{placeID,from,to,computedAt,coverage,metrics,notes}`. The window is the last 30 days, starting no earlier than the current approved claim review. `coverage` contains `status` (`unavailable`, `partial`, `complete`) and a reason. With no authenticated capture windows, `metrics` is empty: unavailable data is not presented as zero.

Each metric contains `{kind,value,definition,method,coverage}`:

| Kind | Counted evidence |
| --- | --- |
| `verified_search_html_fetch` | Verified search crawler, GET, status 200, HTML |
| `verified_training_html_fetch` | Verified training crawler, GET, status 200, HTML |
| `verified_user_html_fetch` | Verified user-triggered retrieval crawler, GET, status 200, HTML |
| `verified_search_revalidation` | Verified search crawler GET returning 304; separate from delivered HTML |
| `unverified_claimed_bot_html_fetch` | Claimed supported bot identity without matching source verification; GET, 200, HTML |

All exclude identified synthetic/health probes. HEAD requests are not HTML deliveries. A verified request is a fetch, **not** a unique visitor, index entry, recommendation, citation, referral, customer action or sale. These other channels are not connected and are not represented by zero-valued invented metrics.

Verification currently supports **OpenAI's three distinct crawler roles only**, matching both their User-Agent token and source IP against official ranges valid at observation time: [OAI-SearchBot ranges](https://openai.com/searchbot.json), [GPTBot ranges](https://openai.com/gptbot.json), [ChatGPT-User ranges](https://openai.com/chatgpt-user.json). Every successful refresh appends a separate immutable rule snapshot with its source URL, checksum and validity window, even if the ranges have not changed. Delayed logs can use the original historical proof window; a subsequent refresh cannot retrospectively verify a gap after earlier evidence expired. Missing or nonmatching evidence cannot produce a verified count. Other providers remain unverified/unknown until their own supported verification adapters are implemented.

The dedicated worker reads Caddy's public-branch-page JSON log from a read-only volume. The collector uses a durable device/inode/byte cursor, deduplicated request IDs and idempotent batches; interruption between ingest and cursor advance safely replays. It handles appended lines and file rotation. All current file-collector batches are honestly **partial** because missing rotation tails and complete capture cannot be proven. A future complete-coverage adapter must establish every interval before reporting complete coverage.

Only Caddy's direct peer address is trusted. This deployment must terminate public HTTPS directly at Caddy. Adding a CDN or another proxy requires a reviewed trusted-origin adapter; forwarded headers alone must never verify a provider. The worker checks official rules for refresh hourly and normally fetches daily, with a 48-hour validity window. Failure does not block publication or manufacture verification.

Database observations contain an HMAC of the IP scoped to its observation day, not raw IPs; URL queries and original User-Agent strings are not stored in the observation table. Caddy logs are limited to exact public place paths, strip query strings and listed authentication/cookie/referrer headers, and remain private to the host/worker. Raw log files still contain request metadata, including peer IP; restrict host access accordingly. Size-based rotation retains at most seven rolled files and applies a 168-hour retention setting to rolled files. This does **not** guarantee deletion of a low-volume active file within seven days. Database observations and coverage batches are purged after 35 days; old rule snapshots are removed when unreferenced and sufficiently expired.

## Private operator workflow

The public API process has no worker credential. Caddy blocks `/v1/ops/*` and `/internal/*`; `requireOps` additionally requires the internal-service flag and operator token. The private ops container has no public port. Its helper reads its token from the environment rather than placing it in the command line:

```sh
docker compose --profile ops up -d ops
docker compose exec ops node ops/operator.mjs GET /v1/ops/claims
docker compose exec ops node ops/operator.mjs POST /v1/ops/claims/CLAIM_UUID/review '{"decision":"approved","reason":"Describe the actual evidence and review performed."}'
docker compose exec ops node ops/operator.mjs POST /v1/ops/publications/PUBLICATION_UUID/withdraw '{"reason":"Describe the correction or safety concern requiring withdrawal."}'
```

Replace IDs and review text with real values. Claim decisions can also be `rejected`, `revoked` or `disputed`; nonapproved decisions withdraw that tenant's publications for the place. Approval is a human operational responsibility, not an invitation to approve a placeholder claim. Actions write audit events. There is no automatic proof-verification or public operator login hidden in this workflow.

The isolated internal service also exposes authenticated `/internal/telemetry/refresh-rules` and `/internal/telemetry/edge-batches` for controlled administration. Ordinary operation uses the worker collector, not client-submitted counters. Native apps and public users cannot submit crawler observations. The current operator helper intentionally accepts only `/v1/ops/` paths.

## Verified scope and remaining integrations

The automated tests exercise actual PostgreSQL tenant isolation, signed account sessions, claim review, stale versions, exact-preview publication, retry deduplication, escaping, withdrawal/recovery and log ingestion. Telemetry checks distinguish GET/HEAD/304/synthetic requests, reject spoofed source claims, preserve tenant isolation, and test replay plus file rotation. See the repository's verification record for the final run; these checks do not assert that an unspecified VPS is already deployed.

External business-directory connections, Google Business Profile, Apple Business Connect, Bing/IndexNow submission, third-party backlink placement, search-console reports, AI citation experiments and attribution/conversion integrations are not implemented by this API. It publishes useful, accessible first-party pages and records supported fetch evidence. It cannot require an external bot to crawl, guarantee a million crawls, guarantee indexing, or sell an undisclosed preferred position in an external AI answer.
