import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { createAppQueryClient } from './bootstrap';
// A separate statement: bootstrap.test.ts pins the exact `import { createAppQueryClient } from './bootstrap'` line.
import { installAppSessionExpired, wireAppPlayerSession } from './bootstrap';
import { routeTree } from './routeTree.gen';
import './styles/app.css';

const queryClient = createAppQueryClient();
// The offline pieces (outbox sync, persisted cache) follow the player session; see bootstrap.ts.
wireAppPlayerSession(queryClient);
const router = createRouter({ routeTree });
installAppSessionExpired((url) => void router.history.push(url));

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
