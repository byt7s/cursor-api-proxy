import { createContext, useContext, useId, type ReactNode } from "react";

import { cx } from "../utils";
import styles from "./FormField.module.css";

type FieldContextValue = {
  controlId: string;
  describedBy?: string;
  invalid: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Controls inside a `FormField` read their id, `aria-describedby` and
 * `aria-invalid` from here, so label/help/error association is never forgotten.
 */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export type FormFieldProps = {
  label: ReactNode;
  children: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
};

export function FormField({
  label,
  children,
  help,
  error,
  required = false,
  htmlFor,
  className,
}: FormFieldProps) {
  const autoId = useId();
  const controlId = htmlFor ?? autoId;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;

  return (
    <FieldContext.Provider
      value={{ controlId, describedBy, invalid: Boolean(error) }}
    >
      <div className={cx(styles.field, className)}>
        <label className={styles.label} htmlFor={controlId}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
        </label>
        {children}
        {error ? (
          <p className={styles.error} id={errorId} role="alert">
            {error}
          </p>
        ) : (
          help && (
            <p className={styles.help} id={helpId}>
              {help}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}
