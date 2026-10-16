/** Successful modules are shared; rejected loads expose explicit reload recovery. */
export class RouteCodeError extends Error {
  constructor(cause: unknown) {
    super('Page code could not be loaded. Reload the page to try again.', {
      cause,
    });
  }
}
function entry<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((cause: unknown) => {
      pending = undefined;
      throw new RouteCodeError(cause);
    });
    return pending;
  };
}
export const loadAdminCode = entry(() => import('./admin-entry.tsx'));
