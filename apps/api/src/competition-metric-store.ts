/** Persist only explicitly confirmed definitions; resolution tokens never grant import credit. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  competitionScope,
  parseCustomCompetitionMetric,
  womMetricType,
  type CompetitionMetricDiscovery,
  type CompetitionMetricRegistry,
  type CompetitionMetricResolution,
  type CustomCompetitionMetric,
} from '@clog/domain';
import { ApiError } from './types.js';
import { transaction } from './transaction.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export interface MetricSaveReceipt {
  revision: string;
  savedMetrics: string[];
}
export interface CompetitionMetricService {
  list(): Promise<CompetitionMetricRegistry>;
  challenge(
    discovery: CompetitionMetricDiscovery,
    actor: string,
  ): Promise<CompetitionMetricResolution>;
  save(
    token: string,
    revision: string,
    definitions: unknown[],
    key: string,
    actor: string,
  ): Promise<MetricSaveReceipt>;
}
export class PgCompetitionMetricStore implements CompetitionMetricService {
  constructor(private readonly pool: pg.Pool) {}
  async list(): Promise<CompetitionMetricRegistry> {
    return transaction(this.pool, 'snapshot', async (client) => {
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM competition_metric_state WHERE singleton',
        )
      ).rows[0]!;
      const rows = await client.query<{ definition: unknown }>(
        'SELECT definition FROM custom_competition_metrics ORDER BY metric LIMIT 501',
      );
      if (rows.rows.length > 500)
        throw new ApiError(503, 'Custom metric capacity exceeded.');
      return {
        revision: 'metrics-' + state.version,
        definitions: rows.rows.map((r) =>
          parseCustomCompetitionMetric(r.definition),
        ),
      };
    });
  }
  async challenge(
    discovery: CompetitionMetricDiscovery,
    actor: string,
  ): Promise<CompetitionMetricResolution> {
    const token = randomBytes(32).toString('base64url');
    return transaction(this.pool, 'write', async (client) => {
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM competition_metric_state WHERE singleton',
        )
      ).rows[0]!;
      const expires = (
        await client.query<{ at: Date }>(
          "SELECT clock_timestamp()+interval '10 minutes' AS at",
        )
      ).rows[0]!.at;
      await client.query(
        'INSERT INTO competition_metric_resolutions(token_hash,actor_id,discovery,expires_at) VALUES($1,$2,$3,$4)',
        [hash(token), actor, JSON.stringify(discovery), expires],
      );
      const pages = (
        await client.query<{ id: string; name: string }>(
          'SELECT id,name FROM pages WHERE active ORDER BY category,sort_order,id LIMIT 2001',
        )
      ).rows;
      if (pages.length > 2000)
        throw new ApiError(503, 'Catalog page limit exceeded.');
      return {
        ...discovery,
        resolutionToken: token,
        revision: 'metrics-' + state.version,
        expiresAt: expires.toISOString(),
        pages,
      };
    });
  }
  async save(
    token: string,
    revision: string,
    values: unknown[],
    key: string,
    actor: string,
  ): Promise<MetricSaveReceipt> {
    let definitions: CustomCompetitionMetric[];
    try {
      if (!Array.isArray(values) || !values.length || values.length > 64)
        throw new Error('Choose definitions for every unknown metric.');
      definitions = values
        .map(parseCustomCompetitionMetric)
        .sort((a, b) => a.metric.localeCompare(b.metric));
      if (new Set(definitions.map((d) => d.metric)).size !== definitions.length)
        throw new Error('Duplicate metrics cannot be registered.');
    } catch (error) {
      throw new ApiError(422, (error as Error).message);
    }
    const payloadHash = hash(JSON.stringify([token, revision, definitions]));
    return transaction(this.pool, 'write', async (client) => {
      await client.query('SELECT pg_advisory_xact_lock_shared(74261005)');
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM competition_metric_state WHERE singleton FOR UPDATE',
        )
      ).rows[0]!;
      const replay = (
        await client.query<{
          payload_hash: string;
          receipt: MetricSaveReceipt;
        }>(
          'SELECT payload_hash,receipt FROM competition_metric_audit WHERE actor_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== payloadHash)
          throw new ApiError(
            409,
            'Metric save key was used for a different request.',
          );
        return replay.receipt;
      }
      if (definitions.some((d) => womMetricType(d.metric)))
        throw new ApiError(422, 'Built-in metrics cannot be registered.');
      const resolution = (
        await client.query<{
          actor_id: string;
          discovery: CompetitionMetricDiscovery;
          valid: boolean;
        }>(
          // Maintenance removes only long-expired prompts; live tokens need no
          // row lock or UPDATE privilege on their server-fetched evidence.
          'SELECT actor_id,discovery,expires_at>clock_timestamp() AS valid FROM competition_metric_resolutions WHERE token_hash=$1',
          [hash(token)],
        )
      ).rows[0];
      if (!resolution || resolution.actor_id !== actor || !resolution.valid)
        throw new ApiError(
          409,
          'Metric prompt expired or belongs to another staff member. Preview again.',
        );
      if (
        JSON.stringify([...resolution.discovery.unknownMetrics].sort()) !==
        JSON.stringify(definitions.map((d) => d.metric))
      )
        throw new ApiError(
          422,
          'Define exactly the unknown metrics from this competition.',
        );
      const existing = (
        await client.query<{
          metric: string;
          definition: CustomCompetitionMetric;
        }>(
          'SELECT metric,definition FROM custom_competition_metrics ORDER BY metric',
        )
      ).rows;
      for (const definition of definitions) {
        const prior = existing.find((d) => d.metric === definition.metric);
        if (
          prior &&
          JSON.stringify(parseCustomCompetitionMetric(prior.definition)) !==
            JSON.stringify(definition)
        )
          throw new ApiError(
            409,
            'Another staff member saved a different definition. Preview again.',
          );
        const pages = await client.query(
          'SELECT id FROM pages WHERE active AND id=ANY($1::text[]) FOR SHARE',
          [definition.pageIds],
        );
        if (pages.rowCount !== definition.pageIds.length)
          throw new ApiError(422, 'Choose active catalog pages.');
      }
      const additions = definitions.filter(
        (d) => !existing.some((p) => p.metric === d.metric),
      );
      if (revision !== 'metrics-' + state.version && additions.length)
        throw new ApiError(409, 'Metric definitions changed. Preview again.');
      if (existing.length + additions.length > 500)
        throw new ApiError(
          422,
          'The 500 custom metric limit has been reached.',
        );
      const available = [...existing.map((r) => r.definition), ...additions];
      try {
        const metrics = resolution.discovery.metrics.map((d) => {
          const definition =
            !womMetricType(d.metric) &&
            available.find((m) => m.metric === d.metric);
          return { ...d, ...(definition ? { definition } : {}) };
        });
        competitionScope(
          metrics.map((d) => d.metric),
          metrics,
        );
      } catch (error) {
        throw new ApiError(422, (error as Error).message);
      }
      for (const d of additions)
        await client.query(
          'INSERT INTO custom_competition_metrics(metric,definition,actor_id) VALUES($1,$2,$3)',
          [d.metric, JSON.stringify(d), actor],
        );
      const version = additions.length
        ? (
            await client.query<{ version: string }>(
              'UPDATE competition_metric_state SET version=version+1 WHERE singleton RETURNING version::text',
            )
          ).rows[0]!.version
        : state.version;
      const receipt = {
        revision: 'metrics-' + version,
        savedMetrics: definitions.map((d) => d.metric),
      };
      await client.query(
        'INSERT INTO competition_metric_audit(id,actor_id,request_key,payload_hash,version,definitions,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          actor,
          key,
          payloadHash,
          version,
          JSON.stringify(definitions),
          JSON.stringify(receipt),
        ],
      );
      return receipt;
    });
  }
}
