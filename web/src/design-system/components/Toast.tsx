import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Tone } from "../tokens";
import { cx } from "../utils";
import { IconButton } from "./IconButton";
import styles from "./Toast.module.css";

export type ToastOptions = {
  tone?: Tone;
  /** Milliseconds before auto-dismiss; `0` keeps the toast until dismissed. */
  duration?: number;
};

export type ToastRecord = ToastOptions & {
  id: number;
  message: ReactNode;
};

export type ToastApi = {
  toast: (message: ReactNode, options?: ToastOptions) => number;
  success: (message: ReactNode, options?: ToastOptions) => number;
  error: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
  toasts: ReadonlyArray<ToastRecord>;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: ReactNode, options: ToastOptions = {}) => {
      const id = nextId.current++;
      const duration = options.duration ?? DEFAULT_DURATION;
      setToasts((current) => [
        ...current,
        { id, message, tone: options.tone ?? "neutral", duration },
      ]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (message, options) =>
        toast(message, { tone: "success", ...options }),
      error: (message, options) =>
        toast(message, { tone: "danger", duration: 6000, ...options }),
      dismiss,
      toasts,
    }),
    [toast, dismiss, toasts],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.stack} aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            data-tone={item.tone}
            className={cx(styles.toast, styles[item.tone ?? "neutral"])}
          >
            <span className={styles.message}>{item.message}</span>
            <IconButton
              label="Dismiss notification"
              icon="✕"
              size="sm"
              onClick={() => dismiss(item.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside a <ToastProvider>");
  }
  return context;
}
