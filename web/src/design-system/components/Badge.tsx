import type { HTMLAttributes } from "react";

import type { Tone } from "../tokens";
import { cx } from "../utils";
import styles from "./Badge.module.css";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  mono?: boolean;
};

export function Badge({
  tone = "neutral",
  mono = false,
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cx(styles.badge, styles[tone], mono && styles.mono, className)}
      {...rest}
    />
  );
}
