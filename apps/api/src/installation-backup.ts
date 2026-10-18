/** Logical DB dump plus quiescent assets; never archive a live PostgreSQL directory. */
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  cp,
  rm,
  mkdir,
  chown,
} from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { databaseUrl } from '@clog/database/dist/secrets.js';
import { releaseState } from '@clog/database/dist/release-state.js';
import { provisionRuntimeRole } from '@clog/database/dist/runtime-role.js';
import { readSecret } from '@clog/database/dist/secrets.js';
import { control, waitForWebsite } from './installation-control.js';
import { runProcess } from './installation.js';
const exec = promisify(execFile);
const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
async function hashFile(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
const content = [
  'database.dump',
  'icons.tar.gz',
  'screenshots.tar.gz',
  'secrets.tar.gz',
  'configuration.json',
];
const metadata = ['release.json', 'schema.json'];
export async function verifyBackup(directory: string, requireComplete = true) {
  for (const [name, expected] of [
    ['SHA256SUMS', content],
    ['META-SHA256SUMS', metadata],
  ] as const) {
    const lines = (await readFile(join(directory, name), 'utf8'))
      .trim()
      .split('\n');
    if (lines.length !== expected.length)
      throw new Error('Backup manifest is incomplete');
    const seen = new Set<string>();
    for (const line of lines) {
      const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/u.exec(line);
      if (
        !match ||
        !expected.includes(match[2]! as never) ||
        seen.has(match[2]!)
      )
        throw new Error('Invalid backup manifest');
      seen.add(match[2]!);
      if ((await hashFile(join(directory, match[2]!))) !== match[1])
        throw new Error('Backup checksum mismatch');
    }
  }
  if (
    requireComplete &&
    (await readFile(join(directory, 'COMPLETE'), 'utf8')).trim() !== 'complete'
  )
    throw new Error('Backup is incomplete');
  for (const name of ['icons', 'screenshots', 'secrets'])
    await validateArchive(join(directory, name + '.tar.gz'));
  const manifest = await readFile(
    join(directory, 'infrastructure/manifest.json'),
  );
  const contract = JSON.parse(manifest.toString()) as {
    files: Record<string, string>;
  };
  for (const [file, expected] of Object.entries(contract.files)) {
    if (
      !/^[A-Za-z0-9_./-]+$/u.test(file) ||
      file.startsWith('/') ||
      file.split('/').includes('..') ||
      !/^[a-f0-9]{64}$/u.test(expected)
    )
      throw new Error('Invalid infrastructure manifest');
    if ((await hashFile(join(directory, 'infrastructure', file))) !== expected)
      throw new Error('Infrastructure checksum mismatch');
  }
  const record = JSON.parse(
    await readFile(join(directory, 'release.json'), 'utf8'),
  ) as { bundleChecksum: string; revision: string };
  if (
    hash(manifest) !== record.bundleChecksum ||
    JSON.parse(manifest.toString()).revision !== record.revision
  )
    throw new Error('Backup release identity mismatch');
}
export async function validateArchive(file: string) {
  const names = (
    await exec('tar', ['-tzf', file], { maxBuffer: 32 * 1024 * 1024 })
  ).stdout
    .trim()
    .split('\n');
  if (
    names.some(
      (name) =>
        !/^\.\/[A-Za-z0-9_./-]*$/u.test(name) || /(^|\/)\.\.(\/|$)/u.test(name),
    )
  )
    throw new Error('Unsafe backup archive path');
  const listing = (
    await exec('tar', ['-tvzf', file], { maxBuffer: 64 * 1024 * 1024 })
  ).stdout
    .trim()
    .split('\n');
  if (listing.some((line) => !['-', 'd'].includes(line[0]!)))
    throw new Error(
      'Backup archives must contain regular files and directories',
    );
}
export async function verifyBackupArchive(requireComplete = true) {
  const directory = await mkdtemp('/tmp/clog-verify-');
  try {
    const archive = join(directory, 'capture.tar.gz');
    await pipeline(process.stdin, createWriteStream(archive, { mode: 0o600 }));
    await validateArchive(archive);
    await runProcess(
      'tar',
      ['--no-same-owner', '-xzf', archive, '-C', directory],
      { stdio: 'ignore' },
    );
    await rm(archive);
    await verifyBackup(directory, requireComplete);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function postgresTool(
  tool: string,
  args: string[],
  directory: string,
  output?: string,
  input?: string,
) {
  const bundled = process.env.CLOG_DATABASE_MODE !== 'external';
  let env = { ...process.env };
  if (!bundled) {
    const url = new URL(databaseUrl());
    const escape = (value: string) =>
      value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    const passwordFile = join(directory, 'pgpass');
    await writeFile(
      passwordFile,
      [
        url.hostname,
        url.port || '5432',
        decodeURIComponent(url.pathname.slice(1)),
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
      ]
        .map(escape)
        .join(':') + '\n',
      { mode: 0o600 },
    );
    env = { ...env, PGPASSFILE: passwordFile };
    args = [
      '-h',
      url.hostname,
      '-p',
      url.port || '5432',
      '-U',
      decodeURIComponent(url.username),
      '-d',
      decodeURIComponent(url.pathname.slice(1)),
      ...args,
    ];
  } else
    args = ['-h', '/run/clog/postgres', '-U', 'clog', '-d', 'clog', ...args];
  const fd = output ? openSync(output, 'wx', 0o600) : undefined;
  const inputFd = input ? openSync(input, 'r') : undefined;
  try {
    await runProcess(tool, args, {
      env,
      ...(bundled ? { uid: 999, gid: 999 } : {}),
      stdio: [inputFd ?? 'ignore', fd ?? 'ignore', 'inherit'],
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (inputFd !== undefined) closeSync(inputFd);
    if (!bundled) await rm(join(directory, 'pgpass'), { force: true });
  }
}
export async function backupInstallation() {
  const directory = await mkdtemp('/run/clog/backup-'),
    token = randomUUID();
  const before = await control();
  let paused = false;
  try {
    await control('pause', token);
    paused = true;
    await postgresTool(
      'pg_dump',
      ['-Fc'],
      directory,
      join(directory, 'database.dump'),
    );
    for (const [name, source] of [
      ['icons', process.env.ICON_STORAGE_PATH!],
      ['screenshots', process.env.PROOF_STORAGE_PATH!],
    ] as const)
      await runProcess(
        'tar',
        ['-C', source, '-czf', join(directory, name + '.tar.gz'), '.'],
        { stdio: 'ignore' },
      );
    const secrets = [
      './system/postgres',
      './system/app',
      './system/session',
      ...(existsSync('/data/bootstrap') ? ['./bootstrap'] : []),
    ];
    await runProcess(
      'tar',
      ['-C', '/data', '-czf', join(directory, 'secrets.tar.gz'), ...secrets],
      { stdio: 'ignore' },
    );
    const configuration = Object.fromEntries(
      [
        'PUBLIC_ORIGIN',
        'TRUSTED_PROXY_CIDRS',
        'AUTH_ENABLED',
        'BOT_SETTINGS_MODE',
        'CLOG_DATABASE_MODE',
        'DB_HOST',
        'DB_PORT',
        'DB_NAME',
        'DB_USER',
      ]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    );
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify(configuration) + '\n',
    );
    const schema = await releaseState(
      databaseUrl(),
      '/opt/clog-release/manifest.json',
      true,
    );
    await writeFile(
      join(directory, 'schema.json'),
      JSON.stringify(schema) + '\n',
    );
    await cp('/opt/clog-release', join(directory, 'infrastructure'), {
      recursive: true,
    });
    const manifestBytes = await readFile('/opt/clog-release/manifest.json'),
      manifest = JSON.parse(manifestBytes.toString());
    const identity = JSON.parse(
      await readFile('/data/system/postgres/installation.json', 'utf8'),
    );
    await writeFile(
      join(directory, 'release.json'),
      JSON.stringify({
        format: 2,
        revision: manifest.revision,
        bundleChecksum: hash(manifestBytes),
        schema,
        evidence: manifest.evidence,
        installation: identity,
      }) + '\n',
    );
    for (const [name, files] of [
      ['SHA256SUMS', content],
      ['META-SHA256SUMS', metadata],
    ] as const)
      await writeFile(
        join(directory, name),
        (
          await Promise.all(
            files.map(
              async (file) =>
                (await hashFile(join(directory, file))) + '  ' + file,
            ),
          )
        ).join('\n') + '\n',
      );
    await verifyBackup(directory, false);
    if ((await control()).instance !== before.instance)
      throw new Error('Installation changed during backup');
    await control('resume', token);
    paused = false;
    await waitForWebsite();
    if ((await control()).instance !== before.instance)
      throw new Error('Installation changed during backup');
    await writeFile(join(directory, 'COMPLETE'), 'complete\n');
    await runProcess('tar', ['-C', directory, '-czf', '-', '.']);
  } finally {
    if (paused) await control('resume', token).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
export async function restoreInstallation() {
  if ((await control()).phase !== 'restore')
    throw new Error(
      'Restore requires a fresh installation started in restore mode',
    );
  const directory = await mkdtemp('/run/clog/restore-');
  try {
    const archive = join(directory, 'input.tar.gz');
    await pipeline(process.stdin, createWriteStream(archive, { mode: 0o600 }));
    await validateArchive(archive);
    await runProcess(
      'tar',
      ['--no-same-owner', '-xzf', archive, '-C', directory],
      { stdio: 'ignore' },
    );
    await rm(archive);
    await verifyBackup(directory);
    const record = JSON.parse(
      await readFile(join(directory, 'release.json'), 'utf8'),
    );
    const manifest = await readFile('/opt/clog-release/manifest.json');
    if (record.bundleChecksum !== hash(manifest))
      throw new Error('Restore image does not match the recorded release');
    for (const name of ['icons', 'screenshots', 'secrets'])
      await validateArchive(join(directory, name + '.tar.gz'));
    await postgresTool(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges'],
      directory,
      undefined,
      join(directory, 'database.dump'),
    );
    await releaseState(databaseUrl(), '/opt/clog-release/manifest.json', true);
    for (const [name, target] of [
      ['icons', process.env.ICON_STORAGE_PATH!],
      ['screenshots', process.env.PROOF_STORAGE_PATH!],
    ] as const) {
      await runProcess(
        'tar',
        [
          '--no-same-owner',
          '-xzf',
          join(directory, name + '.tar.gz'),
          '-C',
          target,
        ],
        { stdio: 'ignore' },
      );
      await runProcess('chown', ['-R', '1000:1000', target], {
        stdio: 'ignore',
      });
    }
    // Clone DB/session credentials remain independent; retain only pending first-login state.
    const secretStaging = join(directory, 'source-secrets');
    await mkdir(secretStaging);
    await runProcess(
      'tar',
      [
        '--no-same-owner',
        '-xzf',
        join(directory, 'secrets.tar.gz'),
        '-C',
        secretStaging,
      ],
      { stdio: 'ignore' },
    );
    const pending = join(secretStaging, 'bootstrap/administrator.json');
    if (existsSync(pending)) {
      await mkdir('/data/bootstrap', { recursive: true, mode: 0o700 });
      await chown('/data/bootstrap', 1000, 1000);
      await copyFile(pending, process.env.CLOG_BOOTSTRAP_FILE!);
      await chown(process.env.CLOG_BOOTSTRAP_FILE!, 1000, 1000);
    }
    await provisionRuntimeRole(databaseUrl(), readSecret('APP_DB_PASSWORD')!);
    await control('resume');
    await waitForWebsite();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
