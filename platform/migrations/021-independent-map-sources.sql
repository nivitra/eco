-- Add a source-specific CC0 Wikidata observation path without changing old OSM
-- observations, public-read RLS, entrance verification or merchant ownership.
ALTER TABLE place_map_points DROP CONSTRAINT place_map_points_payload_check;
ALTER TABLE place_map_points DROP CONSTRAINT place_map_points_payload_check1;
ALTER TABLE place_map_points ADD CONSTRAINT place_map_points_supported_source CHECK ((
  (payload->>'sourceName' = 'OpenStreetMap' AND payload->>'osmType' IN ('node','way','relation'))
  OR
  (payload->>'sourceName' = 'Wikidata'
    AND payload->>'wikidataID' ~ '^Q[1-9][0-9]*$'
    AND payload->>'sourceURL' = 'https://www.wikidata.org/wiki/' || (payload->>'wikidataID')
    AND payload->>'coordinateKind' IN ('poi','coordinate_location')
    AND payload->'entranceVerified' = 'false'::jsonb
    AND jsonb_typeof(payload->'latitude') = 'number'
    AND jsonb_typeof(payload->'longitude') = 'number'
    AND (payload->>'latitude')::numeric BETWEEN 17.15 AND 17.75
    AND (payload->>'longitude')::numeric BETWEEN 78.10 AND 78.80)
) IS TRUE);
