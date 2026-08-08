import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Stack.module.css";

export type StackGap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8;
export type StackAlign = "start" | "center" | "end" | "stretch";

export type StackProps = HTMLAttributes<HTMLDivElement> & {
  gap?: StackGap;
  align?: StackAlign;
};

const gapClass: Record<StackGap, string> = {
  0: styles.gap0,
  1: styles.gap1,
  2: styles.gap2,
  3: styles.gap3,
  4: styles.gap4,
  5: styles.gap5,
  6: styles.gap6,
  8: styles.gap8,
};

const alignClass: Record<StackAlign, string> = {
  start: styles.alignStart,
  center: styles.alignCenter,
  end: styles.alignEnd,
  stretch: styles.alignStretch,
};

/** Vertical flex layout on the spacing scale. */
export function Stack({
  gap = 4,
  align = "stretch",
  className,
  ...rest
}: StackProps) {
  return (
    <div
      className={cx(styles.stack, gapClass[gap], alignClass[align], className)}
      {...rest}
    />
  );
}
