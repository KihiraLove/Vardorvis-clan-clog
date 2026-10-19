-- All new generated images use WebP. Existing stored PNGs are deliberately not
-- transformed or served by this release; the owner is discarding test storage.
-- Preserve the retirement ledger, including old entries, and its write lock.
CREATE OR REPLACE FUNCTION reject_retired_asset() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
    names := ARRAY[NEW.id::text || '.webp', NEW.favicon_id::text || '.webp'];
  ELSIF TG_TABLE_NAME = 'submission_images' THEN
    kind := 'proofs';
    names := ARRAY[NEW.id::text || '.webp'];
  ELSIF TG_TABLE_NAME = 'items' THEN
    names := ARRAY[NEW.icon_asset_id::text || '.webp', substring(NEW.icon_path from '([a-f0-9-]{36}\.webp)$')];
  ELSE
    names := ARRAY[NEW.id::text || '.webp'];
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
$_$;

-- Bundled static icons have verified WebP counterparts. Preserve staff overrides,
-- original audit/receipt JSON and all collection history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM items WHERE icon_path ~ '^/catalog/items/[1-9][0-9]*\.png$') THEN
    UPDATE items SET icon_path = regexp_replace(icon_path, '\.png$', '.webp')
    WHERE icon_path ~ '^/catalog/items/[1-9][0-9]*\.png$';
  END IF;
END;
$$;

-- The only bundled snapshot change is its icon extension. Recognize that exact
-- previous snapshot so insert-only startup does not reject an upgraded catalog.
UPDATE catalog_versions SET id = 'sha256:752c0a56f48cf04b1d4387102c428e1961d022d6fd7a17761d740c850e887ee0'
WHERE id = 'sha256:1b71705bb061c341a42c79f5d010af4ae296d33f58cc52c331a680a50e263e32'
  AND source_url = 'https://templeosrs.com/api/collection-log/categories.php'
  AND source_revision = '25da8ab34b0e7a6cd5fe38f8615325a49712a5a20918779a4d0ef1f7072e5c34';
