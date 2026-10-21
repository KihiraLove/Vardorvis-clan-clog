/** Browser-only test harness: serve API fixtures through the real HTTP clients. */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { itemAssets } from './test.ts';
import { MemoryAdminClient } from './support/admin.ts';
import { MemoryXpClient } from './support/xp.ts';
import { MemoryCompetitionClient } from './support/competition.ts';
import { defaultBranding, type Branding } from '../src/branding.ts';
import type { Scenario } from './support/scenarios.ts';

export async function mockApi(
  page: Page,
  options: { scenario?: Scenario; xpSamples?: boolean } = {},
) {
  await itemAssets(page);
  const admin = new MemoryAdminClient();
  const xp = new MemoryXpClient((signal) => admin.session(signal));
  const competition = new MemoryCompetitionClient(admin, xp, (value) =>
    xp.storeMetadata(value),
  );
  const state = { scenario: options.scenario as Scenario | undefined };
  if (options.xpSamples) await xp.samples();
  const signal = new AbortController().signal;
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  assets.set(
    '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.webp',
    {
      body: await sharp({
        create: { width: 320, height: 180, channels: 4, background: '#443322' },
      })
        .webp({ lossless: true })
        .toBuffer(),
      contentType: 'image/webp',
    },
  );
  const logos: Branding[] = [{ ...defaultBranding }, { ...defaultBranding }];
  const previews = new Map<
    string,
    Awaited<ReturnType<typeof competition.preview>>
  >();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const method = request.method(),
      csrf = request.headers()['x-csrf-token'] ?? '',
      key = request.headers()['idempotency-key'] ?? '';
    const contentType = request.headers()['content-type'];
    const form = contentType?.startsWith('multipart/form-data')
      ? await new Request(url, {
          method,
          headers: request.headers(),
          body: new Uint8Array(request.postDataBuffer()!).buffer,
        }).formData()
      : undefined;
    const b = form ? {} : (request.postDataJSON() ?? {});
    const scheduleFields = {
      title: b.title,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      pageIds: b.pageIds,
    };
    const revision = async () => (await admin.catalog(signal)).revision;
    const session = async () => {
      const value = await admin.session(signal);
      return value
        ? { ...value, authenticated: true }
        : { authenticated: false };
    };
    let status = 200;
    try {
      const asset = assets.get(path);
      if (asset) return await route.fulfill(asset);
      let result: unknown;
      if (path === '/api/v1/auth/session') result = await session();
      else if (path === '/api/v1/admin/catalog-updates')
        result = {
          revision: '0'.repeat(64),
          catalogRevision: 'catalog-1',
          autoOpen: false,
          releases: [],
          proposals: [],
          conflicts: [],
          currentImages: [],
        };
      else if (path === '/api/v1/admin/access-control')
        result =
          method === 'GET'
            ? await admin.accessControl(signal)
            : await admin.saveAccessControl(
                b.moderatorPages,
                b.expectedRevision,
                csrf,
                signal,
              );
      else if (path === '/api/v1/auth/logout') {
        await admin.logout(csrf, signal);
        result = {};
      } else if (path === '/api/v1/auth/login') {
        await admin.login(b.username, b.password, signal);
        result = {};
      } else if (path === '/api/v1/auth/account') {
        await admin.updateAccount(b, csrf, signal);
        result = await session();
      } else if (path === '/api/v1/settings') result = admin.publicSettings();
      else if (path === '/api/v1/catalog') result = admin.publicLog().catalog;
      else if (path === '/api/v1/collections')
        result = admin.publicLog(state.scenario ?? 'reviewed').collections;
      else if (
        /^\/api\/v1\/(?:admin\/)?branding(?:\/hardcore)?(?:\/logo)?$/.test(path)
      ) {
        const mode = path.includes('/hardcore') ? 1 : 0;
        if (method !== 'GET') {
          const next = Number(logos[mode]!.revision.slice(9)) + 1;
          if (method === 'DELETE')
            logos[mode] = { ...defaultBranding, revision: 'branding-' + next };
          else {
            const file = form!.get('logo') as File,
              bytes = Buffer.from(await file.arrayBuffer()),
              id = crypto.randomUUID();
            const logoPath = `/api/v1/branding/${id}.webp`,
              faviconPath = `/api/v1/branding/${id}/favicon.webp`;
            assets.set(logoPath, {
              body: await sharp(bytes, { animated: true }).webp().toBuffer(),
              contentType: 'image/webp',
            });
            assets.set(faviconPath, {
              body: await sharp(bytes)
                .resize(64, 64, { fit: 'contain' })
                .webp({ lossless: true })
                .toBuffer(),
              contentType: 'image/webp',
            });
            logos[mode] = {
              revision: 'branding-' + next,
              logoPath,
              faviconPath,
            };
          }
        }
        result = logos[mode];
      } else if (path === '/api/v1/discord/status') {
        result = await admin.discordStatus(signal);
      } else if (path === '/api/v1/admin/discord-settings') {
        result =
          method === 'GET'
            ? await admin.discordSettings(signal)
            : await admin.saveDiscordSettings(b, csrf, signal);
      } else if (path === '/api/v1/admin/discord-settings/register') {
        await admin.registerDiscordCommands(
          b.target,
          b.expectedRevision,
          csrf,
          signal,
        );
        const saved = await admin.discordSettings(signal);
        result = {
          registered: true,
          revision: saved.revision,
          guildId: b.target === 'test' ? saved.testGuildId : saved.guildId,
        };
      } else if (path === '/api/v1/admin/settings')
        result =
          method === 'GET'
            ? await admin.settings(signal)
            : await admin.saveSettings(
                b.hardcoreEnabled,
                b.expectedRevision,
                csrf,
                signal,
                b.clanName,
                b.copy,
                b.hardcore,
                b.howToSubmitMarkdown,
                {
                  ...(b.eventHighlight === undefined
                    ? {}
                    : { eventHighlight: b.eventHighlight }),
                  ...(b.hardcoreHighlight === undefined
                    ? {}
                    : { hardcoreHighlight: b.hardcoreHighlight }),
                },
              );
      else if (path === '/api/v1/admin/clan-api-key')
        result =
          method === 'GET'
            ? await admin.clanApiKey(signal)
            : await admin.saveClanApiKey(b, csrf, signal);
      else if (path === '/api/v1/admin/runelite-settings')
        result =
          method === 'GET'
            ? await admin.runeLiteSettings(signal)
            : await admin.saveRuneLiteSettings(b, csrf, signal);
      else if (path === '/api/v1/admin/submission-filters')
        result = await admin.saveSubmissionFilters(
          b.filterCollected,
          b.expectedRevision,
          csrf,
          signal,
        );
      else if (path === '/api/v1/admin/schedules')
        result =
          method === 'GET'
            ? await admin.scheduling(signal)
            : await admin.saveSchedule(
                scheduleFields,
                b.expectedRevision,
                csrf,
                signal,
              );
      else if (path === '/api/v1/admin/schedules/settings')
        result = await admin.setSchedulingEnabled(
          b.enabled,
          b.expectedRevision,
          csrf,
          signal,
        );
      else if (path.startsWith('/api/v1/admin/schedules/')) {
        const id = path.split('/').at(-1)!;
        result =
          method === 'DELETE'
            ? await admin.deleteSchedule(id, b.expectedRevision, csrf, signal)
            : await admin.saveSchedule(
                scheduleFields,
                b.expectedRevision,
                csrf,
                signal,
                id,
              );
      } else if (path === '/api/v1/admin/accounts') {
        if (method === 'GET')
          result = { accounts: await admin.accounts(signal) };
        else {
          result = await admin.createModerator(
            b.username,
            b.password,
            csrf,
            signal,
          );
          status = 201;
        }
      } else if (path.startsWith('/api/v1/admin/accounts/')) {
        const parts = path.split('/');
        result = await admin.manageModerator(
          parts.at(-2)!,
          b.expectedVersion,
          parts.at(-1)! as 'disable' | 'enable' | 'delete',
          csrf,
          signal,
        );
      } else if (path === '/api/v1/admin/catalog')
        result = await admin.catalog(signal);
      else if (path === '/api/v1/admin/catalog/icons') {
        const file = form!.get('icon') as File,
          iconPath = `/api/v1/catalog/icons/${crypto.randomUUID()}.webp`;
        assets.set(iconPath, {
          body: await sharp(Buffer.from(await file.arrayBuffer()))
            .webp({ lossless: true })
            .toBuffer(),
          contentType: 'image/webp',
        });
        result = await admin.upload(file, csrf, signal, iconPath);
      } else if (path === '/api/v1/admin/catalog/sections') {
        result = {
          section: await admin.createSection(
            b.name,
            key,
            b.expectedRevision,
            csrf,
            signal,
          ),
          catalogRevision: await revision(),
        };
      } else if (path === '/api/v1/admin/catalog/sections/order') {
        await admin.reorderSections(
          b.orderedSectionIds,
          b.expectedRevision,
          csrf,
          signal,
        );
        result = { catalogRevision: await revision() };
      } else if (path.startsWith('/api/v1/admin/catalog/sections/')) {
        await admin.editSection(
          path.split('/').at(-1)!,
          method === 'DELETE' ? null : b.name,
          b.expectedRevision,
          csrf,
          signal,
        );
        result = { catalogRevision: await revision() };
      } else if (path === '/api/v1/admin/catalog/pages') {
        result = {
          page: await admin.createPage(
            b,
            key,
            b.expectedRevision,
            csrf,
            signal,
          ),
          catalogRevision: await revision(),
        };
      } else if (path === '/api/v1/admin/catalog/pages/order') {
        await admin.reorderPages(
          b.category,
          b.orderedPageIds,
          b.expectedRevision,
          csrf,
          signal,
        );
        result = {
          category: b.category,
          orderedPageIds: b.orderedPageIds,
          catalogRevision: await revision(),
        };
      } else if (path.startsWith('/api/v1/admin/catalog/pages/')) {
        const parts = path.split('/'),
          pageId = parts[6]!;
        if (parts[7] === 'items') {
          const itemId = Number(parts[8]);
          const removed =
            method === 'DELETE'
              ? await admin.removePageItem(
                  pageId,
                  itemId,
                  b.expectedRevision,
                  b.expectedVersion,
                  csrf,
                  signal,
                )
              : await admin.attachItem(
                  pageId,
                  itemId,
                  b.expectedRevision,
                  csrf,
                  signal,
                );
          result = {
            ...removed,
            pageId,
            itemId,
            catalogRevision: await revision(),
          };
        } else if (parts[7] === 'order') {
          result = {
            page: await admin.order(
              pageId,
              b.orderedItemIds,
              b.expectedVersion,
              csrf,
              signal,
            ),
            catalogRevision: await revision(),
          };
        } else if (method === 'DELETE') {
          result = {
            ...(await admin.removePage(
              pageId,
              b.expectedRevision,
              b.expectedVersion,
              csrf,
              signal,
            )),
            pageId,
            catalogRevision: await revision(),
          };
        } else {
          await admin.renamePage(
            pageId,
            b.name,
            b.expectedRevision,
            csrf,
            signal,
          );
          result = { catalogRevision: await revision() };
        }
      } else if (path === '/api/v1/admin/catalog/items') {
        result = await admin.create(b, key, csrf, signal);
        status = 201;
      } else if (path.startsWith('/api/v1/admin/catalog/items/')) {
        const id = Number(path.split('/').at(-1));
        if (method === 'DELETE')
          await admin.deleteItem(id, b.expectedRevision, csrf, signal);
        else await admin.editItem(id, b, b.expectedRevision, csrf, signal);
        result = { catalogRevision: await revision() };
      } else if (
        path === '/api/v1/admin/submissions' ||
        path === '/api/v1/admin/submissions/upload'
      ) {
        if (method === 'GET')
          result = await admin.queue(
            url.searchParams.get('status') === 'reviewed'
              ? 'reviewed'
              : url.searchParams.get('unmatched') === 'true'
                ? 'unmatched'
                : 'pending',
            url.searchParams.get('cursor') ?? undefined,
            signal,
          );
        else {
          const fields = form ? JSON.parse(String(form.get('submission'))) : b,
            screenshot = form?.get('screenshot') as File | undefined;
          const row = await admin.addManual(
            fields,
            key,
            csrf,
            signal,
            screenshot,
          );
          if (screenshot) {
            assets.set(row.screenshotPath!, {
              body: await sharp(Buffer.from(await screenshot.arrayBuffer()))
                .webp({ lossless: true })
                .toBuffer(),
              contentType: 'image/webp',
            });
          }
          result = row;
          status = 201;
        }
      } else if (path.startsWith('/api/v1/admin/submissions/')) {
        const parts = path.split('/'),
          id = parts[5]!,
          action = parts[6];
        result =
          action === 'flags'
            ? await admin.saveCollectionFlags(
                id,
                b.expectedVersion,
                b.flags,
                b.reason,
                csrf,
                signal,
              )
            : action === 'note'
              ? await admin.saveReviewNote(
                  id,
                  b.expectedVersion,
                  b.note,
                  csrf,
                  signal,
                )
              : action
                ? await admin.decide(
                    id,
                    b.expectedVersion,
                    action as 'approve' | 'reject' | 'revoke',
                    b.reason ?? '',
                    csrf,
                    signal,
                    b.flags,
                  )
                : method === 'PATCH'
                  ? await admin.edit(id, b.expectedVersion, b, csrf, signal)
                  : await admin.detail(
                      id,
                      signal,
                      url.searchParams.get('cursor') ?? undefined,
                    );
      } else if (path === '/api/v1/xp/tracker')
        result = await xp.tracker(signal);
      else if (path === '/api/v1/admin/xp/imports')
        result = await xp.history(
          signal,
          url.searchParams.get('cursor') ?? undefined,
        );
      else if (path === '/api/v1/competitions/activities')
        result = await competition.activities(signal);
      else if (path === '/api/v1/admin/competitions/preview') {
        const p = await competition.preview(
          b.competitionUrl,
          csrf,
          signal,
          b.pageIds,
        );
        previews.set(p.previewToken, p);
        result = p;
      } else if (path === '/api/v1/admin/competitions/imports')
        result = await competition.apply(
          previews.get(b.previewToken)!,
          csrf,
          key,
          b.acknowledgeCorrections,
          signal,
        );
      else
        return await route.fulfill({
          status: 404,
          json: { error: 'No test fixture for ' + path },
        });
      await route.fulfill({ status, json: result ?? {} });
    } catch (error) {
      if (!(error as { status?: number }).status) console.error(path, error);
      await route.fulfill({
        status: (error as { status?: number }).status ?? 500,
        json: {
          error: error instanceof Error ? error.message : 'Fixture error',
        },
      });
    }
  });
  return { admin, xp, competition, state };
}
