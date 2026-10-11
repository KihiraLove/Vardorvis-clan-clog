import type pg from 'pg';
import type { LogoRecord } from './branding-storage.js';
import { ApiError } from './types.js';
export interface Branding {
  revision: string;
  logoPath: string;
  faviconPath: string;
}
export const defaultBranding: Branding = {
  revision: 'branding-1',
  logoPath: '/brand/clan-logo.png',
  faviconPath: '/favicon.png',
};
export interface BrandingStore {
  settings(): Promise<Branding>;
  asset(id: string): Promise<LogoRecord | null>;
  save(
    record: LogoRecord | null,
    revision: string,
    actor: string,
  ): Promise<Branding>;
}
export class PgBrandingStore implements BrandingStore {
  constructor(private readonly pool: pg.Pool) {}
  async settings(): Promise<Branding> {
    const row = (
      await this.pool.query<{
        version: number;
        logo_asset_id: string | null;
        favicon_id: string | null;
      }>(
        'SELECT b.version,b.logo_asset_id,a.favicon_id FROM clan_branding b LEFT JOIN clan_logo_assets a ON a.id=b.logo_asset_id WHERE singleton=true',
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'Clan branding unavailable.');
    return {
      revision: 'branding-' + row.version,
      logoPath: row.logo_asset_id
        ? `/api/v1/branding/${row.logo_asset_id}.webp`
        : defaultBranding.logoPath,
      faviconPath: row.logo_asset_id
        ? `/api/v1/branding/${row.logo_asset_id}/favicon.png`
        : defaultBranding.faviconPath,
    };
  }
  async asset(id: string): Promise<LogoRecord | null> {
    const row = (
      await this.pool.query('SELECT * FROM clan_logo_assets WHERE id=$1', [id])
    ).rows[0];
    return row
      ? {
          logo: {
            id: row.id,
            sha256: row.sha256,
            byteSize: row.byte_size,
            width: row.width,
            height: row.height,
          },
          favicon: {
            id: row.favicon_id,
            sha256: row.favicon_sha256,
            byteSize: row.favicon_byte_size,
            width: row.favicon_width,
            height: row.favicon_height,
          },
        }
      : null;
  }
  async save(
    record: LogoRecord | null,
    revision: string,
    actor: string,
  ): Promise<Branding> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = (
        await client.query(
          'SELECT * FROM clan_branding WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!old || 'branding-' + old.version !== revision)
        throw new ApiError(
          409,
          'The clan logo changed. Reload before trying again.',
        );
      if (record) {
        const { logo: l, favicon: f } = record;
        await client.query(
          'INSERT INTO clan_logo_assets(id,sha256,byte_size,width,height,favicon_id,favicon_sha256,favicon_byte_size,favicon_width,favicon_height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            l.id,
            l.sha256,
            l.byteSize,
            l.width,
            l.height,
            f.id,
            f.sha256,
            f.byteSize,
            f.width,
            f.height,
          ],
        );
      }
      const id = record?.logo.id ?? null,
        version = old.version + 1;
      await client.query(
        'UPDATE clan_branding SET logo_asset_id=$1,version=$2 WHERE singleton=true',
        [id, version],
      );
      await client.query(
        'INSERT INTO clan_branding_audit(actor_id,old_logo_asset_id,new_logo_asset_id,version) VALUES($1,$2,$3,$4)',
        [actor, old.logo_asset_id, id, version],
      );
      await client.query('COMMIT');
      return {
        revision: 'branding-' + version,
        logoPath: id ? `/api/v1/branding/${id}.webp` : defaultBranding.logoPath,
        faviconPath: id
          ? `/api/v1/branding/${id}/favicon.png`
          : defaultBranding.faviconPath,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
