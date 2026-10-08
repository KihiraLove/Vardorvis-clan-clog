-- Public XP tracks one aggregate event snapshot by WOM identity; no member-facing projection.
CREATE TABLE xp_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz
);
INSERT INTO xp_state(singleton) VALUES (true);

CREATE TABLE xp_events (
  competition_id bigint PRIMARY KEY CHECK (competition_id > 0),
  title text NOT NULL,
  source_url text NOT NULL,
  skills jsonb NOT NULL,
  gains jsonb NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  source_snapshot jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Store only hashed preview tokens. Each preview binds the admin and global revision.
CREATE TABLE xp_previews (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  actor_discord_id text NOT NULL,
  expected_revision text NOT NULL,
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX xp_previews_expiry ON xp_previews(expires_at);

-- Full request-key records survive preview expiry and instance restarts.
CREATE TABLE xp_import_history (
  id uuid PRIMARY KEY,
  actor_discord_id text NOT NULL,
  actor_name text NOT NULL,
  request_key uuid NOT NULL,
  token_hash text NOT NULL,
  expected_revision text NOT NULL,
  competition_id bigint NOT NULL REFERENCES xp_events(competition_id),
  title text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('applied','unchanged')),
  changes jsonb NOT NULL,
  resulting_revision text NOT NULL,
  acknowledged_corrections boolean NOT NULL DEFAULT false,
  UNIQUE(actor_discord_id,request_key)
);
CREATE INDEX xp_history_latest ON xp_import_history(imported_at DESC,id DESC);
