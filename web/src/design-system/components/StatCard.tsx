import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import { Skeleton } from "./Skeleton";
import styles from "./StatCard.module.css";

export type StatCardProps = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  loading?: boolean;
  mono?: boolean;
};

export function StatCard({
  label,
  value,
  hint,
  badge,
  loading = false,
  mono = false,
  className,
  ...rest
}: StatCardProps) {
  return (
    <div className={cx(styles.root, className)} {...rest}>
      <span className={styles.label}>{label}</span>
      {loading ? (
        <Skeleton height="var(--space-8)" width="60%" />
      ) : (
        <span className={cx(styles.value, mono && styles.mono)}>{value}</span>
      )}
      {(hint || badge) && (
        <span className={styles.footer}>
          {badge}
          {hint && <span className={styles.hint}>{hint}</span>}
        </span>
      )}
    </div>
  );
}
