-- Public directory observations remain approximate POIs, never entrance evidence.
-- Existing source types stay compatible; no historical map points are rewritten.
ALTER TABLE place_map_points DROP CONSTRAINT place_map_points_supported_source;
ALTER TABLE place_map_points ADD CONSTRAINT place_map_points_supported_source CHECK ((
  (payload->>'sourceName' = 'OpenStreetMap' AND payload->>'osmType' IN ('node','way','relation'))
  OR
  (payload->>'sourceName' = 'Wikidata'
    AND payload->>'wikidataID' ~ '^Q[1-9][0-9]*$'
    AND payload->>'sourceURL' = 'https://www.wikidata.org/wiki/' || (payload->>'wikidataID')
    AND payload->>'coordinateKind' IN ('poi','coordinate_location')
    AND payload->'entranceVerified' = 'false'::jsonb
    AND jsonb_typeof(payload->'latitude') = 'number' AND jsonb_typeof(payload->'longitude') = 'number'
    AND (payload->>'latitude')::numeric BETWEEN 17.15 AND 17.75 AND (payload->>'longitude')::numeric BETWEEN 78.10 AND 78.80)
  OR
  (payload->>'coordinateKind' = 'poi' AND payload->'entranceVerified' = 'false'::jsonb
    AND jsonb_typeof(payload->'latitude') = 'number' AND jsonb_typeof(payload->'longitude') = 'number'
    AND (payload->>'latitude')::numeric BETWEEN 17.15 AND 17.75 AND (payload->>'longitude')::numeric BETWEEN 78.10 AND 78.80
    AND payload->'coordinateProvenance'->>'sourceURL' = payload->>'sourceURL'
    AND payload->'coordinateProvenance'->'entranceVerified' = 'false'::jsonb
    AND payload->'coordinateProvenance'->'independentlyVerified' = 'false'::jsonb
    AND jsonb_typeof(payload->'coordinateProvenance'->'retrievedAt') = 'string'
    AND (
      (payload->>'sourceName'='EazyDiner'
        AND payload->>'sourceURL' ~ '^https://www\.eazydiner\.com/(hyderabad|kokapet)/[a-z0-9-]+-[1-9][0-9]*$'
        AND payload->'coordinateProvenance'->>'method'='published_JSON-LD')
      OR
      (payload->>'sourceName'='Playo'
        AND payload->>'sourceURL' ~ '^https://playo\.co/venues/[A-Za-z0-9_@().-]+/[A-Za-z0-9_@().-]+$'
        AND payload->'coordinateProvenance'->>'method'='public_venue_data')
    ))
) IS TRUE);
