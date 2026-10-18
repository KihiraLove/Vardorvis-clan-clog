/** Local root-only CLI; the web server never exposes installation operations. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { control, waitForWebsite } from './installation-control.js';
import {
  backupInstallation,
  restoreInstallation,
  verifyBackup,
  verifyBackupArchive,
} from './installation-backup.js';
import { releaseState } from '@clog/database/dist/release-state.js';
import { databaseUrl } from '@clog/database/dist/secrets.js';
import { rotateSecret } from '@clog/database/dist/rotate-secret.js';
import { safeFailure } from '@clog/domain';
import { protectSecrets } from './installation.js';

async function main() {
  if (process.getuid?.() !== 0) throw new Error('Run clog maintenance as root');
  process.setgroups?.([]);
  for (const [kind, name] of Object.entries({
    postgres: 'POSTGRES_PASSWORD',
    app: 'APP_DB_PASSWORD',
    session: 'SESSION_SECRET',
  })) {
    delete process.env[name];
    process.env[name + '_FILE'] = '/data/system/' + kind + '/value';
  }
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'status':
      console.log(JSON.stringify(await control()));
      break;
    case 'pause':
      await control('pause', randomUUID());
      console.log('Application writers paused.');
      break;
    case 'resume':
      await control('resume');
      await waitForWebsite();
      console.log('Application readiness verified.');
      break;
    case 'stop-database':
    case 'start-database':
      await control(command);
      break;
    case 'identity':
      console.log(
        await readFile('/data/system/postgres/installation.json', 'utf8'),
      );
      break;
    case 'schema':
    case 'check-schema': {
      let path = '/opt/clog-release/manifest.json';
      if (command === 'check-schema') {
        path = '/run/clog/candidate-' + randomUUID() + '.json';
        let text = '';
        for await (const chunk of process.stdin) {
          text += String(chunk);
          if (text.length > 4 * 1024 * 1024)
            throw new Error('Schema manifest is too large');
        }
        await writeFile(path, text, { mode: 0o600 });
      }
      try {
        console.log(
          JSON.stringify(
            await releaseState(databaseUrl(), path, command === 'schema'),
          ),
        );
      } finally {
        if (command === 'check-schema') await unlink(path);
      }
      break;
    }
    case 'backup':
      await backupInstallation();
      break;
    case 'verify':
      if (!args[0]) throw new Error('Supply a backup directory');
      await verifyBackup(args[0], args[1] !== '--capture');
      break;
    case 'verify-archive':
      await verifyBackupArchive(args[0] !== '--capture');
      break;
    case 'restore':
      await restoreInstallation();
      break;
    case 'rotate': {
      const kind = args[0];
      if (
        !['postgres', 'app', 'session'].includes(kind ?? '') ||
        args.some((arg, index) => index > 0 && arg !== '--resume')
      )
        throw new Error('Usage: clog rotate postgres|app|session [--resume]');
      const status = await control(),
        token = randomUUID();
      if (status.phase === 'running') await control('pause', token);
      await rotateSecret(
        '/data/system',
        kind as 'postgres' | 'app' | 'session',
        args.includes('--resume'),
      );
      protectSecrets();
      await control('resume', status.phase === 'running' ? token : undefined);
      await waitForWebsite();
      console.log('Secret rotated and application readiness verified.');
      break;
    }
    case 'owner':
    case 'runtime': {
      if (!args.length) throw new Error('Supply a maintenance command');
      const env = { ...process.env };
      if (command === 'runtime') env.DB_USER = 'clog_runtime';
      if (command === 'runtime')
        for (const name of [
          'POSTGRES_PASSWORD',
          'POSTGRES_PASSWORD_FILE',
          'DATABASE_URL',
          'DATABASE_URL_FILE',
          'ADMIN_BOOTSTRAP_PASSWORD',
          'ADMIN_BOOTSTRAP_PASSWORD_FILE',
        ])
          delete env[name];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(args[0]!, args.slice(1), {
          env,
          stdio: 'inherit',
          ...(command === 'runtime' ? { uid: 1000, gid: 1000 } : {}),
        });
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Maintenance command failed')),
        );
      });
      break;
    }
    default:
      throw new Error(
        'Usage: clog status|backup|restore|pause|resume|rotate|schema|owner|runtime',
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
        service: 'maintenance',
        event: 'MAINTENANCE_FAILED',
        ...safeFailure(error),
      }),
    );
    process.exitCode = 1;
  });
