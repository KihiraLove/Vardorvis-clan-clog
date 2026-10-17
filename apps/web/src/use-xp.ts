/** Selection changes cancel reads; the public cadence belongs to one shared coordinator. */
import { useCallback } from 'react';
import type { SkillId, XpClient } from './xp-model.ts';
import { XpRequestError } from './xp-api.ts';
import { usePublicPolling } from './use-public-polling.ts';
export function useXp(
  client: XpClient,
  skill: SkillId,
  competitionId: number | undefined,
  refreshKey: number,
) {
  const read = useCallback(
    (signal: AbortSignal) => client.load(skill, competitionId, signal),
    [client, skill, competitionId],
  );
  return usePublicPolling(
    read,
    (failure) =>
      failure instanceof XpRequestError
        ? failure.message
        : 'Could not refresh XP. Try again shortly.',
    { refreshKey },
  );
}
