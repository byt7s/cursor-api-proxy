import { useCallback, useState } from "react";

import { errorMessage } from "../lib/api";
import { useToast } from "../design-system";

export type AsyncActionOptions = {
  successMessage?: string | ((result: unknown) => string);
  errorPrefix?: string;
  onSuccess?: () => void | Promise<void>;
};

/**
 * Wraps a mutating call with pending state plus success/error toasts, so every
 * action in the dashboard reports the same way.
 */
export function useAsyncAction(): {
  pending: boolean;
  run: <T>(
    action: () => Promise<T>,
    options?: AsyncActionOptions,
  ) => Promise<T | null>;
} {
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const run = useCallback(
    async <T,>(
      action: () => Promise<T>,
      options: AsyncActionOptions = {},
    ): Promise<T | null> => {
      setPending(true);
      try {
        const result = await action();
        const message =
          typeof options.successMessage === "function"
            ? options.successMessage(result)
            : options.successMessage;
        if (message) toast.success(message);
        await options.onSuccess?.();
        return result;
      } catch (error) {
        const prefix = options.errorPrefix ? `${options.errorPrefix}: ` : "";
        toast.error(`${prefix}${errorMessage(error)}`);
        return null;
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

  return { pending, run };
}
