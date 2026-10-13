/** Prepare authorized reads before mounting any destination editor. */
import { createContext, useContext, useId, useLayoutEffect } from 'react';
import type {
  AdminCatalog,
  AdminClient,
  QueueResult,
  StaffAccount,
} from './admin-model.ts';
import type { AdminSession, ImportEntry, XpClient } from './xp-model.ts';
import type { XpTracker } from './xp-tracker.ts';
import type { Branding } from './branding.ts';
import type { SiteSettings } from './site-settings.ts';
import type { ClanKeySettings } from './clan-api-key.ts';
import type { RuneLiteSettings, SchedulingState } from '@clog/domain';
import { withAbort } from './with-abort.ts';
import { classifyAccessFailure } from './admin-session.ts';

export interface PreparedAdminData {
  kind:
    | 'queue'
    | 'catalog'
    | 'xp'
    | 'schedules'
    | 'settings'
    | 'runelite'
    | 'accounts'
    | 'account'
    | 'denied';
  catalog?: AdminCatalog;
  queue?: QueueResult;
  tracker?: XpTracker;
  history?: ImportEntry[];
  historyError?: string;
  schedules?: SchedulingState;
  settings?: SiteSettings;
  branding?: Branding;
  clanKey?: ClanKeySettings;
  runeLite?: RuneLiteSettings;
  accounts?: StaffAccount[];
  denial?: string;
}
export const adminRouteLabels: Record<string, string> = {
  '/admin': 'Submissions',
  '/admin/catalog': 'Items catalog',
  '/admin/xp': 'XP imports',
  '/admin/schedules': 'Scheduling',
  '/admin/settings': 'Site settings',
  '/admin/settings/hardcore': 'Hardcore worlds',
  '/admin/runelite': 'RuneLite submissions',
  '/admin/accounts': 'Moderator accounts',
  '/admin/account': 'Your account',
};
export function isAdminPath(path: string) {
  return path === '/admin' || path.startsWith('/admin/');
}
export async function loadAdminRoute(
  path: string,
  session: AdminSession,
  client: AdminClient,
  xp: XpClient,
  signal: AbortSignal,
): Promise<PreparedAdminData> {
  return withAbort(readAdminRoute(path, session, client, xp, signal), signal);
}
async function readAdminRoute(
  path: string,
  session: AdminSession,
  client: AdminClient,
  xp: XpClient,
  signal: AbortSignal,
): Promise<PreparedAdminData> {
  signal.throwIfAborted();
  if (session.mustChangePassword || path === '/admin/account')
    return { kind: 'account' };
  if (
    session.role !== 'admin' &&
    [
      '/admin/settings',
      '/admin/settings/hardcore',
      '/admin/runelite',
      '/admin/accounts',
    ].includes(path)
  )
    return {
      kind: 'denied',
      denial:
        path === '/admin/accounts'
          ? 'Only the administrator can create moderator accounts.'
          : path === '/admin/runelite'
            ? 'Only the administrator can change RuneLite settings.'
            : 'Only the administrator can change site settings.',
    };
  switch (path) {
    case '/admin/catalog':
      return { kind: 'catalog', catalog: await client.catalog(signal) };
    case '/admin/xp': {
      const [tracker, historyData] = await Promise.all([
        xp.tracker(signal),
        session.role === 'admin'
          ? xp
              .history(signal)
              .then((history) => ({ history }))
              .catch((failure: unknown) => {
                if (classifyAccessFailure(failure) === 'denied')
                  return {
                    history: [],
                    historyError:
                      'Your account is not allowed to view XP import history.',
                  };
                throw failure;
              })
          : Promise.resolve({ history: [] }),
      ]);
      return { kind: 'xp', tracker, ...historyData };
    }
    case '/admin/schedules': {
      const [schedules, catalog] = await Promise.all([
        client.scheduling(signal),
        client.catalog(signal),
      ]);
      return { kind: 'schedules', schedules, catalog };
    }
    case '/admin/settings':
    case '/admin/settings/hardcore': {
      const [settings, branding] = await Promise.all([
        client.settings(signal),
        client.branding(signal, path.endsWith('/hardcore')),
      ]);
      return { kind: 'settings', settings, branding };
    }
    case '/admin/runelite': {
      const [clanKey, runeLite] = await Promise.all([
        client.clanApiKey(signal),
        client.runeLiteSettings(signal),
      ]);
      return { kind: 'runelite', clanKey, runeLite };
    }
    case '/admin/accounts':
      return { kind: 'accounts', accounts: await client.accounts(signal) };
    default: {
      const [catalog, queue] = await Promise.all([
        client.catalog(signal),
        client.queue('pending', undefined, signal),
      ]);
      return { kind: 'queue', catalog, queue };
    }
  }
}
export interface AdminDraft {
  dirty: boolean;
  busy: boolean;
}
export const AdminRouteContext = createContext<{
  data: PreparedAdminData;
  drafts: Map<string, AdminDraft>;
} | null>(null);
export function usePreparedAdminData() {
  return useContext(AdminRouteContext)?.data;
}
/** Register only mounted forms, including pending writes whose outcome may be uncertain. */
export function useAdminDraft(dirty: boolean, busy = false) {
  const context = useContext(AdminRouteContext),
    id = useId();
  useLayoutEffect(() => {
    context?.drafts.set(id, { dirty, busy });
    return () => {
      context?.drafts.delete(id);
    };
  }, [context, id, dirty, busy]);
}
