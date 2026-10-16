/** Public log and event tracker share one page; admin routes remain directly addressable. */
import { useCallback, useMemo, useEffect, useState } from 'react';
import { XpPage } from './XpPage.tsx';
import { ActivityCompetitions } from './ActivityCompetitions.tsx';
import type { CompetitionClient } from './competition-api.ts';
import { CollectionLog } from './CollectionLog.tsx';
import { usePublicLog } from './use-public-log.ts';
import { type SiteSettings } from './site-settings.ts';
import { defaultBranding } from './branding.ts';
import { PublicMetadataClient } from './public-metadata.ts';
import { usePublicPolling } from './use-public-polling.ts';
import type { SiteNavigation } from './use-route-navigation.ts';
import type { RouteResources } from './app-runtime.ts';
import {
  defaultSiteCopy,
  type SiteCopy,
  type HardcoreAppearance,
} from '@clog/domain';

function LiveLog({
  hardcore,
  copy,
  competitionClient,
}: {
  hardcore: boolean;
  copy: SiteCopy;
  competitionClient: CompetitionClient;
}) {
  const state = usePublicLog();
  return (
    <CollectionLog
      {...state}
      hardcore={hardcore}
      copy={copy}
      activity={<ActivityCompetitions client={competitionClient} />}
    />
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
export function SiteApp({
  navigation,
  resources,
}: {
  navigation: SiteNavigation;
  resources: RouteResources;
}) {
  const { route, navigate, register } = navigation;
  const { runtime, AdminEntry } = resources;
  const {
    admin: adminClient,
    xp: xpClient,
    competition: competitionClient,
  } = runtime;
  const [hardcore, setHardcore] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveClanName, setLiveClanName] = useState('');
  const [liveCopy, setLiveCopy] = useState<SiteCopy>(defaultSiteCopy);
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
    setLiveHardcoreAppearance(
      value.hardcore ?? {
        clanName: value.clanName,
        copy: value.copy ?? defaultSiteCopy,
      },
    );
    if (!value.hardcoreEnabled) setHardcore(false);
  }, [settings.data]);
  const admin = route.path === '/admin' || route.path.startsWith('/admin/');
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
            href="/"
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
            (liveEnabled ? (
              <Skull
                enabled={hardcore}
                onChange={() => setHardcore(!hardcore)}
              />
            ) : null)}
        </header>
        <main id={admin ? 'admin-main' : 'collection-log'}>
          {admin && AdminEntry ? (
            <AdminEntry
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
              path={route.path}
              onNavigate={navigate}
              takeEntry={resources.takeEntry}
            />
          ) : (
            <>
              <LiveLog
                hardcore={hardcore}
                copy={copy}
                competitionClient={competitionClient}
              />
              <XpPage client={xpClient} admin={false} copy={copy} />
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
                <image href="/brand/ko-fi-blue.png" width="980" height="198" />
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
