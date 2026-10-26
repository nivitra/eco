-- Partial-index ON CONFLICT reads the existing job. Installation principals may
-- observe only jobs for bindings on their own installation; no other tenant rows.
DROP POLICY access_job_read ON access_jobs;
CREATE POLICY access_job_read ON access_jobs FOR SELECT USING(EXISTS(
 SELECT 1 FROM publication_destinations d WHERE d.id=destination_id
 AND (can_access_place(d.tenant_id,d.place_id,false) OR adapter_installation_allowed(d.installation_id))
));
