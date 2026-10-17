/** Test-only TLS terminator. No host ports, external DNS, production certs or API fixtures. */
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { forward } from '../tests-security/proxy.mjs';

if (
  process.env.STACK_BROWSER_TEST !== '1' ||
  !/^clog-checks-[a-z0-9-]+$/u.test(process.env.COMPOSE_PROJECT_NAME ?? '') ||
  process.env.PUBLIC_ORIGIN !== 'https://clog.example.com'
)
  throw new Error('Disposable HTTPS browser tests only');
if ((await lookup('clog.example.com')).address !== '127.0.0.1')
  throw new Error('Test origin must resolve inside this runner');
const directory = await mkdtemp(join(tmpdir(), 'clog-browser-tls-'));
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=clog.example.com',
      '-addext',
      'subjectAltName=DNS:clog.example.com',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const server = createServer(
    {
      key: await readFile(join(directory, 'key.pem')),
      cert: await readFile(join(directory, 'cert.pem')),
    },
    (request, response) => {
      request.headers['x-forwarded-proto'] = 'https';
      forward(request, response);
    },
  );
  const close = () =>
    server.close(() => {
      void rm(directory, { recursive: true, force: true });
    });
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  server.listen(443, '127.0.0.1');
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
