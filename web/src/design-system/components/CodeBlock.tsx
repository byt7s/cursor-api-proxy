import { cx } from "../utils";
import { Button } from "./Button";
import styles from "./CodeBlock.module.css";

export type CodeBlockProps = {
  code: string;
  className?: string;
  copyable?: boolean;
  label?: string;
};

export function CodeBlock({
  code,
  className,
  copyable = false,
  label,
}: CodeBlockProps) {
  return (
    <div className={cx(styles.root, className)}>
      <pre className={styles.pre} aria-label={label}>
        <code>{code}</code>
      </pre>
      {copyable && (
        <Button
          className={styles.copy}
          size="sm"
          variant="ghost"
          onClick={() => void navigator.clipboard?.writeText(code)}
        >
          Copy
        </Button>
      )}
    </div>
  );
}

export type InlineCodeProps = {
  children: string;
  className?: string;
};

export function InlineCode({ children, className }: InlineCodeProps) {
  return <code className={cx(styles.inline, className)}>{children}</code>;
}
