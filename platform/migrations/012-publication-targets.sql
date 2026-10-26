-- Per-site installations are separate from per-location destination bindings.
ALTER TABLE publications ADD COLUMN approved_by text;
CREATE TABLE adapter_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), origin text NOT NULL, credential_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pairing' CHECK(status IN('pairing','connected','revoked')),
 plugin_version text NOT NULL, renderer_version text NOT NULL, template_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, revoked_at timestamptz
);
CREATE TABLE adapter_pairings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), installation_id uuid NOT NULL REFERENCES adapter_installations,
 code_hash text NOT NULL UNIQUE, challenge text NOT NULL, page_id text NOT NULL, page_url text NOT NULL,
 base_content_hash text NOT NULL, expires_at timestamptz NOT NULL, approved_at timestamptz,
 confirmed_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 place_id text NOT NULL REFERENCES places, kind text NOT NULL CHECK(kind IN('hosted','wordpress')),
 installation_id uuid REFERENCES adapter_installations, pairing_id uuid REFERENCES adapter_pairings,
 binding_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, page_id text, allowed_metadata jsonb NOT NULL DEFAULT '[]', public_url text NOT NULL,
 canonical_url text NOT NULL, state text NOT NULL DEFAULT 'connected', version int NOT NULL DEFAULT 1,
 next_sequence bigint NOT NULL DEFAULT 1, last_sequence bigint NOT NULL DEFAULT 0,
 last_applied_hash text NOT NULL, conflict_hash text, last_success_at timestamptz, last_error text,
 paused_at timestamptz, lifecycle_checked_at timestamptz NOT NULL DEFAULT '-infinity', disconnected_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='hosted' AND installation_id IS NULL) OR (kind='wordpress' AND installation_id IS NOT NULL)),
 UNIQUE(tenant_id,place_id,id)
);
CREATE UNIQUE INDEX one_selected_website ON publication_destinations(place_id) WHERE state<>'revoked';
CREATE UNIQUE INDEX adapter_page_scope ON publication_destinations(installation_id,page_id) WHERE state<>'revoked';
ALTER TABLE subscriptions ADD COLUMN first_website_destination_id uuid REFERENCES publication_destinations;
ALTER TABLE subscriptions ADD COLUMN first_selected_at timestamptz;
CREATE TABLE destination_domains (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), destination_id uuid NOT NULL UNIQUE REFERENCES publication_destinations,
 tenant_id uuid NOT NULL REFERENCES tenants, place_id text NOT NULL REFERENCES places, hostname text NOT NULL UNIQUE, token text NOT NULL,
 expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'requested', verified_at timestamptz,
 routed_at timestamptz, tls_at timestamptz, activated_at timestamptz, recheck_at timestamptz,
 migration_preview jsonb, migration_expires_at timestamptz, removed_at timestamptz
);
CREATE TABLE destination_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), destination_id uuid NOT NULL REFERENCES publication_destinations,
 tenant_id uuid NOT NULL REFERENCES tenants, place_id text NOT NULL REFERENCES places, draft_id uuid NOT NULL REFERENCES merchant_drafts,
 draft_version int NOT NULL, target_version int NOT NULL, sequence bigint NOT NULL,
 snapshot jsonb NOT NULL, fragment text NOT NULL, html text NOT NULL, metadata jsonb NOT NULL,
 asset_manifest jsonb NOT NULL DEFAULT '[]', base_content_hash text NOT NULL, artifact_digest text NOT NULL,
 metadata_digest text NOT NULL, digest text NOT NULL, renderer_version text NOT NULL, template_hash text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE target_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 place_id text NOT NULL REFERENCES places, destination_id uuid NOT NULL REFERENCES publication_destinations,
 publication_id uuid NOT NULL REFERENCES publications, preview_id uuid NOT NULL UNIQUE REFERENCES destination_previews,
 sequence bigint NOT NULL, approved_by text, state text NOT NULL DEFAULT 'queued', attempts int NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, error_code text,
 bundle_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, envelope jsonb,
 applied_at timestamptz, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(destination_id,sequence)
);
CREATE INDEX target_jobs_ready ON target_deliveries(available_at) WHERE state IN('queued','preparing');
CREATE TABLE adapter_apply_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES target_deliveries,
 installation_id uuid NOT NULL REFERENCES adapter_installations, token_hash text NOT NULL UNIQUE,
 destination_version int NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE adapter_receipts (
 installation_id uuid NOT NULL REFERENCES adapter_installations, bundle_id uuid NOT NULL,
 request_digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,bundle_id)
);
CREATE TABLE hosted_sites (
 destination_id uuid PRIMARY KEY REFERENCES publication_destinations, place_id text NOT NULL UNIQUE REFERENCES places,
 delivery_id uuid NOT NULL REFERENCES target_deliveries, html text NOT NULL, digest text NOT NULL,
 canonical_url text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), withdrawn_at timestamptz
);
CREATE TABLE access_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), destination_id uuid NOT NULL REFERENCES publication_destinations,
 delivery_id uuid REFERENCES target_deliveries, kind text NOT NULL DEFAULT 'page', state text NOT NULL DEFAULT 'queued',
 attempts int NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_jobs_ready ON access_jobs(available_at) WHERE state IN('queued','running');
CREATE UNIQUE INDEX access_job_coalesce ON access_jobs(destination_id,kind) WHERE state IN('queued','running');
CREATE TABLE access_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 place_id text NOT NULL REFERENCES places, destination_id uuid NOT NULL REFERENCES publication_destinations,
 delivery_id uuid REFERENCES target_deliveries, outcome text NOT NULL, checks jsonb NOT NULL,
 observed_url text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), synthetic boolean NOT NULL DEFAULT true CHECK(synthetic)
);
CREATE TABLE website_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 place_id text NOT NULL REFERENCES places, destination_id uuid NOT NULL REFERENCES publication_destinations,
 kind text NOT NULL, state text NOT NULL DEFAULT 'open', reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(destination_id,kind)
);

CREATE FUNCTION adapter_installation_allowed(i uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM adapter_installations a WHERE a.id=i AND a.status<>'revoked'
  AND a.credential_hash=current_setting('app.adapter_hash',true))
$$;
CREATE FUNCTION adapter_bound_location(t uuid,p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM publication_destinations d JOIN adapter_installations a ON a.id=d.installation_id
  WHERE d.tenant_id=t AND d.place_id=p AND d.state<>'revoked' AND a.status='connected'
   AND a.credential_hash=current_setting('app.adapter_hash',true))
$$;
CREATE FUNCTION adapter_installation_visible(i uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT adapter_installation_allowed(i) OR EXISTS(SELECT 1 FROM publication_destinations d WHERE d.installation_id=i AND can_access_place(d.tenant_id,d.place_id,false))
$$;

ALTER TABLE adapter_installations ENABLE ROW LEVEL SECURITY; ALTER TABLE adapter_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_read ON adapter_installations FOR SELECT USING(adapter_installation_visible(id));
CREATE POLICY installation_create ON adapter_installations FOR INSERT WITH CHECK(credential_hash=current_setting('app.adapter_hash',true) AND status='pairing');
CREATE POLICY installation_machine_update ON adapter_installations FOR UPDATE USING(adapter_installation_allowed(id));
ALTER TABLE adapter_pairings ENABLE ROW LEVEL SECURITY; ALTER TABLE adapter_pairings FORCE ROW LEVEL SECURITY;
CREATE POLICY pairing_read ON adapter_pairings FOR SELECT USING(adapter_installation_visible(installation_id) OR code_hash=current_setting('app.pairing_hash',true));
CREATE POLICY pairing_create ON adapter_pairings FOR INSERT WITH CHECK(adapter_installation_allowed(installation_id));
CREATE POLICY pairing_update ON adapter_pairings FOR UPDATE USING(adapter_installation_allowed(installation_id) OR code_hash=current_setting('app.pairing_hash',true));
ALTER TABLE publication_destinations ENABLE ROW LEVEL SECURITY; ALTER TABLE publication_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY destination_read ON publication_destinations FOR SELECT USING(can_access_place(tenant_id,place_id,false) OR adapter_installation_allowed(installation_id));
CREATE POLICY destination_create ON publication_destinations FOR INSERT WITH CHECK(can_access_place(tenant_id,place_id,true));
CREATE POLICY destination_update ON publication_destinations FOR UPDATE USING(can_access_place(tenant_id,place_id,true) OR adapter_installation_allowed(installation_id));
ALTER TABLE destination_domains ENABLE ROW LEVEL SECURITY; ALTER TABLE destination_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_read ON destination_domains FOR SELECT USING(can_access_place(tenant_id,place_id,false));
CREATE POLICY domain_write ON destination_domains FOR ALL USING(can_access_place(tenant_id,place_id,true)) WITH CHECK(can_access_place(tenant_id,place_id,true));
ALTER TABLE destination_previews ENABLE ROW LEVEL SECURITY; ALTER TABLE destination_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY target_preview_read ON destination_previews FOR SELECT USING(can_access_place(tenant_id,place_id,false) OR adapter_bound_location(tenant_id,place_id));
CREATE POLICY target_preview_create ON destination_previews FOR INSERT WITH CHECK(can_access_place(tenant_id,place_id,false));
ALTER TABLE target_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE target_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_read ON target_deliveries FOR SELECT USING(can_access_place(tenant_id,place_id,false) OR adapter_bound_location(tenant_id,place_id));
CREATE POLICY delivery_create ON target_deliveries FOR INSERT WITH CHECK(can_access_place(tenant_id,place_id,true));
CREATE POLICY delivery_update ON target_deliveries FOR UPDATE USING(can_access_place(tenant_id,place_id,true) OR adapter_bound_location(tenant_id,place_id));
ALTER TABLE adapter_apply_leases ENABLE ROW LEVEL SECURITY; ALTER TABLE adapter_apply_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY apply_lease_machine ON adapter_apply_leases FOR ALL USING(adapter_installation_allowed(installation_id)) WITH CHECK(adapter_installation_allowed(installation_id));
ALTER TABLE adapter_receipts ENABLE ROW LEVEL SECURITY; ALTER TABLE adapter_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_machine ON adapter_receipts FOR ALL USING(adapter_installation_allowed(installation_id)) WITH CHECK(adapter_installation_allowed(installation_id));
ALTER TABLE hosted_sites ENABLE ROW LEVEL SECURITY; ALTER TABLE hosted_sites FORCE ROW LEVEL SECURITY;
CREATE POLICY hosted_public_read ON hosted_sites FOR SELECT USING(withdrawn_at IS NULL);
ALTER TABLE access_jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE access_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY access_job_create ON access_jobs FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM publication_destinations d WHERE d.id=destination_id AND (can_access_place(d.tenant_id,d.place_id,true) OR adapter_installation_allowed(d.installation_id))));
CREATE POLICY access_job_read ON access_jobs FOR SELECT USING(EXISTS(SELECT 1 FROM publication_destinations d WHERE d.id=destination_id AND can_access_place(d.tenant_id,d.place_id,false)));
ALTER TABLE access_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE access_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_read ON access_observations FOR SELECT USING(can_access_place(tenant_id,place_id,false));
ALTER TABLE website_incidents ENABLE ROW LEVEL SECURITY; ALTER TABLE website_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_read ON website_incidents FOR SELECT USING(can_access_place(tenant_id,place_id,false));
CREATE POLICY claims_adapter_read ON merchant_claims FOR SELECT USING(state='approved' AND adapter_bound_location(tenant_id,place_id));
CREATE POLICY places_adapter_read ON places FOR SELECT USING(EXISTS(SELECT 1 FROM publication_destinations d WHERE d.place_id=places.id AND adapter_bound_location(d.tenant_id,d.place_id)));
CREATE POLICY publications_adapter_read ON publications FOR SELECT USING(adapter_bound_location(tenant_id,place_id));
CREATE POLICY grants_adapter_read ON service_grants FOR SELECT USING(adapter_bound_location(tenant_id,place_id));
CREATE POLICY subscriptions_adapter_read ON subscriptions FOR SELECT USING(adapter_bound_location(tenant_id,place_id));
CREATE POLICY ledger_adapter_read ON payment_ledger FOR SELECT USING(EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=subscription_id AND adapter_bound_location(s.tenant_id,s.place_id)));

-- Public host lookup exposes only a verified, active serving projection, never tokens/private drafts.
CREATE FUNCTION published_host(h text) RETURNS TABLE(destination_id uuid,place_id text,html text,digest text,canonical_url text,domain_state text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT d.id,d.place_id,s.html,s.digest,s.canonical_url,x.state FROM destination_domains x
 JOIN publication_destinations d ON d.id=x.destination_id JOIN hosted_sites s ON s.destination_id=d.id
 WHERE x.hostname=h AND x.state IN('live','activating') AND x.removed_at IS NULL AND d.state<>'revoked' AND s.withdrawn_at IS NULL
$$;
CREATE FUNCTION domain_certificate_allowed(h text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM destination_domains x JOIN publication_destinations d ON d.id=x.destination_id
 WHERE x.hostname=h AND x.state IN('dns_routed','tls_ready','activating','live') AND x.verified_at>now()-interval '30 days'
 AND x.removed_at IS NULL AND d.state<>'revoked')
$$;

-- Machine credentials can ask only whether their own immutable approval remains authorized.
CREATE FUNCTION adapter_approval_current(pub uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM publications p JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.approved_by
 WHERE p.id=pub AND adapter_bound_location(p.tenant_id,p.place_id) AND m.state='active'
 AND (m.role='owner' OR (m.role='manager' AND m.can_publish AND (m.scope_mode='all' OR EXISTS(SELECT 1 FROM membership_places s WHERE s.tenant_id=m.tenant_id AND s.user_id=m.user_id AND s.place_id=p.place_id)))))
$$;
CREATE FUNCTION public_hosted_site(p text) RETURNS TABLE(html text,digest text,canonical_url text,paused_at timestamptz,canonical_path text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.html,s.digest,s.canonical_url,d.paused_at,b.canonical_path FROM hosted_sites s JOIN publication_destinations d ON d.id=s.destination_id JOIN public_pages b ON b.place_id=s.place_id
 WHERE s.place_id=p AND s.withdrawn_at IS NULL AND b.withdrawn_at IS NULL
$$;
CREATE FUNCTION public_domain_status(h text) RETURNS TABLE(state text,paused_at timestamptz,place_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT x.state,d.paused_at,d.place_id FROM destination_domains x JOIN publication_destinations d ON d.id=x.destination_id
 WHERE x.hostname=h AND x.state IN('dns_routed','tls_ready','activating','live') AND x.removed_at IS NULL AND d.state<>'revoked'
$$;
