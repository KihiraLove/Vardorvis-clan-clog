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
import { classifyAccessFailure } from './admin-session.ts';
import { useAdminAction } from './use-admin-action.ts';
import { usePreparedAdminData, useAdminDraft } from './admin-route-data.ts';
import { ClanApiKeySettings } from './ClanApiKeySettings.tsx';
import type { ClanKeySettings } from './clan-api-key.ts';

const matchingMode = (matchName: boolean, requireKey: boolean) =>
  matchName ? (requireKey ? 'both' : 'name') : 'key';

const worldOptions = [
  ['f2p', 'F2P worlds', true],
  ['pvp', 'PVP worlds', true],
  ['members', 'MEMBERS worlds', false],
  ['hardcore', 'HARDCORE_MAIN worlds', false],
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
  const prepared = usePreparedAdminData();
  const initial = prepared?.runeLite;
  const [keySettings, setKeySettings] = useState<ClanKeySettings | undefined>(
    prepared?.clanKey,
  );
  const [mode, setMode] = useState(() =>
    matchingMode(
      initial?.matchClanName ?? true,
      prepared?.clanKey?.enabled ?? true,
    ),
  );
  const [saved, setSaved] = useState<RuneLiteSettings | undefined>(initial);
  const [rules, setRules] = useState<RuneLiteRules>(() =>
    initial
      ? {
          matchClanName: initial.matchClanName,
          clanName: initial.clanName,
          worldPolicies: initial.worldPolicies,
          playerWhitelist: initial.playerWhitelist,
        }
      : defaultRuneLiteRules(''),
  );
  const [whitelist, setWhitelist] = useState(
    initial?.playerWhitelist.join('\n') ?? '',
  );
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const accept = (value: RuneLiteSettings, key: ClanKeySettings) => {
    setSaved(value);
    setKeySettings(key);
    setMode(matchingMode(value.matchClanName, key.enabled));
    setRules({
      matchClanName: value.matchClanName,
      clanName: value.clanName,
      worldPolicies: value.worldPolicies,
      playerWhitelist: value.playerWhitelist,
    });
    setWhitelist(value.playerWhitelist.join('\n'));
  };
  useEffect(() => {
    if (initial && prepared?.clanKey && refresh === 0) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSaved(undefined);
    setError(undefined);
    void Promise.all([
      client.runeLiteSettings(controller.signal),
      client.clanApiKey(controller.signal),
    ])
      .then(([value, key]) => {
        if (active && !controller.signal.aborted) accept(value, key);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (classifyAccessFailure(failure) === 'expired') onAccessLost();
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
    keySettings &&
    (rules.matchClanName !== saved.matchClanName ||
      mode !== matchingMode(saved.matchClanName, keySettings.enabled) ||
      rules.clanName !== saved.clanName ||
      JSON.stringify(rules.worldPolicies) !==
        JSON.stringify(saved.worldPolicies) ||
      whitelist !== saved.playerWhitelist.join('\n'));
  const disabled = action.busy || !saved || !keySettings;
  useAdminDraft(!!changed, action.busy);
  return (
    <>
      <ClanApiKeySettings
        client={client}
        session={session}
        onAccessLost={onAccessLost}
        settings={keySettings}
        onSaved={setKeySettings}
        busy={action.busy}
      />
      <div className="clan-api-key-settings runelite-review-settings">
        <h3>Automatic review</h3>
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
            if (!saved || !keySettings) return;
            void action.execute(
              async (signal) => {
                const input = parseRuneLiteRules({
                  ...rules,
                  playerWhitelist: whitelist
                    .split(/\r?\n/u)
                    .filter((name) => name.trim()),
                });
                const value = await client.saveRuneLiteSettings(
                  {
                    ...input,
                    expectedRevision: saved.revision,
                    clanKeyRequirement: {
                      enabled: mode !== 'name',
                      expectedRevision: keySettings.revision,
                    },
                  },
                  session.csrfToken,
                  signal,
                );
                if (!signal.aborted) {
                  if (!value.clanKeyRequirement)
                    throw new Error('Missing clan matching receipt.');
                  accept(value, {
                    ...keySettings,
                    ...value.clanKeyRequirement,
                  });
                  action.setMessage('RuneLite review settings saved.');
                }
              },
              async (signal) => {
                const [value, key] = await Promise.all([
                  client.runeLiteSettings(signal),
                  client.clanApiKey(signal),
                ]);
                if (!signal.aborted) accept(value, key);
              },
            );
          }}
        >
          <label htmlFor="runelite-clan-matching">Clan matching</label>
          <select
            id="runelite-clan-matching"
            value={mode}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as 'name' | 'key' | 'both';
              setMode(next);
              setRules({
                ...rules,
                matchClanName: next !== 'key',
              });
              action.setMessage(undefined);
            }}
          >
            <option value="name">Clan name</option>
            <option value="key">API key</option>
            <option value="both">Both</option>
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
            Players submissions who are the whitelist get auto accepted after
            world filtering
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
    </>
  );
}
