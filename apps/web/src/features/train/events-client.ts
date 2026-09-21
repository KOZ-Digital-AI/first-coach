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
 * - Summary (fc-mol-urn.10): right after the ['today'] write, the same successful response is also written to the in-memory key
 *   ['session-summary'] (SESSION_SUMMARY_QUERY_KEY) as { progress, nextSessionDate, sessionId } (sessionId = response.session.id,
 *   the server's id), replaced not merged; a failed or invalid response writes neither. It is what /train/summary reads. The key
 *   is deliberately NOT in the persisted cache allow-list (lib/query-persist.ts), so a reload starts without one. Any batch
 *   writes it (a drill_done response carries progress too), so the summary screen also checks that the session is finished.
 * - Offline (fc-mol-eay.5): with `deps.offline` and a player, `submitEvents` goes through the outbox (offline/outbox.ts) instead of
 *   POSTing directly, so a failed or offline send loses nothing:
 *     1. every event is validated (a bad one rejects the whole batch, nothing is stored), then `enqueue`d (persisted, keyed by its
 *        clientUuid: resubmitting the same event is one entry and it is never re-id'd);
 *     2. each event is applied locally: to the offline session store (drill_done / drill_undone flip `done`) and, the same way, to
 *        the ['today'] cache; a `session_finished` for the cached session also writes an ESTIMATED ['session-summary'] (below);
 *     3. `outbox.flush()` sends everything that waits as ONE batch. A delivered batch writes the server's answer to ['today'] and
 *        ['session-summary'] exactly like the direct path (replace, not merge), wherever the flush was started (`client.outbox
 *        .start()` included: coming back online writes the caches too).
 *   The result is the server response plus `status: 'sent'` once every event of THIS call was delivered, or `{ status: 'queued' }`
 *   (no session / progress) when it was not (offline, 5xx, a non-contract 2xx): the caller may carry on, the event is safe on the
 *   device and is sent later. It rejects only for a bad batch (empty / invalid event / storage failure) and when the server refuses
 *   it for good (a 4xx that names the events and leaves nothing queued): then with that ApiProblem, unchanged.
 *   The estimated summary (offline finish): no progress is stored on the device, so it is built from the last ['session-summary']
 *   in the cache (else zeros): sessionsCompleted + 1, minutesTrained + the session's done drills' minutes (not when that summary
 *   is already of this session: its minutes are counted), streakDays at least 1, nextSessionDate the cached one if it is after the
 *   session's date, else the next calendar day. Written once per session; the server's answer replaces it when it arrives.
 *   Without `deps.offline`, or while its `playerId` is undefined, the direct path above is used unchanged.
 * - The QueryClient is the app's one (created in main.tsx); this module never creates another. The default instance reads
 *   it lazily from `configureEventsClient({ queryClient })`, which the app calls once at start-up. Until then a submit
 *   rejects before any request is made.
 */
import { ENDPOINTS, SessionEvent as SessionEventSchema, SessionEventsResponse as SessionEventsResponseSchema } from '@api-types/session';
import type { SessionEvent, SessionEventsResponse, SessionProgress, TodaySession } from '@api-types/session';
import type { QueryClient } from '@tanstack/react-query';
import { api as defaultApi } from '../../lib/api';
import type { Api } from '../../lib/api';
import { createOutbox } from '../../offline/outbox';
import type { Outbox, OutboxDeps } from '../../offline/outbox';
import { applyLocalEvent as defaultApplyLocalEvent } from '../../offline/session-store';
import type { SessionStore } from '../../offline/session-store';

/** The React Query key of today's session. */
export const TODAY_QUERY_KEY = ['today'] as const;

/** The React Query key of the last accepted response's summary (in memory only, never persisted). */
export const SESSION_SUMMARY_QUERY_KEY = ['session-summary'] as const;

/** What `submitEvents` caches under SESSION_SUMMARY_QUERY_KEY. */
export interface SessionSummary {
  progress: SessionProgress;
  nextSessionDate: SessionEventsResponse['nextSessionDate'];
  /** The server's id of the session the response describes (`response.session.id`). */
  sessionId: string;
}

export type SessionEventType = SessionEvent['type'];
/** What the caller chooses: the session, and optionally the item and a value. The id, type and time are ours. */
export type SessionEventFields = Omit<SessionEvent, 'clientUuid' | 'type' | 'at'>;

/** What `submitEvents` resolves with when the batch was NOT delivered yet: it is safe in the outbox and will be sent later. */
export interface QueuedSubmit {
  status: 'queued';
  session?: undefined;
  progress?: undefined;
  nextSessionDate?: undefined;
}

/** The server's answer (`status: 'sent'` through the outbox, absent on the direct path), or `{ status: 'queued' }`. */
export type SubmitResult = (SessionEventsResponse & { status?: 'sent' }) | QueuedSubmit;

export interface OfflineDeps {
  /** The player whose outbox this is (read at every submit); `undefined` means "no player": the direct path is used. */
  playerId: string | undefined | (() => string | undefined);
  /** Default: IndexedDB (the outbox's own default). */
  storage?: OutboxDeps['storage'];
  /** Default: the device's offline session store. */
  sessionStore?: Pick<SessionStore, 'applyLocalEvent'>;
  /** Default: setTimeout (the outbox's retry timer, used by `outbox.start()`). */
  schedule?: OutboxDeps['schedule'];
}

export interface EventsClientDeps {
  api: Pick<Api, 'post'>;
  /** The app's QueryClient, or a function returning it (read at submit time, so it may be provided after creation). */
  queryClient: QueryClient | (() => QueryClient);
  /** Default: the current time. */
  now?: () => Date;
  /** Default: `crypto.randomUUID()`. Must return a lower-case UUID. */
  newId?: () => string;
  /** Route submits through the offline outbox (see the module header). */
  offline?: OfflineDeps;
}

export interface EventsClient {
  makeEvent(type: SessionEventType, fields: SessionEventFields): SessionEvent;
  submitEvents(events: readonly SessionEvent[]): Promise<SubmitResult>;
  /** The outbox behind `submitEvents` (only with `deps.offline`): `outbox.start()` replays it, writing the caches on delivery. */
  outbox?: Outbox;
}

// --- cache writes ---------------------------------------------------------------------------------------------------------

/** The server's answer: the session and the summary, both replaced (not merged). */
function writeServerAnswer(queryClient: QueryClient, response: SessionEventsResponse): void {
  queryClient.setQueryData(TODAY_QUERY_KEY, response.session);
  const summary: SessionSummary = { progress: response.progress, nextSessionDate: response.nextSessionDate, sessionId: response.session.id };
  queryClient.setQueryData(SESSION_SUMMARY_QUERY_KEY, summary);
}

/** `2026-09-21` -> `2026-09-22` (a calendar day: UTC keeps the arithmetic off the device's time zone). */
function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** How many rounds one submit may flush: 1 normally, more when other events were enqueued while a flush was in flight. */
const MAX_FLUSH_ROUNDS = 5;

export function createEventsClient(deps: EventsClientDeps): EventsClient {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const resolveQueryClient = typeof deps.queryClient === 'function' ? deps.queryClient : () => deps.queryClient as QueryClient;

  const offline = deps.offline;
  const resolvePlayer = (): string | undefined => {
    if (offline === undefined) return undefined;
    const playerId = typeof offline.playerId === 'function' ? offline.playerId() : offline.playerId;
    return playerId === '' ? undefined : playerId;
  };
  const applyLocalEvent = offline?.sessionStore?.applyLocalEvent.bind(offline.sessionStore) ?? defaultApplyLocalEvent;

  /** Who wants to know what the outbox's requests did (one per submit in progress). */
  interface Watcher {
    delivered(events: readonly SessionEvent[], response: SessionEventsResponse): void;
    failed(events: readonly SessionEvent[], error: unknown): void;
  }
  const watchers = new Set<Watcher>();

  // The outbox posts through this: the same api, but a delivered answer is written to the caches and reported to the submits waiting.
  const watchedApi = {
    post: (async (path: string, options: { body?: unknown; schema: never }) => {
      const events = (options.body as { events: SessionEvent[] }).events;
      let response: unknown;
      try {
        response = await deps.api.post(path, options);
      } catch (error) {
        for (const watcher of [...watchers]) watcher.failed(events, error);
        throw error;
      }
      const parsed = SessionEventsResponseSchema.safeParse(response);
      if (parsed.success) {
        try {
          writeServerAnswer(resolveQueryClient(), parsed.data);
        } catch {
          // A cache that cannot be written must not turn a delivered batch into a failed one (it would only be re-sent).
        }
        for (const watcher of [...watchers]) watcher.delivered(events, parsed.data);
      }
      return response;
    }) as Api['post'],
  };

  const outbox =
    offline === undefined
      ? undefined
      : createOutbox({
          playerId: () => {
            const playerId = resolvePlayer();
            if (playerId === undefined) throw new Error('events client: no player configured for the outbox');
            return playerId;
          },
          api: watchedApi,
          now,
          ...(offline.storage !== undefined && { storage: offline.storage }),
          ...(offline.schedule !== undefined && { schedule: offline.schedule }),
        });

  /** Session ids whose finish already counted in an estimated summary. */
  const estimated = new Set<string>();

  function applyLocally(queryClient: QueryClient, playerId: string, events: readonly SessionEvent[]): void {
    let today = queryClient.getQueryData<TodaySession>(TODAY_QUERY_KEY);
    let flipped = false;
    for (const event of events) {
      try {
        applyLocalEvent(event, playerId);
      } catch {
        // The event is already safe in the outbox; a device that cannot save the offline copy still trains on the ['today'] cache.
      }
      const done = event.type === 'drill_done' ? true : event.type === 'drill_undone' ? false : undefined;
      if (done === undefined || today === undefined || today.id !== event.sessionId) continue;
      const item = today.items.find((candidate) => candidate.itemId === event.itemId);
      if (item === undefined || item.done === done) continue;
      today = { ...today, items: today.items.map((candidate) => (candidate === item ? { ...candidate, done } : candidate)) };
      flipped = true;
    }
    if (flipped) queryClient.setQueryData(TODAY_QUERY_KEY, today);

    const finished = events.some((event) => event.type === 'session_finished' && event.sessionId === today?.id);
    if (finished && today !== undefined && !estimated.has(today.id)) {
      estimated.add(today.id);
      const previous = queryClient.getQueryData<SessionSummary>(SESSION_SUMMARY_QUERY_KEY);
      const progress = SessionEventsResponseSchema.shape.progress.safeParse(previous?.progress);
      const known = progress.success ? progress.data : { sessionsCompleted: 0, minutesTrained: 0, streakDays: 0 };
      const doneMinutes = today.items.reduce((sum, item) => sum + (item.done ? item.minutes : 0), 0);
      const nextKnown = SessionEventsResponseSchema.shape.nextSessionDate.safeParse(previous?.nextSessionDate);
      const summary: SessionSummary = {
        progress: {
          sessionsCompleted: known.sessionsCompleted + 1,
          minutesTrained: known.minutesTrained + (previous?.sessionId === today.id ? 0 : doneMinutes),
          streakDays: Math.max(known.streakDays, 1),
        },
        nextSessionDate: nextKnown.success && nextKnown.data > today.date ? nextKnown.data : nextDay(today.date),
        sessionId: today.id,
      };
      queryClient.setQueryData(SESSION_SUMMARY_QUERY_KEY, summary);
    }
  }

  async function submitThroughOutbox(queryClient: QueryClient, playerId: string, events: readonly SessionEvent[]): Promise<SubmitResult> {
    if (outbox === undefined) throw new Error('events client: no outbox');
    for (const event of events) SessionEventSchema.parse(event);
    for (const event of events) await outbox.enqueue(event);
    applyLocally(queryClient, playerId, events);

    // Wait for THIS call's events only: another submit's events may be flushed in the same or the next batch.
    const remaining = new Set(events.map((event) => event.clientUuid));
    let answer: SessionEventsResponse | undefined;
    let failure: unknown;
    const watcher: Watcher = {
      delivered(sent, response) {
        let mine = false;
        for (const { clientUuid } of sent) mine = remaining.delete(clientUuid) || mine;
        if (mine) answer = response;
      },
      failed(sent, error) {
        if (sent.some(({ clientUuid }) => remaining.has(clientUuid))) failure = error;
      },
    };
    watchers.add(watcher);
    try {
      let last: Awaited<ReturnType<Outbox['flush']>> | undefined;
      for (let round = 0; round < MAX_FLUSH_ROUNDS && remaining.size > 0; round += 1) {
        last = await outbox.flush();
        if (last.outcome === 'empty') break;
        // 'failed' with survivors of a partial 4xx is retried at once (they were not at fault); any other failure waits for the outbox.
        if (last.outcome === 'failed' && !(last.dropped > 0 && last.kept > 0)) break;
      }
      if (remaining.size === 0 && answer !== undefined) return { ...answer, status: 'sent' };
      // The server refused the batch for good (a 4xx named it) and nothing is left queued: that is an error, not "later".
      if (last?.outcome === 'failed' && last.dropped > 0 && failure !== undefined && (await outbox.pendingCount()) === 0) throw failure;
      return { status: 'queued' };
    } finally {
      watchers.delete(watcher);
    }
  }

  return {
    makeEvent(type, fields) {
      return { ...fields, type, clientUuid: newId(), at: now().toISOString() };
    },

    async submitEvents(events) {
      if (events.length === 0) throw new TypeError('submitEvents: at least one event is required');
      const queryClient = resolveQueryClient();
      const playerId = resolvePlayer();
      if (playerId !== undefined) return submitThroughOutbox(queryClient, playerId, events);

      const response = await deps.api.post(ENDPOINTS.postSessionEvents.path, {
        body: { events },
        schema: ENDPOINTS.postSessionEvents.response,
      });
      writeServerAnswer(queryClient, response);
      return response;
    },

    ...(outbox !== undefined && { outbox }),
  };
}

let configuredQueryClient: QueryClient | undefined;

let configuredPlayerId: string | undefined;

/** Called once by the app with its QueryClient (main.tsx). */
export function configureEventsClient({ queryClient }: { queryClient: QueryClient }): void {
  configuredQueryClient = queryClient;
}

/**
 * Called by the app with the signed-in player's id (and again, on sign-out / sign-in, with the next one or `undefined`). While
 * there is one, the default `submitEvents` goes through the offline outbox; until then it POSTs directly, as before.
 */
export function configureEventsPlayer(playerId: string | undefined): void {
  configuredPlayerId = playerId;
}

const defaultClient = createEventsClient({
  api: defaultApi,
  queryClient: () => {
    if (configuredQueryClient === undefined) throw new Error('events client: call configureEventsClient({ queryClient }) before submitting events');
    return configuredQueryClient;
  },
  offline: { playerId: () => configuredPlayerId },
});

/** The default client's outbox: `startEventsSync()` replays it on app start / `online` / visibility change, filling the caches on delivery. */
export const startEventsSync: Outbox['start'] = (targets) => defaultClient.outbox?.start(targets) ?? (() => {});

export const makeEvent: EventsClient['makeEvent'] = (type, fields) => defaultClient.makeEvent(type, fields);
export const submitEvents: EventsClient['submitEvents'] = (events) => defaultClient.submitEvents(events);
