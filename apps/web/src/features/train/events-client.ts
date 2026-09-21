/**
 * The ONE path the UI uses to send session events (drill done / undone, a result, session finished).
 *
 *   const event = makeEvent('drill_done', { sessionId, itemId });
 *   await submitEvents([event]);
 *
 * `submitEvents` POSTs the whole batch as a single request and writes the session the server returns into the React Query
 * cache under ['today']. Screens call only this module, so the offline slice can later route `submitEvents` through the
 * outbox without touching a screen.
 *
 * - `makeEvent(type, fields)`: a contract-valid SessionEvent. `clientUuid` is a lower-case UUID v4 (`crypto.randomUUID()`):
 *   the contract's ClientUuid is `z.uuid().toLowerCase()` (and the DB CHECK is a UUID GLOB), so a nanoid would be rejected.
 *   `at` is `new Date().toISOString()` (UTC, millisecond precision). `fields` is read, never mutated.
 * - `submitEvents(events)`: an empty batch rejects locally (the contract wants at least one) and sends nothing. The events
 *   are sent in the order given, as they are: never re-id'd or mutated, so resubmitting a batch after a failure is safe
 *   (the server is idempotent by clientUuid). The cache is set to the response's `session` exactly (replace, not merge); on
 *   any failure the ApiProblem is thrown unchanged and the cache is untouched. Concurrent submissions each write when their
 *   own response arrives, so the last response to arrive wins.
 * - The QueryClient is the app's one (created in main.tsx); this module never creates another. The default instance reads
 *   it lazily from `configureEventsClient({ queryClient })`, which the app calls once at start-up. Until then a submit
 *   rejects before any request is made.
 */
import { ENDPOINTS } from '@api-types/session';
import type { SessionEvent, SessionEventsResponse } from '@api-types/session';
import type { QueryClient } from '@tanstack/react-query';
import { api as defaultApi } from '../../lib/api';
import type { Api } from '../../lib/api';

/** The React Query key of today's session. */
export const TODAY_QUERY_KEY = ['today'] as const;

export type SessionEventType = SessionEvent['type'];
/** What the caller chooses: the session, and optionally the item and a value. The id, type and time are ours. */
export type SessionEventFields = Omit<SessionEvent, 'clientUuid' | 'type' | 'at'>;

export interface EventsClientDeps {
  api: Pick<Api, 'post'>;
  /** The app's QueryClient, or a function returning it (read at submit time, so it may be provided after creation). */
  queryClient: QueryClient | (() => QueryClient);
  /** Default: the current time. */
  now?: () => Date;
  /** Default: `crypto.randomUUID()`. Must return a lower-case UUID. */
  newId?: () => string;
}

export interface EventsClient {
  makeEvent(type: SessionEventType, fields: SessionEventFields): SessionEvent;
  submitEvents(events: readonly SessionEvent[]): Promise<SessionEventsResponse>;
}

export function createEventsClient(deps: EventsClientDeps): EventsClient {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const resolveQueryClient = typeof deps.queryClient === 'function' ? deps.queryClient : () => deps.queryClient as QueryClient;

  return {
    makeEvent(type, fields) {
      return { ...fields, type, clientUuid: newId(), at: now().toISOString() };
    },

    async submitEvents(events) {
      if (events.length === 0) throw new TypeError('submitEvents: at least one event is required');
      const queryClient = resolveQueryClient();
      const response = await deps.api.post(ENDPOINTS.postSessionEvents.path, {
        body: { events },
        schema: ENDPOINTS.postSessionEvents.response,
      });
      queryClient.setQueryData(TODAY_QUERY_KEY, response.session);
      return response;
    },
  };
}

let configuredQueryClient: QueryClient | undefined;

/** Called once by the app with its QueryClient (main.tsx). */
export function configureEventsClient({ queryClient }: { queryClient: QueryClient }): void {
  configuredQueryClient = queryClient;
}

const defaultClient = createEventsClient({
  api: defaultApi,
  queryClient: () => {
    if (configuredQueryClient === undefined) throw new Error('events client: call configureEventsClient({ queryClient }) before submitting events');
    return configuredQueryClient;
  },
});

export const makeEvent: EventsClient['makeEvent'] = (type, fields) => defaultClient.makeEvent(type, fields);
export const submitEvents: EventsClient['submitEvents'] = (events) => defaultClient.submitEvents(events);
