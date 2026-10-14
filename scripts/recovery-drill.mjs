/** Real database/filesystem restore and versioned deployment failures, with no host data mounted. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
if (
  !/^clog-checks-[a-z0-9-]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? '') ||
  !process.env.CHECK_APP_IMAGE
)
  throw new Error('Use the disposable full acceptance runner');
const root = await mkdtemp(path.join(tmpdir(), 'clog-recovery-')),
  id = path.basename(root).toLowerCase(),
  project = 'clog-restore-' + id;
const evidence = path.resolve('.data/local-checks/recovery');
await mkdir(evidence, { recursive: true });
const secrets = [
  process.env.POSTGRES_PASSWORD,
  process.env.APP_DB_PASSWORD,
  process.env.SESSION_SECRET,
  process.env.ADMIN_BOOTSTRAP_PASSWORD,
].filter(Boolean);
const scenarios = [],
  tags = [],
  fixtureContainers = [];
let failure, cleanupFailure;
let expectedFailures = 0;
const safe = (value) =>
  secrets.reduce(
    (text, secret) => text.replaceAll(secret, '[redacted]'),
    value,
  );
function run(
  command,
  args,
  { env = {}, cwd = process.cwd(), input, expectFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if ((code !== 0) !== expectFailure) {
        void writeFile(
          path.join(evidence, 'last-failure.log'),
          safe(stderr.slice(-12000) + '\n' + stdout.slice(-4000)),
        );
        reject(
          new Error(
            expectFailure
              ? 'Expected failure was accepted'
              : 'Recovery command failed: ' +
                  command +
                  ' ' +
                  args[0] +
                  ' (' +
                  code +
                  ')',
          ),
        );
      } else if (expectFailure) {
        const result = {
          stdout: safe(stdout.trim()),
          stderr: safe(stderr.trim()),
        };
        void writeFile(
          path.join(
            evidence,
            'expected-failure-' + ++expectedFailures + '.log',
          ),
          result.stderr + '\n' + result.stdout,
        );
        resolve(result);
      } else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const docker = (args, options) => run('docker', args, options);
const compose = (args, options = {}) => docker(['compose', ...args], options);
const stateScript = await readFile('scripts/recovery-state.mjs');
const appState = (mode, env = {}) =>
  compose(
    [
      'exec',
      '-T',
      '-e',
      'RECOVERY_DISPOSABLE=true',
      ...(env.RECOVERY_OLD_PASSWORD
        ? ['-e', 'RECOVERY_OLD_PASSWORD=' + env.RECOVERY_OLD_PASSWORD]
        : []),
      'app',
      'node',
      '--input-type=module',
      '-',
      mode,
    ],
    { env, input: stateScript },
  );
const snapshot = (env = {}) =>
  compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      'RECOVERY_DISPOSABLE=true',
      'migrate',
      'node',
      '--input-type=module',
      '-',
      'snapshot',
    ],
    { env, input: stateScript },
  ).then(JSON.parse);
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stable = (value) =>
  Object.fromEntries(
    Object.entries(value.tables).filter(
      ([name]) => !['admin_sessions', 'auth_rate_limits'].includes(name),
    ),
  );
let cloneEnv;
try {
  console.log(
    'Recovery: seed complete representative state and capture the real versioned backup.',
  );
  const baseId = await docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    process.env.CHECK_APP_IMAGE,
  ]);
  const container = await docker([
    'create',
    '--label',
    'clog.recovery=' + id,
    baseId,
  ]);
  fixtureContainers.push(container);
  const bundle = path.join(root, 'source-bundle');
  await mkdir(bundle);
  await docker(['cp', container + ':/opt/clog-release/.', bundle]);
  const manifest = JSON.parse(
    await readFile(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  const sourceDb = await compose(['ps', '-q', 'db']);
  const dbId = await docker(['inspect', '--format', '{{.Image}}', sourceDb]);
  const dbDigest = await docker([
    'image',
    'inspect',
    '--format',
    '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}',
    dbId,
  ]);
  const sourceSchema = JSON.parse(
    await compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'migrate',
      'node',
      'packages/database/dist/release-state.js',
      '--exact',
    ]),
  );
  await writeFile(
    '.current-release.json',
    JSON.stringify({
      format: 1,
      revision: manifest.revision,
      image: baseId,
      dbImage: dbDigest,
      infrastructure: bundle,
      launcherChecksum: checksum(await readFile('infra/deploy.sh')),
      bundleChecksum: checksum(
        await readFile(path.join(bundle, 'manifest.json')),
      ),
      evidence: manifest.evidence,
      schema: sourceSchema,
      testOverlayChecksum: checksum(await readFile('compose.checks.yaml')),
    }),
  );
  await appState('seed');
  const before = await snapshot();
  const backup = path.join(root, 'backup');
  await run('bash', ['infra/backup.sh', backup], {
    env: { CLOG_RELEASE_DIR: bundle },
  });
  scenarios.push(
    'real coordinated backup with actual image/schema/infrastructure evidence',
  );
  const target = path.join(root, 'clone');
  await mkdir(target);
  const settings = {
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    APP_DB_PASSWORD: randomBytes(32).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ADMIN_BOOTSTRAP_PASSWORD: randomBytes(32).toString('hex'),
    AUTH_ENABLED: 'true',
    PUBLIC_ORIGIN: 'https://clog.example.com',
    BOT_ENABLED: 'false',
  };
  secrets.push(
    ...Object.values(settings).filter((value) => /^[a-f0-9]{64}$/.test(value)),
  );
  const writeEnv = () =>
    writeFile(
      path.join(target, '.env'),
      Object.entries(settings)
        .map(([k, v]) => k + '=' + v)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  await writeEnv();
  cloneEnv = {
    ...settings,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE:
      path.join(target, 'releases/restored/compose.yaml') +
      ':' +
      path.join(target, 'releases/restored/compose.release.yaml') +
      ':' +
      path.join(target, 'releases/restored/compose.isolated.yaml'),
    COMPOSE_ENV_FILES: path.join(target, '.env'),
    COMPOSE_DISABLE_ENV_FILE: 'true',
    RELEASE_IMAGE: baseId,
    RELEASE_DB_IMAGE: dbDigest,
    IMAGE_TAG: manifest.revision,
  };
  await run('bash', ['infra/restore.sh', backup, project, target], {
    env: settings,
  });
  const after = await snapshot(cloneEnv);
  assert.deepEqual(
    after,
    before,
    'Every public table and both filesystem inventories must restore exactly',
  );
  await appState('verify', cloneEnv);
  const appContainer = await compose(['ps', '-q', 'app'], { env: cloneEnv });
  const isolated = JSON.parse(await docker(['inspect', appContainer]))[0];
  assert.deepEqual(isolated.HostConfig.PortBindings, {});
  assert.ok(!Object.keys(isolated.NetworkSettings.Networks).includes('web'));
  assert.ok(isolated.Config.Env.includes('BOT_ENABLED=false'));
  scenarios.push(
    'fresh namespace: all database tables/files exact; accounts/credits/audits/XP/schedules/catalog preserved; assets/private access/key decryption verified',
  );
  // Integrity and reuse checks must fail without changing the healthy restored stack.
  let started = await docker([
    'inspect',
    '--format',
    '{{.State.StartedAt}}',
    appContainer,
  ]);
  await run('bash', ['infra/restore.sh', backup, project, target], {
    expectFailure: true,
  });
  const corrupt = path.join(root, 'corrupt');
  await cp(backup, corrupt, { recursive: true });
  await writeFile(path.join(corrupt, 'icons.tar.gz'), 'corrupt');
  const rejectedTarget = path.join(root, 'rejected');
  await mkdir(rejectedTarget);
  await cp(path.join(target, '.env'), path.join(rejectedTarget, '.env'));
  await run(
    'bash',
    ['infra/restore.sh', corrupt, project + '-corrupt', rejectedTarget],
    { expectFailure: true },
  );
  await rm(path.join(corrupt, 'COMPLETE'));
  await run(
    'bash',
    ['infra/restore.sh', corrupt, project + '-incomplete', rejectedTarget],
    { expectFailure: true },
  );
  assert.equal(
    await docker(['inspect', '--format', '{{.State.StartedAt}}', appContainer]),
    started,
  );
  scenarios.push(
    'corrupt/incomplete backup and existing namespace rejected without touching healthy clone',
  );
  const prefix = id,
    originalTag = prefix + '-app:sha-' + manifest.revision;
  await docker(['tag', baseId, originalTag]);
  tags.push(originalTag);
  const deployEnv = {
    ...cloneEnv,
    CLOG_DEPLOY_ROOT: target,
    CLOG_DEPLOY_PROJECT: project,
    CLOG_IMAGE_PREFIX: prefix,
  };
  const deploy = (revision, expectFailure = false) =>
    run('bash', [path.resolve('infra/deploy.sh'), revision], {
      env: deployEnv,
      expectFailure,
    });
  // A crash between optional pointer-cache writes cannot redirect the canonical release record.
  await writeFile(
    path.join(target, '.current-infrastructure'),
    path.join(root, 'stale-pointer'),
  );
  await run(
    'bash',
    [
      path.resolve('infra/backup-current.sh'),
      path.join(root, 'canonical-state-backup'),
    ],
    { env: deployEnv },
  );
  scenarios.push(
    'canonical atomic release record controls backup despite stale convenience pointer',
  );
  started = await docker([
    'inspect',
    '--format',
    '{{.State.StartedAt}}',
    appContainer,
  ]);
  await deploy('f'.repeat(40), true);
  assert.equal(
    await docker(['inspect', '--format', '{{.State.StartedAt}}', appContainer]),
    started,
  );
  scenarios.push('unavailable image leaves current writer untouched');
  // Controlled release candidates share the real runtime; only revision/schema fixtures differ.
  async function candidate(kind) {
    const revision = randomBytes(20).toString('hex'),
      directory = path.join(root, kind),
      payload = path.join(directory, 'bundle');
    await mkdir(directory);
    await cp(bundle, payload, { recursive: true });
    const value = structuredClone(manifest);
    value.revision = revision;
    let extra = '';
    if (kind === 'older') {
      const last = value.migrations.pop(),
        file = 'packages/database/migrations/' + last.name;
      delete value.files[file];
      await rm(path.join(payload, file));
      extra = 'RUN rm /app/' + file + '\n';
    }
    if (kind === 'failed-migration') {
      const name = '021_recovery_failure.sql',
        file = 'packages/database/migrations/' + name,
        sql =
          'CREATE TABLE recovery_rollback_marker(id integer); SELECT 1/0;\n';
      await writeFile(path.join(payload, file), sql);
      value.files[file] = checksum(sql);
      value.migrations.push({ name, checksum: checksum(sql) });
      extra = 'COPY bundle/' + file + ' /app/' + file + '\n';
    }
    const json = JSON.stringify(value, null, 2) + '\n';
    await writeFile(path.join(payload, 'manifest.json'), json);
    await writeFile(
      path.join(payload, 'SHA256SUMS'),
      [...Object.entries(value.files), ['manifest.json', checksum(json)]]
        .map(([name, hash]) => hash + '  ' + name)
        .join('\n') + '\n',
    );
    await writeFile(
      path.join(directory, 'Dockerfile'),
      `FROM ${process.env.CHECK_APP_IMAGE}\nUSER root\nCOPY bundle /opt/clog-release\n${extra}LABEL org.opencontainers.image.revision="${revision}"\nUSER node\n`,
    );
    if (kind === 'tampered')
      await writeFile(
        path.join(payload, 'infra/start-app.sh'),
        '# invalid changed helper\n',
      );
    const tag = prefix + '-app:sha-' + revision;
    tags.push(tag);
    await docker(['build', '--network=none', '--tag', tag, directory]);
    return revision;
  }
  const tampered = await candidate('tampered');
  const rejectedInfrastructure = await deploy(tampered, true);
  assert.match(rejectedInfrastructure.stderr, /checksum.*match/iu);
  assert.equal(
    await docker(['inspect', '--format', '{{.State.StartedAt}}', appContainer]),
    started,
  );
  scenarios.push(
    'changed infrastructure bytes rejected before execution or writer stop',
  );
  const older = await candidate('older');
  await deploy(older, true);
  assert.equal(
    await docker(['inspect', '--format', '{{.State.StartedAt}}', appContainer]),
    started,
  );
  scenarios.push(
    'older image missing applied migration rejected before writer stop',
  );
  const broken = await candidate('failed-migration');
  await deploy(broken, true);
  let failedMigrationLog;
  for (const name of await readdir(path.join(target, 'evidence'))) {
    const directory = path.join(target, 'evidence', name);
    const candidateInfo = await readFile(
      path.join(directory, 'candidate.json'),
      'utf8',
    )
      .then(JSON.parse)
      .catch(() => null);
    if (candidateInfo?.revision === broken) {
      assert.equal(
        (await readFile(path.join(directory, 'status'), 'utf8'))
          .trim()
          .startsWith('failed'),
        true,
      );
      failedMigrationLog = await readFile(
        path.join(directory, 'bootstrap.log'),
        'utf8',
      );
    }
  }
  assert.match(
    failedMigrationLog ?? '',
    /division by zero/u,
    'The transaction must execute the injected failing SQL',
  );
  await writeFile(
    path.join(evidence, 'migration-failure.log'),
    safe(failedMigrationLog),
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(target, '.current-release.json'), 'utf8'),
    ).revision,
    manifest.revision,
  );
  assert.equal(
    await compose(
      [
        'exec',
        '-T',
        'db',
        'psql',
        '-U',
        'clog',
        '-d',
        'clog',
        '-Atc',
        "SELECT to_regclass('public.recovery_rollback_marker') IS NULL AND (SELECT count(*) FROM schema_migrations)=20",
      ],
      { env: cloneEnv },
    ),
    't',
  );
  await deploy(manifest.revision);
  assert.deepEqual(stable(await snapshot(cloneEnv)), stable(before));
  scenarios.push(
    'partial DDL migration failure rolls back; successful release evidence retained; compatible recovery redeploy succeeds',
  );
  const compatible = await candidate('compatible');
  await deploy(compatible);
  assert.equal(
    JSON.parse(
      await readFile(path.join(target, '.current-release.json'), 'utf8'),
    ).revision,
    compatible,
  );
  await deploy(manifest.revision);
  assert.equal(
    JSON.parse(
      await readFile(path.join(target, '.previous-release.json'), 'utf8'),
    ).revision,
    compatible,
  );
  assert.deepEqual(stable(await snapshot(cloneEnv)), stable(before));
  scenarios.push(
    'controlled compatible image promotion and approved previous-image rollback preserve all business tables',
  );
  const oldPassword = settings.APP_DB_PASSWORD;
  settings.APP_DB_PASSWORD = randomBytes(32).toString('hex');
  secrets.push(settings.APP_DB_PASSWORD);
  await writeEnv();
  cloneEnv.APP_DB_PASSWORD = settings.APP_DB_PASSWORD;
  await deploy(manifest.revision);
  await appState('old-credentials', {
    ...cloneEnv,
    RECOVERY_OLD_PASSWORD: oldPassword,
  });
  await appState('verify', cloneEnv);
  assert.deepEqual(stable(await snapshot(cloneEnv)), stable(before));
  scenarios.push(
    'runtime credential rotation rejects new connections with old secret and preserves restricted access/state',
  );
  const crashed = await compose(['ps', '-q', 'app'], { env: cloneEnv });
  await compose(
    [
      'exec',
      '-T',
      'app',
      'node',
      '--input-type=module',
      '-e',
      `import {readdir,readFile} from 'node:fs/promises'; let found=false; for(const pid of await readdir('/proc')) { if(!/^\\d+$/.test(pid))continue; const command=await readFile('/proc/'+pid+'/cmdline','utf8').catch(()=> ''); if(command.startsWith('node\\0apps/api/dist/server.js\\0')) {process.kill(Number(pid),'SIGKILL'); found=true; break;} } if(!found) process.exit(1);`,
    ],
    { env: cloneEnv },
  );
  for (let i = 0; i < 50; i++) {
    if (
      (await docker(['inspect', '--format', '{{.State.Running}}', crashed])) ===
      'false'
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    await docker(['inspect', '--format', '{{.State.Running}}', crashed]),
    'false',
  );
  assert.notEqual(
    await docker(['inspect', '--format', '{{.State.ExitCode}}', crashed]),
    '0',
  );
  await deploy(manifest.revision);
  assert.deepEqual(stable(await snapshot(cloneEnv)), stable(before));
  scenarios.push(
    'critical API process crash fails container; versioned recovery retains all data and receipts',
  );
  await writeFile(
    path.join(evidence, 'inventory.json'),
    JSON.stringify(before, null, 2) + '\n',
  );
  await cp(
    path.join(target, '.current-release.json'),
    path.join(evidence, 'release.json'),
  );
  await writeFile(
    path.join(evidence, 'source-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(
    'Recovery: complete restore, schema/deployment failure, rollback, rotation and process-crash scenarios passed.',
  );
} catch (error) {
  failure = error;
} finally {
  if (cloneEnv) {
    try {
      for (const cleanupProject of [
        project,
        project + '-corrupt',
        project + '-incomplete',
      ]) {
        const containers = await docker([
          'ps',
          '-aq',
          '--filter',
          'label=com.docker.compose.project=' + cleanupProject,
        ]);
        for (const container of containers.split('\n').filter(Boolean))
          assert.equal(
            await docker([
              'inspect',
              '--format',
              '{{index .Config.Labels "com.docker.compose.project"}}',
              container,
            ]),
            cleanupProject,
          );
        if (containers)
          await compose(['down', '--volumes', '--remove-orphans'], {
            env: { ...cloneEnv, COMPOSE_PROJECT_NAME: cleanupProject },
          });
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }
  for (const container of fixtureContainers)
    await docker(['rm', '--force', container]).catch((error) => {
      cleanupFailure = error;
    });
  for (const tag of tags)
    await docker(['image', 'rm', tag]).catch((error) => {
      cleanupFailure = error;
    });
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        status: failure || cleanupFailure ? 'failed' : 'passed',
        scenarios,
        cleanup: cleanupFailure ? 'failed' : 'passed',
        error: failure?.message,
      },
      null,
      2,
    ) + '\n',
  );
  if (!cleanupFailure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
if (cleanupFailure) throw cleanupFailure;
