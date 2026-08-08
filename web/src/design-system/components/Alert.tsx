import type { HTMLAttributes, ReactNode } from "react";

import type { Tone } from "../tokens";
import { cx } from "../utils";
import styles from "./Alert.module.css";

const defaultIcon: Record<Tone, string> = {
  neutral: "•",
  brand: "★",
  success: "✓",
  warning: "!",
  danger: "✕",
  info: "i",
};

export type AlertProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  tone?: Tone;
  title?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
};

export function Alert({
  tone = "neutral",
  title,
  actions,
  icon,
  className,
  children,
  ...rest
}: AlertProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cx(styles.alert, styles[tone], className)}
      {...rest}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon ?? defaultIcon[tone]}
      </span>
      <div className={styles.content}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <p className={styles.body}>{children}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
