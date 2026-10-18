/** Encrypted integration credentials; audit records and admin responses exclude secrets. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  defaultDiscordLimits,
  parseDiscordFields,
  type DiscordSettings,
  type DiscordSettingsUpdate,
} from '@clog/domain';

export class DiscordSettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type PrivateSettings = { token: string; apiToken: string };
type Row = { version: number; settings: unknown; credentials: string };
export interface DiscordSettingsStore {
  settings(): Promise<DiscordSettings>;
  update(input: DiscordSettingsUpdate, actor: string): Promise<DiscordSettings>;
  runtime(): Promise<DiscordSettings & PrivateSettings>;
}
export class PgDiscordSettingsStore implements DiscordSettingsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly root: Buffer,
  ) {
    if (root.length !== 32)
      throw new Error('Invalid integration encryption root');
  }
  private encrypt(value: PrivateSettings) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.root, iv);
    cipher.setAAD(Buffer.from('clog:discord-settings:v1'));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      bytes.toString('base64url'),
    ].join(':');
  }
  private decrypt(value: string): PrivateSettings {
    try {
      const [version, iv, tag, data, ...extra] = value.split(':');
      if (version !== 'v1' || !iv || !tag || !data || extra.length)
        throw new Error();
      const cipher = createDecipheriv(
        'aes-256-gcm',
        this.root,
        Buffer.from(iv, 'base64url'),
      );
      cipher.setAAD(Buffer.from('clog:discord-settings:v1'));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const result = JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(data, 'base64url')),
          cipher.final(),
        ]).toString('utf8'),
      ) as PrivateSettings;
      if (
        typeof result.token !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(result.apiToken)
      )
        throw new Error();
      return result;
    } catch {
      throw new DiscordSettingsError(
        503,
        'Discord credential storage is unavailable.',
      );
    }
  }
  async ensureDefault() {
    await this.pool.query(
      'INSERT INTO discord_settings(singleton,settings,credentials) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING',
      [
        {
          enabled: false,
          applicationId: '',
          guildId: '',
          testGuildId: '',
          limits: defaultDiscordLimits,
        },
        this.encrypt({ token: '', apiToken: randomBytes(32).toString('hex') }),
      ],
    );
    await this.settings();
  }
  private view(row: Row): DiscordSettings {
    return {
      ...parseDiscordFields(row.settings),
      revision: 'discord-' + row.version,
      tokenConfigured: !!this.decrypt(row.credentials).token,
    };
  }
  private async row() {
    const row = (
      await this.pool.query<Row>(
        'SELECT version,settings,credentials FROM discord_settings WHERE singleton=true',
      )
    ).rows[0];
    if (!row)
      throw new DiscordSettingsError(503, 'Discord settings are unavailable.');
    return row;
  }
  async settings() {
    return this.view(await this.row());
  }
  async runtime() {
    const row = await this.row();
    return { ...this.view(row), ...this.decrypt(row.credentials) };
  }
  async update(input: DiscordSettingsUpdate, actor: string) {
    let fields: ReturnType<typeof parseDiscordFields>;
    try {
      fields = parseDiscordFields(input);
      if (
        input.token !== undefined &&
        (typeof input.token !== 'string' ||
          (input.token !== '' &&
            !/^[A-Za-z0-9._-]{20,256}$/u.test(input.token)))
      )
        throw new Error('Discord bot token is invalid.');
    } catch (error) {
      throw new DiscordSettingsError(422, (error as Error).message);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<Row>(
          'SELECT version,settings,credentials FROM discord_settings WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old)
        throw new DiscordSettingsError(
          503,
          'Discord settings are unavailable.',
        );
      if (input.expectedRevision !== 'discord-' + old.version)
        throw new DiscordSettingsError(
          409,
          'Discord settings changed. Reload before saving again.',
        );
      const previous = this.decrypt(old.credentials),
        token = input.token ?? previous.token;
      if (fields.enabled && !token)
        throw new DiscordSettingsError(
          422,
          'Save a bot token before enabling Discord.',
        );
      const changed = token !== previous.token;
      const row: Row = {
        version: old.version + 1,
        settings: fields,
        credentials: changed
          ? this.encrypt({ token, apiToken: randomBytes(32).toString('hex') })
          : old.credentials,
      };
      const result = this.view(row);
      await client.query(
        'UPDATE discord_settings SET settings=$1,credentials=$2,version=$3 WHERE singleton=true',
        [fields, row.credentials, row.version],
      );
      await client.query(
        'INSERT INTO discord_settings_audit(actor_id,version,old_settings,new_settings,token_changed) VALUES($1,$2,$3,$4,$5)',
        [actor, row.version, old.settings, fields, changed],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
