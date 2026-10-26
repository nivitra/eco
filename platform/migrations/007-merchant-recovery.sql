-- A withdrawn public page must remain reviewable in its merchant workspace.
-- No anonymous access and no new write privileges; existing tenant membership RLS applies.
CREATE POLICY places_merchant_read ON places FOR SELECT USING(EXISTS(
 SELECT 1 FROM merchant_claims c WHERE c.place_id=places.id
   AND can_access_tenant(c.tenant_id,false)
));
