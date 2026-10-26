-- Private named place collections. Tombstones retain only identity/version/times.
CREATE FUNCTION consumer_shortlist_utf16_length(value text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(CASE WHEN ascii(substr(value,n,1))>65535 THEN 2 ELSE 1 END),0)::integer
 FROM generate_series(1,length(value)) n
$$;
CREATE FUNCTION consumer_shortlist_text_valid(value text,maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=public,pg_temp AS $$
 SELECT consumer_shortlist_utf16_length(value) BETWEEN 1 AND maximum
  AND value=btrim(value,U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND value !~ '[[:cntrl:]]'
$$;
CREATE FUNCTION consumer_shortlist_ids_valid(ids text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_ndims(ids)=1 AND array_lower(ids,1)=1 AND cardinality(ids) BETWEEN 1 AND 8
  AND NOT EXISTS(SELECT 1 FROM unnest(ids) AS id WHERE id IS NULL OR NOT consumer_shortlist_text_valid(id,160))
  AND cardinality(ids)=(SELECT count(DISTINCT id) FROM unnest(ids) AS id),false)
$$;
CREATE TABLE consumer_shortlists (
 user_id text NOT NULL CHECK(length(user_id)>0),
 id uuid NOT NULL,
 title text NOT NULL,
 place_ids text[] NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 PRIMARY KEY(user_id,id),
 CHECK(updated_at>=created_at),
 CHECK((deleted_at IS NULL AND consumer_shortlist_text_valid(title,80) AND consumer_shortlist_ids_valid(place_ids))
    OR (deleted_at IS NOT NULL AND title='' AND cardinality(place_ids)=0 AND deleted_at=updated_at))
);
CREATE INDEX consumer_shortlists_active ON consumer_shortlists(user_id,updated_at DESC,id) WHERE deleted_at IS NULL;
ALTER TABLE consumer_shortlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_shortlists FORCE ROW LEVEL SECURITY;
CREATE POLICY consumer_shortlist_read ON consumer_shortlists FOR SELECT
 USING(user_id=nullif(current_setting('app.actor_id',true),''));
CREATE POLICY consumer_shortlist_create ON consumer_shortlists FOR INSERT
 WITH CHECK(user_id=nullif(current_setting('app.actor_id',true),'') AND version=1 AND deleted_at IS NULL);
CREATE POLICY consumer_shortlist_update ON consumer_shortlists FOR UPDATE
 USING(user_id=nullif(current_setting('app.actor_id',true),''))
 WITH CHECK(user_id=nullif(current_setting('app.actor_id',true),''));
-- Deliberately no DELETE policy: deleted client UUIDs must not be reused.
CREATE FUNCTION preserve_consumer_shortlist_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('consumer-shortlists:'||NEW.user_id,0));
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.deleted_at IS NOT NULL OR NEW.created_at<>now() OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'invalid_shortlist_creation' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM consumer_shortlists WHERE user_id=NEW.user_id AND deleted_at IS NULL)>=100 THEN
   RAISE EXCEPTION 'shortlist_limit' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (NEW.user_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.created_at)
    OR OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'shortlist_identity_or_version_immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consumer_shortlist_identity BEFORE INSERT OR UPDATE ON consumer_shortlists
 FOR EACH ROW EXECUTE FUNCTION preserve_consumer_shortlist_identity();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kulture_app') THEN
  GRANT SELECT,INSERT,UPDATE ON consumer_shortlists TO kulture_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kulture_worker') THEN
  GRANT SELECT,INSERT,UPDATE ON consumer_shortlists TO kulture_worker;
 END IF;
END $$;
