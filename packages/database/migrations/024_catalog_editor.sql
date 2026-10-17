-- Sections are staff-managed taxonomy; stable IDs preserve page and schedule references.
CREATE TABLE catalog_sections (
  id text PRIMARY KEY,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  sort_order integer NOT NULL CHECK(sort_order>=0),
  active boolean NOT NULL DEFAULT true
);
INSERT INTO catalog_sections(id,name,sort_order) VALUES
  ('bosses','Bosses',0),('raids','Raids',1),('clues','Clues',2),
  ('minigames','Minigames',3),('other','Other',4);
ALTER TABLE pages ADD CONSTRAINT pages_section_fkey FOREIGN KEY(category) REFERENCES catalog_sections(id);
CREATE TRIGGER sections_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_sections
  FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TABLE catalog_section_requests (LIKE catalog_page_requests INCLUDING ALL);
-- Keep previous icons readable after a replacement, including cached public snapshots.
ALTER TABLE catalog_assets DROP CONSTRAINT catalog_assets_item_id_key;
CREATE INDEX game_item_ids_by_item ON game_item_ids(item_id,game_item_id);
ALTER TABLE items DROP CONSTRAINT items_overrides_check,
  ADD CONSTRAINT items_overrides_check CHECK(overrides <@ ARRAY['name','icon','pages','game_ids']::text[]);
ALTER TABLE catalog_audit DROP CONSTRAINT catalog_audit_action_check,
  ADD CONSTRAINT catalog_audit_action_check CHECK(action IN
    ('create','reorder','reconcile','taxonomy','delete','create_page','delete_page','reorder_pages',
     'create_section','edit_section','delete_section','reorder_sections','edit_page','edit_item','attach_item','delete_item'));
UPDATE catalog_state SET version=version+1 WHERE singleton;
