/** Backend contracts isolate PostgreSQL and Discord from route tests. */
export interface Settings {
  copy?: import('@clog/domain').SiteCopy;
  hardcore?: import('@clog/domain').HardcoreAppearance;
  clanName: string;
  revision: string;
  hardcoreEnabled: boolean;
}
export interface CatalogData {
  catalogVersion?: string;
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
  accountVersion?: number;
}
export interface StaffAccount {
  disabled?: boolean;
  version?: number;
  id: string;
  username: string;
  role: 'admin' | 'moderator';
  mustChangePassword: boolean;
}
export interface StoredAccount extends StaffAccount {
  passwordHash: string;
  credentialVersion: number;
}
export interface AccountSessionIdentity extends AdminIdentity {
  accountVersion: number;
}
export interface StoredSession extends AccountSessionIdentity {
  expiresAt: Date;
}
export interface BotSubmissionInput {
  interactionId: string;
  guildId: string;
  actorDiscordId: string;
  rawItemText: string;
  itemId?: number;
  collectorName: string;
  proofUrl: string;
  hardcore: boolean;
}
export interface BotReceipt {
  submissionId: string;
  interactionId: string;
  status: 'pending';
  submittedAt: string;
  collectedOn: string;
  dateSource: 'collector' | 'submission_default';
  hardcore: boolean;
  resolution: 'resolved' | 'needs_match';
  itemId: number | null;
  candidates: { id: number; name: string }[];
  creditOccupied: boolean;
}
export interface BackendStore {
  publicSnapshot?(
    resource: 'catalog' | 'collections',
  ): Promise<{ revision: string; body: string }>;
  manageModerator?(
    id: string,
    expectedVersion: number,
    action: 'disable' | 'enable' | 'delete',
    actor: string,
  ): Promise<StaffAccount>;
  /** Preserve an existing administrator; a fresh database requires an explicit verifier. */
  ensureDefaultAdmin(bootstrapPasswordHash?: string): Promise<void>;
  accountByUsername(username: string): Promise<StoredAccount | null>;
  accountById(id: string): Promise<StoredAccount | null>;
  accounts(): Promise<StaffAccount[]>;
  createModerator(
    username: string,
    passwordHash: string,
    actor: string,
  ): Promise<StaffAccount>;
  updateAccount(
    id: string,
    expectedVersion: number,
    username: string,
    passwordHash?: string,
  ): Promise<StoredAccount>;
  botItems(
    query: string,
    limit: number,
  ): Promise<{ id: number; name: string }[]>;
  submitClaim(
    input: BotSubmissionInput,
    payloadHash: string,
  ): Promise<{ created: boolean; receipt: BotReceipt }>;
  ready(): Promise<void>;
  catalog(): Promise<CatalogData>;
  collections(): Promise<PublicCredit[]>;
  settings(): Promise<Settings>;
  saveSettings(
    enabled: boolean,
    revision: string,
    actor: string,
    clanName?: string,
    copy?: import('@clog/domain').SiteCopy,
    hardcore?: import('@clog/domain').HardcoreAppearance,
  ): Promise<Settings | null>;
  createState(hash: string, expiresAt: Date): Promise<void>;
  consumeState(hash: string): Promise<boolean>;
  createSession(
    hash: string,
    identity: AccountSessionIdentity,
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
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
