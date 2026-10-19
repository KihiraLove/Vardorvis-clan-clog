/** Public submission instructions, shared across world modes and API/browser validation. */
export const submissionHelpMaxBytes = 32 * 1024;
export const defaultSubmissionHelp = `## Submit a collection

1. Follow your clan's RuneLite submission setup, or send your proof to a moderator.
2. Include the item, collector name, collection date and a screenshot or proof link.
3. Your collection appears in the log once the submission is approved.

Ask your clan staff for setup instructions and submission rules.`;

export function parseSubmissionHelp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    new TextEncoder().encode(value).length > submissionHelpMaxBytes
  )
    throw new Error(
      'Submission instructions must be at most 32 KiB of UTF-8 text with no NUL characters.',
    );
  return value;
}
