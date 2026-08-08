import { useId, useState, type ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Tooltip.module.css";

export type TooltipProps = {
  label: ReactNode;
  children: ReactNode;
  placement?: "top" | "bottom";
  className?: string;
};

/** Hover/focus tooltip wired with `aria-describedby`. */
export function Tooltip({
  label,
  children,
  placement = "top",
  className,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cx(styles.root, className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cx(styles.bubble, placement === "bottom" && styles.bottom)}
        >
          {label}
        </span>
      )}
    </span>
  );
}
