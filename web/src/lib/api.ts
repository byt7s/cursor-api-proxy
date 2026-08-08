import type {
  AccountModelsPayload,
  AccountMutationResult,
  AccountsReport,
  AuditPayload,
  ClearLogResult,
  ConfigFilePayload,
  ConfigFileSaveResult,
  ConfigFileValue,
  ControlAction,
  ControlResult,
  DoctorResult,
  LogPayload,
  ProxyConfig,
  ProxyStatus,
  RequestsPayload,
  SessionStats,
} from "./types";

export const DASHBOARD_KEY_STORAGE = "cursor-api-proxy.dashboardKey";

export type ApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "badRequest"
  | "server"
  | "network";

/** Every failure the dashboard surfaces is normalized into this shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(message: string, status: number, kind: ApiErrorKind) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }

  /** True when the failure is fixable by setting a valid dashboard key. */
  get isAuthError(): boolean {
    return this.kind === "unauthorized" || this.kind === "forbidden";
  }
}

function kindFor(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status >= 500) return "server";
  return "badRequest";
}

function messageFor(status: number, serverMessage: string | null): string {
  if (status === 401) {
    return serverMessage
      ? `${serverMessage} — save the dashboard key in Settings.`
      : "Unauthorized: this proxy requires a dashboard key (CURSOR_BRIDGE_DASHBOARD_KEY, an admin-scoped API key, or CURSOR_BRIDGE_API_KEY). Save it in Settings.";
  }
  if (status === 403) {
    return serverMessage
      ? `${serverMessage} — open the dashboard from localhost or set a dashboard key.`
      : "Forbidden: mutating APIs need a dashboard key unless you are on loopback.";
  }
  return serverMessage ?? `Request failed with status ${status}`;
}

export function readDashboardKey(): string {
  try {
    return window.sessionStorage.getItem(DASHBOARD_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function writeDashboardKey(key: string): void {
  try {
    if (key) window.sessionStorage.setItem(DASHBOARD_KEY_STORAGE, key);
    else window.sessionStorage.removeItem(DASHBOARD_KEY_STORAGE);
  } catch {
    /* private mode / storage disabled — key simply is not persisted */
  }
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Fetches a dashboard API endpoint, injecting `Authorization: Bearer` from the
 * session-stored key and normalizing every failure into an `ApiError`.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const key = readDashboardKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(`Network error: ${detail}`, 0, "network");
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const serverMessage =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : text && !parsed
          ? text
          : null;
    throw new ApiError(
      messageFor(response.status, serverMessage),
      response.status,
      kindFor(response.status),
    );
  }

  return parsed as T;
}

/** Endpoints exposed by the admin dashboard server. */
export const api = {
  status: () => apiRequest<ProxyStatus>("/api/status"),
  config: () => apiRequest<ProxyConfig>("/api/config"),
  configFile: () => apiRequest<ConfigFilePayload>("/api/config/file"),
  saveConfigFile: (values: Record<string, ConfigFileValue>) =>
    apiRequest<ConfigFileSaveResult>("/api/config/file", {
      method: "PUT",
      body: { values },
    }),
  stats: (hours = 24) => apiRequest<SessionStats>(`/api/stats?hours=${hours}`),
  log: (lines = 200) => apiRequest<LogPayload>(`/api/log?lines=${lines}`),
  clearLog: () =>
    apiRequest<ClearLogResult>("/api/log/clear", { method: "POST", body: {} }),
  requests: (limit = 40) =>
    apiRequest<RequestsPayload>(`/api/requests?limit=${limit}`),
  audit: (limit = 100) =>
    apiRequest<AuditPayload>(`/api/audit?limit=${limit}`),
  accounts: () => apiRequest<AccountsReport>("/api/accounts"),
  addAccount: (name: string, apiKey: string) =>
    apiRequest<AccountMutationResult>("/api/accounts", {
      method: "POST",
      body: { name, apiKey },
    }),
  setAccountKey: (name: string, apiKey: string) =>
    apiRequest<AccountMutationResult>(
      `/api/accounts/${encodeURIComponent(name)}/key`,
      { method: "PUT", body: { apiKey } },
    ),
  accountModels: (name: string) =>
    apiRequest<AccountModelsPayload>(
      `/api/accounts/${encodeURIComponent(name)}/models`,
    ),
  setAccountModels: (name: string, allowedModels: string[]) =>
    apiRequest<AccountModelsPayload>(
      `/api/accounts/${encodeURIComponent(name)}/models`,
      { method: "PUT", body: { allowedModels } },
    ),
  removeAccount: (name: string) =>
    apiRequest<AccountMutationResult>(
      `/api/accounts/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  doctor: () => apiRequest<DoctorResult>("/api/doctor"),
  resetHwid: (deepClean: boolean) =>
    apiRequest<{ ok: boolean; deepClean: boolean }>("/api/reset-hwid", {
      method: "POST",
      body: { deepClean },
    }),
  control: (action: ControlAction) =>
    apiRequest<ControlResult>("/api/control", {
      method: "POST",
      body: { action },
    }),
  wiki: async (): Promise<string> => {
    const key = readDashboardKey();
    const response = await fetch("/api/wiki", {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!response.ok) {
      throw new ApiError(
        messageFor(response.status, null),
        response.status,
        kindFor(response.status),
      );
    }
    return response.text();
  },
};

/** Human-readable message for anything thrown by the client. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
