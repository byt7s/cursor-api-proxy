import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  InlineCode,
  PageHeader,
  Stack,
  Table,
  type TableColumn,
} from "../design-system";
import { useApiResource } from "../hooks";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { AuditPayload, AuditRecord } from "../lib/types";

const columns: Array<TableColumn<AuditRecord>> = [
  {
    key: "ts",
    header: "When",
    render: (r) => formatDateTime(r.ts),
    sortValue: (r) => r.ts,
  },
  {
    key: "action",
    header: "Action",
    render: (r) => <code>{r.action}</code>,
    sortValue: (r) => r.action,
  },
  {
    key: "actor",
    header: "Actor",
    render: (r) => (
      <>
        {r.actor}
        {r.actorFingerprint ? ` · ${r.actorFingerprint}` : ""}
      </>
    ),
    sortValue: (r) => r.actor,
  },
  { key: "target", header: "Target", render: (r) => r.target ?? "—" },
  {
    key: "remoteAddress",
    header: "From",
    render: (r) => r.remoteAddress,
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (r) => (
      <Badge tone={r.outcome === "ok" ? "success" : "danger"}>
        {r.outcome === "ok" ? `ok ${r.status}` : `${r.status}`}
      </Badge>
    ),
    sortValue: (r) => r.status,
  },
];

export function AuditPage() {
  const audit = useApiResource<AuditPayload>(() => api.audit(200));
  const records = audit.data?.records ?? [];
  const refused = records.filter((r) => r.outcome === "error").length;

  return (
    <Stack gap={6}>
      <PageHeader
        title="Audit"
        description="Every mutating dashboard call — including the ones that were refused."
        actions={
          <Button
            variant="secondary"
            loading={audit.loading}
            onClick={() => void audit.reload()}
          >
            Refresh
          </Button>
        }
      />

      {audit.error && (
        <Alert tone="danger" title="Could not load the audit log">
          {audit.error}
        </Alert>
      )}

      {audit.data && !audit.data.enabled && (
        <Alert tone="warning" title="Audit logging is disabled">
          Set <InlineCode>CURSOR_BRIDGE_AUDIT_LOG_ENABLED=true</InlineCode> to
          record dashboard mutations again.
        </Alert>
      )}

      <Card>
        <CardHeader
          title="Recent mutations"
          description={audit.data?.path ?? "Reading the audit log…"}
          actions={
            records.length > 0 && (
              <Badge tone={refused > 0 ? "warning" : "neutral"}>
                {refused > 0
                  ? `${refused} refused of ${records.length}`
                  : `${records.length} entries`}
              </Badge>
            )
          }
        />
        <CardBody flush>
          <Table
            columns={columns}
            rows={records}
            rowKey={(r, index) => `${r.ts}-${index}`}
            caption="Dashboard audit log"
            loading={audit.initial && audit.loading}
            emptyTitle="No audited actions yet"
            emptyDescription="Account changes, HWID resets and control actions appear here."
          />
        </CardBody>
      </Card>
    </Stack>
  );
}
