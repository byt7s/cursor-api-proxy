import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { readDashboardKey, writeDashboardKey } from "../lib/api";

type DashboardKeyContextValue = {
  dashboardKey: string;
  hasKey: boolean;
  saveKey: (key: string) => void;
  clearKey: () => void;
};

const DashboardKeyContext = createContext<DashboardKeyContextValue | null>(null);

/**
 * The Bearer key lives in `sessionStorage` (per tab, cleared on close) exactly
 * like the previous dashboard did; this provider keeps every consumer in sync.
 */
export function DashboardKeyProvider({ children }: { children: ReactNode }) {
  const [dashboardKey, setDashboardKey] = useState<string>(readDashboardKey);

  const saveKey = useCallback((key: string) => {
    const trimmed = key.trim();
    writeDashboardKey(trimmed);
    setDashboardKey(trimmed);
  }, []);

  const clearKey = useCallback(() => {
    writeDashboardKey("");
    setDashboardKey("");
  }, []);

  const value = useMemo<DashboardKeyContextValue>(
    () => ({
      dashboardKey,
      hasKey: dashboardKey.length > 0,
      saveKey,
      clearKey,
    }),
    [dashboardKey, saveKey, clearKey],
  );

  return (
    <DashboardKeyContext.Provider value={value}>
      {children}
    </DashboardKeyContext.Provider>
  );
}

export function useDashboardKey(): DashboardKeyContextValue {
  const context = useContext(DashboardKeyContext);
  if (!context) {
    throw new Error(
      "useDashboardKey must be used inside a <DashboardKeyProvider>",
    );
  }
  return context;
}
