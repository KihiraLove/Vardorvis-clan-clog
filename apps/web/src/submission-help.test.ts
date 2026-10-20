import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings } from './site-settings.ts';
import { LiveAdminClient } from './admin-api.ts';

const base = {
  revision: 'settings-3',
  hardcoreEnabled: false,
  clanName: 'Clan',
};
test('public settings retain the bounded guide and accept older omitted fields', () => {
  assert.deepEqual(parseSettings(base), base);
  assert.equal(
    parseSettings({ ...base, howToSubmitMarkdown: '' }).howToSubmitMarkdown,
    '',
  );
  assert.equal(
    parseSettings({ ...base, howToSubmitMarkdown: '# Guide\n\n**Proof**' })
      .howToSubmitMarkdown,
    '# Guide\n\n**Proof**',
  );
  for (const howToSubmitMarkdown of [null, {}, 'bad\0text', '😀'.repeat(8193)])
    assert.throws(() => parseSettings({ ...base, howToSubmitMarkdown }));
});

test('the settings adapter sends the guide exactly and rejects an incomplete save receipt', async () => {
  const text = '# Guide\n\nKeep trailing spaces  \n';
  let payload: Record<string, unknown> = {};
  let incomplete = false;
  const client = new LiveAdminClient(async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    if (incomplete) return Response.json({ ...base, revision: 'settings-5' });
    return Response.json({
      ...base,
      revision: 'settings-4',
      howToSubmitMarkdown: text,
    });
  });
  const signal = new AbortController().signal;
  const saved = await client.saveSettings(
    false,
    base.revision,
    'csrf',
    signal,
    undefined,
    undefined,
    undefined,
    text,
  );
  assert.equal(saved.howToSubmitMarkdown, text);
  assert.equal(payload.howToSubmitMarkdown, text);
  incomplete = true;
  await assert.rejects(
    client.saveSettings(
      false,
      base.revision,
      'csrf',
      signal,
      undefined,
      undefined,
      undefined,
      text,
    ),
    /Unexpected settings receipt/,
  );
});
