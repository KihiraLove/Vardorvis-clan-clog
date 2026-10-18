/** Focused real-image coverage for automatic startup and shared Compose isolation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const image = process.env.CHECK_APP_IMAGE;
if (!image) throw Error('Set CHECK_APP_IMAGE to the disposable test image');
const directory = await mkdtemp(path.join(tmpdir(), 'clog-installation-'));
const project = 'clog-checks-installation-' + randomBytes(6).toString('hex');
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: path.join(directory, 'compose.json'),
  COMPOSE_ENV_FILES: path.join(directory, 'empty.env'),
  COMPOSE_DISABLE_ENV_FILE: 'true',
};
async function run(args, { input, fail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if ((code !== 0) !== fail)
        reject(
          Error(
            'Installation check command failed: ' +
              args[0] +
              ' ' +
              args[1] +
              '; ' +
              stderr.replace(
                /Temporary password: \S+/gu,
                'Temporary password: [redacted]',
              ),
          ),
        );
      else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const compose = (args, options) => run(['compose', ...args], options);
const command = (service, code, options) =>
  compose(
    ['exec', '-T', '--user', '0', service, 'node', '--input-type=module'],
    { input: code, ...options },
  );
async function ready(service) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const text = await compose(
      ['exec', '-T', '--user', '0', service, 'clog', 'status'],
      { fail: false },
    ).catch(() => null);
    if (text && JSON.parse(text).phase === 'running') {
      if (
        (await command(
          service,
          "console.log((await fetch('http://127.0.0.1:8080/readyz').catch(()=>({status:0}))).status)",
        )) === '200'
      )
        return;
    }
    await delay(500);
  }
  throw Error('Installation readiness deadline expired: ' + service);
}
const service = (volume) => ({
  image,
  restart: 'no',
  stop_grace_period: '90s',
  environment: {
    PUBLIC_ORIGIN: 'https://clog.example.com',
    BOT_SETTINGS_MODE: 'disabled',
  },
  volumes: [volume + ':/data'],
});
try {
  await writeFile(env.COMPOSE_ENV_FILES, '');
  await writeFile(
    env.COMPOSE_FILE,
    JSON.stringify({
      services: {
        first: service('first-data'),
        second: service('second-data'),
        unrelated: {
          image,
          entrypoint: ['node', '-e', 'setInterval(()=>{},1000)'],
          restart: 'no',
        },
      },
      volumes: { 'first-data': {}, 'second-data': {} },
    }),
  );
  // Interrupt a fresh bootstrap as soon as the early credential is visible.
  await compose(['create', 'first']);
  const interrupted = await compose(['ps', '--all', '-q', 'first']);
  await run(['start', interrupted]);
  let pending;
  for (let i = 0; i < 100; i++) {
    pending = /Temporary password: ([a-f0-9]{64})/u.exec(
      await run(['logs', interrupted]),
    )?.[1];
    if (pending) break;
    await delay(50);
  }
  assert.ok(
    pending,
    'Credential is visible before first initialization completes',
  );
  await run(['kill', '--signal', 'KILL', interrupted]);
  await compose(['up', '-d', 'unrelated', 'first', 'second']);
  await ready('first');
  await ready('second');
  const sentinel = await compose(['ps', '-q', 'unrelated']);
  const started = await run([
    'inspect',
    '--format',
    '{{.State.StartedAt}}',
    sentinel,
  ]);
  const first = await compose(['ps', '-q', 'first']);
  const initialLogs = await run(['logs', first]);
  const password = /Temporary password: ([a-f0-9]{64})/u.exec(initialLogs)?.[1];
  assert.ok(password, 'First-login credential printed');
  assert.equal(password, pending);
  assert.ok(
    initialLogs.indexOf('FIRST LOGIN') <
      initialLogs.indexOf('Installation initialized'),
  );
  const identity = await compose([
    'exec',
    '-T',
    '--user',
    '0',
    'first',
    'clog',
    'identity',
  ]);
  assert.notEqual(
    identity,
    await compose(['exec', '-T', '--user', '0', 'second', 'clog', 'identity']),
  );
  await compose([
    'exec',
    '-T',
    '--user',
    '1000',
    'first',
    'sh',
    '-c',
    'test ! -r /data/system/postgres/value && test -r /data/system/app/value && test ! -w /data/system/app/value && test -r /data/system/session/value && test ! -w /data/system/session/value && test ! -r /run/clog/control.sock',
  ]);
  // Recreate before first login: pending password must remain valid and unchanged.
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'first']);
  await ready('first');
  const repeated = await run(['logs', await compose(['ps', '-q', 'first'])]);
  assert.equal(
    /Temporary password: ([a-f0-9]{64})/u.exec(repeated)?.[1],
    password,
  );
  await command(
    'first',
    `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const {password}=JSON.parse(await readFile('/data/bootstrap/administrator.json','utf8'));
const response=await fetch('http://127.0.0.1:8080/api/v1/auth/login',{method:'POST',headers:{Origin:'https://clog.example.com','Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});assert.equal(response.status,200);
const body=await response.json();const result=await fetch('http://127.0.0.1:8080/api/v1/auth/account',{method:'PATCH',headers:{Origin:'https://clog.example.com','Content-Type':'application/json',Cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':body.csrfToken},body:JSON.stringify({currentPassword:password,newPassword:'installation-only-permanent-password',username:'owner'})});assert.equal(result.status,200);`,
  );
  await compose([
    'exec',
    '-T',
    '--user',
    '0',
    'first',
    'test',
    '!',
    '-e',
    '/data/bootstrap/administrator.json',
  ]);
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'first']);
  await ready('first');
  const permanentLogs = await run([
    'logs',
    await compose(['ps', '-q', 'first']),
  ]);
  assert.ok(!permanentLogs.includes('Temporary password:'));
  assert.equal(
    await compose(['exec', '-T', '--user', '0', 'first', 'clog', 'identity']),
    identity,
  );
  await command(
    'first',
    `import assert from 'node:assert/strict';const r=await fetch('http://127.0.0.1:8080/api/v1/auth/login',{method:'POST',headers:{Origin:'https://clog.example.com','Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'installation-only-permanent-password'})});assert.equal(r.status,200);`,
  );
  // Maintenance marker survives restart; PostgreSQL stays available with writers stopped.
  await compose(['exec', '-T', '--user', '0', 'first', 'clog', 'pause']);
  let status = JSON.parse(
    await compose(['exec', '-T', '--user', '0', 'first', 'clog', 'status']),
  );
  assert.equal(status.database, true);
  assert.equal(status.workers, false);
  await compose(['restart', 'first']);
  for (let i = 0; i < 60; i++) {
    status = JSON.parse(
      await compose([
        'exec',
        '-T',
        '--user',
        '0',
        'first',
        'clog',
        'status',
      ]).catch(() => '{}'),
    );
    if (status.phase === 'maintenance') break;
    await delay(500);
  }
  assert.equal(status.phase, 'maintenance');
  assert.equal(status.workers, false);
  await compose(['exec', '-T', '--user', '0', 'first', 'clog', 'resume']);
  await ready('first');
  const fingerprints = async () =>
    JSON.parse(
      await command(
        'first',
        "import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';const result={};for(const kind of ['postgres','app','session'])result[kind]=createHash('sha256').update(await readFile('/data/system/'+kind+'/value')).digest('hex');console.log(JSON.stringify(result));",
      ),
    );
  let keys = await fingerprints();
  for (const kind of ['app', 'session', 'postgres']) {
    await compose([
      'exec',
      '-T',
      '--user',
      '0',
      'first',
      'clog',
      'rotate',
      kind,
    ]);
    const next = await fingerprints();
    for (const key of Object.keys(keys))
      assert.equal(keys[key] === next[key], key !== kind);
    keys = next;
    await ready('first');
  }
  // Rotation and restart must preserve the permanent account as well as DB data.
  await compose(['restart', 'first']);
  await ready('first');
  assert.equal(
    JSON.parse(
      await compose(['exec', '-T', '--user', '0', 'first', 'clog', 'identity']),
    ).id,
    JSON.parse(identity).id,
  );
  await ready('second');
  assert.equal(
    await run(['inspect', '--format', '{{.State.StartedAt}}', sentinel]),
    started,
  );
  console.log(
    'Installation checks passed: early automatic password, pending retry, permanent account preservation, private credentials, all three credential rotations, two independent instances and persistent maintenance alongside an unrelated service.',
  );
} finally {
  await compose(['down', '--volumes', '--remove-orphans']);
  await rm(directory, { recursive: true, force: true });
}
