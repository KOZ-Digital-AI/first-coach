import { QueryClient } from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';
import { installSessionExpired } from './features/account/session-expired';
import { configureEventsClient, configureEventsPlayer, startEventsSync, TODAY_QUERY_KEY } from './features/train/events-client';
import { authClient } from './lib/auth';
import { PERSIST_MAX_AGE_MS, persistAppQueryClient, resolveBuildVersion } from './lib/query-persist';
import type { PersistAppQueryClientOptions, PersistStore } from './lib/query-persist';
import { getDefaultStore, type KeyValueStore, readOfflineSession } from './offline/types';

/**
 * Creates the app's ONE QueryClient and hands it to the session events client, whose default instance rejects until
 * `configureEventsClient` has been called. main.tsx calls this once, before the first render.
 *
 * `gcTime` is PERSIST_MAX_AGE_MS (14 days): lib/query-persist.ts requires a QueryClient whose queries outlive the restore, or a
 * hydrated query would be garbage-collected (react-query's default is 5 minutes) before a screen reads it.
 */
export function createAppQueryClient(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: PERSIST_MAX_AGE_MS } } });
  configureEventsClient({ queryClient });
  return queryClient;
}

let uninstallSessionExpired: (() => void) | undefined;

/**
 * Installs the app's ONE 401 handler (coach-area redirect to /account/sign-in, see features/account/session-expired.ts) with
 * the given client-side `navigate`, so the page (and its toast) survives instead of a full page load. main.tsx calls this once,
 * before the first render, with a navigate built from its router. Calling it again REPLACES the handler (never two at once).
 * Returns the function that uninstalls it. The player-route retry needs no installing: the app-wide `api` (lib/api.ts) has it.
 */
export function installAppSessionExpired(navigate: (url: string) => void): () => void {
  uninstallSessionExpired?.();
  const uninstall = installSessionExpired({ navigate });
  const mine = () => {
    uninstall();
    if (uninstallSessionExpired === mine) uninstallSessionExpired = undefined;
  };
  uninstallSessionExpired = mine;
  return mine;
}

/** What a Better Auth session atom holds (`authClient.$store.atoms.session`); only the fields that are read. */
export interface SessionAtomValue {
  data?: unknown;
  /** Set when the last read FAILED (the network, or an HTTP error status); `data` then keeps what it had (null on a first read). */
  error?: unknown;
  isPending?: boolean;
  /** Set while the session is being re-read; the PREVIOUS data (possibly the previous person's) is kept meanwhile. */
  isRefetching?: boolean;
}

/** The part of a nanostores atom that `watchAuthSession` uses (Better Auth's session atom is assignable to it). */
export interface SessionAtomLike {
  subscribe(listener: (value: SessionAtomValue) => void): () => void;
}

/**
 * The session-change signal: calls `listener` with the signed-in user's id, or `undefined` for "no session", each time the
 * session atom SETTLES (the atom re-emits on every refetch, so the same id can arrive many times: the wiring dedupes).
 * While it is loading or re-reading (`isPending` / `isRefetching`) nothing is reported: the data then may still be the previous
 * person's. A payload without a string user id counts as no session. Returns the unsubscribe function.
 *
 * A read that FAILED (fc-mol-eay.12: the atom's `error` is set and it holds no session: the device is offline, the server is
 * down) is not an answer, so nothing is reported for it: reporting "no session" would sign the remembered player out of the
 * wiring just because the network is gone. An error that is an ANSWER (HTTP 401: the server says there is no session) still
 * reports "no session".
 */
export function watchAuthSession(atom: SessionAtomLike, listener: (playerId: string | undefined) => void): () => void {
  return atom.subscribe((value) => {
    if (value.isPending === true || value.isRefetching === true) return;
    const id = (value.data as { user?: { id?: unknown } } | null | undefined)?.user?.id;
    if (typeof id === 'string' && id.length > 0) {
      listener(id);
      return;
    }
    if (value.error !== null && value.error !== undefined && (value.error as { status?: unknown }).status !== 401) return;
    listener(undefined);
  });
}

// --- the last player, remembered on the device (fc-mol-eay.12) ---------------------------------------------------------------

/** Where the id of the last player is kept. Not `fc:<playerId>:<name>`: it is the one key that says WHICH player. */
export const LAST_PLAYER_KEY = 'fc:last-player';

/** The id of the last player of this device: what a start-up without a session answer (offline) wires, see `wireAppPlayerSession`. */
export interface LastPlayerStore {
  /** The remembered id, or undefined (nothing remembered, an unusable value, storage that cannot be read). Never throws. */
  read(): string | undefined;
  /** Remembers `playerId`. Best effort: a storage that refuses (quota, private mode) is ignored. */
  write(playerId: string): void;
  /** Forgets it. Best effort. */
  clear(): void;
}

/** An id that can name a storage namespace (offline/types.ts: `fc:<playerId>:<name>`, so no ':'). Anything else is ignored. */
const usableId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes(':');

/**
 * `storage`: the device storage; undefined is the browser's localStorage (looked up on every call: reading it can throw or change),
 * null is a device without one.
 */
export function readLastPlayerId(storage?: KeyValueStore | null): string | undefined {
  try {
    const store = storage === undefined ? getDefaultStore() : (storage ?? undefined);
    const value = store?.getItem(LAST_PLAYER_KEY);
    return usableId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createLastPlayerStore(storage?: KeyValueStore | null): LastPlayerStore {
  const device = (): KeyValueStore | undefined => (storage === undefined ? getDefaultStore() : (storage ?? undefined));
  return {
    read: () => readLastPlayerId(storage),
    write(playerId) {
      try {
        device()?.setItem(LAST_PLAYER_KEY, playerId);
      } catch {
        // best effort
      }
    },
    clear() {
      try {
        device()?.removeItem(LAST_PLAYER_KEY);
      } catch {
        // best effort
      }
    },
  };
}

/**
 * The offline fallback of /train and /train/drill/<itemId> (fc-mol-eay.12): when today's session could not be loaded and the
 * ['today'] query cache holds none (no persisted cache, or one dropped by a new build or its age), the session the LAST player
 * downloaded ("Download today's session", offline/session-store.ts) is put into that cache, stamped with its download time. The
 * screens then read it like any cached session (and the drill player's Done, which patches the cache, works). Returns that
 * timestamp (ms), or undefined when nothing was seeded: the cache already had a session (it is never overwritten), no player is
 * remembered, that player downloaded nothing, or the stored copy is unreadable. The session is whatever the device holds, not
 * necessarily today's, like the persisted cache: the screens say it could not be refreshed. Only the remembered id keys the read,
 * and it never leaves the device.
 */
export function seedTodayFromDevice(queryClient: QueryClient, storage?: KeyValueStore | null): number | undefined {
  try {
    if (queryClient.getQueryData(TODAY_QUERY_KEY) !== undefined) return undefined;
    const store = storage === undefined ? getDefaultStore() : (storage ?? undefined);
    if (store === undefined) return undefined;
    const playerId = readLastPlayerId(store);
    if (playerId === undefined) return undefined;
    const offline = readOfflineSession(store, playerId);
    if (offline === undefined) return undefined;
    const parsed = Date.parse(offline.downloadedAt);
    const updatedAt = Number.isFinite(parsed) ? parsed : Date.now();
    queryClient.setQueryData(TODAY_QUERY_KEY, offline.session, { updatedAt });
    return updatedAt;
  } catch {
    return undefined;
  }
}

/** Everything `wireAppPlayerSession` touches. The defaults are the real modules; tests inject fakes. */
export interface PlayerSessionWiringDeps {
  /**
   * Reports the session's user id once the session is known and after every change (a screen's sign-in, sign-out, expiry), and
   * undefined for "no session"; returns the unsubscribe function. It never signs anybody in: a fresh visitor must stay without a
   * session. The real one is the shared Better Auth session atom, the ONLY session source (see `wireAppPlayerSession`).
   */
  watchSession(listener: (playerId: string | undefined) => void): () => void;
  configureEventsPlayer(playerId: string | undefined): void;
  /** Starts the outbox replay (app start, `online`, visibility) and returns its stop function. */
  startEventsSync(): () => void;
  persistAppQueryClient(options: PersistAppQueryClientOptions): [() => void, Promise<void>];
  /** The persist cache buster (VITE_BUILD_VERSION, see vite.config.ts). */
  resolveBuildVersion(): string;
  /** The last player's id on this device (localStorage `fc:last-player`). */
  lastPlayer: LastPlayerStore;
  /** The device store the persisted cache lives in. Default: idb-keyval's IndexedDB, the one lib/query-persist.ts defaults to. */
  persistStore?: PersistStore;
}

/** The store `persistAppQueryClient` uses when it is given none (lib/query-persist.ts keeps its copy private). */
const deviceStore: PersistStore = { get: (key) => get(key), set, del };

/**
 * `base` for ONE wiring: its reads stop delivering once the wiring is torn down. persistQueryClient's unsubscribe only stops the
 * LATER save subscription; a restore that is already running still hydrates afterwards. So a restore that resolves after the
 * player changed (or signed out, or the app was torn down) would put the previous player's queries into the next player's cache,
 * where the next player's persist subscription would save them into the next player's own record. Such a restore reads
 * `undefined` instead: nothing is hydrated. (A torn-down wiring never saves: its subscription is unsubscribed, and no restore
 * that read `undefined` subscribes.)
 */
function guardedReads(base: PersistStore, alive: () => boolean): PersistStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await base.get<T>(key);
      return alive() ? value : undefined;
    },
    set: (key, value) => base.set(key, value),
    del: (key) => base.del(key),
  };
}

const realDeps = (): PlayerSessionWiringDeps => ({
  watchSession: (listener) => watchAuthSession(authClient.$store.atoms.session, listener),
  configureEventsPlayer,
  startEventsSync: () => startEventsSync(),
  persistAppQueryClient,
  resolveBuildVersion: () => resolveBuildVersion(),
  lastPlayer: createLastPlayerStore(),
});

/**
 * Wires the offline pieces to the player session (fc-mol-eay.9, fixed by fc-mol-eay.10: it never signs anybody in, so a visitor
 * who only opens the landing page or /legal/* gets no session and no cookie; and by fc-mol-eay.11: it makes no session read of
 * its own). Once a session id is reported, for THAT id:
 *  1. `configureEventsPlayer(id)`: from now on `submitEvents` goes through the outbox (offline/outbox.ts);
 *  2. `persistAppQueryClient({ queryClient, playerId: id, buildVersion })`: the query cache is restored from and saved to the
 *     player's own record, busted by the build version;
 *  3. `startEventsSync()`: replays the outbox now, on `online` and on visibility change. Started exactly once per id, so an
 *     offline/online flip never has two listeners; two flushes that still overlap are single-flighted by the outbox itself.
 * The id comes ONLY from the session-change signal: the shared Better Auth session atom. Subscribing to it makes the atom fetch
 * get-session (once) and the app shell's `useSession` reads that same atom, so a page load costs exactly ONE get-session
 * request; a separate session read here would be a second one. The signal is also how a session that a screen creates LATER
 * (train / roadmap / onboarding sign in on their own) reaches the wiring. The SAME id again does nothing. A DIFFERENT id
 * (sign-in as a coach, another player) or no session (sign-out) first tears the previous wiring down (sync stopped, persister unsubscribed, events player back to `undefined`), and empties the in-memory
 * query cache, because the persister would otherwise save the previous player's queries into the next player's record. The
 * FIRST wiring keeps the cache as it is (screens may already have fetched). A restore that is still IN FLIGHT when its wiring is
 * torn down (the atom answers before IndexedDB does) delivers nothing: see `guardedReads`.
 * No session (a fresh visitor) wires nothing. While the atom is still loading, or when its read failed (offline at first load,
 * server down), nothing is reported and nothing is wired or thrown; the player is wired as soon as a session is reported.
 *
 * THE LAST PLAYER (fc-mol-eay.12). A cold start offline gets no session answer at all, so the id-from-the-atom rule alone left
 * the persisted cache unrestored and the outbox unwired: /train showed "Could not load". So the id the atom reports is also
 * REMEMBERED on the device (localStorage `fc:last-player`, `deps.lastPlayer`), and at start-up, before the atom has answered, the
 * remembered id is wired exactly like a reported one (steps 1 to 3). The atom stays the only authority: its answer confirms that id
 * (nothing more happens), replaces it (a different id: the old wiring is torn down, the in-memory cache emptied, the new id wired
 * and remembered) or removes it (settled with no session, i.e. sign-out: torn down and forgotten). A failed read reports nothing
 * (see `watchAuthSession`), so being offline never forgets the player. A fresh visitor (nothing remembered) wires nothing and
 * makes no sign-in or session read: still exactly one get-session per load. The remembered id is used only to key THIS device's
 * own cache, downloaded session and outbox; it is never sent to the server and never decides who the player is.
 *
 * Returns the teardown (stops everything, ignores later signals). main.tsx calls this once, before the first render.
 */
export function wireAppPlayerSession(queryClient: QueryClient, deps: Partial<PlayerSessionWiringDeps> = {}): () => void {
  const d: PlayerSessionWiringDeps = { ...realDeps(), ...deps };
  let current: string | undefined;
  let wiring: { stopSync: () => void; unpersist: () => void; retire: () => void } | undefined;
  let stopped = false;

  /** The last-player store is an optimisation of the offline start: a failure of it never breaks the wiring. */
  function remember(playerId: string | undefined): void {
    try {
      if (playerId === undefined) d.lastPlayer.clear();
      else d.lastPlayer.write(playerId);
    } catch {
      // best effort
    }
  }

  function unwire(): void {
    if (wiring === undefined) return;
    const { stopSync, unpersist, retire } = wiring;
    wiring = undefined;
    retire(); // first: a restore still in flight must not hydrate from here on
    // A stop that throws must not keep the next player from being wired.
    for (const step of [stopSync, unpersist, () => d.configureEventsPlayer(undefined)]) {
      try {
        step();
      } catch {
        // best effort
      }
    }
  }

  /** The three steps for one id. A step that throws leaves nothing half-wired behind, and the error goes on to the caller. */
  function wire(playerId: string): void {
    d.configureEventsPlayer(playerId);
    let live = true;
    const retire = () => void (live = false);
    let unpersist = () => {};
    try {
      const store = guardedReads(d.persistStore ?? deviceStore, () => live);
      const [stop, restored] = d.persistAppQueryClient({ queryClient, playerId, buildVersion: d.resolveBuildVersion(), store });
      unpersist = stop;
      // Best effort: a cache that cannot be restored only means the app runs without it.
      restored.catch(() => {});
      wiring = { unpersist, stopSync: d.startEventsSync(), retire };
    } catch (error) {
      retire();
      for (const step of [unpersist, () => d.configureEventsPlayer(undefined)]) {
        try {
          step();
        } catch {
          // best effort
        }
      }
      throw error;
    }
  }

  function apply(playerId: string | undefined): void {
    if (stopped) return;
    // The atom's answer is the truth about who this device belongs to now: a session id is remembered (again), no session forgets.
    remember(playerId);
    if (playerId === current) return;
    const hadPlayer = current !== undefined;
    current = playerId;
    unwire();
    if (hadPlayer) queryClient.clear();
    if (playerId === undefined) return;
    wire(playerId);
  }

  // Start-up, BEFORE the session atom has answered (offline it never will): the player this device last saw is wired at once, so
  // the persisted cache is restored and the outbox replays for that player. The atom's answer, when it comes, confirms this id
  // (nothing happens), replaces it (`apply`: torn down, cache emptied, the new id wired) or removes it (sign-out). A remembered id
  // that cannot be wired is dropped: it would fail the same way on every start.
  let restoring: string | undefined;
  try {
    restoring = d.lastPlayer.read();
  } catch {
    restoring = undefined;
  }
  if (restoring !== undefined) {
    current = restoring;
    try {
      wire(restoring);
    } catch {
      current = undefined;
      remember(undefined);
    }
  }

  const stopWatching = d.watchSession(apply);

  return () => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    unwire();
  };
}
