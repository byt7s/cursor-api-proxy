import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cx } from "../utils";
import styles from "./SidebarNavItem.module.css";

export type SidebarNavItemProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  label: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  badge?: ReactNode;
};

/**
 * Anchor-based so hash routes stay keyboard operable and open in a new tab
 * like any normal link.
 */
export function SidebarNavItem({
  label,
  icon,
  active = false,
  badge,
  className,
  ...rest
}: SidebarNavItemProps) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={cx(styles.item, className)}
      {...rest}
    >
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.label}>{label}</span>
      {badge && <span className={styles.badge}>{badge}</span>}
    </a>
  );
}
