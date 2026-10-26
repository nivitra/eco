-- Merchant workflow. Private rows require a verified app.actor_id and active membership.
CREATE TABLE merchant_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  place_id text NOT NULL REFERENCES places(id), submitted_by text NOT NULL,
  evidence jsonb NOT NULL, state text NOT NULL DEFAULT 'submitted'
    CHECK(state IN ('submitted','approved','rejected','revoked','disputed')),
  submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
  review_reason text, CHECK(state <> 'approved' OR reviewed_at IS NOT NULL),
  UNIQUE(tenant_id,place_id,id)
);
CREATE UNIQUE INDEX merchant_one_approved_claim ON merchant_claims(place_id) WHERE state='approved';
CREATE INDEX merchant_claim_tenant ON merchant_claims(tenant_id,submitted_at DESC);
CREATE TABLE merchant_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  place_id text NOT NULL REFERENCES places(id), claim_id uuid NOT NULL,
  base_place_revision integer NOT NULL CHECK(base_place_revision>0), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','queued','published')),
  profile jsonb NOT NULL, rights_confirmed boolean NOT NULL DEFAULT false,
  preview_digest text, preview_expires_at timestamptz,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,place_id,claim_id) REFERENCES merchant_claims(tenant_id,place_id,id),
  UNIQUE(tenant_id,place_id,id)
);
CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  place_id text NOT NULL REFERENCES places(id), draft_id uuid NOT NULL, draft_version integer NOT NULL,
  revision integer NOT NULL, snapshot jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  html text NOT NULL, canonical_path text NOT NULL, status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','live','failed','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, error text,
  FOREIGN KEY(tenant_id,place_id,draft_id) REFERENCES merchant_drafts(tenant_id,place_id,id),
  UNIQUE(draft_id,draft_version)
);
CREATE TABLE publication_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), publication_id uuid NOT NULL UNIQUE REFERENCES publications(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_jobs_ready ON publication_jobs(next_attempt_at) WHERE state IN ('queued','running');
-- Separate allowlisted serving projection; no ownership evidence or tenant IDs.
CREATE TABLE public_pages (
  place_id text PRIMARY KEY REFERENCES places(id), publication_id uuid NOT NULL REFERENCES publications(id),
  canonical_path text UNIQUE NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
  html text NOT NULL, digest text NOT NULL, published_at timestamptz NOT NULL, withdrawn_at timestamptz
);
CREATE TABLE crawler_rule_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, role text NOT NULL CHECK(role IN ('search','training','user_fetch')),
  user_agent_token text NOT NULL, source_url text NOT NULL, ranges jsonb NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  UNIQUE(provider,role,checksum), CHECK(expires_at>fetched_at)
);
CREATE TABLE edge_ingest_batches (
  source text NOT NULL, batch_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, coverage text NOT NULL CHECK(coverage IN ('partial','complete')),
  expected_records integer NOT NULL, body_hash text NOT NULL, PRIMARY KEY(source,batch_id), CHECK(window_end>window_start)
);
CREATE TABLE crawler_events (
  source text NOT NULL, request_id text NOT NULL, observed_at timestamptz NOT NULL,
  place_id text REFERENCES places(id), publication_id uuid REFERENCES publications(id),
  canonical_path text NOT NULL, method text NOT NULL, status integer NOT NULL, content_type text NOT NULL,
  provider text, role text, verification text NOT NULL CHECK(verification IN ('verified','claimed','unknown')),
  rule_snapshot_id uuid REFERENCES crawler_rule_snapshots(id), rule_checksum text,
  ip_hash text NOT NULL, synthetic boolean NOT NULL, cache_status text,
  PRIMARY KEY(source,request_id)
);
CREATE INDEX crawler_events_place_date ON crawler_events(place_id,observed_at);
CREATE TABLE telemetry_cursors(source text PRIMARY KEY,device text NOT NULL,inode text NOT NULL,byte_offset bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
-- Caller has no direct write grants through policy; authenticated commands use tenant scope.
ALTER TABLE merchant_claims ENABLE ROW LEVEL SECURITY; ALTER TABLE merchant_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_claim_read ON merchant_claims FOR SELECT USING(can_access_tenant(tenant_id,false));
CREATE POLICY merchant_claim_create ON merchant_claims FOR INSERT WITH CHECK(can_access_tenant(tenant_id,true) AND submitted_by=current_setting('app.actor_id',true) AND state='submitted');
ALTER TABLE merchant_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE merchant_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_draft_read ON merchant_drafts FOR SELECT USING(can_access_tenant(tenant_id,false));
CREATE POLICY merchant_draft_create ON merchant_drafts FOR INSERT WITH CHECK(can_access_tenant(tenant_id,true) AND created_by=current_setting('app.actor_id',true));
CREATE POLICY merchant_draft_update ON merchant_drafts FOR UPDATE USING(can_access_tenant(tenant_id,true)) WITH CHECK(can_access_tenant(tenant_id,true));
ALTER TABLE publications ENABLE ROW LEVEL SECURITY; ALTER TABLE publications FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_read ON publications FOR SELECT USING(can_access_tenant(tenant_id,false));
CREATE POLICY publication_create ON publications FOR INSERT WITH CHECK(can_access_tenant(tenant_id,true));
ALTER TABLE publication_jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE publication_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_job_create ON publication_jobs FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM publications p WHERE p.id=publication_id AND can_access_tenant(p.tenant_id,true)));
ALTER TABLE public_pages ENABLE ROW LEVEL SECURITY; ALTER TABLE public_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY public_page_read ON public_pages FOR SELECT USING(withdrawn_at IS NULL);
ALTER TABLE crawler_rule_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE crawler_rule_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE edge_ingest_batches ENABLE ROW LEVEL SECURITY; ALTER TABLE edge_ingest_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY edge_coverage_read ON edge_ingest_batches FOR SELECT USING(EXISTS(SELECT 1 FROM memberships WHERE user_id=current_setting('app.actor_id',true) AND state='active'));
ALTER TABLE telemetry_cursors ENABLE ROW LEVEL SECURITY; ALTER TABLE telemetry_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE crawler_events ENABLE ROW LEVEL SECURITY; ALTER TABLE crawler_events FORCE ROW LEVEL SECURITY;
CREATE POLICY crawler_event_merchant_read ON crawler_events FOR SELECT USING(EXISTS(
  SELECT 1 FROM merchant_claims c WHERE c.place_id=crawler_events.place_id AND c.state='approved'
    AND can_access_tenant(c.tenant_id,false) AND crawler_events.observed_at>=c.reviewed_at
));
