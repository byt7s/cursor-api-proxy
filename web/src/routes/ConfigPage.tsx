import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Grid,
  KeyValueList,
  PageHeader,
  Stack,
  type KeyValueItem,
} from "../design-system";
import { useApiResource } from "../hooks";
import { api } from "../lib/api";
import type { ProxyConfig } from "../lib/types";

type Group = {
  title: string;
  description: string;
  items: (config: ProxyConfig) => KeyValueItem[];
};

function bool(value: boolean, onTone: "success" | "warning" = "success") {
  return (
    <Badge tone={value ? onTone : "neutral"}>{value ? "on" : "off"}</Badge>
  );
}

const GROUPS: Group[] = [
  {
    title: "Server",
    description: "Listener and package identity",
    items: (c) => [
      { key: "host", label: "Host", value: c.host, mono: true },
      { key: "port", label: "Port", value: c.port, mono: true },
      { key: "multiPort", label: "Multi-port", value: bool(c.multiPort) },
      { key: "tls", label: "TLS", value: bool(c.tlsEnabled) },
      { key: "timeout", label: "Timeout", value: `${c.timeoutMs} ms` },
      {
        key: "version",
        label: "Package version",
        value: c.bridgePackageVersion,
        mono: true,
      },
      {
        key: "sessionsLog",
        label: "Sessions log",
        value: c.sessionsLogPath,
        mono: true,
      },
    ],
  },
  {
    title: "Models",
    description: "Default model and resolution behaviour",
    items: (c) => [
      { key: "defaultModel", label: "Default model", value: c.defaultModel, mono: true },
      { key: "strictModel", label: "Strict model", value: bool(c.strictModel) },
      { key: "mode", label: "Mode", value: c.mode, mono: true },
      { key: "maxMode", label: "Max mode", value: bool(c.maxMode) },
      { key: "force", label: "Force", value: bool(c.force, "warning") },
    ],
  },
  {
    title: "Workspace",
    description: "Where agent runs are rooted",
    items: (c) => [
      { key: "workspace", label: "Workspace", value: c.workspace, mono: true },
      {
        key: "chatOnly",
        label: "Chat-only workspace",
        value: bool(c.chatOnlyWorkspace),
      },
      { key: "preamble", label: "Context preamble", value: bool(c.contextPreamble) },
      {
        key: "contextExtra",
        label: "Extra context",
        value: bool(c.contextExtraConfigured),
      },
    ],
  },
  {
    title: "Engines",
    description: "Agent binary and execution engine",
    items: (c) => [
      { key: "agentBin", label: "Agent binary", value: c.agentBin, mono: true },
      { key: "useAcp", label: "ACP engine", value: bool(c.useAcp) },
      { key: "configDirs", label: "Account dirs", value: c.configDirsCount },
      { key: "approveMcps", label: "Approve MCPs", value: bool(c.approveMcps, "warning") },
      { key: "verbose", label: "Verbose", value: bool(c.verbose) },
    ],
  },
  {
    title: "Admission — ACP plane",
    description: "Concurrency caps for CLI/ACP runs",
    items: (c) => [
      { key: "acpGlobal", label: "Global cap", value: c.maxConcurrentRuns },
      {
        key: "acpPerAccount",
        label: "Per-account cap",
        value: c.maxConcurrentRunsPerAccount,
      },
      { key: "wait", label: "Admission wait", value: `${c.admissionWaitMs} ms` },
    ],
  },
  {
    title: "Admission — SDK plane",
    description: "Separate, higher caps for @cursor/sdk runs",
    items: (c) => [
      { key: "sdkGlobal", label: "Global cap", value: c.sdkMaxConcurrentRuns },
      {
        key: "sdkPerAccount",
        label: "Per-account cap",
        value: c.sdkMaxConcurrentRunsPerAccount,
      },
    ],
  },
  {
    title: "Observability",
    description: "Structured request log and Prometheus endpoint",
    items: (c) => [
      {
        key: "requestsLog",
        label: "Requests log (JSONL)",
        value: c.requestsLogPath,
        mono: true,
      },
      {
        key: "requestsLogEnabled",
        label: "Requests log enabled",
        value: bool(c.requestsLogEnabled),
      },
      {
        key: "requestsLogMaxBytes",
        label: "Rotate at",
        value: c.requestsLogMaxBytes
          ? `${Math.round(c.requestsLogMaxBytes / (1024 * 1024))} MB`
          : "never",
      },
      { key: "metrics", label: "GET /metrics", value: bool(c.metricsEnabled) },
    ],
  },
  {
    title: "Security",
    description: "Inbound auth gates (secret values are never sent to the browser)",
    items: (c) => [
      {
        key: "requiredKey",
        label: "Inbound API key required",
        value: (
          <Badge tone={c.requiredKey ? "warning" : "neutral"}>
            {c.requiredKey ? "CURSOR_BRIDGE_API_KEY required" : "not required"}
          </Badge>
        ),
      },
      { key: "tlsEnabled", label: "TLS configured", value: bool(c.tlsEnabled) },
    ],
  },
];

export function ConfigPage() {
  const config = useApiResource<ProxyConfig>(() => api.config());

  return (
    <Stack gap={6}>
      <PageHeader
        title="Config"
        description="Sanitized runtime configuration reported by /api/config."
        actions={
          <Button
            variant="secondary"
            loading={config.loading}
            onClick={() => void config.reload()}
          >
            Refresh
          </Button>
        }
      />

      {config.error && (
        <Alert tone="danger" title="Could not load config">
          {config.error}
        </Alert>
      )}

      <Grid columns={2} gap={4}>
        {GROUPS.map((group) => (
          <Card key={group.title}>
            <CardHeader title={group.title} description={group.description} />
            <CardBody>
              {config.data ? (
                <KeyValueList items={group.items(config.data)} />
              ) : (
                <Stack gap={2}>
                  {config.loading ? "Loading…" : "No configuration available."}
                </Stack>
              )}
            </CardBody>
          </Card>
        ))}
      </Grid>
    </Stack>
  );
}
