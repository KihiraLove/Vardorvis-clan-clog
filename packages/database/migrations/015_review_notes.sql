-- REVIEW-03/F05: persistent staff note independent from rejection/revocation reasons.
-- review_reason remains the status/correction decision reason, including historical
-- values required by the rejected/revoked status constraint.
ALTER TABLE submissions
  ADD COLUMN review_note text NOT NULL DEFAULT ''
  CHECK (length(review_note) <= 1000);
