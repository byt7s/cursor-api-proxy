import { useEffect, useRef } from "react";

import { cx } from "../utils";
import { EmptyState } from "./EmptyState";
import styles from "./LogViewer.module.css";

export type LogViewerProps = {
  lines: ReadonlyArray<string>;
  autoscroll?: boolean;
  emptyTitle?: string;
  className?: string;
  ariaLabel?: string;
};

const TIMESTAMP_RE = /^(\S+Z)\s+(.*)$/;

function toneFor(rest: string): string | undefined {
  if (rest.includes(" ERROR ")) return styles.error;
  if (/\s[45]\d\d\s*$/.test(rest)) return styles.warn;
  if (/listening on/.test(rest)) return styles.ok;
  return undefined;
}

/** Monospace tail viewer with timestamp de-emphasis and severity colouring. */
export function LogViewer({
  lines,
  autoscroll = true,
  emptyTitle = "Log is empty.",
  className,
  ariaLabel = "Log output",
}: LogViewerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoscroll || !ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoscroll]);

  if (lines.length === 0) {
    return <EmptyState compact title={emptyTitle} />;
  }

  return (
    <div
      ref={ref}
      className={cx(styles.viewer, className)}
      role="log"
      aria-label={ariaLabel}
      aria-live="polite"
      data-testid="log-viewer"
    >
      {lines.map((line, index) => {
        const match = TIMESTAMP_RE.exec(line);
        const timestamp = match?.[1];
        const rest = match?.[2] ?? line;
        return (
          <div key={`${index}-${line}`} className={styles.line}>
            {timestamp && (
              <span className={styles.timestamp}>
                {new Date(timestamp).toLocaleTimeString()}{" "}
              </span>
            )}
            <span className={toneFor(rest)}>{rest}</span>
          </div>
        );
      })}
    </div>
  );
}
