-- Track a one-time, audited, source-preserving clue page correction.
-- Catalog membership changes run AFTER the pinned first import in bootstrap.
CREATE TABLE catalog_taxonomy_updates (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE catalog_audit DROP CONSTRAINT catalog_audit_action_check;
ALTER TABLE catalog_audit ADD CONSTRAINT catalog_audit_action_check
  CHECK (action IN ('create', 'reorder', 'reconcile', 'taxonomy'));
