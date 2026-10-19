-- One public Markdown guide for normal, hardcore and XP views.
ALTER TABLE site_settings ADD COLUMN how_to_submit_markdown text NOT NULL DEFAULT
$help$## Submit a collection

1. Follow your clan's RuneLite submission setup, or send your proof to a moderator.
2. Include the item, collector name, collection date and a screenshot or proof link.
3. Your collection appears in the log once the submission is approved.

Ask your clan staff for setup instructions and submission rules.$help$;
ALTER TABLE site_settings ADD CONSTRAINT site_settings_help_size
  CHECK (octet_length(how_to_submit_markdown) <= 32768);
ALTER TABLE site_settings_audit ADD COLUMN old_how_to_submit_markdown text;
ALTER TABLE site_settings_audit ADD COLUMN new_how_to_submit_markdown text;
-- Invalidate settings ETags and forms opened before this additive upgrade.
UPDATE site_settings SET version=version+1;
