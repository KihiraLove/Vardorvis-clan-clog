-- Preserve the released baseline and existing moderator permissions.
CREATE TABLE staff_page_access (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    moderator_pages text[] NOT NULL,
    CHECK (moderator_pages <@ ARRAY['submissions','catalog','schedules','runelite','settings','hardcore','discord']::text[]),
    CHECK (array_position(moderator_pages, NULL) IS NULL),
    CHECK (cardinality(moderator_pages) <= 7)
);

INSERT INTO staff_page_access(singleton, moderator_pages)
VALUES (true, ARRAY['submissions','catalog','schedules','runelite']);

CREATE TABLE staff_page_access_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL UNIQUE CHECK (version > 1),
    old_pages text[] NOT NULL,
    new_pages text[] NOT NULL
);
