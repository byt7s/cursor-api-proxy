import type { HTMLAttributes, ReactNode } from "react";

import type { Tone } from "../tokens";
import { cx } from "../utils";
import styles from "./StatusDot.module.css";

export type StatusDotProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  label?: ReactNode;
  pulse?: boolean;
};

export function StatusDot({
  tone = "neutral",
  label,
  pulse = false,
  className,
  ...rest
}: StatusDotProps) {
  return (
    <span
      className={cx(styles.root, className)}
      data-tone={tone}
      data-testid="status-dot"
      {...rest}
    >
      <span
        className={cx(styles.dot, styles[tone], pulse && styles.pulse)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
