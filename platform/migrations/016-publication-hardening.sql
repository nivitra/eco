-- INSERT RETURNING evaluates read policy before a subquery can see the newly inserted row.
-- Match the scoped credential on that row directly; tenant visibility remains place-scoped.
DROP POLICY installation_read ON adapter_installations;
CREATE POLICY installation_read ON adapter_installations FOR SELECT USING(
 (credential_hash=current_setting('app.adapter_hash',true) AND status<>'revoked')
 OR EXISTS(SELECT 1 FROM publication_destinations d WHERE d.installation_id=adapter_installations.id AND can_access_place(d.tenant_id,d.place_id))
);
