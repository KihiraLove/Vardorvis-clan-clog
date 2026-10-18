/** PID-1 child: one persistent installation, restricted workers, local PostgreSQL and root-only control. */
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  chownSync,
  fchownSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { initializeSecrets } from '@clog/database/dist/initialize-secrets.js';
import { writeManagedFile } from '@clog/database/dist/managed-secrets.js';
import { databaseUrl, readSecret } from '@clog/database/dist/secrets.js';
import { migrate } from '@clog/database/dist/migrate.js';
import { importBundledCatalog } from '@clog/database/dist/catalog-import.js';
import { applyBundledClueTaxonomy } from '@clog/database/dist/clue-taxonomy.js';
import { provisionRuntimeRole } from '@clog/database/dist/runtime-role.js';
import { safeFailure } from '@clog/domain';
import {
  prepareAdministrator,
  printAdministrator,
  provisionAdministrator,
} from './automatic-admin.js';

export const controlSocket = '/run/clog/control.sock';
export const systemDirectory = '/data/system';
const databaseDirectory = '/data/postgres';
function writeSystemFile(file: string, value: string) {
  writeManagedFile(file, value);
  chownSync(file, 0, 0);
}
export function protectSecrets() {
  chmodSync(systemDirectory, 0o755);
  for (const kind of ['postgres', 'app', 'session']) {
    const directory = join(systemDirectory, kind),
      owner = kind === 'postgres';
    chownSync(directory, 0, owner ? 0 : 1000);
    chmodSync(directory, owner ? 0o700 : 0o710);
    const file = join(directory, 'value');
    chownSync(file, 0, owner ? 0 : 1000);
    chmodSync(file, owner ? 0o600 : 0o440);
  }
}
export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('Installation command failed: ' + command)),
    );
  });
}
function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DB_USER: 'clog_runtime' };
  for (const name of [
    'POSTGRES_PASSWORD',
    'POSTGRES_PASSWORD_FILE',
    'DATABASE_URL',
    'DATABASE_URL_FILE',
    'ADMIN_BOOTSTRAP_PASSWORD',
    'ADMIN_BOOTSTRAP_PASSWORD_FILE',
  ])
    delete env[name];
  return env;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.getuid?.() !== 0)
    throw new Error('Installation supervisor must initialize as root');
  process.setgroups?.([]);
  // Nginx reopens /dev/stdout and /dev/stderr after dropping privileges.
  // Docker's inherited pipe descriptors otherwise remain owned by root.
  fchownSync(1, 1000, 1000);
  fchownSync(2, 1000, 1000);
  const mode = process.env.CLOG_START_MODE || 'normal';
  if (!['normal', 'restore', 'maintenance'].includes(mode))
    throw new Error('Invalid installation start mode');
  const bundled = process.env.CLOG_DATABASE_MODE !== 'external';
  if (
    !['bundled', 'external'].includes(
      process.env.CLOG_DATABASE_MODE || 'bundled',
    )
  )
    throw new Error('Invalid database mode');
  if (!bundled && mode === 'restore')
    throw new Error('Restore uses the bundled database on a fresh volume');
  const layoutFile = join(systemDirectory, 'layout.json'),
    marker = join(systemDirectory, 'maintenance.json');
  const administratorFile =
    process.env.CLOG_BOOTSTRAP_FILE || '/data/bootstrap/administrator.json';
  const databaseExists = existsSync(join(databaseDirectory, 'PG_VERSION'));
  const existingLayout = existsSync(layoutFile)
    ? (JSON.parse(readFileSync(layoutFile, 'utf8')) as {
        databaseInitialized: boolean;
      })
    : undefined;
  if (
    existingLayout &&
    !existsSync(join(systemDirectory, 'postgres/installation.json'))
  )
    throw new Error(
      'Installed credentials are missing; restore the complete installation',
    );
  if (mode === 'restore' && (databaseExists || existingLayout))
    throw new Error('Restore requires a new empty data volume');
  if (bundled && existingLayout?.databaseInitialized && !databaseExists)
    throw new Error(
      'Installed database is missing; restore the complete installation',
    );
  for (const directory of ['/run/clog', '/data/logs', systemDirectory])
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  mkdirSync('/run/clog/postgres', { recursive: true, mode: 0o755 });
  chownSync('/run/clog/postgres', 999, 999);
  let phase = 'credentials',
    stopping = false,
    expectedDatabaseStop = false;
  let database: ChildProcess | undefined, workers: ChildProcess | undefined;
  let shutdownPromise: Promise<void> | undefined,
    printedPassword = false;
  const initialization = new AbortController();
  const instance = randomUUID();
  let operation: Promise<unknown> = Promise.resolve();
  const logFile = openSync('/data/logs/bootstrap.log', 'a', 0o600);
  const seedEnv = { ...process.env };
  for (const [kind, name] of [
    ['postgres', 'POSTGRES_PASSWORD'],
    ['app', 'APP_DB_PASSWORD'],
    ['session', 'SESSION_SECRET'],
  ]) {
    if (seedEnv[name + '_FILE'] === join(systemDirectory, kind!, 'value'))
      delete seedEnv[name + '_FILE'];
  }
  const pendingRotation = existsSync(
    join(systemDirectory, 'postgres/rotation.json'),
  );
  if (readSecret('DATABASE_URL'))
    throw new Error(
      'Use DB_HOST, DB_PORT, DB_NAME and DB_USER for an external installation',
    );
  if (
    !bundled &&
    !existsSync(join(systemDirectory, 'postgres/value')) &&
    !readSecret('POSTGRES_PASSWORD', seedEnv)
  )
    throw new Error(
      'Supply the external database owner password file on first initialization',
    );
  initializeSecrets(
    systemDirectory,
    databaseDirectory,
    seedEnv,
    false,
    pendingRotation,
  );
  // Workers can read their runtime/session keys but cannot traverse the owner directory.
  protectSecrets();
  for (const [kind, name] of [
    ['postgres', 'POSTGRES_PASSWORD'],
    ['app', 'APP_DB_PASSWORD'],
    ['session', 'SESSION_SECRET'],
  ]) {
    delete process.env[name!];
    process.env[name + '_FILE'] = join(systemDirectory, kind!, 'value');
  }
  for (const directory of [
    process.env.ICON_STORAGE_PATH!,
    process.env.PROOF_STORAGE_PATH!,
  ]) {
    if (!directory) throw new Error('Installation storage paths are required');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chownSync(directory, 1000, 1000);
  }
  if (!existingLayout)
    writeSystemFile(
      layoutFile,
      JSON.stringify({ format: 2, databaseInitialized: databaseExists }) + '\n',
    );
  const fresh =
    bundled && !databaseExists && mode === 'normal' && !existsSync(marker);
  if (fresh) {
    const password = prepareAdministrator(administratorFile, true);
    if (password) {
      printAdministrator(password);
      printedPassword = true;
    }
  }
  async function stopChild(
    child: ChildProcess | undefined,
    signal: NodeJS.Signals,
    timeout: number,
  ) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill(signal);
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!ended) {
      child.kill('SIGKILL');
      throw new Error('Installation shutdown deadline expired');
    }
  }
  async function stopWorkers() {
    const old = workers;
    workers = undefined;
    await stopChild(old, 'SIGTERM', 70000);
  }
  async function stopDatabase() {
    expectedDatabaseStop = true;
    const old = database;
    database = undefined;
    await stopChild(old, 'SIGINT', 15000);
  }
  async function startDatabase() {
    if (!bundled || database) return;
    phase = 'database';
    if (!existsSync(join(databaseDirectory, 'PG_VERSION'))) {
      const staging = '/data/.postgres-initializing';
      if (existsSync(staging)) {
        if (lstatSync(staging).isSymbolicLink())
          throw new Error('Invalid database staging directory');
        if (!existsSync(join(staging, '.initialized')))
          rmSync(staging, { recursive: true });
      }
      if (!existsSync(staging)) {
        mkdirSync(staging, { mode: 0o700 });
        chownSync(staging, 999, 999);
        const passwordFile = '/run/clog/init-password';
        writeFileSync(passwordFile, readSecret('POSTGRES_PASSWORD')! + '\n', {
          mode: 0o600,
        });
        chownSync(passwordFile, 999, 999);
        try {
          await runProcess(
            'initdb',
            [
              '-D',
              staging,
              '--username=clog',
              '--pwfile=' + passwordFile,
              '--auth-host=scram-sha-256',
              '--auth-local=peer',
              '--no-locale',
              '--encoding=UTF8',
            ],
            {
              uid: 999,
              gid: 999,
              signal: initialization.signal,
              stdio: ['ignore', logFile, logFile],
            },
          );
          writeFileSync(join(staging, '.initialized'), 'complete\n');
        } finally {
          unlinkSync(passwordFile);
        }
      }
      if (stopping) return;
      if (existsSync(databaseDirectory)) {
        if (readdirSync(databaseDirectory).length)
          throw new Error('Database directory is not empty');
        rmSync(databaseDirectory);
      }
      renameSync(staging, databaseDirectory);
      writeFileSync(
        join(databaseDirectory, 'pg_hba.conf'),
        'local all clog peer map=clog_owner\nlocal all all scram-sha-256\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n',
      );
      writeFileSync(
        join(databaseDirectory, 'pg_ident.conf'),
        'clog_owner postgres clog\n',
      );
      chownSync(join(databaseDirectory, 'pg_hba.conf'), 999, 999);
      chownSync(join(databaseDirectory, 'pg_ident.conf'), 999, 999);
      writeSystemFile(
        layoutFile,
        JSON.stringify({ format: 2, databaseInitialized: true }) + '\n',
      );
    }
    if (stopping) return;
    expectedDatabaseStop = false;
    const child = spawn(
      'postgres',
      [
        '-D',
        databaseDirectory,
        '-h',
        '127.0.0.1',
        '-k',
        '/run/clog/postgres',
        '-c',
        'log_min_error_statement=panic',
        '-c',
        'log_parameter_max_length_on_error=0',
      ],
      { uid: 999, gid: 999, stdio: ['ignore', logFile, logFile] },
    );
    database = child;
    child.once('error', () => {
      void shutdown(1);
    });
    child.once('exit', () => {
      if (!stopping && !expectedDatabaseStop && database === child) {
        console.error('PostgreSQL stopped unexpectedly.');
        void shutdown(1);
      }
    });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      try {
        await runProcess(
          'pg_isready',
          ['-h', '/run/clog/postgres', '-U', 'clog', '-d', 'postgres'],
          { uid: 999, gid: 999, stdio: 'ignore' },
        );
        ready = true;
        break;
      } catch {
        await delay(500);
      }
    }
    if (!ready) throw new Error('PostgreSQL readiness deadline expired');
    if (stopping) throw new Error('Installation is stopping');
    const pool = new pg.Pool({
      connectionString: databaseUrl({ ...process.env, DB_NAME: 'postgres' }),
      connectionTimeoutMillis: 5000,
    });
    try {
      if (
        !(await pool.query("SELECT 1 FROM pg_database WHERE datname='clog'"))
          .rowCount
      )
        await pool.query('CREATE DATABASE clog');
    } finally {
      await pool.end();
    }
  }
  async function startWorkers() {
    if (workers || stopping) return;
    if (existsSync(join(systemDirectory, 'postgres/rotation.json')))
      throw new Error('Resume pending secret rotation before starting writers');
    phase = 'schema';
    const url = databaseUrl();
    await migrate(url);
    if (stopping) return;
    const pool = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 5000,
    });
    try {
      if (
        !bundled &&
        !(await pool.query("SELECT 1 FROM staff_accounts WHERE role='admin'"))
          .rowCount
      )
        prepareAdministrator(administratorFile, true);
      const password = await provisionAdministrator(pool, administratorFile);
      if (password && !printedPassword) {
        printAdministrator(password);
        printedPassword = true;
      }
    } finally {
      await pool.end();
    }
    if (stopping) return;
    phase = 'catalog';
    await importBundledCatalog(url);
    if (stopping) return;
    await applyBundledClueTaxonomy(url);
    await provisionRuntimeRole(url, readSecret('APP_DB_PASSWORD')!);
    if (stopping) return;
    phase = 'running';
    const child = spawn('bash', ['/usr/local/bin/start-app'], {
      uid: 1000,
      gid: 1000,
      env: workerEnvironment(),
      stdio: 'inherit',
    });
    workers = child;
    child.once('error', () => {
      void shutdown(1);
    });
    child.once('exit', () => {
      if (!stopping && workers === child) {
        console.error('Application supervisor stopped unexpectedly.');
        void shutdown(1);
      }
    });
    console.log(
      'Installation initialized; starting website and optional Discord gateway.',
    );
  }
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const snapshot = () => ({
      instance,
      phase,
      database: !!database || !bundled,
      workers: !!workers,
      maintenance: existsSync(marker),
      databasePid: database?.pid,
      supervisorPid: workers?.pid,
    });
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify(snapshot()));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 2048) request.destroy();
    });
    request.on('end', () => {
      const run = async () => {
        if (request.method !== 'POST' || request.url !== '/operation')
          throw new Error('Unknown control request');
        const input = JSON.parse(body) as { operation: string; token?: string };
        if (stopping) throw new Error('Installation is stopping');
        switch (input.operation) {
          case 'pause':
            if (phase !== 'running' || existsSync(marker) || !input.token)
              throw new Error('Installation is not available for maintenance');
            writeSystemFile(
              marker,
              JSON.stringify({ token: input.token, instance }) + '\n',
            );
            await stopWorkers();
            phase = 'maintenance';
            break;
          case 'resume':
            if (
              existsSync(marker) &&
              input.token &&
              JSON.parse(readFileSync(marker, 'utf8')).token !== input.token
            )
              throw new Error('Maintenance owner mismatch');
            await startDatabase();
            await startWorkers();
            if (existsSync(marker)) unlinkSync(marker);
            break;
          case 'stop-database':
            if (!bundled)
              throw new Error('External database is operator-managed');
            await stopDatabase();
            break;
          case 'start-database':
            await startDatabase();
            if (workers) phase = 'running';
            break;
          default:
            throw new Error('Unknown maintenance operation');
        }
        return snapshot();
      };
      operation = operation.then(run, run).then(
        (value) => {
          response.end(JSON.stringify(value));
        },
        () => {
          response.statusCode = 409;
          response.end(
            '{"error":"Installation maintenance failed; inspect the installation state."}',
          );
        },
      );
    });
  });
  function shutdown(code = 0) {
    if (code) process.exitCode = code;
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    initialization.abort();
    shutdownPromise = (async () => {
      try {
        await stopWorkers();
      } catch {
        process.exitCode = 1;
      }
      try {
        await stopDatabase();
      } catch {
        process.exitCode = 1;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeSync(logFile);
    })();
    return shutdownPromise;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      void shutdown();
    });
  if (existsSync(controlSocket)) unlinkSync(controlSocket);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlSocket, resolve);
  });
  chmodSync(controlSocket, 0o600);
  try {
    await startDatabase();
    if (mode !== 'normal' || existsSync(marker) || pendingRotation) {
      if (!existsSync(marker))
        writeSystemFile(
          marker,
          JSON.stringify({ token: mode, instance }) + '\n',
        );
      phase = mode === 'restore' ? 'restore' : 'maintenance';
      console.log(
        'PostgreSQL ready; application writers are paused for maintenance.',
      );
    } else await startWorkers();
  } catch (error) {
    if (stopping) return;
    phase = 'failed';
    console.error(
      JSON.stringify({
        service: 'installation',
        event: 'STARTUP_FAILED',
        ...safeFailure(error),
      }),
    );
    console.error(
      'Inspect /data/logs/bootstrap.log. Writers remain stopped; use clog resume after repairing the installation.',
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        service: 'installation',
        event: 'INSTALLATION_FAILED',
        ...safeFailure(error),
      }),
    );
    process.exit(1);
  });
