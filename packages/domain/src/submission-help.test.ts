import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSubmissionHelp,
  parseSubmissionHelp,
  submissionHelpMaxBytes,
} from './submission-help.js';

test('submission instructions preserve Markdown and enforce the UTF-8 byte boundary', () => {
  assert.equal(
    parseSubmissionHelp(defaultSubmissionHelp),
    defaultSubmissionHelp,
  );
  for (const text of [
    '',
    '  \n',
    '# Guide\r\n\t**Proof**',
    'a'.repeat(submissionHelpMaxBytes),
    '😀'.repeat(8192),
  ])
    assert.equal(parseSubmissionHelp(text), text);
  for (const text of [
    null,
    {},
    1,
    'bad\0text',
    'a'.repeat(submissionHelpMaxBytes + 1),
    '😀'.repeat(8193),
  ])
    assert.throws(() => parseSubmissionHelp(text), /32 KiB/);
});
