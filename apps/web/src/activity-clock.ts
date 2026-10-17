import { useEffect, useState } from 'react';
import type { WomCompetition } from '@clog/domain';
export function nextActivityBoundary(
  competitions: readonly WomCompetition[],
  now: number,
): number | undefined {
  let next = Infinity;
  for (const competition of competitions)
    for (const text of [competition.startsAt, competition.endsAt]) {
      const at = Date.parse(text);
      if (at > now && at < next) next = at;
    }
  return Number.isFinite(next) ? next : undefined;
}
export function useActivityClock(
  competitions: readonly WomCompetition[],
  offset: number,
) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== 'visible') return;
      const local = Date.now();
      setNow(local);
      const next = nextActivityBoundary(competitions, local + offset);
      if (next !== undefined)
        timer = setTimeout(
          update,
          Math.min(2147483647, Math.max(1, next - local - offset)),
        );
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [competitions, offset]);
  return now + offset;
}
