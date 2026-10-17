import { useEffect, useRef, useState } from 'react';
import {
  publicPoller,
  publicRead,
  reportPublicFailure,
} from './public-polling.ts';
export function usePublicPolling<T>(
  read: (signal: AbortSignal) => Promise<T>,
  message: string | ((error: unknown) => string),
  options: { enabled?: boolean; initial?: T; refreshKey?: number } = {},
) {
  const [data, setData] = useState<T | undefined>(options.initial),
    [error, setError] = useState<string>(),
    [loading, setLoading] = useState(options.initial === undefined);
  const retry = useRef(() => {}),
    failure = useRef(message);
  failure.current = message;
  const enabled = options.enabled ?? true,
    refreshKey = options.refreshKey ?? 0,
    initial = options.initial;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const subscription = publicPoller.subscribe(
      async (signal) => {
        if (active) setLoading(true);
        try {
          const next = await publicRead(read(signal), signal);
          if (active && !signal.aborted) {
            setData(next);
            setError(undefined);
          }
        } catch (error) {
          if (active && reportPublicFailure(signal))
            setError(
              typeof failure.current === 'function'
                ? failure.current(error)
                : failure.current,
            );
        } finally {
          if (active && reportPublicFailure(signal)) setLoading(false);
        }
      },
      initial === undefined || refreshKey > 0,
    );
    retry.current = subscription.refresh;
    return () => {
      active = false;
      subscription.stop();
    };
  }, [read, enabled, refreshKey, initial]);
  return { data, error, loading, retry: () => retry.current() };
}
