-- O(1) invalidation shared by every writer, including bot and owner imports.
-- The counter is transactional: a reader sees both the rows and their revision
-- in one REPEATABLE READ snapshot, never a sequence value from an uncommitted write.
CREATE TABLE review_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO review_state(singleton) VALUES(true);

CREATE FUNCTION advance_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE review_state SET version = version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER submissions_review_revision
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON submissions
  FOR EACH STATEMENT EXECUTE FUNCTION advance_review_revision();
CREATE TRIGGER audit_review_revision
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION advance_review_revision();

-- Match each queue predicate so the page read need not sort/filter the ledger.
CREATE INDEX submissions_pending_page ON submissions(submitted_at DESC, id DESC)
  WHERE status = 'pending';
CREATE INDEX submissions_unmatched_page ON submissions(submitted_at DESC, id DESC)
  WHERE status = 'pending' AND item_id IS NULL;
CREATE INDEX submissions_reviewed_page ON submissions(submitted_at DESC, id DESC)
  WHERE status IN ('approved', 'rejected', 'revoked');
CREATE INDEX audit_submission_page ON audit_events(submission_id, id DESC);
