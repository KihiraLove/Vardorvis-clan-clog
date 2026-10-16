-- Keep the complete RuneLite chat message as private proof; screenshots are optional.
-- Existing screenshot-only submissions and immutable receipts remain valid.
ALTER TABLE submissions
  ADD COLUMN chat_message text,
  ADD CONSTRAINT submissions_chat_message CHECK (
    chat_message IS NULL OR
    (source = 'runelite' AND octet_length(chat_message) BETWEEN 1 AND 8192
      AND length(trim(chat_message)) > 0)
  ),
  DROP CONSTRAINT submissions_proof_by_source,
  ADD CONSTRAINT submissions_proof_by_source CHECK (
    length(proof_url) <= 2048 AND
    (source = 'manual' OR (source = 'discord' AND length(proof_url) > 0)
      OR (source = 'runelite' AND (proof_image_id IS NOT NULL OR chat_message IS NOT NULL)))
  );
