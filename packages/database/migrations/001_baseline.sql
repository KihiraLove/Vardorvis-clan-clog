-- First-release baseline: all pre-release development migrations consolidated.
-- Existing test volumes with migration 001_initial through 009_clue_taxonomy
-- MUST be discarded and recreated; no in-place migration is supported.
-- Keep subsequent release migrations additive and checksummed.

-- ===== 001_initial.sql =====
CREATE TABLE catalog_versions (
  id text PRIMARY KEY,
  source_url text NOT NULL,
  source_revision text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id integer PRIMARY KEY CHECK (id > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  icon_path text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE game_item_ids (
  game_item_id integer PRIMARY KEY CHECK (game_item_id > 0),
  item_id integer NOT NULL REFERENCES items(id)
);

CREATE TABLE pages (
  id text PRIMARY KEY,
  category text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order >= 0)
);

CREATE TABLE page_items (
  page_id text NOT NULL REFERENCES pages(id),
  item_id integer NOT NULL REFERENCES items(id),
  slot integer NOT NULL CHECK (slot >= 0),
  PRIMARY KEY (page_id, item_id),
  UNIQUE (page_id, slot)
);

CREATE TABLE submissions (
  id uuid PRIMARY KEY,
  discord_interaction_id text NOT NULL UNIQUE,
  discord_user_id text NOT NULL,
  discord_guild_id text NOT NULL,
  raw_item_text text NOT NULL CHECK (length(trim(raw_item_text)) BETWEEN 1 AND 200),
  item_id integer REFERENCES items(id),
  collector_name text NOT NULL CHECK (length(trim(collector_name)) BETWEEN 1 AND 80),
  collected_on date NOT NULL,
  date_source text NOT NULL CHECK (date_source IN ('submission_default', 'collector', 'admin')),
  proof_url text NOT NULL CHECK (length(proof_url) BETWEEN 1 AND 2048),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (status <> 'approved' OR item_id IS NOT NULL),
  CHECK (status = 'pending' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CHECK (status NOT IN ('rejected', 'revoked') OR (review_reason IS NOT NULL AND length(trim(review_reason)) > 0))
);

CREATE INDEX submissions_review_queue ON submissions(status, submitted_at);
CREATE INDEX submissions_item_approved ON submissions(item_id, collected_on) WHERE status = 'approved';

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  actor_discord_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('resolve', 'edit', 'approve', 'reject', 'revoke')),
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW collection_credits AS
SELECT id AS submission_id, item_id, collector_name, collected_on
FROM submissions
WHERE status = 'approved';

CREATE VIEW item_collection_state AS
SELECT i.id AS item_id, EXISTS (
  SELECT 1 FROM collection_credits c WHERE c.item_id = i.id
) AS collected
FROM items i;

-- ===== 002_world_modes.sql =====
-- Independent normal/hardcore logs share catalog identities, never collection credit.
ALTER TABLE submissions ADD COLUMN hardcore boolean NOT NULL DEFAULT false;

-- Fail for existing duplicate approvals rather than silently discarding any history.
-- Reconcile conflicting approvals explicitly before retrying this forward migration.
CREATE UNIQUE INDEX submissions_one_credit_per_world
  ON submissions(item_id, hardcore) WHERE status = 'approved';

CREATE TABLE site_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hardcore_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO site_settings(singleton) VALUES (true);

CREATE OR REPLACE VIEW collection_credits AS
SELECT id AS submission_id, item_id, collector_name, collected_on, hardcore
FROM submissions WHERE status = 'approved';

CREATE OR REPLACE VIEW item_collection_state AS
SELECT i.id AS item_id,
  EXISTS (SELECT 1 FROM collection_credits c WHERE c.item_id = i.id AND NOT c.hardcore) AS collected,
  EXISTS (SELECT 1 FROM collection_credits c WHERE c.item_id = i.id AND c.hardcore) AS hardcore_collected
FROM items i;

-- ===== 003_admin_auth.sql =====
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

-- ===== 004_bot_intake.sql =====
-- Immutable bot-intake payload/receipt enables replay even after catalog/review changes.
-- Existing historical submissions have no bot receipt, so reuse of their interaction IDs conflicts.
ALTER TABLE submissions
  ADD COLUMN intake_payload_hash text CHECK (intake_payload_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN intake_receipt jsonb,
  ADD CONSTRAINT intake_receipt_pair CHECK (
    (intake_payload_hash IS NULL AND intake_receipt IS NULL)
    OR (intake_payload_hash IS NOT NULL AND intake_receipt IS NOT NULL)
  );

-- Aliases are explicit, non-unique across canonical items: ambiguous inputs require review.
CREATE TABLE item_aliases (
  item_id integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 200),
  PRIMARY KEY (item_id, alias)
);
CREATE INDEX item_aliases_item ON item_aliases(item_id);

-- ===== 005_xp_events.sql =====
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

-- ===== 006_review_audit.sql =====
-- Preserve human-readable admin identity and per-action reason after sessions expire.
-- Historical rows retain a labelled fallback; never delete legacy audit history.
ALTER TABLE audit_events
  ADD COLUMN actor_name text NOT NULL DEFAULT 'Unknown administrator',
  ADD COLUMN reason text;
CREATE INDEX submissions_review_cursor
  ON submissions (submitted_at DESC, id DESC);

-- ===== 007_manual_submissions.sql =====
-- Admin-entered drops have no Discord interaction, user or guild.
-- Keep bot submissions unchanged and uniquely replayable by Discord interaction ID.
ALTER TABLE submissions
  ADD COLUMN source text NOT NULL DEFAULT 'discord'
    CHECK (source IN ('discord', 'manual')),
  ALTER COLUMN discord_interaction_id DROP NOT NULL,
  ALTER COLUMN discord_user_id DROP NOT NULL,
  ALTER COLUMN discord_guild_id DROP NOT NULL,
  DROP CONSTRAINT submissions_proof_url_check,
  ADD CONSTRAINT submissions_proof_by_source CHECK (
    length(proof_url) <= 2048
    AND (source = 'manual' OR length(proof_url) > 0)
  ),
  ADD CONSTRAINT submissions_source_provenance CHECK (
    (source = 'discord' AND discord_interaction_id IS NOT NULL
      AND discord_user_id IS NOT NULL AND discord_guild_id IS NOT NULL)
    OR (source = 'manual' AND discord_interaction_id IS NULL
      AND discord_user_id IS NULL AND discord_guild_id IS NULL)
  );

-- Preserve historical actions, adding immutable manual-creation provenance.
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_action_check,
  ADD CONSTRAINT audit_events_action_check
    CHECK (action IN ('create','resolve','edit','approve','reject','revoke'));

-- ===== 008_admin_catalog.sql =====
-- Preserve source identities while adding durable admin-owned catalog metadata.
CREATE SEQUENCE canonical_item_id_seq AS integer;
SELECT setval('canonical_item_id_seq', COALESCE((SELECT max(id) FROM items), 0) + 1, false);
ALTER TABLE items ALTER COLUMN id SET DEFAULT nextval('canonical_item_id_seq');
ALTER SEQUENCE canonical_item_id_seq OWNED BY items.id;
ALTER TABLE items ADD COLUMN origin text NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'manual'));
ALTER TABLE items ADD COLUMN overrides text[] NOT NULL DEFAULT '{}' CHECK (overrides <@ ARRAY['name', 'icon', 'pages']::text[]);
ALTER TABLE pages ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE pages ADD COLUMN order_origin text NOT NULL DEFAULT 'source' CHECK (order_origin IN ('source', 'manual'));
ALTER TABLE page_items ADD COLUMN origin text NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'manual'));

CREATE TABLE catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO catalog_state(singleton) VALUES(true);
CREATE TABLE catalog_assets (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 512),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 512),
  actor_discord_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  item_id integer UNIQUE REFERENCES items(id)
);
ALTER TABLE items ADD COLUMN icon_asset_id uuid UNIQUE REFERENCES catalog_assets(id);
CREATE TABLE catalog_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_discord_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'reorder', 'reconcile')),
  item_id integer REFERENCES items(id),
  page_id text REFERENCES pages(id),
  before_value jsonb,
  after_value jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_requests (
  actor_discord_id text NOT NULL,
  request_key text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_discord_id, request_key)
);

-- Revision triggers also cover future importers: membership changes invalidate stale editors.
CREATE FUNCTION bump_catalog_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE catalog_state SET version = version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE FUNCTION bump_page_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER page_version BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION bump_page_version();
CREATE FUNCTION bump_membership_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE pages SET version = version WHERE id = OLD.page_id; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.page_id <> OLD.page_id) THEN
    UPDATE pages SET version = version WHERE id = NEW.page_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER membership_version AFTER INSERT OR UPDATE OR DELETE ON page_items FOR EACH ROW EXECUTE FUNCTION bump_membership_page();
CREATE TRIGGER items_revision AFTER INSERT OR UPDATE OR DELETE ON items FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER pages_revision AFTER INSERT OR UPDATE OR DELETE ON pages FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER aliases_revision AFTER INSERT OR UPDATE OR DELETE ON game_item_ids FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();

-- ===== 009_clue_taxonomy.sql =====
-- Track a one-time, audited, source-preserving clue page correction.
-- Catalog membership changes run AFTER the pinned first import in bootstrap.
CREATE TABLE catalog_taxonomy_updates (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE catalog_audit DROP CONSTRAINT catalog_audit_action_check;
ALTER TABLE catalog_audit ADD CONSTRAINT catalog_audit_action_check
  CHECK (action IN ('create', 'reorder', 'reconcile', 'taxonomy'));
