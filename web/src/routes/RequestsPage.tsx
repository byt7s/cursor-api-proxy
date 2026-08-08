import { Fragment, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  Divider,
  Inline,
  KeyValueList,
  Modal,
  PageHeader,
  Select,
  Stack,
  Switch,
  Table,
  type KeyValueItem,
  type TableColumn,
} from "../design-system";
import { useApiResource, usePolling, useSettings } from "../hooks";
import { api } from "../lib/api";
import { formatDash, formatDateTime, formatTime } from "../lib/format";
import type {
  LatencySpanName,
  RequestRecord,
  RequestsPayload,
} from "../lib/types";
import styles from "./RequestsPage.module.css";

const LIMITS = [
  { value: "20", label: "20 requests" },
  { value: "40", label: "40 requests" },
  { value: "80", label: "80 requests" },
  { value: "200", label: "200 requests" },
];

/** Waterfall order; `total` is shown as the scale, not as a span row. */
const SPAN_ORDER: LatencySpanName[] = [
  "gateway_queue",
  "account_select",
  "spawn",
  "session_ready",
  "model_first_byte",
  "model_complete",
  "shape_response",
];

const SPAN_LABELS: Record<LatencySpanName, string> = {
  gateway_queue: "Gateway queue",
  account_select: "Account select",
  spawn: "Spawn",
  session_ready: "Session ready",
  model_first_byte: "Model first byte",
  model_complete: "Model complete",
  shape_response: "Shape response",
  total: "Total",
};

function statusTone(status: number): "success" | "warning" | "danger" {
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  return "success";
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function LatencyWaterfall({ record }: { record: RequestRecord }) {
  const spans = record.spans ?? {};
  const rows = SPAN_ORDER.filter((span) => typeof spans[span] === "number").map(
    (span) => ({ span, ms: spans[span] as number }),
  );
  if (rows.length === 0) {
    return (
      <span>
        No latency spans recorded for this request (enable
        CURSOR_BRIDGE_LATENCY_WATERFALL).
      </span>
    );
  }

  const scale = Math.max(
    spans.total ?? 0,
    ...rows.map((row) => row.ms),
    1,
  );

  return (
    <div className={styles.waterfall}>
      {rows.map((row) => (
        <Fragment key={row.span}>
          <span className={styles.spanLabel}>{SPAN_LABELS[row.span]}</span>
          <div className={styles.spanTrack} aria-hidden="true">
            <div
              className={styles.spanBar}
              style={{ inlineSize: `${Math.min(100, (row.ms / scale) * 100)}%` }}
            />
          </div>
          <span className={styles.spanValue}>{formatMs(row.ms)}</span>
        </Fragment>
      ))}
    </div>
  );
}

function detailItems(record: RequestRecord): KeyValueItem[] {
  return [
    { key: "ts", label: "When", value: formatDateTime(record.ts), mono: true },
    {
      key: "request",
      label: "Request",
      value: `${record.method} ${record.pathname}`,
      mono: true,
    },
    {
      key: "status",
      label: "Status",
      value: (
        <Badge tone={statusTone(record.status)}>{record.status}</Badge>
      ),
    },
    { key: "duration", label: "Duration", value: formatMs(record.durationMs) },
    { key: "model", label: "Model", value: formatDash(record.model), mono: true },
    { key: "engine", label: "Engine", value: formatDash(record.engine) },
    {
      key: "account",
      label: "Account",
      value: formatDash(record.account),
      mono: true,
    },
    {
      key: "streaming",
      label: "Streaming",
      value:
        record.streaming === undefined ? (
          "—"
        ) : (
          <Badge tone={record.streaming ? "info" : "neutral"}>
            {record.streaming ? "stream" : "sync"}
          </Badge>
        ),
    },
    {
      key: "errorCode",
      label: "Error code",
      value: record.errorCode ? (
        <Badge tone="danger">{record.errorCode}</Badge>
      ) : (
        "—"
      ),
    },
    {
      key: "failoverCount",
      label: "Account failovers",
      value: formatDash(record.failoverCount ?? 0),
    },
    {
      key: "conversation",
      label: "Conversation",
      value: record.hasConversation
        ? formatDash(record.conversationHash)
        : "—",
      mono: true,
    },
    {
      key: "chars",
      label: "Prompt / completion chars",
      value: `${formatDash(record.promptChars)} / ${formatDash(record.completionChars)}`,
      mono: true,
    },
    {
      key: "remote",
      label: "Client",
      value: formatDash(record.remoteAddress),
      mono: true,
    },
  ];
}

const columns: Array<TableColumn<RequestRecord>> = [
  {
    key: "ts",
    header: "When",
    render: (r) => formatTime(r.ts),
    sortValue: (r) => r.ts,
  },
  { key: "method", header: "Method", render: (r) => r.method },
  { key: "pathname", header: "Path", render: (r) => r.pathname },
  {
    key: "model",
    header: "Model",
    render: (r) => formatDash(r.model),
    sortValue: (r) => r.model ?? "",
  },
  {
    key: "durationMs",
    header: "Duration",
    align: "end",
    numeric: true,
    sortValue: (r) => r.durationMs ?? 0,
    render: (r) => formatMs(r.durationMs),
  },
  {
    key: "status",
    header: "Status",
    align: "end",
    numeric: true,
    sortValue: (r) => r.status,
    render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
  },
];

export function RequestsPage() {
  const { poll } = useSettings();
  const [limit, setLimit] = useState(40);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const requests = useApiResource<RequestsPayload>(
    () => api.requests(limit),
    [limit],
  );

  usePolling(
    () => {
      void requests.reload();
    },
    poll.requestsMs,
    autoRefresh,
  );

  const detailColumns: Array<TableColumn<RequestRecord>> = [
    ...columns,
    {
      key: "detail",
      header: "",
      align: "end",
      render: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
          Details
        </Button>
      ),
    },
  ];

  const source = requests.data?.source;

  return (
    <Stack gap={6}>
      <PageHeader
        title="Requests"
        description="Recent proxied requests — open one for its latency waterfall, model, account and error code."
        actions={
          <Button
            variant="secondary"
            loading={requests.loading}
            onClick={() => void requests.reload()}
          >
            Refresh
          </Button>
        }
      />

      {requests.error && (
        <Alert tone="danger" title="Could not load requests">
          {requests.error}
        </Alert>
      )}

      <Card>
        <CardHeader
          title="Recent requests"
          description={requests.data?.path}
          actions={
            <Inline gap={3}>
              {source && (
                <Badge tone={source === "jsonl" ? "info" : "neutral"}>
                  {source === "jsonl" ? "structured log" : "text log"}
                </Badge>
              )}
              <Select
                autoWidth
                selectSize="sm"
                aria-label="Request limit"
                options={LIMITS}
                value={String(limit)}
                onValueChange={(value) => setLimit(Number(value))}
              />
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                label="auto-refresh"
              />
            </Inline>
          }
        />
        <CardBody flush>
          <Table
            columns={detailColumns}
            rows={requests.data?.requests ?? []}
            rowKey={(r, index) => `${r.ts}-${index}`}
            caption="Recent requests"
            loading={requests.initial && requests.loading}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No requests yet"
            emptyDescription="Send a request through the proxy and it will show up here."
          />
        </CardBody>
      </Card>

      <Modal
        wide
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Request detail"
        description={
          selected ? `${selected.method} ${selected.pathname}` : undefined
        }
      >
        {selected && (
          <Stack gap={5}>
            <KeyValueList items={detailItems(selected)} />
            <Divider />
            <Stack gap={2}>
              <strong>Latency waterfall</strong>
              <LatencyWaterfall record={selected} />
            </Stack>
            <Divider />
            <Stack gap={2}>
              <strong>Raw record</strong>
              <CodeBlock
                copyable
                label="Raw request record"
                code={JSON.stringify(selected, null, 2)}
              />
            </Stack>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
