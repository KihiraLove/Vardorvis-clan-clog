-- Clan Collection Log 1.0: complete fresh-install database setup.
-- Pre-release databases must be recreated; no development upgrade path is supported.
-- After release, append new checksummed migrations instead of editing this file.

CREATE FUNCTION advance_lifecycle_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE lifecycle_state SET version=version+1 WHERE singleton;
  RETURN NULL;
END;
$$;

CREATE FUNCTION advance_projection_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE projection_state SET version=version+1 WHERE resource=ANY(TG_ARGV);
  RETURN NULL;
END;
$$;

CREATE FUNCTION advance_review_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE review_state SET version = version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;

CREATE FUNCTION advance_xp_history_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE xp_state SET history_version = history_version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_catalog_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE catalog_state SET version = version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_membership_page() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    WITH affected AS (SELECT id FROM pages WHERE id IN(SELECT page_id FROM new_memberships) ORDER BY id FOR UPDATE)
    UPDATE pages p SET version=p.version FROM affected a WHERE p.id=a.id;
  ELSIF TG_OP='DELETE' THEN
    WITH affected AS (SELECT id FROM pages WHERE id IN(SELECT page_id FROM old_memberships) ORDER BY id FOR UPDATE)
    UPDATE pages p SET version=p.version FROM affected a WHERE p.id=a.id;
  ELSIF TG_OP='UPDATE' THEN
    WITH affected AS (SELECT id FROM pages WHERE id IN(SELECT page_id FROM old_memberships UNION SELECT page_id FROM new_memberships) ORDER BY id FOR UPDATE)
    UPDATE pages p SET version=p.version FROM affected a WHERE p.id=a.id;
  ELSE
    UPDATE pages SET version=version;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_page_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE FUNCTION preserve_archived_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Archived records must be retained.' USING ERRCODE='55000';
    END IF;
    IF NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Restore the archived record before editing.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION preserve_archived_schedule_pages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF EXISTS(SELECT 1 FROM collection_log_schedules WHERE id=OLD.schedule_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Archived schedule memberships must be retained.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS(SELECT 1 FROM collection_log_schedules WHERE id=NEW.schedule_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Restore the schedule before changing memberships.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION preserve_archived_xp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF EXISTS(SELECT 1 FROM wom_competitions WHERE competition_id=OLD.competition_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Archived XP contributions must be retained.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS(SELECT 1 FROM wom_competitions WHERE competition_id=NEW.competition_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Restore the competition before changing XP.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_retired_asset() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  kind text := 'icons';
  names text[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Asset writes require read committed isolation.' USING ERRCODE = '55000';
  END IF;
  -- Shared by old and new application binaries: protect the whole write
  -- transaction, not merely the request handler's acknowledgement.
  PERFORM pg_advisory_xact_lock_shared(74261080,hashtext(current_schema()));
  IF TG_TABLE_NAME = 'clan_logo_assets' THEN
    kind := 'branding';
    names := ARRAY[NEW.id::text || '.webp', NEW.favicon_id::text || '.png'];
  ELSIF TG_TABLE_NAME = 'submission_images' THEN
    kind := 'proofs';
    names := ARRAY[NEW.id::text || '.png'];
  ELSIF TG_TABLE_NAME = 'items' THEN
    names := ARRAY[NEW.icon_asset_id::text || '.png', substring(NEW.icon_path from '([a-f0-9-]{36}\.png)$')];
  ELSE
    names := ARRAY[NEW.id::text || '.png'];
  END IF;
  IF EXISTS (
    SELECT 1 FROM asset_retirements
    WHERE storage_kind = kind AND
      (file_name = ANY(names) OR file_name = ANY(ARRAY(SELECT n || '.tmp' FROM unnest(names) n)))
  ) THEN
    RAISE EXCEPTION 'Upload was retired; upload the image again.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$_$;

CREATE TABLE admin_sessions (
    token_hash text NOT NULL,
    discord_user_id text NOT NULL,
    display_name text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid,
    credential_version integer,
    CONSTRAINT admin_sessions_account_version CHECK ((((account_id IS NULL) AND (credential_version IS NULL)) OR ((account_id IS NOT NULL) AND (credential_version IS NOT NULL) AND (credential_version > 0)))),
    CONSTRAINT admin_sessions_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE asset_retirements (
    storage_kind text NOT NULL,
    file_name text NOT NULL,
    retired_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT asset_retirements_file_name_check CHECK ((file_name ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|webp)(\.tmp)?$'::text)),
    CONSTRAINT asset_retirements_storage_kind_check CHECK ((storage_kind = ANY (ARRAY['icons'::text, 'branding'::text, 'proofs'::text])))
);

CREATE TABLE audit_events (
    id bigint NOT NULL,
    submission_id uuid NOT NULL,
    actor_discord_id text NOT NULL,
    action text NOT NULL,
    old_values jsonb NOT NULL,
    new_values jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_name text DEFAULT 'Unknown administrator'::text NOT NULL,
    reason text,
    CONSTRAINT audit_events_action_check CHECK ((action = ANY (ARRAY['create'::text, 'resolve'::text, 'edit'::text, 'approve'::text, 'reject'::text, 'revoke'::text])))
);

ALTER TABLE audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE auth_rate_limits (
    key_hash text NOT NULL,
    attempts integer NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE items (
    id integer NOT NULL,
    name text NOT NULL,
    icon_path text,
    active boolean DEFAULT true NOT NULL,
    origin text DEFAULT 'source'::text NOT NULL,
    overrides text[] DEFAULT '{}'::text[] NOT NULL,
    icon_asset_id uuid,
    CONSTRAINT items_id_check CHECK ((id > 0)),
    CONSTRAINT items_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT items_origin_check CHECK ((origin = ANY (ARRAY['source'::text, 'manual'::text]))),
    CONSTRAINT items_overrides_check CHECK ((overrides <@ ARRAY['name'::text, 'icon'::text, 'pages'::text, 'game_ids'::text]))
);

CREATE SEQUENCE canonical_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE canonical_item_id_seq OWNED BY items.id;

CREATE TABLE catalog_assets (
    id uuid NOT NULL,
    sha256 text NOT NULL,
    byte_size integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    actor_discord_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    item_id integer,
    CONSTRAINT catalog_assets_byte_size_check CHECK (((byte_size >= 1) AND (byte_size <= 2097152))),
    CONSTRAINT catalog_assets_height_check CHECK (((height >= 1) AND (height <= 512))),
    CONSTRAINT catalog_assets_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT catalog_assets_width_check CHECK (((width >= 1) AND (width <= 512)))
);

CREATE TABLE catalog_audit (
    id bigint NOT NULL,
    actor_discord_id text NOT NULL,
    action text NOT NULL,
    item_id integer,
    page_id text,
    before_value jsonb,
    after_value jsonb NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_audit_action_check CHECK ((action = ANY (ARRAY['create'::text, 'reorder'::text, 'reconcile'::text, 'taxonomy'::text, 'delete'::text, 'create_page'::text, 'delete_page'::text, 'reorder_pages'::text, 'create_section'::text, 'edit_section'::text, 'delete_section'::text, 'reorder_sections'::text, 'edit_page'::text, 'edit_item'::text, 'attach_item'::text, 'delete_item'::text])))
);

ALTER TABLE catalog_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog_page_requests (
    actor_discord_id text NOT NULL,
    request_key text NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE catalog_requests (
    actor_discord_id text NOT NULL,
    request_key text NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE catalog_section_requests (
    actor_discord_id text NOT NULL,
    request_key text NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE catalog_sections (
    id text NOT NULL,
    name text NOT NULL,
    sort_order integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT catalog_sections_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 200))),
    CONSTRAINT catalog_sections_sort_order_check CHECK ((sort_order >= 0))
);

CREATE TABLE catalog_state (
    singleton boolean DEFAULT true NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT catalog_state_singleton_check CHECK (singleton),
    CONSTRAINT catalog_state_version_check CHECK ((version > 0))
);

CREATE TABLE catalog_taxonomy_updates (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE catalog_versions (
    id text NOT NULL,
    source_url text NOT NULL,
    source_revision text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE discord_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    version integer NOT NULL DEFAULT 1 CHECK(version > 0),
    settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
    credentials text NOT NULL
);

CREATE TABLE discord_settings_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid NOT NULL,
    version integer NOT NULL UNIQUE CHECK(version > 1),
    old_settings jsonb NOT NULL,
    new_settings jsonb NOT NULL,
    token_changed boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clan_api_key_audit (
    id bigint NOT NULL,
    actor_id text NOT NULL,
    old_enabled boolean NOT NULL,
    new_enabled boolean NOT NULL,
    key_rotated boolean NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE clan_api_key_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME clan_api_key_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE clan_api_keys (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    encrypted_key text NOT NULL,
    key_hash text NOT NULL,
    CONSTRAINT clan_api_keys_key_hash_check CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT clan_api_keys_singleton_check CHECK (singleton),
    CONSTRAINT clan_api_keys_version_check CHECK ((version > 0))
);

CREATE TABLE clan_branding (
    singleton boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    logo_asset_id uuid,
    hardcore_version integer DEFAULT 1 NOT NULL,
    hardcore_logo_asset_id uuid,
    CONSTRAINT clan_branding_hardcore_version_check CHECK ((hardcore_version > 0)),
    CONSTRAINT clan_branding_singleton_check CHECK (singleton),
    CONSTRAINT clan_branding_version_check CHECK ((version > 0))
);

CREATE TABLE clan_branding_audit (
    id bigint NOT NULL,
    actor_id text NOT NULL,
    old_logo_asset_id uuid,
    new_logo_asset_id uuid,
    version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hardcore boolean DEFAULT false NOT NULL,
    CONSTRAINT clan_branding_audit_version_check CHECK ((version > 1))
);

ALTER TABLE clan_branding_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME clan_branding_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE clan_logo_assets (
    id uuid NOT NULL,
    sha256 text NOT NULL,
    byte_size integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    favicon_id uuid NOT NULL,
    favicon_sha256 text NOT NULL,
    favicon_byte_size integer NOT NULL,
    favicon_width integer NOT NULL,
    favicon_height integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clan_logo_assets_byte_size_check CHECK (((byte_size >= 1) AND (byte_size <= 10485760))),
    CONSTRAINT clan_logo_assets_favicon_byte_size_check CHECK (((favicon_byte_size >= 1) AND (favicon_byte_size <= 2097152))),
    CONSTRAINT clan_logo_assets_favicon_height_check CHECK (((favicon_height >= 1) AND (favicon_height <= 64))),
    CONSTRAINT clan_logo_assets_favicon_sha256_check CHECK ((favicon_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT clan_logo_assets_favicon_width_check CHECK (((favicon_width >= 1) AND (favicon_width <= 64))),
    CONSTRAINT clan_logo_assets_height_check CHECK (((height >= 1) AND (height <= 1024))),
    CONSTRAINT clan_logo_assets_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT clan_logo_assets_width_check CHECK (((width >= 1) AND (width <= 1024)))
);

CREATE TABLE submissions (
    id uuid NOT NULL,
    discord_interaction_id text,
    discord_user_id text,
    discord_guild_id text,
    raw_item_text text NOT NULL,
    item_id integer,
    collector_name text NOT NULL,
    collected_on date NOT NULL,
    date_source text NOT NULL,
    proof_url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    review_reason text,
    version integer DEFAULT 1 NOT NULL,
    hardcore boolean DEFAULT false NOT NULL,
    intake_payload_hash text,
    intake_receipt jsonb,
    source text DEFAULT 'discord'::text NOT NULL,
    proof_image_id uuid,
    submitted_clan_name text,
    game_item_id integer,
    submitted_world_types text[],
    review_note text DEFAULT ''::text NOT NULL,
    chat_message text,
    CONSTRAINT intake_receipt_pair CHECK ((((intake_payload_hash IS NULL) AND (intake_receipt IS NULL)) OR ((intake_payload_hash IS NOT NULL) AND (intake_receipt IS NOT NULL)))),
    CONSTRAINT submissions_chat_message CHECK (((chat_message IS NULL) OR ((source = 'runelite'::text) AND ((octet_length(chat_message) >= 1) AND (octet_length(chat_message) <= 8192)) AND (length(TRIM(BOTH FROM chat_message)) > 0)))),
    CONSTRAINT submissions_check CHECK (((status <> 'approved'::text) OR (item_id IS NOT NULL))),
    CONSTRAINT submissions_check1 CHECK (((status = 'pending'::text) OR ((reviewed_at IS NOT NULL) AND (reviewed_by IS NOT NULL)))),
    CONSTRAINT submissions_check2 CHECK (((status <> ALL (ARRAY['rejected'::text, 'revoked'::text])) OR ((review_reason IS NOT NULL) AND (length(TRIM(BOTH FROM review_reason)) > 0)))),
    CONSTRAINT submissions_check3 CHECK (((submitted_world_types IS NULL) OR ((source = 'runelite'::text) AND (cardinality(submitted_world_types) <= 32) AND (array_position(submitted_world_types, NULL::text) IS NULL)))),
    CONSTRAINT submissions_collector_name_check CHECK (((length(TRIM(BOTH FROM collector_name)) >= 1) AND (length(TRIM(BOTH FROM collector_name)) <= 80))),
    CONSTRAINT submissions_date_source_check CHECK ((date_source = ANY (ARRAY['submission_default'::text, 'collector'::text, 'admin'::text]))),
    CONSTRAINT submissions_game_item_id_check CHECK ((game_item_id > 0)),
    CONSTRAINT submissions_intake_payload_hash_check CHECK ((intake_payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT submissions_proof_by_source CHECK (((length(proof_url) <= 2048) AND ((source = 'manual'::text) OR ((source = 'discord'::text) AND (length(proof_url) > 0)) OR ((source = 'runelite'::text) AND ((proof_image_id IS NOT NULL) OR (chat_message IS NOT NULL)))))),
    CONSTRAINT submissions_raw_item_text_check CHECK (((length(TRIM(BOTH FROM raw_item_text)) >= 1) AND (length(TRIM(BOTH FROM raw_item_text)) <= 200))),
    CONSTRAINT submissions_review_note_check CHECK ((length(review_note) <= 1000)),
    CONSTRAINT submissions_runelite_provenance CHECK (((source <> 'runelite'::text) OR ((game_item_id IS NOT NULL) AND (submitted_clan_name IS NOT NULL) AND ((length(TRIM(BOTH FROM submitted_clan_name)) >= 1) AND (length(TRIM(BOTH FROM submitted_clan_name)) <= 80))))),
    CONSTRAINT submissions_source_check CHECK ((source = ANY (ARRAY['discord'::text, 'manual'::text, 'runelite'::text]))),
    CONSTRAINT submissions_source_provenance CHECK ((((source = 'discord'::text) AND (discord_interaction_id IS NOT NULL) AND (discord_user_id IS NOT NULL) AND (discord_guild_id IS NOT NULL)) OR ((source = ANY (ARRAY['manual'::text, 'runelite'::text])) AND (discord_interaction_id IS NULL) AND (discord_user_id IS NULL) AND (discord_guild_id IS NULL)))),
    CONSTRAINT submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'revoked'::text]))),
    CONSTRAINT submissions_version_check CHECK ((version > 0))
);

CREATE VIEW collection_credits AS
 SELECT id AS submission_id,
    item_id,
    collector_name,
    collected_on,
    hardcore
   FROM submissions
  WHERE (status = 'approved'::text);

CREATE TABLE collection_log_schedule_pages (
    schedule_id uuid NOT NULL,
    page_id text NOT NULL
);

CREATE TABLE collection_log_schedules (
    id uuid NOT NULL,
    title text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT collection_log_schedules_check CHECK ((ends_at > starts_at)),
    CONSTRAINT collection_log_schedules_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 100))),
    CONSTRAINT schedule_archive_ended CHECK (((archived_at IS NULL) OR (archived_at >= ends_at)))
);

CREATE TABLE collection_schedule_audit (
    id bigint NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    action text NOT NULL,
    version integer NOT NULL,
    old_values jsonb NOT NULL,
    new_values jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_schedule_audit_action_check CHECK ((action = ANY (ARRAY['enable'::text, 'disable'::text, 'create'::text, 'edit'::text, 'delete'::text])))
);

ALTER TABLE collection_schedule_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME collection_schedule_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE collection_scheduling (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT collection_scheduling_singleton_check CHECK (singleton),
    CONSTRAINT collection_scheduling_version_check CHECK ((version > 0))
);

CREATE TABLE competition_import_history (
    id uuid NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    request_key uuid NOT NULL,
    request_hash text NOT NULL,
    competition_id bigint NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    old_values jsonb,
    new_values jsonb NOT NULL,
    receipt jsonb NOT NULL,
    CONSTRAINT competition_import_history_kind_check CHECK ((kind = ANY (ARRAY['SKILL'::text, 'ACTIVITY'::text])))
);

CREATE TABLE competition_previews (
    token_hash text NOT NULL,
    actor_id text NOT NULL,
    expected_revision text NOT NULL,
    schedule_revision text NOT NULL,
    snapshot jsonb NOT NULL,
    page_ids text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT competition_previews_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE game_item_ids (
    game_item_id integer NOT NULL,
    item_id integer NOT NULL,
    CONSTRAINT game_item_ids_game_item_id_check CHECK ((game_item_id > 0))
);

CREATE TABLE item_aliases (
    item_id integer NOT NULL,
    alias text NOT NULL,
    CONSTRAINT item_aliases_alias_check CHECK (((length(TRIM(BOTH FROM alias)) >= 1) AND (length(TRIM(BOTH FROM alias)) <= 200)))
);

CREATE VIEW item_collection_state AS
 SELECT id AS item_id,
    (EXISTS ( SELECT 1
           FROM collection_credits c
          WHERE ((c.item_id = i.id) AND (NOT c.hardcore)))) AS collected,
    (EXISTS ( SELECT 1
           FROM collection_credits c
          WHERE ((c.item_id = i.id) AND c.hardcore))) AS hardcore_collected
   FROM items i;

CREATE TABLE lifecycle_archive_audit (
    id uuid NOT NULL,
    resource text NOT NULL,
    resource_id text NOT NULL,
    action text NOT NULL,
    actor_name text NOT NULL,
    reason text NOT NULL,
    old_values jsonb NOT NULL,
    new_values jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT lifecycle_archive_audit_action_check CHECK ((action = ANY (ARRAY['archive'::text, 'restore'::text]))),
    CONSTRAINT lifecycle_archive_audit_actor_name_check CHECK (((length(TRIM(BOTH FROM actor_name)) >= 1) AND (length(TRIM(BOTH FROM actor_name)) <= 80))),
    CONSTRAINT lifecycle_archive_audit_reason_check CHECK (((length(TRIM(BOTH FROM reason)) >= 1) AND (length(TRIM(BOTH FROM reason)) <= 1000))),
    CONSTRAINT lifecycle_archive_audit_resource_check CHECK ((resource = ANY (ARRAY['schedules'::text, 'competitions'::text])))
);

CREATE TABLE lifecycle_state (
    singleton boolean DEFAULT true NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT lifecycle_state_singleton_check CHECK (singleton),
    CONSTRAINT lifecycle_state_version_check CHECK ((version > 0))
);

CREATE TABLE manual_submission_requests (
    actor_id text NOT NULL,
    request_key uuid NOT NULL,
    payload_hash text NOT NULL,
    submission_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT manual_submission_requests_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE page_items (
    page_id text NOT NULL,
    item_id integer NOT NULL,
    slot integer NOT NULL,
    origin text DEFAULT 'source'::text NOT NULL,
    CONSTRAINT page_items_origin_check CHECK ((origin = ANY (ARRAY['source'::text, 'manual'::text]))),
    CONSTRAINT page_items_slot_check CHECK ((slot >= 0))
);

CREATE TABLE pages (
    id text NOT NULL,
    category text NOT NULL,
    name text NOT NULL,
    sort_order integer NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    order_origin text DEFAULT 'source'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    position_origin text DEFAULT 'source'::text NOT NULL,
    CONSTRAINT pages_order_origin_check CHECK ((order_origin = ANY (ARRAY['source'::text, 'manual'::text]))),
    CONSTRAINT pages_position_origin_check CHECK ((position_origin = ANY (ARRAY['source'::text, 'manual'::text]))),
    CONSTRAINT pages_sort_order_check CHECK ((sort_order >= 0)),
    CONSTRAINT pages_version_check CHECK ((version > 0))
);

CREATE TABLE projection_state (
    resource text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT projection_state_resource_check CHECK ((resource = ANY (ARRAY['catalog'::text, 'collections'::text, 'matches'::text, 'xp'::text, 'activities'::text]))),
    CONSTRAINT projection_state_version_check CHECK ((version > 0))
);

CREATE TABLE review_state (
    singleton boolean DEFAULT true NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT review_state_singleton_check CHECK (singleton),
    CONSTRAINT review_state_version_check CHECK ((version > 0))
);

CREATE TABLE runelite_drop_events (
    submission_id uuid NOT NULL,
    player_key text NOT NULL,
    item_id integer NOT NULL,
    hardcore boolean NOT NULL,
    first_received_at timestamp with time zone NOT NULL,
    receipt jsonb NOT NULL
);

CREATE TABLE runelite_settings (
    singleton boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    rules jsonb NOT NULL,
    CONSTRAINT runelite_settings_rules_check CHECK ((jsonb_typeof(rules) = 'object'::text)),
    CONSTRAINT runelite_settings_singleton_check CHECK (singleton),
    CONSTRAINT runelite_settings_version_check CHECK ((version > 0))
);

CREATE TABLE runelite_settings_audit (
    id bigint NOT NULL,
    actor_id text NOT NULL,
    version integer NOT NULL,
    old_rules jsonb NOT NULL,
    new_rules jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE runelite_settings_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME runelite_settings_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE runelite_submission_requests (
    request_key uuid NOT NULL,
    payload_hash text NOT NULL,
    submission_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runelite_submission_requests_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE site_settings (
    singleton boolean DEFAULT true NOT NULL,
    hardcore_enabled boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    clan_name text DEFAULT 'Clan name'::text NOT NULL,
    public_copy jsonb DEFAULT '{"xpTitle": "XP gained during SOTW events", "collectionTitle": "Clan Collection Log", "collectionCaption": "Collected during BOTW events"}'::jsonb NOT NULL,
    hardcore_name text DEFAULT 'Clan name'::text NOT NULL,
    hardcore_copy jsonb DEFAULT '{"xpTitle": "XP gained during SOTW events", "collectionTitle": "Clan Collection Log", "collectionCaption": "Collected during BOTW events"}'::jsonb NOT NULL,
    CONSTRAINT hardcore_copy_valid CHECK (((jsonb_typeof(hardcore_copy) = 'object'::text) AND (hardcore_copy ?& ARRAY['collectionTitle'::text, 'collectionCaption'::text, 'xpTitle'::text]) AND ((hardcore_copy - ARRAY['collectionTitle'::text, 'collectionCaption'::text, 'xpTitle'::text]) = '{}'::jsonb) AND (jsonb_typeof((hardcore_copy -> 'collectionTitle'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (hardcore_copy ->> 'collectionTitle'::text))) >= 1) AND (length(TRIM(BOTH FROM (hardcore_copy ->> 'collectionTitle'::text))) <= 160)) AND (jsonb_typeof((hardcore_copy -> 'collectionCaption'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (hardcore_copy ->> 'collectionCaption'::text))) >= 1) AND (length(TRIM(BOTH FROM (hardcore_copy ->> 'collectionCaption'::text))) <= 160)) AND (jsonb_typeof((hardcore_copy -> 'xpTitle'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (hardcore_copy ->> 'xpTitle'::text))) >= 1) AND (length(TRIM(BOTH FROM (hardcore_copy ->> 'xpTitle'::text))) <= 160)))),
    CONSTRAINT hardcore_name_valid CHECK (((length(TRIM(BOTH FROM hardcore_name)) >= 1) AND (length(TRIM(BOTH FROM hardcore_name)) <= 80))),
    CONSTRAINT site_settings_clan_name_check CHECK (((clan_name = TRIM(BOTH FROM clan_name)) AND ((length(clan_name) >= 1) AND (length(clan_name) <= 80)))),
    CONSTRAINT site_settings_public_copy_check CHECK (((jsonb_typeof(public_copy) = 'object'::text) AND (public_copy ?& ARRAY['collectionTitle'::text, 'collectionCaption'::text, 'xpTitle'::text]) AND ((public_copy - ARRAY['collectionTitle'::text, 'collectionCaption'::text, 'xpTitle'::text]) = '{}'::jsonb) AND (jsonb_typeof((public_copy -> 'collectionTitle'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (public_copy ->> 'collectionTitle'::text))) >= 1) AND (length(TRIM(BOTH FROM (public_copy ->> 'collectionTitle'::text))) <= 160)) AND (jsonb_typeof((public_copy -> 'collectionCaption'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (public_copy ->> 'collectionCaption'::text))) >= 1) AND (length(TRIM(BOTH FROM (public_copy ->> 'collectionCaption'::text))) <= 160)) AND (jsonb_typeof((public_copy -> 'xpTitle'::text)) = 'string'::text) AND ((length(TRIM(BOTH FROM (public_copy ->> 'xpTitle'::text))) >= 1) AND (length(TRIM(BOTH FROM (public_copy ->> 'xpTitle'::text))) <= 160)))),
    CONSTRAINT site_settings_singleton_check CHECK (singleton),
    CONSTRAINT site_settings_version_check CHECK ((version > 0))
);

CREATE TABLE site_settings_audit (
    id bigint NOT NULL,
    actor_discord_id text NOT NULL,
    old_enabled boolean NOT NULL,
    new_enabled boolean NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    old_clan_name text,
    new_clan_name text,
    old_public_copy jsonb,
    new_public_copy jsonb,
    old_hardcore_name text,
    new_hardcore_name text,
    old_hardcore_copy jsonb,
    new_hardcore_copy jsonb
);

ALTER TABLE site_settings_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site_settings_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE staff_account_audit (
    id bigint NOT NULL,
    actor_id uuid NOT NULL,
    account_id uuid NOT NULL,
    action text NOT NULL,
    username text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_account_audit_action_check CHECK ((action = ANY (ARRAY['create'::text, 'update'::text, 'disable'::text, 'enable'::text, 'delete'::text])))
);

CREATE SEQUENCE staff_account_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE staff_account_audit_id_seq OWNED BY staff_account_audit.id;

CREATE TABLE staff_accounts (
    id uuid NOT NULL,
    username text NOT NULL,
    role text NOT NULL,
    password_hash text NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    disabled_password_hash text,
    deleted_at timestamp with time zone,
    CONSTRAINT staff_accounts_admin_active CHECK (((role <> 'admin'::text) OR ((NOT disabled) AND (deleted_at IS NULL)))),
    CONSTRAINT staff_accounts_credential_version_check CHECK ((credential_version > 0)),
    CONSTRAINT staff_accounts_deleted_disabled CHECK (((deleted_at IS NULL) OR disabled)),
    CONSTRAINT staff_accounts_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'moderator'::text]))),
    CONSTRAINT staff_accounts_username_check CHECK ((username ~ '^[A-Za-z0-9_.-]{3,32}$'::text))
);

CREATE TABLE submission_filter_audit (
    id uuid NOT NULL,
    actor_id text NOT NULL,
    version integer NOT NULL,
    old_filter_collected boolean NOT NULL,
    new_filter_collected boolean NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE submission_filter_settings (
    singleton boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    filter_collected boolean DEFAULT false NOT NULL,
    CONSTRAINT submission_filter_settings_singleton_check CHECK (singleton),
    CONSTRAINT submission_filter_settings_version_check CHECK ((version > 0))
);

CREATE TABLE submission_images (
    id uuid NOT NULL,
    sha256 text NOT NULL,
    byte_size integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submission_images_byte_size_check CHECK (((byte_size >= 1) AND (byte_size <= 10485760))),
    CONSTRAINT submission_images_height_check CHECK (((height >= 1) AND (height <= 8192))),
    CONSTRAINT submission_images_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT submission_images_width_check CHECK (((width >= 1) AND (width <= 8192)))
);

CREATE TABLE wom_competitions (
    competition_id bigint NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    source_url text NOT NULL,
    metrics jsonb NOT NULL,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    schedule_id uuid,
    schedule_created boolean DEFAULT false NOT NULL,
    results_imported_at timestamp with time zone,
    activity_results jsonb,
    source_hash text,
    archived_at timestamp with time zone,
    CONSTRAINT competition_archive_ended CHECK (((archived_at IS NULL) OR (archived_at >= ends_at))),
    CONSTRAINT wom_competitions_check CHECK ((ends_at > starts_at)),
    CONSTRAINT wom_competitions_check1 CHECK (((activity_results IS NULL) OR ((kind = 'ACTIVITY'::text) AND (results_imported_at IS NOT NULL)))),
    CONSTRAINT wom_competitions_competition_id_check CHECK ((competition_id > 0)),
    CONSTRAINT wom_competitions_kind_check CHECK ((kind = ANY (ARRAY['SKILL'::text, 'ACTIVITY'::text]))),
    CONSTRAINT wom_competitions_metrics_check CHECK (((jsonb_typeof(metrics) = 'array'::text) AND (jsonb_array_length(metrics) > 0))),
    CONSTRAINT wom_competitions_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)))
);

CREATE TABLE xp_events (
    competition_id bigint NOT NULL,
    title text NOT NULL,
    source_url text NOT NULL,
    skills jsonb NOT NULL,
    gains jsonb NOT NULL,
    source_hash text NOT NULL,
    source_snapshot jsonb NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'SKILL'::text NOT NULL,
    CONSTRAINT xp_events_competition_id_check CHECK ((competition_id > 0)),
    CONSTRAINT xp_events_kind_check CHECK ((kind = 'SKILL'::text)),
    CONSTRAINT xp_events_source_hash_check CHECK ((source_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE xp_import_history (
    id uuid NOT NULL,
    actor_discord_id text NOT NULL,
    actor_name text NOT NULL,
    request_key uuid NOT NULL,
    token_hash text NOT NULL,
    expected_revision text NOT NULL,
    competition_id bigint NOT NULL,
    title text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text NOT NULL,
    changes jsonb NOT NULL,
    resulting_revision text NOT NULL,
    acknowledged_corrections boolean DEFAULT false NOT NULL,
    CONSTRAINT xp_import_history_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'unchanged'::text])))
);

CREATE TABLE xp_previews (
    token_hash text NOT NULL,
    actor_discord_id text NOT NULL,
    expected_revision text NOT NULL,
    snapshot jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT xp_previews_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE xp_state (
    singleton boolean DEFAULT true NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone,
    history_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT xp_state_history_version_check CHECK ((history_version > 0)),
    CONSTRAINT xp_state_singleton_check CHECK (singleton),
    CONSTRAINT xp_state_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY items ALTER COLUMN id SET DEFAULT nextval('canonical_item_id_seq'::regclass);

ALTER TABLE ONLY staff_account_audit ALTER COLUMN id SET DEFAULT nextval('staff_account_audit_id_seq'::regclass);

ALTER TABLE ONLY admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY asset_retirements
    ADD CONSTRAINT asset_retirements_pkey PRIMARY KEY (storage_kind, file_name);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (key_hash);

ALTER TABLE ONLY catalog_assets
    ADD CONSTRAINT catalog_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_audit
    ADD CONSTRAINT catalog_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_page_requests
    ADD CONSTRAINT catalog_page_requests_pkey PRIMARY KEY (actor_discord_id, request_key);

ALTER TABLE ONLY catalog_requests
    ADD CONSTRAINT catalog_requests_pkey PRIMARY KEY (actor_discord_id, request_key);

ALTER TABLE ONLY catalog_section_requests
    ADD CONSTRAINT catalog_section_requests_pkey PRIMARY KEY (actor_discord_id, request_key);

ALTER TABLE ONLY catalog_sections
    ADD CONSTRAINT catalog_sections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_state
    ADD CONSTRAINT catalog_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY catalog_taxonomy_updates
    ADD CONSTRAINT catalog_taxonomy_updates_pkey PRIMARY KEY (name);

ALTER TABLE ONLY catalog_versions
    ADD CONSTRAINT catalog_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY clan_api_key_audit
    ADD CONSTRAINT clan_api_key_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY clan_api_key_audit
    ADD CONSTRAINT clan_api_key_audit_version_key UNIQUE (version);

ALTER TABLE ONLY clan_api_keys
    ADD CONSTRAINT clan_api_keys_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY clan_branding_audit
    ADD CONSTRAINT clan_branding_audit_mode_version UNIQUE (hardcore, version);

ALTER TABLE ONLY clan_branding_audit
    ADD CONSTRAINT clan_branding_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY clan_branding
    ADD CONSTRAINT clan_branding_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY clan_logo_assets
    ADD CONSTRAINT clan_logo_assets_favicon_id_key UNIQUE (favicon_id);

ALTER TABLE ONLY clan_logo_assets
    ADD CONSTRAINT clan_logo_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY collection_log_schedule_pages
    ADD CONSTRAINT collection_log_schedule_pages_pkey PRIMARY KEY (schedule_id, page_id);

ALTER TABLE ONLY collection_log_schedules
    ADD CONSTRAINT collection_log_schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY collection_schedule_audit
    ADD CONSTRAINT collection_schedule_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY collection_schedule_audit
    ADD CONSTRAINT collection_schedule_audit_version_key UNIQUE (version);

ALTER TABLE ONLY collection_scheduling
    ADD CONSTRAINT collection_scheduling_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY competition_import_history
    ADD CONSTRAINT competition_import_history_actor_id_request_key_key UNIQUE (actor_id, request_key);

ALTER TABLE ONLY competition_import_history
    ADD CONSTRAINT competition_import_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY competition_previews
    ADD CONSTRAINT competition_previews_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY game_item_ids
    ADD CONSTRAINT game_item_ids_pkey PRIMARY KEY (game_item_id);

ALTER TABLE ONLY item_aliases
    ADD CONSTRAINT item_aliases_pkey PRIMARY KEY (item_id, alias);

ALTER TABLE ONLY items
    ADD CONSTRAINT items_icon_asset_id_key UNIQUE (icon_asset_id);

ALTER TABLE ONLY items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY lifecycle_archive_audit
    ADD CONSTRAINT lifecycle_archive_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY lifecycle_state
    ADD CONSTRAINT lifecycle_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY manual_submission_requests
    ADD CONSTRAINT manual_submission_requests_pkey PRIMARY KEY (actor_id, request_key);

ALTER TABLE ONLY page_items
    ADD CONSTRAINT page_items_page_id_slot_key UNIQUE (page_id, slot);

ALTER TABLE ONLY page_items
    ADD CONSTRAINT page_items_pkey PRIMARY KEY (page_id, item_id);

ALTER TABLE ONLY pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY projection_state
    ADD CONSTRAINT projection_state_pkey PRIMARY KEY (resource);

ALTER TABLE ONLY review_state
    ADD CONSTRAINT review_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY runelite_drop_events
    ADD CONSTRAINT runelite_drop_events_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY runelite_settings_audit
    ADD CONSTRAINT runelite_settings_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY runelite_settings_audit
    ADD CONSTRAINT runelite_settings_audit_version_key UNIQUE (version);

ALTER TABLE ONLY runelite_settings
    ADD CONSTRAINT runelite_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY runelite_submission_requests
    ADD CONSTRAINT runelite_submission_requests_pkey PRIMARY KEY (request_key);

ALTER TABLE ONLY site_settings_audit
    ADD CONSTRAINT site_settings_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_settings_audit
    ADD CONSTRAINT site_settings_audit_version_key UNIQUE (version);

ALTER TABLE ONLY site_settings
    ADD CONSTRAINT site_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY staff_account_audit
    ADD CONSTRAINT staff_account_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY staff_accounts
    ADD CONSTRAINT staff_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submission_filter_audit
    ADD CONSTRAINT submission_filter_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submission_filter_audit
    ADD CONSTRAINT submission_filter_audit_version_key UNIQUE (version);

ALTER TABLE ONLY submission_filter_settings
    ADD CONSTRAINT submission_filter_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY submission_images
    ADD CONSTRAINT submission_images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_discord_interaction_id_key UNIQUE (discord_interaction_id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY wom_competitions
    ADD CONSTRAINT wom_competitions_pkey PRIMARY KEY (competition_id);

ALTER TABLE ONLY wom_competitions
    ADD CONSTRAINT wom_kind_identity UNIQUE (competition_id, kind);

ALTER TABLE ONLY xp_events
    ADD CONSTRAINT xp_events_pkey PRIMARY KEY (competition_id);

ALTER TABLE ONLY xp_import_history
    ADD CONSTRAINT xp_import_history_actor_discord_id_request_key_key UNIQUE (actor_discord_id, request_key);

ALTER TABLE ONLY xp_import_history
    ADD CONSTRAINT xp_import_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xp_previews
    ADD CONSTRAINT xp_previews_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY xp_state
    ADD CONSTRAINT xp_state_pkey PRIMARY KEY (singleton);

CREATE INDEX admin_sessions_account ON admin_sessions USING btree (account_id);

CREATE INDEX admin_sessions_expiry ON admin_sessions USING btree (expires_at);

CREATE INDEX asset_retirements_pending ON asset_retirements USING btree (storage_kind, retired_at, file_name) WHERE (removed_at IS NULL);

CREATE INDEX audit_submission_page ON audit_events USING btree (submission_id, id DESC);

CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits USING btree (expires_at);

CREATE INDEX collection_log_schedule_page_lookup ON collection_log_schedule_pages USING btree (page_id, schedule_id);

CREATE INDEX competition_preview_expiry ON competition_previews USING btree (expires_at);

CREATE INDEX competitions_archived_page ON wom_competitions USING btree (competition_id) WHERE (archived_at IS NOT NULL);

CREATE INDEX competitions_current_listing ON wom_competitions USING btree (kind, ends_at DESC, competition_id DESC) WHERE (archived_at IS NULL);

CREATE INDEX competitions_current_page ON wom_competitions USING btree (competition_id) WHERE (archived_at IS NULL);

CREATE INDEX game_item_ids_by_item ON game_item_ids USING btree (item_id, game_item_id);

CREATE INDEX item_aliases_item ON item_aliases USING btree (item_id);

CREATE INDEX lifecycle_audit_resource ON lifecycle_archive_audit USING btree (resource, resource_id, created_at DESC, id DESC);

CREATE INDEX runelite_drop_events_recent ON runelite_drop_events USING btree (player_key, item_id, hardcore, first_received_at DESC);

CREATE INDEX schedules_archived_page ON collection_log_schedules USING btree (id) WHERE (archived_at IS NOT NULL);

CREATE INDEX schedules_current_page ON collection_log_schedules USING btree (id) WHERE (archived_at IS NULL);

CREATE UNIQUE INDEX staff_accounts_single_admin ON staff_accounts USING btree (role) WHERE (role = 'admin'::text);

CREATE UNIQUE INDEX staff_accounts_username ON staff_accounts USING btree (lower(username)) WHERE (deleted_at IS NULL);

CREATE INDEX submissions_item_approved ON submissions USING btree (item_id, collected_on) WHERE (status = 'approved'::text);

CREATE UNIQUE INDEX submissions_one_credit_per_world ON submissions USING btree (item_id, hardcore) WHERE (status = 'approved'::text);

CREATE INDEX submissions_pending_page ON submissions USING btree (submitted_at DESC, id DESC) WHERE (status = 'pending'::text);

CREATE INDEX submissions_proof_reference ON submissions USING btree (proof_image_id) WHERE (proof_image_id IS NOT NULL);

CREATE INDEX submissions_review_cursor ON submissions USING btree (submitted_at DESC, id DESC);

CREATE INDEX submissions_review_queue ON submissions USING btree (status, submitted_at);

CREATE INDEX submissions_reviewed_page ON submissions USING btree (submitted_at DESC, id DESC) WHERE (status = ANY (ARRAY['approved'::text, 'rejected'::text, 'revoked'::text]));

CREATE INDEX submissions_unmatched_page ON submissions USING btree (submitted_at DESC, id DESC) WHERE ((status = 'pending'::text) AND (item_id IS NULL));

CREATE INDEX wom_competitions_listing ON wom_competitions USING btree (kind, ends_at DESC, competition_id DESC);

CREATE INDEX xp_history_latest ON xp_import_history USING btree (imported_at DESC, id DESC);

CREATE INDEX xp_previews_expiry ON xp_previews USING btree (expires_at);

-- Initial configuration; API startup creates credentials separately.
INSERT INTO catalog_sections (id, name, sort_order, active) VALUES ('bosses', 'Bosses', 0, true);
INSERT INTO catalog_sections (id, name, sort_order, active) VALUES ('raids', 'Raids', 1, true);
INSERT INTO catalog_sections (id, name, sort_order, active) VALUES ('clues', 'Clues', 2, true);
INSERT INTO catalog_sections (id, name, sort_order, active) VALUES ('minigames', 'Minigames', 3, true);
INSERT INTO catalog_sections (id, name, sort_order, active) VALUES ('other', 'Other', 4, true);
INSERT INTO catalog_state (singleton, version) VALUES (true, 1);
INSERT INTO clan_branding (singleton, version, logo_asset_id, hardcore_version, hardcore_logo_asset_id) VALUES (true, 1, NULL, 1, NULL);
INSERT INTO collection_scheduling (singleton, enabled, version) VALUES (true, false, 1);
INSERT INTO lifecycle_state (singleton, version) VALUES (true, 1);
INSERT INTO projection_state (resource, version) VALUES ('collections', 1);
INSERT INTO projection_state (resource, version) VALUES ('matches', 1);
INSERT INTO projection_state (resource, version) VALUES ('xp', 1);
INSERT INTO projection_state (resource, version) VALUES ('activities', 1);
INSERT INTO projection_state (resource, version) VALUES ('catalog', 1);
INSERT INTO review_state (singleton, version) VALUES (true, 1);
INSERT INTO runelite_settings (singleton, version, rules) VALUES (true, 1, '{"clanName": "Clan name", "matchClanName": true, "worldPolicies": {"f2p": "review", "pvp": "review", "members": "review", "hardcore": "review"}, "playerWhitelist": []}');
INSERT INTO site_settings (singleton, hardcore_enabled, version, clan_name, public_copy, hardcore_name, hardcore_copy) VALUES (true, false, 1, 'Clan name', '{"xpTitle": "XP gained during SOTW events", "collectionTitle": "Clan Collection Log", "collectionCaption": "Collected during BOTW events"}', 'Clan name', '{"xpTitle": "XP gained during SOTW events", "collectionTitle": "Clan Collection Log", "collectionCaption": "Collected during BOTW events"}');
INSERT INTO submission_filter_settings (singleton, version, filter_collected) VALUES (true, 1, false);
INSERT INTO xp_state (singleton, version, updated_at, history_version) VALUES (true, 1, NULL, 1);

CREATE TRIGGER aliases_revision AFTER INSERT OR DELETE OR UPDATE ON game_item_ids FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();

CREATE TRIGGER audit_review_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION advance_review_revision();

CREATE TRIGGER catalog_assets_retirement BEFORE INSERT OR UPDATE ON catalog_assets FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();

CREATE TRIGGER catalog_items_retirement BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();

CREATE TRIGGER catalog_state_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON catalog_state FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('catalog');

CREATE TRIGGER collection_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON submissions FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('collections');

CREATE TRIGGER competition_lifecycle_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON wom_competitions FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();

CREATE TRIGGER competition_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON wom_competitions FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('xp', 'activities');

CREATE TRIGGER game_id_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON game_item_ids FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('catalog');

CREATE TRIGGER item_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('catalog', 'collections', 'matches');

CREATE TRIGGER items_revision AFTER INSERT OR DELETE OR UPDATE ON items FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();

CREATE TRIGGER logo_assets_retirement BEFORE INSERT OR UPDATE ON clan_logo_assets FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();

CREATE TRIGGER matching_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON item_aliases FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('matches');

CREATE TRIGGER membership_delete_version AFTER DELETE ON page_items REFERENCING OLD TABLE AS old_memberships FOR EACH STATEMENT EXECUTE FUNCTION bump_membership_page();

CREATE TRIGGER membership_insert_version AFTER INSERT ON page_items REFERENCING NEW TABLE AS new_memberships FOR EACH STATEMENT EXECUTE FUNCTION bump_membership_page();

CREATE TRIGGER membership_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON page_items FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('catalog');

CREATE TRIGGER membership_truncate_version AFTER TRUNCATE ON page_items FOR EACH STATEMENT EXECUTE FUNCTION bump_membership_page();

CREATE TRIGGER membership_update_version AFTER UPDATE ON page_items REFERENCING OLD TABLE AS old_memberships NEW TABLE AS new_memberships FOR EACH STATEMENT EXECUTE FUNCTION bump_membership_page();

CREATE TRIGGER page_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON pages FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('catalog');

CREATE TRIGGER page_version BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION bump_page_version();

CREATE TRIGGER pages_revision AFTER INSERT OR DELETE OR UPDATE ON pages FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();

CREATE TRIGGER preserve_archived_competition BEFORE DELETE OR UPDATE ON wom_competitions FOR EACH ROW EXECUTE FUNCTION preserve_archived_lifecycle();

CREATE TRIGGER preserve_archived_contributions BEFORE INSERT OR DELETE OR UPDATE ON xp_events FOR EACH ROW EXECUTE FUNCTION preserve_archived_xp();

CREATE TRIGGER preserve_archived_memberships BEFORE INSERT OR DELETE OR UPDATE ON collection_log_schedule_pages FOR EACH ROW EXECUTE FUNCTION preserve_archived_schedule_pages();

CREATE TRIGGER preserve_archived_schedule BEFORE DELETE OR UPDATE ON collection_log_schedules FOR EACH ROW EXECUTE FUNCTION preserve_archived_lifecycle();

CREATE TRIGGER proof_assets_retirement BEFORE INSERT OR UPDATE ON submission_images FOR EACH ROW EXECUTE FUNCTION reject_retired_asset();

CREATE TRIGGER schedule_lifecycle_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON collection_log_schedules FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();

CREATE TRIGGER schedule_pages_lifecycle_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON collection_log_schedule_pages FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();

CREATE TRIGGER sections_revision AFTER INSERT OR DELETE OR UPDATE ON catalog_sections FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();

CREATE TRIGGER submissions_review_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON submissions FOR EACH STATEMENT EXECUTE FUNCTION advance_review_revision();

CREATE TRIGGER xp_event_projection AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON xp_events FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('xp');

CREATE TRIGGER xp_history_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON xp_import_history FOR EACH STATEMENT EXECUTE FUNCTION advance_xp_history_revision();

CREATE TRIGGER xp_revision_projection AFTER UPDATE OF version ON xp_state FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('xp');

CREATE TRIGGER xp_state_projection AFTER INSERT OR DELETE OR TRUNCATE ON xp_state FOR EACH STATEMENT EXECUTE FUNCTION advance_projection_revision('xp');

ALTER TABLE ONLY admin_sessions
    ADD CONSTRAINT admin_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES staff_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

ALTER TABLE ONLY catalog_assets
    ADD CONSTRAINT catalog_assets_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY catalog_audit
    ADD CONSTRAINT catalog_audit_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY catalog_audit
    ADD CONSTRAINT catalog_audit_page_id_fkey FOREIGN KEY (page_id) REFERENCES pages(id);

ALTER TABLE ONLY clan_branding_audit
    ADD CONSTRAINT clan_branding_audit_new_logo_asset_id_fkey FOREIGN KEY (new_logo_asset_id) REFERENCES clan_logo_assets(id);

ALTER TABLE ONLY clan_branding_audit
    ADD CONSTRAINT clan_branding_audit_old_logo_asset_id_fkey FOREIGN KEY (old_logo_asset_id) REFERENCES clan_logo_assets(id);

ALTER TABLE ONLY clan_branding
    ADD CONSTRAINT clan_branding_hardcore_logo_asset_id_fkey FOREIGN KEY (hardcore_logo_asset_id) REFERENCES clan_logo_assets(id);

ALTER TABLE ONLY clan_branding
    ADD CONSTRAINT clan_branding_logo_asset_id_fkey FOREIGN KEY (logo_asset_id) REFERENCES clan_logo_assets(id);

ALTER TABLE ONLY collection_log_schedule_pages
    ADD CONSTRAINT collection_log_schedule_pages_page_id_fkey FOREIGN KEY (page_id) REFERENCES pages(id);

ALTER TABLE ONLY collection_log_schedule_pages
    ADD CONSTRAINT collection_log_schedule_pages_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES collection_log_schedules(id) ON DELETE CASCADE;

ALTER TABLE ONLY competition_import_history
    ADD CONSTRAINT competition_import_history_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES wom_competitions(competition_id);

ALTER TABLE ONLY game_item_ids
    ADD CONSTRAINT game_item_ids_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY item_aliases
    ADD CONSTRAINT item_aliases_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE;

ALTER TABLE ONLY items
    ADD CONSTRAINT items_icon_asset_id_fkey FOREIGN KEY (icon_asset_id) REFERENCES catalog_assets(id);

ALTER TABLE ONLY manual_submission_requests
    ADD CONSTRAINT manual_submission_requests_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

ALTER TABLE ONLY page_items
    ADD CONSTRAINT page_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY page_items
    ADD CONSTRAINT page_items_page_id_fkey FOREIGN KEY (page_id) REFERENCES pages(id);

ALTER TABLE ONLY pages
    ADD CONSTRAINT pages_section_fkey FOREIGN KEY (category) REFERENCES catalog_sections(id);

ALTER TABLE ONLY runelite_drop_events
    ADD CONSTRAINT runelite_drop_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY runelite_drop_events
    ADD CONSTRAINT runelite_drop_events_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

ALTER TABLE ONLY runelite_submission_requests
    ADD CONSTRAINT runelite_submission_requests_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

ALTER TABLE ONLY staff_account_audit
    ADD CONSTRAINT staff_account_audit_account_id_fkey FOREIGN KEY (account_id) REFERENCES staff_accounts(id);

ALTER TABLE ONLY staff_account_audit
    ADD CONSTRAINT staff_account_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES staff_accounts(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_proof_image_id_fkey FOREIGN KEY (proof_image_id) REFERENCES submission_images(id);

ALTER TABLE ONLY wom_competitions
    ADD CONSTRAINT wom_competitions_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES collection_log_schedules(id) ON DELETE SET NULL;

ALTER TABLE ONLY xp_events
    ADD CONSTRAINT xp_event_competition_identity FOREIGN KEY (competition_id) REFERENCES wom_competitions(competition_id);

ALTER TABLE ONLY xp_import_history
    ADD CONSTRAINT xp_import_history_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES xp_events(competition_id);

ALTER TABLE ONLY xp_events
    ADD CONSTRAINT xp_skill_identity FOREIGN KEY (competition_id, kind) REFERENCES wom_competitions(competition_id, kind);
