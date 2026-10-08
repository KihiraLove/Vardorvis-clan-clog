-- Preserve human-readable admin identity and per-action reason after sessions expire.
-- Historical rows retain a labelled fallback; never delete legacy audit history.
ALTER TABLE audit_events
  ADD COLUMN actor_name text NOT NULL DEFAULT 'Unknown administrator',
  ADD COLUMN reason text;
CREATE INDEX submissions_review_cursor
  ON submissions (submitted_at DESC, id DESC);
