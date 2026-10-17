/** Node-side secret inputs; never copy file contents into process.env or diagnostics. */
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export class SecretInputError extends Error {}

export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = env[name] || undefined;
  const file = env[name + '_FILE'] || undefined;
  if (value && file)
    throw new SecretInputError(`Set only ${name} or ${name}_FILE`);
  if (!file) return value;
  if (!isAbsolute(file))
    throw new SecretInputError(`${name}_FILE must be absolute`);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new Error();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 65536) throw new Error();
    const text = buffer
      .subarray(0, size)
      .toString('utf8')
      .replace(/\r?\n$/u, '');
    if (!text || /[\r\n\0]/u.test(text)) throw new Error();
    return text;
  } catch {
    throw new SecretInputError(`Cannot read a valid ${name}_FILE`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
