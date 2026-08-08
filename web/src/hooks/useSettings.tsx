import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const SETTINGS_STORAGE_KEY = "cursor-api-proxy.settings";

export type PollSettings = {
  statusMs: number;
  logMs: number;
  requestsMs: number;
  accountsMs: number;
};

export const DEFAULT_POLL_SETTINGS: PollSettings = {
  statusMs: 5000,
  logMs: 3000,
  requestsMs: 10_000,
  accountsMs: 30_000,
};

function readStored(): PollSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_POLL_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PollSettings>;
    return { ...DEFAULT_POLL_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_POLL_SETTINGS;
  }
}

type SettingsContextValue = {
  poll: PollSettings;
  setPoll: (next: Partial<PollSettings>) => void;
  resetPoll: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [poll, setPollState] = useState<PollSettings>(readStored);

  const persist = useCallback((next: PollSettings) => {
    setPollState(next);
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage disabled */
    }
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      poll,
      setPoll: (next) => persist({ ...poll, ...next }),
      resetPoll: () => persist(DEFAULT_POLL_SETTINGS),
    }),
    [poll, persist],
  );

  return (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used inside a <SettingsProvider>");
  }
  return context;
}
