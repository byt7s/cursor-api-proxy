import type { TextareaHTMLAttributes } from "react";

import { cx } from "../utils";
import { useFieldContext } from "./FormField";
import styles from "./Input.module.css";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
  invalid?: boolean;
};

export function Textarea({
  mono = false,
  invalid,
  className,
  id,
  "aria-describedby": describedBy,
  ...rest
}: TextareaProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      id={id ?? field?.controlId}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cx(
        styles.input,
        styles.textarea,
        mono && styles.mono,
        isInvalid && styles.invalid,
        className,
      )}
      {...rest}
    />
  );
}
