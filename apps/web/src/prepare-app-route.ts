/** Fetch authorized entry data alongside code, without keeping a private route cache. */
import { classifyAccessFailure } from './admin-session.ts';
import { isAdminPath, loadAdminRoute } from './admin-route-data.ts';
import { withAbort } from './with-abort.ts';
import { loadAdminCode } from './route-code.ts';
import type {
  AppRuntime,
  PreparedAdminEntry,
  RouteResources,
} from './app-runtime.ts';

async function prepareEntry(
  path: string,
  runtime: AppRuntime,
  signal: AbortSignal,
): Promise<PreparedAdminEntry> {
  try {
    const session = await withAbort(runtime.admin.session(signal), signal);
    if (!session) return { access: { phase: 'signed-out' } };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const result = loadAdminRoute(
      path,
      session,
      runtime.admin,
      controller.signal,
    )
      .then(
        (data) => ({ data }),
        (error: unknown) => ({ error }),
      )
      .finally(() => signal.removeEventListener('abort', cancel));
    return {
      access: { phase: 'authenticated', session },
      preparation: { path, result, cancel },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (classifyAccessFailure(error) !== 'other')
      return { access: { phase: 'expired' } };
    return {
      access: { phase: 'checking' },
      error: 'Could not check admin access. Reload to try again.',
    };
  }
}
export async function prepareAppRoute(
  route: { path: string },
  current: { runtime: AppRuntime; admin: boolean },
  live: AppRuntime,
  signal: AbortSignal,
): Promise<RouteResources> {
  const admin = isAdminPath(route.path);
  let accepted = false;
  const entryPromise =
    admin && !current.admin
      ? prepareEntry(route.path, live, signal)
      : Promise.resolve(undefined);
  try {
    const [code, prepared] = await withAbort(
      Promise.all([
        admin ? loadAdminCode() : Promise.resolve(undefined),
        entryPromise,
      ]),
      signal,
    );
    signal.throwIfAborted();
    let entry = prepared;
    accepted = true;
    return {
      runtime: live,
      ...(code ? { AdminEntry: code.AdminEntry } : {}),
      takeEntry: () => {
        const result = entry;
        entry = undefined;
        return result;
      },
    };
  } finally {
    if (!accepted)
      void entryPromise.then(
        (value) => value?.preparation?.cancel(),
        () => {},
      );
  }
}
