-- A reviewed building grant can reference a different tenant's branch without exposing private claim data.
CREATE FUNCTION arrival_binding_authorized(sid text,tid uuid,pid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (can_read_arrival_site(sid) OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolbypassrls OR rolsuper))) AND EXISTS(
 SELECT 1 FROM merchant_claims c WHERE c.place_id=pid AND c.state='approved' AND (c.tenant_id=tid OR EXISTS(
 SELECT 1 FROM arrival_site_grants g WHERE g.site_id=sid AND g.place_id=pid AND g.tenant_id=c.tenant_id)))
$$;
