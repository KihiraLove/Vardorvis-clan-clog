/** PNG evidence, automatic review, audit and RuneLite receipts commit together. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  blockedRuneLiteWorldTypes,
  hardcoreRuneLiteWorldTypes,
  parseRuneLiteWorldTypes,
  runeLiteDecision,
  type RuneLiteRules,
} from '@clog/domain';
import { readRuneLiteSettings } from './runelite-settings.js';
import { lockScheduling, requireScheduledItem } from './scheduling-store.js';
import { requireClanKey } from './clan-api-key.js';
import type { IconRecord } from './icon-storage.js';
import { ApiError } from './types.js';
export const screenshotPath = (id: string) =>
  `/api/v1/admin/submission-images/${id}.png`;
export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export const clanMatches = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
export function runeLiteWorld(value: unknown) {
  let worldTypes: string[];
  try {
    worldTypes = parseRuneLiteWorldTypes(value);
  } catch {
    throw new ApiError(
      422,
      'Use a world type identifier or a JSON array of world type identifiers.',
    );
  }
  const blocked = worldTypes.find((type) =>
    blockedRuneLiteWorldTypes.includes(type),
  );
  if (blocked)
    throw new ApiError(
      403,
      `Submissions from ${blocked} worlds are not allowed.`,
    );
  return {
    worldTypes,
    hardcore: worldTypes.some((type) =>
      (hardcoreRuneLiteWorldTypes as readonly string[]).includes(type),
    ),
  };
}
function validateSubmission(fields: RuneLiteFields, rules: RuneLiteRules) {
  if (rules.matchClanName && !clanMatches(fields.clanName, rules.clanName))
    throw new ApiError(
      403,
      'Clan name does not match the configured in-game clan name.',
    );
  const decision = runeLiteDecision(fields.worldTypes, fields.username, rules);
  if (decision.action === 'reject') throw new ApiError(403, decision.reason);
  return decision;
}
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
  worldTypes: string[];
}
export interface RuneLiteReceipt {
  submissionId: string;
  status: 'pending' | 'approved';
  itemId: number;
  submittedAt: string;
  collectedOn: string;
  hardcore?: boolean;
}
export interface ProofStore {
  allowIntake(ip: string): Promise<boolean>;
  authorizeIntake(apiKey: string | undefined): Promise<void>;
  validateSubmission(fields: RuneLiteFields): Promise<void>;
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
    const rules = await readRuneLiteSettings(this.pool);
    await requireClanKey(this.pool, apiKey, false, !rules.matchClanName);
  }
  async validateSubmission(fields: RuneLiteFields) {
    validateSubmission(fields, await readRuneLiteSettings(this.pool));
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
    const world = runeLiteWorld(fields.worldTypes);
    const payload = [
      fields.username.trim(),
      fields.clanName.trim().toLowerCase(),
      fields.itemId,
      image.sha256,
    ];
    const hash = createHash('sha256')
      .update(JSON.stringify([...payload, world.worldTypes]))
      .digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const schedulingEnabled = await lockScheduling(client);
      // Settings and key rotation cannot race validation, approval or a replay.
      const rules = await readRuneLiteSettings(client, true);
      const decision = validateSubmission(fields, rules);
      await requireClanKey(client, apiKey, true, !rules.matchClanName);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['runelite:' + key.toLowerCase()],
      );
      const prior = (
        await client.query<{
          payload_hash: string;
          response: RuneLiteReceipt;
          image_id: string;
          legacy: boolean;
        }>(
          'SELECT r.payload_hash,r.response,s.proof_image_id::text AS image_id,s.submitted_world_types IS NULL AS legacy FROM runelite_submission_requests r JOIN submissions s ON s.id=r.submission_id WHERE r.request_key=$1',
          [key],
        )
      ).rows[0];
      if (prior) {
        const legacyMatch =
          prior.legacy &&
          !world.hardcore &&
          prior.payload_hash ===
            createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        if (prior.payload_hash !== hash && !legacyMatch)
          throw new ApiError(
            409,
            'Submission key already used for a different request.',
          );
        await client.query('COMMIT');
        return { receipt: prior.response, imageId: prior.image_id };
      }
      const item = (
        await client.query<{ id: number; name: string }>(
          'SELECT i.id,i.name FROM game_item_ids g JOIN items i ON i.id=g.item_id WHERE g.game_item_id=$1 AND i.active FOR SHARE OF i',
          [fields.itemId],
        )
      ).rows[0];
      if (!item)
        throw new ApiError(
          422,
          'Item ID is not in the active collection-log catalog.',
        );
      await requireScheduledItem(client, schedulingEnabled, item.id);
      await insertImage(client, image);
      const id = randomUUID();
      const row = (
        await client.query<{ submitted_at: Date; collected_on: string }>(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,proof_image_id,submitted_clan_name,game_item_id,hardcore,submitted_world_types) VALUES($1,'runelite',$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,'submission_default','',$5,$6,$7,$8,$9) RETURNING submitted_at,to_char(collected_on,'YYYY-MM-DD') AS collected_on",
          [
            id,
            item.name,
            item.id,
            fields.username.trim(),
            image.id,
            fields.clanName.trim(),
            fields.itemId,
            world.hardcore,
            world.worldTypes,
          ],
        )
      ).rows[0]!;
      let status: RuneLiteReceipt['status'] = 'pending';
      if (decision.action === 'allow') {
        // The unique credit index arbitrates concurrent auto/manual approvals.
        await client.query('SAVEPOINT automatic_approval');
        try {
          await client.query(
            "UPDATE submissions SET status='approved',version=version+1,reviewed_at=now(),reviewed_by='system:runelite-auto-review',review_reason=$2 WHERE id=$1",
            [id, decision.reason],
          );
          status = 'approved';
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== '23505' ||
            !('constraint' in error) ||
            error.constraint !== 'submissions_one_credit_per_world'
          )
            throw error;
          await client.query('ROLLBACK TO SAVEPOINT automatic_approval');
        }
        await client.query('RELEASE SAVEPOINT automatic_approval');
        const before = {
          id,
          version: 1,
          source: 'runelite',
          itemId: item.id,
          rawItemText: item.name,
          collectorName: fields.username.trim(),
          collectedOn: row.collected_on,
          dateSource: 'submission',
          submittedAt: row.submitted_at.toISOString(),
          proofUrl: '',
          screenshotPath: screenshotPath(image.id),
          hardcore: world.hardcore,
          status: 'pending',
        };
        await client.query(
          'INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,reason,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            'system:runelite-auto-review',
            'RuneLite auto review',
            status === 'approved' ? 'approve' : 'create',
            status === 'approved'
              ? decision.reason
              : 'Automatic approval deferred: an approved credit already exists for this item and world mode.',
            JSON.stringify(before),
            JSON.stringify({
              ...before,
              status,
              version: status === 'approved' ? 2 : 1,
            }),
          ],
        );
      }
      const receipt: RuneLiteReceipt = {
        submissionId: id,
        status,
        itemId: item.id,
        submittedAt: row.submitted_at.toISOString(),
        collectedOn: row.collected_on,
        hardcore: world.hardcore,
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
