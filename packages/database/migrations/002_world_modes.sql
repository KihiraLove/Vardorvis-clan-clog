-- Independent normal/hardcore logs share catalog identities, never collection credit.
ALTER TABLE submissions ADD COLUMN hardcore boolean NOT NULL DEFAULT false;

-- Fail for existing duplicate approvals rather than silently discarding any history.
-- Reconcile conflicting approvals explicitly before retrying this forward migration.
CREATE UNIQUE INDEX submissions_one_credit_per_world
  ON submissions(item_id, hardcore) WHERE status = 'approved';

CREATE TABLE site_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hardcore_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO site_settings(singleton) VALUES (true);

CREATE OR REPLACE VIEW collection_credits AS
SELECT id AS submission_id, item_id, collector_name, collected_on, hardcore
FROM submissions WHERE status = 'approved';

CREATE OR REPLACE VIEW item_collection_state AS
SELECT i.id AS item_id,
  EXISTS (SELECT 1 FROM collection_credits c WHERE c.item_id = i.id AND NOT c.hardcore) AS collected,
  EXISTS (SELECT 1 FROM collection_credits c WHERE c.item_id = i.id AND c.hardcore) AS hardcore_collected
FROM items i;
