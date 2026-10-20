import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultBranding, parseBranding } from './branding.ts';
import { LiveAdminClient } from './admin-api.ts';
const id = '00000000-0000-4000-8000-000000000001';
const branding = {
  revision: 'branding-2',
  logoPath: `/api/v1/branding/${id}.webp`,
  faviconPath: `/api/v1/branding/${id}/favicon.webp`,
};
test('live branding allows only a matched same-origin logo/favicon pair', () => {
  assert.deepEqual(parseBranding(defaultBranding), defaultBranding);
  assert.deepEqual(parseBranding(branding), branding);
  for (const invalid of [
    { ...branding, logoPath: 'https://example.com/logo.svg' },
    { ...branding, logoPath: 'javascript:alert(1)' },
    { ...branding, faviconPath: '/favicon.webp' },
    { ...branding, revision: 'branding-0' },
    { ...branding, logoPath: '/api/v1/branding/../file.webp' },
  ])
    assert.throws(() => parseBranding(invalid));
});
test('logo upload and reset preserve CSRF, multipart boundaries and optimistic concurrency', async () => {
  const requests: RequestInit[] = [];
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/branding/logo');
    requests.push(options!);
    return new Response(
      JSON.stringify(
        requests.length === 1
          ? branding
          : { ...defaultBranding, revision: 'branding-3' },
      ),
    );
  });
  const file = new File(['fixture'], 'logo.gif', { type: 'image/gif' });
  await client.saveLogo(
    file,
    'branding-1',
    'csrf',
    new AbortController().signal,
  );
  const upload = requests[0]!;
  assert.equal(upload.method, 'PUT');
  assert.equal(new Headers(upload.headers).get('X-CSRF-Token'), 'csrf');
  assert.equal(new Headers(upload.headers).get('If-Match'), 'branding-1');
  assert.equal(new Headers(upload.headers).has('Content-Type'), false);
  assert.equal((upload.body as FormData).get('logo'), file);
  await client.saveLogo(
    null,
    'branding-2',
    'csrf',
    new AbortController().signal,
  );
  assert.equal(requests[1]!.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[1]!.body as string), {
    expectedRevision: 'branding-2',
  });
});
