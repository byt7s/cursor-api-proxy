import {
  AppShell,
  Badge,
  IconButton,
  Sidebar,
  SidebarNavItem,
  SidebarSection,
  StatusDot,
  ToastProvider,
  Tooltip,
  Topbar,
} from "./design-system";
import {
  DashboardEventsProvider,
  DashboardKeyProvider,
  SettingsProvider,
  StatusProvider,
  ThemeProvider,
  useDashboardKey,
  useStatus,
  useTheme,
} from "./hooks";
import { formatDuration } from "./lib/format";
import { hrefFor, useHashRoute, type RouteId } from "./lib/router";
import { AccountsPage } from "./routes/AccountsPage";
import { AuditPage } from "./routes/AuditPage";
import { ConfigPage } from "./routes/ConfigPage";
import { DiagnosticsPage } from "./routes/DiagnosticsPage";
import { LogsPage } from "./routes/LogsPage";
import { OverviewPage } from "./routes/OverviewPage";
import { RequestsPage } from "./routes/RequestsPage";
import { SettingsPage } from "./routes/SettingsPage";
import { WikiPage } from "./routes/WikiPage";

type NavEntry = { route: RouteId; label: string; icon: string };

const NAV_SECTIONS: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: "Monitor",
    items: [
      { route: "overview", label: "Overview", icon: "◈" },
      { route: "requests", label: "Requests", icon: "⇄" },
      { route: "logs", label: "Logs", icon: "≡" },
    ],
  },
  {
    label: "Manage",
    items: [
      { route: "accounts", label: "Accounts", icon: "◍" },
      { route: "config", label: "Config", icon: "⚙" },
      { route: "diagnostics", label: "Diagnostics", icon: "✚" },
      { route: "audit", label: "Audit", icon: "⛨" },
    ],
  },
  {
    label: "Reference",
    items: [
      { route: "wiki", label: "Wiki", icon: "❏" },
      { route: "settings", label: "Settings", icon: "⋯" },
    ],
  },
];

function RouteView({ route }: { route: RouteId }) {
  switch (route) {
    case "accounts":
      return <AccountsPage />;
    case "requests":
      return <RequestsPage />;
    case "logs":
      return <LogsPage />;
    case "config":
      return <ConfigPage />;
    case "diagnostics":
      return <DiagnosticsPage />;
    case "audit":
      return <AuditPage />;
    case "wiki":
      return <WikiPage />;
    case "settings":
      return <SettingsPage />;
    case "overview":
    default:
      return <OverviewPage />;
  }
}

function Dashboard() {
  const { route, navigate } = useHashRoute();
  const { theme, toggleTheme } = useTheme();
  const { hasKey } = useDashboardKey();
  const status = useStatus();
  const running = status.data?.running ?? false;

  const summary = status.error
    ? "unreachable"
    : status.data
      ? `v${status.data.version} · PID ${status.data.pid ?? "—"} · :${status.data.port} · up ${formatDuration(status.data.uptimeSeconds)}`
      : "loading…";

  return (
    <AppShell
      sidebar={
        <Sidebar
          brand={
            <>
              <StatusDot
                tone={status.error ? "danger" : running ? "success" : "warning"}
                pulse={running}
              />
              <span>cursor-api-proxy</span>
            </>
          }
          footer={
            <>
              <a href="/healthz" target="_blank" rel="noreferrer">
                /healthz
              </a>
              <a href="/health" target="_blank" rel="noreferrer">
                /health
              </a>
              <a href="/accounts" target="_blank" rel="noreferrer">
                /accounts
              </a>
            </>
          }
        >
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              <SidebarSection label={section.label} />
              {section.items.map((item) => (
                <SidebarNavItem
                  key={item.route}
                  href={hrefFor(item.route)}
                  icon={item.icon}
                  label={item.label}
                  active={route === item.route}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(item.route);
                  }}
                />
              ))}
            </div>
          ))}
        </Sidebar>
      }
      topbar={
        <Topbar
          status={
            <StatusDot
              tone={status.error ? "danger" : running ? "success" : "warning"}
              label={
                status.error ? "unreachable" : running ? "running" : "stopped"
              }
            />
          }
          summary={summary}
          actions={
            <>
              <Tooltip
                label={
                  hasKey
                    ? "Dashboard key stored for this tab"
                    : "No dashboard key — loopback-only mutations"
                }
              >
                <Badge tone={hasKey ? "success" : "neutral"}>
                  {hasKey ? "key set" : "no key"}
                </Badge>
              </Tooltip>
              <IconButton
                label={
                  theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
                }
                icon={theme === "dark" ? "☾" : "☀"}
                onClick={toggleTheme}
              />
            </>
          }
        />
      }
    >
      <RouteView route={route} />
    </AppShell>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <DashboardKeyProvider>
        <ToastProvider>
          <SettingsProvider>
            <DashboardEventsProvider>
              <StatusProvider>
                <Dashboard />
              </StatusProvider>
            </DashboardEventsProvider>
          </SettingsProvider>
        </ToastProvider>
      </DashboardKeyProvider>
    </ThemeProvider>
  );
}
