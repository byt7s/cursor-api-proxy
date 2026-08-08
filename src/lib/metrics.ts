/**
 * In-process Prometheus registry (text exposition format 0.0.4).
 *
 * Hand-rolled on purpose: the proxy ships no metrics dependency, and the
 * surface is small — a few counters, two histograms, and gauges collected at
 * scrape time from admission and the account pool.
 *
 * Label cardinality is capped: `model` and `account` fall back to `other`
 * after `MAX_LABEL_VALUES` distinct values, and unknown routes collapse to
 * `other`, so a hostile client cannot grow the registry without bound.
 */

import * as path from "node:path";

import { getAccountStats } from "./account-pool.js";
import { getAdmissionConfig, getAdmissionSnapshot } from "./admission.js";
import type { LatencySpanName } from "./latency-waterfall.js";

export const METRICS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

/** Distinct values kept per capped label before collapsing to `other`. */
export const MAX_LABEL_VALUES = 40;

const OTHER = "other";
const UNKNOWN = "unknown";

const KNOWN_ROUTES = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/models",
  "/health",
  "/healthz",
  "/accounts",
  "/metrics",
]);

const DURATION_BUCKETS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300,
];

const SPAN_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

export type MetricLabels = Record<string, string>;

type HistogramSeries = {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
};

type Registry = {
  requestsTotal: Map<string, { labels: MetricLabels; value: number }>;
  requestDuration: Map<string, HistogramSeries>;
  spanDuration: Map<string, HistogramSeries>;
  failoverTotal: Map<string, { labels: MetricLabels; value: number }>;
  rateLimitedTotal: Map<string, { labels: MetricLabels; value: number }>;
  /** Bounded sets backing the cardinality caps. */
  seenModels: Set<string>;
  seenAccounts: Set<string>;
};

function emptyRegistry(): Registry {
  return {
    requestsTotal: new Map(),
    requestDuration: new Map(),
    spanDuration: new Map(),
    failoverTotal: new Map(),
    rateLimitedTotal: new Map(),
    seenModels: new Set(),
    seenAccounts: new Set(),
  };
}

let registry = emptyRegistry();

export function resetMetricsForTests(): void {
  registry = emptyRegistry();
}

function seriesKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(",");
}

function bumpCounter(
  target: Map<string, { labels: MetricLabels; value: number }>,
  labels: MetricLabels,
  delta = 1,
): void {
  const key = seriesKey(labels);
  const existing = target.get(key);
  if (existing) existing.value += delta;
  else target.set(key, { labels, value: delta });
}

function observeHistogram(
  target: Map<string, HistogramSeries>,
  buckets: number[],
  labels: MetricLabels,
  value: number,
): void {
  if (!Number.isFinite(value) || value < 0) return;
  const key = seriesKey(labels);
  let series = target.get(key);
  if (!series) {
    series = {
      labels,
      counts: new Array(buckets.length + 1).fill(0),
      sum: 0,
      count: 0,
    };
    target.set(key, series);
  }
  series.sum += value;
  series.count += 1;
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]!) series.counts[i]! += 1;
  }
  series.counts[buckets.length]! += 1;
}

/** Keeps a label bounded: known values pass through, the rest become `other`. */
function capped(seen: Set<string>, raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return UNKNOWN;
  if (seen.has(value)) return value;
  if (seen.size >= MAX_LABEL_VALUES) return OTHER;
  seen.add(value);
  return value;
}

export function normalizeRoute(pathname: string | undefined): string {
  const value = (pathname ?? "").split("?")[0] ?? "";
  if (KNOWN_ROUTES.has(value)) return value;
  if (value.startsWith("/api/")) return "/api/*";
  if (value.startsWith("/static/")) return "/static/*";
  return OTHER;
}

/** Account label is the directory basename, never the full path. */
export function accountLabel(configDirOrName: string | undefined): string {
  if (!configDirOrName) return UNKNOWN;
  return path.basename(configDirOrName);
}

export type RequestObservation = {
  route: string;
  status: number;
  model?: string;
  engine?: string;
  account?: string;
  durationMs: number;
  spans?: Partial<Record<LatencySpanName, number>>;
};

export function observeRequest(observation: RequestObservation): void {
  const route = normalizeRoute(observation.route);
  const engine = observation.engine ?? UNKNOWN;
  const model = capped(registry.seenModels, observation.model);
  const account = capped(registry.seenAccounts, observation.account);

  bumpCounter(registry.requestsTotal, {
    route,
    status: String(observation.status),
    model,
    engine,
    account,
  });

  // Duration keeps only the low-cardinality labels: one histogram per
  // (route, engine) instead of per model/account/status combination.
  observeHistogram(
    registry.requestDuration,
    DURATION_BUCKETS,
    { route, engine },
    observation.durationMs / 1000,
  );

  for (const [span, ms] of Object.entries(observation.spans ?? {})) {
    if (typeof ms !== "number") continue;
    observeHistogram(
      registry.spanDuration,
      SPAN_BUCKETS,
      { span, engine },
      ms / 1000,
    );
  }
}

export function incFailover(reason: string): void {
  bumpCounter(registry.failoverTotal, { reason: reason || UNKNOWN });
}

export function incRateLimited(configDir: string | undefined): void {
  bumpCounter(registry.rateLimitedTotal, {
    account: capped(registry.seenAccounts, accountLabel(configDir)),
  });
}

export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const body = entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${body}}`;
}

function renderNumber(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

type Line = string;

function metricHeader(name: string, help: string, type: string): Line[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
}

function renderCounter(
  name: string,
  help: string,
  series: Map<string, { labels: MetricLabels; value: number }>,
): Line[] {
  if (series.size === 0) return [];
  const lines = metricHeader(name, help, "counter");
  for (const { labels, value } of series.values()) {
    lines.push(`${name}${renderLabels(labels)} ${renderNumber(value)}`);
  }
  return lines;
}

function renderHistogram(
  name: string,
  help: string,
  buckets: number[],
  series: Map<string, HistogramSeries>,
): Line[] {
  if (series.size === 0) return [];
  const lines = metricHeader(name, help, "histogram");
  for (const entry of series.values()) {
    for (let i = 0; i < buckets.length; i++) {
      const labels = { ...entry.labels, le: renderNumber(buckets[i]!) };
      lines.push(
        `${name}_bucket${renderLabels(labels)} ${renderNumber(entry.counts[i]!)}`,
      );
    }
    lines.push(
      `${name}_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${renderNumber(entry.count)}`,
    );
    lines.push(`${name}_sum${renderLabels(entry.labels)} ${renderNumber(entry.sum)}`);
    lines.push(
      `${name}_count${renderLabels(entry.labels)} ${renderNumber(entry.count)}`,
    );
  }
  return lines;
}

function renderGauge(
  name: string,
  help: string,
  samples: Array<{ labels: MetricLabels; value: number }>,
): Line[] {
  if (samples.length === 0) return [];
  const lines = metricHeader(name, help, "gauge");
  for (const { labels, value } of samples) {
    lines.push(`${name}${renderLabels(labels)} ${renderNumber(value)}`);
  }
  return lines;
}

const ACCOUNT_STATES = ["usable", "rate_limited", "disabled"] as const;

function accountStateSamples(): Array<{
  labels: MetricLabels;
  value: number;
}> {
  // Keyed by label set: past the cardinality cap several accounts share the
  // `other` label, and Prometheus rejects duplicate series.
  const samples = new Map<string, { labels: MetricLabels; value: number }>();
  for (const stat of getAccountStats()) {
    const account = capped(
      registry.seenAccounts,
      accountLabel(stat.configDir),
    );
    const current = stat.isDisabled
      ? "disabled"
      : stat.isRateLimited
        ? "rate_limited"
        : "usable";
    for (const state of ACCOUNT_STATES) {
      const labels = { account, state };
      const value = state === current ? 1 : 0;
      const existing = samples.get(seriesKey(labels));
      if (existing) existing.value = Math.max(existing.value, value);
      else samples.set(seriesKey(labels), { labels, value });
    }
  }
  return [...samples.values()];
}

function admissionSamples(): {
  inUse: Array<{ labels: MetricLabels; value: number }>;
  limit: Array<{ labels: MetricLabels; value: number }>;
} {
  const snapshot = getAdmissionSnapshot();
  const config = getAdmissionConfig();
  return {
    inUse: [
      { labels: { plane: "acp" }, value: snapshot.acp.globalInUse },
      { labels: { plane: "sdk" }, value: snapshot.sdk.globalInUse },
    ],
    limit: [
      {
        labels: { plane: "acp", scope: "global" },
        value: config.acp.maxConcurrentRuns,
      },
      {
        labels: { plane: "acp", scope: "per_account" },
        value: config.acp.maxConcurrentRunsPerAccount,
      },
      {
        labels: { plane: "sdk", scope: "global" },
        value: config.sdk.maxConcurrentRuns,
      },
      {
        labels: { plane: "sdk", scope: "per_account" },
        value: config.sdk.maxConcurrentRunsPerAccount,
      },
    ],
  };
}

export type RenderMetricsOptions = {
  /** Proxy version for `cursor_proxy_build_info`. */
  version: string;
  /** Defaults to the running Node version. */
  nodeVersion?: string;
};

/** Renders the whole registry, collecting live gauges at scrape time. */
export function renderMetrics(options: RenderMetricsOptions): string {
  const admission = admissionSamples();
  const lines: Line[] = [
    ...renderGauge(
      "cursor_proxy_build_info",
      "Build metadata of the running proxy (always 1).",
      [
        {
          labels: {
            version: options.version,
            node: options.nodeVersion ?? process.version,
          },
          value: 1,
        },
      ],
    ),
    ...renderCounter(
      "cursor_proxy_requests_total",
      "Proxied requests by route, status, model, engine and account.",
      registry.requestsTotal,
    ),
    ...renderHistogram(
      "cursor_proxy_request_duration_seconds",
      "End-to-end proxied request duration in seconds.",
      DURATION_BUCKETS,
      registry.requestDuration,
    ),
    ...renderHistogram(
      "cursor_proxy_span_duration_seconds",
      "Latency waterfall span duration in seconds.",
      SPAN_BUCKETS,
      registry.spanDuration,
    ),
    ...renderGauge(
      "cursor_proxy_admission_in_use",
      "Agent run permits currently held per admission plane.",
      admission.inUse,
    ),
    ...renderGauge(
      "cursor_proxy_admission_limit",
      "Configured admission limits per plane and scope.",
      admission.limit,
    ),
    ...renderGauge(
      "cursor_proxy_account_state",
      "Account availability (1 for the current state, 0 otherwise).",
      accountStateSamples(),
    ),
    ...renderCounter(
      "cursor_proxy_failover_total",
      "Account failovers by reason.",
      registry.failoverTotal,
    ),
    ...renderCounter(
      "cursor_proxy_rate_limited_total",
      "Rate-limit responses observed per account.",
      registry.rateLimitedTotal,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
