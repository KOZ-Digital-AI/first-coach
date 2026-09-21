import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { SessionEvent } from '@api-types/session';

/*
 * fc-mol-eay.13: coming back online replays the queued events with exactly ONE POST /api/player/session-events, even though two
 * things react to the `online` event: the connectivity banner (features/offline/root-extra.tsx, default flush) and the events
 * client's `startEventsSync()` (bootstrap.ts). Found by the real-stack gate j7-offline.sh: two identical POSTs 1 ms apart.
 *
 * The app's real default instances are used end to end (banner default flush, default events client, default outbox, the real
 * app api wrapper). Faked seams only: IndexedDB (idb-keyval is replaced by an in-memory Map with the same get/update shape, and put
 * back afterwards) and the global `fetch` (counts the POSTs and answers with a contract-valid response after a short delay, so a
 * second flush that is not single-flighted would read the still-full outbox and POST again). happy-dom's window is the `online`
 * emitter, exactly as in the browser.
 */

if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}

const realIdb = await import('idb-keyval');
const rows = new Map<string, unknown>();
mock.module('idb-keyval', () => ({
  ...realIdb,
  get: async (key: string) => structuredClone(rows.get(key)),
  update: async (key: string, updater: (old: unknown) => unknown) => {
    rows.set(key, structuredClone(updater(structuredClone(rows.get(key)))));
  },
}));

const { act, cleanup, render } = await import('@testing-library/react');
const { configureOutbox, pendingCount } = await import('./outbox');
const { configureEventsClient, configureEventsPlayer, startEventsSync, submitEvents, SESSION_SUMMARY_QUERY_KEY, TODAY_QUERY_KEY } = await import('../features/train/events-client');
const { default: ConnectivityBannerSlot } = await import('../features/offline/root-extra');

afterAll(() => {
  mock.module('idb-keyval', () => realIdb);
});

const PLAYER = 'player-1';
const SESSION_ID = 's-2026-09-21';
const POST_PATH = '/api/player/session-events';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const drillDone = (n: number): SessionEvent => ({ clientUuid: uuid(n), sessionId: SESSION_ID, type: 'drill_done', itemId: `item-${n}`, at: `2026-09-21T10:0${n}:00.000Z` });

const sessionJson = (done: boolean): Record<string, unknown> => ({
  id: SESSION_ID,
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 12,
  graphVersion: '0.1.0',
  items: [1, 2].map((n) => ({
    itemId: `item-${n}`,
    drillVersionId: 'weak-foot-50-v1',
    minutes: n === 1 ? 5 : 7,
    done,
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
const SERVER_PROGRESS = { sessionsCompleted: 5, minutesTrained: 92, streakDays: 3 };
const serverBody = () => ({ session: sessionJson(true), progress: SERVER_PROGRESS, nextSessionDate: '2026-09-24' });

// --- rig -----------------------------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let network: 'down' | 'up' = 'up';
let posts: string[][] = [];
let queryClient: QueryClient;
let stopSync: (() => void) | undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    if (init?.method === 'POST' && url.pathname === POST_PATH) {
      const body = JSON.parse(String(init.body)) as { events: SessionEvent[] };
      posts.push(body.events.map((event) => event.clientUuid));
      if (network === 'down') throw new TypeError('network down');
      await sleep(15);
      return new Response(JSON.stringify(serverBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

let onLine = true;

beforeEach(() => {
  rows.clear();
  posts = [];
  network = 'up';
  onLine = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
  queryClient = new QueryClient();
  queryClient.setQueryData(TODAY_QUERY_KEY, sessionJson(false));
  configureEventsClient({ queryClient });
  configureEventsPlayer(PLAYER);
  configureOutbox({ playerId: PLAYER });
});

afterEach(() => {
  stopSync?.();
  stopSync = undefined;
  cleanup();
  configureEventsPlayer(undefined);
  configureOutbox({ playerId: undefined });
  delete (navigator as { onLine?: boolean }).onLine;
});

const goOffline = () =>
  act(async () => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });
const goOnline = () =>
  act(async () => {
    onLine = true;
    window.dispatchEvent(new Event('online'));
  });

/** Lets every in-flight request finish and any late second request happen. */
const settle = () => act(async () => void (await sleep(80)));

/** The user finishes a drill offline: the event is queued on the device (the send fails, the outbox keeps it). */
async function queueOffline(n: number): Promise<void> {
  network = 'down';
  const result = await submitEvents([drillDone(n)]);
  expect(result.status).toBe('queued');
  expect(await pendingCount()).toBe(1);
  posts = [];
  network = 'up';
}

describe('one POST per online transition', () => {
  test('banner mounted BEFORE the events sync: the queued batch is POSTed once and the caches are filled from the answer', async () => {
    render(createElement(ConnectivityBannerSlot));
    stopSync = startEventsSync();
    await settle();
    await goOffline();
    await queueOffline(1);

    await goOnline();
    await settle();

    expect(posts).toEqual([[uuid(1)]]);
    expect(await pendingCount()).toBe(0);
    // The events client's delivered-response writes still happen for the replayed batch.
    expect(queryClient.getQueryData(SESSION_SUMMARY_QUERY_KEY)).toEqual({ progress: SERVER_PROGRESS, nextSessionDate: '2026-09-24', sessionId: SESSION_ID });
    expect((queryClient.getQueryData(TODAY_QUERY_KEY) as { items: { done: boolean }[] }).items.every((item) => item.done)).toBe(true);
  });

  test('events sync started BEFORE the banner mounts: still one POST', async () => {
    stopSync = startEventsSync();
    render(createElement(ConnectivityBannerSlot));
    await settle();
    await goOffline();
    await queueOffline(1);

    await goOnline();
    await settle();

    expect(posts).toEqual([[uuid(1)]]);
    expect(await pendingCount()).toBe(0);
  });

  test('a second offline/online round POSTs its own batch once, not twice', async () => {
    render(createElement(ConnectivityBannerSlot));
    stopSync = startEventsSync();
    await settle();

    await goOffline();
    await queueOffline(1);
    await goOnline();
    await settle();
    expect(posts).toEqual([[uuid(1)]]);

    posts = [];
    await goOffline();
    await queueOffline(2);
    await goOnline();
    await settle();
    expect(posts).toEqual([[uuid(2)]]);
    expect(await pendingCount()).toBe(0);
  });

  test('an online event that follows no offline event (the banner stays out of it) is flushed once by the events sync', async () => {
    render(createElement(ConnectivityBannerSlot));
    stopSync = startEventsSync();
    await settle();
    network = 'down';
    await submitEvents([drillDone(1)]);
    posts = [];
    network = 'up';

    await goOnline();
    await settle();

    expect(posts).toEqual([[uuid(1)]]);
  });

  test('the banner alone (no events sync started) still delivers the queued batch, once, through the events client', async () => {
    render(createElement(ConnectivityBannerSlot));
    await goOffline();
    await queueOffline(1);

    await goOnline();
    await settle();

    expect(posts).toEqual([[uuid(1)]]);
    expect(await pendingCount()).toBe(0);
    expect(queryClient.getQueryData(SESSION_SUMMARY_QUERY_KEY)).toEqual({ progress: SERVER_PROGRESS, nextSessionDate: '2026-09-24', sessionId: SESSION_ID });
  });
});
