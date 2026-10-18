import { useEffect, useState } from 'react';
import {
  parseDiscordFields,
  type DiscordSettings,
  type DiscordSettingsUpdate,
} from '@clog/domain';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { useAdminDraft, usePreparedAdminData } from './admin-route-data.ts';

export function DiscordBotSettings({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const initial = usePreparedAdminData()?.discord;
  const [saved, setSaved] = useState<DiscordSettings | undefined>(initial);
  const [fields, setFields] = useState(initial);
  const [token, setToken] = useState(''),
    [clearToken, setClearToken] = useState(false);
  const action = useAdminAction(onAccessLost);
  const [connection, setConnection] = useState('Checking…');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await client.discordStatus(controller.signal);
        if (!controller.signal.aborted)
          setConnection(
            !status.enabled
              ? 'Disabled'
              : status.ready
                ? 'Connected'
                : 'Connecting or unavailable',
          );
      } catch {
        if (!controller.signal.aborted) setConnection('Unavailable');
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, saved?.revision]);
  const dirty =
    !!saved &&
    (JSON.stringify(fields) !== JSON.stringify(saved) || !!token || clearToken);
  useAdminDraft(dirty, action.busy);
  const accept = (value: DiscordSettings) => {
    setSaved(value);
    setFields(value);
    setToken('');
    setClearToken(false);
  };
  const reload = async (signal: AbortSignal) => {
    const value = await client.discordSettings(signal);
    if (!signal.aborted) accept(value);
  };
  const register = (target: 'guild' | 'test') => {
    if (!saved) return;
    void action.execute(
      async (signal) => {
        await client.registerDiscordCommands(
          target,
          saved.revision,
          session.csrfToken,
          signal,
        );
        if (!signal.aborted)
          action.setMessage(
            `Commands registered for the ${target === 'test' ? 'test' : 'main'} server.`,
          );
      },
      reload,
      'Registering commands',
    );
  };
  if (!saved || !fields)
    return (
      <p role="alert">Discord settings are unavailable. Reload this page.</p>
    );
  return (
    <section className="admin-panel discord-settings">
      <h2>Discord bot</h2>
      <p role="status">Status: {connection}</p>
      <p>
        Connect your own Discord application. Changes take effect automatically
        within a few seconds.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async (signal) => {
            const input: DiscordSettingsUpdate = {
              ...parseDiscordFields(fields),
              expectedRevision: saved.revision,
              ...(clearToken ? { token: '' } : token ? { token } : {}),
            };
            if (
              input.enabled &&
              (!saved.tokenConfigured || clearToken) &&
              !token
            )
              throw new Error('Add a bot token before enabling Discord.');
            const value = await client.saveDiscordSettings(
              input,
              session.csrfToken,
              signal,
            );
            if (!signal.aborted) {
              accept(value);
              action.setMessage(
                'Discord settings saved. The bot will reload automatically.',
              );
            }
          }, reload);
        }}
      >
        <fieldset disabled={action.busy}>
          <legend>Connection</legend>
          <div>
            <span id="discord-enable-label">Enable Discord bot</span>{' '}
            <button
              type="button"
              className="site-button"
              role="switch"
              aria-labelledby="discord-enable-label"
              aria-checked={fields.enabled}
              onClick={() => setFields({ ...fields, enabled: !fields.enabled })}
            >
              {fields.enabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="discord-settings-grid">
            <label>
              Application ID
              <input
                inputMode="numeric"
                pattern="[0-9]{17,20}"
                maxLength={20}
                required={fields.enabled}
                value={fields.applicationId}
                onChange={(e) =>
                  setFields({ ...fields, applicationId: e.target.value })
                }
              />
            </label>
            <label>
              Server ID
              <input
                inputMode="numeric"
                pattern="[0-9]{17,20}"
                maxLength={20}
                required={fields.enabled}
                value={fields.guildId}
                onChange={(e) =>
                  setFields({ ...fields, guildId: e.target.value })
                }
              />
            </label>
            <label>
              Test server ID (optional)
              <input
                inputMode="numeric"
                pattern="[0-9]{17,20}"
                maxLength={20}
                value={fields.testGuildId}
                onChange={(e) =>
                  setFields({ ...fields, testGuildId: e.target.value })
                }
              />
            </label>
            <label>
              Bot token
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                maxLength={256}
                value={token}
                disabled={clearToken}
                placeholder={
                  saved.tokenConfigured
                    ? 'Stored securely; leave blank to keep it'
                    : 'Paste the token from Discord'
                }
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </div>
          <p>
            {saved.tokenConfigured
              ? 'A bot token is stored. Its value is never displayed.'
              : 'No bot token is stored.'}
          </p>
          {saved.tokenConfigured && (
            <label>
              <input
                type="checkbox"
                checked={clearToken}
                onChange={(e) => {
                  setClearToken(e.target.checked);
                  setToken('');
                  if (e.target.checked)
                    setFields({ ...fields, enabled: false });
                }}
              />
              Remove stored token when saving
            </label>
          )}
        </fieldset>
        <fieldset disabled={action.busy}>
          <legend>Rate limits per minute</legend>
          <div className="discord-settings-grid">
            {(
              [
                ['intakeUser', 'Submissions per user', 120],
                ['intakeGuild', 'Submissions per server', 120],
                ['searchUser', 'Searches per user', 600],
                ['searchGuild', 'Searches per server', 600],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={1}
                  max={max}
                  required
                  value={fields.limits[key]}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      limits: {
                        ...fields.limits,
                        [key]: e.target.valueAsNumber,
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="admin-actions">
          <button className="site-button" disabled={action.busy || !dirty}>
            Save Discord settings
          </button>
          <button
            type="button"
            className="site-button"
            disabled={action.busy || !dirty}
            onClick={() => accept(saved)}
          >
            Discard changes
          </button>
        </div>
      </form>
      <h3>Register slash commands</h3>
      <p>
        Invite the bot to your server with the bot and applications.commands
        permissions, then register /cc-clog. Save changes before registering.
      </p>
      <div className="admin-actions">
        <button
          className="site-button"
          disabled={
            action.busy ||
            dirty ||
            !saved.tokenConfigured ||
            !saved.applicationId ||
            !saved.guildId
          }
          onClick={() => register('guild')}
        >
          Register for main server
        </button>
        <button
          className="site-button"
          disabled={
            action.busy ||
            dirty ||
            !saved.tokenConfigured ||
            !saved.applicationId ||
            !saved.testGuildId
          }
          onClick={() => register('test')}
        >
          Register for test server
        </button>
      </div>
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </section>
  );
}
