import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  Grid,
  Inline,
  KeyValueList,
  PageHeader,
  Stack,
  StatCard,
} from "../design-system";
import {
  useApiResource,
  useAsyncAction,
  usePolling,
  useSettings,
  useStatus,
} from "../hooks";
import { api } from "../lib/api";
import { formatDateTime, formatDuration, formatPercent } from "../lib/format";
import type {
  AccountsReport,
  ControlAction,
  ProxyConfig,
  SessionStats,
} from "../lib/types";

const CONTROLS: Array<{
  action: ControlAction;
  label: string;
  variant: "primary" | "secondary" | "danger";
  confirm?: string;
}> = [
  { action: "start", label: "Start", variant: "primary" },
  {
    action: "restart",
    label: "Restart",
    variant: "primary",
    confirm: "Restart the proxy? The dashboard will briefly disconnect.",
  },
  {
    action: "stop",
    label: "Stop",
    variant: "danger",
    confirm: "Stop the proxy? Clients will fail until you restart.",
  },
  { action: "enable", label: "Enable autostart", variant: "secondary" },
  { action: "disable", label: "Disable autostart", variant: "secondary" },
];

export function OverviewPage() {
  const status = useStatus();
  const { poll } = useSettings();
  const { pending, run } = useAsyncAction();
  const [confirming, setConfirming] = useState<ControlAction | null>(null);

  const stats = useApiResource<SessionStats>(() => api.stats(1));
  const config = useApiResource<ProxyConfig>(() => api.config());
  const accounts = useApiResource<AccountsReport>(() => api.accounts());

  usePolling(() => {
    void stats.reload();
  }, poll.requestsMs);

  const total = stats.data?.total ?? 0;
  const errors = stats.data?.errors ?? 0;
  const successRate = total > 0 ? (total - errors) / total : null;

  async function runControl(action: ControlAction): Promise<void> {
    await run(() => api.control(action), {
      successMessage: `Scheduled: cursor-api-proxy ${action}`,
      errorPrefix: "Action failed",
      onSuccess: async () => {
        setTimeout(() => void status.reload(), 1500);
        setTimeout(() => void status.reload(), 4000);
      },
    });
  }

  function onControlClick(action: ControlAction, confirm?: string): void {
    if (confirm) setConfirming(action);
    else void runControl(action);
  }

  const pendingConfirm = CONTROLS.find((c) => c.action === confirming);

  return (
    <Stack gap={6}>
      <PageHeader
        title="Overview"
        description="Process health, throughput and the same lifecycle actions as the CLI."
        actions={
          <Button
            variant="secondary"
            loading={status.loading}
            onClick={() => void status.reload()}
          >
            Refresh
          </Button>
        }
      />

      {status.error && (
        <Alert tone="danger" title="Status unavailable">
          {status.error}
        </Alert>
      )}

      <Grid columns={4} gap={4}>
        <StatCard
          label={`Requests (${stats.data?.windowHours ?? 1}h)`}
          value={total}
          loading={stats.initial && stats.loading}
          hint={`${errors} error${errors === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Success rate"
          value={successRate === null ? "—" : formatPercent(successRate)}
          loading={stats.initial && stats.loading}
          badge={
            successRate !== null && (
              <Badge tone={successRate >= 0.95 ? "success" : "warning"}>
                {successRate >= 0.95 ? "healthy" : "degraded"}
              </Badge>
            )
          }
        />
        <StatCard
          label="Accounts"
          value={accounts.data?.accounts.length ?? "—"}
          loading={accounts.initial && accounts.loading}
          hint={
            accounts.error
              ? "unauthorized"
              : `${accounts.data?.accounts.filter((a) => a.hasApiKey).length ?? 0} with API key`
          }
        />
        <StatCard
          label="Engine"
          value={config.data ? (config.data.useAcp ? "ACP" : "CLI") : "—"}
          loading={config.initial && config.loading}
          hint={
            config.data
              ? `ACP ${config.data.maxConcurrentRuns}/${config.data.maxConcurrentRunsPerAccount} · SDK ${config.data.sdkMaxConcurrentRuns}/${config.data.sdkMaxConcurrentRunsPerAccount}`
              : undefined
          }
        />
      </Grid>

      <Card>
        <CardHeader
          title="Process"
          description="Reported by /api/status"
          actions={
            status.data && (
              <Badge tone={status.data.launchdLoaded ? "success" : "neutral"}>
                {status.data.launchdLoaded ? "autostart enabled" : "autostart off"}
              </Badge>
            )
          }
        />
        <CardBody>
          {status.data ? (
            <Stack gap={4}>
              <KeyValueList
                items={[
                  {
                    key: "process",
                    label: "Process",
                    value: (
                      <>
                        <Badge tone={status.data.running ? "success" : "danger"}>
                          {status.data.running ? "running" : "down"}
                        </Badge>
                        <span>PID {status.data.pid ?? "—"}</span>
                      </>
                    ),
                  },
                  {
                    key: "listening",
                    label: "Listening",
                    value: `http://${status.data.host}:${status.data.port}`,
                    mono: true,
                  },
                  {
                    key: "uptime",
                    label: "Uptime",
                    value: `${formatDuration(status.data.uptimeSeconds)} (since ${formatDateTime(status.data.startedAt)})`,
                  },
                  {
                    key: "cursor-auth",
                    label: "Cursor auth",
                    value: (
                      <Badge
                        tone={status.data.apiKeyConfigured ? "success" : "warning"}
                      >
                        {status.data.apiKeyConfigured
                          ? "CURSOR_API_KEY set"
                          : "no CURSOR_API_KEY"}
                      </Badge>
                    ),
                  },
                  {
                    key: "inbound-key",
                    label: "Inbound API key",
                    value: (
                      <Badge
                        tone={
                          status.data.bridgeApiKeyRequired ? "warning" : "neutral"
                        }
                      >
                        {status.data.bridgeApiKeyRequired
                          ? "CURSOR_BRIDGE_API_KEY required"
                          : "no bridge API key gate"}
                      </Badge>
                    ),
                  },
                  {
                    key: "node",
                    label: "Node",
                    value: `${status.data.node} (${status.data.platform})`,
                  },
                  {
                    key: "package",
                    label: "Package root",
                    value: status.data.packageRoot,
                    mono: true,
                  },
                  {
                    key: "sessions-log",
                    label: "Sessions log",
                    value: status.data.sessionsLogPath,
                    mono: true,
                  },
                  {
                    key: "service-log",
                    label: "Service log",
                    value: status.data.serviceLog,
                    mono: true,
                  },
                ]}
              />
              <CodeBlock
                copyable
                label="health check command"
                code={`curl -s http://${status.data.host}:${status.data.port}/healthz`}
              />
            </Stack>
          ) : (
            <StatCard label="Status" value="—" loading />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Quick actions"
          description="Runs cursor-api-proxy <cmd> in the background"
        />
        <CardBody>
          <Inline gap={2} wrap>
            {CONTROLS.map((control) => (
              <Button
                key={control.action}
                variant={control.variant}
                disabled={pending}
                onClick={() => onControlClick(control.action, control.confirm)}
              >
                {control.label}
              </Button>
            ))}
          </Inline>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirming !== null}
        title="Please confirm"
        message={pendingConfirm?.confirm ?? ""}
        destructive={confirming === "stop"}
        loading={pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) void runControl(action);
        }}
      />
    </Stack>
  );
}
