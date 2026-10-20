/** Screenshot metadata, automatic review, audit and RuneLite receipts commit together. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  blockedRuneLiteWorldTypes,
  hardcoreRuneLiteWorldTypes,
  parseRuneLiteWorldTypes,
  runeLiteDecision,
  normalizePlayerName,
  classifyCollection,
  type RuneLiteRules,
} from '@clog/domain';
import { readRuneLiteSettings } from './runelite-settings.js';
import { lockScheduling } from './scheduling-store.js';
import { requireClanKey } from './clan-api-key.js';
import {
  readSubmissionFilters,
  isCollectedDuplicate,
  resolveCollectionCredit,
} from './submission-filters.js';
import type { IconRecord } from './icon-storage.js';
import { ApiError } from './types.js';
import {
  validateRuneLiteItemName,
  runeLiteItemName,
} from './runelite-item-name.js';
import { intakeScheduling } from './intake-scheduling.js';
export const screenshotPath = (id: string) =>
  `/api/v1/admin/submission-images/${id}.webp`;
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
  validateRuneLiteItemName(fields.itemName);
  if (
    fields.chatMessage === undefined ||
    !fields.chatMessage.trim() ||
    fields.chatMessage.includes('\0') ||
    Buffer.byteLength(fields.chatMessage, 'utf8') > 8192
  )
    throw new ApiError(
      422,
      'Supply the full chat message, up to 8192 UTF-8 bytes.',
    );
  if (rules.matchClanName && !clanMatches(fields.clanName, rules.clanName))
    throw new ApiError(
      403,
      'Clan name does not match the configured in-game clan name.',
    );
  return runeLiteDecision(fields.worldTypes, fields.username, rules);
}
export async function insertImage(
  client: Pick<pg.PoolClient, 'query'>,
  image: IconRecord,
) {
  await client.query(
    'INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,$2,$3,$4,$5)',
    [image.id, image.sha256, image.byteSize, image.width, image.height],
  );
}
export interface RuneLiteFields {
  username: string;
  clanName: string;
  itemId: number;
  itemName?: string;
  worldTypes: string[];
  /** Runtime validation requires the complete original chat message. */
  chatMessage?: string;
}
export interface RuneLiteReceipt {
  submissionId: string;
  status: 'pending' | 'approved' | 'rejected';
  itemId: number | null;
  /** Original game ID; omitted only on immutable receipts from older releases. */
  gameItemId?: number;
  collectionType?: import('@clog/domain').CollectionType | null;
  submittedAt: string;
  collectedOn: string;
  hardcore?: boolean;
  duplicate?: true;
}
export interface ProofStore {
  allowIntake(ip: string): Promise<boolean>;
  authorizeIntake(apiKey: string | undefined): Promise<void>;
  validateSubmission(fields: RuneLiteFields): Promise<void>;
  image(id: string): Promise<IconRecord | null>;
  createRuneLite(
    fields: RuneLiteFields,
    image: IconRecord | undefined,
    key: string,
    apiKey?: string,
  ): Promise<{ receipt: RuneLiteReceipt; imageId: string | null }>;
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
    image: IconRecord | undefined,
    key: string,
    apiKey?: string,
  ) {
    const world = runeLiteWorld(fields.worldTypes);
    const payload = [
      fields.username.trim(),
      fields.clanName.trim().toLowerCase(),
      fields.itemId,
      image?.sha256 ?? null,
    ];
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          ...payload,
          world.worldTypes,
          ...(fields.chatMessage === undefined ? [] : [fields.chatMessage]),
          ...(fields.itemName === undefined
            ? []
            : [{ itemName: fields.itemName }]),
        ]),
      )
      .digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Catalog writes take this gate before scheduling/item locks. Hold a
      // shared gate so lookup and frozen page membership use the same catalog.
      await client.query('SELECT pg_advisory_xact_lock_shared(74261005)');
      const schedulingEnabled = await lockScheduling(client, world.hardcore);
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
          image_id: string | null;
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
      if (fields.chatMessage === undefined)
        throw new ApiError(422, 'Supply the full chat message as proof.');
      const playerKey = normalizePlayerName(fields.username);
      // Serialize observers even before a canonical item exists. One lock per
      // player/world also covers aliases mapped between two deliveries.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['runelite-player', playerKey, world.hardcore])],
      );
      const item = (
        await client.query<{ id: number; name: string }>(
          'SELECT i.id,i.name FROM game_item_ids g JOIN items i ON i.id=g.item_id WHERE g.game_item_id=$1 AND i.active FOR UPDATE OF i',
          [fields.itemId],
        )
      ).rows[0];
      const filters = await readSubmissionFilters(client, true);
      const receivedAt = (
        await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
      ).rows[0]!.at;
      // The item lock serializes independent observers, including game-ID aliases.
      // Immutable event time/identity keep staff edits and duplicate deliveries from extending the window.
      const duplicate = (
        await client.query<{
          receipt: RuneLiteReceipt;
          imageId: string | null;
        }>(
          'SELECT e.receipt,s.proof_image_id::text AS "imageId" FROM runelite_drop_events e JOIN submissions s ON s.id=e.submission_id ' +
            'WHERE e.player_key=$1 AND (e.game_item_id=$5 OR ($2::integer IS NOT NULL AND (e.item_id=$2 OR ' +
            'EXISTS(SELECT 1 FROM game_item_ids g WHERE g.game_item_id=e.game_item_id AND g.item_id=$2)))) ' +
            "AND e.hardcore=$3 AND e.first_received_at > $4::timestamptz - interval '5 seconds' ORDER BY e.first_received_at LIMIT 1",
          [
            playerKey,
            item?.id ?? null,
            world.hardcore,
            receivedAt,
            fields.itemId,
          ],
        )
      ).rows[0];
      if (duplicate) {
        const receipt = { ...duplicate.receipt, duplicate: true as const };
        await client.query(
          'INSERT INTO runelite_submission_requests(request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4)',
          [key, hash, receipt.submissionId, JSON.stringify(receipt)],
        );
        await client.query('COMMIT');
        return { receipt, imageId: duplicate.imageId };
      }
      const schedulingEvidence = await intakeScheduling(
        client,
        schedulingEnabled,
        world.hardcore,
        receivedAt,
      );
      const classification = await resolveCollectionCredit(
        client,
        item?.id ?? null,
        world.hardcore,
        classifyCollection(
          schedulingEvidence,
          item?.id ?? null,
          world.hardcore,
        ),
      );
      const collectedDuplicate =
        item &&
        (await isCollectedDuplicate(
          client,
          filters.filterCollected,
          item.id,
          world.hardcore,
          classification.collectionType,
        ));
      const rejection = collectedDuplicate
        ? 'Automatically rejected: Filter out regular duplicates is on and this item already has a Regular collection in this world mode.'
        : decision.action === 'reject'
          ? decision.reason
          : undefined;
      if (image) await insertImage(client, image);
      const rawItemText = runeLiteItemName(fields, item?.name);
      const id = randomUUID();
      const row = (
        await client.query<{ submitted_at: Date; collected_on: string }>(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,proof_image_id,submitted_clan_name,game_item_id,hardcore,submitted_world_types,chat_message,submitted_at,intake_scheduling,collection_type,collection_reason) VALUES($1,'runelite',$2,$3,$4,($11::timestamptz AT TIME ZONE 'UTC')::date,'submission_default','',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING submitted_at,to_char(collected_on,'YYYY-MM-DD') AS collected_on",
          [
            id,
            rawItemText,
            item?.id ?? null,
            fields.username.trim(),
            image?.id ?? null,
            fields.clanName.trim(),
            fields.itemId,
            world.hardcore,
            world.worldTypes,
            fields.chatMessage,
            receivedAt,
            JSON.stringify(schedulingEvidence),
            classification.collectionType,
            classification.collectionReason,
          ],
        )
      ).rows[0]!;
      let status: RuneLiteReceipt['status'] = 'pending';
      if (rejection || (item && decision.action === 'allow')) {
        if (rejection) {
          await client.query(
            "UPDATE submissions SET status='rejected',version=version+1,reviewed_at=now(),reviewed_by='system:runelite-auto-review',review_reason=$2 WHERE id=$1",
            [id, rejection],
          );
          status = 'rejected';
        } else {
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
              error.constraint !== 'submissions_one_event_credit'
            )
              throw error;
            await client.query('ROLLBACK TO SAVEPOINT automatic_approval');
          }
          await client.query('RELEASE SAVEPOINT automatic_approval');
        }
        const before = {
          id,
          version: 1,
          source: 'runelite',
          itemId: item?.id ?? null,
          gameItemId: fields.itemId,
          ...classification,
          rawItemText,
          collectorName: fields.username.trim(),
          collectedOn: row.collected_on,
          dateSource: 'submission',
          submittedAt: row.submitted_at.toISOString(),
          proofUrl: '',
          screenshotPath: image ? screenshotPath(image.id) : null,
          chatMessage: fields.chatMessage,
          hardcore: world.hardcore,
          status: 'pending',
        };
        await client.query(
          'INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,reason,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            'system:runelite-auto-review',
            'RuneLite auto review',
            status === 'rejected'
              ? 'reject'
              : status === 'approved'
                ? 'approve'
                : 'create',
            rejection ??
              (status === 'approved'
                ? decision.reason
                : 'Automatic approval deferred: an approved Event collection already exists for this item.'),
            JSON.stringify(before),
            JSON.stringify({
              ...before,
              status,
              version: status === 'pending' ? 1 : 2,
            }),
          ],
        );
      }
      const receipt: RuneLiteReceipt = {
        submissionId: id,
        status,
        itemId: item?.id ?? null,
        gameItemId: fields.itemId,
        collectionType: classification.collectionType,
        submittedAt: row.submitted_at.toISOString(),
        collectedOn: row.collected_on,
        hardcore: world.hardcore,
      };
      await client.query(
        'INSERT INTO runelite_submission_requests(request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4)',
        [key, hash, id, JSON.stringify(receipt)],
      );
      await client.query(
        'INSERT INTO runelite_drop_events(submission_id,player_key,item_id,hardcore,first_received_at,receipt,game_item_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          playerKey,
          item?.id ?? null,
          world.hardcore,
          receivedAt,
          JSON.stringify(receipt),
          fields.itemId,
        ],
      );
      await client.query('COMMIT');
      return { receipt, imageId: image?.id ?? null };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
