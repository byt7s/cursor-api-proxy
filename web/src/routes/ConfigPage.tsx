import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  FormField,
  Grid,
  Inline,
  InlineCode,
  Input,
  KeyValueList,
  PageHeader,
  Select,
  Stack,
  useToast,
  type KeyValueItem,
} from "../design-system";
import { useApiResource } from "../hooks";
import { api, errorMessage } from "../lib/api";
import type {
  ConfigFileKeySpec,
  ConfigFilePayload,
  ConfigFileValue,
  ConfigValueSource,
  ProxyConfig,
} from "../lib/types";

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

/** Read-only runtime facts the config file does not own. */
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
      {
        key: "dashboardKey",
        label: "Dedicated dashboard key",
        value: (
          <Badge tone={c.dashboardKeyConfigured ? "success" : "warning"}>
            {c.dashboardKeyConfigured ? "configured" : "not set"}
          </Badge>
        ),
      },
      {
        key: "apiKeys",
        label: "Scoped keys",
        value:
          c.apiKeys.length > 0
            ? c.apiKeys
                .map((k) => `${k.label} (${k.scope}/${k.fingerprint})`)
                .join(", ")
            : "none",
      },
      {
        key: "rateLimit",
        label: "Per-key rate limit",
        value:
          c.keyRateLimitPerMin > 0 ? `${c.keyRateLimitPerMin}/min` : "off",
      },
      {
        key: "maxBody",
        label: "Max JSON body",
        value: c.maxBodyBytes
          ? `${Math.round(c.maxBodyBytes / (1024 * 1024))} MB`
          : "unlimited",
      },
      {
        key: "cors",
        label: "CORS origins",
        value: c.corsOrigins.length > 0 ? c.corsOrigins.join(", ") : "off",
      },
      {
        key: "auditLog",
        label: "Audit log",
        value: c.auditLogEnabled ? c.auditLogPath : "disabled",
        mono: c.auditLogEnabled,
      },
      { key: "tlsEnabled", label: "TLS configured", value: bool(c.tlsEnabled) },
    ],
  },
];

const SOURCE_TONE: Record<ConfigValueSource, "success" | "warning" | "neutral"> = {
  cli: "warning",
  env: "warning",
  file: "success",
  default: "neutral",
};

const SOURCE_HELP: Record<ConfigValueSource, string> = {
  cli: "a CLI flag decides this value — the file is ignored",
  env: "an environment variable decides this value — the file is ignored",
  file: "from the config file",
  default: "built-in default",
};

/** True when a flag, env var or policy means editing the file cannot help. */
function isLocked(spec: ConfigFileKeySpec, source: ConfigValueSource): boolean {
  return !spec.editable || source === "env" || source === "cli";
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function toInputText(value: ConfigFileValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function ConfigPage() {
  const config = useApiResource<ProxyConfig>(() => api.config());
  const file = useApiResource<ConfigFilePayload>(() => api.configFile());
  const toast = useToast();

  const [draft, setDraft] = useState<Record<string, ConfigFileValue | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState<string[]>([]);
  const [noEffect, setNoEffect] = useState<string[]>([]);

  // The server's view wins after every load, so the form can never keep
  // claiming a value the write did not accept.
  useEffect(() => {
    setDraft({});
  }, [file.data]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, ConfigFileKeySpec[]>();
    for (const spec of file.data?.keys ?? []) {
      const list = byGroup.get(spec.group) ?? [];
      list.push(spec);
      byGroup.set(spec.group, list);
    }
    return [...byGroup.entries()];
  }, [file.data]);

  const setValue = useCallback(
    (key: string, value: ConfigFileValue | undefined) => {
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const dirty = Object.keys(draft).length > 0;

  const save = useCallback(async () => {
    const data = file.data;
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      const merged: Record<string, ConfigFileValue> = { ...data.values };
      for (const [key, value] of Object.entries(draft)) {
        if (value === undefined || value === "") delete merged[key];
        else merged[key] = value;
      }
      const result = await api.saveConfigFile(merged);
      setRestartRequired(result.restartRequired);
      setNoEffect(result.noEffect);
      toast.success(`Saved ${result.path}`);
      await file.reload();
    } catch (err) {
      setSaveError(errorMessage(err));
      toast.error("Could not save the config file");
    } finally {
      setSaving(false);
    }
  }, [draft, file, toast]);

  const restart = useCallback(async () => {
    try {
      await api.control("restart");
      toast.success("Restart scheduled");
      setRestartRequired([]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [toast]);

  const data = file.data;

  return (
    <Stack gap={6}>
      <PageHeader
        title="Config"
        description="CLI flags win over environment variables, which win over the config file, which wins over built-in defaults."
        actions={
          <Inline gap={2}>
            <Button
              variant="secondary"
              loading={config.loading || file.loading}
              onClick={() => {
                void config.reload();
                void file.reload();
              }}
            >
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => void restart()}>
              Restart proxy
            </Button>
            <Button disabled={!dirty} loading={saving} onClick={() => void save()}>
              Save config file
            </Button>
          </Inline>
        }
      />

      {config.error && (
        <Alert tone="danger" title="Could not load config">
          {config.error}
        </Alert>
      )}
      {file.error && (
        <Alert tone="danger" title="Could not load the config file">
          {file.error}
        </Alert>
      )}
      {saveError && (
        <Alert tone="danger" title="Could not save the config file">
          {saveError}
        </Alert>
      )}
      {restartRequired.length > 0 && (
        <Alert
          tone="warning"
          title="Restart required"
          actions={
            <Button size="sm" onClick={() => void restart()}>
              Restart proxy
            </Button>
          }
        >
          These values take effect after a restart: {restartRequired.join(", ")}.
        </Alert>
      )}
      {noEffect.length > 0 && (
        <Alert tone="warning" title="Saved but overridden">
          A CLI flag or environment variable still wins for: {noEffect.join(", ")}.
        </Alert>
      )}
      {data && data.warnings.length > 0 && (
        <Alert tone="warning" title="Config file warnings">
          <Stack gap={1}>
            {data.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </Stack>
        </Alert>
      )}

      {data && (
        <Card>
          <CardHeader
            title="Config file"
            description={
              data.exists
                ? "Read at startup, editable here."
                : "Not created yet — saving writes it."
            }
          />
          <CardBody>
            <Stack gap={2}>
              <InlineCode>{data.path}</InlineCode>
              <span>
                Credentials are refused on purpose ({data.refusedKeys.join(", ")}
                ): they must come from the environment.
              </span>
            </Stack>
          </CardBody>
        </Card>
      )}

      {data && (
        <Grid columns={2} gap={4}>
          {groups.map(([group, specs]) => (
            <Card key={`file-${group}`}>
              <CardHeader title={`${group} — config file`} />
              <CardBody>
                <Stack gap={4}>
                  {specs.map((spec) => {
                    const source = data.sources[spec.key] ?? "default";
                    const locked = isLocked(spec, source);
                    const value = Object.prototype.hasOwnProperty.call(
                      draft,
                      spec.key,
                    )
                      ? draft[spec.key]
                      : data.values[spec.key];
                    const help = (
                      <>
                        {spec.env} · effective{" "}
                        {displayValue(data.effective[spec.key])} ·{" "}
                        {spec.editable
                          ? SOURCE_HELP[source]
                          : "read-only from the dashboard"}
                      </>
                    );
                    const label = (
                      <Inline gap={2}>
                        <span>{spec.label}</span>
                        <Badge tone={SOURCE_TONE[source]}>{source}</Badge>
                        {locked && <Badge tone="neutral">locked</Badge>}
                      </Inline>
                    );

                    if (spec.type === "boolean") {
                      return (
                        <FormField key={spec.key} label={label} help={help}>
                          <Checkbox
                            label={spec.label}
                            checked={value === true}
                            disabled={locked}
                            onChange={(event) =>
                              setValue(spec.key, event.target.checked)
                            }
                          />
                        </FormField>
                      );
                    }

                    if (spec.type === "enum") {
                      return (
                        <FormField key={spec.key} label={label} help={help}>
                          <Select
                            options={[
                              { value: "", label: "(unset)" },
                              ...(spec.values ?? []).map((v) => ({
                                value: v,
                                label: v,
                              })),
                            ]}
                            value={typeof value === "string" ? value : ""}
                            disabled={locked}
                            onValueChange={(next) =>
                              setValue(spec.key, next === "" ? undefined : next)
                            }
                          />
                        </FormField>
                      );
                    }

                    return (
                      <FormField key={spec.key} label={label} help={help}>
                        <Input
                          type={spec.type === "number" ? "number" : "text"}
                          value={toInputText(value)}
                          disabled={locked}
                          placeholder={displayValue(data.effective[spec.key])}
                          onChange={(event) => {
                            const raw = event.target.value;
                            if (raw === "") return setValue(spec.key, undefined);
                            if (spec.type === "number") {
                              const parsed = Number(raw);
                              return setValue(
                                spec.key,
                                Number.isFinite(parsed) ? parsed : raw,
                              );
                            }
                            if (spec.type === "string[]") {
                              return setValue(
                                spec.key,
                                raw
                                  .split(",")
                                  .map((part) => part.trim())
                                  .filter(Boolean),
                              );
                            }
                            return setValue(spec.key, raw);
                          }}
                        />
                      </FormField>
                    );
                  })}
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Grid>
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
