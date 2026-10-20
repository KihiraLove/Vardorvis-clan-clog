import type pg from 'pg';
import {
  parseStaffPages,
  type AccessControlSettings,
  type StaffPage,
} from '@clog/domain';
import { ApiError } from './types.js';

export interface AccessControlStore {
  settings(): Promise<AccessControlSettings>;
  update(
    pages: StaffPage[],
    revision: string,
    actor: string,
  ): Promise<AccessControlSettings>;
}
export class PgAccessControlStore implements AccessControlStore {
  constructor(private readonly pool: pg.Pool) {}
  async settings(): Promise<AccessControlSettings> {
    const row = (
      await this.pool.query<{ version: number; moderator_pages: string[] }>(
        'SELECT version,moderator_pages FROM staff_page_access WHERE singleton',
      )
    ).rows[0];
    if (!row)
      throw new ApiError(503, 'Access control settings are unavailable.');
    return {
      revision: 'access-control-' + row.version,
      moderatorPages: parseStaffPages(row.moderator_pages),
    };
  }
  async update(
    pages: StaffPage[],
    revision: string,
    actor: string,
  ): Promise<AccessControlSettings> {
    const moderatorPages = parseStaffPages(pages);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query<{ version: number; moderator_pages: string[] }>(
          'SELECT version,moderator_pages FROM staff_page_access WHERE singleton FOR UPDATE',
        )
      ).rows[0];
      if (!old)
        throw new ApiError(503, 'Access control settings are unavailable.');
      if (revision !== 'access-control-' + old.version)
        throw new ApiError(
          409,
          'Access control changed. Reload before saving again.',
        );
      const version = old.version + 1;
      await client.query(
        'UPDATE staff_page_access SET version=$1,moderator_pages=$2 WHERE singleton',
        [version, moderatorPages],
      );
      await client.query(
        'INSERT INTO staff_page_access_audit(actor_id,version,old_pages,new_pages) VALUES($1,$2,$3,$4)',
        [actor, version, old.moderator_pages, moderatorPages],
      );
      await client.query('COMMIT');
      return { revision: 'access-control-' + version, moderatorPages };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Shared catalog reads are needed by manual claims and schedule editors too. */
export function moderatorPagesForRequest(
  path: string,
  method: string,
): StaffPage[] {
  if (path === '/api/v1/admin/catalog' && ['GET', 'HEAD'].includes(method))
    return ['catalog', 'submissions', 'schedules'];
  if (path.startsWith('/api/v1/admin/catalog/')) return ['catalog'];
  if (
    /^\/api\/v1\/admin\/(?:submissions|submission-images|submission-filters)(?:\/|$)/u.test(
      path,
    )
  )
    return ['submissions'];
  if (
    /^\/api\/v1\/admin\/(?:schedules|competitions|xp|lifecycle)(?:\/|$)/u.test(
      path,
    )
  )
    return ['schedules'];
  if (
    path === '/api/v1/admin/runelite-settings' ||
    path === '/api/v1/admin/clan-api-key'
  )
    return ['runelite'];
  if (path === '/api/v1/admin/settings') return ['settings', 'hardcore'];
  if (path.startsWith('/api/v1/admin/branding/hardcore')) return ['hardcore'];
  if (/^\/api\/v1\/admin\/branding(?:\/|$)/u.test(path)) return ['settings'];
  if (/^\/api\/v1\/admin\/discord-settings(?:\/|$)/u.test(path))
    return ['discord'];
  return []; // New private tools require an explicit policy; account/auth routes are separate.
}
