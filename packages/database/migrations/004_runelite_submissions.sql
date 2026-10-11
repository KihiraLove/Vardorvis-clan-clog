-- Clan identity and durable, private screenshot evidence. Existing Discord proofs stay external.
ALTER TABLE site_settings ADD COLUMN clan_name text NOT NULL DEFAULT 'Vardorvis'
  CHECK (clan_name = trim(clan_name) AND length(clan_name) BETWEEN 1 AND 80);
ALTER TABLE site_settings_audit
  ADD COLUMN old_clan_name text,
  ADD COLUMN new_clan_name text;

CREATE TABLE submission_images (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE submissions
  ADD COLUMN proof_image_id uuid REFERENCES submission_images(id),
  ADD COLUMN submitted_clan_name text,
  ADD COLUMN game_item_id integer CHECK (game_item_id > 0),
  DROP CONSTRAINT submissions_source_check,
  ADD CONSTRAINT submissions_source_check CHECK (source IN ('discord','manual','runelite')),
  DROP CONSTRAINT submissions_proof_by_source,
  ADD CONSTRAINT submissions_proof_by_source CHECK (
    length(proof_url) <= 2048 AND
    (source = 'manual' OR (source = 'discord' AND length(proof_url) > 0)
      OR (source = 'runelite' AND proof_image_id IS NOT NULL))
  ),
  DROP CONSTRAINT submissions_source_provenance,
  ADD CONSTRAINT submissions_source_provenance CHECK (
    (source = 'discord' AND discord_interaction_id IS NOT NULL
      AND discord_user_id IS NOT NULL AND discord_guild_id IS NOT NULL)
    OR (source IN ('manual','runelite') AND discord_interaction_id IS NULL
      AND discord_user_id IS NULL AND discord_guild_id IS NULL)
  ),
  ADD CONSTRAINT submissions_runelite_provenance CHECK (
    source <> 'runelite' OR
    (game_item_id IS NOT NULL AND submitted_clan_name IS NOT NULL
      AND length(trim(submitted_clan_name)) BETWEEN 1 AND 80)
  );
CREATE TABLE runelite_submission_requests (
  request_key uuid PRIMARY KEY,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
