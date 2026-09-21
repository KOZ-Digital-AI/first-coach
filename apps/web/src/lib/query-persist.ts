/**
 * The React Query cache, persisted in IndexedDB so the app opens with the last known data while offline.
 *
 *   const [unsubscribe, restored] = persistAppQueryClient({ queryClient, playerId });
 *   await restored; // the cache of THIS player is hydrated (or empty); later cache changes are saved
 *
 * - Namespaced by player id: every player has their own record (`fc:<playerId>:query-cache`, the same `fc:<playerId>:`
 *   scheme as offline/types.ts), so on a shared device another player never sees this cache. An empty id throws.
 * - Allow-list only: a successful query is saved only when its key starts with one of PERSISTED_QUERY_PREFIXES (today, me,
 *   journey, onboarding options, commons list, commons detail). Matching is on whole key elements. Loading and failed queries
 *   are never saved. A restore applies the same filter, so an entry an older build saved outside the list is ignored.
 * - Mutations are NEVER saved: react-query would keep paused mutations by default, but the outbox owns offline writes.
 * - The cache is dropped (and removed from storage) when its buster differs from the current build version, or it is older
 *   than PERSIST_MAX_AGE_MS (14 days). The buster is `VITE_BUILD_VERSION`, else `BUILD_VERSION` (the Dockerfile ARG), else "dev".
 *   Vite only exposes VITE_-prefixed variables to the client, so whoever wires the build must pass the version under one of
 *   those names; the fallback "dev" never busts.
 * - Best effort: a storage that cannot be read, written or cleared (private mode, quota) never rejects the restore and never
 *   leaks an unhandled rejection; the app then simply runs without a persisted cache. A corrupt blob is discarded.
 *
 * The storage is the `PersistStore` seam (idb-keyval's get/set/del shape); tests inject an in-memory fake, the app uses the
 * real idb-keyval default. The persisted queries must also outlive the restore in memory: the QueryClient's `gcTime` should be
 * at least PERSIST_MAX_AGE_MS, or a hydrated query is garbage-collected before it is read.
 */
import type { Query, QueryClient } from '@tanstack/react-query';
import { type PersistedClient, persistQueryClient, type Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

/** The part of IndexedDB (idb-keyval) this module needs. */
export interface PersistStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const idbKeyval: PersistStore = { get: (key) => get(key), set, del };

export const PERSIST_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The query keys that may be persisted, as key prefixes. No query exists yet in the app, so this list fixes the key shapes the
 * screens must use: ['today'], ['me'], ['journey'], ['onboarding', 'options', ...], ['commons', 'list', ...] and
 * ['commons', 'detail', ...].
 */
export const PERSISTED_QUERY_PREFIXES: ReadonlyArray<readonly string[]> = [
  ['today'],
  ['me'],
  ['journey'],
  ['onboarding', 'options'],
  ['commons', 'list'],
  ['commons', 'detail'],
];

const isPersistedKey = (queryKey: readonly unknown[]) =>
  PERSISTED_QUERY_PREFIXES.some((prefix) => prefix.every((part, i) => queryKey[i] === part));

/** The IndexedDB key of one player's cache. */
export function queryCacheKey(playerId: string): string {
  if (typeof playerId !== 'string' || playerId.length === 0) throw new TypeError('query-persist: playerId must be a non-empty string');
  return `fc:${playerId}:query-cache`;
}

/** The build version used as the cache buster. `env` defaults to the bundler's `import.meta.env`. */
export function resolveBuildVersion(
  env: Record<string, unknown> = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {},
): string {
  for (const name of ['VITE_BUILD_VERSION', 'BUILD_VERSION']) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'dev';
}

const isPersistedClient = (value: unknown): value is PersistedClient => {
  const client = value as Partial<PersistedClient> | null | undefined;
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof client.timestamp === 'number' &&
    typeof client.buster === 'string' &&
    Array.isArray(client.clientState?.queries) &&
    Array.isArray(client.clientState?.mutations)
  );
};

function createPlayerPersister(playerId: string, store: PersistStore): Persister {
  const key = queryCacheKey(playerId);
  const quietly = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch {
      // Best effort: the cache is an optimisation, never a reason to fail.
    }
  };
  return {
    persistClient: (client) => quietly(() => store.set(key, client)),
    removeClient: () => quietly(() => store.del(key)),
    async restoreClient() {
      let blob: unknown;
      try {
        blob = await store.get<unknown>(key);
      } catch {
        return undefined;
      }
      if (blob === undefined) return undefined;
      if (!isPersistedClient(blob)) {
        await quietly(() => store.del(key));
        return undefined;
      }
      return {
        ...blob,
        clientState: {
          ...blob.clientState,
          queries: blob.clientState.queries.filter((q) => isPersistedKey(q.queryKey)),
          mutations: [],
        },
      };
    },
  };
}

export interface PersistAppQueryClientOptions {
  queryClient: QueryClient;
  playerId: string;
  /** Cache buster. Defaults to `resolveBuildVersion()`. */
  buildVersion?: string;
  /** Defaults to idb-keyval's default IndexedDB store. */
  store?: PersistStore;
}

/** Restores this player's cache into `queryClient`, then saves its changes. Returns `[unsubscribe, restored]`. */
export function persistAppQueryClient({
  queryClient,
  playerId,
  buildVersion = resolveBuildVersion(),
  store = idbKeyval,
}: PersistAppQueryClientOptions): [() => void, Promise<void>] {
  return persistQueryClient({
    queryClient,
    persister: createPlayerPersister(playerId, store),
    buster: buildVersion,
    maxAge: PERSIST_MAX_AGE_MS,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: Query) => query.state.status === 'success' && isPersistedKey(query.queryKey),
      shouldDehydrateMutation: () => false,
    },
  });
}
