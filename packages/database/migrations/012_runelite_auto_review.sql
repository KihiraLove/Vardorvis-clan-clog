-- Seed the in-game name once, independently of subsequent visual clan renames.
CREATE TABLE runelite_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules)='object')
);
INSERT INTO runelite_settings(singleton,rules)
SELECT true,jsonb_build_object(
  'matchClanName',true,'clanName',clan_name,
  'worldPolicies',jsonb_build_object('f2p','review','pvp','review','members','review','hardcore','review'),
  'playerWhitelist','[]'::jsonb
) FROM site_settings WHERE singleton=true;
CREATE TABLE runelite_settings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  version integer NOT NULL UNIQUE,
  old_rules jsonb NOT NULL,
  new_rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
