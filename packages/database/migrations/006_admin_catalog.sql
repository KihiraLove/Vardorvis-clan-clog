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
