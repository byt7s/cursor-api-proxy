import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Grid.module.css";

export type GridColumns = 1 | 2 | 3 | 4;
export type GridGap = 2 | 3 | 4 | 6;

export type GridProps = HTMLAttributes<HTMLDivElement> & {
  columns?: GridColumns;
  gap?: GridGap;
};

const colsClass: Record<GridColumns, string> = {
  1: styles.cols1,
  2: styles.cols2,
  3: styles.cols3,
  4: styles.cols4,
};

const gapClass: Record<GridGap, string> = {
  2: styles.gap2,
  3: styles.gap3,
  4: styles.gap4,
  6: styles.gap6,
};

/** Responsive equal-width grid; columns collapse at the md/lg breakpoints. */
export function Grid({
  columns = 2,
  gap = 4,
  className,
  ...rest
}: GridProps) {
  return (
    <div
      className={cx(styles.grid, colsClass[columns], gapClass[gap], className)}
      {...rest}
    />
  );
}
