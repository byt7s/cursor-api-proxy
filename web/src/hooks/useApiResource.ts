import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "../lib/api";

export type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** True until the first settled response, so pages can show skeletons once. */
  initial: boolean;
};

export type ApiResource<T> = AsyncState<T> & {
  reload: () => Promise<void>;
  setData: (data: T | null) => void;
};

export type UseApiResourceOptions = {
  /** Skip the automatic first load (used by on-demand actions like doctor). */
  enabled?: boolean;
};

/**
 * Runs an async loader, tracking loading/error/initial state and ignoring
 * responses that arrive after the component unmounted.
 */
export function useApiResource<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  options: UseApiResourceOptions = {},
): ApiResource<T> {
  const { enabled = true } = options;
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: enabled,
    initial: true,
  });
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await loaderRef.current();
      if (!mounted.current) return;
      setState({ data, error: null, loading: false, initial: false });
    } catch (error) {
      if (!mounted.current) return;
      setState((current) => ({
        data: current.data,
        error: errorMessage(error),
        loading: false,
        initial: false,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...deps]);

  const setData = useCallback((data: T | null) => {
    setState((current) => ({ ...current, data, initial: false }));
  }, []);

  return { ...state, reload, setData };
}
