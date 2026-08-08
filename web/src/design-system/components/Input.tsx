import type { InputHTMLAttributes } from "react";

import { cx } from "../utils";
import { useFieldContext } from "./FormField";
import styles from "./Input.module.css";

export type InputSize = "sm" | "md" | "lg";

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> & {
  inputSize?: InputSize;
  mono?: boolean;
  invalid?: boolean;
};

export function Input({
  inputSize = "md",
  mono = false,
  invalid,
  className,
  id,
  "aria-describedby": describedBy,
  ...rest
}: InputProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      id={id ?? field?.controlId}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      data-size={inputSize}
      className={cx(
        styles.input,
        styles[inputSize],
        mono && styles.mono,
        isInvalid && styles.invalid,
        className,
      )}
      {...rest}
    />
  );
}
