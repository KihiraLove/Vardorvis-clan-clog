-- Preserve the distinction between a new installation and a reviewed upgrade,
-- including a restart between the baseline import and release installation.
CREATE TABLE catalog_bootstrap_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    complete boolean NOT NULL
);
INSERT INTO catalog_bootstrap_state(singleton, complete)
SELECT true,
    EXISTS (SELECT 1 FROM catalog_versions) OR
    EXISTS (SELECT 1 FROM items) OR
    EXISTS (SELECT 1 FROM pages) OR
    EXISTS (SELECT 1 FROM submissions) OR
    EXISTS (SELECT 1 FROM catalog_update_batches);
