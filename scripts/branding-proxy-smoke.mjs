/** Real Nginx→API multipart boundary regression for disposable CI only. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

if (process.env.BRANDING_PROXY_SMOKE_TEST !== '1')
  throw new Error('Disposable CI database opt-in required');
if (process.env.PUBLIC_ORIGIN !== 'https://clog.example.com')
  throw new Error('Refuse to mutate a non-CI branding origin');

const base = 'http://127.0.0.1:8080';
const origin = process.env.PUBLIC_ORIGIN;
const fileLimit = 10 * 1024 * 1024;
const proxyLimit = 11 * 1024 * 1024;

const request = (path, options = {}) =>
  fetch(base + path, { signal: AbortSignal.timeout(30000), ...options });
function form(bytes, filename = 'logo.png') {
  const payload = new FormData();
  payload.set('logo', new Blob([bytes], { type: 'image/png' }), filename);
  return payload;
}
function put(path, bytes, headers = {}, filename = 'logo.png') {
  return request(path, {
    method: 'PUT',
    headers: { Origin: origin, 'If-Match': 'branding-1', ...headers },
    body: form(bytes, filename),
  });
}
const login = await request('/api/v1/auth/login', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'ci-only-test-admin-password',
  }),
});
assert.equal(login.status, 200, 'the disposable staff fixture must exist');
const session = await login.json();
assert.equal(session.mustChangePassword, false);
const authorized = {
  Cookie: login.headers.get('set-cookie').split(';')[0],
  'X-CSRF-Token': session.csrfToken,
};
try {
  // Even after fixing the proxy cap, neither route may bypass API ownership,
  // CSRF or image decoding. Only authenticated, valid images are persisted.
  const tiny = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
  for (const route of [
    '/api/v1/admin/branding/logo',
    '/api/v1/admin/branding/hardcore/logo',
  ]) {
    assert.equal((await put(route, tiny)).status, 401, route + ': session');
    assert.equal(
      (await put(route, tiny, { Cookie: authorized.Cookie })).status,
      403,
      route + ': CSRF',
    );
    assert.equal(
      (await put(route, tiny, { ...authorized, 'X-CSRF-Token': 'invalid' }))
        .status,
      403,
      route + ': forged CSRF',
    );
    assert.equal(
      (await put(route, Buffer.from('not a logo'), authorized)).status,
      400,
      route + ': decoder validation',
    );
  }

  // The real PNG is >4 MiB (greater than the regular 3 MiB Nginx limit), not
  // a random multipart body pretending to be an image. This reaches Sharp.
  const makeLargePng = () =>
    sharp(randomBytes(1220 * 1220 * 3), {
      raw: { width: 1220, height: 1220, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
  const normal = await makeLargePng();
  const hardcore = await makeLargePng();
  for (const bytes of [normal, hardcore])
    assert.ok(bytes.length > 4 * 1024 * 1024 && bytes.length < fileLimit);

  const ordinaryPath = '/api/v1/admin/branding/logo';
  const hardcorePath = '/api/v1/admin/branding/hardcore/logo';
  const ordinary = await put(ordinaryPath, normal, authorized);
  assert.equal(ordinary.status, 200, 'ordinary >4 MiB through Nginx');
  const ordinaryReceipt = await ordinary.json();
  assert.equal(ordinaryReceipt.revision, 'branding-2');
  assert.match(
    ordinaryReceipt.logoPath,
    /^\/api\/v1\/branding\/[a-zA-Z0-9_-]+\.webp$/u,
  );

  const hc = await put(hardcorePath, hardcore, authorized);
  assert.equal(hc.status, 200, 'hardcore >4 MiB through Nginx');
  const hcReceipt = await hc.json();
  assert.equal(hcReceipt.revision, 'branding-2');
  assert.notEqual(hcReceipt.logoPath, ordinaryReceipt.logoPath);
  assert.equal(
    (await (await request('/api/v1/branding')).json()).logoPath,
    ordinaryReceipt.logoPath,
  );
  assert.equal(
    (await (await request('/api/v1/branding/hardcore')).json()).logoPath,
    hcReceipt.logoPath,
  );
  assert.equal((await request(ordinaryReceipt.logoPath)).status, 200);
  assert.equal((await request(hcReceipt.logoPath)).status, 200);

  // A file larger than the documented 10 MiB is stopped by Fastify, while
  // still fitting inside the proxy's multipart allowance.
  const overFile = Buffer.alloc(fileLimit + 1);
  for (const route of [ordinaryPath, hardcorePath]) {
    const response = await put(route, overFile, authorized);
    assert.equal(response.status, 413, route + ': >10 MiB file');
    assert.match(
      response.headers.get('content-type') ?? '',
      /application\/json/u,
    );
  }

  // The proxy itself rejects any multipart body over 11 MiB, for either logo
  // route; the generic 3 MiB cap must still apply on non-logo API routes.
  const overProxy = Buffer.alloc(proxyLimit + 1);
  for (const route of [ordinaryPath, hardcorePath]) {
    const response = await put(route, overProxy, authorized);
    assert.equal(response.status, 413, route + ': >11 MiB body');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/u);
  }
  for (const route of [
    '/api/v1/admin/catalog/icons',
    '/api/v1/admin/branding/logo/extra',
    '/api/v1/admin/branding/hardcore/logo/extra',
  ]) {
    const response = await put(route, normal, authorized);
    assert.equal(response.status, 413, route + ': unrelated 3 MiB cap');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/u);
  }
  console.log(
    'Both exact Nginx branding routes accept valid >4 MiB images and reject excessive files/bodies; default cap and auth/CSRF remain enforced.',
  );
} finally {
  const logout = await request('/api/v1/auth/logout', {
    method: 'POST',
    headers: { Origin: origin, ...authorized },
  });
  assert.equal(logout.status, 204);
}
