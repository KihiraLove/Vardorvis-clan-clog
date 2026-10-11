-- Immutable raster logo/favicon pairs; old versions remain available to cached clients.
CREATE TABLE clan_logo_assets (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
  favicon_id uuid NOT NULL UNIQUE,
  favicon_sha256 text NOT NULL CHECK (favicon_sha256 ~ '^[a-f0-9]{64}$'),
  favicon_byte_size integer NOT NULL CHECK (favicon_byte_size BETWEEN 1 AND 2097152),
  favicon_width integer NOT NULL CHECK (favicon_width BETWEEN 1 AND 64),
  favicon_height integer NOT NULL CHECK (favicon_height BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clan_branding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  logo_asset_id uuid REFERENCES clan_logo_assets(id)
);
INSERT INTO clan_branding(singleton) VALUES(true);
CREATE TABLE clan_branding_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  old_logo_asset_id uuid REFERENCES clan_logo_assets(id),
  new_logo_asset_id uuid REFERENCES clan_logo_assets(id),
  version integer NOT NULL UNIQUE CHECK (version > 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
