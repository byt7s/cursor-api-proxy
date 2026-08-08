import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Inline.module.css";

export type InlineGap = 0 | 1 | 2 | 3 | 4 | 6;
export type InlineJustify = "start" | "between" | "end" | "center";
export type InlineAlign = "start" | "center" | "end" | "baseline";

export type InlineProps = HTMLAttributes<HTMLDivElement> & {
  gap?: InlineGap;
  justify?: InlineJustify;
  align?: InlineAlign;
  wrap?: boolean;
};

const gapClass: Record<InlineGap, string> = {
  0: styles.gap0,
  1: styles.gap1,
  2: styles.gap2,
  3: styles.gap3,
  4: styles.gap4,
  6: styles.gap6,
};

const justifyClass: Record<InlineJustify, string> = {
  start: styles.justifyStart,
  between: styles.justifyBetween,
  end: styles.justifyEnd,
  center: styles.justifyCenter,
};

const alignClass: Record<InlineAlign, string> = {
  start: styles.alignStart,
  center: styles.alignCenter,
  end: styles.alignEnd,
  baseline: styles.alignBaseline,
};

/** Horizontal flex layout on the spacing scale. */
export function Inline({
  gap = 2,
  justify = "start",
  align = "center",
  wrap = false,
  className,
  ...rest
}: InlineProps) {
  return (
    <div
      className={cx(
        styles.inline,
        gapClass[gap],
        justifyClass[justify],
        alignClass[align],
        wrap && styles.wrap,
        className,
      )}
      {...rest}
    />
  );
}
