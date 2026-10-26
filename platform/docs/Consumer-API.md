# Native consumer API

Kulture owns stable place identities, saved IDs and plan IDs. The 10 October 2026 release has 1,189 public records (including the labelled fictional Amul demonstration), all 1,000 reviewed research IDs, and 1,132 source-backed approximate map points. No OSM overlays remain in that live catalogue. Unmapped records remain cards; source coordinates do not establish verified entrances.

- `GET /v1/catalog`: public `{version,places,mapPoints,coverage}`, strong `ETag`, conditional `If-None-Match` → 304. Public inventory cap 2,000; `coverage.truncated` reports incomplete snapshots. This is a sourced collection, not a complete-city inventory. Public `mapPoints` retain their source IDs, dates and applicable attribution. Native apps currently refresh full snapshots and retain local fallback.
- `GET /v1/places?q=&category=&lat=&lon=&radius=`: public, at most 50. Latitude/longitude together; 100–10,000m radius. Distance is straight-line to a feature, never route/arrival distance.
- `GET /v1/places/:id`: native card plus current verified entrances (empty until real evidence exists).
- `GET /v1/profile`: account session, `{revision,profile}`, ETag `"profile:1"`.
- `PUT /v1/profile`: bare profile or `{profile:...}`, exact `If-Match`. Missing precondition 428, stale 412. Saved IDs ≤1000; outings ≤100, ≤8 stops each. Unrecognized place IDs fail 422 instead of silently dropping them. Cloud profiles are private under forced RLS.
- `POST /v1/ai/chat`: account session and persisted quotas. Body `{messages:[{role:"user"|"assistant",content}],taste:{interests,pace,avoidBars},scope:"jubilee_hills"|"kokapet"|"hyderabad",savedIDs?,discovery?,planning?}`. At most 7 messages, 2000 characters each; last message user. No client system prompts. Server credentials never enter native apps. Server chooses eligible ranked catalog; validates reply IDs, lengths and complete JSON before returning OpenAI-compatible SSE events. It intentionally buffers the upstream answer before emitting it; this is not token-by-token upstream streaming. Unsupported IDs fail safely. AI prose can still be wrong; sources and caution remain necessary.
- `POST /v1/routes`: authenticated `{origin:{latitude,longitude},destinationPlaceID,mode:"driving"|"walking"}`. Requires configured operated/contracted routing gateway; the shared server refuses the public FOSSGIS demo host. Response includes `distanceMetres,durationSeconds,geometry:{type:"LineString",coordinates:[[lon,lat],...]},traffic:false,verifiedEntrance:false,computedAt,expiresAt,warning`. Area/building/lake centers fail with arrival confirmation required. POI nodes only support an explicitly unverified preview. Never persist the precise origin. Service uses `/routed-car/route/v1/driving/` and `/routed-foot/route/v1/driving/` prefixes, which the configured gateway must expose.
- `POST /v1/recommendations`: public, optionally personalized with authenticated feedback. `{intent,scope,taste,savedIDs?,limit<=20,category?,positiveTags?,negativeTags?,excludedCategories?,requireVerifiedOpen?,origin?}`. Returns versioned rules, ranked `results` with IDs, score/reasons/cautions, and typed exclusion audit. A supplied origin affects only measured straight-line distance; none is inferred.
- `GET /v1/feedback`: private explicit likes/dismissals. `POST /v1/feedback {placeID,kind:"liked"|"dismissed"|"clear"}` updates/removes one choice. Feedback has separate forced RLS and remains separate from the profile.

The earlier Android client opens configuration from Explore → Info → Server & account. HTTPS is required, with individual signed-session tokens encrypted by an Android Keystore AES-GCM key. Sign-in restores the account's device profile and only inspects the cloud revision and record counts; it never replaces unsynced device changes. Check cloud also inspects without replacement, including after a conflict. Load cloud explicitly replaces that account's current device profile; Upload changes replaces the inspected cloud revision and preserves newer local edits. Conflict messages keep local changes intact. Sign-out returns to guest profile. Local catalog and deterministic matching remain usable when disconnected. Production builds no longer read or embed the private development provider key. The previous private-testing APK is a separate old deliverable and must not be treated as the newly built app.

The public preview photo metadata does not confer commercial image rights. Seed images remain remotely credited source previews, not owned assets; field/merchant operations must establish and track permitted commercial use before broad production distribution. Likewise, a successful map rendering or source-coordinate match does not certify a correct entrance.


## Explicit discovery and staged outings

`discovery` is optional: `{goal:"discover"|"outing"|"service",categoryID?,query?,savedOnly:false,selectedPlaceIDs?}`. The 29 source-tag category IDs are defined in `ai-discovery.ts`. Query length is at most 160 characters; `selectedPlaceIDs`, when present, contains 1–8 unique nonempty IDs and is a hard intersection, independent from saved IDs used as taste signals. Empty categories stay empty. An outing stage cannot turn a care/service listing into leisure.

`planning` is additive and optional:

```json
{
  "stages": [
    {"id":"coffee","categoryID":"cafes"},
    {"id":"walk","categoryID":"parks","scope":"jubilee_hills"}
  ],
  "company":"friends",
  "budgetPerPersonINR":1000,
  "durationMinutes":120,
  "selectionMode":"nearby",
  "note":"No bars"
}
```

Use 2–4 stages with unique IDs up to 40 characters and explicit leisure categories. An optional stage scope narrows the effective global area. Company defaults to `any` and also accepts `solo`, `friends`, `date`, `family`. Budget is an integer from 1 to 100,000; duration from 15 to 1,440 minutes; note at most 500 characters. These are preferences, not verified costs, schedules or suitability. The note is an explicit user constraint and applies on follow-ups until edited.

For individual-stop refinement, a stage may contain `pinnedPlaceID` and `excludedPlaceIDs`. A pin is a trimmed nonempty catalogue ID, up to 160 characters, unique across stages. Exclusions are stage-local, with zero to twelve unique IDs of the same shape. A pin excluded on its own stage is invalid. Eligible pins remain exact; a missing or ineligible pin produces an explicit unmatched stage rather than a substitute. Pins still obey source, category, locality, saved-selection and factual constraints, and cannot be consumed by another stage. Removing a pin and adding its former ID to that stage's exclusions requests a replacement while other pins remain fixed.

The server ranks bounded candidates per stage, then assigns distinct venue IDs for maximum coverage before rank cost. It attaches `plan:{stages:[{id,categoryID,placeID:string|null,reason}],checks:[string],status:"complete"|"partial"|"empty"}` to the existing reply. Order and identities match the request. `complete` means every activity has a distinct source-backed match, **not** that hours, costs, access, traffic or entrances are verified. Missing stages remain `null`. Flat recommendations contain the same matched IDs in order. The model describes the server-owned draft; provider failure can return the validated deterministic draft. Authentication, private/no-store responses, quotas, SSE `stop` and `[DONE]` still apply.

`selectionMode` defaults to `nearby`; `relevance` retains the preference-ranked assignment. Nearby selection compares at most twelve candidates per stage using published, provenance-checked coordinates. It preserves coverage, stage order, distinct IDs, hard filters, pins and explicitly named baseline places. It allows at most three raw ranking points of loss per stage and four overall. A measured alternative must improve the straight-line total by at least 500 metres after a rank-position penalty. When the original draft has unknown geography, a fully mapped alternative is considered only if every adjacent leg is at most 8 km. These are transparent editorial policy limits, not learned or field-validated routing guarantees.

Nearby replies add optional `proximity:{state:"grouped"|"retained"|"unavailable",straightLineMetres?,knownLegCount,unknownLegCount,summary}`. Counts cover every requested adjacent pair; any missing place or position prevents a complete total. Native validation rejects contradictory coverage. This compares approximate feature positions, not entrances, paths, travel time, walkability or arrival side. Saved plans offer a separate explicit Mapbox driving/walking estimate. Relevance-mode replies and older servers may omit proximity.

Parks use exact source category/tag evidence. Urban, eco and national parks qualify; specialist zoo, water-park, amusement-park and memorial-garden tags override a broad imported `parks` category. Free-form park/walk requests also reject those substitutes unless the current topic explicitly requests that specialist type or sourced place name. Other activities in a mixed request remain eligible. An explicit Parks directory or stage keeps its category boundary even for a named specialist. A subtype label does not verify access, hours or facilities.

A profile outing can include `brief` with that same planning shape. Existing outings without a brief remain valid. On a version-matched profile update, omission preserves the stored brief for that outing ID; explicit `null` clears it, and removing the outing removes it. The merge runs after locking the account row and checking its revision. This allows older native clients to reorder existing plans without silently deleting new brief data.

Omitting the whole brief differs from explicitly replacing it: an older client that sends a new brief without the optional pin/exclusion fields replaces those fields under the existing full-replacement semantics, and omission of `selectionMode` normalizes to `nearby`. A rollback to a server predating these fields may reject later profile writes containing them. Prefer forward repair once clients have saved the new shape.


## Unlisted outing links

- `POST /v1/outing-shares` (authenticated): strict `{requestID, title, placeIDs}`. Use a canonical lowercase UUIDv4 request ID, a 1–120 character title and 1–8 distinct stable catalogue IDs. Returns 201 `{share, url}`. Replaying the same active request returns its original link; different content returns 409 `idempotency_conflict`, and a revoked/expired request returns 409 `share_unavailable`.
- `GET /v1/outing-shares` (authenticated): owner-only `{shares}`, at most 100, active first.
- `DELETE /v1/outing-shares/:id` (authenticated): owner-only, idempotent `{revoked:true}`. A different owner gets the same 404 as an unknown ID.
- `GET /v1/outing-shares/:id` (public capability): `{share:{version:1,id,title,createdAt,expiresAt,stops:[{placeID,place}]}}`. Each place is the current whitelisted public catalogue projection. A withdrawn, closed or ineligible stop is `null`, keeping its ordered ID. Invalid, unknown, expired and revoked capabilities return uniform 404.
- `GET /outings/:id`: responsive HTML preview, or a generic unavailable page with HTTP 404.

Creation accepts current source-backed leisure places and excludes demonstration, OpenStreetMap, care/service and closed records. Title and ordered IDs are immutable. Links expire after 30 days; there are at most 20 active links per account. Creation is limited to 30 requests/hour/account, owner reads and revokes to 60/minute/account each, and anonymous reads to 120/minute/hashed proxy IP. Retries consume request quota but never create another link for the same request ID.

Private notes, briefs, visit progress, preferences and author identity are not accepted or projected. Responses carry `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, nosnippet` and a CSP forbidding external assets. Capability paths are redacted in application request logs and excluded from proxy access logs. These are bearer links: no recipient account or membership check is claimed. Revocation cannot remove a copy already saved by a recipient.

Migration `023-outing-shares.sql` creates the table, forced row-level policies, immutable snapshot trigger and runtime grants. Application rollback must retain this additive schema, migration ledger and existing share rows; the old application image cannot serve these routes until a compatible forward release is restored.
