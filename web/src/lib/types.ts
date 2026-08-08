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
  /** True when CURSOR_BRIDGE_DASHBOARD_KEY is set. */
  dashboardKeyRequired?: boolean;
  /** True when any credential guards the dashboard APIs. */
  dashboardKeyProtected?: boolean;
  node: string;
  platform: string;
  startedAt: string;
};

export type ApiKeyScope = "chat" | "admin";

/** Safe projection of an inbound key: never the value, only how to spot it. */
export type ApiKeyDescriptor = {
  label: string;
  scope: ApiKeyScope;
  fingerprint: string;
};

/** Which credential the browser used for the request that returned this. */
export type ConfigCaller = { actor: string; fingerprint?: string };

export type ProxyConfig = {
  apiKeys: ApiKeyDescriptor[];
  dashboardKeyConfigured: boolean;
  keyRateLimitPerMin: number;
  auditLogPath: string;
  auditLogEnabled: boolean;
  maxBodyBytes: number;
  corsOrigins: string[];
  caller: ConfigCaller;
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
  requestsLogPath: string;
  requestsLogEnabled: boolean;
  requestsLogMaxBytes: number;
  metricsEnabled: boolean;
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

export type LatencySpanName =
  | "gateway_queue"
  | "account_select"
  | "spawn"
  | "session_ready"
  | "model_first_byte"
  | "model_complete"
  | "shape_response"
  | "total";

/**
 * Structured record from the JSONL request log (`src/lib/request-record.ts`).
 * Everything past the four text-log fields is optional: the same shape is used
 * when `/api/requests` falls back to parsing `sessions.log`.
 */
export type RequestRecord = SessionRequest & {
  remoteAddress?: string;
  durationMs?: number;
  model?: string;
  engine?: "acp" | "sdk";
  account?: string;
  streaming?: boolean;
  errorCode?: string;
  failoverCount?: number;
  spans?: Partial<Record<LatencySpanName, number>>;
  hasConversation?: boolean;
  conversationHash?: string;
  promptChars?: number;
  completionChars?: number;
};

/** One line of `audit.jsonl` (see `src/lib/audit-log.ts`). */
export type AuditRecord = {
  ts: string;
  action: string;
  method: string;
  route: string;
  actor: string;
  actorFingerprint?: string;
  remoteAddress: string;
  target?: string;
  outcome: "ok" | "error";
  status: number;
  error?: string;
};

export type AuditPayload = {
  path: string;
  enabled: boolean;
  records: AuditRecord[];
};

export type LogPayload = { path: string; lines: string[] };
export type RequestsPayload = {
  path: string;
  /** `jsonl` when served from the structured log, `text` from `sessions.log`. */
  source?: "jsonl" | "text";
  requests: RequestRecord[];
};
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
