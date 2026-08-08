import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Divider.module.css";

export type DividerProps = HTMLAttributes<HTMLHRElement> & {
  orientation?: "horizontal" | "vertical";
  tone?: "default" | "subtle";
};

export function Divider({
  orientation = "horizontal",
  tone = "default",
  className,
  ...rest
}: DividerProps) {
  return (
    <hr
      aria-orientation={orientation}
      className={cx(
        styles.divider,
        orientation === "vertical" ? styles.vertical : styles.horizontal,
        tone === "subtle" && styles.subtle,
        className,
      )}
      {...rest}
    />
  );
}
