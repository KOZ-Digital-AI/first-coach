import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { ENDPOINTS, SessionEvent, TodaySession } from '@api-types/session';
import type { Api } from '../../lib/api';
import type { OutboxStorage } from '../../offline/outbox';
import { createSessionStore } from '../../offline/session-store';
import type { KeyValueStore, OutboxEntry } from '../../offline/types';
import { playerKeys } from '../../offline/types';
import { ApiProblem } from '../../lib/problem';
import { createEventsClient } from './events-client';

/*
 * fc-mol-eay.5: submitEvents goes through the offline outbox. The order is: enqueue (persisted) -> apply to the offline
 * session store and the ['today'] cache -> flush. Offline (or any failed send) resolves { status: 'queued' } and nothing is
 * lost; coming back online sends everything that waited as ONE batch. The legacy behaviour (no `offline` option) is pinned by
 * events-client.test.ts and events-client.summary.test.ts and is not repeated here.
 *
 * Real collaborators: the real outbox (createOutbox, built by the client), the real offline session store and the real
 * QueryClient. Faked: the `api` (records what is POSTed; parses the answer with the schema the caller passed, like the real
 * wrapper), IndexedDB (a Map with the same get/update seam) and the device's localStorage (a Map). No timers.
 */

const PLAYER = 'player-1';
const SESSION_ID = 's-2026-09-21';
const TODAY = ['today'] as const;
const SUMMARY = ['session-summary'] as const;
const OUTBOX_KEY = playerKeys(PLAYER).outbox;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const makeSessionJson = (done: readonly boolean[] = [false, false]): Record<string, unknown> => ({
  id: SESSION_ID,
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 12,
  graphVersion: '0.1.0',
  items: done.map((isDone, index) => ({
    itemId: `item-${index + 1}`,
    drillVersionId: 'weak-foot-50-v1',
    minutes: index === 0 ? 5 : 7,
    done: isDone,
    content: {
      title: { ru: 'Слабая нога 50', en: 'Weak Foot 50' },
      goal: { ru: 'Улучшить контроль слабой ногой', en: 'Control with the weaker foot' },
      instructions: { ru: '50 касаний внутренней стороной.', en: '50 inside touches.' },
      dose: { reps: 50 },
      conditions: { equipment: 'ball', spaces: ['yard'] },
    },
    status: 'COMMUNITY',
    attribution: { author: 'FIRST COACH Genesis', source: 'FIRST COACH Genesis', license: 'CC-BY-SA-4.0', createdAt: '2026-09-01T10:00:00Z', semver: '1.0.0' },
  })),
  roadmapSummary: {
    currentLevelLabel: 'Foundation',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' },
      { skill: 'passing', level: 1, targetLevel: 2, reason: 'One of the weakest areas.' },
    ],
  },
});

/** What the server answers once the drills are done: the session plus the authoritative progress. */
const serverResponse = (): Record<string, unknown> => ({
  session: makeSessionJson([true, true]),
  progress: { sessionsCompleted: 5, minutesTrained: 92, streakDays: 3 },
  nextSessionDate: '2026-09-24',
});

const ev = (n: number, patch: Partial<SessionEvent> = {}): SessionEvent => ({
  clientUuid: uuid(n),
  sessionId: SESSION_ID,
  type: 'drill_done',
  itemId: `item-${n}`,
  at: `2026-09-21T10:${String(n).padStart(2, '0')}:00.000Z`,
  ...patch,
});
const finishEvent = (n: number): SessionEvent => ({ clientUuid: uuid(n), sessionId: SESSION_ID, type: 'session_finished', at: `2026-09-21T10:${String(n).padStart(2, '0')}:00.000Z` });

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

/** Fake IndexedDB: async, structured-cloning, per-key-atomic (updates run one after another). */
class FakeIdb implements OutboxStorage {
  readonly data = new Map<string, unknown>();
  private chain: Promise<unknown> = Promise.resolve();
  async get(key: string): Promise<unknown> {
    await Promise.resolve();
    return structuredClone(this.data.get(key));
  }
  update(key: string, updater: (old: unknown) => unknown): Promise<void> {
    const run = async (): Promise<void> => {
      await Promise.resolve();
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

const mapStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value), removeItem: (key) => void map.delete(key) };
};

interface Call {
  path: string;
  schema: unknown;
  events: SessionEvent[];
}

type Answer = (index: number, events: SessionEvent[]) => unknown;

async function make(options: { answer?: Answer; downloaded?: boolean } = {}) {
  const network = { online: true };
  const calls: Call[] = [];
  const answer: Answer =
    options.answer ??
    (() => {
      if (!network.online) throw new ApiProblem({ kind: 'offline' });
      return serverResponse();
    });
  const post = async (path: string, callOptions: { body: { events: SessionEvent[] }; schema: { parse(input: unknown): unknown } }): Promise<unknown> => {
    const index = calls.length;
    calls.push({ path, schema: callOptions.schema, events: callOptions.body.events });
    return callOptions.schema.parse(await answer(index, callOptions.body.events));
  };
  const api = { post } as unknown as Api;

  const storage = new FakeIdb();
  const sessionStore = createSessionStore({ store: mapStore(), api: { get: (async () => TodaySession.parse(makeSessionJson())) as never } });
  if (options.downloaded !== false) await sessionStore.downloadToday(PLAYER, 'en');
  const queryClient = new QueryClient();
  queryClient.setQueryData(TODAY, TodaySession.parse(makeSessionJson()));
  const client = createEventsClient({
    api,
    queryClient,
    offline: { playerId: PLAYER, storage, sessionStore, schedule: () => () => {} },
  });
  return { client, queryClient, calls, storage, sessionStore, network };
}

const todayItems = (queryClient: QueryClient) => (queryClient.getQueryData<TodaySession>(TODAY)?.items ?? []).map((item) => item.done);

async function waitFor(condition: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await condition()) return;
    await settle();
  }
  throw new Error('waitFor: the condition never became true');
}

describe('online: enqueue first, then flush', () => {
  test('one POST with the batch in order; resolves the server response as sent; the outbox is empty afterwards', async () => {
    const { client, calls, storage } = await make();
    const events = [ev(1), ev(2)];
    const result = await client.submitEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(ENDPOINTS.postSessionEvents.path);
    expect(calls[0]?.schema).toBe(ENDPOINTS.postSessionEvents.response);
    expect(calls[0]?.events).toEqual(events);
    expect(result.status).toBe('sent');
    expect(result.progress).toEqual({ sessionsCompleted: 5, minutesTrained: 92, streakDays: 3 });
    expect(result.nextSessionDate).toBe('2026-09-24');
    expect(result.session).toEqual(TodaySession.parse(serverResponse().session));
    expect(storage.stored()).toEqual([]);
  });

  test("the server's answer replaces the cached ['today'] and is written to ['session-summary'] like the direct path does", async () => {
    const { client, queryClient } = await make();
    await client.submitEvents([ev(1), ev(2)]);

    expect(queryClient.getQueryData<TodaySession>(TODAY)).toStrictEqual(TodaySession.parse(serverResponse().session));
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 5, minutesTrained: 92, streakDays: 3 },
      nextSessionDate: '2026-09-24',
      sessionId: SESSION_ID,
    });
  });

  test('the event is persisted in the outbox BEFORE the request is made', async () => {
    let storedAtSend: OutboxEntry[] | undefined;
    let storage: FakeIdb | undefined;
    const made = await make({
      answer: () => {
        storedAtSend = storage?.stored();
        return serverResponse();
      },
    });
    storage = made.storage;
    await made.client.submitEvents([ev(1)]);
    expect(storedAtSend?.map((entry) => entry.clientUuid)).toEqual([uuid(1)]);
  });

  test('the event is applied to the offline session store and the [today] cache before the request is answered', async () => {
    const gate = deferred<unknown>();
    const { client, queryClient, sessionStore } = await make({ answer: () => gate.promise });
    const pending = client.submitEvents([ev(1)]);
    await settle();

    expect(todayItems(queryClient)).toEqual([true, false]);
    expect(sessionStore.getOffline(PLAYER, '2026-09-21')?.session.items.map((item) => item.done)).toEqual([true, false]);
    gate.resolve(serverResponse());
    await pending;
  });
});

describe('offline: nothing is lost', () => {
  test("a network failure resolves { status: 'queued' } (it does not reject) and the event stays in the outbox", async () => {
    const { client, network, storage } = await make();
    network.online = false;
    const event = ev(1);

    const result = await client.submitEvents([event]);

    expect(result.status).toBe('queued');
    expect(result.session).toBeUndefined();
    expect(storage.stored().map((entry) => entry.event)).toEqual([event]);
    expect(await client.outbox?.pendingCount()).toBe(1);
  });

  test('a 5xx is queued too, not thrown', async () => {
    const { client, storage } = await make({
      answer: () => {
        throw new ApiProblem({ kind: 'server', status: 503 });
      },
    });
    const result = await client.submitEvents([ev(1)]);
    expect(result.status).toBe('queued');
    expect(storage.stored()).toHaveLength(1);
  });

  test('a 2xx that is not the contract response is not delivery: queued, and the event is kept', async () => {
    const { client, storage } = await make({ answer: () => ({ html: '<!doctype html>' }) });
    const result = await client.submitEvents([ev(1)]);
    expect(result.status).toBe('queued');
    expect(storage.stored()).toHaveLength(1);
  });

  test("offline a drill is done locally: the session store and the ['today'] cache show it, and drill_undone reverses it", async () => {
    const { client, network, queryClient, sessionStore } = await make();
    network.online = false;

    await client.submitEvents([ev(1), ev(2)]);
    expect(todayItems(queryClient)).toEqual([true, true]);
    expect(sessionStore.getOffline(PLAYER, '2026-09-21')?.session.items.map((item) => item.done)).toEqual([true, true]);

    await client.submitEvents([ev(3, { type: 'drill_undone', itemId: 'item-2' })]);
    expect(todayItems(queryClient)).toEqual([true, false]);
    expect(sessionStore.getOffline(PLAYER, '2026-09-21')?.session.items.map((item) => item.done)).toEqual([true, false]);
  });

  test('an event of another session changes neither the session store nor the [today] cache', async () => {
    const { client, network, queryClient, sessionStore } = await make();
    network.online = false;
    await client.submitEvents([ev(1, { sessionId: 's-other' })]);
    expect(todayItems(queryClient)).toEqual([false, false]);
    expect(sessionStore.getOffline(PLAYER, '2026-09-21')?.session.items.map((item) => item.done)).toEqual([false, false]);
  });

  test('the whole session can be finished offline: the summary has local data, marked with this session, and nothing is sent', async () => {
    const { client, network, queryClient, calls, storage } = await make();
    network.online = false;
    await client.submitEvents([ev(1), ev(2)]);

    const result = await client.submitEvents([finishEvent(3)]);

    expect(result.status).toBe('queued');
    expect(storage.stored().map((entry) => entry.event.type)).toEqual(['drill_done', 'drill_done', 'session_finished']);
    // No earlier progress is known on the device: this session alone (5 + 7 minutes), the day after the session for the next one.
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 1, minutesTrained: 12, streakDays: 1 },
      nextSessionDate: '2026-09-22',
      sessionId: SESSION_ID,
    });
  });

  test('the offline summary builds on the last known progress and keeps its next session date', async () => {
    const { client, network, queryClient } = await make();
    queryClient.setQueryData(SUMMARY, { progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 }, nextSessionDate: '2026-09-23', sessionId: 's-2026-09-19' });
    network.online = false;
    await client.submitEvents([ev(1), ev(2)]);

    await client.submitEvents([finishEvent(3)]);

    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 5, minutesTrained: 92, streakDays: 2 },
      nextSessionDate: '2026-09-23',
      sessionId: SESSION_ID,
    });
  });

  test("a summary of this very session (the server's answer to an earlier drill) already counts its minutes: only the finish is added", async () => {
    const { client, network, queryClient } = await make();
    queryClient.setQueryData(SUMMARY, { progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 }, nextSessionDate: '2026-09-23', sessionId: SESSION_ID });
    network.online = false;
    await client.submitEvents([ev(1), ev(2)]);

    await client.submitEvents([finishEvent(3)]);

    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 5, minutesTrained: 80, streakDays: 2 },
      nextSessionDate: '2026-09-23',
      sessionId: SESSION_ID,
    });
  });

  test.each(['2026-09-20', '2026-09-21'])('a cached next session date (%s) that is not after the session is not kept: the day after the session is', async (stale) => {
    const { client, network, queryClient } = await make();
    queryClient.setQueryData(SUMMARY, { progress: { sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 }, nextSessionDate: stale, sessionId: 's-2026-09-19' });
    network.online = false;
    await client.submitEvents([ev(1), ev(2)]);

    await client.submitEvents([finishEvent(3)]);

    expect(queryClient.getQueryData<{ nextSessionDate: string }>(SUMMARY)?.nextSessionDate).toBe('2026-09-22');
  });

  test('finishing the same session offline twice counts it once', async () => {
    const { client, network, queryClient } = await make();
    network.online = false;
    await client.submitEvents([ev(1), ev(2)]);
    await client.submitEvents([finishEvent(3)]);
    const first = queryClient.getQueryData<unknown>(SUMMARY);
    await client.submitEvents([finishEvent(4)]);
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual(first);
  });

  test('a non-finishing batch offline writes no summary', async () => {
    const { client, network, queryClient } = await make();
    network.online = false;
    await client.submitEvents([ev(1)]);
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toBeUndefined();
  });

  test('resubmitting the same event keeps ONE entry with the same clientUuid, and the event is never changed', async () => {
    const { client, network, storage } = await make();
    network.online = false;
    const event = Object.freeze(ev(1));
    const snapshot = structuredClone(event);

    await client.submitEvents([event]);
    await client.submitEvents([event]);

    expect(event).toEqual(snapshot);
    expect(storage.stored()).toHaveLength(1);
    expect(storage.stored()[0]?.clientUuid).toBe(uuid(1));
    expect(storage.stored()[0]?.event).toEqual(snapshot);
  });
});

describe('going online', () => {
  test('one batch with everything that waited, in the order it was queued, then the outbox is empty and the caches hold the server answer', async () => {
    const { client, network, calls, storage, queryClient } = await make();
    network.online = false;
    await client.submitEvents([ev(1)]);
    await client.submitEvents([ev(2)]);
    await client.submitEvents([finishEvent(3)]);
    expect(storage.stored()).toHaveLength(3);

    const windowTarget = new EventTarget();
    const stop = client.outbox?.start({ window: windowTarget, document: new EventTarget() });
    await settle();
    network.online = true;
    const beforeOnline = calls.length;
    windowTarget.dispatchEvent(new Event('online'));
    await waitFor(async () => (await client.outbox?.pendingCount()) === 0);
    stop?.();

    const sent = calls.slice(beforeOnline);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((event) => event.clientUuid)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(storage.stored()).toEqual([]);
    expect(queryClient.getQueryData<TodaySession>(TODAY)).toStrictEqual(TodaySession.parse(serverResponse().session));
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toStrictEqual({
      progress: { sessionsCompleted: 5, minutesTrained: 92, streakDays: 3 },
      nextSessionDate: '2026-09-24',
      sessionId: SESSION_ID,
    });
  });

  test('an online submit after an offline one sends the earlier events too (one batch), and resolves sent', async () => {
    const { client, network, calls } = await make();
    network.online = false;
    await client.submitEvents([ev(1)]);
    network.online = true;
    const before = calls.length;

    const result = await client.submitEvents([ev(2)]);

    expect(result.status).toBe('sent');
    expect(calls.slice(before)).toHaveLength(1);
    expect(calls[before]?.events.map((event) => event.clientUuid)).toEqual([uuid(1), uuid(2)]);
  });
});

describe('concurrent submissions', () => {
  test('an event enqueued while a flush is in flight is still delivered, and its submit does not resolve sent before that', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>()];
    const { client, calls, storage } = await make({ answer: (index) => gates[index]?.promise });

    const first = client.submitEvents([ev(1)]);
    await waitFor(() => calls.length === 1);
    const second = client.submitEvents([ev(2)]);
    await settle();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });

    gates[0]?.resolve(serverResponse());
    await first;
    await waitFor(() => calls.length === 2);
    expect(secondDone).toBe(false);
    expect(calls[1]?.events.map((event) => event.clientUuid)).toEqual([uuid(2)]);

    gates[1]?.resolve(serverResponse());
    const result = await second;
    expect(result.status).toBe('sent');
    expect(storage.stored()).toEqual([]);
  });
});

describe('what is still an error', () => {
  test('an empty batch rejects locally, stores and sends nothing', async () => {
    const { client, calls, storage } = await make();
    await expect(client.submitEvents([])).rejects.toThrow(/at least one event/i);
    expect(calls).toHaveLength(0);
    expect(storage.stored()).toEqual([]);
  });

  test('an invalid event rejects; nothing of the batch is stored or sent', async () => {
    const { client, calls, storage } = await make();
    await expect(client.submitEvents([ev(1), { ...ev(2), clientUuid: 'not-a-uuid' }])).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
    expect(storage.stored()).toEqual([]);
  });

  test('a batch the server refuses for good (a 4xx naming the event) rejects with that very problem; nothing is left queued', async () => {
    const problem = new ApiProblem({
      kind: 'validation',
      status: 422,
      problem: { type: 'about:blank', title: 'Invalid events', status: 422, errors: [{ pointer: '/events/0', detail: 'unknown item' }] },
    });
    const { client, storage, queryClient } = await make({
      answer: () => {
        throw problem;
      },
    });
    const outcome = await client.submitEvents([ev(1)]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBe(problem);
    expect(storage.stored()).toEqual([]);
    expect(queryClient.getQueryData<unknown>(SUMMARY)).toBeUndefined();
  });

  test('no player configured: the direct path is used (a request, no outbox)', async () => {
    const calls: unknown[] = [];
    const api = {
      post: async (_path: string, options: { schema: { parse(input: unknown): unknown } }) => {
        calls.push(1);
        return options.schema.parse(serverResponse());
      },
    } as unknown as Api;
    const storage = new FakeIdb();
    const queryClient = new QueryClient();
    const client = createEventsClient({ api, queryClient, offline: { playerId: () => undefined, storage } });

    const result = await client.submitEvents([ev(1)]);

    expect(calls).toHaveLength(1);
    expect(result.session).toBeDefined();
    expect(storage.stored()).toEqual([]);
    expect(queryClient.getQueryData<TodaySession>(TODAY)).toBeDefined();
  });
});
