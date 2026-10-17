/** Shared API clients and prepared staff entry data. */
import type { AdminClient } from './admin-model.ts';
import type { XpClient } from './xp-model.ts';
import type { CompetitionClient } from './competition-api.ts';
import type { AdminAccess } from './admin-session.ts';
import type { PreparedAdminData } from './admin-route-data.ts';
import type { AdminEntry } from './admin-entry.tsx';

export interface AppRuntime {
  admin: AdminClient;
  xp: XpClient;
  competition: CompetitionClient;
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
