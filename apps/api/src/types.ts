/** Backend contracts isolate PostgreSQL and Discord from route tests. */
export interface Settings {
  revision: string;
  hardcoreEnabled: boolean;
}
export interface CatalogData {
  items: { id: number; name: string; iconPath: string }[];
  pages: { id: string; name: string; category: string; itemIds: number[] }[];
}
export interface PublicCredit {
  submissionId: string;
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
}
export interface AdminIdentity {
  id: string;
  displayName: string;
}
export interface StoredSession extends AdminIdentity {
  expiresAt: Date;
}
export interface BackendStore {
  ready(): Promise<void>;
  catalog(): Promise<CatalogData>;
  collections(): Promise<PublicCredit[]>;
  settings(): Promise<Settings>;
  saveSettings(
    enabled: boolean,
    revision: string,
    actor: string,
  ): Promise<Settings | null>;
  createState(hash: string, expiresAt: Date): Promise<void>;
  consumeState(hash: string): Promise<boolean>;
  createSession(
    hash: string,
    identity: AdminIdentity,
    expiresAt: Date,
  ): Promise<void>;
  session(hash: string): Promise<StoredSession | null>;
  deleteSession(hash: string): Promise<void>;
  allowLogin(keyHash: string): Promise<boolean>;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
