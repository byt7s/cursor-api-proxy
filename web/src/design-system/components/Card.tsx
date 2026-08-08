import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Card.module.css";

export type CardProps = HTMLAttributes<HTMLElement>;

export function Card({ className, ...rest }: CardProps) {
  return <section className={cx(styles.card, className)} {...rest} />;
}

export type CardHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

export function CardHeader({
  title,
  description,
  actions,
  className,
  ...rest
}: CardHeaderProps) {
  return (
    <div className={cx(styles.header, className)} {...rest}>
      <div className={styles.titleGroup}>
        <h2 className={styles.title}>{title}</h2>
        {description && <span className={styles.description}>{description}</span>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

export type CardBodyProps = HTMLAttributes<HTMLDivElement> & {
  /** Removes padding so tables and log viewers can bleed to the card edges. */
  flush?: boolean;
};

export function CardBody({ flush = false, className, ...rest }: CardBodyProps) {
  return (
    <div
      className={cx(styles.body, flush && styles.flush, className)}
      {...rest}
    />
  );
}

export function CardFooter({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
