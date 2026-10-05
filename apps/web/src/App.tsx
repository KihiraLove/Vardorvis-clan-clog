import { useEffect, useMemo, useState } from 'react';
import { XpPage } from './XpPage.tsx';
import { LiveXpClient } from './xp-api.ts';
import { PreviewXpClient } from './preview/xp.ts';
import { CollectionLog } from './CollectionLog.tsx';
import { usePublicLog } from './use-public-log.ts';
import {
  previewCatalog,
  previewCollections,
  scenarios,
  type Scenario,
} from './preview/scenarios.ts';

function LiveLog({ preview }: { preview: () => void }) {
  const state = usePublicLog();
  return <CollectionLog {...state} onPreview={preview} />;
}
function PreviewLog({ live }: { live: () => void }) {
  const [scenario, setScenario] = useState<Scenario>('uncollected');
  return (
    <>
      <div className="preview-banner">
        <div>
          <strong>Frontend preview</strong>
          <p>
            Sample pages, not the live clan log. Collection examples below are
            for review only.
          </p>
        </div>
        <button type="button" className="site-button" onClick={live}>
          View live log
        </button>
      </div>
      <div className="preview-controls">
        <label htmlFor="preview-scenario">Review scenario</label>
        <select
          id="preview-scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value as Scenario)}
        >
          {scenarios.map((entry) => (
            <option value={entry.id} key={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <span>No clan data is changed.</span>
      </div>
      <CollectionLog
        preview
        data={{
          catalog: previewCatalog,
          collections: previewCollections(scenario),
        }}
      />
    </>
  );
}
export function App() {
  const location = () => ({
    path: window.location.pathname,
    preview: new URLSearchParams(window.location.search).get('preview') === '1',
  });
  const [route, setRoute] = useState(location);
  useEffect(() => {
    const change = () => setRoute(location());
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
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
  const href = (path: string) => path + (route.preview ? '?preview=1' : '');
  const xp = route.path === '/xp' || route.path === '/admin/xp';
  const client = useMemo(
    () => (route.preview ? new PreviewXpClient() : new LiveXpClient()),
    [route.preview],
  );
  return (
    <>
      <a className="skip-link" href={xp ? '#xp-main' : '#collection-log'}>
        Skip to {xp ? 'XP tracker' : 'collection log'}
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a
            className="clan-brand"
            href={href('/')}
            onClick={navigate}
            aria-label="Vardorvis clan collection log"
          >
            <span className="brand-mark" aria-hidden="true">
              V
            </span>
            <div>
              <span className="clan-name">Vardorvis</span>
              <span className="clan-subtitle">Clan collection log</span>
            </div>
          </a>
          <nav className="site-nav" aria-label="Site navigation">
            <a
              href={href('/')}
              onClick={navigate}
              aria-current={!xp ? 'page' : undefined}
            >
              Collection log
            </a>
            <a
              href={href('/xp')}
              onClick={navigate}
              aria-current={route.path === '/xp' ? 'page' : undefined}
            >
              XP gained
            </a>
            <a
              href={href('/admin/xp')}
              onClick={navigate}
              aria-current={route.path === '/admin/xp' ? 'page' : undefined}
            >
              Admin
            </a>
          </nav>
          <span
            className={
              'mode-label' + (route.preview ? ' mode-label--preview' : '')
            }
          >
            {route.preview
              ? 'Review preview'
              : xp
                ? 'Public XP tracker'
                : 'Public collection log'}
          </span>
        </header>
        <main id={xp ? 'xp-main' : 'collection-log'}>
          {xp ? (
            <XpPage
              key={route.preview ? 'preview-xp' : 'live-xp'}
              client={client}
              admin={route.path === '/admin/xp'}
              preview={route.preview}
              onMode={mode}
              onNavigate={navigate}
            />
          ) : route.preview ? (
            <PreviewLog live={() => mode(false)} />
          ) : (
            <LiveLog preview={() => mode(true)} />
          )}
        </main>
        <footer className="site-footer">
          <p>One clan. Every collection.</p>
          <p>Old School RuneScape assets © Jagex. Community project.</p>
        </footer>
      </div>
    </>
  );
}
