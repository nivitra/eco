# Portable location archive

`GET /v1/tenants/{tenantID}/places/{placeID}/export/archive`

Requires a valid user session and an active workspace **owner or manager** role. Managers must have the selected location in their assigned scope. Export remains available without a paid plan or pilot. It does not grant ownership of a shared building. Existing `/export` JSON remains available.

Successful responses return `200`, `Content-Type: application/x-tar`, an attachment filename, an exact `Content-Length`, and `Cache-Control: private, no-store`. Use a streaming download or native download task rather than decoding this response as JSON. A browser may save the downloaded Blob. The archive opens with standard tar tools or macOS Archive Utility.

Contents:

- `facts.json`: current location facts and latest editable business profile, explicitly distinguished.
- `publications/{id}.json` and `.html`: publication history, status, timestamps, snapshot and exact approved HTML.
- `websites/{deliveryID}.json` and `.html`: applied destination history, public canonical/schema metadata, and exact website HTML. Synthetic verification is not a crawl or citation.
- `destinations.json`: public destination identity, kind, state and URLs. Pairing secrets, site credentials and signed machine envelopes are excluded.
- `media/{assetID}.webp` plus `media/index.json`: actual derivative bytes for this location's ready, reviewed, public-use-approved media whose permission remains current. The index includes SHA-256, alt text, dimensions and rights basis/holder/expiry, but no private permission note or original-storage key. Export does not expand a licence.
- `arrival/{releaseID}.json`: published graph history only when both the building owner and graph owner are this workspace and the graph was authored for this location. Editing grants to someone else's building do not qualify. These are historical records, including withdrawn/expired releases, **not live navigation instructions**. Missing or revoked media remain graph references and are listed as unavailable; their binaries are excluded. The recorded original publication digest is historical and is not relabelled as a checksum of a transformed export.
- `manifest.json`: exported timestamp, location identity, counts, exclusions, exact path/byte length/SHA-256 for every payload file except the manifest itself.

HTML bytes retain their original canonical URLs and external resource links. They are source material for a migration, not a claim that extracting the archive transfers DNS, activates another host, or restores current access permissions. Private originals, claim documents, private map review evidence, unpublished arrival drafts and other owners' shared-building content are excluded.

The facts/history query uses a repeatable-read snapshot. Media permissions and scope are checked again before each derivative is loaded. Files are sent with backpressure, in 64 KiB chunks, loading at most one bounded derivative at a time. Cancellation prevents later loads. Size and SHA-256 mismatches, revoked rights or a missing image abort the connection; clients must discard a failed or incomplete download and retry. Check `Content-Length` and the manifest after download. An audit event records preparation, not a claim that the client saved the file.

Limits: four requests per user per hour; 1,000 rows per history section; 16 MiB of generated text/metadata, with an earlier 8 MiB raw-row budget; 100 derivatives; 5 MiB per derivative; 270 MiB for the complete tar. An oversized request returns `413 export_too_large` before download and directs the owner to assisted export. No history is silently truncated. Ordinary ownership/scope errors return 403/404; missing media returns `409 export_media_unavailable` before streaming where detected.

Validation: system-tar extraction preserves Unicode and binary content; unsafe paths, duplicate entries, archive limits, corrupt bytes and cancellation are tested. A real PostgreSQL test covers unpaid export, tenant/manager/editor scope, publication and applied-website HTML, real processed-format WebP bytes, graph ownership, revoked/expired/unapproved media, private-field exclusion, manifest checksums, revocation during transfer and oversized history.
