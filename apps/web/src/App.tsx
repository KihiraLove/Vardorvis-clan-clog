import { useState } from 'react';
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
  const [preview, setPreview] = useState(
    new URLSearchParams(window.location.search).get('preview') === '1',
  );
  const mode = (next: boolean) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('preview', '1');
    else url.searchParams.delete('preview');
    window.history.replaceState(null, '', url);
    setPreview(next);
  };
  return (
    <>
      <a className="skip-link" href="#collection-log">
        Skip to collection log
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a
            className="clan-brand"
            href="/"
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
          <span
            className={`mode-label${preview ? ' mode-label--preview' : ''}`}
          >
            {preview ? 'Review preview' : 'Public collection log'}
          </span>
        </header>
        <main id="collection-log">
          {preview ? (
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
