/** Transactional Regular/Event credits, explicit corrections and private audit history. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  classifyCollection,
  type CollectionType,
  type IntakeSchedulingEvidence,
} from '@clog/domain';
import { transaction } from './transaction.js';
import type { IconRecord } from './icon-storage.js';
import { insertImage, screenshotPath } from './proof-store.js';
import { validCollectionDate } from './intake.js';
import { ApiError, type BackendStore } from './types.js';
import {
  readSubmissionFilters,
  requireCreditAvailable,
} from './submission-filters.js';
import type {
  ReviewAction,
  ReviewCollectionFlags,
  ReviewFlagsChange,
  ManualSubmissionInput,
  ReviewAudit,
  ReviewCorrection,
  ReviewNote,
  ReviewStore,
  ReviewSubmission,
} from './review-types.js';

type Row = {
  id: string;
  version: number;
  source: 'discord' | 'manual' | 'runelite';
  itemId: number | null;
  collectionType: CollectionType | null;
  collectionReason: string;
  intakeScheduling: IntakeSchedulingEvidence | null;
  rawItemText: string;
  gameItemId: number | null;
  collectorName: string;
  collectedOn: string;
  dateSource: string;
  submittedAt: Date;
  proofUrl: string;
  proofImageId: string | null;
  chatMessage: string | null;
  hardcore: boolean;
  status: ReviewSubmission['status'];
  reviewNote: string;
  reviewReason: string | null;
};
const selection =
  'id::text,version,source,item_id AS "itemId",raw_item_text AS "rawItemText",game_item_id AS "gameItemId",' +
  'collection_type AS "collectionType",collection_reason AS "collectionReason",intake_scheduling AS "intakeScheduling",' +
  'collector_name AS "collectorName",to_char(collected_on,\'YYYY-MM-DD\') AS "collectedOn",' +
  'date_source AS "dateSource",submitted_at AS "submittedAt",' +
  'proof_url AS "proofUrl",proof_image_id::text AS "proofImageId",chat_message AS "chatMessage",hardcore,status,' +
  'review_note AS "reviewNote",review_reason AS "reviewReason"';
const view = (row: Row): ReviewSubmission => ({
  id: row.id,
  version: row.version,
  source: row.source,
  itemId: row.itemId,
  collectionType: row.collectionType,
  collectionReason: row.collectionReason,
  rawItemText: row.rawItemText,
  ...(row.gameItemId === null ? {} : { gameItemId: row.gameItemId }),
  collectorName: row.collectorName,
  collectedOn: row.collectedOn,
  proofUrl: row.proofUrl,
  hardcore: row.hardcore,
  status: row.status,
  reviewNote: row.reviewNote,
  reviewReason: row.reviewReason,
  screenshotPath: row.proofImageId ? screenshotPath(row.proofImageId) : null,
  ...(row.chatMessage === null ? {} : { chatMessage: row.chatMessage }),
  dateSource:
    row.dateSource === 'submission_default'
      ? 'submission'
      : row.dateSource === 'collector'
        ? 'claim'
        : 'admin',
  submittedAt: row.submittedAt.toISOString(),
});
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const conflict = () =>
  new ApiError(
    409,
    'Submission changed or approved credit already exists; reload.',
  );
const occupied = () =>
  new ApiError(
    409,
    'An approved Event collection already exists for this item. Revoke it before approving another Event collection.',
  );
function requireId(id: string) {
  if (!uuid.test(id)) throw new ApiError(404, 'Submission not found.');
}
function reasonOf(input: unknown, required: boolean) {
  if (
    typeof input !== 'string' ||
    input.trim().length > 1000 ||
    (required && !input.trim())
  )
    throw new ApiError(
      422,
      'A valid review reason of 1–1000 characters is required.',
    );
  return input.trim();
}
type Cursor = { revision: string; key: string[] | null };
function manualType(value: unknown, hardcore: boolean): CollectionType {
  if (value !== undefined && value !== 'regular' && value !== 'event')
    throw new ApiError(422, 'Select Regular collection or Event collection.');
  if (hardcore && value === 'event')
    throw new ApiError(422, 'Hardcore supports Regular collections only.');
  return value ?? 'regular';
}
function selectedFlags(row: Row, flags: ReviewCollectionFlags) {
  if (
    typeof flags.hardcore !== 'boolean' ||
    (flags.useIntakeTiming !== undefined && flags.useIntakeTiming !== true) ||
    (flags.useIntakeTiming
      ? flags.collectionType !== undefined || row.source === 'manual'
      : flags.collectionType === undefined)
  )
    throw new ApiError(422, 'Choose collection flags or saved intake timing.');
  if (flags.collectionType !== undefined)
    manualType(flags.collectionType, flags.hardcore);
  const classification = flags.useIntakeTiming
    ? classifyCollection(row.intakeScheduling, row.itemId, flags.hardcore)
    : {
        collectionType: flags.collectionType!,
        collectionReason: 'staff_correction',
      };
  return { hardcore: flags.hardcore, ...classification };
}
const cursorError = () =>
  new ApiError(
    409,
    'Review history changed or cursor expired. Reload the first page.',
  );
const encodeCursor = (revision: string, key: string[] | null) =>
  Buffer.from(JSON.stringify({ revision, key })).toString('base64url');
function parseCursor(
  value: string | undefined,
  revision: string,
  audit = false,
): Cursor {
  if (value === undefined) return { revision, key: null };
  try {
    if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw cursorError();
    const x = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Cursor;
    if (
      !x ||
      x.revision !== revision ||
      (x.key !== null &&
        (!Array.isArray(x.key) ||
          !x.key.every((value) => typeof value === 'string') ||
          (audit
            ? x.key.length !== 1 ||
              !/^[1-9][0-9]{0,18}$/u.test(x.key[0]!) ||
              BigInt(x.key[0]!) > 9223372036854775807n
            : x.key.length !== 2 ||
              !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(
                x.key[0]!,
              ) ||
              !Number.isFinite(Date.parse(x.key[0]!)) ||
              new Date(x.key[0]!).toISOString() !==
                x.key[0]!.slice(0, 23) + 'Z' ||
              !uuid.test(x.key[1]!))))
    )
      throw cursorError();
    return x;
  } catch {
    throw cursorError();
  }
}
function pageLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new ApiError(400, 'Page size must be between 1 and 20.');
}
export class PgReviewStore implements ReviewStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly backend: Pick<BackendStore, 'catalog'>,
  ) {}
  /** Bridge the merged read-only review UI; manual item editing belongs to #30/#31. */
  async adminCatalog() {
    const catalog = await this.backend.catalog();
    const revision = 'catalog-' + digest(JSON.stringify(catalog));
    return {
      revision,
      sourceRevision: null,
      items: catalog.items.map((item) => ({
        ...item,
        origin: 'source' as const,
        overrides: [],
      })),
      pages: catalog.pages.map((page) => ({
        ...page,
        version: 'page-' + digest(JSON.stringify([page.id, page.itemIds])),
        orderOrigin: 'source' as const,
      })),
    };
  }
  /** Insert trusted manual claims under the same credit uniqueness and audit transaction. */
  async createManual(
    fields: ManualSubmissionInput,
    actorId: string,
    actorName: string,
    requestKey: string,
    image?: IconRecord,
  ): Promise<ReviewSubmission> {
    if (!uuid.test(requestKey))
      throw new ApiError(400, 'A UUID Idempotency-Key is required.');
    const key = requestKey.toLowerCase();
    const collectionType = manualType(fields.collectionType, fields.hardcore);
    if (
      !Number.isSafeInteger(fields.itemId) ||
      fields.itemId <= 0 ||
      typeof fields.collectorName !== 'string' ||
      !fields.collectorName.trim() ||
      fields.collectorName.trim().length > 80 ||
      typeof fields.hardcore !== 'boolean' ||
      typeof fields.approve !== 'boolean' ||
      (typeof fields.proofUrl !== 'string' && fields.proofUrl !== undefined) ||
      (fields.proofUrl !== undefined && fields.proofUrl !== '') ||
      (typeof fields.reason !== 'string' && fields.reason !== undefined) ||
      (fields.reason?.trim().length ?? 0) > 1000
    )
      throw new ApiError(422, 'Invalid manual submission fields.');
    const payloadHash = digest(
      JSON.stringify([
        fields.itemId,
        fields.collectorName.trim(),
        fields.collectedOn,
        fields.hardcore,
        fields.proofUrl?.trim() ?? '',
        fields.approve,
        fields.reason?.trim() ?? '',
        ...(image ? [image.sha256] : []),
        ...(fields.collectionType === undefined
          ? []
          : [{ collectionType: fields.collectionType }]),
      ]),
    );
    try {
      return await transaction(this.pool, 'write', async (client) => {
        // Catalog bulk writers take the exclusive gate before canonical locks.
        await client.query('SELECT pg_advisory_xact_lock_shared(74261005)');
        // Serialize this actor/key across API processes before checking receipts.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [JSON.stringify(['manual', actorId, key])],
        );
        const replay = (
          await client.query<{
            payload_hash: string;
            response: ReviewSubmission;
          }>(
            'SELECT payload_hash,response FROM manual_submission_requests WHERE actor_id=$1 AND request_key=$2',
            [actorId, key],
          )
        ).rows[0];
        if (replay) {
          if (replay.payload_hash !== payloadHash)
            throw new ApiError(
              409,
              'Submission key already used for a different request.',
            );

          return replay.response;
        }
        const validItem = await client.query<{ name: string }>(
          'SELECT name FROM items WHERE id=$1 AND active FOR UPDATE',
          [fields.itemId],
        );
        if (validItem.rowCount !== 1)
          throw new ApiError(422, 'Select an active catalog item.');
        // Trusted staff can record achievements after a page's opening window.
        const now = (
          await client.query<{ today: string }>(
            "SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
        if (!validCollectionDate(fields.collectedOn, now))
          throw new ApiError(
            422,
            'Collection date is invalid or in the future.',
          );
        if (fields.approve)
          await requireCreditAvailable(
            client,
            fields.itemId,
            fields.hardcore,
            collectionType,
          );
        if (image) await insertImage(client, image);
        const id = randomUUID();
        const row = (
          await client.query<Row>(
            'INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,' +
              'collected_on,date_source,proof_url,hardcore,status,reviewed_at,' +
              "reviewed_by,review_reason,proof_image_id,collection_type,collection_reason) VALUES($1,'manual',$2,$3,$4,$5,'admin'," +
              "$6,$7,$8,CASE WHEN $8='approved' THEN now() ELSE NULL END," +
              "CASE WHEN $8='approved' THEN $9 ELSE NULL END,$10,$11,$12,'manual') RETURNING " +
              selection,
            [
              id,
              validItem.rows[0]!.name,
              fields.itemId,
              fields.collectorName.trim(),
              fields.collectedOn,
              fields.proofUrl?.trim() ?? '',
              fields.hardcore,
              fields.approve ? 'approved' : 'pending',
              actorId,
              fields.reason?.trim() || null,
              image?.id ?? null,
              collectionType,
            ],
          )
        ).rows[0]!;
        const created = view(row);
        await client.query(
          'INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,' +
            "reason,old_values,new_values) VALUES($1,$2,$3,'create',$4,$5,$6)",
          [
            id,
            actorId,
            actorName,
            fields.reason?.trim() || null,
            JSON.stringify(created),
            JSON.stringify(created),
          ],
        );
        await client.query(
          'INSERT INTO manual_submission_requests(actor_id,request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4,$5)',
          [actorId, key, payloadHash, id, JSON.stringify(created)],
        );

        return created;
      });
    } catch (e) {
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        e.code === '23505' &&
        'constraint' in e &&
        e.constraint === 'submissions_one_event_credit'
      )
        throw occupied();
      throw e;
    }
  }
  submissionFilters() {
    return readSubmissionFilters(this.pool);
  }
  async saveSubmissionFilters(
    filterCollected: boolean,
    revision: string,
    actorId: string,
  ) {
    return transaction(this.pool, 'write', async (client) => {
      const old = (
        await client.query<{ version: number; filter_collected: boolean }>(
          'SELECT version,filter_collected FROM submission_filter_settings WHERE singleton FOR UPDATE',
        )
      ).rows[0];
      if (!old) throw new ApiError(503, 'Submission filters are unavailable.');
      if (revision !== 'submission-filters-' + old.version)
        throw new ApiError(
          409,
          'Submission filters changed. Reload before saving again.',
        );
      await client.query(
        'UPDATE submission_filter_settings SET filter_collected=$1,version=version+1 WHERE singleton',
        [filterCollected],
      );
      await client.query(
        'INSERT INTO submission_filter_audit(id,actor_id,version,old_filter_collected,new_filter_collected) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          actorId,
          old.version + 1,
          old.filter_collected,
          filterCollected,
        ],
      );
      return {
        revision: 'submission-filters-' + (old.version + 1),
        filterCollected,
      };
    });
  }
  async queue(
    status: 'pending' | 'reviewed',
    unmatched: boolean,
    limit: number,
    cursor?: string,
  ) {
    return transaction(this.pool, 'snapshot', async (client) => {
      const where =
        status === 'pending'
          ? unmatched
            ? "WHERE status='pending' AND item_id IS NULL"
            : "WHERE status='pending'"
          : "WHERE status IN ('approved','rejected','revoked')";
      pageLimit(limit);
      await client.query("SET LOCAL statement_timeout = '5s'");
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM review_state WHERE singleton',
        )
      ).rows[0]!;
      const revision =
        'reviews-' +
        digest(
          JSON.stringify(['queue', state.version, status, unmatched, limit]),
        );
      const decoded = parseCursor(cursor, revision);
      const rows = (
        await client.query<Row & { pageTime: string }>(
          'SELECT ' +
            selection +
            ',to_char(submitted_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS "pageTime" FROM submissions ' +
            where +
            (decoded.key
              ? ' AND (submitted_at,id) < ($2::timestamptz,$3::uuid)'
              : '') +
            ' ORDER BY submissions.submitted_at DESC,submissions.id DESC LIMIT $1',
          decoded.key ? [limit + 1, ...decoded.key] : [limit + 1],
        )
      ).rows;
      const hasNext = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);

      return {
        revision,
        filters: await readSubmissionFilters(client),
        submissions: page.map(view),
        pageCursor: encodeCursor(revision, decoded.key),
        nextCursor:
          hasNext && last
            ? encodeCursor(revision, [last.pageTime, last.id])
            : null,
      };
    });
  }
  async detail(id: string, cursor?: string, limit = 20) {
    pageLimit(limit);
    requireId(id);
    return transaction(this.pool, 'snapshot', async (client) => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      const submission = (
        await client.query<Row>(
          'SELECT ' + selection + ' FROM submissions WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!submission) {
        return null;
      }
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM review_state WHERE singleton',
        )
      ).rows[0]!;
      const auditRevision =
        'reviews-' +
        digest(JSON.stringify(['audit', state.version, id, limit]));
      const decoded = parseCursor(cursor, auditRevision, true);
      const audits = (
        await client.query<{
          id: string;
          actorName: string;
          at: Date;
          action: string;
          reason: string | null;
          before: ReviewSubmission;
          after: ReviewSubmission;
        }>(
          'SELECT id::text,actor_name AS "actorName",created_at AS at,action,reason,' +
            'old_values AS before,new_values AS after FROM audit_events ' +
            'WHERE submission_id=$1 ' +
            (decoded.key
              ? 'AND (submission_id,id) < ($1::uuid,$3::bigint) '
              : '') +
            'ORDER BY audit_events.id DESC LIMIT $2',
          decoded.key ? [id, limit + 1, decoded.key[0]] : [id, limit + 1],
        )
      ).rows;

      return {
        submission: view(submission),
        auditRevision,
        auditCursor: encodeCursor(auditRevision, decoded.key),
        nextAuditCursor:
          audits.length > limit
            ? encodeCursor(auditRevision, [audits[limit - 1]!.id])
            : null,
        audit: audits.slice(0, limit).map((a) => ({
          id: a.id,
          actorName: a.actorName,
          at: a.at.toISOString(),
          action: (a.action === 'resolve'
            ? 'edit'
            : a.action) as ReviewAudit['action'],
          reason: a.reason,
          before: a.before,
          after: a.after,
        })),
      };
    });
  }
  async mutate(
    id: string,
    expectedVersion: number,
    fields: ReviewCorrection | ReviewAction | ReviewNote | ReviewFlagsChange,
    actorId: string,
    actorName: string,
  ) {
    requireId(id);
    try {
      return await transaction(this.pool, 'write', async (client) => {
        await client.query('SELECT pg_advisory_xact_lock_shared(74261005)');
        const row = (
          await client.query<Row>(
            'SELECT ' + selection + ' FROM submissions WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!row) throw new ApiError(404, 'Submission not found.');
        if (row.version !== expectedVersion) throw conflict();
        const before = view(row);
        let result: Row,
          action: 'edit' | 'approve' | 'reject' | 'revoke',
          reason: string;
        if ('action' in fields) {
          action = fields.action;
          reason = action === 'approve' ? '' : reasonOf(fields.reason, true);
          if (action === 'revoke' && fields.flags !== undefined)
            throw new ApiError(
              422,
              'Save collection flags separately before revoking.',
            );
          const flags =
            fields.flags === undefined ? row : selectedFlags(row, fields.flags);
          if (action === 'approve') {
            if (
              row.status !== 'pending' ||
              row.itemId === null ||
              flags.collectionType === null ||
              !row.collectorName.trim() ||
              (row.source !== 'manual' &&
                !row.proofImageId &&
                !(row.source === 'runelite' && row.chatMessage?.trim()))
            )
              throw new ApiError(
                422,
                'Resolve a canonical item and validate proof before approval.',
              );
            const active = await client.query(
              'SELECT 1 FROM items WHERE id=$1 AND active FOR UPDATE',
              [row.itemId],
            );
            if (active.rowCount !== 1)
              throw new ApiError(422, 'Selected item is inactive.');
            const now = (
              await client.query<{ today: string }>(
                "SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS today",
              )
            ).rows[0]!.today;
            if (!validCollectionDate(row.collectedOn, now))
              throw new ApiError(
                422,
                'Collection date is invalid or in the future.',
              );
            await requireCreditAvailable(
              client,
              row.itemId,
              flags.hardcore,
              flags.collectionType!,
            );
          } else if (
            action === 'reject'
              ? row.status !== 'pending'
              : row.status !== 'approved'
          )
            throw conflict();
          const status =
            action === 'approve'
              ? 'approved'
              : action === 'reject'
                ? 'rejected'
                : 'revoked';
          result = (
            await client.query<Row>(
              'UPDATE submissions SET status=$2,reviewed_by=$3,reviewed_at=now(),' +
                'review_reason=$4,hardcore=$5,collection_type=$6,collection_reason=$7,version=version+1 WHERE id=$1 RETURNING ' +
                selection,
              [
                id,
                status,
                actorId,
                reason || null,
                flags.hardcore,
                flags.collectionType,
                flags.collectionReason,
              ],
            )
          ).rows[0]!;
        } else if ('flags' in fields) {
          action = 'edit';
          if (row.status !== 'approved') throw conflict();
          reason = reasonOf(fields.reason, true);
          const flags = selectedFlags(row, fields.flags);
          if (
            row.hardcore === flags.hardcore &&
            row.collectionType === flags.collectionType &&
            row.collectionReason === flags.collectionReason
          )
            throw new ApiError(
              422,
              'There are no collection flag changes to save.',
            );
          const active = await client.query(
            'SELECT 1 FROM items WHERE id=$1 AND active FOR UPDATE',
            [row.itemId],
          );
          if (active.rowCount !== 1)
            throw new ApiError(422, 'Selected item is inactive.');
          await requireCreditAvailable(
            client,
            row.itemId!,
            flags.hardcore,
            flags.collectionType!,
            row.id,
          );
          result = (
            await client.query<Row>(
              'UPDATE submissions SET hardcore=$2,collection_type=$3,collection_reason=$4,reviewed_by=$5,reviewed_at=now(),review_reason=$6,version=version+1 WHERE id=$1 RETURNING ' +
                selection,
              [
                id,
                flags.hardcore,
                flags.collectionType,
                flags.collectionReason,
                actorId,
                reason,
              ],
            )
          ).rows[0]!;
        } else if ('note' in fields) {
          // This branch never touches claim fields, review decision metadata, or
          // the unique approved credit. It also handles unmatched pending claims.
          action = 'edit';
          if (row.status !== 'pending' && row.status !== 'approved')
            throw conflict();
          if (
            typeof fields.note !== 'string' ||
            fields.note.trim().length > 1000
          )
            throw new ApiError(
              422,
              'Keep the review note to 1,000 characters.',
            );
          const note = fields.note.trim();
          if (note === row.reviewNote)
            throw new ApiError(422, 'There are no changes to save.');
          reason = '';
          result = (
            await client.query<Row>(
              'UPDATE submissions SET review_note=$2,version=version+1 ' +
                'WHERE id=$1 RETURNING ' +
                selection,
              [id, note],
            )
          ).rows[0]!;
        } else {
          action = 'edit';
          if (row.status !== 'pending' && row.status !== 'approved')
            throw conflict();
          reason = reasonOf(fields.reason, row.status === 'approved');
          if (
            fields.useIntakeTiming !== undefined &&
            typeof fields.useIntakeTiming !== 'boolean'
          )
            throw new ApiError(422, 'Invalid intake timing choice.');
          if (fields.useIntakeTiming && fields.collectionType !== undefined)
            throw new ApiError(
              422,
              'Choose saved intake timing or an explicit collection type.',
            );
          if (fields.useIntakeTiming && row.source === 'manual')
            throw new ApiError(
              422,
              'Manual historical claims require an explicit collection type.',
            );
          if (fields.collectionType !== undefined)
            manualType(fields.collectionType, fields.hardcore);
          const automatic = classifyCollection(
            row.intakeScheduling,
            fields.itemId,
            fields.hardcore,
          );
          const preserveType =
            !fields.useIntakeTiming &&
            (row.source === 'manual' ||
              row.collectionReason === 'staff_correction' ||
              (row.collectionReason === 'legacy' && row.itemId !== null));
          const collectionType = fields.hardcore
            ? 'regular'
            : (fields.collectionType ??
              (preserveType
                ? (row.collectionType ?? 'regular')
                : (automatic.collectionType ?? 'regular')));
          const collectionReason =
            fields.collectionType !== undefined
              ? 'staff_correction'
              : preserveType
                ? row.collectionReason
                : automatic.collectionReason;
          if (
            !Number.isSafeInteger(fields.itemId) ||
            fields.itemId <= 0 ||
            typeof fields.hardcore !== 'boolean' ||
            typeof fields.collectorName !== 'string' ||
            !fields.collectorName.trim() ||
            fields.collectorName.trim().length > 80
          )
            throw new ApiError(
              422,
              'Select a valid canonical item, collector and mode.',
            );
          const now = (
            await client.query<{ today: string }>(
              "SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS today",
            )
          ).rows[0]!.today;
          if (!validCollectionDate(fields.collectedOn, now))
            throw new ApiError(
              422,
              'Collection date is invalid or in the future.',
            );
          const active = await client.query(
            'SELECT 1 FROM items WHERE id=$1 AND active FOR UPDATE',
            [fields.itemId],
          );
          if (active.rowCount !== 1)
            throw new ApiError(422, 'Selected catalog item is unavailable.');
          if (
            row.itemId === fields.itemId &&
            row.hardcore === fields.hardcore &&
            row.collectionType === collectionType &&
            row.collectionReason === collectionReason &&
            row.collectorName === fields.collectorName.trim() &&
            row.collectedOn === fields.collectedOn
          )
            throw new ApiError(422, 'There are no changes to save.');
          if (
            row.status === 'approved' &&
            (row.itemId !== fields.itemId ||
              row.hardcore !== fields.hardcore ||
              row.collectionType !== collectionType)
          )
            await requireCreditAvailable(
              client,
              fields.itemId,
              fields.hardcore,
              collectionType,
              row.id,
            );
          result = (
            await client.query<Row>(
              'UPDATE submissions SET item_id=$2,collector_name=$3,collected_on=$4,collection_type=$8,collection_reason=$9,' +
                "hardcore=$5,date_source=CASE WHEN collected_on<>$4::date THEN 'admin' ELSE date_source END," +
                "version=version+1,reviewed_at=CASE WHEN status='approved' THEN now() ELSE reviewed_at END," +
                "reviewed_by=CASE WHEN status='approved' THEN $6 ELSE reviewed_by END," +
                "review_reason=CASE WHEN status='approved' THEN $7 ELSE review_reason END " +
                'WHERE id=$1 RETURNING ' +
                selection,
              [
                id,
                fields.itemId,
                fields.collectorName.trim(),
                fields.collectedOn,
                fields.hardcore,
                actorId,
                reason || null,
                collectionType,
                collectionReason,
              ],
            )
          ).rows[0]!;
        }
        const after = view(result);
        await client.query(
          'INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,' +
            'reason,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            actorId,
            actorName,
            action,
            reason || null,
            JSON.stringify(before),
            JSON.stringify(after),
          ],
        );

        return after;
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505') {
        if (
          'constraint' in e &&
          e.constraint === 'submissions_one_event_credit'
        )
          throw occupied();
        throw conflict();
      }
      throw e;
    }
  }
}
