/** Shared live capabilities; preview implementation is available only through its entry chunk. */
import type { AdminClient } from './admin-model.ts';
import type { XpClient } from './xp-model.ts';
import type { CompetitionClient } from './competition-api.ts';
import type { SiteSettings } from './site-settings.ts';
import type { Branding } from './branding.ts';
import type { ComponentType } from 'react';
import type { CollectionLog } from './CollectionLog.tsx';
import type { AdminAccess } from './admin-session.ts';
import type { PreparedAdminData } from './admin-route-data.ts';
import type { AdminEntry } from './admin-entry.tsx';

export interface PreviewRuntime {
  subscribe: (listener: () => void) => () => void;
  getRevision: () => number;
  settings: () => SiteSettings;
  branding: (hardcore: boolean) => Branding;
  Log: ComponentType<
    Required<
      Pick<React.ComponentProps<typeof CollectionLog>, 'hardcore' | 'copy'>
    >
  >;
  xpControls: { samples: () => Promise<void>; advance: () => void };
}
export interface AppRuntime {
  admin: AdminClient;
  xp: XpClient;
  competition: CompetitionClient;
  preview?: PreviewRuntime;
  dispose?: () => void;
}
export interface PreparedAdminEntry {
  access: AdminAccess;
  error?: string;
  preparation?: {
    path: string;
    result: Promise<{ data: PreparedAdminData } | { error: unknown }>;
    cancel: () => void;
  };
}
export interface RouteResources {
  runtime: AppRuntime;
  AdminEntry?: typeof AdminEntry;
  takeEntry: () => PreparedAdminEntry | undefined;
}
