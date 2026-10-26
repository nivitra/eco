-- Public ODbL observations stay distinct from owned place identity and private plans.
CREATE TABLE place_map_points (
  place_id text PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload->>'placeID' = place_id),
  CHECK (payload->>'sourceName' = 'OpenStreetMap'),
  CHECK (payload->>'osmType' IN ('node','way','relation'))
);
ALTER TABLE place_map_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE place_map_points FORCE ROW LEVEL SECURITY;
CREATE POLICY public_map_point_read ON place_map_points FOR SELECT USING (true);
-- Runtime has no insert/update/delete policy: only the seed/import worker may write.
CREATE TABLE entrances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id text NOT NULL REFERENCES places(id),
  point geography(Point,4326) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('pedestrian','vehicle','dropoff','parking','accessible')),
  modes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','verified','stale','blocked')),
  evidence jsonb NOT NULL DEFAULT '{}',
  verified_at timestamptz,
  valid_until timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK(status <> 'verified' OR (verified_at IS NOT NULL AND valid_until > verified_at))
);
ALTER TABLE entrances ENABLE ROW LEVEL SECURITY;
ALTER TABLE entrances FORCE ROW LEVEL SECURITY;
CREATE POLICY public_current_entrance_read ON entrances FOR SELECT
  USING(status='verified' AND valid_until > now());
-- There is deliberately no invented entrance seed or client write policy.
CREATE INDEX entrances_place ON entrances(place_id);
