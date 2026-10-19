-- Keep drop identity independent of a later canonical match or catalog edit.
ALTER TABLE runelite_drop_events ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE runelite_drop_events ADD COLUMN game_item_id integer;
UPDATE runelite_drop_events e SET game_item_id=s.game_item_id
FROM submissions s WHERE s.id=e.submission_id;
ALTER TABLE runelite_drop_events ADD CONSTRAINT runelite_drop_events_game_item_id_check
  CHECK (game_item_id > 0);
-- Older fixtures/imported records may not have game provenance. New intake always does.
ALTER TABLE runelite_drop_events ADD CONSTRAINT runelite_drop_events_identity_check
  CHECK (item_id IS NOT NULL OR game_item_id IS NOT NULL);
CREATE INDEX runelite_drop_events_player_recent
  ON runelite_drop_events(player_key,hardcore,first_received_at DESC);

-- Freeze only evidence available at intake; never reconstruct historical windows.
ALTER TABLE submissions ADD COLUMN intake_scheduling jsonb;
ALTER TABLE submissions ADD CONSTRAINT submissions_intake_scheduling_check
  CHECK (intake_scheduling IS NULL OR jsonb_typeof(intake_scheduling)='object');
