import { useState } from "react";

import { IconButton } from "./IconButton";
import { Input, type InputProps } from "./Input";
import styles from "./Input.module.css";

export type PasswordInputProps = Omit<InputProps, "type"> & {
  /** Hide the reveal control for values that must never be shown (raw keys). */
  allowReveal?: boolean;
};

/** Masked text input with an optional reveal toggle. */
export function PasswordInput({
  allowReveal = true,
  ...rest
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className={styles.wrapper}>
      <Input
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        mono
        {...rest}
      />
      {allowReveal && (
        <IconButton
          className={styles.reveal}
          size={rest.inputSize ?? "md"}
          label={revealed ? "Hide value" : "Show value"}
          aria-pressed={revealed}
          icon={revealed ? "◎" : "◉"}
          onClick={() => setRevealed((v) => !v)}
        />
      )}
    </span>
  );
}
