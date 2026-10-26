-- Narrow financial and audit reads to the same branch scope as ordinary facts.
DROP POLICY subscription_read ON subscriptions;
CREATE POLICY subscription_read ON subscriptions FOR SELECT USING(can_access_place(tenant_id,place_id));
DROP POLICY payment_read ON payment_ledger;
CREATE POLICY payment_read ON payment_ledger FOR SELECT USING(EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=subscription_id AND can_access_place(s.tenant_id,s.place_id)));
-- Incomplete initial attempts can be abandoned only after an operator verifies no remote binding.
-- Public request metadata must never grant write authority to an unapproved claim.
CREATE INDEX location_submission_owner ON places(submitting_tenant_id) WHERE state='pending';
CREATE INDEX service_request_tenant_state ON service_requests(tenant_id,state,created_at);
CREATE INDEX service_grant_location_period ON service_grants(tenant_id,place_id,ends_at) WHERE revoked_at IS NULL;
CREATE INDEX billing_reconcile_due ON subscriptions(next_reconcile_at) WHERE provider_id IS NOT NULL;
