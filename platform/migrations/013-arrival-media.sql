-- Arrival/media are first-party facts. No prototype coordinates are automatically verified.
CREATE TABLE media_assets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,place_id text NOT NULL REFERENCES places,
 purpose text NOT NULL CHECK(purpose IN('business_photo','checkpoint','floor_plan')),alt text NOT NULL CHECK(length(alt) BETWEEN 1 AND 300),
 rights jsonb NOT NULL,state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','processing','ready','failed','revoked')),
 original_key text,derivative_key text,sha256 text,mime text,width int,height int,stored_bytes bigint NOT NULL DEFAULT 0 CHECK(stored_bytes>=0),
 revision int NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,place_id,id));
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY media_private_read ON media_assets FOR SELECT USING(can_access_place(tenant_id,place_id));
CREATE POLICY media_private_write ON media_assets FOR ALL USING(can_access_place(tenant_id,place_id,true)) WITH CHECK(can_access_place(tenant_id,place_id,true));
-- A separate projection prevents anonymous asset serving from accessing original storage keys.
CREATE TABLE public_media(id uuid PRIMARY KEY REFERENCES media_assets,tenant_id uuid NOT NULL,place_id text NOT NULL,
 derivative_key text NOT NULL,sha256 text NOT NULL,mime text NOT NULL,alt text NOT NULL,width int NOT NULL,height int NOT NULL,revision int NOT NULL,valid_until timestamptz,revoked_at timestamptz,
 FOREIGN KEY(tenant_id,place_id,id) REFERENCES media_assets(tenant_id,place_id,id));
ALTER TABLE public_media ENABLE ROW LEVEL SECURITY;ALTER TABLE public_media FORCE ROW LEVEL SECURITY;
CREATE POLICY public_media_read ON public_media FOR SELECT USING((revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now())) OR can_access_place(tenant_id,place_id));
CREATE POLICY public_media_owner_write ON public_media FOR ALL USING(can_access_place(tenant_id,place_id,true)) WITH CHECK(can_access_place(tenant_id,place_id,true));
CREATE TABLE arrival_sites(id text PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,origin_place_id text NOT NULL REFERENCES places,name text NOT NULL,authority_state text NOT NULL DEFAULT 'proposed' CHECK(authority_state IN('proposed','approved','revoked')),revision int NOT NULL DEFAULT 1,UNIQUE(tenant_id,id));
CREATE TABLE arrival_site_grants(site_id text NOT NULL REFERENCES arrival_sites,tenant_id uuid NOT NULL REFERENCES tenants,place_id text NOT NULL REFERENCES places,can_edit boolean NOT NULL DEFAULT false,PRIMARY KEY(site_id,tenant_id,place_id));
CREATE FUNCTION can_read_arrival_site(sid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM arrival_sites s WHERE s.id=sid AND can_access_place(s.tenant_id,s.origin_place_id)) OR EXISTS(SELECT 1 FROM arrival_site_grants g WHERE g.site_id=sid AND can_access_place(g.tenant_id,g.place_id)) $$;
CREATE FUNCTION can_edit_arrival_site(sid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM arrival_sites s WHERE s.id=sid AND can_access_place(s.tenant_id,s.origin_place_id,true)) OR EXISTS(SELECT 1 FROM arrival_site_grants g WHERE g.site_id=sid AND g.can_edit AND can_access_place(g.tenant_id,g.place_id,true)) $$;
ALTER TABLE arrival_sites ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_sites FORCE ROW LEVEL SECURITY;
CREATE POLICY site_read ON arrival_sites FOR SELECT USING(can_read_arrival_site(id));
CREATE POLICY site_create ON arrival_sites FOR INSERT WITH CHECK(can_access_place(tenant_id,origin_place_id,true) AND authority_state='proposed');
ALTER TABLE arrival_site_grants ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_site_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY site_grant_read ON arrival_site_grants FOR SELECT USING(can_read_arrival_site(site_id));
CREATE TABLE arrival_drafts(graph_id text PRIMARY KEY,site_id text NOT NULL REFERENCES arrival_sites,tenant_id uuid NOT NULL REFERENCES tenants,place_id text NOT NULL REFERENCES places,
 body jsonb NOT NULL,revision int NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','submitted','approved','rejected','published')),
 approved_digest text,review_note text,review_evidence jsonb,reviewed_at timestamptz,reviewed_by text,created_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(site_id,graph_id));
ALTER TABLE arrival_drafts ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_draft_read ON arrival_drafts FOR SELECT USING(can_read_arrival_site(site_id));
CREATE POLICY arrival_draft_create ON arrival_drafts FOR INSERT WITH CHECK(can_access_place(tenant_id,place_id,true) AND can_edit_arrival_site(site_id) AND created_by=current_setting('app.actor_id',true) AND state='draft');
CREATE POLICY arrival_draft_edit ON arrival_drafts FOR UPDATE USING(can_edit_arrival_site(site_id)) WITH CHECK(can_edit_arrival_site(site_id));
CREATE TABLE arrival_releases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),graph_id text NOT NULL REFERENCES arrival_drafts,site_id text NOT NULL REFERENCES arrival_sites,
 revision int NOT NULL,graph jsonb NOT NULL,assets jsonb NOT NULL,manifest_json text NOT NULL,digest text NOT NULL,verification jsonb NOT NULL,published_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz,UNIQUE(graph_id,revision),FOREIGN KEY(site_id,graph_id) REFERENCES arrival_drafts(site_id,graph_id));
ALTER TABLE arrival_releases ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_release_read ON arrival_releases FOR SELECT USING(withdrawn_at IS NULL OR can_read_arrival_site(site_id));
CREATE POLICY arrival_release_create ON arrival_releases FOR INSERT WITH CHECK(can_edit_arrival_site(site_id));
CREATE POLICY arrival_release_update ON arrival_releases FOR UPDATE USING(can_edit_arrival_site(site_id)) WITH CHECK(can_edit_arrival_site(site_id));
CREATE TABLE place_arrival_bindings(place_id text PRIMARY KEY REFERENCES places,release_id uuid NOT NULL REFERENCES arrival_releases,destination_node_id text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE place_arrival_bindings ENABLE ROW LEVEL SECURITY;ALTER TABLE place_arrival_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_binding_read ON place_arrival_bindings FOR SELECT USING(true);
CREATE POLICY arrival_binding_write ON place_arrival_bindings FOR ALL USING(EXISTS(SELECT 1 FROM arrival_releases r WHERE r.id=release_id AND can_edit_arrival_site(r.site_id))) WITH CHECK(EXISTS(SELECT 1 FROM arrival_releases r WHERE r.id=release_id AND can_edit_arrival_site(r.site_id)));
CREATE TABLE arrival_closures(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id text NOT NULL REFERENCES arrival_sites,graph_id text NOT NULL REFERENCES arrival_drafts,
 target_type text NOT NULL CHECK(target_type IN('entrance','node','edge','lift')),target_id text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz,
 reason text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','resolved')),revision int NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(ends_at IS NULL OR ends_at>starts_at),FOREIGN KEY(site_id,graph_id) REFERENCES arrival_drafts(site_id,graph_id));
ALTER TABLE arrival_closures ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY closure_read ON arrival_closures FOR SELECT USING(can_read_arrival_site(site_id) OR EXISTS(SELECT 1 FROM arrival_releases r WHERE r.graph_id=arrival_closures.graph_id AND r.withdrawn_at IS NULL));
CREATE POLICY closure_create ON arrival_closures FOR INSERT WITH CHECK(can_edit_arrival_site(site_id) AND EXISTS(SELECT 1 FROM arrival_sites s WHERE s.id=site_id AND s.authority_state='approved') AND created_by=current_setting('app.actor_id',true));
CREATE POLICY closure_edit ON arrival_closures FOR UPDATE USING(can_edit_arrival_site(site_id)) WITH CHECK(can_edit_arrival_site(site_id));
CREATE TABLE arrival_issues(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),place_id text NOT NULL REFERENCES places,graph_id text,description text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),state text NOT NULL DEFAULT 'submitted');
ALTER TABLE arrival_issues ENABLE ROW LEVEL SECURITY;ALTER TABLE arrival_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_issue_insert ON arrival_issues FOR INSERT WITH CHECK(state='submitted');
CREATE INDEX arrival_closures_graph ON arrival_closures(graph_id,status);
CREATE INDEX media_location ON media_assets(tenant_id,place_id,state);
CREATE FUNCTION arrival_place_visible(pid text,rid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(
 SELECT 1 FROM arrival_releases r JOIN arrival_sites s ON s.id=r.site_id JOIN arrival_drafts d ON d.graph_id=r.graph_id JOIN places p ON p.id=pid
 WHERE r.id=rid AND r.withdrawn_at IS NULL AND s.authority_state='approved' AND p.state NOT IN('closed','withdrawn','merged') AND EXISTS(
 SELECT 1 FROM merchant_claims c WHERE c.place_id=pid AND c.state='approved' AND (c.tenant_id=d.tenant_id OR EXISTS(SELECT 1 FROM arrival_site_grants g WHERE g.site_id=s.id AND g.place_id=pid AND g.tenant_id=c.tenant_id)))) $$;

-- An authorized site editor cannot bind an unrelated branch or spoof a graph's site.
ALTER POLICY arrival_binding_write ON place_arrival_bindings WITH CHECK(
 arrival_place_visible(place_id,release_id) AND EXISTS(SELECT 1 FROM arrival_releases r WHERE r.id=release_id AND can_edit_arrival_site(r.site_id)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.graph->'placeDestinationBindings') b WHERE b->>'placeID'=place_arrival_bindings.place_id AND b->>'destinationNodeID'=place_arrival_bindings.destination_node_id)));
