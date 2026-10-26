-- Unlisted, revocable outing links. Private notes, briefs and profiles are never stored here.
CREATE FUNCTION outing_share_ids_valid(ids text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_ndims(ids)=1 AND array_lower(ids,1)=1 AND cardinality(ids) BETWEEN 1 AND 8
   AND NOT EXISTS(SELECT 1 FROM unnest(ids) AS id WHERE id IS NULL OR length(id) NOT BETWEEN 1 AND 160 OR id<>btrim(id) OR id ~ '[[:cntrl:]]')
   AND cardinality(ids)=(SELECT count(DISTINCT id) FROM unnest(ids) AS id),false)
$$;

CREATE TABLE outing_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid() CHECK(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 owner_id text NOT NULL CHECK(length(owner_id)>0),
 request_id uuid NOT NULL CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120 AND title=btrim(title) AND title !~ '[[:cntrl:]]'),
 place_ids text[] NOT NULL CHECK(outing_share_ids_valid(place_ids)),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 revoked_at timestamptz,
 UNIQUE(owner_id,request_id),
 CHECK(expires_at=created_at+interval '30 days'),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX outing_shares_owner_created ON outing_shares(owner_id,created_at DESC);
CREATE INDEX outing_shares_owner_active ON outing_shares(owner_id,expires_at) WHERE revoked_at IS NULL;
ALTER TABLE outing_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE outing_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY outing_share_owner_read ON outing_shares FOR SELECT
 USING(owner_id=nullif(current_setting('app.actor_id',true),''));
-- A transaction-local capability permits only that live link, never a public directory.
CREATE POLICY outing_share_token_read ON outing_shares FOR SELECT
 USING(id::text=nullif(current_setting('app.outing_share_id',true),'') AND revoked_at IS NULL AND expires_at>now());
CREATE POLICY outing_share_owner_create ON outing_shares FOR INSERT
 WITH CHECK(owner_id=nullif(current_setting('app.actor_id',true),'') AND revoked_at IS NULL AND created_at=now());
CREATE POLICY outing_share_owner_revoke ON outing_shares FOR UPDATE
 USING(owner_id=nullif(current_setting('app.actor_id',true),''))
 WITH CHECK(owner_id=nullif(current_setting('app.actor_id',true),''));
-- No DELETE policy: retries retain their original request identity even after expiry/revocation.
CREATE FUNCTION preserve_outing_share_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.id,NEW.owner_id,NEW.request_id,NEW.title,NEW.place_ids,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.request_id,OLD.title,OLD.place_ids,OLD.created_at,OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<>now()) THEN
  RAISE EXCEPTION 'outing_share_snapshot_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outing_share_immutable BEFORE UPDATE ON outing_shares
 FOR EACH ROW EXECUTE FUNCTION preserve_outing_share_snapshot();
-- Also complete when this additive migration is applied without the broad migration runner.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kulture_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON outing_shares TO kulture_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kulture_worker') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON outing_shares TO kulture_worker;
 END IF;
END $$;
