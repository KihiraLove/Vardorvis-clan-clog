-- Independent from timed schedules; upgrading never opens an existing page.
CREATE TABLE collection_permanent_pages (
    page_id text PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
);

ALTER TABLE collection_schedule_audit
    DROP CONSTRAINT collection_schedule_audit_action_check,
    ADD CONSTRAINT collection_schedule_audit_action_check CHECK (
        action IN ('enable', 'disable', 'create', 'edit', 'delete',
                   'set_permanent_pages', 'remove_permanent_page')
    );
