import { createContext, useContext, type ReactNode } from "react";

import { api } from "../lib/api";
import type { ProxyStatus } from "../lib/types";
import { useApiResource, type ApiResource } from "./useApiResource";
import { useDashboardEvents } from "./useDashboardEvents";
import { usePolling } from "./usePolling";
import { useSettings } from "./useSettings";

const StatusContext = createContext<ApiResource<ProxyStatus> | null>(null);

/** Single `/api/status` feed shared by the topbar and the Overview page. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const { poll } = useSettings();
  const resource = useApiResource<ProxyStatus>(() => api.status());
  const mode = useDashboardEvents({
    onStatus: () => {
      void resource.reload();
    },
  });
  usePolling(
    () => resource.reload(),
    poll.statusMs,
    mode !== "sse",
  );
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
