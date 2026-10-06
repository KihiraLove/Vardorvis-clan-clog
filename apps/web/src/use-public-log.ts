import { useEffect, useRef, useState } from 'react';
import { LogUnavailable, PublicLogClient } from './api.ts';
import type { LogData } from './model.ts';

export function usePublicLog() {
  const [data, setData] = useState<LogData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const client = new PublicLogClient();
    let stopped = false;
    let pending = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (pending || stopped) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10_000);
      try {
        const result = await client.load(controller.signal);
        if (!stopped) {
          setData(result);
          setError(undefined);
        }
      } catch (failure) {
        if (!stopped)
          setError(
            failure instanceof LogUnavailable &&
              [404, 501, 503].includes(failure.status)
              ? 'The clan collection log is not available yet.'
              : 'Could not refresh the clan collection log. Try again shortly.',
          );
      } finally {
        window.clearTimeout(timeout);
        pending = false;
        if (!stopped) setLoading(false);
      }
    };
    refresh.current = () => {
      void load();
    };
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 25_000);
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  return { data, error, loading, retry: () => refresh.current() };
}
