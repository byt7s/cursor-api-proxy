import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Button.module.css";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  children?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  fullWidth = false,
  iconStart,
  iconEnd,
  disabled,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = Boolean(disabled) || loading;
  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" inherit label="Working" />
      ) : (
        iconStart && (
          <span className={styles.icon} aria-hidden="true">
            {iconStart}
          </span>
        )
      )}
      {children}
      {iconEnd && !loading && (
        <span className={styles.icon} aria-hidden="true">
          {iconEnd}
        </span>
      )}
    </button>
  );
}
