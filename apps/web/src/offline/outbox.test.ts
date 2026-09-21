import { afterEach, describe, expect, test } from 'bun:test';
import { ENDPOINTS, SessionEvent } from '@api-types/session';
import { createApi } from '../lib/api';
import type { FetchLike } from '../lib/api';
import { backoffMs, configureOutbox, createOutbox, enqueue as defaultEnqueue, flush as defaultFlush, pendingCount as defaultPendingCount, start as defaultStart } from './outbox';
import type { OutboxStorage } from './outbox';
import { OutboxEntry, playerKeys } from './types';

// The outbox is tested through its real collaborators wherever possible: the real `createApi` wrapper drives a FAKE FETCH
// that behaves like the server (idempotent by clientUuid, so a re-send is a counted duplicate, never a second write), and
// storage is a FAKE IDB (an async, structured-cloning, per-key-atomic Map with a hook to fail one write). No timers: the
// backoff scheduler is a fake that records what was scheduled. `start()` is driven with the real window/document events
// (happy-dom is preloaded when this runs from apps/web).

const PLAYER = 'player-1';
const SESSION_ID = 's-2026-09-21';
const OUTBOX_KEY = playerKeys(PLAYER).outbox;
const SEND_PATH = ENDPOINTS.postSessionEvents.path;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ev = (n: number, patch: Partial<SessionEvent> = {}): SessionEvent => ({
  clientUuid: uuid(n),
  sessionId: SESSION_ID,
  type: 'drill_done',
  itemId: `item-${n}`,
  at: `2026-09-21T10:${String(n).padStart(2, '0')}:00.000Z`,
  ...patch,
});

const makeSessionJson = (): Record<string, unknown> => ({
  id: SESSION_ID,
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 20,
  graphVersion: '0.1.0',
  items: [
    {
      itemId: 'item-1',
      drillVersionId: 'weak-foot-50-v1',
      minutes: 5,
      done: true,
      content: {
        title: { ru: 'Слабая нога 50', en: 'Weak Foot 50' },
        goal: { ru: 'Улучшить контроль слабой ногой', en: 'Control with the weaker foot' },
        instructions: { ru: '50 касаний внутренней стороной.', en: '50 inside touches.' },
        dose: { reps: 50 },
        conditions: { equipment: 'ball', spaces: ['yard'] },
      },
      status: 'COMMUNITY',
      attribution: { author: 'FIRST COACH Genesis', source: 'FIRST COACH Genesis', license: 'CC-BY-SA-4.0', createdAt: '2026-09-01T10:00:00Z', semver: '1.0.0' },
    },
  ],
  roadmapSummary: {
    currentLevelLabel: 'Foundation',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [{ skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' }],
  },
});

const json = (status: number, body: unknown, contentType = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

const okResponse = (): Response => json(200, { session: makeSessionJson(), progress: { sessionsCompleted: 1, minutesTrained: 5, streakDays: 1 }, nextSessionDate: '2026-09-22' });

/** Same wire shape the API emits (RFC 9457 problem+json). */
const problemResponse = (status: number, title: string, errors?: { pointer: string; detail: string }[], detail?: string): Response =>
  json(status, { type: 'about:blank', title, status, ...(detail !== undefined && { detail }), ...(errors !== undefined && { errors }) }, 'application/problem+json');

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending microtask and the already-queued macrotasks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- fake IDB ---------------------------------------------------------------------------------------------------------

class FakeIdb implements OutboxStorage {
  readonly data = new Map<string, unknown>();
  /** When true, the NEXT update rejects before changing anything (a crash / quota error), then the flag clears. */
  failNextUpdate = false;
  private chain: Promise<unknown> = Promise.resolve();

  async get(key: string): Promise<unknown> {
    await Promise.resolve();
    return structuredClone(this.data.get(key));
  }

  update(key: string, updater: (old: unknown) => unknown): Promise<void> {
    const run = async (): Promise<void> => {
      await Promise.resolve();
      if (this.failNextUpdate) {
        this.failNextUpdate = false;
        throw new Error('IDB: transaction aborted');
      }
      this.data.set(key, structuredClone(updater(structuredClone(this.data.get(key)))));
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  stored(): OutboxEntry[] {
    return (this.data.get(OUTBOX_KEY) ?? []) as OutboxEntry[];
  }
}

// --- fake server / fetch -----------------------------------------------------------------------------------------------

type Script = (index: number, events: SessionEvent[]) => Response | Promise<Response> | undefined;

function fakeServer(script?: Script) {
  const requests: Array<{ url: string; method: string | undefined; events: SessionEvent[] }> = [];
  const processed = new Set<string>();
  let duplicates = 0;
  const fetch: FetchLike = async (url, init) => {
    const events = (JSON.parse(String(init?.body)) as { events: SessionEvent[] }).events;
    const index = requests.length;
    requests.push({ url, method: init?.method, events });
    const scripted = script?.(index, events);
    if (scripted !== undefined) return scripted;
    for (const e of events) {
      if (processed.has(e.clientUuid)) duplicates += 1;
      else processed.add(e.clientUuid);
    }
    return okResponse();
  };
  return { fetch, requests, processed, duplicates: () => duplicates };
}

// --- harness -------------------------------------------------------------------------------------------------------------

interface Timer {
  ms: number;
  run(): void;
  cancelled: boolean;
  fired: boolean;
}

function harness(script?: Script, opts: { idb?: FakeIdb; playerId?: string; server?: ReturnType<typeof fakeServer> } = {}) {
  const idb = opts.idb ?? new FakeIdb();
  const server = opts.server ?? fakeServer(script);
  const state = { online: true };
  const api = createApi({ fetch: server.fetch, online: () => state.online, language: () => 'en' });
  const timers: Timer[] = [];
  const schedule = (run: () => void, ms: number): (() => void) => {
    const timer: Timer = { ms, run, cancelled: false, fired: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const fire = (timer: Timer): void => {
    timer.fired = true;
    timer.run();
  };
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 21, 12, 0, tick++));
  const outbox = createOutbox({ playerId: opts.playerId ?? PLAYER, api, storage: idb, now, schedule });
  const live = () => timers.filter((t) => !t.cancelled && !t.fired);
  return { outbox, idb, server, state, timers, live, fire };
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
});

// --- enqueue / pendingCount ----------------------------------------------------------------------------------------------

describe('enqueue and pendingCount', () => {
  test('an enqueued event is kept, per player, as a valid OutboxEntry with zero attempts', async () => {
    const { outbox, idb } = harness();
    expect(await outbox.pendingCount()).toBe(0);
    await outbox.enqueue(ev(1));
    await outbox.enqueue(ev(2));
    expect(await outbox.pendingCount()).toBe(2);
    const rows = idb.stored();
    expect(rows.map((r) => r.clientUuid)).toEqual([uuid(1), uuid(2)]);
    for (const row of rows) {
      expect(OutboxEntry.safeParse(row).success).toBe(true);
      expect(row.playerId).toBe(PLAYER);
      expect(row.attempts).toBe(0);
    }
    expect(rows[0]?.event).toEqual(ev(1));
  });

  test('enqueueing the same clientUuid twice keeps one entry', async () => {
    const { outbox } = harness();
    await outbox.enqueue(ev(1));
    await outbox.enqueue(ev(1));
    expect(await outbox.pendingCount()).toBe(1);
  });

  test('an event the contract rejects is refused and nothing is stored', async () => {
    const { outbox, idb } = harness();
    await expect(outbox.enqueue({ ...ev(1), clientUuid: 'not-a-uuid' })).rejects.toBeDefined();
    expect(await outbox.pendingCount()).toBe(0);
    expect(idb.data.size).toBe(0);
  });

  test('two players on one device keep separate outboxes and never send each other\'s events', async () => {
    const idb = new FakeIdb();
    const server = fakeServer();
    const a = harness(undefined, { idb, server, playerId: 'a' });
    const b = harness(undefined, { idb, server, playerId: 'b' });
    await a.outbox.enqueue(ev(1));
    await b.outbox.enqueue(ev(2));
    expect(await a.outbox.pendingCount()).toBe(1);
    await a.outbox.flush();
    expect(server.requests.map((r) => r.events.map((e) => e.clientUuid))).toEqual([[uuid(1)]]);
    expect(await a.outbox.pendingCount()).toBe(0);
    expect(await b.outbox.pendingCount()).toBe(1);
  });
});

// --- flush: one batch, removal on 2xx --------------------------------------------------------------------------------------

describe('flush', () => {
  test('sends ALL queued events as ONE batch, in order, and removes them on 2xx', async () => {
    const { outbox, server } = harness();
    for (const n of [1, 2, 3]) await outbox.enqueue(ev(n));
    const result = await outbox.flush();
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.url).toBe(SEND_PATH);
    expect(request?.method).toBe('POST');
    expect(request?.events).toEqual([ev(1), ev(2), ev(3)]);
    expect(await outbox.pendingCount()).toBe(0);
    expect(result.outcome).toBe('sent');
    expect(result.sent).toBe(3);
  });

  test('an empty outbox sends nothing', async () => {
    const { outbox, server } = harness();
    const result = await outbox.flush();
    expect(server.requests).toHaveLength(0);
    expect(result.outcome).toBe('empty');
    expect(result.sent).toBe(0);
  });

  test('events are never re-id\'d or mutated on the way out', async () => {
    const { outbox, server } = harness();
    const event = ev(1, { type: 'result', value: 42 });
    await outbox.enqueue(event);
    await outbox.flush();
    expect(server.requests[0]?.events).toEqual([event]);
  });

  test('an event enqueued while a batch is in flight is neither sent in it nor lost when the batch succeeds', async () => {
    const gate = deferred<Response>();
    const { outbox, server, idb } = harness((index) => (index === 0 ? gate.promise : undefined));
    await outbox.enqueue(ev(1));
    const flushing = outbox.flush();
    await settle();
    await outbox.enqueue(ev(2));
    gate.resolve(okResponse());
    await flushing;
    expect(server.requests[0]?.events.map((e) => e.clientUuid)).toEqual([uuid(1)]);
    expect(idb.stored().map((r) => r.clientUuid)).toEqual([uuid(2)]);
    await outbox.flush();
    expect(server.requests[1]?.events.map((e) => e.clientUuid)).toEqual([uuid(2)]);
  });
});

// --- flush: failures keep entries -----------------------------------------------------------------------------------------

describe('flush failures keep the queue', () => {
  const failures: Array<[string, Script]> = [
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 500', () => problemResponse(500, 'Internal Server Error')],
    ['a 503 with a non-JSON body', () => new Response('<html>bad gateway</html>', { status: 503, headers: { 'content-type': 'text/html' } })],
  ];

  test.each(failures)('%s: every entry stays, unchanged, with attempts + 1 and a lastError', async (_name, script) => {
    const { outbox, idb } = harness(script);
    for (const n of [1, 2, 3]) await outbox.enqueue(ev(n));
    const result = await outbox.flush();
    expect(result.outcome).toBe('failed');
    expect(result.sent).toBe(0);
    expect(result.dropped).toBe(0);
    expect(await outbox.pendingCount()).toBe(3);
    for (const [i, row] of idb.stored().entries()) {
      expect(row.event).toEqual(ev(i + 1));
      expect(row.attempts).toBe(1);
      expect(typeof row.lastError).toBe('string');
      expect(row.lastError).not.toBe('');
    }
  });

  test('offline (fetch rejects while the browser is offline) keeps the queue too', async () => {
    const h = harness(() => Promise.reject(new TypeError('Failed to fetch')));
    h.state.online = false;
    await h.outbox.enqueue(ev(1));
    const result = await h.outbox.flush();
    expect(result.outcome).toBe('failed');
    expect(h.idb.stored()[0]?.attempts).toBe(1);
  });

  test('attempts keep counting across flushes, and a later success clears the queue', async () => {
    const { outbox, idb, server } = harness((index) => (index < 2 ? problemResponse(502, 'Bad Gateway') : undefined));
    await outbox.enqueue(ev(1));
    await outbox.flush();
    await outbox.flush();
    expect(idb.stored()[0]?.attempts).toBe(2);
    const result = await outbox.flush();
    expect(result.outcome).toBe('sent');
    expect(await outbox.pendingCount()).toBe(0);
    expect(server.requests).toHaveLength(3);
  });

  test('a 2xx whose body is not the contract response is NOT treated as delivered (it may be the SPA fallback page)', async () => {
    const { outbox } = harness(() => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await outbox.enqueue(ev(1));
    const result = await outbox.flush();
    expect(result.outcome).toBe('failed');
    expect(await outbox.pendingCount()).toBe(1);
  });

  test('a 4xx that names nothing (401, 404, 429, a bare 400) drops nothing and counts an attempt', async () => {
    for (const bad of [
      problemResponse(401, 'Unauthorized'),
      problemResponse(404, 'Not Found', undefined, 'Session not found'),
      problemResponse(429, 'Too Many Requests'),
      problemResponse(400, 'Bad Request', [{ pointer: '', detail: 'Invalid body.' }]),
      problemResponse(400, 'Bad Request', [{ pointer: '/events/7/at', detail: 'no such index in a batch of 2' }]),
    ]) {
      const { outbox, idb } = harness(() => bad.clone());
      await outbox.enqueue(ev(1));
      await outbox.enqueue(ev(2));
      const result = await outbox.flush();
      expect(result.dropped).toBe(0);
      expect(await outbox.pendingCount()).toBe(2);
      expect(idb.stored().map((r) => r.attempts)).toEqual([1, 1]);
    }
  });
});

// --- flush: dropping an entry only on a 4xx that names it -------------------------------------------------------------

describe('a 4xx that names an entry drops that entry only', () => {
  test('named by a JSON pointer into the batch (/events/<index>)', async () => {
    const { outbox, idb, server } = harness((index) =>
      index === 0 ? problemResponse(422, 'Unprocessable Entity', [{ pointer: '/events/1/at', detail: 'Not a timestamp.' }]) : undefined,
    );
    for (const n of [1, 2, 3]) await outbox.enqueue(ev(n));
    const result = await outbox.flush();
    expect(result.outcome).toBe('failed');
    expect(result.dropped).toBe(1);
    expect(idb.stored().map((r) => r.clientUuid)).toEqual([uuid(1), uuid(3)]);
    // The survivors were not at fault (the server rolled the whole batch back): no attempt is charged, retry is immediate.
    expect(idb.stored().map((r) => r.attempts)).toEqual([0, 0]);
    expect(result.retryInMs).toBe(0);
    // Next flush sends the survivors as one batch and succeeds.
    const next = await outbox.flush();
    expect(next.outcome).toBe('sent');
    expect(server.requests[1]?.events.map((e) => e.clientUuid)).toEqual([uuid(1), uuid(3)]);
    expect(await outbox.pendingCount()).toBe(0);
  });

  test('named by its clientUuid in the problem detail (the too-old / in-future rejection)', async () => {
    const { outbox, idb } = harness(() => problemResponse(422, 'Unprocessable Entity', undefined, `Event ${uuid(2)}: at is older than 30 days`));
    for (const n of [1, 2, 3]) await outbox.enqueue(ev(n));
    const result = await outbox.flush();
    expect(result.dropped).toBe(1);
    expect(idb.stored().map((r) => r.clientUuid)).toEqual([uuid(1), uuid(3)]);
  });

  test('several named entries are all dropped', async () => {
    const { outbox, idb } = harness(() =>
      problemResponse(400, 'Bad Request', [
        { pointer: '/events/0/type', detail: 'bad' },
        { pointer: '/events/2/clientUuid', detail: 'bad' },
      ]),
    );
    for (const n of [1, 2, 3]) await outbox.enqueue(ev(n));
    const result = await outbox.flush();
    expect(result.dropped).toBe(2);
    expect(idb.stored().map((r) => r.clientUuid)).toEqual([uuid(2)]);
  });

  test('only a 4xx drops: a 5xx that names an entry drops nothing', async () => {
    const { outbox } = harness(() => problemResponse(500, 'Internal Server Error', [{ pointer: '/events/0', detail: 'boom' }], `Event ${uuid(1)} exploded`));
    await outbox.enqueue(ev(1));
    const result = await outbox.flush();
    expect(result.dropped).toBe(0);
    expect(await outbox.pendingCount()).toBe(1);
  });
});

// --- backoff ---------------------------------------------------------------------------------------------------------------------

describe('backoff', () => {
  test('backoffMs grows with attempts, is positive, and is capped', () => {
    expect(backoffMs(1)).toBeGreaterThan(0);
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
    expect(backoffMs(50)).toBe(backoffMs(51));
    expect(backoffMs(50)).toBeGreaterThanOrEqual(backoffMs(10));
    expect(backoffMs(50)).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(Number.isFinite(backoffMs(10_000))).toBe(true);
  });

  test('a failed flush reports the wait derived from the attempts it just recorded', async () => {
    const { outbox } = harness(() => problemResponse(500, 'Internal Server Error'));
    await outbox.enqueue(ev(1));
    const first = await outbox.flush();
    expect(first.retryInMs).toBe(backoffMs(1));
    const second = await outbox.flush();
    expect(second.retryInMs).toBe(backoffMs(2));
  });

  test('a successful flush reports no wait', async () => {
    const { outbox } = harness();
    await outbox.enqueue(ev(1));
    expect((await outbox.flush()).retryInMs).toBeUndefined();
  });
});

// --- single flight -----------------------------------------------------------------------------------------------------------------

describe('single flight', () => {
  test('concurrent flush() calls send ONCE and every caller gets the same result', async () => {
    const gate = deferred<Response>();
    const { outbox, server } = harness((index) => (index === 0 ? gate.promise : undefined));
    for (const n of [1, 2]) await outbox.enqueue(ev(n));
    const calls = [outbox.flush(), outbox.flush(), outbox.flush()];
    await settle();
    expect(server.requests).toHaveLength(1);
    gate.resolve(okResponse());
    const results = await Promise.all(calls);
    expect(server.requests).toHaveLength(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(results[0]?.sent).toBe(2);
  });

  test('after a flush settles (even by failing) the next flush is a fresh send', async () => {
    const { outbox, server } = harness((index) => (index === 0 ? problemResponse(500, 'Internal Server Error') : undefined));
    await outbox.enqueue(ev(1));
    await outbox.flush();
    await outbox.flush();
    expect(server.requests).toHaveLength(2);
  });
});

// --- crash between send and delete -------------------------------------------------------------------------------------------------

describe('replay after a crash between send and delete', () => {
  /** A script that "crashes" the device once: the server processes the batch and answers 200, but the next IDB write fails. */
  const crashOnce = (idb: FakeIdb): Script => {
    let crashed = false;
    return () => {
      if (!crashed) idb.failNextUpdate = true;
      crashed = true;
      return undefined;
    };
  };

  test('the removal never happened: the same events are sent again, the server ignores the duplicates, nothing is lost or doubled', async () => {
    const idb = new FakeIdb();
    const server = fakeServer(crashOnce(idb));
    const first = harness(undefined, { idb, server });
    for (const n of [1, 2, 3]) await first.outbox.enqueue(ev(n));
    await expect(first.outbox.flush()).rejects.toBeDefined();
    expect(server.processed.size).toBe(3); // the server has them
    expect(idb.stored().map((r) => r.clientUuid)).toEqual([uuid(1), uuid(2), uuid(3)]); // the device still has them too

    // App restarts: a NEW outbox over the same IDB re-sends the same batch, byte for byte, to the idempotent server.
    const second = harness(undefined, { idb, server });
    const result = await second.outbox.flush();
    expect(result.outcome).toBe('sent');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.events).toEqual(server.requests[0]?.events ?? []);
    expect(server.duplicates()).toBe(3); // all three were already processed: ignored, not written twice
    expect(server.processed.size).toBe(3);
    expect(await second.outbox.pendingCount()).toBe(0);
  });

  test('the same outbox instance recovers too: a failed removal does not wedge single-flight', async () => {
    const idb = new FakeIdb();
    const h = harness(crashOnce(idb), { idb });
    await h.outbox.enqueue(ev(1));
    await expect(h.outbox.flush()).rejects.toBeDefined();
    const again = await h.outbox.flush();
    expect(again.outcome).toBe('sent');
    expect(h.server.requests).toHaveLength(2);
    expect(h.server.requests[1]?.events).toEqual([ev(1)]);
    expect(await h.outbox.pendingCount()).toBe(0);
  });
});

// --- start(): triggers ---------------------------------------------------------------------------------------------------------------

describe('start', () => {
  test('flushes on app start: the queued events go out when start() is called', async () => {
    const { outbox, server } = harness();
    await outbox.enqueue(ev(1));
    stops.push(outbox.start());
    await settle();
    expect(server.requests).toHaveLength(1);
    expect(await outbox.pendingCount()).toBe(0);
  });

  test('flushes on the online event', async () => {
    const { outbox, server } = harness();
    stops.push(outbox.start());
    await settle();
    expect(server.requests).toHaveLength(0);
    await outbox.enqueue(ev(1));
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(server.requests).toHaveLength(1);
  });

  test('flushes on visibility change', async () => {
    const { outbox, server } = harness();
    stops.push(outbox.start());
    await settle();
    await outbox.enqueue(ev(1));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(server.requests).toHaveLength(1);
  });

  test('the returned stop function removes the listeners and cancels a pending retry', async () => {
    const h = harness(() => problemResponse(500, 'Internal Server Error'));
    await h.outbox.enqueue(ev(1));
    const stop = h.outbox.start();
    await settle();
    expect(h.live()).toHaveLength(1);
    stop();
    expect(h.live()).toHaveLength(0);
    const before = h.server.requests.length;
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(h.server.requests).toHaveLength(before);
  });

  test('a failed flush schedules ONE retry after the backoff; running it re-sends; success schedules nothing more', async () => {
    const h = harness((index) => (index === 0 ? problemResponse(500, 'Internal Server Error') : undefined));
    await h.outbox.enqueue(ev(1));
    stops.push(h.outbox.start());
    await settle();
    expect(h.server.requests).toHaveLength(1);
    const pending = h.live();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ms).toBe(backoffMs(1));
    const [timer] = pending;
    if (timer === undefined) throw new Error('no retry scheduled');
    h.fire(timer);
    await settle();
    expect(h.server.requests).toHaveLength(2);
    expect(await h.outbox.pendingCount()).toBe(0);
    expect(h.live()).toHaveLength(0);
  });

  test('the online event does not wait for the backoff: it cancels the pending retry and flushes now', async () => {
    const h = harness((index) => (index === 0 ? problemResponse(500, 'Internal Server Error') : undefined));
    await h.outbox.enqueue(ev(1));
    stops.push(h.outbox.start());
    await settle();
    expect(h.live()).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(h.server.requests).toHaveLength(2);
    expect(h.live()).toHaveLength(0);
    expect(await h.outbox.pendingCount()).toBe(0);
  });

  test('a flush that rejects (storage failure) does not escape as an unhandled rejection and is retried later', async () => {
    const h = harness();
    await h.outbox.enqueue(ev(1));
    h.idb.failNextUpdate = true; // the send happens, the removal fails
    stops.push(h.outbox.start());
    await settle();
    expect(h.live()).toHaveLength(1);
    const [timer] = h.live();
    if (timer === undefined) throw new Error('no retry scheduled');
    h.fire(timer);
    await settle();
    expect(h.server.requests).toHaveLength(2);
    expect(await h.outbox.pendingCount()).toBe(0);
  });
});

// --- default instance -------------------------------------------------------------------------------------------------------------------

describe('module-level API', () => {
  test('exports enqueue, flush, start and pendingCount; enqueue before configureOutbox rejects with a clear message', async () => {
    for (const fn of [defaultEnqueue, defaultFlush, defaultStart, defaultPendingCount, configureOutbox]) expect(typeof fn).toBe('function');
    await expect(defaultEnqueue(ev(1))).rejects.toThrow(/configureOutbox/);
  });
});
