/** Public log and event tracker share one page; admin routes remain directly addressable. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AdminPage } from './AdminPage.tsx';
import { LiveAdminClient } from './admin-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
import { XpPage } from './XpPage.tsx';
import { ActivityCompetitions } from './ActivityCompetitions.tsx';
import {
  LiveCompetitionClient,
  PreviewCompetitionClient,
  type CompetitionClient,
} from './competition-api.ts';
import { LiveXpClient } from './xp-api.ts';
import { PreviewXpClient } from './preview/xp.ts';
import { CollectionLog } from './CollectionLog.tsx';
import { usePublicLog } from './use-public-log.ts';
import { scenarios, type Scenario } from './preview/scenarios.ts';
import { parseSettings, type SiteSettings } from './site-settings.ts';
import { defaultBranding, parseBranding } from './branding.ts';
import { useRouteNavigation } from './use-route-navigation.ts';
import {
  defaultSiteCopy,
  type SiteCopy,
  type HardcoreAppearance,
} from '@clog/domain';

function LiveLog({
  preview,
  hardcore,
  copy,
  competitionClient,
}: {
  preview: () => void;
  hardcore: boolean;
  copy: SiteCopy;
  competitionClient: CompetitionClient;
}) {
  const state = usePublicLog();
  return (
    <CollectionLog
      {...state}
      hardcore={hardcore}
      onPreview={preview}
      copy={copy}
      activity={<ActivityCompetitions client={competitionClient} />}
    />
  );
}
function PreviewLog({
  client,
  hardcore,
  copy,
  competitionClient,
}: {
  client: PreviewAdminClient;
  hardcore: boolean;
  copy: SiteCopy;
  competitionClient: CompetitionClient;
}) {
  const [scenario, setScenario] = useState<Scenario | 'reviewed'>('reviewed');
  const revision = useSyncExternalStore(client.subscribe, client.getRevision);
  const data = useMemo(
    () => client.publicLog(scenario),
    [client, revision, scenario],
  );
  return (
    <>
      <details className="preview-options">
        <summary>Frontend preview · sample data</summary>
        <label>
          Review scenario{' '}
          <select
            value={scenario}
            onChange={(event) =>
              setScenario(event.target.value as Scenario | 'reviewed')
            }
          >
            <option value="reviewed">Admin review results</option>
            {scenarios.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          Review fixtures only. Reload resets changes; no clan data is changed.
        </p>
      </details>
      <CollectionLog
        preview
        data={data}
        hardcore={hardcore}
        copy={copy}
        activity={<ActivityCompetitions client={competitionClient} />}
      />
    </>
  );
}
function Skull({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: () => void;
}) {
  return (
    <button
      className={
        'hardcore-toggle' + (enabled ? ' hardcore-toggle--active' : '')
      }
      aria-label="Hardcore worlds"
      aria-pressed={enabled}
      title={enabled ? 'Switch to normal worlds' : 'Switch to hardcore worlds'}
      onClick={onChange}
    >
      <img src="/brand/skull.png" alt="" />
      <span className="sr-only">
        {enabled ? 'Hardcore worlds' : 'Normal worlds'}
      </span>
    </button>
  );
}
function PreviewSkull({
  client,
  hardcore,
  onChange,
}: {
  client: PreviewAdminClient;
  hardcore: boolean;
  onChange: (next: boolean) => void;
}) {
  useSyncExternalStore(client.subscribe, client.getRevision);
  const enabled = client.publicSettings().hardcoreEnabled;
  useEffect(() => {
    if (!enabled) onChange(false);
  }, [enabled, onChange]);
  return enabled ? (
    <Skull enabled={hardcore} onChange={() => onChange(!hardcore)} />
  ) : null;
}
export function App() {
  const { route, navigate, mode, register } = useRouteNavigation();
  const [hardcore, setHardcore] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveClanName, setLiveClanName] = useState('');
  const [liveCopy, setLiveCopy] = useState<SiteCopy>(defaultSiteCopy);
  const [liveBranding, setLiveBranding] = useState(defaultBranding);
  const [liveHardcoreBranding, setLiveHardcoreBranding] =
    useState(defaultBranding);
  const [liveHardcoreAppearance, setLiveHardcoreAppearance] =
    useState<HardcoreAppearance>();
  useEffect(() => {
    setLiveBranding(defaultBranding);
    setLiveHardcoreBranding(defaultBranding);
    if (route.preview) return;
    let stopped = false,
      pending = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (stopped || pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      const signal = controller.signal;
      try {
        await Promise.all(
          [false, true].map(async (hardcoreMode) => {
            try {
              const response = await fetch(
                '/api/v1/branding' + (hardcoreMode ? '/hardcore' : ''),
                {
                  signal,
                  cache: 'no-store',
                },
              );
              if (!response.ok) throw new Error('Branding unavailable');
              const value = parseBranding(await response.json());
              if (!stopped)
                (hardcoreMode ? setLiveHardcoreBranding : setLiveBranding)(
                  (current) =>
                    Number(value.revision.slice(9)) >=
                    Number(current.revision.slice(9))
                      ? value
                      : current,
                );
            } catch {
              /* Keep each mode's last verified logo independently. */
            }
          }),
        );
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    void load();
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const interval = setInterval(resume, 25000);
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [route.preview]);
  useEffect(() => {
    setHardcore(false);
    setLiveEnabled(false);
    if (route.preview) return;
    let stopped = false;
    let pending = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (pending || stopped) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch('/api/v1/settings', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Settings unavailable');
        const value = parseSettings(await response.json());
        if (!stopped) {
          setLiveEnabled(value.hardcoreEnabled);
          setLiveClanName(value.clanName);
          setLiveCopy(value.copy ?? defaultSiteCopy);
          setLiveHardcoreAppearance(
            value.hardcore ?? {
              clanName: value.clanName,
              copy: value.copy ?? defaultSiteCopy,
            },
          );
          if (!value.hardcoreEnabled) setHardcore(false);
        }
      } catch {
        if (!stopped) {
          setLiveEnabled(false);
          setHardcore(false);
        }
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    void load();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 25000);
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [route.preview]);
  const admin = route.path === '/admin' || route.path.startsWith('/admin/');
  const hardcoreAppearance = hardcore && !admin;
  const adminClient = useMemo(
    () => (route.preview ? new PreviewAdminClient() : new LiveAdminClient()),
    [route.preview],
  );
  useEffect(
    () => () => {
      if (adminClient instanceof PreviewAdminClient) adminClient.dispose();
    },
    [adminClient],
  );
  const xpClient = useMemo(
    () =>
      route.preview
        ? new PreviewXpClient((signal) => adminClient.session(signal))
        : new LiveXpClient(),
    [route.preview, adminClient],
  );
  const competitionClient = useMemo(
    () =>
      route.preview
        ? new PreviewCompetitionClient(
            adminClient,
            xpClient,
            xpClient instanceof PreviewXpClient
              ? (competition) => xpClient.storeMetadata(competition)
              : undefined,
          )
        : new LiveCompetitionClient(),
    [route.preview, adminClient, xpClient],
  );
  useSyncExternalStore(
    adminClient instanceof PreviewAdminClient
      ? adminClient.subscribe
      : () => () => {},
    adminClient instanceof PreviewAdminClient
      ? adminClient.getRevision
      : () => 0,
  );
  const appearance =
    adminClient instanceof PreviewAdminClient
      ? hardcoreAppearance
        ? adminClient.publicSettings().hardcore
        : adminClient.publicSettings()
      : hardcoreAppearance
        ? liveHardcoreAppearance
        : { clanName: liveClanName, copy: liveCopy };
  const clanName = appearance?.clanName ?? liveClanName;
  const branding =
    adminClient instanceof PreviewAdminClient
      ? adminClient.publicBranding(hardcoreAppearance)
      : hardcoreAppearance
        ? liveHardcoreBranding
        : liveBranding;
  useEffect(() => {
    document
      .querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"], link[rel="alternate icon"]',
      )
      .forEach((icon) => {
        icon.type = 'image/png';
        icon.href = branding.faviconPath;
      });
  }, [branding.faviconPath]);
  const copy = appearance?.copy ?? defaultSiteCopy;
  const settingsSaved = (value: SiteSettings) => {
    setLiveCopy(value.copy ?? defaultSiteCopy);
    setLiveHardcoreAppearance(
      value.hardcore ?? {
        clanName: value.clanName,
        copy: value.copy ?? defaultSiteCopy,
      },
    );
    setLiveClanName(value.clanName);
    setLiveEnabled(value.hardcoreEnabled);
    if (!value.hardcoreEnabled) setHardcore(false);
  };
  useEffect(() => {
    document.title = (clanName ? clanName + ' · ' : '') + copy.collectionTitle;
  }, [clanName, copy.collectionTitle]);
  return (
    <>
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: 'absolute' }}
      >
        <defs>
          <filter
            id="hardcore-outline"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius="0.65"
              result="expanded"
            />
            <feComposite
              in="expanded"
              in2="SourceAlpha"
              operator="out"
              result="edge"
            />
            <feFlood floodColor="#ff2929" />
            <feComposite in2="edge" operator="in" result="red-edge" />
            <feMerge>
              <feMergeNode in="red-edge" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <a className="skip-link" href={admin ? '#admin-main' : '#collection-log'}>
        Skip to {admin ? 'clan administration' : 'collection log'}
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a
            className="clan-brand"
            href={'/' + (route.preview ? '?preview=1' : '')}
            onClick={navigate}
            aria-label={
              (clanName ? clanName + ' ' : '') + 'clan collection log'
            }
          >
            <img className="clan-logo" src={branding.logoPath} alt="" />
            <div>
              <span className="clan-name">{clanName || 'Clan name'}</span>
              <span className="clan-subtitle">{copy.collectionTitle}</span>
            </div>
          </a>
          {!admin &&
            (adminClient instanceof PreviewAdminClient ? (
              <PreviewSkull
                client={adminClient}
                hardcore={hardcore}
                onChange={setHardcore}
              />
            ) : liveEnabled ? (
              <Skull
                enabled={hardcore}
                onChange={() => setHardcore(!hardcore)}
              />
            ) : null)}
        </header>
        <main id={admin ? 'admin-main' : 'collection-log'}>
          {admin ? (
            <AdminPage
              key={route.preview ? 'preview-admin' : 'live-admin'}
              competitionClient={competitionClient}
              client={adminClient}
              xpClient={xpClient}
              registerNavigation={register}
              clanName={clanName}
              onSettingsSaved={settingsSaved}
              onBrandingSaved={(value, hardcoreMode) =>
                (hardcoreMode ? setLiveHardcoreBranding : setLiveBranding)(
                  value,
                )
              }
              preview={route.preview}
              path={route.path}
              onMode={mode}
              onNavigate={navigate}
            >
              {(session, onAccessLost) =>
                route.path === '/admin/xp' ? (
                  <XpPage
                    competitionClient={competitionClient}
                    client={xpClient}
                    admin
                    session={session}
                    onAccessLost={onAccessLost}
                    preview={route.preview}
                    onMode={mode}
                  />
                ) : null
              }
            </AdminPage>
          ) : (
            <>
              {adminClient instanceof PreviewAdminClient ? (
                <PreviewLog
                  client={adminClient}
                  hardcore={hardcore}
                  copy={copy}
                  competitionClient={competitionClient}
                />
              ) : (
                <LiveLog
                  preview={() => mode(true)}
                  hardcore={hardcore}
                  copy={copy}
                  competitionClient={competitionClient}
                />
              )}
              <XpPage
                competitionClient={competitionClient}
                client={xpClient}
                admin={false}
                copy={copy}
                preview={route.preview}
                onMode={mode}
              />
            </>
          )}
        </main>
        <footer className="site-footer">
          <div className="footer-support">
            <a
              href="https://github.com/KihiraLove"
              className="github-support"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src="/brand/github-mark.svg" alt="" width="22" height="22" />
              <span>GitHub</span>
            </a>
            <a
              href="https://ko-fi.com/kihiralove"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="/brand/ko-fi-blue.png"
                alt="Support me on Ko-fi"
                width="180"
              />
            </a>
          </div>
          <p>
            Created using intellectual property belonging to Jagex Limited under
            the terms of Jagex's{' '}
            <a href="https://legal.jagex.com/docs/policies/fan-content-policy">
              Fan Content Policy
            </a>
            . This content is not endorsed by or affiliated with Jagex.
          </p>
          <p>
            Catalog data:{' '}
            <a href="https://templeosrs.com/api_doc.php">TempleOSRS</a> and{' '}
            <a href="https://oldschool.runescape.wiki/w/Module:Collection_log/data.json?oldid=15347607">
              OSRS Wiki contributors
            </a>
            .
          </p>
        </footer>
      </div>
    </>
  );
}
