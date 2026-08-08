import { useCallback, useEffect, useState } from "react";

export const ROUTES = [
  "overview",
  "accounts",
  "requests",
  "logs",
  "config",
  "diagnostics",
  "audit",
  "wiki",
  "settings",
] as const;

export type RouteId = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: RouteId = "overview";

function isRoute(value: string): value is RouteId {
  return (ROUTES as ReadonlyArray<string>).includes(value);
}

export function parseHash(hash: string): RouteId {
  const cleaned = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return isRoute(cleaned) ? cleaned : DEFAULT_ROUTE;
}

export function hrefFor(route: RouteId): string {
  return `#/${route}`;
}

/**
 * Hash routing keeps the server to two HTML entry points (`/` and `/wiki`)
 * while still giving every section a linkable URL. `GET /wiki` serves the same
 * shell, so the pathname is translated into the wiki route on first load.
 */
export function initialRoute(): RouteId {
  if (typeof window === "undefined") return DEFAULT_ROUTE;
  if (window.location.hash) return parseHash(window.location.hash);
  if (window.location.pathname.replace(/\/$/, "") === "/wiki") return "wiki";
  return DEFAULT_ROUTE;
}

export function useHashRoute(): {
  route: RouteId;
  navigate: (route: RouteId) => void;
} {
  const [route, setRoute] = useState<RouteId>(initialRoute);

  useEffect(() => {
    function onHashChange(): void {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: RouteId) => {
    window.location.hash = hrefFor(next);
    setRoute(next);
  }, []);

  return { route, navigate };
}
