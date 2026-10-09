/** Transactional review: one current approved credit per item/world, private audits. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { validCollectionDate, validProofUrl } from './intake.js';
import { ApiError, type BackendStore } from './types.js';
import type {
  ReviewAction,
  ManualSubmissionInput,
  ReviewAudit,
  ReviewCorrection,
  ReviewStore,
  ReviewSubmission,
} from './review-types.js';

type Row = {
  id: string;
  version: number;
  source: 'discord' | 'manual';
  itemId: number | null;
  rawItemText: string;
  collectorName: string;
  collectedOn: string;
  dateSource: string;
  submittedAt: Date;
  proofUrl: string;
  hardcore: boolean;
  status: ReviewSubmission['status'];
};
const selection =
  'id::text,version,source,item_id AS "itemId",raw_item_text AS "rawItemText",' +
  'collector_name AS "collectorName",to_char(collected_on,\'YYYY-MM-DD\') AS "collectedOn",' +
  'date_source AS "dateSource",submitted_at AS "submittedAt",' +
  'proof_url AS "proofUrl",hardcore,status';
const view = (row: Row): ReviewSubmission => ({
  ...row,
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
    'An approved credit already exists for this item and world mode. Revoke the existing credit or select a different item or mode.',
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
function parseCursor(value: string): { revision: string; offset: number } {
  try {
    if (value.length > 1024) throw new Error('Bad cursor');
    const x = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      revision?: unknown;
      offset?: unknown;
    };
    if (
      !x ||
      typeof x.revision !== 'string' ||
      !/^reviews-[a-f0-9]{64}$/u.test(x.revision) ||
      !Number.isSafeInteger(x.offset) ||
      Number(x.offset) < 0
    )
      throw new Error('Bad cursor');
    return { revision: x.revision, offset: Number(x.offset) };
  } catch {
    throw new ApiError(409, 'Review cursor expired. Reload the first page.');
  }
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
  ): Promise<ReviewSubmission> {
    if (
      !Number.isSafeInteger(fields.itemId) ||
      fields.itemId <= 0 ||
      typeof fields.collectorName !== 'string' ||
      !fields.collectorName.trim() ||
      fields.collectorName.trim().length > 80 ||
      typeof fields.hardcore !== 'boolean' ||
      typeof fields.approve !== 'boolean' ||
      (typeof fields.proofUrl !== 'string' && fields.proofUrl !== undefined) ||
      (fields.proofUrl && !validProofUrl(fields.proofUrl)) ||
      (typeof fields.reason !== 'string' && fields.reason !== undefined) ||
      (fields.reason?.trim().length ?? 0) > 1000
    )
      throw new ApiError(422, 'Invalid manual submission fields.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const validItem = await client.query<{ name: string }>(
        'SELECT name FROM items WHERE id=$1 AND active',
        [fields.itemId],
      );
      if (validItem.rowCount !== 1)
        throw new ApiError(422, 'Select an active catalog item.');
      const now = (
        await client.query<{ today: string }>(
          "SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS today",
        )
      ).rows[0]!.today;
      if (!validCollectionDate(fields.collectedOn, now))
        throw new ApiError(422, 'Collection date is invalid or in the future.');
      const id = randomUUID();
      const row = (
        await client.query<Row>(
          'INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,' +
            'collected_on,date_source,proof_url,hardcore,status,reviewed_at,' +
            "reviewed_by,review_reason) VALUES($1,'manual',$2,$3,$4,$5,'admin'," +
            "$6,$7,$8,CASE WHEN $8='approved' THEN now() ELSE NULL END," +
            "CASE WHEN $8='approved' THEN $9 ELSE NULL END,$10) RETURNING " +
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
      await client.query('COMMIT');
      return created;
    } catch (e) {
      await client.query('ROLLBACK');
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        e.code === '23505' &&
        'constraint' in e &&
        e.constraint === 'submissions_one_credit_per_world'
      )
        throw new ApiError(
          409,
          'This item already has an approved ' +
            (fields.hardcore ? 'hardcore' : 'ordinary') +
            ' collection log entry. Revoke or edit it instead.',
        );
      throw e;
    } finally {
      client.release();
    }
  }
  async queue(
    status: 'pending' | 'reviewed',
    unmatched: boolean,
    limit: number,
    cursor?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const where =
        status === 'pending'
          ? unmatched
            ? "WHERE status='pending' AND item_id IS NULL"
            : "WHERE status='pending'"
          : "WHERE status IN ('approved','rejected','revoked')";
      const fingerprint = (
        await client.query<{
          id: string;
          version: number;
          status: string;
          itemId: number | null;
        }>(
          'SELECT id::text,version,status,item_id AS "itemId" FROM submissions ' +
            where +
            ' ORDER BY id LIMIT 20001',
        )
      ).rows;
      if (fingerprint.length > 20000)
        throw new ApiError(503, 'Review queue exceeds supported bounds.');
      const revision =
        'reviews-' + digest(JSON.stringify([status, unmatched, fingerprint]));
      const decoded = cursor ? parseCursor(cursor) : { revision, offset: 0 };
      if (decoded.revision !== revision || decoded.offset > fingerprint.length)
        throw new ApiError(409, 'Review queue changed. Reload the first page.');
      const rows = (
        await client.query<Row>(
          'SELECT ' +
            selection +
            ' FROM submissions ' +
            where +
            ' ORDER BY submitted_at DESC,id DESC LIMIT $1 OFFSET $2',
          [limit + 1, decoded.offset],
        )
      ).rows;
      const hasNext = rows.length > limit;
      await client.query('COMMIT');
      return {
        revision,
        submissions: rows.slice(0, limit).map(view),
        nextCursor: hasNext
          ? Buffer.from(
              JSON.stringify({
                revision,
                offset: decoded.offset + limit,
              }),
            ).toString('base64url')
          : null,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async detail(id: string) {
    requireId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const submission = (
        await client.query<Row>(
          'SELECT ' + selection + ' FROM submissions WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!submission) {
        await client.query('COMMIT');
        return null;
      }
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
            'WHERE submission_id=$1 ORDER BY id DESC LIMIT 5001',
          [id],
        )
      ).rows;
      if (audits.length > 5000)
        throw new ApiError(503, 'Review audit exceeds supported bounds.');
      await client.query('COMMIT');
      return {
        submission: view(submission),
        audit: audits.map((a) => ({
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
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async mutate(
    id: string,
    expectedVersion: number,
    fields: ReviewCorrection | ReviewAction,
    actorId: string,
    actorName: string,
  ) {
    requireId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
        if (action === 'approve') {
          if (
            row.status !== 'pending' ||
            row.itemId === null ||
            !row.collectorName.trim() ||
            (row.source !== 'manual' && !validProofUrl(row.proofUrl))
          )
            throw new ApiError(
              422,
              'Resolve a canonical item and validate proof before approval.',
            );
          const active = await client.query(
            'SELECT 1 FROM items WHERE id=$1 AND active',
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
              'review_reason=$4,version=version+1 WHERE id=$1 RETURNING ' +
              selection,
            [id, status, actorId, reason || null],
          )
        ).rows[0]!;
      } else {
        action = 'edit';
        if (row.status !== 'pending' && row.status !== 'approved')
          throw conflict();
        reason = reasonOf(fields.reason, row.status === 'approved');
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
          'SELECT 1 FROM items WHERE id=$1 AND active',
          [fields.itemId],
        );
        if (active.rowCount !== 1)
          throw new ApiError(422, 'Selected catalog item is unavailable.');
        if (
          row.itemId === fields.itemId &&
          row.hardcore === fields.hardcore &&
          row.collectorName === fields.collectorName.trim() &&
          row.collectedOn === fields.collectedOn
        )
          throw new ApiError(422, 'There are no changes to save.');
        result = (
          await client.query<Row>(
            'UPDATE submissions SET item_id=$2,collector_name=$3,collected_on=$4,' +
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
      await client.query('COMMIT');
      return after;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505') {
        if (
          'constraint' in e &&
          e.constraint === 'submissions_one_credit_per_world'
        )
          throw occupied();
        throw conflict();
      }
      throw e;
    } finally {
      client.release();
    }
  }
}
