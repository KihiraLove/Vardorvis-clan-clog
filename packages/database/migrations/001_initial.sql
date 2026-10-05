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
