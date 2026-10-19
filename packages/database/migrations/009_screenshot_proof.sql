-- New Discord intake requires an uploaded image. Retain historical external URL
-- evidence so existing records, audit history and immutable receipts are intact.
-- The API rejects URL-only intake; staff approval requires an image or RuneLite chat.
ALTER TABLE submissions DROP CONSTRAINT submissions_proof_by_source;
ALTER TABLE submissions ADD CONSTRAINT submissions_proof_by_source CHECK (
  length(proof_url) <= 2048 AND (
    source = 'manual' OR
    (source = 'discord' AND (proof_image_id IS NOT NULL OR length(proof_url) > 0)) OR
    (source = 'runelite' AND (proof_image_id IS NOT NULL OR chat_message IS NOT NULL))
  )
);

-- Refresh only the untouched built-in guide; preserve staff-authored Markdown.
ALTER TABLE site_settings ALTER COLUMN how_to_submit_markdown SET DEFAULT $help$## Submit a collection

1. Follow your clan's RuneLite submission setup, or send your proof to a moderator.
2. Include the item, collector name, collection date and a PNG screenshot. RuneLite submissions can use their chat proof.
3. Your collection appears in the log once the submission is approved.

Ask your clan staff for setup instructions and submission rules.$help$;
UPDATE site_settings SET how_to_submit_markdown=$help$## Submit a collection

1. Follow your clan's RuneLite submission setup, or send your proof to a moderator.
2. Include the item, collector name, collection date and a PNG screenshot. RuneLite submissions can use their chat proof.
3. Your collection appears in the log once the submission is approved.

Ask your clan staff for setup instructions and submission rules.$help$,version=version+1
WHERE how_to_submit_markdown=$old$## Submit a collection

1. Follow your clan's RuneLite submission setup, or send your proof to a moderator.
2. Include the item, collector name, collection date and a screenshot or proof link.
3. Your collection appears in the log once the submission is approved.

Ask your clan staff for setup instructions and submission rules.$old$;
