import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ToastProvider } from "../src/design-system";
import {
  DashboardKeyProvider,
  SettingsProvider,
  StatusProvider,
  ThemeProvider,
} from "../src/hooks";

type Options = { withStatus?: boolean };

function Providers({
  children,
  withStatus,
}: {
  children: ReactNode;
  withStatus: boolean;
}) {
  const inner = withStatus ? <StatusProvider>{children}</StatusProvider> : children;
  return (
    <ThemeProvider>
      <DashboardKeyProvider>
        <ToastProvider>
          <SettingsProvider>{inner}</SettingsProvider>
        </ToastProvider>
      </DashboardKeyProvider>
    </ThemeProvider>
  );
}

/** Renders a route or component inside the same provider stack as the app. */
export function renderWithProviders(
  ui: ReactElement,
  { withStatus = false }: Options = {},
): RenderResult {
  return render(
    <Providers withStatus={withStatus}>{ui}</Providers>,
  );
}
