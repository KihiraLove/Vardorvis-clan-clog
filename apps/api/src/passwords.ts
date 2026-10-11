/** Randomly salted, one-way scrypt password verifiers; never reversible encryption. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP's equivalent 32 MiB configuration keeps concurrent logins bounded.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const value = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString('hex')}$${value.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const match = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/u.exec(
    encoded,
  );
  if (!match) return false;
  const value = await derive(password, Buffer.from(match[1]!, 'hex'));
  return timingSafeEqual(value, Buffer.from(match[2]!, 'hex'));
}
