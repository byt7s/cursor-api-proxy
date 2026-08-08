import type { HTMLAttributes } from "react";

import { cx } from "../utils";
import styles from "./Spinner.module.css";

export type SpinnerProps = HTMLAttributes<HTMLSpanElement> & {
  size?: "sm" | "md" | "lg";
  /** Inherit the surrounding text colour instead of the brand colour. */
  inherit?: boolean;
  label?: string;
};

export function Spinner({
  size = "md",
  inherit = false,
  label = "Loading",
  className,
  ...rest
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      data-testid="spinner"
      className={cx(
        styles.spinner,
        styles[size],
        inherit && styles.inherit,
        className,
      )}
      {...rest}
    />
  );
}
