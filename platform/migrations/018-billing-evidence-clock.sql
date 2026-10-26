-- Provider invoice.paid_at proves when the captured payment was made; never infer it from local receipt time.
ALTER TABLE payment_ledger ADD COLUMN captured_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN first_website_binding_id uuid;
UPDATE subscriptions s SET first_website_binding_id=d.binding_id
 FROM publication_destinations d WHERE d.id=s.first_website_destination_id AND d.tenant_id=s.tenant_id AND d.place_id=s.place_id;
-- Existing deadlines and completion markers were derived from observation time/arbitrary history.
-- Force fresh provider timestamps and current destination verification on the next reconciliation.
UPDATE subscriptions SET first_delivery_due_at=NULL,first_delivery_verified_at=NULL,next_reconcile_at=now()
 WHERE first_website_destination_id IS NOT NULL;
