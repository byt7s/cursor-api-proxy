import { useMemo, useState, type ReactNode } from "react";

import { cx } from "../utils";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import styles from "./Table.module.css";

export type TableColumn<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  /** Enables click-to-sort on this column when a comparable value is returned. */
  sortValue?: (row: Row) => string | number;
  align?: "start" | "end";
  numeric?: boolean;
  width?: string;
};

export type TableProps<Row> = {
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row, index: number) => string;
  caption?: string;
  loading?: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  emptyActions?: ReactNode;
  className?: string;
};

type SortState = { key: string; direction: "asc" | "desc" } | null;

export function Table<Row>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  emptyTitle = "Nothing to show",
  emptyDescription,
  emptyActions,
  className,
}: TableProps<Row>) {
  const [sort, setSort] = useState<SortState>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * factor;
    });
  }, [rows, columns, sort]);

  function toggleSort(key: string): void {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  if (loading) {
    return (
      <div className={cx(styles.loadingRows, className)} data-testid="table-loading">
        <Skeleton height="var(--space-4)" width="40%" />
        <Skeleton height="var(--space-4)" />
        <Skeleton height="var(--space-4)" />
        <Skeleton height="var(--space-4)" width="70%" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title={emptyTitle}
        description={emptyDescription}
        actions={emptyActions}
      />
    );
  }

  return (
    <div className={cx(styles.scroll, className)}>
      <table className={styles.table}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => {
              const sortable = Boolean(column.sortValue);
              const active = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={cx(column.align === "end" && styles.alignEnd)}
                  aria-sort={
                    active
                      ? sort?.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : sortable
                        ? "none"
                        : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.header}
                      <span className={styles.sortIndicator} aria-hidden="true">
                        {active ? (sort?.direction === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    column.align === "end" && styles.alignEnd,
                    column.numeric && styles.numeric,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
