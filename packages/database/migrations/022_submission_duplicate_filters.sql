-- Staff-controlled intake filtering and immutable cross-client RuneLite event identity.
CREATE TABLE submission_filter_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  filter_collected boolean NOT NULL DEFAULT false
);
INSERT INTO submission_filter_settings(singleton) VALUES(true);

CREATE TABLE submission_filter_audit (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  version integer NOT NULL UNIQUE,
  old_filter_collected boolean NOT NULL,
  new_filter_collected boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE runelite_drop_events (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id),
  player_key text NOT NULL,
  item_id integer NOT NULL REFERENCES items(id),
  hardcore boolean NOT NULL,
  first_received_at timestamptz NOT NULL,
  receipt jsonb NOT NULL
);
CREATE INDEX runelite_drop_events_recent ON runelite_drop_events(player_key,item_id,hardcore,first_received_at DESC);

-- Preserve the opening window for claims accepted just before the upgrade.
INSERT INTO runelite_drop_events(submission_id,player_key,item_id,hardcore,first_received_at,receipt)
SELECT DISTINCT ON (s.id) s.id,
  lower(trim(regexp_replace(replace(replace(s.collector_name,'_',' '),chr(160),' '),'[[:space:]]+',' ','g'))),
  s.item_id,s.hardcore,s.submitted_at,r.response
FROM submissions s JOIN runelite_submission_requests r ON r.submission_id=s.id
WHERE s.source='runelite' AND s.item_id IS NOT NULL AND s.submitted_at > clock_timestamp()-interval '1 minute'
ORDER BY s.id,r.request_key;
