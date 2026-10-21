import { type Page } from '@playwright/test';
import { adminFixtures } from '../tests/admin-fixtures.ts';
import { MemoryAdminClient } from '../tests/support/admin.ts';
import { MemoryXpClient } from '../tests/support/xp.ts';
import { defaultBranding } from '../src/branding.ts';

export async function loadingFixtures(page: Page) {
  const f = await adminFixtures(),
    client = new MemoryAdminClient();
  const signal = new AbortController().signal,
    log = client.publicLog();
  const responses: Record<string, unknown> = {
    '/api/v1/auth/session': f.session,
    '/api/v1/settings': client.publicSettings(),
    '/api/v1/branding': defaultBranding,
    '/api/v1/branding/hardcore': defaultBranding,
    '/api/v1/catalog': log.catalog,
    '/api/v1/collections': log.collections,
    '/api/v1/admin/catalog': f.catalog,
    '/api/v1/admin/catalog-updates': f.catalogUpdates,
    '/api/v1/admin/submissions': f.pending,
    '/api/v1/admin/settings': client.publicSettings(),
    '/api/v1/admin/branding': defaultBranding,
    '/api/v1/admin/branding/hardcore': defaultBranding,
    '/api/v1/xp/tracker': await new MemoryXpClient().tracker(signal),
    '/api/v1/admin/xp/imports': {
      imports: [],
      revision: 'xp-history-1',
      pageCursor: 'first',
      nextCursor: null,
    },
    '/api/v1/competitions/activities': {
      serverNow: new Date().toISOString(),
      competitions: [],
    },
  };
  const calls: string[] = [],
    times: { path: string; at: number }[] = [];
  const delays = new Map<string, number>();
  const holds = new Map<string, Promise<void>>();
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    times.push({ path, at: Date.now() });
    await holds.get(path);
    const delay = delays.get(path);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({
      status: path in responses ? 200 : 404,
      json: responses[path] ?? {},
    });
  });
  return {
    calls,
    times,
    delays,
    responses,
    block: (path: string) => {
      let release!: () => void;
      holds.set(
        path,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        holds.delete(path);
        release();
      };
    },
  };
}
