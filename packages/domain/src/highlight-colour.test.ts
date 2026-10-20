import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHighlightColour, highlightCss } from './highlight-colour.js';

test('highlight channels preserve transparent, opaque and fractional alpha colours', () => {
  for (const alpha of [0, 0.375, 1]) {
    const colour = { red: 0, green: 255, blue: 127, alpha };
    assert.deepEqual(parseHighlightColour(colour), colour);
    assert.equal(highlightCss(colour), `rgba(0, 255, 127, ${alpha})`);
  }
});
test('highlight validation rejects incomplete, non-numeric and out-of-range channels', () => {
  const valid = { red: 231, green: 189, blue: 82, alpha: 1 };
  for (const invalid of [
    null,
    [],
    '#ff0000',
    {},
    { ...valid, extra: 1 },
    ...[-1, 256, 1.5, NaN, Infinity, '22', null, undefined].map((red) => ({
      ...valid,
      red,
    })),
    ...[-0.01, 1.01, NaN, Infinity, '1', null, undefined].map((alpha) => ({
      ...valid,
      alpha,
    })),
  ])
    assert.throws(() => parseHighlightColour(invalid));
});
