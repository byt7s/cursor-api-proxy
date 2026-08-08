/**
 * Response shapes served by `src/lib/admin-dashboard.ts`. Kept structurally in
 * sync with the server types (`AccountsReport`, `DoctorResult`, `SessionStats`,
 * `SessionRequest`) — the dashboard is bundled from this repo, so drift shows up
 * in `pnpm typecheck` on either side.
 */

export type ProxyStatus = {
  running: boolean;
  pid: number | null;
  port: number;
  host: string;
  version: string;
  uptimeSeconds: number;
  launchdLoaded: boolean;
  plistPath: string;
  packageRoot: string;
  publicDir: string;
  docsDir: string;
  storageDir: string;
  sessionsLogPath: string;
  serviceLog: string;
  pidFile: string;
  apiKeyConfigured: boolean;
  bridgeApiKeyRequired: boolean;
  node: string;
  platform: string;
  startedAt: string;
};

export type ProxyConfig = {
  agentBin: string;
  useAcp: boolean;
  host: string;
  port: number;
  defaultModel: string;
  mode: string;
  force: boolean;
  approveMcps: boolean;
  strictModel: boolean;
  workspace: string;
  timeoutMs: number;
  sessionsLogPath: string;
  chatOnlyWorkspace: boolean;
  verbose: boolean;
  maxMode: boolean;
  requiredKey: boolean;
  tlsEnabled: boolean;
  configDirsCount: number;
  multiPort: boolean;
  contextPreamble: boolean;
  bridgePackageVersion: string;
  maxConcurrentRuns: number;
  maxConcurrentRunsPerAccount: number;
  sdkMaxConcurrentRuns: number;
  sdkMaxConcurrentRunsPerAccount: number;
  admissionWaitMs: number;
  contextExtraConfigured: boolean;
};

export type AccountUsageModel = {
  id: string;
  numRequests?: number;
  maxRequestUsage?: number | null;
  numTokens?: number;
};

export type AccountReport = {
  name: string;
  configDir: string;
  authenticated: boolean;
  authMethod: "cli" | "api-key" | null;
  hasApiKey: boolean;
  email: string | null;
  displayName: string | null;
  apiKeyName: string | null;
  apiKeyCreatedAt: string | null;
  plan: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  expiresAt: string | null;
  usage: { startOfMonth: string | null; models: AccountUsageModel[] } | null;
  usageError: string | null;
};

export type AccountsReport = { accounts: AccountReport[] };

export type DoctorCheck = { name: string; ok: boolean; detail: string };
export type DoctorResult = { ok: boolean; checks: DoctorCheck[] };

export type SessionRequest = {
  ts: string;
  method: string;
  pathname: string;
  status: number;
};

export type SessionStats = {
  windowHours: number;
  total: number;
  errors: number;
  byPath: Record<string, number>;
  recent: SessionRequest[];
};

export type LogPayload = { path: string; lines: string[] };
export type RequestsPayload = { path: string; requests: SessionRequest[] };
export type ClearLogResult = { archivePath: string };
export type ControlAction =
  | "start"
  | "stop"
  | "restart"
  | "enable"
  | "disable";
export type ControlResult = {
  ok: boolean;
  action: ControlAction;
  scheduled: boolean;
};
export type AccountMutationResult = {
  ok?: boolean;
  name: string;
  configDir?: string;
};
