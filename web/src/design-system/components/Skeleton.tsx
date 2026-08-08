import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Skeleton.module.css";

export type SkeletonProps = HTMLAttributes<HTMLSpanElement> & {
  /** Any CSS length; callers should pass a spacing token where possible. */
  width?: string;
  height?: string;
  round?: boolean;
};

export function Skeleton({
  width = "100%",
  height = "var(--space-4)",
  round = false,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="skeleton"
      className={cx(styles.skeleton, round && styles.round, className)}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}
