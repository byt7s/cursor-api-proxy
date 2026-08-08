import { useState, type FormEvent } from "react";

import {
  Alert,
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
} from "../design-system";
import {
  DEFAULT_POLL_SETTINGS,
  useDashboardKey,
  useSettings,
  useTheme,
  useToast,
} from "../hooks";

const INTERVAL_OPTIONS = [
  { value: "1000", label: "1s" },
  { value: "3000", label: "3s" },
  { value: "5000", label: "5s" },
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
  { value: "60000", label: "60s" },
];

export function SettingsPage() {
  const { dashboardKey, hasKey, saveKey, clearKey } = useDashboardKey();
  const { theme, setTheme } = useTheme();
  const { poll, setPoll, resetPoll } = useSettings();
  const toast = useToast();
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
                  : "No key stored. Without a key, mutating APIs only work from loopback, and every API is refused when the server sets CURSOR_BRIDGE_API_KEY."}
              </Alert>
              <FormField
                label="CURSOR_BRIDGE_API_KEY"
                help={
                  <>
                    Matches the value the proxy was started with. Stored in{" "}
                    <InlineCode>sessionStorage</InlineCode>, never sent anywhere
                    but this proxy.
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
