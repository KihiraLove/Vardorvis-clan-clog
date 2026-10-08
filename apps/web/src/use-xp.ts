/** Refresh the selected XP projection on visibility, polling or import; retain data on failure. */
import { useEffect, useRef, useState } from 'react';
import type { SkillId, XpClient, XpSnapshot } from './xp-model.ts';
import { XpRequestError } from './xp-api.ts';

export function useXp(
  client: XpClient,
  skill: SkillId,
  competitionId: number | undefined,
  refreshKey: number,
) {
  const [data, setData] = useState<XpSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false,
      pending = false;
    let controller: AbortController | undefined;
    setLoading(true);
    setError(undefined);
    const load = async () => {
      if (stopped || pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10000);
      try {
        const next = await client.load(skill, competitionId, controller.signal);
        if (!stopped) {
          setData(next);
          setError(undefined);
        }
      } catch (failure) {
        if (!stopped)
          setError(
            failure instanceof XpRequestError
              ? failure.message
              : 'Could not refresh XP. Try again shortly.',
          );
      } finally {
        clearTimeout(timeout);
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
    }, 25000);
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', resume);
    // Selection/client changes cancel the old request before its result can replace the view.
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [client, skill, competitionId, refreshKey]);
  return { data, error, loading, retry: () => refresh.current() };
}
