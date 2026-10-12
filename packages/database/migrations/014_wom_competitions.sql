-- One WOM identity for metadata, schedules and finished skill/activity results.
CREATE TABLE wom_competitions (
  competition_id bigint PRIMARY KEY CHECK(competition_id > 0),
  kind text NOT NULL CHECK(kind IN ('SKILL','ACTIVITY')),
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  source_url text NOT NULL,
  metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='array' AND jsonb_array_length(metrics)>0),
  skills jsonb NOT NULL DEFAULT '[]',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  schedule_id uuid REFERENCES collection_log_schedules(id) ON DELETE SET NULL,
  schedule_created boolean NOT NULL DEFAULT false,
  results_imported_at timestamptz,
  activity_results jsonb,
  source_hash text,
  CHECK(activity_results IS NULL OR (kind='ACTIVITY' AND results_imported_at IS NOT NULL))
);
CREATE INDEX wom_competitions_listing ON wom_competitions(kind,ends_at DESC,competition_id DESC);
ALTER TABLE wom_competitions ADD CONSTRAINT wom_kind_identity UNIQUE(competition_id,kind);
INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,results_imported_at,source_hash)
SELECT competition_id,'SKILL',title,source_url,skills,skills,
  (source_snapshot->>'startsAt')::timestamptz,(source_snapshot->>'endsAt')::timestamptz,imported_at,source_hash
FROM xp_events;
ALTER TABLE xp_events ADD CONSTRAINT xp_event_competition_identity FOREIGN KEY(competition_id) REFERENCES wom_competitions(competition_id);
ALTER TABLE xp_events ADD COLUMN kind text NOT NULL DEFAULT 'SKILL' CHECK(kind='SKILL');
ALTER TABLE xp_events ADD CONSTRAINT xp_skill_identity FOREIGN KEY(competition_id,kind) REFERENCES wom_competitions(competition_id,kind);
-- Invalidate legacy live previews; already published totals/history remain recoverable.
DELETE FROM xp_previews WHERE (snapshot->>'endsAt')::timestamptz > now();
CREATE TABLE competition_previews (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL,
  expected_revision text NOT NULL,
  schedule_revision text NOT NULL,
  snapshot jsonb NOT NULL,
  page_ids text[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX competition_preview_expiry ON competition_previews(expires_at);
CREATE TABLE competition_import_history (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  competition_id bigint NOT NULL REFERENCES wom_competitions(competition_id),
  title text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('SKILL','ACTIVITY')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  old_values jsonb,
  new_values jsonb NOT NULL,
  receipt jsonb NOT NULL,
  UNIQUE(actor_id,request_key)
);
