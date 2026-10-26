# Kokapet and Jubilee Hills discovery import

The 2026-10-01 run fetched **244 OpenStreetMap features** in two fixed rectangles and reviewed them before merging. The catalog now contains **150 places**, including the original 37 IDs, with **121 sourced feature points**. Additions include 60 healthcare entries, 27 cafes, 15 parks, 5 water/nature places, 4 community places and 2 stationery branches. Healthcare includes hospitals, clinics, pharmacies and blood banks; it is not a count of 60 hospitals.

**25 records have images; 125 do not.** The new image pass adds a licensed Kokapet Lake photo, replaces KBR's image with a licensed Commons photo, and adds five remote official previews: four healthcare premises and the Epistles bookstore. Original image fields are preserved. A public image URL does not establish reuse permission.

## Reproduce the reviewed result

Run from `platform/`:

```sh
node --import tsx scripts/discover-city-places.ts \
  --endpoint https://overpass-api.de/api/interpreter \
  --acknowledge-api-policy \
  --cache-dir data/discovery/cache \
  --output-dir data/discovery/review \
  --review-rules data/discovery/review-rules.json \
  --images data/discovery/image-manifest.json \
  --allow-official-previews
```

The command uses the committed cached extracts and writes review output. Add `--apply` to merge into `data/places.json`, `data/map-points.json` and the native `jubilee-places.json` resource. A second application produces no duplicate records. Add `--refresh` to request fresh extracts, then inspect the review before applying; freshness of OSM data is not independent verification that a business still operates.

The importer has **no database access**. Deployment uses the separate seed command, whose merchant/claim protection must remain in place. Removing or correcting an already deployed record requires the operational correction/withdrawal workflow; this tool does not silently delete database records.

## Source and policy evidence

- `cache/*.extract.json` contains the exact query, response, retrieval time, source timestamp, query digest and robots response. The source snapshot is 2026-10-01 14:31:06 UTC; retrieval completed at 14:33 UTC.
- `review-rules.json` records 15 explicit exclusions and 29 neighboring-locality labels, plus one official Apollo profile correction and six manually reviewed official-site additions. The merge also holds a same-name nearby park for duplicate review.
- `initial-import-report.json` preserves the original 113-addition audit. `review/report.json` describes the latest run, so its `added` value is zero on a repeat application.
- `image-manifest.json` records exact place bindings, source pages, authors/credits, licences or the explicit unknown reuse status of official previews. All five new official previews were visually inspected: Apollo Cradle exterior, UniCare reception, Curo exterior, Medicover Financial District exterior and the Epistles bookstore interior. Medicover is explicitly labelled outside Kokapet; its photograph does not verify current operation or construction status. Remote links can change or disappear.

The fixed rectangles are Kokapet `[17.375,78.315,17.419,78.363]` and Jubilee Hills `[17.411,78.388,17.449,78.429]`, ordered south, west, north, east. They are search areas, **not verified neighborhood boundaries**. Adjacent localities are labelled when supported by the source. Some features retain boundary uncertainty. Unnamed entries, inaccessible gathering spaces, conflicting address/point records and uncertain duplicates are withheld. There are no invented addresses, hours, ratings, availability, medical quality claims or entrance surveys.

The importer identifies itself, runs requests serially with at least 2.1 seconds between requests, caps responses at 5 MB and stops on HTTP errors or incomplete Overpass results. It does not rotate hosts after throttling. No live application request uses this public service. Private.coffee timed out during this run and the old VK endpoint was unavailable; the successful run used the documented official API. The explicit policy flag records developer API permission separately from the website's `/api/` crawl exclusion. Ordinary website downloads remain subject to their robots rules. See the [official Overpass resource policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html); a production refresh service at scale needs a suitable hosted or paid data source.

## Data and image rights

OSM-derived records and map points are available under **ODbL-1.0**, credited to **© OpenStreetMap contributors**. Their source URLs and provenance remain attached. Display that attribution with a link to [OpenStreetMap copyright](https://www.openstreetmap.org/copyright), and retain the [ODbL licence](https://opendatacommons.org/licenses/odbl/1-0/) when distributing this derived data.

The two added Commons bindings use **CC BY-SA 4.0** with exact file pages and author credit. Official previews are explicitly `official-public-preview`, `reusePermission: unknown`, remote links only. They are not licensed assets and are not rehosted by this import. Existing directory/editorial preview rights are likewise not upgraded. [Commons reuse guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia) explains why file-specific attribution and licence checks matter.

This is a sourced, partial discovery catalog. It is not an exhaustive inventory of either neighborhood. Source photos, stationery coverage in Jubilee Hills proper, current operation, public access and exact arrival points remain incomplete.
