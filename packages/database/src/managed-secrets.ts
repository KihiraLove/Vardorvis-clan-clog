import { randomUUID } from 'node:crypto';
import {
  writeFileSync,
  renameSync,
  existsSync,
  chownSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const managedSecrets = {
  postgres: 'POSTGRES_PASSWORD',
  app: 'APP_DB_PASSWORD',
  session: 'SESSION_SECRET',
} as const;
export type SecretKind = keyof typeof managedSecrets;

export function writeManagedFile(file: string, value: string) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32' && process.getuid?.() === 0)
      chownSync(temporary, 1000, 1000);
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
