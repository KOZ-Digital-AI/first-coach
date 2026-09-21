import { QueryClient } from '@tanstack/react-query';
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
