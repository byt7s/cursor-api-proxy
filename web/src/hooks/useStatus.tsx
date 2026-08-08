import { createContext, useContext, type ReactNode } from "react";

import { api } from "../lib/api";
import type { ProxyStatus } from "../lib/types";
import { useApiResource, type ApiResource } from "./useApiResource";
import { usePolling } from "./usePolling";
import { useSettings } from "./useSettings";

const StatusContext = createContext<ApiResource<ProxyStatus> | null>(null);

/** Single `/api/status` poller shared by the topbar and the Overview page. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const { poll } = useSettings();
  const resource = useApiResource<ProxyStatus>(() => api.status());
  usePolling(() => resource.reload(), poll.statusMs);
  return (
    <StatusContext.Provider value={resource}>{children}</StatusContext.Provider>
  );
}

export function useStatus(): ApiResource<ProxyStatus> {
  const context = useContext(StatusContext);
  if (!context) {
    throw new Error("useStatus must be used inside a <StatusProvider>");
  }
  return context;
}
