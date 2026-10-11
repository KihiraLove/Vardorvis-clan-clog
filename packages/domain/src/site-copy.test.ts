import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSiteCopy, parseSiteCopy } from './site-copy.js';
test('website copy validates all four labels, trims whitespace and leaves text as text', () => {
  const input = {
    ...defaultSiteCopy,
    collectionTitle: '  My clan  ',
    collectionCaption: '<script>as plain text</script>',
  };
  assert.deepEqual(parseSiteCopy(input), {
    ...input,
    collectionTitle: 'My clan',
  });
  for (const invalid of [
    null,
    [],
    {},
    { ...defaultSiteCopy, extra: 'field' },
    { ...defaultSiteCopy, xpTitle: '' },
    { ...defaultSiteCopy, xpTitle: 42 },
    { ...defaultSiteCopy, xpTotalCaption: 'a'.repeat(161) },
    { ...defaultSiteCopy, collectionTitle: 'line\nbreak' },
  ])
    assert.throws(() => parseSiteCopy(invalid));
});
