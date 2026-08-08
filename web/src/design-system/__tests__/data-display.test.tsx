import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { KeyValueList } from "../components/KeyValueList";
import { LogViewer } from "../components/LogViewer";
import { StatCard } from "../components/StatCard";
import { StatusDot } from "../components/StatusDot";
import { Table, type TableColumn } from "../components/Table";

type Row = { name: string; count: number };

const columns: Array<TableColumn<Row>> = [
  { key: "name", header: "Name", render: (r) => r.name, sortValue: (r) => r.name },
  {
    key: "count",
    header: "Count",
    numeric: true,
    align: "end",
    render: (r) => r.count,
    sortValue: (r) => r.count,
  },
];

const rows: Row[] = [
  { name: "beta", count: 2 },
  { name: "alpha", count: 9 },
];

describe("Badge and StatusDot", () => {
  it("carry their tone as a data attribute", () => {
    render(
      <>
        <Badge tone="success">CLI + key</Badge>
        <StatusDot tone="danger" label="unreachable" />
      </>,
    );

    expect(screen.getByText("CLI + key")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByTestId("status-dot")).toHaveTextContent("unreachable");
  });
});

describe("Table", () => {
  it("renders a row per record", () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.name} />);

    expect(screen.getAllByRole("row")).toHaveLength(rows.length + 1);
    expect(screen.getByRole("cell", { name: "alpha" })).toBeVisible();
  });

  it("shows a skeleton placeholder while loading", () => {
    render(
      <Table columns={columns} rows={[]} rowKey={(r) => r.name} loading />,
    );

    expect(screen.getByTestId("table-loading")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the empty state when there are no rows", () => {
    render(
      <Table
        columns={columns}
        rows={[]}
        rowKey={(r) => r.name}
        emptyTitle="No accounts found"
        emptyDescription="Run cursor-api-proxy login."
      />,
    );

    expect(screen.getByText("No accounts found")).toBeVisible();
    expect(screen.getByText("Run cursor-api-proxy login.")).toBeVisible();
  });

  it("sorts ascending then descending on a sortable header", async () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.name} />);

    const header = screen.getByRole("button", { name: /Name/ });
    const firstCell = () => screen.getAllByRole("row")[1].textContent ?? "";

    expect(firstCell()).toContain("beta");

    await userEvent.click(header);
    expect(firstCell()).toContain("alpha");

    await userEvent.click(header);
    expect(firstCell()).toContain("beta");
  });
});

describe("KeyValueList", () => {
  it("pairs each label with its value", () => {
    render(
      <KeyValueList
        items={[
          { key: "port", label: "Port", value: 8765 },
          { key: "host", label: "Host", value: "127.0.0.1", mono: true },
        ]}
      />,
    );

    expect(screen.getByText("Port")).toBeVisible();
    expect(screen.getByText("8765")).toBeVisible();
    expect(screen.getByText("127.0.0.1")).toBeVisible();
  });
});

describe("StatCard", () => {
  it("hides the value behind a skeleton while loading", () => {
    const { rerender } = render(
      <StatCard label="Requests (1h)" value={42} loading />,
    );
    expect(screen.queryByText("42")).toBeNull();

    rerender(<StatCard label="Requests (1h)" value={42} hint="0 errors" />);
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByText("0 errors")).toBeVisible();
  });
});

describe("LogViewer", () => {
  it("renders lines and falls back to an empty state", () => {
    const { rerender } = render(<LogViewer lines={[]} />);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("Log is empty.");

    rerender(
      <LogViewer lines={["2026-08-08T00:00:00.000Z GET /healthz 127.0.0.1 200"]} />,
    );
    const viewer = screen.getByRole("log", { name: "Log output" });
    expect(viewer).toHaveTextContent("GET /healthz 127.0.0.1 200");
  });
});

describe("EmptyState", () => {
  it("renders a title, description and actions", () => {
    render(
      <EmptyState
        title="No requests yet"
        description="Send a request through the proxy."
        actions={<button type="button">Refresh</button>}
      />,
    );

    expect(screen.getByText("No requests yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });
});
