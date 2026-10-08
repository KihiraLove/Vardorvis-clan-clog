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
