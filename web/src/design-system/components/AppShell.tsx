import type { ReactNode } from "react";

import { cx } from "../utils";
import styles from "./AppShell.module.css";
import { Container } from "./Container";

export type AppShellProps = {
  sidebar: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Sidebar + topbar + scrolling content frame for the whole dashboard. */
export function AppShell({
  sidebar,
  topbar,
  children,
  className,
}: AppShellProps) {
  return (
    <div className={cx(styles.shell, className)}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      {sidebar}
      <div className={styles.main}>
        {topbar}
        <main id="main-content" className={styles.content} tabIndex={-1}>
          <Container>{children}</Container>
        </main>
      </div>
    </div>
  );
}
