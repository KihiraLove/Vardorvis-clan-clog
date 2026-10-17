/** Minimal typed doubles run through production auth, validation and error handling. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LifecycleError } from '@clog/database/dist/lifecycle.js';
import { createApp } from './app.js';
import { ApiError, type StaffAccount } from './types.js';
import type {
  ApplicationStore,
  CompetitionService,
  CatalogService,
  LifecycleReader,
  IconFiles,
} from './route-services.js';
import type { ReviewStore } from './review-types.js';
import type {
  CompetitionSnapshot,
  CompetitionReceipt,
} from './competition-types.js';

test('narrow route dependencies inject authorization, business/read failures and uncertain writes without store casts', async (t) => {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected dependency call');
  };
  let role: StaffAccount['role'] = 'admin';
  const id = randomUUID(),
    token = 'A'.repeat(43),
    origin = 'https://clog.test';
  const store = {
    ensureDefaultAdmin: async () => {},
    session: async () => ({
      id,
      displayName: 'Owner',
      accountVersion: 1,
      expiresAt: new Date(Date.now() + 60000),
    }),
    accountById: async () => ({
      id,
      username: 'Owner',
      role,
      mustChangePassword: false,
      credentialVersion: 1,
      passwordHash: 'unused verifier',
    }),
    accountByUsername: unexpected,
    createSession: unexpected,
    allowLogin: unexpected,
    deleteSession: unexpected,
    updateAccount: unexpected,
    accounts: unexpected,
    createModerator: unexpected,
    settings: unexpected,
    saveSettings: unexpected,
    botItems: unexpected,
    submitClaim: unexpected,
    catalog: unexpected,
    collections: unexpected,
  } satisfies ApplicationStore;
  let mode = 'business',
    readCalls = 0,
    previewCalls = 0,
    applyCalls = 0,
    catalogWrites = 0;
  let source: CompetitionSnapshot = {
    competition: {
      id: 99,
      kind: 'SKILL',
      title: 'Skill event',
      sourceUrl: 'https://wiseoldman.net/competitions/99',
      metrics: ['attack'],
      startsAt: '2099-01-01T00:00:00.000Z',
      endsAt: '2099-01-02T00:00:00.000Z',
    },
    skills: ['attack'],
    lifecycle: 'future',
  };
  const receipts = new Map<string, CompetitionReceipt>();
  const calls: unknown[][] = [];
  const competitions = {
    clock: async () => Date.now(),
    activities: async () => {
      readCalls++;
      throw new Error('postgres://secret-driver-details');
    },
    preview: async () => {
      previewCalls++;
      throw new ApiError(422, 'Metric scope changed.');
    },
    apply: async (...args) => {
      applyCalls++;
      calls.push(args);
      if (mode === 'business') throw new ApiError(409, 'Preview changed.');
      const key = args[3],
        previous = receipts.get(key);
      if (previous) return previous;
      const receipt = {
        outcome: 'applied',
        revision: 'xp-2',
        scheduleId: null,
      } satisfies CompetitionReceipt;
      receipts.set(key, receipt);
      throw new Error('commit acknowledgement lost: postgres://private');
    },
  } satisfies CompetitionService;
  const page = {
    page: {
      id: 'new-page',
      name: 'New',
      category: 'other',
      itemIds: [],
      version: 'page-1',
      orderOrigin: 'manual' as const,
    },
    catalogRevision: 'catalog-2',
  };
  const pageReceipts = new Map<string, typeof page>();
  const catalog = {
    catalog: async () => {
      throw new Error('private catalog connection string');
    },
    asset: async () => null,
    stage: unexpected,
    createSection: unexpected,
    editSection: unexpected,
    reorderSections: unexpected,
    renamePage: unexpected,
    attachItem: unexpected,
    editItem: unexpected,
    deleteItem: unexpected,
    removePage: unexpected,
    reorderPages: unexpected,
    create: unexpected,
    removePageItem: unexpected,
    reorder: unexpected,
    reconcile: unexpected,
    createPage: async (_fields, _actor, key) => {
      catalogWrites++;
      if (mode === 'business')
        throw new ApiError(422, 'Choose an active item.');
      const previous = pageReceipts.get(key);
      if (previous) return previous;
      pageReceipts.set(key, page);
      throw new Error('lost catalog commit acknowledgement');
    },
  } satisfies CatalogService;
  const review = {
    adminCatalog: unexpected,
    createManual: unexpected,
    queue: async () => {
      throw new Error('private review driver failure');
    },
    detail: async () => null,
    mutate: async () => {
      throw new ApiError(409, 'Submission changed.');
    },
  } satisfies ReviewStore;
  const lifecycle = {
    list: async () => {
      throw new LifecycleError(409, 'Archive cursor changed.');
    },
    detail: async () => {
      throw new LifecycleError(404, 'History not found.');
    },
  } satisfies LifecycleReader;
  const icons = { read: unexpected, save: unexpected } satisfies IconFiles;
  const app = createApp(undefined, undefined, {
    store,
    competitions,
    catalog,
    review,
    lifecycle,
    icons,
    auth: { origin, secret: 'b'.repeat(64), secure: true },
    fetchCompetition: async () => source,
    logger: false,
  });
  const cookie = '__Host-clog-session=' + token;
  try {
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    assert.equal(session.statusCode, 200);
    const headers = {
      cookie,
      origin,
      'x-csrf-token': session.json().csrfToken,
    };
    const body = {
      previewToken: 'B'.repeat(43),
      expectedRevision: 'xp-1',
      scheduleRevision: 'schedules-1',
      acknowledgeCorrections: true,
    };
    const competitionPath = '/api/v1/admin/competitions/imports';
    const pageBody = {
      name: 'New',
      category: 'other',
      itemIds: [],
      expectedRevision: 'catalog-1',
    };
    const pagePath = '/api/v1/admin/catalog/pages';
    await t.test(
      'anonymous and CSRF failures run before any store write or source preview',
      async () => {
        for (const path of [competitionPath, pagePath]) {
          const payload = path === pagePath ? pageBody : body;
          assert.equal(
            (await app.inject({ method: 'POST', url: path, payload }))
              .statusCode,
            401,
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: path,
                payload,
                headers: { cookie },
              })
            ).statusCode,
            403,
          );
        }
        assert.equal(applyCalls, 0);
        assert.equal(catalogWrites, 0);
        assert.equal(previewCalls, 0);
      },
    );
    await t.test(
      'unavailable reads use the production sanitized error contract',
      async () => {
        for (const path of [
          '/api/v1/competitions/activities',
          '/api/v1/admin/catalog',
          '/api/v1/admin/submissions',
        ]) {
          const result = await app.inject({ url: path, headers });
          assert.equal(result.statusCode, 503);
          assert.equal(result.json().error, 'Service temporarily unavailable.');
          assert.ok(!/private|postgres|driver|connection/u.test(result.body));
        }
        assert.equal(readCalls, 1);
      },
    );
    await t.test(
      'explicit business methods retain domain errors, version checks and lifecycle translation',
      async () => {
        const result = await app.inject({
          method: 'POST',
          url: competitionPath,
          payload: body,
          headers: { ...headers, 'idempotency-key': randomUUID() },
        });
        assert.equal(result.statusCode, 409);
        assert.equal(result.json().error, 'Preview changed.');
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: pagePath,
              payload: pageBody,
              headers: { ...headers, 'idempotency-key': 'catalog-key' },
            })
          ).statusCode,
          422,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/submissions/' + randomUUID() + '/approve',
              payload: { expectedVersion: 3 },
              headers,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              url: '/api/v1/admin/lifecycle/competitions',
              headers,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/competitions/preview',
              payload: { competitionUrl: source.competition.sourceUrl },
              headers,
            })
          ).statusCode,
          422,
        );
        assert.equal(previewCalls, 1);
      },
    );
    await t.test(
      'moderator imports reach domain validation while lifecycle tools remain owner-only',
      async () => {
        role = 'moderator';
        const before = catalogWrites;
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: pagePath,
              payload: pageBody,
              headers: { ...headers, 'idempotency-key': 'moderator-key' },
            })
          ).statusCode,
          422,
        );
        assert.equal(
          catalogWrites,
          before + 1,
          'catalog editing remains available to staff',
        );
        assert.equal(
          (
            await app.inject({
              url: '/api/v1/admin/lifecycle/competitions',
              headers,
            })
          ).statusCode,
          403,
        );
        source = { ...source, lifecycle: 'finished' };
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/competitions/preview',
              payload: { competitionUrl: source.competition.sourceUrl },
              headers,
            })
          ).statusCode,
          422,
        );
        assert.equal(previewCalls, 2);
        role = 'admin';
      },
    );
    await t.test(
      'uncertain competition and catalog writes expose no invented success; exact keys recover receipts',
      async () => {
        mode = 'uncertain';
        const key = randomUUID(),
          commandHeaders = { ...headers, 'idempotency-key': key };
        const first = await app.inject({
          method: 'POST',
          url: competitionPath,
          payload: body,
          headers: commandHeaders,
        });
        assert.equal(first.statusCode, 503);
        assert.ok(!first.body.includes('postgres'));
        assert.equal(receipts.size, 1);
        const second = await app.inject({
          method: 'POST',
          url: competitionPath,
          payload: body,
          headers: commandHeaders,
        });
        assert.equal(second.statusCode, 200);
        assert.deepEqual(second.json(), receipts.get(key));
        assert.deepEqual(calls.at(-1), calls.at(-2));
        assert.deepEqual(calls.at(-1), [
          body.previewToken,
          body.expectedRevision,
          body.scheduleRevision,
          key,
          id,
          'Owner',
          'admin',
          true,
        ]);
        const pageHeaders = { ...headers, 'idempotency-key': randomUUID() };
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: pagePath,
              payload: pageBody,
              headers: pageHeaders,
            })
          ).statusCode,
          503,
        );
        const retried = await app.inject({
          method: 'POST',
          url: pagePath,
          payload: pageBody,
          headers: pageHeaders,
        });
        assert.equal(retried.statusCode, 201);
        assert.deepEqual(retried.json(), page);
        assert.equal(pageReceipts.size, 1);
      },
    );
  } finally {
    await app.close();
  }
});
