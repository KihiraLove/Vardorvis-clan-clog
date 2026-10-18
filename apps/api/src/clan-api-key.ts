/** Recoverable clan keys are encrypted; request checks need only the SHA-256 digest. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type pg from 'pg';
import type { IncomingHttpHeaders } from 'node:http';
import { TextDecoder } from 'node:util';
import { ApiError } from './types.js';
import { clanKeyBytes, validClanApiKey } from '@clog/domain';
export { validClanApiKey as validClanKey } from '@clog/domain';
export interface ClanKeySettings {
  revision: string;
  enabled: boolean;
  key: string;
}
export interface ClanKeyUpdate {
  expectedRevision: string;
  enabled?: boolean;
  key?: string;
  generate?: true;
}
export interface ClanKeyStore {
  settings(): Promise<ClanKeySettings>;
  update(fields: ClanKeyUpdate, actorId: string): Promise<ClanKeySettings>;
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const generateClanKey = () => randomBytes(clanKeyBytes).toString('hex');
/** Encoded credentials carry Unicode, whitespace and controls safely through HTTP headers. */
export function suppliedClanKey(
  headers: IncomingHttpHeaders,
): string | undefined {
  const raw = headers['x-clan-api-key'];
  const encoded = headers['x-clan-api-key-base64'];
  if (encoded === undefined) return typeof raw === 'string' ? raw : undefined;
  try {
    if (
      raw !== undefined ||
      typeof encoded !== 'string' ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded)
    )
      throw new Error('Invalid key header');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded)
      throw new Error('Invalid key encoding');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
}
/** Atomically publish the encryption root in the private, backed-up screenshot volume. */
export async function loadClanKeyRoot(directory: string): Promise<Buffer> {
  if (!isAbsolute(directory))
    throw new Error('Key storage directory must be absolute');
  const path = join(directory, '.clan-api-key.secret');
  try {
    return await readRoot(path);
  } catch (error) {
    if (!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    return await readRoot(path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function readRoot(path: string) {
  const key = await readFile(path);
  if (key.length !== 32)
    throw new Error('Clan key encryption storage is invalid');
  return key;
}
function encrypt(value: string, root: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', root, iv);
  cipher.setAAD(Buffer.from('clog:clan-api-key:v1'));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    bytes.toString('base64url'),
  ].join(':');
}
function decrypt(value: string, root: Buffer) {
  try {
    const [version, iv, tag, data, ...extra] = value.split(':');
    if (version !== 'v1' || !iv || !tag || !data || extra.length)
      throw new Error('Invalid encrypted key');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      root,
      Buffer.from(iv, 'base64url'),
    );
    cipher.setAAD(Buffer.from('clog:clan-api-key:v1'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const key = Buffer.concat([
      cipher.update(Buffer.from(data, 'base64url')),
      cipher.final(),
    ]).toString('utf8');
    if (!key.length) throw new Error('Invalid key');
    return key;
  } catch {
    throw new ApiError(503, 'Clan API key storage is unavailable.');
  }
}
type KeyRow = {
  enabled: boolean;
  version: number;
  encrypted_key: string;
  key_hash: string;
};
export class PgClanKeyStore implements ClanKeyStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly root: Buffer,
  ) {
    if (root.length !== 32) throw new Error('Invalid clan key encryption root');
  }
  async ensureDefault() {
    const key = generateClanKey();
    await this.pool.query(
      'INSERT INTO clan_api_keys(singleton,encrypted_key,key_hash) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING',
      [encrypt(key, this.root), digest(key)],
    );
    // Catch a missing/wrong restored encryption root without replacing a valid key.
    await this.settings();
  }
  private view(row: KeyRow): ClanKeySettings {
    const key = decrypt(row.encrypted_key, this.root);
    if (!validClanApiKey(key))
      throw new ApiError(503, 'Clan API key storage is invalid.');
    return {
      revision: 'clan-key-' + row.version,
      enabled: row.enabled,
      key,
    };
  }
  async settings() {
    const row = (
      await this.pool.query<KeyRow>(
        'SELECT enabled,version,encrypted_key,key_hash FROM clan_api_keys WHERE singleton=true',
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'Clan API key storage is unavailable.');
    return this.view(row);
  }
  async update(fields: ClanKeyUpdate, actorId: string) {
    if (
      (fields.key !== undefined && !validClanApiKey(fields.key)) ||
      (fields.key !== undefined && fields.generate !== undefined) ||
      (fields.enabled === undefined &&
        fields.key === undefined &&
        fields.generate !== true)
    )
      throw new ApiError(
        422,
        'Supply an enabled setting, a key of at least 8 characters, or generate a new key.',
      );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<KeyRow>(
          'SELECT enabled,version,encrypted_key,key_hash FROM clan_api_keys WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old) throw new ApiError(503, 'Clan API key storage is unavailable.');
      if (fields.expectedRevision !== 'clan-key-' + old.version)
        throw new ApiError(
          409,
          'API key settings changed. Reload before saving again.',
        );
      const key = fields.generate ? generateClanKey() : fields.key;
      const enabled = fields.enabled ?? old.enabled;
      const version = old.version + 1;
      const encrypted =
        key === undefined ? old.encrypted_key : encrypt(key, this.root);
      const hash = key === undefined ? old.key_hash : digest(key);
      const row: KeyRow = {
        enabled,
        version,
        encrypted_key: encrypted,
        key_hash: hash,
      };
      const response = this.view(row);
      await client.query(
        'UPDATE clan_api_keys SET enabled=$1,version=$2,encrypted_key=$3,key_hash=$4 WHERE singleton=true',
        [enabled, version, encrypted, hash],
      );
      await client.query(
        'INSERT INTO clan_api_key_audit(actor_id,old_enabled,new_enabled,key_rotated,version) VALUES($1,$2,$3,$4,$5)',
        [actorId, old.enabled, enabled, hash !== old.key_hash, version],
      );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
/** Lock only inside the intake transaction; an early request check rejects before upload parsing. */
export async function requireClanKey(
  database: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  supplied: string | undefined,
  lock = false,
  required = false,
) {
  const row = (
    await database.query<{ enabled: boolean; key_hash: string }>(
      'SELECT enabled,key_hash FROM clan_api_keys WHERE singleton=true' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  if (!row) throw new ApiError(503, 'Clan API key storage is unavailable.');
  if (!row.enabled && !required) return;
  if (
    !validClanApiKey(supplied) ||
    !timingSafeEqual(
      Buffer.from(row.key_hash, 'hex'),
      Buffer.from(digest(supplied), 'hex'),
    )
  )
    throw new ApiError(401, 'A valid clan API key is required.');
}
