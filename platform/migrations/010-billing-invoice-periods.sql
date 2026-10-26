ALTER TABLE payment_ledger ADD COLUMN period_start timestamptz;
ALTER TABLE payment_ledger ADD COLUMN invoice_id text;
CREATE UNIQUE INDEX payment_ledger_invoice ON payment_ledger(invoice_id) WHERE invoice_id IS NOT NULL;
-- Older rows without invoice-period proof cannot establish access until reconciled.
UPDATE subscriptions SET paid_until=(SELECT max(l.paid_until) FROM payment_ledger l WHERE l.subscription_id=subscriptions.id AND l.refunded_at IS NULL AND l.period_start<=now());
