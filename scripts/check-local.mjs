/** Full Linux acceptance on a local Docker engine, including on Windows/macOS. */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'clog.local-checks';

export function configuration(id, password = randomBytes(32).toString('hex')) {
  if (!/^clog-checks-[a-z0-9-]+$/.test(id))
    throw new Error('Invalid disposable project name');
  return {
    id,
    network: `${id}-network`,
    database: `${id}-database`,
    runner: `${id}-runner`,
    runnerImage: `clog-local-checks:${id}`,
    appImage: `clog-local-app:${id}`,
    env: {
      COMPOSE_PROJECT_NAME: id,
      COMPOSE_DISABLE_ENV_FILE: 'true',
      COMPOSE_PROFILES: '',
      CHECK_NETWORK: `${id}-network`,
      CHECK_APP_IMAGE: `clog-local-app:${id}`,
      IMAGE_TAG: id,
      POSTGRES_PASSWORD: password,
      APP_DB_PASSWORD: randomBytes(32).toString('hex'),
      AUTH_ENABLED: 'true',
      PUBLIC_ORIGIN: 'https://clog.example.com',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      ADMIN_BOOTSTRAP_PASSWORD: randomBytes(32).toString('hex'),
      BOT_ENABLED: 'false',
      BOT_SETTINGS_MODE: 'environment',
      BOT_API_TOKEN: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_APPLICATION_ID: '',
      DISCORD_GUILD_ID: '',
      DISCORD_TEST_GUILD_ID: '',
      TRUSTED_PROXY_CIDRS: '',
      TEST_DATABASE_URL: `postgresql://clog:${password}@${id}-database:5432/clog_test`,
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'Usage: node scripts/check-local.mjs\nRequires Node 24 and a running local Linux Docker engine. Runs all gates; no GitHub credentials needed.',
    );
    return;
  }
  if (args.length) throw new Error('Unknown arguments; use --help');
  const config = configuration(
    `clog-checks-${Date.now()}-${randomBytes(4).toString('hex')}`,
  );
  const output = path.join(root, '.data', 'local-checks', config.id);
  await mkdir(output, { recursive: true });
  const emptyEnv = path.join(output, 'empty.env');
  await writeFile(emptyEnv, '');
  const log = createWriteStream(path.join(output, 'run.log'));
  let active;
  let interrupted = false;
  let runnerCreated = false;
  let networkCreated = false;
  let databaseCreated = false;
  let status = 'failed';
  const cleanupErrors = [];
  const env = { ...process.env, ...config.env, COMPOSE_ENV_FILES: emptyEnv };
  const compose = [
    'compose',
    '--project-name',
    config.id,
    '--env-file',
    emptyEnv,
    '-f',
    'compose.yaml',
    '-f',
    'compose.checks.yaml',
  ];
  function run(command, commandArgs, quiet = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      active = child;
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!quiet) {
          process.stdout.write(chunk);
          log.write(chunk);
        }
      });
      child.stderr.on('data', (chunk) => {
        if (!quiet) {
          process.stderr.write(chunk);
          log.write(chunk);
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (active === child) active = undefined;
        if (code !== 0)
          reject(
            new Error(
              `${command} ${commandArgs[0]} failed (${code}); see ${output}`,
            ),
          );
        else resolve(stdout.trim());
      });
    });
  }
  const docker = (args, quiet) => run('docker', args, quiet);
  const cleanup = async (description, action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(description);
      console.error(`${description}: ${error.message}`);
    }
  };
  const owned = async (kind, name) => {
    const args =
      kind === 'network'
        ? [
            'network',
            'inspect',
            '--format',
            `{{index .Labels "${label}"}}`,
            name,
          ]
        : ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name];
    if ((await docker(args, true)) !== config.id)
      throw new Error(`Ownership mismatch for ${name}`);
  };
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    if (runnerCreated) {
      // Stop only our container; its attached docker process then exits and runs finally.
      void docker(['stop', '--time', '10', config.runner], true).catch(() =>
        active?.kill(),
      );
    } else active?.kill();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let failure;
  let revision = 'unavailable';
  try {
    if ((await docker(['info', '--format', '{{.OSType}}'], true)) !== 'linux')
      throw new Error(
        'Start Docker with Linux containers before running the full checks.',
      );
    revision = await run(
      'git',
      [
        '-c',
        `safe.directory=${root.replaceAll('\\', '/')}`,
        'rev-parse',
        'HEAD',
      ],
      true,
    ).catch(() => 'unavailable');
    console.log(
      `Local checks: ${config.id}\nLogs and browser evidence: ${output}`,
    );
    await docker([
      'build',
      '--target',
      'checks',
      '--tag',
      config.runnerImage,
      '.',
    ]);
    if (interrupted) throw new Error('Interrupted');
    await docker([
      'build',
      '--target',
      'app',
      '--build-arg',
      `RELEASE_REVISION=${revision}`,
      '--tag',
      config.appImage,
      '.',
    ]);
    if (interrupted) throw new Error('Interrupted');
    await docker([
      'network',
      'create',
      '--label',
      `${label}=${config.id}`,
      config.network,
    ]);
    networkCreated = true;
    await docker([
      'run',
      '--detach',
      '--name',
      config.database,
      '--label',
      `${label}=${config.id}`,
      '--network',
      config.network,
      '--env',
      'POSTGRES_USER=clog',
      '--env',
      `POSTGRES_PASSWORD=${config.env.POSTGRES_PASSWORD}`,
      '--env',
      'POSTGRES_DB=clog_test',
      '--health-cmd',
      'pg_isready -U clog -d clog_test',
      '--health-interval',
      '2s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      'postgres:17-alpine',
    ]);
    databaseCreated = true;
    let healthy = false;
    for (let attempt = 0; attempt < 60 && !interrupted; attempt++) {
      if (
        (await docker(
          ['inspect', '--format', '{{.State.Health.Status}}', config.database],
          true,
        )) === 'healthy'
      ) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy)
      throw new Error('Disposable PostgreSQL did not become healthy');
    const containerEnv = Object.entries({
      ...config.env,
      CHECK_REVISION: revision,
    }).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    // Source is copied by Dockerfile; no checkout, .env or host database is mounted.
    await docker([
      'create',
      '--init',
      '--name',
      config.runner,
      '--label',
      `${label}=${config.id}`,
      '--network',
      config.network,
      '--shm-size',
      '1g',
      // Browser TLS stays inside this runner; PUBLIC_ORIGIN matches real cookies/CSRF.
      '--add-host',
      'clog.example.com:127.0.0.1',
      '--mount',
      `type=bind,source=${process.env.LOCAL_DOCKER_SOCKET || '/var/run/docker.sock'},target=/var/run/docker.sock`,
      ...containerEnv,
      config.runnerImage,
    ]);
    runnerCreated = true;
    await docker(['start', '--attach', config.runner]);
    if (interrupted) throw new Error('Interrupted');
    status = 'passed';
  } catch (error) {
    failure = error;
  } finally {
    if (runnerCreated) {
      // Evidence retrieval must not turn a failed test into success.
      await docker(
        ['cp', `${config.runner}:/app/.data/local-checks/.`, output],
        true,
      ).catch(() => {});
      await docker(
        [
          'cp',
          `${config.runner}:/app/apps/web/test-results`,
          path.join(output, 'browser'),
        ],
        true,
      ).catch(() => {});
    }
    if (networkCreated)
      await cleanup('Compose cleanup', async () => {
        await owned('network', config.network);
        if (status !== 'passed')
          await docker([
            ...compose,
            'logs',
            '--no-color',
            '--tail',
            '80',
          ]).catch(() => {});
        await docker([...compose, 'down', '--volumes', '--remove-orphans']);
      });
    for (const [created, name] of [
      [runnerCreated, config.runner],
      [databaseCreated, config.database],
    ]) {
      if (created)
        await cleanup(`Container cleanup ${name}`, async () => {
          await owned('container', name);
          await docker(['rm', '--force', '--volumes', name]);
        });
    }
    if (networkCreated)
      await cleanup('Network cleanup', async () => {
        await owned('network', config.network);
        await docker(['network', 'rm', config.network]);
      });
    // Remove run-specific tags, retaining Docker's reusable build cache.
    for (const image of [config.runnerImage, config.appImage])
      await docker(['image', 'rm', image], true).catch(() => {});
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (cleanupErrors.length) status = 'failed';
    await writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          project: config.id,
          revision,
          status,
          interrupted,
          cleanupErrors,
          finishedAt: new Date().toISOString(),
          note: 'Tests cover the working tree copied by Docker, including uncommitted files.',
        },
        null,
        2,
      ) + '\n',
    );
    await new Promise((resolve) => log.end(resolve));
  }
  if (failure) throw failure;
  if (cleanupErrors.length)
    throw new Error(`Cleanup incomplete: ${cleanupErrors.join(', ')}`);
  console.log(`All gates passed. Evidence: ${output}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
