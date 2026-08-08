import { useState, type FormEvent } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Grid,
  Inline,
  InlineCode,
  PageHeader,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  type TableColumn,
} from "../design-system";
import {
  DEFAULT_POLL_SETTINGS,
  useApiResource,
  useDashboardKey,
  useSettings,
  useTheme,
  useToast,
} from "../hooks";
import { api } from "../lib/api";
import type { ApiKeyDescriptor, ConfigCaller, ProxyConfig } from "../lib/types";

const INTERVAL_OPTIONS = [
  { value: "1000", label: "1s" },
  { value: "3000", label: "3s" },
  { value: "5000", label: "5s" },
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
  { value: "60000", label: "60s" },
];

/** `caller` marks the row matching the credential this browser presented. */
function keyColumns(
  caller: ConfigCaller | undefined,
): Array<TableColumn<ApiKeyDescriptor>> {
  return [
    {
      key: "label",
      header: "Label",
      render: (k) => (
        <Inline gap={2}>
          <span>{k.label}</span>
          {caller?.fingerprint === k.fingerprint && (
            <Badge tone="success">this browser</Badge>
          )}
        </Inline>
      ),
      sortValue: (k) => k.label,
    },
    {
      key: "scope",
      header: "Scope",
      render: (k) => (
        <Badge tone={k.scope === "admin" ? "warning" : "neutral"}>
          {k.scope}
        </Badge>
      ),
      sortValue: (k) => k.scope,
    },
    {
      key: "fingerprint",
      header: "Fingerprint",
      render: (k) => <code>{k.fingerprint}</code>,
    },
  ];
}

export function SettingsPage() {
  const { dashboardKey, hasKey, saveKey, clearKey } = useDashboardKey();
  const { theme, setTheme } = useTheme();
  const { poll, setPoll, resetPoll } = useSettings();
  const toast = useToast();
  // Re-reads after the key changes so the "this browser" marker follows it.
  const config = useApiResource<ProxyConfig>(() => api.config(), [dashboardKey]);
  const [draftKey, setDraftKey] = useState(dashboardKey);

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    saveKey(draftKey);
    toast.success(
      draftKey.trim()
        ? "Dashboard key saved for this tab session"
        : "Dashboard key cleared",
    );
  }

  return (
    <Stack gap={6}>
      <PageHeader
        title="Settings"
        description="Dashboard key, appearance and polling intervals. Everything here stays in this browser."
      />

      <Card>
        <CardHeader
          title="Dashboard key"
          description="Sent as Authorization: Bearer on every dashboard API call"
        />
        <CardBody>
          <form onSubmit={onSubmit}>
            <Stack gap={4}>
              <Alert tone={hasKey ? "success" : "info"}>
                {hasKey
                  ? "A key is stored in sessionStorage for this tab and is cleared when the tab closes."
                  : "No key stored. Without a key, mutating APIs only work from loopback, and every API is refused once the server sets a dashboard key."}
              </Alert>
              <FormField
                label="CURSOR_BRIDGE_DASHBOARD_KEY"
                help={
                  <>
                    The dedicated dashboard key when the proxy sets one,
                    otherwise an admin-scoped key from{" "}
                    <InlineCode>CURSOR_BRIDGE_API_KEYS</InlineCode> or the
                    legacy <InlineCode>CURSOR_BRIDGE_API_KEY</InlineCode>.
                    Stored in <InlineCode>sessionStorage</InlineCode>, never
                    sent anywhere but this proxy.
                  </>
                }
              >
                <PasswordInput
                  value={draftKey}
                  placeholder="dashboard key"
                  onChange={(e) => setDraftKey(e.target.value)}
                />
              </FormField>
              <Inline gap={2}>
                <Button type="submit" variant="primary">
                  Save in session
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    clearKey();
                    setDraftKey("");
                    toast.toast("Dashboard key cleared");
                  }}
                >
                  Clear
                </Button>
              </Inline>
            </Stack>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Configured API keys"
          description="Read-only inventory from /api/config — values never leave the server"
          actions={
            config.data && (
              <Badge tone={config.data.dashboardKeyConfigured ? "success" : "warning"}>
                {config.data.dashboardKeyConfigured
                  ? "dedicated dashboard key"
                  : "no dedicated dashboard key"}
              </Badge>
            )
          }
        />
        <CardBody flush>
          {config.error ? (
            <CardBody>
              <Alert tone="danger" title="Could not read the key inventory">
                {config.error}
              </Alert>
            </CardBody>
          ) : (
            <Table
              columns={keyColumns(config.data?.caller)}
              rows={config.data?.apiKeys ?? []}
              rowKey={(k) => k.label}
              caption="Configured inbound API keys"
              loading={config.initial && config.loading}
              emptyTitle="No inbound keys configured"
              emptyDescription="Anyone who can reach this port can use the LLM routes."
            />
          )}
        </CardBody>
        <CardBody>
          <Stack gap={2}>
            <span>
              This browser is authenticated as{" "}
              <InlineCode>{config.data?.caller.actor ?? "unknown"}</InlineCode>
              {config.data?.caller.fingerprint
                ? ` (fingerprint ${config.data.caller.fingerprint})`
                : ""}
              .
            </span>
            {config.data && !config.data.dashboardKeyConfigured && (
              <Alert tone="warning" title="Set a dedicated dashboard key">
                The dashboard can create and remove accounts and reset the
                machine id. Set{" "}
                <InlineCode>CURSOR_BRIDGE_DASHBOARD_KEY</InlineCode> so admin
                actions no longer share a credential with LLM traffic.
              </Alert>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Grid columns={2} gap={4}>
        <Card>
          <CardHeader title="Appearance" description="Theme is stored per browser" />
          <CardBody>
            <Switch
              checked={theme === "dark"}
              onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
              label={theme === "dark" ? "Dark theme" : "Light theme"}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Polling intervals"
            description="How often each page refreshes on its own"
            actions={
              <Button size="sm" variant="ghost" onClick={resetPoll}>
                Reset
              </Button>
            }
          />
          <CardBody>
            <Stack gap={4}>
              <FormField label="Status">
                <Select
                  options={INTERVAL_OPTIONS}
                  value={String(poll.statusMs)}
                  onValueChange={(value) => setPoll({ statusMs: Number(value) })}
                />
              </FormField>
              <FormField label="Logs">
                <Select
                  options={INTERVAL_OPTIONS}
                  value={String(poll.logMs)}
                  onValueChange={(value) => setPoll({ logMs: Number(value) })}
                />
              </FormField>
              <FormField label="Requests">
                <Select
                  options={INTERVAL_OPTIONS}
                  value={String(poll.requestsMs)}
                  onValueChange={(value) => setPoll({ requestsMs: Number(value) })}
                />
              </FormField>
              <FormField label="Accounts">
                <Select
                  options={INTERVAL_OPTIONS}
                  value={String(poll.accountsMs)}
                  onValueChange={(value) => setPoll({ accountsMs: Number(value) })}
                />
              </FormField>
              <span>
                Defaults: status {DEFAULT_POLL_SETTINGS.statusMs / 1000}s · logs{" "}
                {DEFAULT_POLL_SETTINGS.logMs / 1000}s · requests{" "}
                {DEFAULT_POLL_SETTINGS.requestsMs / 1000}s · accounts{" "}
                {DEFAULT_POLL_SETTINGS.accountsMs / 1000}s
              </span>
            </Stack>
          </CardBody>
        </Card>
      </Grid>
    </Stack>
  );
}
