/** PNG metadata and RuneLite receipts commit with the pending claim. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { requireClanKey } from './clan-api-key.js';
import type { IconRecord } from './icon-storage.js';
import { ApiError } from './types.js';
export const screenshotPath = (id: string) =>
  `/api/v1/admin/submission-images/${id}.png`;
export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export const clanMatches = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
export async function insertImage(client: pg.PoolClient, image: IconRecord) {
  await client.query(
    'INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,$2,$3,$4,$5)',
    [image.id, image.sha256, image.byteSize, image.width, image.height],
  );
}
export interface RuneLiteFields {
  username: string;
  clanName: string;
  itemId: number;
}
export interface RuneLiteReceipt {
  submissionId: string;
  status: 'pending';
  itemId: number;
  submittedAt: string;
  collectedOn: string;
}
export interface ProofStore {
  allowIntake(ip: string): Promise<boolean>;
  authorizeIntake(apiKey: string | undefined): Promise<void>;
  clanName(): Promise<string>;
  image(id: string): Promise<IconRecord | null>;
  createRuneLite(
    fields: RuneLiteFields,
    image: IconRecord,
    key: string,
    apiKey?: string,
  ): Promise<{ receipt: RuneLiteReceipt; imageId: string }>;
}
export class PgProofStore implements ProofStore {
  constructor(private readonly pool: pg.Pool) {}
  async authorizeIntake(apiKey: string | undefined) {
    await requireClanKey(this.pool, apiKey);
  }
  async clanName() {
    const row = (
      await this.pool.query<{ clan_name: string }>(
        'SELECT clan_name FROM site_settings WHERE singleton=true',
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'Settings unavailable.');
    return row.clan_name;
  }
  async allowIntake(ip: string) {
    // Durable namespace shared across replicas, independent of staff login limits.
    await this.pool.query(
      'DELETE FROM auth_rate_limits WHERE expires_at<=now()',
    );
    const keys = ['runelite:ip:' + ip, 'runelite:global'];
    for (const [index, key] of keys.entries()) {
      const hash = createHash('sha256').update(key).digest('hex');
      const row = (
        await this.pool.query<{ attempts: number }>(
          "INSERT INTO auth_rate_limits(key_hash,attempts,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at<=now() THEN 1 ELSE auth_rate_limits.attempts+1 END, expires_at=CASE WHEN auth_rate_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE auth_rate_limits.expires_at END RETURNING attempts",
          [hash],
        )
      ).rows[0]!;
      if (row.attempts > (index === 0 ? 10 : 120)) return false;
    }
    return true;
  }
  async image(id: string) {
    const row = (
      await this.pool.query<IconRecord>(
        'SELECT i.id::text,i.sha256,i.byte_size AS "byteSize",i.width,i.height FROM submission_images i WHERE i.id=$1 AND EXISTS(SELECT 1 FROM submissions s WHERE s.proof_image_id=i.id)',
        [id],
      )
    ).rows[0];
    return row ?? null;
  }
  async createRuneLite(
    fields: RuneLiteFields,
    image: IconRecord,
    key: string,
    apiKey?: string,
  ) {
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          fields.username.trim(),
          fields.clanName.trim().toLowerCase(),
          fields.itemId,
          image.sha256,
        ]),
      )
      .digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A rename cannot race validation/insertion. Replays must also match the current clan.
      const settings = (
        await client.query<{ clan_name: string }>(
          'SELECT clan_name FROM site_settings WHERE singleton=true FOR SHARE',
        )
      ).rows[0];
      if (!settings) throw new ApiError(503, 'Settings unavailable.');
      if (!clanMatches(fields.clanName, settings.clan_name))
        throw new ApiError(403, 'Clan name does not match this website.');
      await requireClanKey(client, apiKey, true);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['runelite:' + key.toLowerCase()],
      );
      const prior = (
        await client.query<{
          payload_hash: string;
          response: RuneLiteReceipt;
          image_id: string;
        }>(
          'SELECT r.payload_hash,r.response,s.proof_image_id::text AS image_id FROM runelite_submission_requests r JOIN submissions s ON s.id=r.submission_id WHERE r.request_key=$1',
          [key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new ApiError(
            409,
            'Submission key already used for a different request.',
          );
        await client.query('COMMIT');
        return { receipt: prior.response, imageId: prior.image_id };
      }
      const item = (
        await client.query<{ id: number; name: string }>(
          'SELECT i.id,i.name FROM game_item_ids g JOIN items i ON i.id=g.item_id WHERE g.game_item_id=$1 AND i.active',
          [fields.itemId],
        )
      ).rows[0];
      if (!item)
        throw new ApiError(
          422,
          'Item ID is not in the active collection-log catalog.',
        );
      await insertImage(client, image);
      const id = randomUUID();
      const row = (
        await client.query<{ submitted_at: Date; collected_on: string }>(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,proof_image_id,submitted_clan_name,game_item_id) VALUES($1,'runelite',$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,'submission_default','',$5,$6,$7) RETURNING submitted_at,to_char(collected_on,'YYYY-MM-DD') AS collected_on",
          [
            id,
            item.name,
            item.id,
            fields.username.trim(),
            image.id,
            fields.clanName.trim(),
            fields.itemId,
          ],
        )
      ).rows[0]!;
      const receipt: RuneLiteReceipt = {
        submissionId: id,
        status: 'pending',
        itemId: item.id,
        submittedAt: row.submitted_at.toISOString(),
        collectedOn: row.collected_on,
      };
      await client.query(
        'INSERT INTO runelite_submission_requests(request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4)',
        [key, hash, id, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { receipt, imageId: image.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
