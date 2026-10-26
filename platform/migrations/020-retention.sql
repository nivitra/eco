-- Private retention only. Journal rows have no FK so restored old objects can be suppressed again.
CREATE TABLE retention_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 place_id text REFERENCES places, entity_type text CHECK(entity_type IN ('claim_proof','merchant_draft','media_asset')),
 entity_id uuid, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
 released_at timestamptz, released_by text, release_reason text,
 CHECK((entity_type IS NULL)=(entity_id IS NULL))
);
CREATE INDEX retention_holds_active ON retention_holds(tenant_id,place_id) WHERE released_at IS NULL;
CREATE TABLE retention_location_clocks (
 tenant_id uuid NOT NULL REFERENCES tenants, place_id text NOT NULL REFERENCES places,
 paused_at timestamptz, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,place_id)
);
CREATE TABLE retention_tombstones (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, place_id text NOT NULL, entity_type text NOT NULL CHECK(entity_type IN ('claim_proof','merchant_draft','media_asset')),
 entity_id uuid NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL,
 object_keys jsonb NOT NULL DEFAULT '[]', files_deleted_at timestamptz,
 UNIQUE(entity_type,entity_id), CHECK(jsonb_typeof(object_keys)='array')
);
ALTER TABLE merchant_claims ADD COLUMN evidence_deleted_at timestamptz;
ALTER TABLE media_assets ADD COLUMN retention_deleted_at timestamptz;
ALTER TABLE retention_holds ENABLE ROW LEVEL SECURITY; ALTER TABLE retention_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_location_clocks ENABLE ROW LEVEL SECURITY; ALTER TABLE retention_location_clocks FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_tombstones ENABLE ROW LEVEL SECURITY; ALTER TABLE retention_tombstones FORCE ROW LEVEL SECURITY;
-- No app policies: only the private operator and deletion worker can inspect or mutate this ledger.
