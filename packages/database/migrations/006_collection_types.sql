-- Existing decisions remain Regular; historical eligibility is never inferred.
ALTER TABLE submissions ADD COLUMN collection_type text DEFAULT 'regular';
ALTER TABLE submissions ADD COLUMN collection_reason text NOT NULL DEFAULT 'legacy';
ALTER TABLE submissions ADD CONSTRAINT submissions_collection_type_check
  CHECK (collection_type IN ('regular','event'));
ALTER TABLE submissions ADD CONSTRAINT submissions_collection_type_resolved
  CHECK ((item_id IS NULL AND status<>'approved') OR collection_type IS NOT NULL);
ALTER TABLE submissions ADD CONSTRAINT submissions_hardcore_regular
  CHECK (NOT hardcore OR collection_type IS NOT DISTINCT FROM 'regular');

DROP INDEX submissions_one_credit_per_world;
CREATE UNIQUE INDEX submissions_one_event_credit ON submissions(item_id)
  WHERE status='approved' AND collection_type='event' AND NOT hardcore;
CREATE INDEX submissions_regular_credits ON submissions(item_id,hardcore)
  WHERE status='approved' AND collection_type='regular';
CREATE OR REPLACE VIEW collection_credits AS
  SELECT id AS submission_id,item_id,collector_name,collected_on,hardcore,collection_type
  FROM submissions WHERE status='approved';

-- Change untouched default copy; keep every custom setting and audit intact.
UPDATE site_settings SET
  public_copy=CASE WHEN public_copy->>'collectionCaption'='Collected during BOTW events'
    THEN jsonb_set(public_copy,'{collectionCaption}','"Collected by clan members"') ELSE public_copy END,
  hardcore_copy=CASE WHEN hardcore_copy->>'collectionCaption'='Collected during BOTW events'
    THEN jsonb_set(hardcore_copy,'{collectionCaption}','"Collected by clan members"') ELSE hardcore_copy END,
  version=version+1
WHERE version=1 AND (public_copy->>'collectionCaption'='Collected during BOTW events'
  OR hardcore_copy->>'collectionCaption'='Collected during BOTW events');
