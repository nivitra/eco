-- Each successful provider fetch has its own immutable validity window.
-- Repeating a checksum must not extend evidence across an expired collection gap.
ALTER TABLE crawler_rule_snapshots DROP CONSTRAINT crawler_rule_snapshots_provider_role_checksum_key;
CREATE INDEX crawler_rule_validity ON crawler_rule_snapshots(first_seen_at,expires_at);
