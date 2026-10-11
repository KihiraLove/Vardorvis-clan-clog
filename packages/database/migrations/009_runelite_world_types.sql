-- Preserve the submitted world flags independently from staff-correctable credit mode.
-- Historical claims have NULL flags and remain ordinary-world submissions.
ALTER TABLE submissions ADD COLUMN submitted_world_types text[]
  CHECK (submitted_world_types IS NULL OR (
    source='runelite' AND cardinality(submitted_world_types)<=32 AND
    array_position(submitted_world_types,NULL) IS NULL
  ));
