/** Structural route contracts: explicit domain operations, no pool or owner CLI access. */
import type { PgCatalogStore } from './catalog-store.js';
import type { PgLifecycleStore } from '@clog/database/dist/lifecycle.js';
import type { BackendStore } from './types.js';
import type { ReviewStore } from './review-types.js';
import type { XpStore } from './xp-types.js';
import type { IconStorage } from './icon-storage.js';
import type { ProofStorage } from './proof-storage.js';
import type { BrandingStorage } from './branding-storage.js';
import type {
  CompetitionPreview,
  CompetitionReceipt,
  CompetitionSnapshot,
} from './competition-types.js';
import type { WomCompetition } from '@clog/domain';

export interface CompetitionService {
  clock(): Promise<number>;
  activities(): Promise<{ serverNow: string; competitions: WomCompetition[] }>;
  activitySnapshot?(): Promise<{
    revision: string;
    serverNow: string;
    body: string;
  }>;
  preview(
    snapshot: CompetitionSnapshot,
    actor: string,
    pageIds?: string[],
  ): Promise<CompetitionPreview>;
  apply(
    token: string,
    revision: string,
    scheduleRevision: string,
    key: string,
    actor: string,
    actorName: string,
    role: 'admin' | 'moderator',
    acknowledgeCorrections: boolean,
  ): Promise<CompetitionReceipt>;
}
export type CatalogRouteStore = Pick<
  PgCatalogStore,
  | 'asset'
  | 'stage'
  | 'createPage'
  | 'removePage'
  | 'reorderPages'
  | 'create'
  | 'removePageItem'
  | 'reorder'
  | 'reconcile'
>;
export type CatalogService = CatalogRouteStore &
  Pick<PgCatalogStore, 'catalog'>;
export type LifecycleReader = Pick<PgLifecycleStore, 'list' | 'detail'>;
export type ReviewRouteStore = Pick<
  ReviewStore,
  | 'createManual'
  | 'queue'
  | 'detail'
  | 'mutate'
  | 'submissionFilters'
  | 'saveSubmissionFilters'
>;
export type ManualReviewStore = Pick<ReviewStore, 'createManual'>;
export type XpPublicStore = Pick<XpStore, 'tracker' | 'trackerSnapshot'>;
export type XpAdminStore = Pick<XpStore, 'preview' | 'apply' | 'history'>;
export type BotStore = Pick<BackendStore, 'botItems' | 'submitClaim'>;
export type AuthStore = Pick<
  BackendStore,
  | 'ensureDefaultAdmin'
  | 'session'
  | 'accountById'
  | 'createSession'
  | 'allowLogin'
  | 'accountByUsername'
  | 'deleteSession'
  | 'updateAccount'
  | 'accounts'
  | 'createModerator'
  | 'manageModerator'
  | 'settings'
  | 'saveSettings'
>;
export type ApplicationStore = AuthStore &
  BotStore &
  Pick<BackendStore, 'catalog' | 'collections' | 'publicSnapshot'>;
export type IconFiles = Pick<IconStorage, 'read' | 'save'>;
export type ProofFiles = Pick<ProofStorage, 'read' | 'save'> &
  Partial<Pick<ProofStorage, 'remove'>>;
export type BrandingFiles = Pick<BrandingStorage, 'read' | 'saveLogo'> & {
  favicons: Pick<BrandingStorage['favicons'], 'read'>;
};
