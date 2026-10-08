-- Only hashes of browser credentials are stored. Discord access tokens are never persisted.
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  discord_user_id text NOT NULL,
  display_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE site_settings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_discord_id text NOT NULL,
  old_enabled boolean NOT NULL,
  new_enabled boolean NOT NULL,
  version integer NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Shared across API replicas; fixed-window limits bound unauthenticated OAuth traffic.
CREATE TABLE auth_rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);
