CREATE TABLE worker_heartbeats(name text PRIMARY KEY,last_seen timestamptz NOT NULL DEFAULT now(),last_error text);
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY; ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_read ON worker_heartbeats FOR SELECT USING(true);
