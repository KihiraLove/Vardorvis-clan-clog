-- Unchanged imports append durable receipts without advancing xp_state.version.
-- Their history needs a separate transactional revision shared by both importers.
ALTER TABLE xp_state ADD COLUMN history_version bigint NOT NULL DEFAULT 1
  CHECK (history_version > 0);
CREATE FUNCTION advance_xp_history_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE xp_state SET history_version = history_version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER xp_history_revision
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON xp_import_history
  FOR EACH STATEMENT EXECUTE FUNCTION advance_xp_history_revision();
-- The existing xp_history_latest(imported_at DESC,id DESC) supports keyset seeks.
