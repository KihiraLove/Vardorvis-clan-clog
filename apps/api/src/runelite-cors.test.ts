import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from './app.js';
import { ApiError } from './types.js';

test('browser tester preflight is public and scoped; upload errors retain CORS and still enforce intake authentication', async () => {
  let authorized = 0,
    uploads = 0,
    limited = false;
  const image = {
    id: randomUUID(),
    sha256: 'a'.repeat(64),
    byteSize: 1,
    width: 1,
    height: 1,
  };
  const originalImage = randomUUID();
  const removed: string[] = [];
  const app = createApp(undefined, undefined, {
    logger: false,
    proofStore: {
      allowIntake: async () => !limited,
      authorizeIntake: async (key) => {
        authorized++;
        if (key !== 'test-key') throw new ApiError(401, 'Key required.');
      },
      validateSubmission: async () => {},
      image: async () => null,
      createRuneLite: async () => {
        return {
          imageId: originalImage,
          receipt: {
            submissionId: randomUUID(),
            status: 'pending',
            itemId: 1,
            submittedAt: '2026-10-15T12:00:00.000Z',
            collectedOn: '2026-10-15',
            hardcore: false,
            duplicate: true,
          },
        };
      },
    },
    proofs: {
      read: async () => Buffer.alloc(0),
      save: async () => {
        uploads++;
        return image;
      },
      remove: async (id) => {
        removed.push(id);
      },
    },
  });
  const origin = 'https://kihiralove.github.io';
  const url = '/api/v1/runelite/submissions';
  const preflight = {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers':
      'Content-Type, Idempotency-Key, X-Clan-API-Key, X-Clan-API-Key-Base64',
  };
  try {
    const accepted = await app.inject({
      method: 'OPTIONS',
      url,
      headers: preflight,
    });
    assert.equal(accepted.statusCode, 204, accepted.body);
    assert.equal(accepted.headers['access-control-allow-origin'], origin);
    assert.equal(accepted.headers['access-control-allow-methods'], 'POST');
    assert.equal(
      accepted.headers['access-control-allow-credentials'],
      undefined,
    );
    assert.match(String(accepted.headers.vary), /Origin/);
    assert.equal(authorized, 0);
    for (const headers of [
      { ...preflight, origin: 'https://kihiralove.github.io.evil.example' },
      { ...preflight, origin: 'https://other.github.io' },
      { ...preflight, origin: 'null' },
      { ...preflight, 'access-control-request-method': 'PUT' },
      { ...preflight, 'access-control-request-headers': 'X-CSRF-Token' },
    ]) {
      const denied = await app.inject({ method: 'OPTIONS', url, headers });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.headers['access-control-allow-methods'], undefined);
      if (headers.origin !== origin)
        assert.equal(denied.headers['access-control-allow-origin'], undefined);
    }
    const unauthorized = await app.inject({
      method: 'POST',
      url,
      headers: { origin },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['access-control-allow-origin'], origin);
    assert.match(
      String(unauthorized.headers['access-control-expose-headers']),
      /Retry-After/,
    );
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers: { origin, 'x-clan-api-key': 'test-key' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['access-control-allow-origin'], origin);
    assert.equal(authorized, 2);
    assert.equal(uploads, 0);
    const boundary = 'cors-test-boundary';
    const payload = [
      ...Object.entries({
        username: 'Collector',
        clanName: 'Clan',
        itemId: '4151',
        worldType: 'HARDCORE_MAIN',
      }).map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
      `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="proof.png"\r\nContent-Type: image/png\r\n\r\nx\r\n--${boundary}--\r\n`,
    ].join('');
    const success = await app.inject({
      method: 'POST',
      url,
      headers: {
        origin,
        'x-clan-api-key': 'test-key',
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload,
    });
    assert.equal(success.statusCode, 201, success.body);
    assert.equal(success.headers['access-control-allow-origin'], origin);
    assert.equal(success.json().duplicate, true);
    assert.deepEqual(removed, [image.id]);
    assert.equal(uploads, 1);
    limited = true;
    const rateLimited = await app.inject({
      method: 'POST',
      url,
      headers: { origin },
    });
    assert.equal(rateLimited.statusCode, 429);
    assert.equal(rateLimited.headers['access-control-allow-origin'], origin);
    assert.equal(rateLimited.headers['retry-after'], '60');
    limited = false;
    for (const route of [
      '/api/v1/settings',
      '/api/v1/admin/submissions',
      '/api/v1/admin/submissions/upload',
    ]) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: route,
        headers: preflight,
      });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    const nativeClient = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-clan-api-key': 'test-key' },
    });
    assert.equal(nativeClient.statusCode, 400);
    assert.equal(
      nativeClient.headers['access-control-allow-origin'],
      undefined,
    );
  } finally {
    await app.close();
  }
});
