import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Inline,
  PageHeader,
  Select,
  Stack,
  Switch,
  Table,
  type TableColumn,
} from "../design-system";
import { useApiResource, usePolling, useSettings } from "../hooks";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import type { RequestsPayload, SessionRequest } from "../lib/types";

const LIMITS = [
  { value: "20", label: "20 requests" },
  { value: "40", label: "40 requests" },
  { value: "80", label: "80 requests" },
  { value: "200", label: "200 requests" },
];

const columns: Array<TableColumn<SessionRequest>> = [
  {
    key: "ts",
    header: "When",
    render: (r) => formatTime(r.ts),
    sortValue: (r) => r.ts,
  },
  { key: "method", header: "Method", render: (r) => r.method },
  { key: "pathname", header: "Path", render: (r) => r.pathname },
  {
    key: "status",
    header: "Status",
    align: "end",
    numeric: true,
    sortValue: (r) => r.status,
    render: (r) => (
      <Badge tone={r.status >= 500 ? "danger" : r.status >= 400 ? "warning" : "success"}>
        {r.status}
      </Badge>
    ),
  },
];

export function RequestsPage() {
  const { poll } = useSettings();
  const [limit, setLimit] = useState(40);
  const [autoRefresh, setAutoRefresh] = useState(true);
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

  return (
    <Stack gap={6}>
      <PageHeader
        title="Requests"
        description="Recent proxied requests parsed from the sessions log — the dashboard view of requests --watch."
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
            columns={columns}
            rows={requests.data?.requests ?? []}
            rowKey={(r, index) => `${r.ts}-${index}`}
            caption="Recent requests"
            loading={requests.initial && requests.loading}
            emptyTitle="No requests yet"
            emptyDescription="Send a request through the proxy and it will show up here."
          />
        </CardBody>
      </Card>
    </Stack>
  );
}
