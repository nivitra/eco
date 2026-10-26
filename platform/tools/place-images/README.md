# Place photo ingestion

`collect.py` uses `hooli/google-images-scraper` on Apify. Its inputs are the
canonical `data/independent-places.json` and `data/research-places.json` records,
joined by stable place ID. It does not rename places or change their locations.

Data flow:

1. Plan missing-photo queries using business name, neighborhood and Hyderabad.
2. Collect at most three results per query into a resumable run ledger and raw datasets.
3. Match the business and locality; reject conflicting branches, non-photo
   results, private URLs and Google search thumbnails.
4. Fetch original publisher images with bounded size, raster decoding,
   dimensions, hashes and duplicate checks. Keep rejected candidates for review.
5. Write `data/place-images.json` with the original image and publisher page,
   matching evidence and collection provenance.
6. `src/place-images.ts` validates the feed and enriches the API's `mobilePlace`
   projection only when an existing photo is absent. Docker includes this feed.
7. The native catalogue builder projects that same feed into Edit 3. Ask renders
   cached photos and offers a separate publisher link on each photo card.

## Commands

Run from `platform/`, using Python 3.9+ with Pillow installed:

```sh
python3 tools/place-images/collect.py plan
APIFY_TOKEN_FILE=/absolute/private/token-file python3 tools/place-images/collect.py collect --budget 12 --batch-size 400 --parallel 2
python3 tools/place-images/collect.py process --workers 12
python3 ../native/tools/build-city-catalog.py --target edit3
python3 -m unittest discover -s tools/place-images -p 'test_*.py'
node --import tsx --test tests/place-images.test.ts tests/consumer.test.ts
npm run check
```

The default working directory is the workspace's
`work/google-images-2026-10-24/`. Raw datasets, download evidence, run status,
review exclusions and QA images stay there. No Apify credential belongs in the
feed, source control, API response or native bundle. Supply `APIFY_TOKEN` or a
private token file. The local default file is under ignored `work/private/`.

`--budget` is a cumulative cap across the ledger, including previous accounts
and runs. It reserves the full maximum price before starting another batch.
Interrupted/limited runs mark only returned queries complete; completed queries
are not billed again on resume. A locked dataset stops collection and is retried
after that account receives credits. Changing accounts cannot unlock it.

`--target edit3` preserves the isolated Edit 3 catalogue's order and all non-image
fields, and retains its existing curated photos. It refuses an identity migration.
The default `package` target is separate and is not used for this Edit 3 task.
An older API without the photo feed cannot erase bundled source previews from
Edit 3 during refresh; a current server photo takes precedence.

## Review and provenance

Search results are recorded as `source-preview`, with `reusePermission: unverified`.
They are not added to the separately licensed `publicImages` collection. The
app links to the publisher and uses its original URL; this job does not publish
downloaded images to a hosting service. Availability and usage rights can change.

The collector validates downloadability and matching evidence. It does not claim
that every scene has been manually verified. Local contact sheets and optional
Apple Vision OCR (`review.swift`) support review; rejected hashes go in
`photo-reviews.json` and survive reprocessing. Feed records retain run/dataset IDs,
timestamps, dimensions and content hashes for later replacement or removal.

## 2026-10-24 outcome

Downloaded 2,449 search results, validated 1,409 candidates and selected 689 new
place photos. Together with the 52 existing photos, 741 of 1,188 places have an
image. 447 remain without an accepted image. Actual recorded Apify charge:
$8.7892 of the $12 cumulative cap.

Both supplied accounts reached their usage limits. The current account's final
dataset is locked (HTTP 402), with 153 results reported by the run but not yet
retrieved. No actor run remains active. There are 317 uncompleted queries in the
plan, including queries whose results are locked. Resume with credits on the
current account to retrieve those results before starting another scrape.

This change wires the local API and builds/installs Edit 3 in KulturePerf. The
latest build was also signed, installed and launched on the connected iPhone,
including the Save to Kulture extension. It does not deploy the production API.
