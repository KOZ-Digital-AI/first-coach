import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import * as bootstrap from './bootstrap';
import { watchAuthSession, wireAppPlayerSession } from './bootstrap';
import type { PlayerSessionWiringDeps } from './bootstrap';
import { createPlayerAuthClient } from './lib/auth';
import { persistAppQueryClient, type PersistStore } from './lib/query-persist';
import { TodaySession } from '@api-types/session';
import { type KeyValueStore, writeOfflineSession } from './offline/types';

// fc-mol-eay.12: a cold start OFFLINE cannot ask the server who the player is (get-session fails), so the persisted query cache
// and the outbox were never wired and /train showed "Could not load". bootstrap.ts now remembers the last player id on the
// device (localStorage `fc:last-player`) and, at start-up, wires that id BEFORE the session atom has answered. The atom stays the
// only source of the id and of any change of it: it confirms, replaces or (sign-out) clears the remembered id. Everything the
// wiring touches is a seam (see bootstrap.offline.test.ts), so these tests use fakes; the last two groups use the real Better
// Auth client and the real localStorage.
//
// Readings of the criteria (where they were open):
// - "REMOVED on sign-out / player switch": the atom settling WITHOUT a session (sign-out, or a server that says "no session")
//   removes the id; a DIFFERENT id replaces it. A session read that FAILED (offline, server down: the atom's `error` is set and
//   there is no data) is not "no session": nothing is reported, so the remembered id and its wiring survive an offline start.
//   An error that IS an answer (HTTP 401) still counts as "no session".
// - a remembered id that cannot be used as a storage namespace (empty, contains ':') is ignored, never wired.
// - a remembered id that makes the start-up wiring throw is dropped, and the app still boots.

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An in-memory `lastPlayer` seam that records what the wiring did to it. */
function memoryLastPlayer(initial?: string) {
  let value = initial;
  const log: string[] = [];
  return {
    log,
    value: () => value,
    read: () => value,
    write: (playerId: string) => {
      value = playerId;
      log.push(`write:${playerId}`);
    },
    clear: () => {
      value = undefined;
      log.push('clear');
    },
  };
}

function harness(options: { stored?: string; initial?: 'none' | string } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(playerId: string | undefined) => void>();
  const lastPlayer = memoryLastPlayer(options.stored);
  let syncs = 0;
  const persisted: { playerId: string; queryClient: QueryClient; buildVersion: string | undefined }[] = [];
  const deps: PlayerSessionWiringDeps = {
    watchSession(listener) {
      calls.push('watch');
      listeners.add(listener);
      if (options.initial !== undefined) listener(options.initial === 'none' ? undefined : options.initial);
      return () => void listeners.delete(listener);
    },
    configureEventsPlayer(playerId) {
      calls.push(`player:${playerId}`);
    },
    startEventsSync() {
      syncs += 1;
      const n = syncs;
      calls.push(`start:${n}`);
      return () => void calls.push(`stop:${n}`);
    },
    persistAppQueryClient(persist) {
      persisted.push({ playerId: persist.playerId, queryClient: persist.queryClient, buildVersion: persist.buildVersion });
      calls.push(`persist:${persist.playerId}`);
      return [() => void calls.push(`unpersist:${persist.playerId}`), Promise.resolve()];
    },
    resolveBuildVersion: () => 'build-test-1',
    lastPlayer,
  };
  return {
    calls,
    deps,
    lastPlayer,
    persisted,
    emit: (playerId: string | undefined) => {
      for (const listener of [...listeners]) listener(playerId);
    },
  };
}

describe('wireAppPlayerSession: the last player id is remembered and restored at start-up', () => {
  test('a remembered id is wired at start-up: events player, persisted cache (restored) and sync, before the session signal is even subscribed', async () => {
    const h = harness({ stored: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch']);
    expect(h.persisted[0]?.buildVersion).toBe('build-test-1');
  });

  test('the events player is configured BEFORE the sync starts, as for a session-reported id', async () => {
    const h = harness({ stored: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    expect(h.calls.indexOf('player:p1')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('player:p1')).toBeLessThan(h.calls.indexOf('start:1'));
  });

  test('the SAME id answered later by the session signal changes nothing: wired once, still remembered', async () => {
    const h = harness({ stored: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    h.emit('p1');
    h.emit('p1');
    await flush();
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch']);
    expect(h.lastPlayer.value()).toBe('p1');
  });

  test('a DIFFERENT id answered later re-wires: the old wiring stops first, the new id is wired and remembered', async () => {
    const h = harness({ stored: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    h.emit('p2');
    await flush();
    expect(h.calls).toEqual([
      'player:p1', 'persist:p1', 'start:1', 'watch',
      'stop:1', 'unpersist:p1', 'player:undefined',
      'player:p2', 'persist:p2', 'start:2',
    ]);
    expect(h.lastPlayer.value()).toBe('p2');
  });

  test('a different id answered ON subscribe (the atom delivers its value at once) re-wires in the same order', async () => {
    const h = harness({ stored: 'p1', initial: 'p2' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    expect(h.calls).toEqual([
      'player:p1', 'persist:p1', 'start:1', 'watch',
      'stop:1', 'unpersist:p1', 'player:undefined',
      'player:p2', 'persist:p2', 'start:2',
    ]);
    expect(h.lastPlayer.value()).toBe('p2');
  });

  test('a player switch empties the in-memory query cache: the remembered player\'s data is never saved into the next player', async () => {
    const h = harness({ stored: 'p1' });
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    queryClient.setQueryData(['today'], { id: 'p1-session' });
    h.emit('p2');
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('sign-out (the session settles without a session): everything for the remembered id is torn down and the id is REMOVED', async () => {
    const h = harness({ stored: 'p1' });
    const queryClient = new QueryClient();
    wireAppPlayerSession(queryClient, h.deps);
    queryClient.setQueryData(['today'], { id: 'p1-session' });
    h.emit(undefined);
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch', 'stop:1', 'unpersist:p1', 'player:undefined']);
    expect(h.lastPlayer.value()).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('after the sign-out the next session id is wired and remembered again', async () => {
    const h = harness({ stored: 'p1' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    h.emit(undefined);
    h.emit('p3');
    expect(h.calls.slice(-3)).toEqual(['player:p3', 'persist:p3', 'start:2']);
    expect(h.lastPlayer.value()).toBe('p3');
  });

  test('the id reported by the session is remembered when it is reported (nothing was remembered before)', async () => {
    const h = harness();
    wireAppPlayerSession(new QueryClient(), h.deps);
    expect(h.lastPlayer.value()).toBeUndefined();
    h.emit('p1');
    expect(h.lastPlayer.value()).toBe('p1');
    expect(h.calls).toEqual(['watch', 'player:p1', 'persist:p1', 'start:1']);
  });

  test('a fresh visitor (nothing remembered, the atom settles without a session) wires nothing and remembers nothing', async () => {
    const h = harness({ initial: 'none' });
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls).toEqual(['watch']);
    expect(h.persisted).toEqual([]);
    expect(h.lastPlayer.value()).toBeUndefined();
    expect(h.lastPlayer.log.filter((entry) => entry.startsWith('write'))).toEqual([]);
  });

  test('a fresh visitor before the atom has answered: nothing is wired at start-up', async () => {
    const h = harness();
    wireAppPlayerSession(new QueryClient(), h.deps);
    await flush();
    expect(h.calls).toEqual(['watch']);
  });

  test('the start-up wiring keeps what the query cache already holds (screens may have fetched before)', async () => {
    const h = harness({ stored: 'p1' });
    const queryClient = new QueryClient();
    queryClient.setQueryData(['today'], { id: 'already-here' });
    wireAppPlayerSession(queryClient, h.deps);
    expect(queryClient.getQueryData<{ id: string }>(['today'])).toEqual({ id: 'already-here' });
  });

  test('the teardown stops the remembered player\'s wiring, ignores later signals and does NOT forget the id (a reload must restore it)', async () => {
    const h = harness({ stored: 'p1' });
    const teardown = wireAppPlayerSession(new QueryClient(), h.deps);
    teardown();
    h.emit('p2');
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch', 'stop:1', 'unpersist:p1', 'player:undefined']);
    expect(h.lastPlayer.value()).toBe('p1');
  });

  test('a remembered id that makes the start-up wiring throw is dropped: the app still boots, the signal is still watched', async () => {
    const h = harness({ stored: 'p1' });
    const failing: PlayerSessionWiringDeps = {
      ...h.deps,
      persistAppQueryClient(options) {
        if (options.playerId === 'p1') throw new TypeError('query-persist: playerId must be a non-empty string');
        return h.deps.persistAppQueryClient(options);
      },
    };
    expect(() => wireAppPlayerSession(new QueryClient(), failing)).not.toThrow();
    expect(h.lastPlayer.value()).toBeUndefined();
    expect(h.calls).toContain('watch');
    h.emit('p2');
    expect(h.lastPlayer.value()).toBe('p2');
  });

  test('a lastPlayer store that throws never breaks the wiring', async () => {
    const h = harness();
    const throwing = {
      read: () => {
        throw new Error('blocked');
      },
      write: () => {
        throw new Error('quota');
      },
      clear: () => {
        throw new Error('blocked');
      },
    };
    expect(() => wireAppPlayerSession(new QueryClient(), { ...h.deps, lastPlayer: throwing })).not.toThrow();
    h.emit('p1');
    h.emit(undefined);
    expect(h.calls).toEqual(['watch', 'player:p1', 'persist:p1', 'start:1', 'stop:1', 'unpersist:p1', 'player:undefined']);
  });
});

describe('createLastPlayerStore: the id in localStorage under fc:last-player', () => {
  function mapStorage(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  }

  test('the key is fc:last-player', () => {
    expect(bootstrap.LAST_PLAYER_KEY).toBe('fc:last-player');
  });

  test('write then read gives the id back, under the key and nothing else', () => {
    const storage = mapStorage();
    const store = bootstrap.createLastPlayerStore(storage);
    store.write('p1');
    expect(storage.data.get('fc:last-player')).toBe('p1');
    expect(store.read()).toBe('p1');
    expect([...storage.data.keys()]).toEqual(['fc:last-player']);
  });

  test('clear removes the key', () => {
    const storage = mapStorage({ 'fc:last-player': 'p1' });
    const store = bootstrap.createLastPlayerStore(storage);
    store.clear();
    expect(storage.data.has('fc:last-player')).toBe(false);
    expect(store.read()).toBeUndefined();
  });

  test('nothing remembered reads as undefined', () => {
    expect(bootstrap.createLastPlayerStore(mapStorage()).read()).toBeUndefined();
  });

  test('an id that cannot be a storage namespace (empty, or with ":") reads as undefined', () => {
    expect(bootstrap.createLastPlayerStore(mapStorage({ 'fc:last-player': '' })).read()).toBeUndefined();
    expect(bootstrap.createLastPlayerStore(mapStorage({ 'fc:last-player': 'a:b' })).read()).toBeUndefined();
  });

  test('a device without storage (null) reads undefined and never throws', () => {
    const store = bootstrap.createLastPlayerStore(null);
    expect(store.read()).toBeUndefined();
    expect(() => store.write('p1')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  test('a storage that throws (private mode, blocked) never throws out of the store', () => {
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = bootstrap.createLastPlayerStore(blocked);
    expect(store.read()).toBeUndefined();
    expect(() => store.write('p1')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  test('readLastPlayerId reads the given storage', () => {
    expect(bootstrap.readLastPlayerId(mapStorage({ 'fc:last-player': 'p7' }))).toBe('p7');
    expect(bootstrap.readLastPlayerId(mapStorage())).toBeUndefined();
  });
});

describe('the default lastPlayer store is the device localStorage', () => {
  beforeEach(() => localStorage.removeItem('fc:last-player'));
  afterEach(() => localStorage.removeItem('fc:last-player'));

  test('a reported id is written to localStorage fc:last-player and a sign-out removes it', () => {
    const h = harness();
    const { lastPlayer: _fake, ...withoutSeam } = h.deps;
    wireAppPlayerSession(new QueryClient(), withoutSeam);
    h.emit('p1');
    expect(localStorage.getItem('fc:last-player')).toBe('p1');
    h.emit(undefined);
    expect(localStorage.getItem('fc:last-player')).toBeNull();
  });

  test('a stored fc:last-player is restored at start-up', () => {
    localStorage.setItem('fc:last-player', 'p9');
    const h = harness();
    const { lastPlayer: _fake, ...withoutSeam } = h.deps;
    wireAppPlayerSession(new QueryClient(), withoutSeam);
    expect(h.calls).toEqual(['player:p9', 'persist:p9', 'start:1', 'watch']);
  });
});

describe('watchAuthSession: a session read that FAILED is not "no session"', () => {
  type Value = { data?: unknown; error?: unknown; isPending?: boolean; isRefetching?: boolean };
  function collect(initial: Value) {
    let value = initial;
    const listeners = new Set<(value: Value) => void>();
    const seen: (string | undefined)[] = [];
    watchAuthSession(
      {
        subscribe(listener) {
          listeners.add(listener);
          listener(value);
          return () => void listeners.delete(listener);
        },
      },
      (id) => void seen.push(id),
    );
    return {
      seen,
      set(next: Value) {
        value = next;
        for (const listener of [...listeners]) listener(value);
      },
    };
  }

  test('no data and a network error (offline start): nothing is reported', () => {
    const { seen } = collect({ data: null, error: new TypeError('Failed to fetch'), isPending: false, isRefetching: false });
    expect(seen).toHaveLength(0);
  });

  test('no data and a server error (500): nothing is reported', () => {
    expect(collect({ data: null, error: { status: 500, statusText: 'Internal Server Error' }, isPending: false }).seen).toHaveLength(0);
  });

  test('no data and a 401 answer IS "no session"', () => {
    // (toEqual([undefined]) would also accept [], so the length is asserted)
    const { seen } = collect({ data: null, error: { status: 401, statusText: 'Unauthorized' }, isPending: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });

  test('the same session with a failed re-read still reports its id (the previous data is kept)', () => {
    const { seen } = collect({ data: { user: { id: 'p1' } }, error: new TypeError('Failed to fetch'), isPending: false });
    expect(seen).toEqual(['p1']);
  });

  test('a settled "no session" with no error still reports undefined', () => {
    const { seen } = collect({ data: null, error: null, isPending: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });

  test('a failed read after a good one reports nothing new (the sign-out is not faked by a lost connection)', () => {
    const { seen, set } = collect({ data: { user: { id: 'p1' } }, error: null, isPending: false });
    set({ data: null, error: new TypeError('Failed to fetch'), isPending: false });
    expect(seen).toEqual(['p1']);
  });
});

describe('with the real Better Auth client: one get-session per load, the remembered player survives an offline start', () => {
  const ORIGIN = 'http://coach.test';
  const GET_SESSION = 'GET /api/auth/get-session';

  function server(mode: 'offline' | { session: { id: string } | null }) {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (new URL(request.url).pathname === '/api/auth/get-session') {
        return Response.json(mode.session === null ? null : { session: { id: 's0' }, user: { id: mode.session.id, isAnonymous: false } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { requests, fetchImpl };
  }

  function wired(stored: string | undefined, mode: 'offline' | { session: { id: string } | null }) {
    const s = server(mode);
    const client = createPlayerAuthClient({ baseURL: ORIGIN, fetch: s.fetchImpl });
    const h = harness({ stored });
    const teardown = wireAppPlayerSession(new QueryClient(), {
      ...h.deps,
      watchSession: (listener) => {
        h.calls.push('watch');
        return watchAuthSession(client.$store.atoms.session, listener);
      },
    });
    const shell = renderHook(() => client.useSession());
    return { s, h, client, teardown, shell };
  }

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  };

  test('OFFLINE start (get-session fails) with a remembered id: wired for it, ONE get-session, still wired and remembered once the read has failed', async () => {
    const { s, h, shell, teardown } = wired('p1', 'offline');
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch']);
    await until(() => !shell.result.current.isPending);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch']);
    expect(h.lastPlayer.value()).toBe('p1');
    teardown();
  });

  test('ONLINE start, the server has the same session: wired once, ONE get-session', async () => {
    const { s, h, shell, teardown } = wired('p1', { session: { id: 'p1' } });
    await until(() => !shell.result.current.isPending);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch']);
    teardown();
  });

  test('ONLINE start, the server has ANOTHER player: re-wired for that player, the remembered id replaced', async () => {
    const { h, shell, teardown } = wired('p1', { session: { id: 'p2' } });
    await until(() => !shell.result.current.isPending);
    expect(h.calls).toEqual([
      'player:p1', 'persist:p1', 'start:1', 'watch',
      'stop:1', 'unpersist:p1', 'player:undefined',
      'player:p2', 'persist:p2', 'start:2',
    ]);
    expect(h.lastPlayer.value()).toBe('p2');
    teardown();
  });

  test('ONLINE start, the server says there is no session (signed out elsewhere): torn down and forgotten, and no sign-in is made', async () => {
    const { s, h, shell, teardown } = wired('p1', { session: null });
    await until(() => !shell.result.current.isPending);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual(['player:p1', 'persist:p1', 'start:1', 'watch', 'stop:1', 'unpersist:p1', 'player:undefined']);
    expect(h.lastPlayer.value()).toBeUndefined();
    teardown();
  });

  test('a fresh visitor (nothing remembered): exactly ONE get-session, no sign-in, nothing wired, nothing remembered', async () => {
    const { s, h, shell, teardown } = wired(undefined, { session: null });
    await until(() => !shell.result.current.isPending);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual(['watch']);
    expect(h.lastPlayer.value()).toBeUndefined();
    teardown();
  });

  test('a fresh visitor OFFLINE: nothing wired, nothing remembered', async () => {
    const { s, h, shell, teardown } = wired(undefined, 'offline');
    await until(() => !shell.result.current.isPending);
    expect(s.requests).toEqual([GET_SESSION]);
    expect(h.calls).toEqual(['watch']);
    teardown();
  });
});

describe('seedTodayFromDevice: the downloaded session of the last player, when the query cache has none', () => {
  const attribution = {
    author: 'FIRST COACH Genesis',
    source: 'FIRST COACH Genesis',
    license: 'CC-BY-SA-4.0',
    createdAt: '2026-09-01T10:00:00Z',
    semver: '1.0.0',
  };
  const item = (itemId: string, done: boolean) => ({
    itemId,
    drillVersionId: `${itemId}-v1`,
    minutes: 5,
    done,
    status: 'COMMUNITY',
    attribution,
    content: {
      title: { en: `Drill ${itemId}` },
      goal: { en: `Goal of ${itemId}` },
      instructions: { en: 'Do it.' },
      dose: { reps: 10 },
      conditions: { equipment: 'ball', spaces: ['yard'] },
    },
  });
  const session = (id = 'session-1') =>
    TodaySession.parse({
    id,
    date: '2026-09-21',
    planner: 'rules' as const,
    totalMinutes: 10,
    graphVersion: '0.1.0',
    items: [item('item-1', true), item('item-2', false)],
    roadmapSummary: {
      currentLevelLabel: 'Basic',
      sessionsPerWeek: 3,
      minutesPerSession: 20,
      focus: [
        { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
        { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
      ],
    },
  });
  const DOWNLOADED_AT = '2026-09-21T10:00:00.000Z';

  function device(lastPlayer: string | undefined, sessionFor?: string) {
    const data = new Map<string, string>();
    const storage: KeyValueStore = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    if (lastPlayer !== undefined) storage.setItem('fc:last-player', lastPlayer);
    if (sessionFor !== undefined) {
      writeOfflineSession(storage, sessionFor, {
        playerId: sessionFor,
        session: session() as never,
        downloadedAt: DOWNLOADED_AT,
        locale: 'en',
      });
    }
    return { storage, data };
  }

  test('puts the downloaded session into the [\'today\'] cache, stamped with its download time, and returns that time', () => {
    const { storage } = device('p1', 'p1');
    const queryClient = new QueryClient();
    const updatedAt = bootstrap.seedTodayFromDevice(queryClient, storage);
    expect(updatedAt).toBe(Date.parse(DOWNLOADED_AT));
    expect(queryClient.getQueryData<{ id: string }>(['today'])?.id).toBe('session-1');
    expect(queryClient.getQueryState(['today'])?.dataUpdatedAt).toBe(Date.parse(DOWNLOADED_AT));
  });

  test('progress made offline (the done flags in the stored session) is what is seeded', () => {
    const { storage } = device('p1', 'p1');
    const queryClient = new QueryClient();
    bootstrap.seedTodayFromDevice(queryClient, storage);
    const today = queryClient.getQueryData<{ items: { itemId: string; done: boolean }[] }>(['today']);
    expect(today?.items.map((entry) => [entry.itemId, entry.done])).toEqual([['item-1', true], ['item-2', false]]);
  });

  test('a session already in the cache is never overwritten', () => {
    const { storage } = device('p1', 'p1');
    const queryClient = new QueryClient();
    queryClient.setQueryData(['today'], { id: 'fresher' });
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData<{ id: string }>(['today'])).toEqual({ id: 'fresher' });
  });

  test('no remembered player: nothing is seeded', () => {
    const { storage } = device(undefined, 'p1');
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('no remembered player: a session downloaded by some player is never guessed to be theirs', () => {
    const { storage } = device(undefined, 'p2');
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('another player\'s downloaded session is never used for the remembered player', () => {
    const { storage } = device('p1', 'p2');
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('a remembered player with nothing downloaded: nothing is seeded', () => {
    const { storage } = device('p1');
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('a corrupt stored session is ignored', () => {
    const { storage, data } = device('p1');
    data.set('fc:p1:session', '{"not":"a session"}');
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, storage)).toBeUndefined();
    expect(queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('a device without storage: nothing is seeded, nothing throws', () => {
    const queryClient = new QueryClient();
    expect(bootstrap.seedTodayFromDevice(queryClient, null)).toBeUndefined();
  });
});

describe('a restore that is still pending when the player changes never hydrates the previous player (fc-mol-eay.12, cold review)', () => {
  // persistQueryClient's unsubscribe only stops the LATER save subscription: the restore that is already running still hydrates
  // afterwards. With the last player remembered, start-up wires A and starts A's (asynchronous, IndexedDB) restore; when the
  // session atom answers first with B (or with no session), A's late restore must not put A's ['today'] into B's cache, and B's
  // persist subscription must never save it into B's own record. The REAL persister runs over a store whose read of A's record
  // is held until the test releases it. Like the app, the wiring hands its store to `persistAppQueryClient` (`options.store`);
  // the seam below uses it when there is one and the gated device store otherwise.
  const A_KEY = 'fc:A:query-cache';
  const B_KEY = 'fc:B:query-cache';

  /** What the persister saved for `id`: the ['today'] session id, `at` ms after `base`. */
  function record(id: string, at: number) {
    const timestamp = Date.now() + at;
    return {
      timestamp,
      buster: 'build-test-1',
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: ['today'],
            queryHash: '["today"]',
            state: {
              data: { id },
              dataUpdateCount: 1,
              dataUpdatedAt: timestamp,
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: 'success',
              fetchStatus: 'idle',
            },
          },
        ],
      },
    };
  }

  /** An IndexedDB stand-in: reads of `gated` keys wait for `release`; every write and delete is recorded. */
  function gatedStore(blobs: Record<string, unknown>, gated: string[]) {
    const gates = new Map<string, () => void>();
    const sets: { key: string; value: unknown }[] = [];
    const dels: string[] = [];
    const store: PersistStore = {
      get: <T,>(key: string) => {
        const value = blobs[key] as T | undefined;
        if (!gated.includes(key)) return Promise.resolve(value);
        return new Promise<T | undefined>((resolve) => void gates.set(key, () => resolve(value)));
      },
      set: async (key, value) => void sets.push({ key, value }),
      del: async (key) => void dels.push(key),
    };
    return {
      store,
      sets,
      dels,
      release: async (key: string) => {
        gates.get(key)?.();
        await flush();
      },
    };
  }

  function racing(stored: string | undefined, blobs: Record<string, unknown>, gated: string[]) {
    const h = harness({ stored });
    const g = gatedStore(blobs, gated);
    const queryClient = new QueryClient();
    const teardown = wireAppPlayerSession(queryClient, {
      ...h.deps,
      persistStore: g.store,
      persistAppQueryClient: (options) => persistAppQueryClient({ ...options, store: options.store ?? g.store }),
    });
    const today = () => queryClient.getQueryData<{ id: string }>(['today'])?.id;
    const saved = (key: string) => g.sets.filter((entry) => entry.key === key);
    return { h, g, queryClient, teardown, today, saved };
  }

  test('the normal path: the restore of the remembered player resolves first and hydrates it', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, []);
    await flush();
    expect(r.today()).toBe('session-A');
    r.h.emit('A');
    await flush();
    expect(r.today()).toBe('session-A');
  });

  test('the atom reports ANOTHER player before the remembered one\'s restore resolves: the late restore hydrates nothing', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, [A_KEY]);
    r.h.emit('B');
    await flush();
    await r.g.release(A_KEY);
    expect(r.today()).toBeUndefined();
  });

  test('... and B\'s own persisted record never receives the previous player\'s queries', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, [A_KEY]);
    r.h.emit('B');
    await flush();
    await r.g.release(A_KEY);
    expect(r.saved(B_KEY).filter((entry) => JSON.stringify(entry.value).includes('session-A'))).toEqual([]);
    expect(r.saved(A_KEY)).toEqual([]);
  });

  test('the atom reports NO session (signed out) before the restore resolves: the late restore hydrates nothing and nothing is saved', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, [A_KEY]);
    r.h.emit(undefined);
    await flush();
    await r.g.release(A_KEY);
    expect(r.today()).toBeUndefined();
    expect(r.g.sets).toEqual([]);
  });

  test('the same race for a player that the ATOM reported (nothing was remembered): A then B, A\'s late restore hydrates nothing', async () => {
    const r = racing(undefined, { [A_KEY]: record('session-A', 0) }, [A_KEY]);
    r.h.emit('A');
    r.h.emit('B');
    await flush();
    await r.g.release(A_KEY);
    expect(r.today()).toBeUndefined();
    expect(r.saved(B_KEY).filter((entry) => JSON.stringify(entry.value).includes('session-A'))).toEqual([]);
  });

  test('the new player\'s own restore still hydrates: B\'s session stays when A\'s (newer) late restore resolves afterwards', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 5_000), [B_KEY]: record('session-B', 0) }, [A_KEY]);
    r.h.emit('B');
    await flush();
    expect(r.today()).toBe('session-B');
    await r.g.release(A_KEY);
    expect(r.today()).toBe('session-B');
  });

  test('the teardown before the restore resolves: the late restore hydrates nothing', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, [A_KEY]);
    r.teardown();
    await r.g.release(A_KEY);
    expect(r.today()).toBeUndefined();
    expect(r.g.sets).toEqual([]);
  });

  test('a restore that has resolved before the player changes is not disturbed: a later switch empties the cache as before', async () => {
    const r = racing('A', { [A_KEY]: record('session-A', 0) }, []);
    await flush();
    expect(r.today()).toBe('session-A');
    r.h.emit('B');
    await flush();
    expect(r.today()).toBeUndefined();
  });
});
