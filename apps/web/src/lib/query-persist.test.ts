import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { MutationObserver, onlineManager, QueryClient } from '@tanstack/react-query';
import {
  PERSIST_MAX_AGE_MS,
  PERSISTED_QUERY_PREFIXES,
  type PersistStore,
  persistAppQueryClient,
  queryCacheKey,
  resolveBuildVersion,
} from './query-persist';

// The IndexedDB seam is an in-memory store with the same async shape as idb-keyval's get/set/del. It clones on write and
// read (structuredClone, exactly what IndexedDB does), so a value IndexedDB could not store, or one that leaks a shared
// reference, fails here too. Nothing global is patched except Date.now and the react-query online flag; both are undone
// in afterEach. The QueryClient is the real library's.

type FakeIdb = PersistStore & { data: Map<string, unknown> };

function fakeIdb(): FakeIdb {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      await Promise.resolve();
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async set(key, value) {
      await Promise.resolve();
      data.set(key, structuredClone(value));
    },
    async del(key) {
      await Promise.resolve();
      data.delete(key);
    },
  };
}

type Stored = { timestamp: number; buster: string; clientState: { queries: { queryKey: unknown[] }[]; mutations: unknown[] } };

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const newClient = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => qc.clear());
  return qc;
};

/** Wires a fresh QueryClient to the store and waits until the restore step is done. */
async function attach(store: PersistStore, playerId: string, buildVersion = 'build-1') {
  const queryClient = newClient();
  const [unsubscribe, restored] = persistAppQueryClient({ queryClient, playerId, buildVersion, store });
  cleanups.push(unsubscribe);
  await restored;
  return queryClient;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  if (!cond()) throw new Error('condition not met');
}

const stored = (store: FakeIdb, playerId: string) => store.data.get(queryCacheKey(playerId)) as Stored | undefined;
const storedKeys = (store: FakeIdb, playerId: string) => (stored(store, playerId)?.clientState.queries ?? []).map((q) => q.queryKey);

const ALLOWED: ReadonlyArray<readonly [readonly unknown[], unknown]> = [
  [['today'], { id: 's1' }],
  [['me'], { name: 'Aidar' }],
  [['journey'], { level: 2 }],
  [['onboarding', 'options'], { positions: ['GK'] }],
  [['commons', 'list', { q: 'weak' }], { items: [1, 2] }],
  [['commons', 'detail', 'drill-1'], { title: 'Weak Foot 50' }],
];

describe('persisted query cache: allow-list', () => {
  test('every allow-listed key (today, me, journey, onboarding options, commons list, commons detail) is saved and comes back for the same player', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1');
    for (const [key, data] of ALLOWED) first.setQueryData(key, data);
    await until(() => storedKeys(store, 'p1').length === ALLOWED.length);

    const second = await attach(store, 'p1');
    for (const [key, data] of ALLOWED) expect(second.getQueryData(key)).toEqual(data);
  });

  test('the allow-list is exposed as prefixes covering exactly those six areas', () => {
    expect(PERSISTED_QUERY_PREFIXES).toEqual([
      ['today'],
      ['me'],
      ['journey'],
      ['onboarding', 'options'],
      ['commons', 'list'],
      ['commons', 'detail'],
    ]);
  });

  test('keys outside the allow-list are never saved, even next to allowed ones', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1');
    first.setQueryData(['admin', 'users'], [{ email: 'x@y.z' }]);
    first.setQueryData(['today-extra'], 1); // a prefix must match whole key elements, not string prefixes
    first.setQueryData(['onboarding', 'draft'], { name: 'half typed' });
    first.setQueryData(['commons', 'mine'], []);
    first.setQueryData(['session-events'], []);
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(storedKeys(store, 'p1')).toEqual([['today']]);
    const second = await attach(store, 'p1');
    expect(second.getQueryData(['admin', 'users'])).toBeUndefined();
    expect(second.getQueryData(['onboarding', 'draft'])).toBeUndefined();
    expect(second.getQueryData(['today'])).toEqual({ id: 's1' });
  });

  test('queries that are still loading or failed are not saved, only successful ones', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1');
    void first.prefetchQuery({ queryKey: ['journey'], queryFn: () => new Promise<never>(() => {}) });
    await first.prefetchQuery({
      queryKey: ['me'],
      queryFn: () => Promise.reject(new Error('boom')),
    });
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(storedKeys(store, 'p1')).toEqual([['today']]);
  });

  test('a restore ignores non-allow-listed entries found in the store (older build, tampering)', async () => {
    const store = fakeIdb();
    const writer = await attach(store, 'p1');
    writer.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);
    const blob = stored(store, 'p1') as Stored;
    const template = blob.clientState.queries[0] as { queryKey: unknown[] };
    blob.clientState.queries.push({ ...template, queryKey: ['admin', 'users'] });
    store.data.set(queryCacheKey('p1'), blob);

    const reader = await attach(store, 'p1');
    expect(reader.getQueryData(['today'])).toEqual({ id: 's1' });
    expect(reader.getQueryData(['admin', 'users'])).toBeUndefined();
  });
});

describe('persisted query cache: mutations', () => {
  test('a paused mutation (react-query would persist it by default) is never saved: the outbox owns writes', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1');
    onlineManager.setOnline(false);
    cleanups.push(() => onlineManager.setOnline(true));
    void new MutationObserver(first, { mutationKey: ['session-events'], mutationFn: async () => 'sent' }).mutate({ n: 1 });
    expect(first.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(true);
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(stored(store, 'p1')?.clientState.mutations).toEqual([]);
  });

  test('a paused mutation does not come back after a reload', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1');
    onlineManager.setOnline(false);
    cleanups.push(() => onlineManager.setOnline(true));
    void new MutationObserver(first, { mutationKey: ['session-events'], mutationFn: async () => 'sent' }).mutate({ n: 1 });
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length > 0);

    const second = await attach(store, 'p1');
    expect(second.getMutationCache().getAll()).toEqual([]);
  });
});

describe('persisted query cache: buster and age', () => {
  test('a different build version drops the cache and removes it from storage', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1', 'build-1');
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);
    expect(stored(store, 'p1')?.buster).toBe('build-1');

    const second = await attach(store, 'p1', 'build-2');
    expect(second.getQueryData(['today'])).toBeUndefined();
    expect(store.data.has(queryCacheKey('p1'))).toBe(false);
  });

  test('the same build version keeps the cache', async () => {
    const store = fakeIdb();
    const first = await attach(store, 'p1', 'build-7');
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);

    const second = await attach(store, 'p1', 'build-7');
    expect(second.getQueryData(['today'])).toEqual({ id: 's1' });
  });

  test('without an explicit build version the buster is the resolved BUILD_VERSION', async () => {
    const store = fakeIdb();
    const queryClient = newClient();
    const [unsubscribe, restored] = persistAppQueryClient({ queryClient, playerId: 'p1', store });
    cleanups.push(unsubscribe);
    await restored;
    queryClient.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);

    expect(stored(store, 'p1')?.buster).toBe(resolveBuildVersion());
  });

  test('resolveBuildVersion reads VITE_BUILD_VERSION, then BUILD_VERSION, then falls back to "dev"', () => {
    expect(resolveBuildVersion({ VITE_BUILD_VERSION: 'v-vite', BUILD_VERSION: 'v-docker' })).toBe('v-vite');
    expect(resolveBuildVersion({ BUILD_VERSION: 'v-docker' })).toBe('v-docker');
    expect(resolveBuildVersion({})).toBe('dev');
    expect(resolveBuildVersion({ BUILD_VERSION: '' })).toBe('dev');
  });

  test('a cache is kept for 14 days and dropped after that', async () => {
    expect(PERSIST_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    const T0 = 1_800_000_000_000;
    const now = spyOn(Date, 'now');
    cleanups.push(() => now.mockRestore());
    now.mockReturnValue(T0);

    const store = fakeIdb();
    const first = await attach(store, 'p1');
    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);

    now.mockReturnValue(T0 + PERSIST_MAX_AGE_MS - 1);
    const fresh = await attach(store, 'p1');
    expect(fresh.getQueryData(['today'])).toEqual({ id: 's1' });

    now.mockReturnValue(T0 + PERSIST_MAX_AGE_MS + 1);
    const stale = await attach(store, 'p1');
    expect(stale.getQueryData(['today'])).toBeUndefined();
    expect(store.data.has(queryCacheKey('p1'))).toBe(false);
  });
});

describe('persisted query cache: player namespacing', () => {
  test('a different player id on the same device sees nothing and does not disturb the first player', async () => {
    const store = fakeIdb();
    const a = await attach(store, 'player-a');
    a.setQueryData(['me'], { name: 'Aidar' });
    await until(() => storedKeys(store, 'player-a').length === 1);

    const b = await attach(store, 'player-b');
    expect(b.getQueryData(['me'])).toBeUndefined();
    expect(b.getQueryCache().getAll()).toEqual([]);

    const aAgain = await attach(store, 'player-a');
    expect(aAgain.getQueryData(['me'])).toEqual({ name: 'Aidar' });
  });

  test('each player is saved under a key of their own', async () => {
    const store = fakeIdb();
    const a = await attach(store, 'player-a');
    const b = await attach(store, 'player-b');
    a.setQueryData(['me'], { name: 'Aidar' });
    b.setQueryData(['me'], { name: 'Dana' });
    await until(() => storedKeys(store, 'player-a').length === 1 && storedKeys(store, 'player-b').length === 1);

    expect(queryCacheKey('player-a')).not.toBe(queryCacheKey('player-b'));
    expect(queryCacheKey('player-a')).toContain('player-a');
    const readerB = await attach(store, 'player-b');
    expect(readerB.getQueryData(['me'])).toEqual({ name: 'Dana' });
  });

  test('an empty player id is rejected instead of sharing one anonymous cache', () => {
    expect(() => persistAppQueryClient({ queryClient: newClient(), playerId: '', store: fakeIdb() })).toThrow(TypeError);
    expect(() => queryCacheKey('')).toThrow(TypeError);
  });
});

describe('persisted query cache: unreadable or failing storage', () => {
  test('a corrupt blob is discarded instead of breaking start-up, and caching works afterwards', async () => {
    const store = fakeIdb();
    store.data.set(queryCacheKey('p1'), { garbage: true });
    const first = await attach(store, 'p1');
    expect(first.getQueryCache().getAll()).toEqual([]);
    expect(store.data.has(queryCacheKey('p1'))).toBe(false);

    first.setQueryData(['today'], { id: 's1' });
    await until(() => storedKeys(store, 'p1').length === 1);
  });

  test('a storage that rejects every call (private mode, quota) never rejects the restore or leaks an unhandled rejection', async () => {
    const broken: PersistStore = {
      get: () => Promise.reject(new Error('idb unavailable')),
      set: () => Promise.reject(new Error('quota')),
      del: () => Promise.reject(new Error('idb unavailable')),
    };
    const queryClient = await attach(broken, 'p1');
    queryClient.setQueryData(['today'], { id: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(queryClient.getQueryData(['today'])).toEqual({ id: 's1' });
  });
});
