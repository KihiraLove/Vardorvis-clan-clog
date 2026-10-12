-- Configurable public copy and audited moderator lifecycle; histories keep stable actor IDs.
ALTER TABLE site_settings ADD COLUMN public_copy jsonb NOT NULL DEFAULT
  '{"collectionTitle":"Clan Collection Log","collectionCaption":"Collected during BOTW events","xpTitle":"XP gained during SOTW events","xpTotalCaption":"Across all recorded SOTW events"}'::jsonb
  CHECK (jsonb_typeof(public_copy)='object' AND public_copy ?& ARRAY['collectionTitle','collectionCaption','xpTitle','xpTotalCaption']
    AND jsonb_typeof(public_copy->'collectionTitle')='string' AND length(trim(public_copy->>'collectionTitle')) BETWEEN 1 AND 160
    AND jsonb_typeof(public_copy->'collectionCaption')='string' AND length(trim(public_copy->>'collectionCaption')) BETWEEN 1 AND 160
    AND jsonb_typeof(public_copy->'xpTitle')='string' AND length(trim(public_copy->>'xpTitle')) BETWEEN 1 AND 160
    AND jsonb_typeof(public_copy->'xpTotalCaption')='string' AND length(trim(public_copy->>'xpTotalCaption')) BETWEEN 1 AND 160);
ALTER TABLE site_settings_audit ADD COLUMN old_public_copy jsonb, ADD COLUMN new_public_copy jsonb;
ALTER TABLE staff_accounts ADD COLUMN disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_password_hash text,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT staff_accounts_admin_active CHECK (role <> 'admin' OR (NOT disabled AND deleted_at IS NULL)),
  ADD CONSTRAINT staff_accounts_deleted_disabled CHECK (deleted_at IS NULL OR disabled);
DROP INDEX staff_accounts_username;
CREATE UNIQUE INDEX staff_accounts_username ON staff_accounts(lower(username)) WHERE deleted_at IS NULL;
ALTER TABLE staff_account_audit DROP CONSTRAINT staff_account_audit_action_check,
  ADD CONSTRAINT staff_account_audit_action_check CHECK (action IN ('create','update','disable','enable','delete'));
ALTER TABLE catalog_audit DROP CONSTRAINT catalog_audit_action_check,
  ADD CONSTRAINT catalog_audit_action_check CHECK (action IN ('create','reorder','reconcile','taxonomy','delete'));
