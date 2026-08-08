import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./EmptyState.module.css";

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
};

export function EmptyState({
  title,
  description,
  icon,
  actions,
  compact = false,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cx(styles.root, compact && styles.compact, className)}
      data-testid="empty-state"
      {...rest}
    >
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
