/** Parameterized PostgreSQL persistence; public projections explicitly select safe fields. */
import { randomUUID } from 'node:crypto';
import { parseSiteCopy, type SiteCopy } from '@clog/domain';
import { resolveMatch, searchMatches, type MatchItem } from './matching.js';
import type pg from 'pg';
import {
  ApiError,
  type AccountSessionIdentity,
  type BackendStore,
  type BotReceipt,
  type BotSubmissionInput,
  type CatalogData,
  type PublicCredit,
  type Settings,
  type StoredSession,
  type StaffAccount,
  type StoredAccount,
} from './types.js';
const unavailable = () => new ApiError(503, 'The catalog is not ready.');
const accountFields = `id, username, role, must_change_password AS "mustChangePassword", disabled, credential_version AS version`;
const credentialFields = `${accountFields}, password_hash AS "passwordHash", credential_version AS "credentialVersion"`;
const duplicateUsername = (error: unknown) => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  )
    throw new ApiError(409, 'That username is already in use.');
  throw error;
};
export class PgStore implements BackendStore {
  constructor(private readonly pool: pg.Pool) {}

  async ensureDefaultAdmin(passwordHash: string) {
    await this.pool.query(
      `INSERT INTO staff_accounts(id,username,role,password_hash)
       VALUES('00000000-0000-4000-8000-000000000001','admin','admin',$1)
       ON CONFLICT DO NOTHING`,
      [passwordHash],
    );
  }
  async accountByUsername(username: string): Promise<StoredAccount | null> {
    return (
      (
        await this.pool.query<StoredAccount>(
          `SELECT ${credentialFields} FROM staff_accounts WHERE lower(username)=lower($1) AND deleted_at IS NULL`,
          [username],
        )
      ).rows[0] ?? null
    );
  }
  async accountById(id: string): Promise<StoredAccount | null> {
    // Old shared/Discord session IDs are not UUIDs.
    if (!/^[a-f0-9-]{36}$/iu.test(id)) return null;
    return (
      (
        await this.pool.query<StoredAccount>(
          `SELECT ${credentialFields} FROM staff_accounts WHERE id=$1 AND deleted_at IS NULL`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async accounts(): Promise<StaffAccount[]> {
    return (
      await this.pool.query<StaffAccount>(
        `SELECT ${accountFields} FROM staff_accounts WHERE deleted_at IS NULL ORDER BY role, lower(username)`,
      )
    ).rows;
  }
  async createModerator(
    username: string,
    passwordHash: string,
    actor: string,
  ): Promise<StaffAccount> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = (
        await client.query<StaffAccount>(
          `INSERT INTO staff_accounts(id,username,role,password_hash) VALUES($1,$2,'moderator',$3) RETURNING ${accountFields}`,
          [randomUUID(), username, passwordHash],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO staff_account_audit(actor_id,account_id,action,username) VALUES($1,$2,'create',$3)`,
        [actor, account.id, account.username],
      );
      await client.query('COMMIT');
      return account;
    } catch (error) {
      await client.query('ROLLBACK');
      return duplicateUsername(error);
    } finally {
      client.release();
    }
  }
  async updateAccount(
    id: string,
    expectedVersion: number,
    username: string,
    passwordHash?: string,
  ): Promise<StoredAccount> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = (
        await client.query<StoredAccount>(
          `UPDATE staff_accounts SET username=$3, password_hash=COALESCE($4,password_hash),
         must_change_password=CASE WHEN $4 IS NULL THEN must_change_password ELSE false END,
         credential_version=credential_version+1
         WHERE id=$1 AND credential_version=$2 AND NOT disabled AND deleted_at IS NULL RETURNING ${credentialFields}`,
          [id, expectedVersion, username, passwordHash ?? null],
        )
      ).rows[0];
      if (!account)
        throw new ApiError(
          409,
          'Your account changed. Sign in again before retrying.',
        );
      await client.query('DELETE FROM admin_sessions WHERE account_id=$1', [
        id,
      ]);
      await client.query(
        `INSERT INTO staff_account_audit(actor_id,account_id,action,username) VALUES($1,$1,'update',$2)`,
        [id, username],
      );
      await client.query('COMMIT');
      return account;
    } catch (error) {
      await client.query('ROLLBACK');
      return duplicateUsername(error);
    } finally {
      client.release();
    }
  }

  async manageModerator(
    id: string,
    expectedVersion: number,
    action: 'disable' | 'enable' | 'delete',
    actor: string,
  ): Promise<StaffAccount> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<StoredAccount>(
          `SELECT ${credentialFields} FROM staff_accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!old) throw new ApiError(404, 'Moderator account not found.');
      if (old.role !== 'moderator')
        throw new ApiError(
          403,
          'The administrator account cannot be disabled or deleted.',
        );
      if (old.credentialVersion !== expectedVersion)
        throw new ApiError(
          409,
          'This account changed. Reload the account list.',
        );
      const saved = (
        await client.query<StaffAccount>(
          `UPDATE staff_accounts SET disabled=$2,
        deleted_at=CASE WHEN $3 THEN now() ELSE NULL END,
        password_hash=CASE WHEN $3 THEN '' WHEN $4='enable' THEN COALESCE(disabled_password_hash,password_hash) ELSE '' END,
        disabled_password_hash=CASE WHEN $4='disable' THEN COALESCE(disabled_password_hash,password_hash) ELSE NULL END,
        credential_version=credential_version+1 WHERE id=$1 RETURNING ${accountFields}`,
          [id, action !== 'enable', action === 'delete', action],
        )
      ).rows[0]!;
      await client.query('DELETE FROM admin_sessions WHERE account_id=$1', [
        id,
      ]);
      await client.query(
        'INSERT INTO staff_account_audit(actor_id,account_id,action,username) VALUES($1,$2,$3,$4)',
        [actor, id, action, old.username],
      );
      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async matchItems(client: pg.PoolClient): Promise<MatchItem[]> {
    const items = (
      await client.query<{ id: number; name: string }>(
        'SELECT id,name FROM items WHERE active ORDER BY id LIMIT 10001',
      )
    ).rows;
    const aliases = (
      await client.query<{ item_id: number; alias: string }>(
        'SELECT a.item_id,a.alias FROM item_aliases a JOIN items i ON i.id=a.item_id WHERE i.active ORDER BY a.item_id,a.alias LIMIT 20001',
      )
    ).rows;
    if (items.length > 10000 || aliases.length > 20000)
      throw new ApiError(503, 'Bot catalog exceeds supported limits.');
    const mapped = new Map<number, MatchItem>(
      items.map((item) => [item.id, { ...item, aliases: [] }]),
    );
    for (const alias of aliases)
      mapped.get(alias.item_id)?.aliases.push(alias.alias);
    return [...mapped.values()];
  }

  async botItems(query: string, limit: number) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const results = searchMatches(
        await this.matchItems(client),
        query,
        limit,
      );
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async submitClaim(input: BotSubmissionInput, payloadHash: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const readReceipt = async (): Promise<{
        hash: string | null;
        receipt: BotReceipt | null;
      } | null> => {
        const row = (
          await client.query<{
            hash: string | null;
            receipt: BotReceipt | null;
          }>(
            'SELECT intake_payload_hash AS hash, intake_receipt AS receipt FROM submissions WHERE discord_interaction_id=$1',
            [input.interactionId],
          )
        ).rows[0];
        return row ?? null;
      };
      const replay = (prior: {
        hash: string | null;
        receipt: BotReceipt | null;
      }) => {
        if (prior.hash !== payloadHash || !prior.receipt)
          throw new ApiError(
            409,
            'Discord interaction ID was used for a different claim.',
          );
        return { created: false, receipt: prior.receipt };
      };
      const prior = await readReceipt();
      if (prior) {
        const result = replay(prior);
        await client.query('COMMIT');
        return result;
      }
      const submittedAt = (
        await client.query<{ timestamp: Date }>('SELECT now() AS timestamp')
      ).rows[0]!.timestamp;
      const today = submittedAt.toISOString().slice(0, 10);
      const matches = await this.matchItems(client);
      if (
        input.itemId !== undefined &&
        !matches.some((item) => item.id === input.itemId)
      )
        throw new ApiError(422, 'Selected canonical item is unavailable.');
      const matched = resolveMatch(matches, input.rawItemText, input.itemId);
      const itemId = matched.itemId;
      if (
        itemId !== null &&
        (
          await client.query(
            'SELECT 1 FROM items WHERE id=$1 AND active FOR SHARE',
            [itemId],
          )
        ).rowCount !== 1
      )
        throw new ApiError(422, 'Selected canonical item is unavailable.');
      const creditOccupied =
        itemId !== null &&
        (
          await client.query(
            "SELECT 1 FROM submissions WHERE item_id=$1 AND hardcore=$2 AND status='approved' LIMIT 1",
            [itemId, input.hardcore],
          )
        ).rowCount === 1;
      const receipt: BotReceipt = {
        submissionId: randomUUID(),
        interactionId: input.interactionId,
        status: 'pending',
        submittedAt: submittedAt.toISOString(),
        collectedOn: today,
        dateSource: 'submission_default',
        hardcore: input.hardcore,
        resolution: matched.resolution,
        itemId,
        candidates: matched.candidates,
        creditOccupied,
      };
      // Unique interaction IDs serialize concurrent retries in PostgreSQL. ON CONFLICT
      // waits for the winner, after which readReceipt observes the committed receipt.
      const inserted = await client.query(
        `INSERT INTO submissions (
          id, discord_interaction_id, discord_user_id, discord_guild_id,
          raw_item_text, item_id, collector_name, collected_on, date_source,
          proof_url, hardcore, intake_payload_hash, intake_receipt
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (discord_interaction_id) DO NOTHING RETURNING id`,
        [
          receipt.submissionId,
          input.interactionId,
          input.actorDiscordId,
          input.guildId,
          input.rawItemText,
          itemId,
          input.collectorName,
          receipt.collectedOn,
          receipt.dateSource,
          input.proofUrl,
          input.hardcore,
          payloadHash,
          JSON.stringify(receipt),
        ],
      );
      if (inserted.rowCount !== 1) {
        const winner = await readReceipt();
        if (!winner)
          throw new ApiError(503, 'Claim receipt is temporarily unavailable.');
        const result = replay(winner);
        await client.query('COMMIT');
        return result;
      }
      await client.query('COMMIT');
      return { created: true, receipt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
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
      const version = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM catalog_state WHERE singleton',
        )
      ).rows[0]!.version;
      await client.query('COMMIT');
      return {
        catalogVersion: 'catalog-' + version,
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
      await this.pool.query<{
        hardcore_enabled: boolean;
        version: number;
        clan_name: string;
        public_copy: SiteCopy;
      }>(
        'SELECT hardcore_enabled, version, clan_name, public_copy FROM site_settings WHERE singleton=true',
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'Settings unavailable.');
    return {
      revision: 'settings-' + row.version,
      hardcoreEnabled: row.hardcore_enabled,
      clanName: row.clan_name,
      copy: parseSiteCopy(row.public_copy),
    };
  }
  async saveSettings(
    enabled: boolean,
    revision: string,
    actor: string,
    clanName?: string,
    copy?: SiteCopy,
  ): Promise<Settings | null> {
    if (
      clanName !== undefined &&
      (!clanName.trim() || clanName.trim().length > 80)
    )
      throw new ApiError(422, 'Clan name must contain 1–80 characters.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<{
          hardcore_enabled: boolean;
          version: number;
          clan_name: string;
          public_copy: SiteCopy;
        }>(
          'SELECT hardcore_enabled, version, clan_name, public_copy FROM site_settings WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old || 'settings-' + old.version !== revision) {
        await client.query('ROLLBACK');
        return null;
      }
      const version = old.version + 1;
      const name = clanName?.trim() ?? old.clan_name;
      const text = parseSiteCopy(copy ?? old.public_copy);
      await client.query(
        'UPDATE site_settings SET hardcore_enabled=$1, version=$2, clan_name=$3, public_copy=$4 WHERE singleton=true',
        [enabled, version, name, JSON.stringify(text)],
      );
      await client.query(
        'INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,old_clan_name,new_clan_name,old_public_copy,new_public_copy) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          actor,
          old.hardcore_enabled,
          enabled,
          version,
          old.clan_name,
          name,
          JSON.stringify(old.public_copy),
          JSON.stringify(text),
        ],
      );
      await client.query('COMMIT');
      return {
        revision: 'settings-' + version,
        hardcoreEnabled: enabled,
        clanName: name,
        copy: text,
      };
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
  async createSession(
    hash: string,
    identity: AccountSessionIdentity,
    expiresAt: Date,
  ) {
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
    await this.pool.query(
      'INSERT INTO admin_sessions(token_hash,discord_user_id,display_name,expires_at,account_id,credential_version) VALUES($1,$2,$3,$4,$5,$6)',
      [
        hash,
        identity.id,
        identity.displayName,
        expiresAt,
        identity.id,
        identity.accountVersion,
      ],
    );
  }
  async session(hash: string): Promise<StoredSession | null> {
    return (
      (
        await this.pool.query<StoredSession>(
          'SELECT account_id AS id, display_name AS "displayName", expires_at AS "expiresAt", credential_version AS "accountVersion" FROM admin_sessions WHERE token_hash=$1 AND expires_at>now() AND account_id IS NOT NULL AND credential_version IS NOT NULL',
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
