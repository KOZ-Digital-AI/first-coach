import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '../features/shell/Shell';

// The header and root extension slots (lib/slots.ts) are rendered by the shell, so later beads still add UI
// without editing this file.
function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({ component: RootLayout });
