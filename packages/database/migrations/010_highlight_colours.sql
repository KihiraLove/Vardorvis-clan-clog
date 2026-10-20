-- Independent appearance preferences, preserving all existing collection data.
ALTER TABLE site_settings
  ADD COLUMN event_highlight jsonb NOT NULL DEFAULT '{"red":231,"green":189,"blue":82,"alpha":1}',
  ADD COLUMN hardcore_highlight jsonb NOT NULL DEFAULT '{"red":255,"green":41,"blue":41,"alpha":1}',
  ADD CONSTRAINT event_highlight_valid CHECK(CASE WHEN
    jsonb_typeof(event_highlight) = 'object'
    AND event_highlight - ARRAY['red','green','blue','alpha'] = '{}'::jsonb
    AND jsonb_typeof(event_highlight->'red') = 'number'
    AND jsonb_typeof(event_highlight->'green') = 'number'
    AND jsonb_typeof(event_highlight->'blue') = 'number'
    AND jsonb_typeof(event_highlight->'alpha') = 'number'
    THEN (event_highlight->>'red')::numeric BETWEEN 0 AND 255
      AND (event_highlight->>'green')::numeric BETWEEN 0 AND 255
      AND (event_highlight->>'blue')::numeric BETWEEN 0 AND 255
      AND (event_highlight->>'alpha')::numeric BETWEEN 0 AND 1
      AND (event_highlight->>'red')::numeric = trunc((event_highlight->>'red')::numeric)
      AND (event_highlight->>'green')::numeric = trunc((event_highlight->>'green')::numeric)
      AND (event_highlight->>'blue')::numeric = trunc((event_highlight->>'blue')::numeric)
    ELSE false END),
  ADD CONSTRAINT hardcore_highlight_valid CHECK(CASE WHEN
    jsonb_typeof(hardcore_highlight) = 'object'
    AND hardcore_highlight - ARRAY['red','green','blue','alpha'] = '{}'::jsonb
    AND jsonb_typeof(hardcore_highlight->'red') = 'number'
    AND jsonb_typeof(hardcore_highlight->'green') = 'number'
    AND jsonb_typeof(hardcore_highlight->'blue') = 'number'
    AND jsonb_typeof(hardcore_highlight->'alpha') = 'number'
    THEN (hardcore_highlight->>'red')::numeric BETWEEN 0 AND 255
      AND (hardcore_highlight->>'green')::numeric BETWEEN 0 AND 255
      AND (hardcore_highlight->>'blue')::numeric BETWEEN 0 AND 255
      AND (hardcore_highlight->>'alpha')::numeric BETWEEN 0 AND 1
      AND (hardcore_highlight->>'red')::numeric = trunc((hardcore_highlight->>'red')::numeric)
      AND (hardcore_highlight->>'green')::numeric = trunc((hardcore_highlight->>'green')::numeric)
      AND (hardcore_highlight->>'blue')::numeric = trunc((hardcore_highlight->>'blue')::numeric)
    ELSE false END);
ALTER TABLE site_settings_audit
  ADD COLUMN old_event_highlight jsonb,
  ADD COLUMN new_event_highlight jsonb,
  ADD COLUMN old_hardcore_highlight jsonb,
  ADD COLUMN new_hardcore_highlight jsonb;
UPDATE site_settings SET version=version+1;
