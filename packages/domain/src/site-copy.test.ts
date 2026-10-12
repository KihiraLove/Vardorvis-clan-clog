import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSiteCopy,
  parseSiteCopy,
  parseHardcoreAppearance,
} from './site-copy.js';
test('website copy validates all three labels, trims whitespace and leaves text as text', () => {
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
    { ...defaultSiteCopy, xpTitle: 'a'.repeat(161) },
    { ...defaultSiteCopy, collectionTitle: 'line\nbreak' },
  ])
    assert.throws(() => parseSiteCopy(invalid));
});
test('hardcore appearance validates the displayed name and independent labels', () => {
  const value = {
    clanName: ' Hardcore clan ',
    copy: { ...defaultSiteCopy, collectionTitle: 'Hardcore drops' },
  };
  assert.deepEqual(parseHardcoreAppearance(value), {
    ...value,
    clanName: 'Hardcore clan',
  });
  for (const invalid of [
    null,
    [],
    { ...value, extra: 'unexpected' },
    { ...value, clanName: '' },
    { ...value, clanName: 'a'.repeat(81) },
    { ...value, clanName: 'bad\nname' },
    { ...value, copy: { ...value.copy, xpTotalCaption: 'retired' } },
  ])
    assert.throws(() => parseHardcoreAppearance(invalid));
});
