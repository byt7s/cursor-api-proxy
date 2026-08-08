import type { ReactNode } from "react";

import { cx } from "../utils";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  brand: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  className?: string;
};

export function Sidebar({
  brand,
  children,
  footer,
  ariaLabel = "Dashboard sections",
  className,
}: SidebarProps) {
  return (
    <aside className={cx(styles.sidebar, className)}>
      <div className={styles.brand}>{brand}</div>
      <nav className={styles.nav} aria-label={ariaLabel}>
        {children}
      </nav>
      {footer && <div className={styles.footer}>{footer}</div>}
    </aside>
  );
}

export function SidebarSection({ label }: { label: string }) {
  return <div className={styles.sectionLabel}>{label}</div>;
}
