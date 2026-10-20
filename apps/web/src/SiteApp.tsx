/** Public collection/XP routes share their branding, world controls and navigation. */
import { useCallback, useMemo, useEffect, useState } from 'react';
import { XpPage } from './XpPage.tsx';
import { ActivityCompetitions } from './ActivityCompetitions.tsx';
import type { CompetitionClient } from './competition-api.ts';
import { CollectionLog, type CollectionLogView } from './CollectionLog.tsx';
import { usePublicLog } from './use-public-log.ts';
import { type SiteSettings } from './site-settings.ts';
import { defaultBranding } from './branding.ts';
import { PublicMetadataClient } from './public-metadata.ts';
import { SubmissionHelp } from './SubmissionHelp.tsx';
import { usePublicPolling } from './use-public-polling.ts';
import type { SiteNavigation } from './use-route-navigation.ts';
import type { RouteResources } from './app-runtime.ts';
import {
  defaultSiteCopy,
  defaultSubmissionHelp,
  type SiteCopy,
  type HardcoreAppearance,
} from '@clog/domain';

function LiveLog({
  hardcore,
  copy,
  competitionClient,
  view,
  onViewChange,
  requestedPage,
  captions,
}: {
  hardcore: boolean;
  copy: SiteCopy;
  competitionClient: CompetitionClient;
  view: CollectionLogView;
  onViewChange: (view: CollectionLogView, pageId?: string) => void;
  requestedPage?: string | null;
  captions: { normal: string; hardcore: string };
}) {
  const state = usePublicLog();
  return (
    <CollectionLog
      {...state}
      hardcore={hardcore}
      copy={copy}
      activity={<ActivityCompetitions client={competitionClient} />}
      view={view}
      onViewChange={onViewChange}
      requestedPage={requestedPage}
      captions={captions}
    />
  );
}
function publicHref(
  path: '/' | '/xp',
  pageId?: string | null,
  hardcore = false,
) {
  const query = new URLSearchParams();
  if (pageId && pageId.length <= 100) query.set('page', pageId);
  if (hardcore && path === '/') query.set('hardcore', '1');
  return path + (query.size ? '?' + query.toString() : '');
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
      <img src="/brand/skull.webp" alt="" />
      <span className="sr-only">
        {enabled ? 'Hardcore worlds' : 'Normal worlds'}
      </span>
    </button>
  );
}
export function SiteApp({
  navigation,
  resources,
}: {
  navigation: SiteNavigation;
  resources: RouteResources;
}) {
  const { route, navigate, visit, replaceSearch, register } = navigation;
  const admin = route.path === '/admin' || route.path.startsWith('/admin/');
  const [publicSearch, setPublicSearch] = useState(
    admin ? '' : (route.search ?? ''),
  );
  const [logView, setLogView] = useState<CollectionLogView>({ selection: {} });
  const params = new URLSearchParams(admin ? publicSearch : route.search);
  const requestedPage = params.get('page');
  const pageId =
    requestedPage ??
    (logView.category ? logView.selection[logView.category] : undefined);
  const { runtime, AdminEntry } = resources;
  const {
    admin: adminClient,
    xp: xpClient,
    competition: competitionClient,
  } = runtime;
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveClanName, setLiveClanName] = useState('');
  const [liveCopy, setLiveCopy] = useState<SiteCopy>(defaultSiteCopy);
  const [liveHelp, setLiveHelp] = useState(defaultSubmissionHelp);
  const [helpOpen, setHelpOpen] = useState(false);
  const [liveBranding, setLiveBranding] = useState(defaultBranding);
  const [liveHardcoreBranding, setLiveHardcoreBranding] =
    useState(defaultBranding);
  const [liveHardcoreAppearance, setLiveHardcoreAppearance] =
    useState<HardcoreAppearance>();
  const metadata = useMemo(() => new PublicMetadataClient(), []);
  const readSettings = useCallback(
    (signal: AbortSignal) => metadata.settings(signal),
    [metadata],
  );
  const readNormal = useCallback(
    (signal: AbortSignal) => metadata.branding(false, signal),
    [metadata],
  );
  const readHardcore = useCallback(
    (signal: AbortSignal) => metadata.branding(true, signal),
    [metadata],
  );
  const settings = usePublicPolling(
    readSettings,
    'Settings could not be refreshed.',
  );
  const normalBrand = usePublicPolling(
    readNormal,
    'Logo could not be refreshed.',
  );
  const hardcoreBrand = usePublicPolling(
    readHardcore,
    'Logo could not be refreshed.',
  );
  useEffect(() => {
    if (normalBrand.data)
      setLiveBranding((current) =>
        Number(normalBrand.data!.revision.slice(9)) >=
        Number(current.revision.slice(9))
          ? normalBrand.data!
          : current,
      );
  }, [normalBrand.data]);
  useEffect(() => {
    if (hardcoreBrand.data)
      setLiveHardcoreBranding((current) =>
        Number(hardcoreBrand.data!.revision.slice(9)) >=
        Number(current.revision.slice(9))
          ? hardcoreBrand.data!
          : current,
      );
  }, [hardcoreBrand.data]);
  useEffect(() => {
    const value = settings.data;
    if (!value) return;
    setLiveEnabled(value.hardcoreEnabled);
    setLiveClanName(value.clanName);
    setLiveCopy(value.copy ?? defaultSiteCopy);
    setLiveHelp(value.howToSubmitMarkdown ?? defaultSubmissionHelp);
    setLiveHardcoreAppearance(
      value.hardcore ?? {
        clanName: value.clanName,
        copy: value.copy ?? defaultSiteCopy,
      },
    );
  }, [settings.data]);
  useEffect(() => {
    if (!admin) setPublicSearch(route.search ?? '');
  }, [admin, route.search]);
  const hardcore = liveEnabled && params.get('hardcore') === '1';
  const xp = route.path === '/xp' && !hardcore;
  const collectionHref = publicHref('/', pageId, hardcore);
  const xpHref = publicHref('/xp', pageId);
  useEffect(() => {
    if (!admin && route.path === '/xp' && hardcore) visit(collectionHref, true);
  }, [admin, route.path, hardcore, collectionHref, visit]);
  const hardcoreAppearance = hardcore && !admin;
  const appearance = hardcoreAppearance
    ? liveHardcoreAppearance
    : { clanName: liveClanName, copy: liveCopy };
  const clanName = appearance?.clanName ?? liveClanName;
  const branding = hardcoreAppearance ? liveHardcoreBranding : liveBranding;
  useEffect(() => {
    document
      .querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"], link[rel="alternate icon"]',
      )
      .forEach((icon) => {
        icon.type = 'image/webp';
        icon.href = branding.faviconPath;
      });
  }, [branding.faviconPath]);
  const copy = appearance?.copy ?? defaultSiteCopy;
  const settingsSaved = (value: SiteSettings) => {
    setLiveCopy(value.copy ?? defaultSiteCopy);
    setLiveHelp(value.howToSubmitMarkdown ?? defaultSubmissionHelp);
    setLiveHardcoreAppearance(
      value.hardcore ?? {
        clanName: value.clanName,
        copy: value.copy ?? defaultSiteCopy,
      },
    );
    setLiveClanName(value.clanName);
    setLiveEnabled(value.hardcoreEnabled);
  };
  useEffect(() => {
    document.title =
      (clanName ? clanName + ' · ' : '') +
      (admin
        ? 'Clan administration'
        : xp
          ? copy.xpTitle
          : copy.collectionTitle);
  }, [clanName, copy.collectionTitle, copy.xpTitle, admin, xp]);
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
      <a
        className="skip-link"
        href={admin ? '#admin-main' : xp ? '#xp-main' : '#collection-log'}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          const main = document.querySelector('main');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        Skip to{' '}
        {admin ? 'clan administration' : xp ? 'XP tracker' : 'collection log'}
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a
            className="clan-brand"
            href={collectionHref}
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
          <div className="site-header-controls">
            <div className="site-header-world">
              {!admin && liveEnabled && (
                <Skull
                  enabled={hardcore}
                  onChange={() => visit(publicHref('/', pageId, !hardcore))}
                />
              )}
            </div>
            <a
              className="site-button site-header-link"
              href={admin ? collectionHref : '/admin'}
              onClick={navigate}
              aria-label={admin ? 'Main site' : 'Admin panel'}
              title={admin ? 'Main site' : 'Admin panel'}
            >
              <svg
                className="site-header-link__icon"
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              >
                {admin ? (
                  <path d="M3 11 12 3l9 8M5 9v12h5v-7h4v7h5V9" />
                ) : (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="1" />
                    <path d="M9 3v18M9 9h12M13 13h4M13 17h4" />
                  </>
                )}
              </svg>
              <span className="site-header-link__label">
                {admin ? 'Main site' : 'Admin panel'}
              </span>
            </a>
          </div>
        </header>
        {!admin && (
          <div className="public-navigation-bar">
            <nav
              className={
                'public-navigation' +
                (hardcore ? ' public-navigation--hidden' : '')
              }
              aria-label="Public pages"
              aria-hidden={hardcore || undefined}
              inert={hardcore}
            >
              <a
                className="site-button"
                href={collectionHref}
                onClick={navigate}
                aria-current={!xp ? 'page' : undefined}
              >
                Collection log
              </a>
              <a
                className="site-button"
                href={xpHref}
                onClick={navigate}
                aria-current={xp ? 'page' : undefined}
              >
                Xp tracker
              </a>
            </nav>
            <button
              type="button"
              className="site-button submission-help-button"
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setHelpOpen(true);
              }}
            >
              How to submit
            </button>
          </div>
        )}
        {!admin && helpOpen && (
          <SubmissionHelp text={liveHelp} onClose={() => setHelpOpen(false)} />
        )}
        <main
          id={admin ? 'admin-main' : xp ? 'xp-main' : 'collection-log'}
          tabIndex={-1}
        >
          {admin && AdminEntry ? (
            <AdminEntry
              competitionClient={competitionClient}
              client={adminClient}
              registerNavigation={register}
              clanName={clanName}
              onSettingsSaved={settingsSaved}
              onBrandingSaved={(value, hardcoreMode) =>
                (hardcoreMode ? setLiveHardcoreBranding : setLiveBranding)(
                  value,
                )
              }
              path={route.path}
              onNavigate={navigate}
              takeEntry={resources.takeEntry}
            />
          ) : xp ? (
            <XpPage client={xpClient} copy={copy} />
          ) : (
            <LiveLog
              hardcore={hardcore}
              copy={copy}
              competitionClient={competitionClient}
              view={logView}
              requestedPage={requestedPage}
              captions={{
                normal: liveCopy.collectionCaption,
                hardcore:
                  (liveHardcoreAppearance?.copy ?? liveCopy).collectionCaption +
                  ' Hardcore worlds',
              }}
              onViewChange={(view, selectedPageId) => {
                setLogView(view);
                const href = publicHref('/', selectedPageId, hardcore);
                replaceSearch(new URL(href, window.location.origin).search);
              }}
            />
          )}
        </main>
        <footer className="site-footer">
          <div className="footer-support">
            <a
              href="https://github.com/KihiraLove/clan-clog"
              className="github-support"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="/brand/github-mark.webp"
                alt=""
                width="22"
                height="22"
              />
              <span>GitHub</span>
            </a>
            <a
              href="https://ko-fi.com/kihiralove"
              className="project-support"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                className="project-support__logo"
                aria-hidden="true"
                viewBox="54 45 130 110"
                width="26"
                height="24"
              >
                <image href="/brand/ko-fi-blue.webp" width="980" height="198" />
              </svg>
              Support this project
            </a>
          </div>
          <p className="footer-catalog">
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
