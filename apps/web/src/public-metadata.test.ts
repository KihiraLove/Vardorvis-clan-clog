import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicMetadataClient } from './public-metadata.ts';
import { defaultBranding } from './branding.ts';
test('public metadata keeps independent conditional revisions and never commits failed or canceled reads', async (t) => {
  const client = new PublicMetadataClient(),
    controller = new AbortController();
  let mode = 'initial';
  const seen: Record<string, string | undefined> = {};
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string, options: RequestInit) => {
      seen[path] = (options.headers as Record<string, string>)['If-None-Match'];
      if (mode === 'fail') return Response.json({}, { status: 503 });
      if (mode === '304') return new Response(null, { status: 304 });
      if (mode === 'cancel') controller.abort();
      const data = path.endsWith('settings')
        ? { revision: 'settings-1', clanName: 'Clan', hardcoreEnabled: true }
        : defaultBranding;
      return Response.json(data, {
        headers: {
          ETag: '"' + path + (mode === 'cancel' ? '-canceled' : '') + '"',
        },
      });
    },
  );
  const signal = () => new AbortController().signal;
  const settings = await client.settings(signal());
  await client.branding(false, signal());
  await client.branding(true, signal());
  mode = 'fail';
  await assert.rejects(client.settings(signal()));
  mode = 'cancel';
  await assert.rejects(client.settings(controller.signal));
  mode = '304';
  assert.equal(await client.settings(signal()), settings);
  await client.branding(false, signal());
  await client.branding(true, signal());
  assert.deepEqual(seen, {
    '/api/v1/settings': '"/api/v1/settings"',
    '/api/v1/branding': '"/api/v1/branding"',
    '/api/v1/branding/hardcore': '"/api/v1/branding/hardcore"',
  });
});
