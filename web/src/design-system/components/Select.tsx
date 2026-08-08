import type { SelectHTMLAttributes } from "react";

import { cx } from "../utils";
import { useFieldContext } from "./FormField";
import styles from "./Select.module.css";

export type SelectOption<T extends string | number = string> = {
  value: T;
  label: string;
};

export type SelectProps<T extends string | number = string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "size" | "onChange" | "value"
> & {
  options: ReadonlyArray<SelectOption<T>>;
  value?: T;
  onValueChange?: (value: string) => void;
  selectSize?: "sm" | "md" | "lg";
  autoWidth?: boolean;
};

export function Select<T extends string | number = string>({
  options,
  value,
  onValueChange,
  selectSize = "md",
  autoWidth = false,
  className,
  id,
  "aria-describedby": describedBy,
  ...rest
}: SelectProps<T>) {
  const field = useFieldContext();
  return (
    <span className={cx(styles.wrapper, autoWidth && styles.auto)}>
      <select
        id={id ?? field?.controlId}
        aria-describedby={describedBy ?? field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        value={value}
        onChange={(event) => onValueChange?.(event.target.value)}
        data-size={selectSize}
        className={cx(
          styles.select,
          styles[selectSize],
          autoWidth && styles.auto,
          className,
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className={styles.chevron} aria-hidden="true">
        ▾
      </span>
    </span>
  );
}
