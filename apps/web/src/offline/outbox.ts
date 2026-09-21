/**
 * The offline outbox: session events wait here (IndexedDB) until they are delivered, and are replayed safely.
 *
 *   await enqueue(makeEvent('drill_done', { sessionId, itemId }));   // persisted first, sent later
 *   const result = await flush();                                     // ONE batch POST /api/player/session-events
 *   const stop = start();                                             // flush on app start, `online`, visibility change
 *   const waiting = await pendingCount();
 *
 * Replay is safe because the server is idempotent by clientUuid (ingestEvents: INSERT ... ON CONFLICT (client_uuid) DO
 * NOTHING): an event is never re-id'd or changed, so sending it again, whether after a lost response or after a crash
 * between "the server said 2xx" and "we deleted it", writes nothing twice.
 *
 * - `enqueue(event)`: validates the event with the shared contract (a bad one is refused, nothing is stored), then
 *   appends an OutboxEntry (`attempts: 0`) under the player's key `fc:<playerId>:outbox`. The same clientUuid twice is one
 *   entry. Enqueueing does not send; call `flush()`.
 * - `flush()`: reads ALL of the player's entries and sends them as ONE batch, in the order they were queued.
 *     2xx           the sent entries are removed (only those: an entry enqueued while the request was in flight stays).
 *     network / 5xx / any failure that is not a 4xx naming an entry / a 2xx whose body is not the contract response
 *                   every entry is kept unchanged, `attempts + 1`, `lastError` set; the result carries `retryInMs`
 *                   (`backoffMs(attempts)`). A 2xx that fails the response schema is NOT delivery: the SPA's index.html is
 *                   served with 200 for a missing API route, and losing a player's result is worse than a harmless re-send.
 *     4xx that NAMES an entry   only the named entries are dropped (they can never succeed: the server rejected them). A
 *                   4xx names an entry by a problem `errors[].pointer` of `/events/<index>` (index into the batch we sent)
 *                   or by its clientUuid appearing in the problem's `detail` / `title` / `errors[].detail` (how the server's
 *                   time-window rejection reports it). The survivors were not at fault (the server rolls the whole batch
 *                   back), so their attempts do not change and `retryInMs` is 0. A 4xx naming nothing (401, 404, 429, a bare
 *                   400) drops nothing and is charged like any failure. A 5xx never drops, whatever it names.
 *   Single-flight: while a flush is running, every `flush()` call returns that flush's result; a second request is never
 *   sent. Storage errors reject the flush (entries stay; whatever was sent is re-sent later, harmlessly).
 * - `start()`: flushes now (app start), on the window `online` event and on any `visibilitychange`, and returns `stop()`.
 *   After a failed flush it arms ONE retry timer after `retryInMs` (a rejected flush retries after a growing backoff too).
 *   Any trigger cancels the pending timer and flushes at once: connectivity coming back is not made to wait out a backoff.
 *
 * The 30-day offline window (OFFLINE_EVENT_MAX_AGE_DAYS) is enforced by the server; an event past it is rejected by a 4xx
 * that names it and is dropped then. The outbox never drops on its own clock (only a 4xx that names an entry drops one).
 *
 * The default instance (`enqueue`, `flush`, `start`, `pendingCount`) works for the player given to `configureOutbox`, read
 * at call time, so a sign-out / sign-in switches player without re-wiring `start()`. Until then every call rejects.
 * `createOutbox(deps)` is the same thing with injected collaborators (tests inject a fake IDB, `api` and timers).
 */
import { ENDPOINTS, SessionEvent } from '@api-types/session';
import { get as idbGet, update as idbUpdate } from 'idb-keyval';
import { api as defaultApi } from '../lib/api';
import type { Api } from '../lib/api';
import { isApiProblem } from '../lib/problem';
import type { ApiProblem } from '../lib/problem';
import { OutboxEntry, playerKeys } from './types';

// --- backoff ---------------------------------------------------------------------------------------------------------------

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** How long to wait before retrying after `attempts` failed sends: 2 s, 4 s, 8 s, ... capped at 5 minutes. No jitter. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (Math.max(1, attempts) - 1));
}

// --- storage seam ----------------------------------------------------------------------------------------------------------

/**
 * The part of IndexedDB the outbox needs. `update` is a per-key atomic read-modify-write (idb-keyval's `update` is exactly
 * that: one readwrite transaction), so an enqueue can never be lost to a concurrent removal.
 */
export interface OutboxStorage {
  get(key: string): Promise<unknown>;
  update(key: string, updater: (old: unknown) => unknown): Promise<void>;
}

const idbStorage: OutboxStorage = {
  get: (key) => idbGet(key),
  update: (key, updater) => idbUpdate(key, updater),
};

/** The valid entries of a stored value. A row that is not a valid OutboxEntry cannot be sent, so it is not counted or sent. */
function parseEntries(stored: unknown): OutboxEntry[] {
  if (!Array.isArray(stored)) return [];
  const entries: OutboxEntry[] = [];
  for (const row of stored) {
    const parsed = OutboxEntry.safeParse(row);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

// --- types -------------------------------------------------------------------------------------------------------------------

export interface FlushResult {
  /** 'empty': nothing queued, nothing sent. 'sent': the batch was delivered. 'failed': it was not (see `kept`, `dropped`). */
  outcome: 'empty' | 'sent' | 'failed';
  /** Events delivered (removed on 2xx). */
  sent: number;
  /** Events dropped because a 4xx named them. */
  dropped: number;
  /** Events of this batch still queued after the flush. */
  kept: number;
  /** When to retry (ms), set only when something of this batch is still queued after a failure. */
  retryInMs?: number;
}

export interface StartTargets {
  /** Emits `online`. Default: the global `window`, when there is one. */
  window?: EventTarget;
  /** Emits `visibilitychange`. Default: the global `document`, when there is one. */
  document?: EventTarget;
}

export interface Outbox {
  enqueue(event: SessionEvent): Promise<void>;
  flush(): Promise<FlushResult>;
  start(targets?: StartTargets): () => void;
  pendingCount(): Promise<number>;
}

export interface OutboxDeps {
  /** The player whose events these are, or a function returning it (read at call time). */
  playerId: string | (() => string);
  /** Default: the app's api wrapper. */
  api?: Pick<Api, 'post'>;
  /** Default: idb-keyval (IndexedDB). */
  storage?: OutboxStorage;
  /** Default: the current time. */
  now?: () => Date;
  /** Runs `run` after `ms` and returns a cancel function. Default: setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
}

// --- failure reading -------------------------------------------------------------------------------------------------------

const POINTER = /^\/events\/(\d+)(?:\/|$)/;

/** The clientUuids a 4xx problem names (see the module header). Empty for anything that is not a 4xx. */
function namedBy(error: ApiProblem, batch: readonly OutboxEntry[]): Set<string> {
  const named = new Set<string>();
  if (error.status === undefined || error.status < 400 || error.status > 499) return named;
  const problem = error.problem;
  const errors = problem?.errors ?? [];
  for (const { pointer } of errors) {
    const index = POINTER.exec(pointer)?.[1];
    const entry = index === undefined ? undefined : batch[Number(index)];
    if (entry !== undefined) named.add(entry.clientUuid);
  }
  const texts = [problem?.detail, problem?.title, ...errors.map((e) => e.detail)].filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  for (const { clientUuid } of batch) {
    if (texts.some((text) => text.includes(clientUuid.toLowerCase()))) named.add(clientUuid);
  }
  return named;
}

function describeFailure(error: unknown): string {
  const text = isApiProblem(error) ? `${error.kind}${error.status === undefined ? '' : ` ${error.status}`}: ${error.message}` : error instanceof Error ? error.message : String(error);
  return (text === '' ? 'unknown error' : text).slice(0, 200);
}

// --- the outbox ----------------------------------------------------------------------------------------------------------------

export function createOutbox(deps: OutboxDeps): Outbox {
  const api = deps.api ?? defaultApi;
  const storage = deps.storage ?? idbStorage;
  const now = deps.now ?? (() => new Date());
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    });
  const resolvePlayer = typeof deps.playerId === 'function' ? deps.playerId : () => deps.playerId as string;

  /** One in-flight flush per player. */
  const inFlight = new Map<string, Promise<FlushResult>>();

  async function send(playerId: string): Promise<FlushResult> {
    const key = playerKeys(playerId).outbox;
    const batch = parseEntries(await storage.get(key));
    if (batch.length === 0) return { outcome: 'empty', sent: 0, dropped: 0, kept: 0 };
    const sentIds = new Set(batch.map((entry) => entry.clientUuid));
    const events = batch.map((entry) => entry.event);

    let failure: unknown;
    try {
      await api.post(ENDPOINTS.postSessionEvents.path, { body: { events }, schema: ENDPOINTS.postSessionEvents.response });
    } catch (error) {
      failure = error;
    }

    if (failure === undefined) {
      // Only what was sent goes: entries enqueued while the request was in flight stay queued.
      await storage.update(key, (old) => parseEntries(old).filter((entry) => !sentIds.has(entry.clientUuid)));
      return { outcome: 'sent', sent: batch.length, dropped: 0, kept: 0 };
    }

    const named = isApiProblem(failure) ? namedBy(failure, batch) : new Set<string>();
    if (named.size > 0) {
      await storage.update(key, (old) => parseEntries(old).filter((entry) => !named.has(entry.clientUuid)));
      const kept = batch.length - named.size;
      return { outcome: 'failed', sent: 0, dropped: named.size, kept, ...(kept > 0 && { retryInMs: 0 }) };
    }

    const lastError = describeFailure(failure);
    let attempts = 0;
    await storage.update(key, (old) =>
      parseEntries(old).map((entry) => {
        if (!sentIds.has(entry.clientUuid)) return entry;
        attempts = Math.max(attempts, entry.attempts + 1);
        return { ...entry, attempts: entry.attempts + 1, lastError };
      }),
    );
    return { outcome: 'failed', sent: 0, dropped: 0, kept: batch.length, retryInMs: backoffMs(attempts) };
  }

  async function flush(): Promise<FlushResult> {
    const playerId = resolvePlayer();
    const running = inFlight.get(playerId);
    if (running !== undefined) return running;
    const flight = send(playerId).finally(() => {
      inFlight.delete(playerId);
    });
    inFlight.set(playerId, flight);
    return flight;
  }

  async function enqueue(event: SessionEvent): Promise<void> {
    const playerId = resolvePlayer();
    const valid = SessionEvent.parse(event);
    const entry: OutboxEntry = { clientUuid: valid.clientUuid, playerId, event: valid, createdAt: now().toISOString(), attempts: 0 };
    await storage.update(playerKeys(playerId).outbox, (old) => {
      const entries = parseEntries(old);
      return entries.some((existing) => existing.clientUuid === entry.clientUuid) ? entries : [...entries, entry];
    });
  }

  async function pendingCount(): Promise<number> {
    return parseEntries(await storage.get(playerKeys(resolvePlayer()).outbox)).length;
  }

  function start(targets: StartTargets = {}): () => void {
    const win = targets.window ?? (typeof window === 'undefined' ? undefined : window);
    const doc = targets.document ?? (typeof document === 'undefined' ? undefined : document);
    let stopped = false;
    let cancelRetry: (() => void) | undefined;
    let rejections = 0;

    const arm = (ms: number): void => {
      cancelRetry?.();
      cancelRetry = schedule(() => {
        cancelRetry = undefined;
        trigger();
      }, ms);
    };

    function trigger(): void {
      if (stopped) return;
      cancelRetry?.();
      cancelRetry = undefined;
      flush().then(
        (result) => {
          rejections = 0;
          if (!stopped && result.retryInMs !== undefined) arm(result.retryInMs);
        },
        () => {
          // Storage (or an unset player) failed: nothing was recorded, so back off on our own count.
          rejections += 1;
          if (!stopped) arm(backoffMs(rejections));
        },
      );
    }

    win?.addEventListener('online', trigger);
    doc?.addEventListener('visibilitychange', trigger);
    trigger();

    return () => {
      stopped = true;
      cancelRetry?.();
      cancelRetry = undefined;
      win?.removeEventListener('online', trigger);
      doc?.removeEventListener('visibilitychange', trigger);
    };
  }

  return { enqueue, flush, start, pendingCount };
}

// --- default instance ----------------------------------------------------------------------------------------------------------

let configuredPlayerId: string | undefined;

/** Called by the app with the signed-in player's id (and again, on sign-out / sign-in, with the next one). */
export function configureOutbox({ playerId }: { playerId: string | undefined }): void {
  configuredPlayerId = playerId;
}

const defaultOutbox = createOutbox({
  playerId: () => {
    if (configuredPlayerId === undefined || configuredPlayerId === '') throw new Error('outbox: call configureOutbox({ playerId }) before using the outbox');
    return configuredPlayerId;
  },
});

export const enqueue: Outbox['enqueue'] = (event) => defaultOutbox.enqueue(event);
export const flush: Outbox['flush'] = () => defaultOutbox.flush();
export const start: Outbox['start'] = (targets) => defaultOutbox.start(targets);
export const pendingCount: Outbox['pendingCount'] = () => defaultOutbox.pendingCount();
