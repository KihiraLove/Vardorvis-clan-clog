-- Disabled by default; clocks enforce windows without cron jobs or per-page collected flags.
CREATE TABLE collection_scheduling (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO collection_scheduling(singleton) VALUES(true);
CREATE TABLE collection_log_schedules (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 100),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK(ends_at>starts_at)
);
CREATE TABLE collection_log_schedule_pages (
  schedule_id uuid NOT NULL REFERENCES collection_log_schedules(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES pages(id),
  PRIMARY KEY(schedule_id,page_id)
);
CREATE INDEX collection_log_schedule_page_lookup ON collection_log_schedule_pages(page_id,schedule_id);
CREATE TABLE collection_schedule_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  action text NOT NULL CHECK(action IN ('enable','disable','create','edit','delete')),
  version integer NOT NULL UNIQUE,
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
