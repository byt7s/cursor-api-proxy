import { useState } from "react";

import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Inline,
  LogViewer,
  PageHeader,
  Select,
  Stack,
  Switch,
} from "../design-system";
import {
  useApiResource,
  useAsyncAction,
  useDashboardEvents,
  usePolling,
  useSettings,
} from "../hooks";
import { api } from "../lib/api";
import type { LogPayload } from "../lib/types";

const INTERVALS = [
  { value: "1000", label: "1s" },
  { value: "3000", label: "3s" },
  { value: "5000", label: "5s" },
  { value: "15000", label: "15s" },
];

const LINE_COUNTS = [
  { value: "80", label: "80 lines" },
  { value: "200", label: "200 lines" },
  { value: "500", label: "500 lines" },
  { value: "1000", label: "1000 lines" },
];

export function LogsPage() {
  const { poll, setPoll } = useSettings();
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [lines, setLines] = useState(200);
  const [confirmClear, setConfirmClear] = useState(false);
  const log = useApiResource<LogPayload>(() => api.log(lines), [lines]);
  const { pending, run } = useAsyncAction();

  const eventsMode = useDashboardEvents(
    {
      onLog: () => {
        void log.reload();
      },
    },
    !paused,
  );
  // Keep interval controls for pause / fallback when SSE is unavailable.
  usePolling(
    () => {
      void log.reload();
    },
    poll.logMs,
    !paused && eventsMode !== "sse",
  );

  async function onClear(): Promise<void> {
    setConfirmClear(false);
    await run(() => api.clearLog(), {
      successMessage: (result) =>
        `Archived log to ${(result as { archivePath: string }).archivePath}`,
      errorPrefix: "Clear failed",
      onSuccess: () => log.reload(),
    });
  }

  return (
    <Stack gap={6}>
      <PageHeader
        title="Logs"
        description="Live tail of the sessions log with pause, autoscroll and interval control."
        actions={
          <Button
            variant="secondary"
            loading={log.loading}
            onClick={() => void log.reload()}
          >
            Refresh
          </Button>
        }
      />

      {log.error && (
        <Alert tone="danger" title="Could not read log">
          {log.error}
        </Alert>
      )}

      <Card>
        <CardHeader
          title="Live log tail"
          description={log.data?.path}
          actions={
            <Inline gap={3} wrap>
              <Select
                autoWidth
                selectSize="sm"
                aria-label="Tail size"
                options={LINE_COUNTS}
                value={String(lines)}
                onValueChange={(value) => setLines(Number(value))}
              />
              <Select
                autoWidth
                selectSize="sm"
                aria-label="Poll interval"
                options={INTERVALS}
                value={String(poll.logMs)}
                onValueChange={(value) => setPoll({ logMs: Number(value) })}
              />
              <Switch
                checked={autoscroll}
                onCheckedChange={setAutoscroll}
                label="autoscroll"
              />
              <Button size="sm" onClick={() => setPaused((p) => !p)}>
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => setConfirmClear(true)}
              >
                Clear
              </Button>
            </Inline>
          }
        />
        <CardBody flush>
          <LogViewer
            lines={log.data?.lines ?? []}
            autoscroll={autoscroll && !paused}
            emptyTitle={log.loading ? "Loading log…" : "Log is empty."}
          />
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmClear}
        destructive
        title="Clear sessions log"
        message="Clear and archive the current sessions log? The existing content is moved to a timestamped .archive file."
        confirmLabel="Clear log"
        loading={pending}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void onClear()}
      />
    </Stack>
  );
}
