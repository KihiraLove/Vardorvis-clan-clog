import { databaseUrl as runtimeDatabaseUrl } from '@clog/database/dist/secrets.js';
/** Regression checks for the disposable bundled image; never run against clan data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';

if (process.env.REVIEW_SMOKE_TEST !== '1')
  throw new Error('For disposable CI databases only');
const origin = process.env.PUBLIC_ORIGIN;
const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
if (!password)
  throw new Error('Disposable smoke test requires ADMIN_BOOTSTRAP_PASSWORD');
function request(
  path,
  { ip = '127.0.0.3', method = 'GET', headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path,
        localAddress: ip,
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(5000, () =>
      req.destroy(new Error('Smoke request timed out')),
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
// Actual Nginx appends its peer; attacker-supplied prefixes cannot change buckets.
for (let i = 0; i < 20; i++) {
  const result = await request('/api/v1/auth/login', {
    ip: '127.0.0.2',
    method: 'POST',
    body: { username: 'admin', password: 'wrong-password' },
  });
  assert.equal(result.status, 401);
}
assert.equal(
  (
    await request('/api/v1/auth/login', {
      ip: '127.0.0.2',
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.9' },
      body: { username: 'admin', password },
    })
  ).status,
  429,
);
const login = await request('/api/v1/auth/login', {
  method: 'POST',
  body: { username: 'admin', password },
});
assert.equal(
  login.status,
  200,
  'A different client must retain its own login budget',
);
const headers = {
  Cookie: login.headers['set-cookie'][0].split(';')[0],
  'X-CSRF-Token': login.body.csrfToken,
  'Idempotency-Key': randomUUID(),
};
assert.equal(login.body.mustChangePassword, true);
assert.equal(
  (await request('/api/v1/admin/accounts', { headers })).status,
  403,
);
const setup = await request('/api/v1/auth/account', {
  method: 'PATCH',
  headers,
  body: {
    currentPassword: password,
    newPassword: 'ci-only-test-admin-password',
  },
});
assert.equal(setup.status, 200);
headers.Cookie = setup.headers['set-cookie'][0].split(';')[0];
headers['X-CSRF-Token'] = setup.body.csrfToken;
assert.equal(setup.body.mustChangePassword, false);
const catalog = await request('/api/v1/catalog');
assert.equal(catalog.status, 200);
const body = {
  itemId: catalog.body.items[0].id,
  collectorName: 'CI retry fixture',
  collectedOn: new Date().toISOString().slice(0, 10),
  hardcore: false,
  approve: false,
};
const [first, replay] = await Promise.all(
  [1, 2].map(() =>
    request('/api/v1/admin/submissions', { method: 'POST', headers, body }),
  ),
);
assert.equal(first.status, 201);
assert.equal(replay.status, 201);
assert.deepEqual(replay.body, first.body);
const rejection = await request(
  '/api/v1/admin/submissions/' + first.body.id + '/reject',
  {
    method: 'POST',
    headers,
    body: { expectedVersion: 1, reason: 'Disposable smoke fixture' },
  },
);
assert.equal(rejection.status, 200);
const later = await request('/api/v1/admin/submissions', {
  method: 'POST',
  headers,
  body,
});
assert.deepEqual(
  later.body,
  first.body,
  'Retry returns the original receipt after later review',
);
const db = new pg.Client({
  connectionString: runtimeDatabaseUrl(
    process.env,
    process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
  ),
});
await db.connect();
try {
  const grants = (
    await db.query(
      "SELECT current_user AS role, has_table_privilege(current_user,'manual_submission_requests','SELECT') AS read, has_table_privilege(current_user,'manual_submission_requests','INSERT') AS insert, has_table_privilege(current_user,'manual_submission_requests','UPDATE') AS update, has_table_privilege(current_user,'manual_submission_requests','DELETE') AS delete",
    )
  ).rows[0];
  assert.deepEqual(grants, {
    role: 'clog_runtime',
    read: true,
    insert: true,
    update: false,
    delete: false,
  });
} finally {
  await db.end();
}
assert.equal(
  (await request('/readyz')).status,
  200,
  'Disabled bot does not block readiness',
);
assert.equal(
  (await request('/api/v1/auth/logout', { method: 'POST', headers, body: {} }))
    .status,
  204,
);
console.log(
  'Proxy isolation, spoof resistance, durable manual retries, runtime grants and disabled-bot readiness passed.',
);
