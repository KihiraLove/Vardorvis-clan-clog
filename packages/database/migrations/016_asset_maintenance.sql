-- Durable retirement precedes filesystem deletion. A delayed upload cannot
-- publish a database reference after maintenance has retired its filename.
CREATE TABLE asset_retirements (
  storage_kind text NOT NULL CHECK (storage_kind IN ('icons','branding','proofs')),
  file_name text NOT NULL CHECK (file_name ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|webp)(\.tmp)?$'),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY(storage_kind,file_name)
);
CREATE INDEX asset_retirements_pending ON asset_retirements(storage_kind,retired_at,file_name) WHERE removed_at IS NULL;

CREATE FUNCTION reject_retired_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind text := 'icons';
  names text[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Asset writes require read committed isolation.' USING ERRCODE = '55000';
  END IF;
  -- Shared by old and new application binaries: protect the whole write
  -- transaction, not merely the request handler's acknowledgement.
  PERFORM pg_advisory_xact_lock_shared(74261080,hashtext(current_schema()));
  IF TG_TABLE_NAME = 'clan_logo_assets' THEN
    kind := 'branding';
    names := ARRAY[NEW.id::text || '.webp', NEW.favicon_id::text || '.png'];
  ELSIF TG_TABLE_NAME = 'submission_images' THEN
    kind := 'proofs';
    names := ARRAY[NEW.id::text || '.png'];
  ELSIF TG_TABLE_NAME = 'items' THEN
    names := ARRAY[NEW.icon_asset_id::text || '.png', substring(NEW.icon_path from '([a-f0-9-]{36}\.png)$')];
  ELSE
    names := ARRAY[NEW.id::text || '.png'];
  END IF;
  IF EXISTS (
    SELECT 1 FROM asset_retirements
    WHERE storage_kind = kind AND
      (file_name = ANY(names) OR file_name = ANY(ARRAY(SELECT n || '.tmp' FROM unnest(names) n)))
  ) THEN
    RAISE EXCEPTION 'Upload was retired; upload the image again.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_assets_retirement BEFORE INSERT OR UPDATE ON catalog_assets FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();
CREATE TRIGGER catalog_items_retirement BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();
CREATE TRIGGER logo_assets_retirement BEFORE INSERT OR UPDATE ON clan_logo_assets FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();
CREATE TRIGGER proof_assets_retirement BEFORE INSERT OR UPDATE ON submission_images FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();
