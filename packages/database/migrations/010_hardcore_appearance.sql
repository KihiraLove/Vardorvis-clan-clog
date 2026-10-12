-- Independent hardcore presentation starts as a snapshot of current regular branding.
-- The retired total caption is removed from current settings; audit history stays intact.
ALTER TABLE site_settings DROP CONSTRAINT site_settings_public_copy_check;
UPDATE site_settings SET public_copy=public_copy-'xpTotalCaption';
ALTER TABLE site_settings ALTER COLUMN public_copy SET DEFAULT
  '{"collectionTitle":"Clan Collection Log","collectionCaption":"Collected during BOTW events","xpTitle":"XP gained during SOTW events"}'::jsonb;
ALTER TABLE site_settings ADD CONSTRAINT site_settings_public_copy_check CHECK (
  jsonb_typeof(public_copy)='object' AND public_copy ?& ARRAY['collectionTitle','collectionCaption','xpTitle']
  AND public_copy-ARRAY['collectionTitle','collectionCaption','xpTitle']='{}'::jsonb
  AND jsonb_typeof(public_copy->'collectionTitle')='string' AND length(trim(public_copy->>'collectionTitle')) BETWEEN 1 AND 160
  AND jsonb_typeof(public_copy->'collectionCaption')='string' AND length(trim(public_copy->>'collectionCaption')) BETWEEN 1 AND 160
  AND jsonb_typeof(public_copy->'xpTitle')='string' AND length(trim(public_copy->>'xpTitle')) BETWEEN 1 AND 160
);
ALTER TABLE site_settings ADD COLUMN hardcore_name text,
  ADD COLUMN hardcore_copy jsonb;
UPDATE site_settings SET hardcore_name=clan_name, hardcore_copy=public_copy;
ALTER TABLE site_settings ALTER COLUMN hardcore_name SET NOT NULL,
  ALTER COLUMN hardcore_copy SET NOT NULL,
  ALTER COLUMN hardcore_name SET DEFAULT 'Clan name',
  ALTER COLUMN hardcore_copy SET DEFAULT '{"collectionTitle":"Clan Collection Log","collectionCaption":"Collected during BOTW events","xpTitle":"XP gained during SOTW events"}'::jsonb,
  ADD CONSTRAINT hardcore_name_valid CHECK(length(trim(hardcore_name)) BETWEEN 1 AND 80),
  ADD CONSTRAINT hardcore_copy_valid CHECK (
    jsonb_typeof(hardcore_copy)='object' AND hardcore_copy ?& ARRAY['collectionTitle','collectionCaption','xpTitle']
    AND hardcore_copy-ARRAY['collectionTitle','collectionCaption','xpTitle']='{}'::jsonb
    AND jsonb_typeof(hardcore_copy->'collectionTitle')='string' AND length(trim(hardcore_copy->>'collectionTitle')) BETWEEN 1 AND 160
    AND jsonb_typeof(hardcore_copy->'collectionCaption')='string' AND length(trim(hardcore_copy->>'collectionCaption')) BETWEEN 1 AND 160
    AND jsonb_typeof(hardcore_copy->'xpTitle')='string' AND length(trim(hardcore_copy->>'xpTitle')) BETWEEN 1 AND 160
  );
ALTER TABLE site_settings_audit ADD COLUMN old_hardcore_name text,
  ADD COLUMN new_hardcore_name text,
  ADD COLUMN old_hardcore_copy jsonb,
  ADD COLUMN new_hardcore_copy jsonb;
ALTER TABLE clan_branding ADD COLUMN hardcore_version integer NOT NULL DEFAULT 1 CHECK(hardcore_version>0),
  ADD COLUMN hardcore_logo_asset_id uuid REFERENCES clan_logo_assets(id);
UPDATE clan_branding SET hardcore_logo_asset_id=logo_asset_id;
ALTER TABLE clan_branding_audit ADD COLUMN hardcore boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT clan_branding_audit_version_key,
  ADD CONSTRAINT clan_branding_audit_mode_version UNIQUE(hardcore,version);
