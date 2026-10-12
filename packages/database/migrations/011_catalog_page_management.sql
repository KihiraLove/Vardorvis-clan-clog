-- Retain stable page IDs and audit references after staff remove a page.
ALTER TABLE pages ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN position_origin text NOT NULL DEFAULT 'source' CHECK(position_origin IN ('source','manual'));
ALTER TABLE catalog_audit DROP CONSTRAINT catalog_audit_action_check,
  ADD CONSTRAINT catalog_audit_action_check CHECK(action IN ('create','reorder','reconcile','taxonomy','delete','create_page','delete_page','reorder_pages'));
CREATE TABLE catalog_page_requests (
  actor_discord_id text NOT NULL,
  request_key text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_discord_id,request_key)
);
