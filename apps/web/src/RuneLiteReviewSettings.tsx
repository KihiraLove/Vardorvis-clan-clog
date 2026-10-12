import { useEffect, useState } from 'react';
import {
  defaultRuneLiteRules,
  parseRuneLiteRules,
  type RuneLiteRules,
  type RuneLiteSettings,
  type WorldPolicy,
} from '@clog/domain';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { AdminRequestError } from './admin-api.ts';
import { useAdminAction } from './use-admin-action.ts';

const worldOptions = [
  ['f2p', 'F2P worlds', true],
  ['pvp', 'PVP worlds', true],
  ['members', 'MEMBERS worlds', false],
  ['hardcore', 'HC_WORLDS_PLACEHOLDER worlds', false],
] as const;
export function RuneLiteReviewSettings({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [saved, setSaved] = useState<RuneLiteSettings>();
  const [rules, setRules] = useState<RuneLiteRules>(() =>
    defaultRuneLiteRules(''),
  );
  const [whitelist, setWhitelist] = useState('');
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const accept = (value: RuneLiteSettings) => {
    setSaved(value);
    setRules({
      matchClanName: value.matchClanName,
      clanName: value.clanName,
      worldPolicies: value.worldPolicies,
      playerWhitelist: value.playerWhitelist,
    });
    setWhitelist(value.playerWhitelist.join('\n'));
  };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSaved(undefined);
    setError(undefined);
    void client
      .runeLiteSettings(controller.signal)
      .then((value) => {
        if (active && !controller.signal.aborted) accept(value);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          onAccessLost();
        else setError('RuneLite review settings are unavailable.');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [client, onAccessLost, refresh]);
  const changed =
    saved &&
    (rules.matchClanName !== saved.matchClanName ||
      rules.clanName !== saved.clanName ||
      JSON.stringify(rules.worldPolicies) !==
        JSON.stringify(saved.worldPolicies) ||
      whitelist !== saved.playerWhitelist.join('\n'));
  const disabled = action.busy || !saved;
  return (
    <div className="clan-api-key-settings runelite-review-settings">
      <h3>Automatic review</h3>
      <p>
        Irregular worlds are always rejected: BETA_WORLD, DEADMAN, NOSAVE_MODE,
        PVP_ARENA, QUEST_SPEEDRUNNING, SEASONAL and TOURNAMENT (including
        TOURNAMENT_WORLD).
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            Retry review settings
          </button>
        </p>
      )}
      <form
        aria-busy={!saved && !error}
        onSubmit={(event) => {
          event.preventDefault();
          if (!saved) return;
          void action.execute(
            async (signal) => {
              const input = parseRuneLiteRules({
                ...rules,
                playerWhitelist: whitelist
                  .split(/\r?\n/u)
                  .filter((name) => name.trim()),
              });
              const value = await client.saveRuneLiteSettings(
                { ...input, expectedRevision: saved.revision },
                session.csrfToken,
                signal,
              );
              if (!signal.aborted) {
                accept(value);
                action.setMessage('RuneLite review settings saved.');
              }
            },
            async (signal) => {
              const value = await client.runeLiteSettings(signal);
              if (!signal.aborted) accept(value);
            },
          );
        }}
      >
        <label htmlFor="runelite-clan-matching">Clan matching</label>
        <select
          id="runelite-clan-matching"
          value={rules.matchClanName ? 'name' : 'key'}
          disabled={disabled}
          onChange={(event) => {
            setRules({
              ...rules,
              matchClanName: event.target.value === 'name',
            });
            action.setMessage(undefined);
          }}
        >
          <option value="name">Match in-game clan name</option>
          <option value="key">API key only</option>
        </select>
        <label htmlFor="runelite-clan-name">
          In-game clan name for matching
        </label>
        <input
          id="runelite-clan-name"
          value={rules.clanName}
          maxLength={80}
          required
          disabled={disabled || !rules.matchClanName}
          onChange={(event) => {
            setRules({ ...rules, clanName: event.target.value });
            action.setMessage(undefined);
          }}
        />
        <p className="admin-note">
          Clan matching ignores case and surrounding spaces. This name is
          independent of the website display name. API key only always requires
          a valid key, even when the shared key requirement is off.
        </p>
        {worldOptions.map(([key, label, canReject]) => (
          <div className="runelite-world-policy" key={key}>
            <label htmlFor={'runelite-policy-' + key}>{label}</label>
            <select
              id={'runelite-policy-' + key}
              value={rules.worldPolicies[key]}
              disabled={disabled}
              onChange={(event) => {
                setRules({
                  ...rules,
                  worldPolicies: {
                    ...rules.worldPolicies,
                    [key]: event.target.value as WorldPolicy,
                  },
                });
                action.setMessage(undefined);
              }}
            >
              {canReject && <option value="reject">Reject</option>}
              <option value="review">Send to review</option>
              <option value="allow">Auto allow</option>
            </select>
          </div>
        ))}
        <p className="admin-note">
          For multiple flags, rejection takes priority, then review, then auto
          allow. HC_WORLD_PLACEHOLDER uses the same hardcore policy.
          Unclassified worlds go to review.
        </p>
        <label htmlFor="runelite-player-whitelist">Player whitelist</label>
        <textarea
          id="runelite-player-whitelist"
          rows={6}
          value={whitelist}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => {
            setWhitelist(event.target.value);
            action.setMessage(undefined);
          }}
        />
        <p className="admin-note">
          One player name per line, up to 200. Names ignore case and treat
          underscores as spaces. Whitelisted players are auto approved after
          world rejection checks, including on worlds set to review. Existing
          item credits send additional claims to review.
        </p>
        <div className="admin-actions">
          <button
            className="site-button"
            disabled={disabled || !changed || !rules.clanName.trim()}
          >
            Save review settings
          </button>
        </div>
      </form>
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </div>
  );
}
