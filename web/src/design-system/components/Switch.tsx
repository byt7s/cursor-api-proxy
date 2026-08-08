import { useId, type ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Switch.module.css";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
};

/** Accessible on/off toggle (`role="switch"`) for instant-apply settings. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
  id,
}: SwitchProps) {
  const autoId = useId();
  const labelId = `${id ?? autoId}-label`;
  return (
    <span
      className={cx(styles.root, className)}
      data-disabled={disabled ? "true" : undefined}
    >
      <button
        type="button"
        id={id ?? autoId}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        className={styles.button}
        onClick={() => onCheckedChange(!checked)}
      >
        <span className={styles.track}>
          <span className={styles.thumb} />
        </span>
      </button>
      <label htmlFor={id ?? autoId} id={labelId}>
        {label}
      </label>
    </span>
  );
}
