import { describe, expect, test } from 'bun:test';
import { createApi } from '../lib/api';
import { isApiProblem } from '../lib/problem';
import {
  applyLocalEvent,
  createSessionStore,
  downloadToday,
  getOffline,
  status,
  type SessionStoreDeps,
} from './session-store';
import { type KeyValueStore, offlineKey, OFFLINE_KEY_PREFIX, readOfflineSession, SESSION_KEY_NAME } from './types';

// The store is exercised through its two seams and nothing else: a Map-backed fake standing in
// for the device storage ("fake IDB"), and a stub fetch behind the real typed client. No DOM, no
// real localStorage, no network, no timers, so the file behaves the same from the repo root and
// from apps/web (where the happy-dom preload is registered).

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// --- Fixtures: realistic payloads (shapes follow apps/api/src/shared/session.test.ts) ------------

const makeContent = (title = 'Weak Foot 50'): Record<string, unknown> => ({
  title: { ru: 'Слабая нога 50', en: title },
  goal: { ru: 'Улучшить контроль слабой ногой', en: 'Control with the weaker foot' },
  instructions: { ru: '50 касаний внутренней стороной.', en: '50 inside touches.' },
  dose: { reps: 50 },
  conditions: { equipment: 'ball', spaces: ['yard'] },
});

const makeItem = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemId: 'item-1',
  drillVersionId: 'weak-foot-50-v1',
  minutes: 5,
  done: false,
  content: makeContent(),
  status: 'COMMUNITY',
  attribution: {
    author: 'FIRST COACH Genesis',
    source: 'FIRST COACH Genesis',
    license: 'CC-BY-SA-4.0',
    createdAt: '2026-09-01T10:00:00Z',
    semver: '1.0.0',
  },
  ...patch,
});

const makeToday = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's-2026-09-21',
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 15,
  graphVersion: '0.1.0',
  items: [
    makeItem(),
    makeItem({ itemId: 'item-2', drillVersionId: 'wall-passes-v2' }),
    makeItem({ itemId: 'item-3', drillVersionId: 'juggling-v1' }),
  ],
  roadmapSummary: {
    currentLevelLabel: 'Foundation',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'weakfoot', level: 1, targetLevel: 2, reason: 'Your stated goal.' },
      { skill: 'passing', level: 1, targetLevel: 2, reason: 'One of the weakest areas.' },
    ],
  },
  ...patch,
});

const makeEvent = (patch: Record<string, unknown> = {}) => ({
  clientUuid: uuid(1),
  sessionId: 's-2026-09-21',
  type: 'drill_done' as const,
  itemId: 'item-1',
  at: '2026-09-21T09:30:00+05:00',
  ...patch,
});

// --- Seams -----------------------------------------------------------------------------------------

const NOW = new Date('2026-09-21T06:00:00.000Z');
const NOW_ISO = '2026-09-21T06:00:00.000Z';

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const written: string[] = [];
  const removed: string[] = [];
  const store: KeyValueStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      written.push(key);
      data.set(key, value);
    },
    removeItem: (key) => {
      removed.push(key);
      data.delete(key);
    },
  };
  return { store, data, written, removed };
}

type Call = { url: string; method: string };

/** A fetch behind the real typed client; `respond` decides the answer, every call is recorded. */
function makeApi(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const api = createApi({
    fetch: async (input, init) => {
      const call = { url: input, method: init?.method ?? 'GET' };
      calls.push(call);
      return respond(call);
    },
    online: () => true,
    language: () => 'en',
  });
  return { api, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fresh store + api serving whatever `today()` currently returns; the closure lets a test change the server. */
function setup(today: () => Record<string, unknown> = () => makeToday(), initial: Record<string, string> = {}) {
  const fake = makeStore(initial);
  const remote = makeApi(() => json(200, today()));
  const deps: SessionStoreDeps = { store: fake.store, api: remote.api, now: () => NOW };
  return { ...fake, ...remote, sessions: createSessionStore(deps) };
}

const sessionKey = (playerId: string) => offlineKey(playerId, SESSION_KEY_NAME);
const doneFlags = (session: { items: { itemId: string; done: boolean }[] }) =>
  Object.fromEntries(session.items.map((item) => [item.itemId, item.done]));

// --- downloadToday ----------------------------------------------------------------------------------

describe('downloadToday', () => {
  test('fetches GET /api/player/today for the locale in one call and returns the OfflineSession', async () => {
    const { sessions, calls } = setup();
    const offline = await sessions.downloadToday('player-a', 'kk');
    expect(calls).toEqual([{ url: '/api/player/today?locale=kk', method: 'GET' }]);
    expect(offline.playerId).toBe('player-a');
    expect(offline.locale).toBe('kk');
    expect(offline.downloadedAt).toBe(NOW_ISO);
    expect(offline.session.id).toBe('s-2026-09-21');
    expect(offline.session.items).toHaveLength(3);
    expect(offline.session.items[0]?.content.dose).toEqual({ reps: 50 });
  });

  test.each(['kk', 'ru', 'en'] as const)('asks the server for locale %p', async (locale) => {
    const { sessions, calls } = setup();
    await sessions.downloadToday('player-a', locale);
    expect(calls[0]?.url).toBe(`/api/player/today?locale=${locale}`);
  });

  test('writes the OfflineSession under the player-namespaced key', async () => {
    const { sessions, store, data } = setup();
    const offline = await sessions.downloadToday('player-a', 'ru');
    expect(sessionKey('player-a')).toBe(`${OFFLINE_KEY_PREFIX}:player-a:${SESSION_KEY_NAME}`);
    expect(data.has(sessionKey('player-a'))).toBe(true);
    expect(readOfflineSession(store, 'player-a')).toEqual(offline);
  });

  test('two players on one device keep their own sessions', async () => {
    const { sessions, store, data } = setup();
    await sessions.downloadToday('player-a', 'kk');
    await sessions.downloadToday('player-b', 'en');
    expect(readOfflineSession(store, 'player-a')?.locale).toBe('kk');
    expect(readOfflineSession(store, 'player-b')?.locale).toBe('en');
    expect([...data.keys()].sort()).toEqual([sessionKey('player-a'), sessionKey('player-b')]);
  });

  test('a network failure rejects with an ApiProblem and leaves the stored session untouched', async () => {
    const good = setup();
    const before = await good.sessions.downloadToday('player-a', 'kk');
    const failing = makeApi(() => {
      throw new TypeError('Failed to fetch');
    });
    const sessions = createSessionStore({ store: good.store, api: failing.api, now: () => new Date('2026-09-22T06:00:00.000Z') });
    const error = await sessions.downloadToday('player-a', 'kk').catch((e: unknown) => e);
    expect(isApiProblem(error)).toBe(true);
    expect(readOfflineSession(good.store, 'player-a')).toEqual(before);
  });

  test('a server error rejects and writes nothing', async () => {
    const fake = makeStore();
    const failing = makeApi(() => json(500, { type: 'about:blank', title: 'Boom', status: 500 }));
    const sessions = createSessionStore({ store: fake.store, api: failing.api, now: () => NOW });
    const error = await sessions.downloadToday('player-a', 'kk').catch((e: unknown) => e);
    expect(isApiProblem(error)).toBe(true);
    expect(fake.written).toEqual([]);
  });

  test('a response that is not a TodaySession is rejected and never stored', async () => {
    const { sessions, written } = setup(() => ({ id: 's-1', date: '2026-09-21' }));
    const error = await sessions.downloadToday('player-a', 'kk').catch((e: unknown) => e);
    expect(isApiProblem(error)).toBe(true);
    expect(written).toEqual([]);
  });

  test('rejects instead of pretending success when the session cannot be persisted', async () => {
    const fake = makeStore();
    fake.store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const remote = makeApi(() => json(200, makeToday()));
    const sessions = createSessionStore({ store: fake.store, api: remote.api, now: () => NOW });
    await expect(sessions.downloadToday('player-a', 'kk')).rejects.toThrow();
  });

  test('rejects when the device has no storage at all', async () => {
    const remote = makeApi(() => json(200, makeToday()));
    const sessions = createSessionStore({ store: null, api: remote.api, now: () => NOW });
    await expect(sessions.downloadToday('player-a', 'kk')).rejects.toThrow();
  });
});

// --- getOffline: download then read -----------------------------------------------------------------

describe('getOffline', () => {
  test('returns what was downloaded, for the session date, without touching the network', async () => {
    const { sessions, calls } = setup();
    const downloaded = await sessions.downloadToday('player-a', 'kk');
    calls.length = 0;
    const read = sessions.getOffline('player-a', '2026-09-21');
    expect(read).toEqual(downloaded);
    expect(calls).toEqual([]);
  });

  test('a fresh store instance reads the same data (survives an app restart)', async () => {
    const { sessions, store } = setup();
    const downloaded = await sessions.downloadToday('player-a', 'kk');
    const restarted = createSessionStore({ store, api: makeApi(() => json(500, {})).api, now: () => NOW });
    expect(restarted.getOffline('player-a', '2026-09-21')).toEqual(downloaded);
  });

  test('is undefined for a different date', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.getOffline('player-a', '2026-09-22')).toBeUndefined();
  });

  test('is undefined for a player who downloaded nothing', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.getOffline('player-b', '2026-09-21')).toBeUndefined();
  });

  test('is undefined when the device has no storage', () => {
    const remote = makeApi(() => json(200, makeToday()));
    const sessions = createSessionStore({ store: null, api: remote.api, now: () => NOW });
    expect(sessions.getOffline('player-a', '2026-09-21')).toBeUndefined();
  });
});

// --- A downloaded session is never altered by newer commons versions ------------------------------------

describe('a downloaded session is frozen against newer commons versions', () => {
  const newerCommons = () =>
    makeToday({
      graphVersion: '0.2.0',
      items: [
        makeItem({ drillVersionId: 'weak-foot-50-v2', content: makeContent('Weak Foot 50 (revised)') }),
        makeItem({ itemId: 'item-2', drillVersionId: 'wall-passes-v3' }),
        makeItem({ itemId: 'item-3', drillVersionId: 'juggling-v2' }),
      ],
    });

  test('downloading the same session again keeps the stored content, versions and downloadedAt', async () => {
    let server = makeToday();
    const { sessions, store } = setup(() => server);
    const first = await sessions.downloadToday('player-a', 'kk');

    server = newerCommons();
    const laterClock = createSessionStore({ store, api: makeApi(() => json(200, server)).api, now: () => new Date('2026-09-21T12:00:00.000Z') });
    const second = await laterClock.downloadToday('player-a', 'kk');

    expect(second).toEqual(first);
    const onDevice = readOfflineSession(store, 'player-a');
    expect(onDevice).toEqual(first);
    expect(onDevice?.session.graphVersion).toBe('0.1.0');
    expect(onDevice?.session.items[0]?.drillVersionId).toBe('weak-foot-50-v1');
    expect(onDevice?.session.items[0]?.content.title?.en).toBe('Weak Foot 50');
    expect(onDevice?.downloadedAt).toBe(NOW_ISO);
  });

  test('re-downloading does not wipe progress made offline', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    await sessions.downloadToday('player-a', 'kk');
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)).toEqual({ 'item-1': true, 'item-2': false, 'item-3': false });
  });

  test('applying local events touches only done flags, never the drill content or versions', async () => {
    const { sessions, store } = setup();
    const before = await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    sessions.applyLocalEvent(makeEvent({ clientUuid: uuid(2), itemId: 'item-2' }));
    const after = readOfflineSession(store, 'player-a')!;
    const strip = (s: typeof before) => ({ ...s.session, items: s.session.items.map(({ done: _done, ...rest }) => rest) });
    expect(strip(after)).toEqual(strip(before));
  });

  test('a different session (a new day) replaces the old one', async () => {
    let server = makeToday();
    const { sessions, store } = setup(() => server);
    await sessions.downloadToday('player-a', 'kk');
    server = makeToday({ id: 's-2026-09-22', date: '2026-09-22', graphVersion: '0.2.0' });
    const next = await createSessionStore({ store, api: makeApi(() => json(200, server)).api, now: () => new Date('2026-09-22T05:00:00.000Z') }).downloadToday('player-a', 'kk');
    expect(next.session.id).toBe('s-2026-09-22');
    expect(next.downloadedAt).toBe('2026-09-22T05:00:00.000Z');
    expect(readOfflineSession(store, 'player-a')).toEqual(next);
  });
});

// --- applyLocalEvent -----------------------------------------------------------------------------------

describe('applyLocalEvent', () => {
  test('drill_done marks that item done, persists it, and returns the updated OfflineSession', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const updated = sessions.applyLocalEvent(makeEvent({ itemId: 'item-2' }));
    expect(updated && doneFlags(updated.session)).toEqual({ 'item-1': false, 'item-2': true, 'item-3': false });
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)).toEqual({ 'item-1': false, 'item-2': true, 'item-3': false });
    expect(sessions.getOffline('player-a', '2026-09-21')?.session.items[1]?.done).toBe(true);
  });

  test('drill_undone clears a done flag', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    sessions.applyLocalEvent(makeEvent({ clientUuid: uuid(2), type: 'drill_undone' }));
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-1']).toBe(false);
  });

  test('is idempotent: applying the same event twice gives the same session', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    const once = store.getItem(sessionKey('player-a'));
    sessions.applyLocalEvent(makeEvent());
    expect(store.getItem(sessionKey('player-a'))).toBe(once!);
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-1']).toBe(true);
  });

  test('keeps downloadedAt, locale, playerId and the session id', async () => {
    const { sessions } = setup();
    const before = await sessions.downloadToday('player-a', 'kk');
    const after = sessions.applyLocalEvent(makeEvent());
    expect(after?.downloadedAt).toBe(before.downloadedAt);
    expect(after?.locale).toBe('kk');
    expect(after?.playerId).toBe('player-a');
    expect(after?.session.id).toBe(before.session.id);
  });

  test.each([
    ['result', { type: 'result', value: 12 }],
    ['session_finished', { type: 'session_finished', itemId: undefined }],
  ])('%s does not change any done flag', async (_name, patch) => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    sessions.applyLocalEvent(makeEvent({ clientUuid: uuid(3), ...patch }));
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)).toEqual({ 'item-1': true, 'item-2': false, 'item-3': false });
  });

  test.each([
    ['result', { type: 'result', value: 12 }],
    ['session_finished', { type: 'session_finished' }],
  ])('%s aimed at a not-yet-done item leaves it not done', async (_name, patch) => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.applyLocalEvent(makeEvent({ itemId: 'item-2', ...patch }))).toBeUndefined();
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)).toEqual({ 'item-1': false, 'item-2': false, 'item-3': false });
  });

  test('an event that fails the SessionEvent schema is ignored even when its type and item look right', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const before = store.getItem(sessionKey('player-a'));
    expect(sessions.applyLocalEvent(makeEvent({ clientUuid: 'not-a-uuid' }))).toBeUndefined();
    expect(sessions.applyLocalEvent(makeEvent({ at: 'yesterday' }))).toBeUndefined();
    expect(store.getItem(sessionKey('player-a'))).toBe(before!);
  });

  test('an unknown item changes nothing, writes nothing and returns undefined', async () => {
    const { sessions, written } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const writesBefore = written.length;
    expect(sessions.applyLocalEvent(makeEvent({ itemId: 'item-99' }))).toBeUndefined();
    expect(written.length).toBe(writesBefore);
  });

  test('an event for another session changes nothing', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.applyLocalEvent(makeEvent({ sessionId: 's-2026-09-20' }))).toBeUndefined();
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)).toEqual({ 'item-1': false, 'item-2': false, 'item-3': false });
  });

  test('a malformed event is ignored without throwing', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const before = store.getItem(sessionKey('player-a'));
    expect(sessions.applyLocalEvent({ nonsense: true } as never)).toBeUndefined();
    expect(sessions.applyLocalEvent(makeEvent({ type: 'drill_exploded' }) as never)).toBeUndefined();
    expect(store.getItem(sessionKey('player-a'))).toBe(before!);
  });

  test('does nothing before any session was downloaded', () => {
    const { sessions, written } = setup();
    expect(sessions.applyLocalEvent(makeEvent())).toBeUndefined();
    expect(written).toEqual([]);
  });

  test('only writes the session key, never the outbox', async () => {
    const { sessions, written } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    expect(new Set(written)).toEqual(new Set([sessionKey('player-a')]));
  });

  test('acts on the active player: the one who last downloaded or read', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    await sessions.downloadToday('player-b', 'en');
    sessions.applyLocalEvent(makeEvent());
    expect(doneFlags(readOfflineSession(store, 'player-b')!.session)['item-1']).toBe(true);
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-1']).toBe(false);

    sessions.getOffline('player-a', '2026-09-21');
    sessions.applyLocalEvent(makeEvent({ clientUuid: uuid(4), itemId: 'item-2' }));
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-2']).toBe(true);
    expect(doneFlags(readOfflineSession(store, 'player-b')!.session)['item-2']).toBe(false);
  });

  test('a restarted app acts on the player it reads first', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const restarted = createSessionStore({ store, api: makeApi(() => json(500, {})).api, now: () => NOW });
    restarted.getOffline('player-a', '2026-09-21');
    restarted.applyLocalEvent(makeEvent());
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-1']).toBe(true);
  });

  test('an explicit playerId targets that player and leaves the active one alone', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    await sessions.downloadToday('player-b', 'en');
    sessions.applyLocalEvent(makeEvent(), 'player-a');
    expect(doneFlags(readOfflineSession(store, 'player-a')!.session)['item-1']).toBe(true);
    expect(doneFlags(readOfflineSession(store, 'player-b')!.session)['item-1']).toBe(false);
  });

  test('throws when the updated session cannot be persisted, so progress is never silently lost', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => sessions.applyLocalEvent(makeEvent())).toThrow();
  });
});

// --- status ------------------------------------------------------------------------------------------------

describe('status', () => {
  test('is unavailable before anything was downloaded', () => {
    const { sessions } = setup();
    expect(sessions.status()).toEqual({ available: false, downloadedAt: null });
    expect(sessions.status('player-a')).toEqual({ available: false, downloadedAt: null });
  });

  test('reports availability and when the session was downloaded', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.status()).toEqual({ available: true, downloadedAt: NOW_ISO });
    expect(sessions.status('player-a')).toEqual({ available: true, downloadedAt: NOW_ISO });
  });

  test('is per player', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    expect(sessions.status('player-b')).toEqual({ available: false, downloadedAt: null });
  });

  test('without an argument it follows the active player', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.getOffline('player-b', '2026-09-21');
    expect(sessions.status()).toEqual({ available: false, downloadedAt: null });
  });

  test('downloadedAt is the stored download time, not the current clock', async () => {
    const { sessions, store } = setup();
    await sessions.downloadToday('player-a', 'kk');
    const later = createSessionStore({ store, api: makeApi(() => json(500, {})).api, now: () => new Date('2026-09-25T00:00:00.000Z') });
    expect(later.status('player-a')).toEqual({ available: true, downloadedAt: NOW_ISO });
  });

  test('applying an event does not change downloadedAt', async () => {
    const { sessions } = setup();
    await sessions.downloadToday('player-a', 'kk');
    sessions.applyLocalEvent(makeEvent());
    expect(sessions.status()).toEqual({ available: true, downloadedAt: NOW_ISO });
  });

  test('is unavailable without storage', () => {
    const remote = makeApi(() => json(200, makeToday()));
    const sessions = createSessionStore({ store: null, api: remote.api, now: () => NOW });
    expect(sessions.status('player-a')).toEqual({ available: false, downloadedAt: null });
  });
});

// --- Corrupted record resets --------------------------------------------------------------------------------

describe('a corrupted record resets instead of crashing', () => {
  const corrupt = (raw: string) => setup(() => makeToday(), { [sessionKey('player-a')]: raw });

  test.each([
    ['unparsable JSON', '{"playerId": "player-a", "sess'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
    ['an object of the wrong shape', JSON.stringify({ playerId: 'player-a', session: { id: 's-1' } })],
  ])('getOffline on %s returns undefined and removes the key', (_name, raw) => {
    const { sessions, data, removed } = corrupt(raw);
    expect(sessions.getOffline('player-a', '2026-09-21')).toBeUndefined();
    expect(data.has(sessionKey('player-a'))).toBe(false);
    expect(removed).toEqual([sessionKey('player-a')]);
  });

  test('status on a corrupted record is unavailable and resets it', () => {
    const { sessions, data } = corrupt('not json at all');
    expect(sessions.status('player-a')).toEqual({ available: false, downloadedAt: null });
    expect(data.has(sessionKey('player-a'))).toBe(false);
  });

  test('applyLocalEvent on a corrupted record returns undefined, resets it and does not throw', () => {
    const { sessions, data } = corrupt('not json at all');
    expect(sessions.applyLocalEvent(makeEvent(), 'player-a')).toBeUndefined();
    expect(data.has(sessionKey('player-a'))).toBe(false);
  });

  test("resetting one player's record leaves the other player's session alone", async () => {
    const { sessions, data, store } = setup();
    await sessions.downloadToday('player-b', 'en');
    data.set(sessionKey('player-a'), '{broken');
    expect(sessions.getOffline('player-a', '2026-09-21')).toBeUndefined();
    expect(readOfflineSession(store, 'player-b')?.locale).toBe('en');
  });

  test('after a reset the next download works and is stored', async () => {
    const { sessions, store } = corrupt('{broken');
    expect(sessions.getOffline('player-a', '2026-09-21')).toBeUndefined();
    const fresh = await sessions.downloadToday('player-a', 'kk');
    expect(readOfflineSession(store, 'player-a')).toEqual(fresh);
    expect(sessions.getOffline('player-a', '2026-09-21')).toEqual(fresh);
  });

  test('downloading over a corrupted record stores the new session', async () => {
    const { sessions, store } = corrupt('{broken');
    const fresh = await sessions.downloadToday('player-a', 'kk');
    expect(readOfflineSession(store, 'player-a')).toEqual(fresh);
  });

  test('a store whose reads throw does not crash the reads', () => {
    const fake = makeStore();
    fake.store.getItem = () => {
      throw new Error('SecurityError');
    };
    const remote = makeApi(() => json(200, makeToday()));
    const sessions = createSessionStore({ store: fake.store, api: remote.api, now: () => NOW });
    expect(sessions.getOffline('player-a', '2026-09-21')).toBeUndefined();
    expect(sessions.status('player-a')).toEqual({ available: false, downloadedAt: null });
  });
});

// --- The module-level functions (bound to the device's default storage) ---------------------------------------

describe('module exports', () => {
  test('downloadToday, getOffline, applyLocalEvent and status are exported functions', () => {
    expect(typeof downloadToday).toBe('function');
    expect(typeof getOffline).toBe('function');
    expect(typeof applyLocalEvent).toBe('function');
    expect(typeof status).toBe('function');
  });

  test('with no active player yet, status() is unavailable and applyLocalEvent() does nothing', () => {
    expect(status()).toEqual({ available: false, downloadedAt: null });
    expect(applyLocalEvent(makeEvent())).toBeUndefined();
  });
});
