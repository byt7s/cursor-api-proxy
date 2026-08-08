import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Button.module.css";
import type { ButtonSize, ButtonVariant } from "./Button";
import { Spinner } from "./Spinner";

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  /** Required: icon-only controls have no visible text. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
  disabled,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      data-variant={variant}
      data-size={size}
      disabled={Boolean(disabled) || loading}
      aria-busy={loading || undefined}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        styles.iconOnly,
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" inherit label={label} />
      ) : (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
    </button>
  );
}
