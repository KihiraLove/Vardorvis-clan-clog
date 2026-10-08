/** Parameterized PostgreSQL persistence; public projections explicitly select safe fields. */
import type pg from 'pg';
import {
  ApiError,
  type AdminIdentity,
  type BackendStore,
  type CatalogData,
  type PublicCredit,
  type Settings,
  type StoredSession,
} from './types.js';
const unavailable = () => new ApiError(503, 'The catalog is not ready.');
export class PgStore implements BackendStore {
  constructor(private readonly pool: pg.Pool) {}
  async ready() {
    await this.pool.query('SELECT token_hash FROM admin_sessions LIMIT 1');
    await this.settings();
  }
  async catalog(): Promise<CatalogData> {
    const client = await this.pool.connect();
    try {
      // A repeatable snapshot prevents memberships from racing catalog updates.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const items = (
        await client.query<{ id: number; name: string; iconPath: string }>(
          'SELECT id, name, icon_path AS "iconPath" FROM items WHERE active ORDER BY id LIMIT 10001',
        )
      ).rows;
      const pages = (
        await client.query<{ id: string; name: string; category: string }>(
          'SELECT id, name, category FROM pages ORDER BY sort_order, id LIMIT 2001',
        )
      ).rows;
      const slots = (
        await client.query<{ page_id: string; item_id: number }>(
          'SELECT p.page_id, p.item_id FROM page_items p JOIN items i ON i.id=p.item_id WHERE i.active ORDER BY p.page_id, p.slot LIMIT 50001',
        )
      ).rows;
      if (
        !items.length ||
        !pages.length ||
        items.length > 10000 ||
        pages.length > 2000 ||
        slots.length > 50000
      )
        throw unavailable();
      const ids = new Set(items.map((i) => i.id));
      const pageIds = new Set(pages.map((p) => p.id));
      if (
        items.some(
          (i) =>
            !i.name.trim() ||
            typeof i.iconPath !== 'string' ||
            !i.iconPath.startsWith('/') ||
            i.iconPath.startsWith('//') ||
            /[\\\s?#]/u.test(i.iconPath),
        ) ||
        pages.some(
          (p) =>
            !p.name.trim() ||
            !['bosses', 'raids', 'clues', 'minigames', 'other'].includes(
              p.category,
            ),
        ) ||
        slots.some((s) => !ids.has(s.item_id) || !pageIds.has(s.page_id))
      )
        throw unavailable();
      const membership = new Map<string, number[]>();
      for (const slot of slots) {
        const rows = membership.get(slot.page_id) ?? [];
        rows.push(slot.item_id);
        membership.set(slot.page_id, rows);
      }
      await client.query('COMMIT');
      return {
        items,
        pages: pages.map((p) => ({
          ...p,
          itemIds: membership.get(p.id) ?? [],
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async collections(): Promise<PublicCredit[]> {
    const rows = (
      await this.pool.query<PublicCredit>(
        `SELECT c.submission_id AS "submissionId", c.item_id AS "itemId", c.collector_name AS "collectorName", to_char(c.collected_on, 'YYYY-MM-DD') AS "collectedOn", c.hardcore FROM collection_credits c JOIN items i ON i.id=c.item_id WHERE i.active ORDER BY c.item_id, c.hardcore LIMIT 20001`,
      )
    ).rows;
    if (rows.length > 20000)
      throw new ApiError(
        503,
        'Collection snapshot exceeds the supported size.',
      );
    return rows;
  }
  async settings(): Promise<Settings> {
    const row = (
      await this.pool.query<{ hardcore_enabled: boolean; version: number }>(
        'SELECT hardcore_enabled, version FROM site_settings WHERE singleton=true',
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'Settings unavailable.');
    return {
      revision: 'settings-' + row.version,
      hardcoreEnabled: row.hardcore_enabled,
    };
  }
  async saveSettings(
    enabled: boolean,
    revision: string,
    actor: string,
  ): Promise<Settings | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<{ hardcore_enabled: boolean; version: number }>(
          'SELECT hardcore_enabled, version FROM site_settings WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old || 'settings-' + old.version !== revision) {
        await client.query('ROLLBACK');
        return null;
      }
      const version = old.version + 1;
      await client.query(
        'UPDATE site_settings SET hardcore_enabled=$1, version=$2 WHERE singleton=true',
        [enabled, version],
      );
      await client.query(
        'INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version) VALUES($1,$2,$3,$4)',
        [actor, old.hardcore_enabled, enabled, version],
      );
      await client.query('COMMIT');
      return { revision: 'settings-' + version, hardcoreEnabled: enabled };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createState(hash: string, expiresAt: Date) {
    await this.pool.query('DELETE FROM oauth_states WHERE expires_at <= now()');
    await this.pool.query(
      'INSERT INTO oauth_states(state_hash,expires_at) VALUES($1,$2)',
      [hash, expiresAt],
    );
  }
  async consumeState(hash: string) {
    return (
      (
        await this.pool.query(
          'DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING state_hash',
          [hash],
        )
      ).rowCount === 1
    );
  }
  async createSession(hash: string, identity: AdminIdentity, expiresAt: Date) {
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
    await this.pool.query(
      'INSERT INTO admin_sessions(token_hash,discord_user_id,display_name,expires_at) VALUES($1,$2,$3,$4)',
      [hash, identity.id, identity.displayName, expiresAt],
    );
  }
  async session(hash: string): Promise<StoredSession | null> {
    return (
      (
        await this.pool.query<StoredSession>(
          'SELECT discord_user_id AS id, display_name AS "displayName", expires_at AS "expiresAt" FROM admin_sessions WHERE token_hash=$1 AND expires_at>now()',
          [hash],
        )
      ).rows[0] ?? null
    );
  }
  async deleteSession(hash: string) {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [
      hash,
    ]);
  }
  async allowLogin(keyHash: string) {
    await this.pool.query(
      'DELETE FROM auth_rate_limits WHERE expires_at<=now()',
    );
    const row = (
      await this.pool.query<{ attempts: number }>(
        `INSERT INTO auth_rate_limits(key_hash,attempts,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key_hash) DO UPDATE SET attempts=auth_rate_limits.attempts+1 RETURNING attempts`,
        [keyHash],
      )
    ).rows[0];
    return !!row && row.attempts <= 20;
  }
}
