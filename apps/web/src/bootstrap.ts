import { QueryClient } from '@tanstack/react-query';
import { installSessionExpired } from './features/account/session-expired';
import { configureEventsClient } from './features/train/events-client';

/**
 * Creates the app's ONE QueryClient and hands it to the session events client, whose default instance rejects until
 * `configureEventsClient` has been called. main.tsx calls this once, before the first render.
 */
export function createAppQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  configureEventsClient({ queryClient });
  return queryClient;
}

let uninstallSessionExpired: (() => void) | undefined;

/**
 * Installs the app's ONE 401 handler (coach-area redirect to /account/sign-in, see features/account/session-expired.ts) with
 * the given client-side `navigate`, so the page (and its toast) survives instead of a full page load. main.tsx calls this once,
 * before the first render, with a navigate built from its router. Calling it again REPLACES the handler (never two at once).
 * Returns the function that uninstalls it. The player-route retry needs no installing: the app-wide `api` (lib/api.ts) has it.
 */
export function installAppSessionExpired(navigate: (url: string) => void): () => void {
  uninstallSessionExpired?.();
  const uninstall = installSessionExpired({ navigate });
  const mine = () => {
    uninstall();
    if (uninstallSessionExpired === mine) uninstallSessionExpired = undefined;
  };
  uninstallSessionExpired = mine;
  return mine;
}
