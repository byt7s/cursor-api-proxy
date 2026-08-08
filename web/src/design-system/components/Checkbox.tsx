import type { InputHTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Checkbox.module.css";

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "children"
> & {
  label: ReactNode;
  description?: ReactNode;
};

export function Checkbox({
  label,
  description,
  className,
  disabled,
  ...rest
}: CheckboxProps) {
  return (
    <label
      className={cx(styles.root, className)}
      data-disabled={disabled ? "true" : undefined}
    >
      <input
        type="checkbox"
        className={styles.input}
        disabled={disabled}
        {...rest}
      />
      <span className={styles.text}>
        <span>{label}</span>
        {description && <span className={styles.description}>{description}</span>}
      </span>
    </label>
  );
}
