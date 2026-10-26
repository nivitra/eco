-- Private submitted facts follow the same branch scope as drafts and ownership claims.
DROP POLICY place_submission_read ON places;
CREATE POLICY place_submission_read ON places FOR SELECT USING(can_access_place(submitting_tenant_id,id));
