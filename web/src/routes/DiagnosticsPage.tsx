import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  InlineCode,
  PageHeader,
  Stack,
  Table,
  type TableColumn,
} from "../design-system";
import { useApiResource, useAsyncAction } from "../hooks";
import { api } from "../lib/api";
import type { DoctorCheck, DoctorResult } from "../lib/types";

const columns: Array<TableColumn<DoctorCheck>> = [
  { key: "name", header: "Check", render: (c) => c.name },
  {
    key: "ok",
    header: "Status",
    render: (c) => (
      <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "pass" : "fail"}</Badge>
    ),
    sortValue: (c) => (c.ok ? 1 : 0),
  },
  { key: "detail", header: "Detail", render: (c) => c.detail },
];

export function DiagnosticsPage() {
  const doctor = useApiResource<DoctorResult>(() => api.doctor());
  const { pending, run } = useAsyncAction();
  const [deepClean, setDeepClean] = useState(false);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);

  async function onResetConfirmed(): Promise<void> {
    setConfirmStep(0);
    await run(() => api.resetHwid(deepClean), {
      successMessage: "HWID reset complete",
      errorPrefix: "Reset HWID failed",
    });
  }

  const checks = doctor.data?.checks ?? [];
  const failed = checks.filter((c) => !c.ok).length;

  return (
    <Stack gap={6}>
      <PageHeader
        title="Diagnostics"
        description="Preflight checks and recovery tools, mirroring the doctor and reset-hwid commands."
        actions={
          <Button
            variant="secondary"
            loading={doctor.loading}
            onClick={() => void doctor.reload()}
          >
            Run doctor
          </Button>
        }
      />

      {doctor.error && (
        <Alert tone="danger" title="Doctor failed">
          {doctor.error}
        </Alert>
      )}

      <Card>
        <CardHeader
          title="Doctor"
          description="Accounts, credentials, default model and agent binary"
          actions={
            doctor.data && (
              <Badge tone={doctor.data.ok ? "success" : "danger"}>
                {doctor.data.ok
                  ? "all checks pass"
                  : `${failed} check${failed === 1 ? "" : "s"} failing`}
              </Badge>
            )
          }
        />
        <CardBody flush>
          <Table
            columns={columns}
            rows={checks}
            rowKey={(c) => c.name}
            caption="Doctor checks"
            loading={doctor.initial && doctor.loading}
            emptyTitle="No checks returned"
            emptyDescription="Run doctor to collect preflight results."
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Reset HWID"
          description="Destructive — kills Cursor and rewrites machine/telemetry IDs"
          actions={<Badge tone="danger">destructive</Badge>}
        />
        <CardBody>
          <Stack gap={4}>
            <Alert tone="warning" title="This cannot be undone">
              Intended for anti-ban / fresh-install recovery. Equivalent to{" "}
              <InlineCode>cursor-api-proxy reset-hwid</InlineCode>. Cursor is
              terminated before IDs are rewritten.
            </Alert>
            <Checkbox
              checked={deepClean}
              onChange={(e) => setDeepClean(e.target.checked)}
              label="Deep clean"
              description="Also wipe session storage and cookies."
            />
            <div>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => setConfirmStep(1)}
              >
                Reset HWID
              </Button>
            </div>
          </Stack>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmStep === 1}
        destructive
        title="Reset Cursor HWID"
        message={
          deepClean
            ? "Reset Cursor HWID and DEEP CLEAN session/cookie data? Cursor will be killed."
            : "Reset Cursor HWID / telemetry IDs? Cursor will be killed."
        }
        confirmLabel="Continue"
        onCancel={() => setConfirmStep(0)}
        onConfirm={() => setConfirmStep(2)}
      />
      <ConfirmDialog
        open={confirmStep === 2}
        destructive
        title="Final confirmation"
        message="Proceed with the destructive HWID reset? This cannot be undone."
        confirmLabel="Reset now"
        loading={pending}
        onCancel={() => setConfirmStep(0)}
        onConfirm={() => void onResetConfirmed()}
      />
    </Stack>
  );
}
