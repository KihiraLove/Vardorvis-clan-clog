/** Shared visibility cadence, independent conditional pair and retained last-good data. */
import { useCallback, useMemo } from 'react';
import { LogUnavailable, PublicLogClient } from './api.ts';
import { usePublicPolling } from './use-public-polling.ts';
export function usePublicLog() {
  const client = useMemo(() => new PublicLogClient(), []);
  const read = useCallback(
    (signal: AbortSignal) => client.load(signal),
    [client],
  );
  return usePublicPolling(read, (failure) =>
    failure instanceof LogUnavailable &&
    [404, 501, 503].includes(failure.status)
      ? 'The clan collection log is not available yet.'
      : 'Could not refresh the clan collection log. Try again shortly.',
  );
}
