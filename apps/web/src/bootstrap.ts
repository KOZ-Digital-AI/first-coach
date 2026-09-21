import { QueryClient } from '@tanstack/react-query';
import { installSessionExpired } from './features/account/session-expired';
import { configureEventsClient, configureEventsPlayer, startEventsSync } from './features/train/events-client';
import { authClient, ensurePlayerSession } from './lib/auth';
import { PERSIST_MAX_AGE_MS, persistAppQueryClient, resolveBuildVersion } from './lib/query-persist';
import type { PersistAppQueryClientOptions } from './lib/query-persist';

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
 */
export function watchAuthSession(atom: SessionAtomLike, listener: (playerId: string | undefined) => void): () => void {
  return atom.subscribe((value) => {
    if (value.isPending === true || value.isRefetching === true) return;
    const id = (value.data as { user?: { id?: unknown } } | null | undefined)?.user?.id;
    listener(typeof id === 'string' && id.length > 0 ? id : undefined);
  });
}

/** Everything `wireAppPlayerSession` touches. The defaults are the real modules; tests inject fakes. */
export interface PlayerSessionWiringDeps {
  /** Reads the session, minting the silent anonymous one if there is none (lib/auth.ts ensurePlayerSession). */
  ensureSession(): Promise<{ user: { id: string } }>;
  /** Reports the session's user id after every change (sign-in, sign-out, expiry); returns the unsubscribe function. */
  watchSession(listener: (playerId: string | undefined) => void): () => void;
  configureEventsPlayer(playerId: string | undefined): void;
  /** Starts the outbox replay (app start, `online`, visibility) and returns its stop function. */
  startEventsSync(): () => void;
  persistAppQueryClient(options: PersistAppQueryClientOptions): [() => void, Promise<void>];
  /** The persist cache buster (VITE_BUILD_VERSION, see vite.config.ts). */
  resolveBuildVersion(): string;
}

const realDeps = (): PlayerSessionWiringDeps => ({
  ensureSession: ensurePlayerSession,
  watchSession: (listener) => watchAuthSession(authClient.$store.atoms.session, listener),
  configureEventsPlayer,
  startEventsSync: () => startEventsSync(),
  persistAppQueryClient,
  resolveBuildVersion: () => resolveBuildVersion(),
});

/**
 * Wires the offline pieces to the player session (fc-mol-eay.9). Once the player's session id is known, for THAT id:
 *  1. `configureEventsPlayer(id)`: from now on `submitEvents` goes through the outbox (offline/outbox.ts);
 *  2. `persistAppQueryClient({ queryClient, playerId: id, buildVersion })`: the query cache is restored from and saved to the
 *     player's own record, busted by the build version;
 *  3. `startEventsSync()`: replays the outbox now, on `online` and on visibility change. Started exactly once per id, so an
 *     offline/online flip never has two listeners; two flushes that still overlap are single-flighted by the outbox itself.
 * The id comes first from `ensureSession()` (the answer that mints the anonymous session) and afterwards from the session-change
 * signal. The SAME id again does nothing. A DIFFERENT id (sign-in as a coach, another player) or no session (sign-out) first tears
 * the previous wiring down (sync stopped, persister unsubscribed, events player back to `undefined`), and empties the in-memory
 * query cache, because the persister would otherwise save the previous player's queries into the next player's record. The
 * FIRST wiring keeps the cache as it is (screens may already have fetched).
 * An `ensureSession` that fails (offline at first load, server down) wires nothing and throws nothing; the signal wires the
 * player as soon as a session is reported. One that resolves after the signal already reported an id is ignored (it is older).
 *
 * Returns the teardown (stops everything, ignores later signals). main.tsx calls this once, before the first render.
 */
export function wireAppPlayerSession(queryClient: QueryClient, deps: Partial<PlayerSessionWiringDeps> = {}): () => void {
  const d: PlayerSessionWiringDeps = { ...realDeps(), ...deps };
  let current: string | undefined;
  let wiring: { stopSync: () => void; unpersist: () => void } | undefined;
  let stopped = false;
  let signalReportedId = false;

  function unwire(): void {
    if (wiring === undefined) return;
    const { stopSync, unpersist } = wiring;
    wiring = undefined;
    // A stop that throws must not keep the next player from being wired.
    for (const step of [stopSync, unpersist, () => d.configureEventsPlayer(undefined)]) {
      try {
        step();
      } catch {
        // best effort
      }
    }
  }

  function apply(playerId: string | undefined): void {
    if (stopped || playerId === current) return;
    const hadPlayer = current !== undefined;
    current = playerId;
    unwire();
    if (hadPlayer) queryClient.clear();
    if (playerId === undefined) return;
    d.configureEventsPlayer(playerId);
    const [unpersist, restored] = d.persistAppQueryClient({ queryClient, playerId, buildVersion: d.resolveBuildVersion() });
    // Best effort: a cache that cannot be restored only means the app runs without it.
    restored.catch(() => {});
    wiring = { unpersist, stopSync: d.startEventsSync() };
  }

  const stopWatching = d.watchSession((playerId) => {
    if (playerId !== undefined) signalReportedId = true;
    apply(playerId);
  });
  d.ensureSession().then(
    (session) => {
      if (!signalReportedId) apply(session.user.id);
    },
    () => {},
  );

  return () => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    unwire();
  };
}
