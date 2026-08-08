import { Fragment, type ReactNode } from "react";

import { cx } from "../utils";
import styles from "./KeyValueList.module.css";

export type KeyValueItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
};

export type KeyValueListProps = {
  items: ReadonlyArray<KeyValueItem>;
  className?: string;
};

export function KeyValueList({ items, className }: KeyValueListProps) {
  return (
    <dl className={cx(styles.list, className)}>
      {items.map((item) => (
        <Fragment key={item.key}>
          <dt className={styles.term}>{item.label}</dt>
          <dd className={cx(styles.value, item.mono && styles.mono)}>
            {item.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
