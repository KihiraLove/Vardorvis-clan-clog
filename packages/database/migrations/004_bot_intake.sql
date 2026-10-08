-- Immutable bot-intake payload/receipt enables replay even after catalog/review changes.
-- Existing historical submissions have no bot receipt, so reuse of their interaction IDs conflicts.
ALTER TABLE submissions
  ADD COLUMN intake_payload_hash text CHECK (intake_payload_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN intake_receipt jsonb,
  ADD CONSTRAINT intake_receipt_pair CHECK (
    (intake_payload_hash IS NULL AND intake_receipt IS NULL)
    OR (intake_payload_hash IS NOT NULL AND intake_receipt IS NOT NULL)
  );

-- Aliases are explicit, non-unique across canonical items: ambiguous inputs require review.
CREATE TABLE item_aliases (
  item_id integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 200),
  PRIMARY KEY (item_id, alias)
);
CREATE INDEX item_aliases_item ON item_aliases(item_id);
