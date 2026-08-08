import type { ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Topbar.module.css";

export type TopbarProps = {
  status?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function Topbar({ status, summary, actions, className }: TopbarProps) {
  return (
    <header className={cx(styles.topbar, className)}>
      <div className={styles.status}>
        {status}
        {summary && <span className={styles.summary}>{summary}</span>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
