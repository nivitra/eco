CREATE TABLE consumer_feedback (
  user_id text NOT NULL,
  place_id text NOT NULL REFERENCES places(id),
  kind text NOT NULL CHECK(kind IN ('liked','dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,place_id)
);
ALTER TABLE consumer_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_owner ON consumer_feedback FOR ALL
  USING(user_id=current_setting('app.actor_id',true))
  WITH CHECK(user_id=current_setting('app.actor_id',true));
