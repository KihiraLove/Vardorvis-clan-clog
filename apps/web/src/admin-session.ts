/** Shared access classification: forbidden operations do not necessarily expire a login. */
import type { AdminSession } from './xp-model.ts';

export type AdminAccess =
  | { phase: 'checking' }
  | { phase: 'signed-out' }
  | { phase: 'expired' }
  | { phase: 'authenticated'; session: AdminSession };

export type AccessFailure = 'expired' | 'denied' | 'other';

export function classifyAccessFailure(error: unknown): AccessFailure {
  const status =
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status === 401) return 'expired';
  if (status === 403) return 'denied';
  return 'other';
}

/** Only an authenticated, fully configured session may mount private views. */
export function visibleAdminSession(access: AdminAccess): AdminSession | null {
  return access.phase === 'authenticated' && !access.session.mustChangePassword
    ? access.session
    : null;
}
