-- Use generic install branding while preserving administrator-chosen clan names.
ALTER TABLE site_settings ALTER COLUMN clan_name SET DEFAULT 'Clan name';
WITH previous AS (
  SELECT * FROM site_settings
  WHERE clan_name='Vardorvis' AND NOT EXISTS (
    SELECT 1 FROM site_settings_audit WHERE old_clan_name IS DISTINCT FROM new_clan_name
  ) FOR UPDATE
), changed AS (
  UPDATE site_settings s SET clan_name='Clan name', version=s.version+1
  FROM previous p WHERE s.singleton=p.singleton RETURNING s.version
)
INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,
  old_clan_name,new_clan_name,old_public_copy,new_public_copy)
SELECT 'system:default-clan-name',p.hardcore_enabled,p.hardcore_enabled,c.version,
  p.clan_name,'Clan name',p.public_copy,p.public_copy FROM previous p CROSS JOIN changed c;
