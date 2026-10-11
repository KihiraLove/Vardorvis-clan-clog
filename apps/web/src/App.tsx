/** Public log and event tracker share one page; admin routes remain directly addressable. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AdminPage } from './AdminPage.tsx';
import { LiveAdminClient } from './admin-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
import { XpPage } from './XpPage.tsx';
import { LiveXpClient } from './xp-api.ts';
import { PreviewXpClient } from './preview/xp.ts';
import { CollectionLog } from './CollectionLog.tsx';
import { usePublicLog } from './use-public-log.ts';
import { scenarios, type Scenario } from './preview/scenarios.ts';
import { parseSettings } from './site-settings.ts';

function LiveLog({
  preview,
  hardcore,
}: {
  preview: () => void;
  hardcore: boolean;
}) {
  const state = usePublicLog();
  return <CollectionLog {...state} hardcore={hardcore} onPreview={preview} />;
}
function PreviewLog({
  client,
  hardcore,
}: {
  client: PreviewAdminClient;
  hardcore: boolean;
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
      <CollectionLog preview data={data} hardcore={hardcore} />
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
  const location = () => ({
    path: window.location.pathname,
    preview: new URLSearchParams(window.location.search).get('preview') === '1',
  });
  const [route, setRoute] = useState(location);
  const [hardcore, setHardcore] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(false);
  useEffect(() => {
    const change = () => setRoute(location());
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
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
  const mode = (next: boolean) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('preview', '1');
    else url.searchParams.delete('preview');
    window.history.replaceState(null, '', url);
    setRoute(location());
  };
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    window.history.pushState(null, '', event.currentTarget.href);
    setRoute(location());
    window.scrollTo(0, 0);
  };
  const admin = route.path === '/admin' || route.path.startsWith('/admin/');
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
            aria-label="Vardorvis clan collection log"
          >
            <img className="clan-logo" src="/brand/mexicat.gif" alt="" />
            <div>
              <span className="clan-name">Vardorvis</span>
              <span className="clan-subtitle">Clan Collection Log</span>
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
              client={adminClient}
              preview={route.preview}
              path={route.path}
              onMode={mode}
              onNavigate={navigate}
            >
              {route.path === '/admin/xp' && (
                <XpPage
                  client={xpClient}
                  admin
                  preview={route.preview}
                  onMode={mode}
                />
              )}
            </AdminPage>
          ) : (
            <>
              {adminClient instanceof PreviewAdminClient ? (
                <PreviewLog client={adminClient} hardcore={hardcore} />
              ) : (
                <LiveLog preview={() => mode(true)} hardcore={hardcore} />
              )}
              <XpPage
                client={xpClient}
                admin={false}
                preview={route.preview}
                onMode={mode}
              />
            </>
          )}
        </main>
        <footer className="site-footer">
          <p>Vardorvis · One clan. Every collection.</p>
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
