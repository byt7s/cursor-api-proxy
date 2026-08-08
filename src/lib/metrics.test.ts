import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./account-pool.js", () => ({
  getAccountStats: vi.fn(() => [
    { configDir: "/tmp/accounts/work", isRateLimited: false, isDisabled: false },
    { configDir: "/tmp/accounts/spare", isRateLimited: true, isDisabled: false },
  ]),
}));

import {
  MAX_LABEL_VALUES,
  accountLabel,
  escapeLabelValue,
  incFailover,
  incRateLimited,
  normalizeRoute,
  observeRequest,
  renderMetrics,
  resetMetricsForTests,
} from "./metrics.js";

function render(): string {
  return renderMetrics({ version: "9.9.9", nodeVersion: "v22.0.0" });
}

/** Series lines for one metric name, ignoring `# HELP` / `# TYPE`. */
function samples(body: string, metric: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith(metric) && !line.startsWith("#"));
}

beforeEach(() => {
  resetMetricsForTests();
});

describe("normalizeRoute", () => {
  it("keeps known routes and collapses the rest", () => {
    expect(normalizeRoute("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeRoute("/healthz")).toBe("/healthz");
    expect(normalizeRoute("/api/requests?limit=40")).toBe("/api/*");
    expect(normalizeRoute("/static/dashboard/assets/index-abc.js")).toBe(
      "/static/*",
    );
    expect(normalizeRoute("/v1/chat/completions/../../etc/passwd")).toBe(
      "other",
    );
    expect(normalizeRoute(undefined)).toBe("other");
  });
});

describe("accountLabel", () => {
  it("reduces a config dir to its basename", () => {
    expect(accountLabel("/Users/me/.cursor-api-proxy/accounts/work")).toBe(
      "work",
    );
    expect(accountLabel(undefined)).toBe("unknown");
  });
});

describe("escapeLabelValue", () => {
  it("escapes backslashes, quotes and newlines", () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it("escapes label values in rendered output", () => {
    observeRequest({
      route: "/v1/chat/completions",
      status: 200,
      model: 'claude"4\\opus',
      engine: "acp",
      durationMs: 100,
    });
    const line = samples(render(), "cursor_proxy_requests_total")[0]!;
    expect(line).toContain('model="claude\\"4\\\\opus"');
  });
});

describe("renderMetrics", () => {
  it("always exposes build info and admission gauges", () => {
    const body = render();
    expect(body).toContain(
      "# HELP cursor_proxy_build_info Build metadata of the running proxy (always 1).",
    );
    expect(body).toContain("# TYPE cursor_proxy_build_info gauge");
    expect(body).toContain(
      'cursor_proxy_build_info{version="9.9.9",node="v22.0.0"} 1',
    );
    expect(body).toContain('cursor_proxy_admission_in_use{plane="acp"} 0');
    expect(body).toContain('cursor_proxy_admission_in_use{plane="sdk"} 0');
    expect(body).toContain(
      'cursor_proxy_admission_limit{plane="acp",scope="global"} 16',
    );
    expect(body).toContain(
      'cursor_proxy_admission_limit{plane="sdk",scope="per_account"} 12',
    );
    expect(body.endsWith("\n")).toBe(true);
  });

  it("omits metrics that have no series yet", () => {
    const body = render();
    expect(body).not.toContain("cursor_proxy_requests_total");
    expect(body).not.toContain("cursor_proxy_request_duration_seconds");
    expect(body).not.toContain("cursor_proxy_failover_total");
  });

  it("reports account state as one series per state", () => {
    const body = render();
    expect(body).toContain("# TYPE cursor_proxy_account_state gauge");
    expect(body).toContain(
      'cursor_proxy_account_state{account="work",state="usable"} 1',
    );
    expect(body).toContain(
      'cursor_proxy_account_state{account="work",state="rate_limited"} 0',
    );
    expect(body).toContain(
      'cursor_proxy_account_state{account="spare",state="rate_limited"} 1',
    );
    expect(body).toContain(
      'cursor_proxy_account_state{account="spare",state="usable"} 0',
    );
  });
});

describe("observeRequest", () => {
  it("accumulates one counter series per label set", () => {
    for (let i = 0; i < 3; i++) {
      observeRequest({
        route: "/v1/chat/completions",
        status: 200,
        model: "auto",
        engine: "acp",
        account: "work",
        durationMs: 1500,
      });
    }
    observeRequest({
      route: "/v1/chat/completions",
      status: 503,
      model: "auto",
      engine: "acp",
      account: "work",
      durationMs: 20,
    });

    const body = render();
    expect(body).toContain("# TYPE cursor_proxy_requests_total counter");
    expect(body).toContain(
      'cursor_proxy_requests_total{route="/v1/chat/completions",status="200",model="auto",engine="acp",account="work"} 3',
    );
    expect(body).toContain(
      'cursor_proxy_requests_total{route="/v1/chat/completions",status="503",model="auto",engine="acp",account="work"} 1',
    );
  });

  it("renders the duration histogram in seconds with cumulative buckets", () => {
    observeRequest({
      route: "/v1/chat/completions",
      status: 200,
      engine: "sdk",
      durationMs: 1500,
    });
    observeRequest({
      route: "/v1/chat/completions",
      status: 200,
      engine: "sdk",
      durationMs: 300,
    });

    const body = render();
    const labels = 'route="/v1/chat/completions",engine="sdk"';
    expect(body).toContain("# TYPE cursor_proxy_request_duration_seconds histogram");
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_bucket{${labels},le="0.25"} 0`,
    );
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_bucket{${labels},le="0.5"} 1`,
    );
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_bucket{${labels},le="2"} 2`,
    );
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_bucket{${labels},le="+Inf"} 2`,
    );
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_sum{${labels}} 1.8`,
    );
    expect(body).toContain(
      `cursor_proxy_request_duration_seconds_count{${labels}} 2`,
    );
  });

  it("records one span histogram per waterfall span", () => {
    observeRequest({
      route: "/v1/chat/completions",
      status: 200,
      engine: "acp",
      durationMs: 900,
      spans: { account_select: 5, model_first_byte: 400, total: 900 },
    });

    const body = render();
    expect(body).toContain("# TYPE cursor_proxy_span_duration_seconds histogram");
    expect(body).toContain(
      'cursor_proxy_span_duration_seconds_count{span="account_select",engine="acp"} 1',
    );
    expect(body).toContain(
      'cursor_proxy_span_duration_seconds_sum{span="model_first_byte",engine="acp"} 0.4',
    );
    expect(body).toContain(
      'cursor_proxy_span_duration_seconds_count{span="total",engine="acp"} 1',
    );
  });

  it("labels missing model, engine and account as unknown", () => {
    observeRequest({ route: "/v1/models", status: 200, durationMs: 10 });
    expect(samples(render(), "cursor_proxy_requests_total")[0]).toBe(
      'cursor_proxy_requests_total{route="/v1/models",status="200",model="unknown",engine="unknown",account="unknown"} 1',
    );
  });

  it("caps model and account cardinality at MAX_LABEL_VALUES", () => {
    for (let i = 0; i < MAX_LABEL_VALUES + 5; i++) {
      observeRequest({
        route: "/v1/chat/completions",
        status: 200,
        model: `model-${i}`,
        engine: "acp",
        account: `acc-${i}`,
        durationMs: 10,
      });
    }

    const lines = samples(render(), "cursor_proxy_requests_total");
    // MAX_LABEL_VALUES distinct series plus a single collapsed `other` series.
    expect(lines).toHaveLength(MAX_LABEL_VALUES + 1);
    const collapsed = lines.filter((line) =>
      line.includes('model="other",engine="acp",account="other"'),
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("} 5");
  });
});

describe("failover and rate-limit counters", () => {
  it("counts failovers by reason", () => {
    incFailover("rate_limited");
    incFailover("rate_limited");
    incFailover("agent_capacity");

    const body = render();
    expect(body).toContain("# TYPE cursor_proxy_failover_total counter");
    expect(body).toContain('cursor_proxy_failover_total{reason="rate_limited"} 2');
    expect(body).toContain(
      'cursor_proxy_failover_total{reason="agent_capacity"} 1',
    );
  });

  it("counts rate limits per account basename", () => {
    incRateLimited("/Users/me/.cursor-api-proxy/accounts/work");
    incRateLimited("/Users/me/.cursor-api-proxy/accounts/work");
    incRateLimited(undefined);

    const body = render();
    expect(body).toContain('cursor_proxy_rate_limited_total{account="work"} 2');
    expect(body).toContain(
      'cursor_proxy_rate_limited_total{account="unknown"} 1',
    );
  });
});

describe("resetMetricsForTests", () => {
  it("drops all series and the cardinality bookkeeping", () => {
    observeRequest({
      route: "/v1/chat/completions",
      status: 200,
      model: "auto",
      engine: "acp",
      durationMs: 10,
    });
    incFailover("rate_limited");
    expect(render()).toContain("cursor_proxy_requests_total");

    resetMetricsForTests();
    const body = render();
    expect(body).not.toContain("cursor_proxy_requests_total");
    expect(body).not.toContain("cursor_proxy_failover_total");
    expect(body).toContain("cursor_proxy_build_info");
  });
});
