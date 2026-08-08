import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Container.module.css";

export type ContainerProps = HTMLAttributes<HTMLDivElement> & {
  width?: "default" | "narrow";
  flush?: boolean;
};

export function Container({
  width = "default",
  flush = false,
  className,
  ...rest
}: ContainerProps) {
  return (
    <div
      className={cx(
        styles.container,
        width === "narrow" && styles.narrow,
        flush && styles.flush,
        className,
      )}
      {...rest}
    />
  );
}
