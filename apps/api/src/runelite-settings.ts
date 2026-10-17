import type pg from 'pg';
import {
  parseRuneLiteRules,
  type RuneLiteRules,
  type RuneLiteSettings,
  type RuneLiteSettingsUpdate,
} from '@clog/domain';
import { ApiError } from './types.js';

export interface RuneLiteSettingsStore {
  settings(): Promise<RuneLiteSettings>;
  update(
    fields: RuneLiteSettingsUpdate,
    actorId: string,
  ): Promise<RuneLiteSettings>;
}
export async function readRuneLiteSettings(
  database: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  lock = false,
): Promise<RuneLiteSettings> {
  const row = (
    await database.query<{ version: number; rules: RuneLiteRules }>(
      'SELECT version,rules FROM runelite_settings WHERE singleton=true' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  if (!row) throw new ApiError(503, 'RuneLite settings unavailable.');
  return {
    revision: 'runelite-' + row.version,
    ...parseRuneLiteRules(row.rules),
  };
}
export class PgRuneLiteSettingsStore implements RuneLiteSettingsStore {
  constructor(private readonly pool: pg.Pool) {}
  settings() {
    return readRuneLiteSettings(this.pool);
  }
  async update(fields: RuneLiteSettingsUpdate, actorId: string) {
    const { expectedRevision, clanKeyRequirement, ...input } = fields;
    let rules: RuneLiteRules;
    try {
      rules = parseRuneLiteRules(input);
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : 'Invalid RuneLite settings.',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<{ version: number; rules: RuneLiteRules }>(
          'SELECT version,rules FROM runelite_settings WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old) throw new ApiError(503, 'RuneLite settings unavailable.');
      if (expectedRevision !== 'runelite-' + old.version)
        throw new ApiError(
          409,
          'RuneLite settings changed. Reload before saving again.',
        );
      let requirement: RuneLiteSettings['clanKeyRequirement'];
      if (clanKeyRequirement) {
        const key = (
          await client.query<{ enabled: boolean; version: number }>(
            'SELECT enabled,version FROM clan_api_keys WHERE singleton=true FOR UPDATE',
          )
        ).rows[0];
        if (!key)
          throw new ApiError(503, 'Clan API key storage is unavailable.');
        if (clanKeyRequirement.expectedRevision !== 'clan-key-' + key.version)
          throw new ApiError(
            409,
            'API key settings changed. Reload before saving again.',
          );
        const enabled = clanKeyRequirement.enabled;
        if (!rules.matchClanName && !enabled)
          throw new ApiError(
            422,
            'API key matching requires the clan API key.',
          );
        await client.query(
          'UPDATE clan_api_keys SET enabled=$1,version=$2 WHERE singleton=true',
          [enabled, key.version + 1],
        );
        await client.query(
          'INSERT INTO clan_api_key_audit(actor_id,old_enabled,new_enabled,key_rotated,version) VALUES($1,$2,$3,false,$4)',
          [actorId, key.enabled, enabled, key.version + 1],
        );
        requirement = { enabled, revision: 'clan-key-' + (key.version + 1) };
      }
      const version = old.version + 1;
      await client.query(
        'UPDATE runelite_settings SET rules=$1,version=$2 WHERE singleton=true',
        [JSON.stringify(rules), version],
      );
      await client.query(
        'INSERT INTO runelite_settings_audit(actor_id,version,old_rules,new_rules) VALUES($1,$2,$3,$4)',
        [actorId, version, JSON.stringify(old.rules), JSON.stringify(rules)],
      );
      await client.query('COMMIT');
      return {
        revision: 'runelite-' + version,
        ...rules,
        ...(requirement ? { clanKeyRequirement: requirement } : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
