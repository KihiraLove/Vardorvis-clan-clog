-- Archival retains original identities, memberships, results and receipts.
ALTER TABLE collection_log_schedules ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT schedule_archive_ended CHECK(archived_at IS NULL OR archived_at >= ends_at);
ALTER TABLE wom_competitions ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT competition_archive_ended CHECK(archived_at IS NULL OR archived_at >= ends_at);
CREATE TABLE lifecycle_archive_audit (
  id uuid PRIMARY KEY,
  resource text NOT NULL CHECK(resource IN ('schedules','competitions')),
  resource_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('archive','restore')),
  actor_name text NOT NULL CHECK(length(trim(actor_name)) BETWEEN 1 AND 80),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX lifecycle_audit_resource ON lifecycle_archive_audit(resource,resource_id,created_at DESC,id DESC);
CREATE TABLE lifecycle_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0)
);
INSERT INTO lifecycle_state(singleton) VALUES(true);
CREATE FUNCTION advance_lifecycle_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lifecycle_state SET version=version+1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER schedule_lifecycle_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON collection_log_schedules FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();
CREATE TRIGGER schedule_pages_lifecycle_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON collection_log_schedule_pages FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();
CREATE TRIGGER competition_lifecycle_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON wom_competitions FOR EACH STATEMENT EXECUTE FUNCTION advance_lifecycle_revision();
CREATE INDEX schedules_current_page ON collection_log_schedules(id) WHERE archived_at IS NULL;
CREATE INDEX schedules_archived_page ON collection_log_schedules(id) WHERE archived_at IS NOT NULL;
CREATE INDEX competitions_current_page ON wom_competitions(competition_id) WHERE archived_at IS NULL;
CREATE INDEX competitions_archived_page ON wom_competitions(competition_id) WHERE archived_at IS NOT NULL;
CREATE INDEX competitions_current_listing ON wom_competitions(kind,ends_at DESC,competition_id DESC) WHERE archived_at IS NULL;

-- Archived rows can be restored explicitly, but ordinary edits/deletes must not
-- erase the preserved source. Existing application writes never restore a row.
CREATE FUNCTION preserve_archived_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER preserve_archived_schedule BEFORE UPDATE OR DELETE ON collection_log_schedules
  FOR EACH ROW EXECUTE FUNCTION preserve_archived_lifecycle();
CREATE TRIGGER preserve_archived_competition BEFORE UPDATE OR DELETE ON wom_competitions
  FOR EACH ROW EXECUTE FUNCTION preserve_archived_lifecycle();

CREATE FUNCTION preserve_archived_schedule_pages() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER preserve_archived_memberships BEFORE INSERT OR UPDATE OR DELETE ON collection_log_schedule_pages
  FOR EACH ROW EXECUTE FUNCTION preserve_archived_schedule_pages();
CREATE FUNCTION preserve_archived_xp() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER preserve_archived_contributions BEFORE INSERT OR UPDATE OR DELETE ON xp_events
  FOR EACH ROW EXECUTE FUNCTION preserve_archived_xp();
