-- The API seeds one encrypted random key at first startup; never seed/reset it in SQL.
CREATE TABLE clan_api_keys (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  encrypted_key text NOT NULL,
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE clan_api_key_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  old_enabled boolean NOT NULL,
  new_enabled boolean NOT NULL,
  key_rotated boolean NOT NULL,
  version integer NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
