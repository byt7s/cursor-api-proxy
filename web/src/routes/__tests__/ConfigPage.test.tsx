import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch, type RouteTable } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { ConfigPage } from "../ConfigPage";

const CONFIG = {
  host: "127.0.0.1",
  port: 8765,
  defaultModel: "auto",
  workspace: "/tmp/ws",
  agentBin: "cursor-agent",
  useAcp: true,
  requiredKey: false,
  tlsEnabled: false,
  maxConcurrentRuns: 16,
  maxConcurrentRunsPerAccount: 2,
  sdkMaxConcurrentRuns: 48,
  sdkMaxConcurrentRunsPerAccount: 12,
  admissionWaitMs: 0,
  configDirsCount: 2,
  requestsLogPath: "/tmp/requests.jsonl",
  requestsLogEnabled: true,
  requestsLogMaxBytes: 33_554_432,
  metricsEnabled: true,
  apiKeys: [],
  dashboardKeyConfigured: true,
  keyRateLimitPerMin: 0,
  auditLogPath: "/tmp/audit.jsonl",
  auditLogEnabled: true,
  maxBodyBytes: 8 * 1024 * 1024,
  corsOrigins: [],
  caller: { actor: "loopback" },
};

const KEYS = [
  {
    key: "port",
    env: "CURSOR_BRIDGE_PORT",
    type: "number",
    group: "Server",
    label: "Port",
    editable: true,
  },
  {
    key: "tlsCertPath",
    env: "CURSOR_BRIDGE_TLS_CERT",
    type: "string",
    group: "Server",
    label: "TLS certificate",
    editable: false,
  },
  {
    key: "defaultModel",
    env: "CURSOR_BRIDGE_DEFAULT_MODEL",
    type: "string",
    group: "Models",
    label: "Default model",
    editable: true,
  },
  {
    key: "mode",
    env: "CURSOR_BRIDGE_MODE",
    type: "enum",
    values: ["agent", "ask", "plan"],
    group: "Models",
    label: "Default mode",
    editable: true,
  },
  {
    key: "toolCalls",
    env: "CURSOR_BRIDGE_TOOL_CALLS",
    type: "boolean",
    group: "Models",
    label: "Bridge tool calls",
    editable: true,
  },
];

const FILE = {
  path: "/home/me/.cursor-api-proxy/config.json",
  exists: true,
  values: { defaultModel: "gpt-5" },
  warnings: [],
  sources: {
    port: "env",
    tlsCertPath: "default",
    defaultModel: "file",
    mode: "default",
    toolCalls: "default",
  },
  effective: {
    port: 8765,
    tlsCertPath: "",
    defaultModel: "gpt-5",
    mode: "ask",
    toolCalls: false,
  },
  keys: KEYS,
  refusedKeys: ["apiKey", "dashboardKey"],
};

function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/config": { body: CONFIG },
    "GET /api/config/file": { body: FILE },
    ...extra,
  };
}

describe("ConfigPage", () => {
  it("groups the sanitized runtime config into sections", async () => {
    mockFetch(routes());
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Admission — ACP plane")).toBeVisible();
    expect(screen.getByText("Admission — SDK plane")).toBeVisible();
    expect(screen.getByText("cursor-agent")).toBeVisible();
    expect(screen.getByText("/tmp/requests.jsonl")).toBeVisible();
    expect(screen.getByText("32 MB")).toBeVisible();
  });

  it("shows the config file path and which credentials it refuses", async () => {
    mockFetch(routes());
    renderWithProviders(<ConfigPage />);

    expect(
      await screen.findByText("/home/me/.cursor-api-proxy/config.json"),
    ).toBeVisible();
    expect(screen.getByText(/apiKey, dashboardKey/)).toBeVisible();
  });

  it("labels each field with the source of its effective value", async () => {
    mockFetch(routes());
    renderWithProviders(<ConfigPage />);

    await screen.findByText("Server — config file");
    expect(screen.getByText("env")).toBeVisible();
    expect(screen.getByText("file")).toBeVisible();
    // `default` appears for several keys, so assert on the count, not identity.
    expect(screen.getAllByText("default").length).toBeGreaterThan(0);
  });

  it("locks fields an environment variable or policy already decides", async () => {
    mockFetch(routes());
    renderWithProviders(<ConfigPage />);

    await screen.findByText("Server — config file");
    // `port` comes from the environment and `tlsCertPath` is never writable.
    expect(screen.getAllByText("locked").length).toBe(2);

    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toBeDisabled();
  });

  it("saves the edited file and surfaces the restart notice", async () => {
    const fetchMock = mockFetch(
      routes({
        "PUT /api/config/file": {
          body: {
            ...FILE,
            ok: true,
            values: { defaultModel: "gpt-6" },
            written: ["defaultModel"],
            restartRequired: ["defaultModel"],
            noEffect: [],
            warnings: [],
          },
        },
      }),
    );
    renderWithProviders(<ConfigPage />);

    await screen.findByText("Models — config file");
    const model = screen.getByDisplayValue("gpt-5");
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-6");
    await userEvent.click(screen.getByRole("button", { name: "Save config file" }));

    expect(await screen.findByText("Restart required")).toBeVisible();
    expect(
      screen.getByText(/take effect after a restart: defaultModel/),
    ).toBeVisible();

    const put = fetchMock.calls.find((call) => call.method === "PUT");
    expect(put?.body).toEqual({ values: { defaultModel: "gpt-6" } });
  });

  it("reports a rejected key without pretending the write succeeded", async () => {
    mockFetch(
      routes({
        "PUT /api/config/file": {
          status: 400,
          body: {
            error: 'config file key "apiKey" is not allowed',
            key: "apiKey",
          },
        },
      }),
    );
    renderWithProviders(<ConfigPage />);

    await screen.findByText("Models — config file");
    const model = screen.getByDisplayValue("gpt-5");
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-6");
    await userEvent.click(screen.getByRole("button", { name: "Save config file" }));

    // The banner and the toast both say it, so assert on the reason instead.
    expect(
      (await screen.findAllByText("Could not save the config file")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/"apiKey" is not allowed/)).toBeVisible();
  });

  it("surfaces unknown-key warnings from the loaded file", async () => {
    mockFetch(
      routes({
        "GET /api/config/file": {
          body: {
            ...FILE,
            warnings: ['config file: ignoring unknown key "nonsense"'],
          },
        },
      }),
    );
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Config file warnings")).toBeVisible();
    expect(screen.getByText(/unknown key "nonsense"/)).toBeVisible();
  });

  it("keeps Save disabled until something is edited", async () => {
    mockFetch(routes());
    renderWithProviders(<ConfigPage />);

    const save = await screen.findByRole("button", { name: "Save config file" });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(save).toBeEnabled());
  });
});
