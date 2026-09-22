/**
 * The ONE route-level guard (auth-gate spec §2): a `beforeLoad` that decides, before a gated route's component ever
 * mounts and before any child loader runs, whether the visitor may see the page.
 *
 *   beforeLoad: requireSession()   // any session, anonymous player included (train, progress, video, settings)
 *   beforeLoad: requireAccount()   // a real, non-anonymous account (contribute, admin)
 *
 * Reading the session (§2.3). The guard reads the Better Auth session atom — the app's one session cache, already
 * subscribed to by `AppShell`'s `useSession()` — and NEVER calls `ensurePlayerSession()` (that creates a session, so
 * a gate built on it would never fire) and never calls `authClient.getSession()` per navigation (a second request,
 * a second cache). "Settled" is `bootstrap.ts`'s rule (`watchAuthSession`): neither `isPending` nor `isRefetching`;
 * an `error` with no data/user is not an answer.
 *
 *   1. settled, has a user            -> allow (0 requests)
 *   2. settled, data null/undefined   -> redirect (0 requests)
 *   3. not settled                    -> subscribe once, await the first settled value, unsubscribe
 *   4. the read FAILED (error, no user) -> offline fallback (below)
 *   5. timeoutMs elapses first         -> treated as 4
 *
 * Offline fallback. A read that failed, or that never settled inside `timeoutMs` (default 3000 ms), is never treated
 * as "no session" on its own: `localStorage['fc:last-player']` (LAST_PLAYER_KEY) says whether this device has a
 * remembered player. Remembered -> allow (the page renders from its cache; a real 401 later is session-expired.ts's
 * job). Nothing remembered -> redirect. Every storage read is inside try/catch: private mode can throw just by being
 * touched, and that is "nothing remembered", not a crash.
 *
 * The redirect (§2.4) is `signInUrl(ctx.location.href)` (validates the return path and encodes it as `?redirect=`),
 * thrown as a TanStack `redirect({ href, replace: true })`. `ctx.location.href` is the router's own parsed location
 * (pathname + search + hash, no origin), which is exactly the return path `signInUrl` expects. `replace: true` keeps
 * the Back button pointing at wherever the visitor came from, not at a redirect loop.
 */
import { redirect } from '@tanstack/react-router';
import { LAST_PLAYER_KEY, type SessionAtomLike, type SessionAtomValue } from '../../bootstrap';
import { authClient } from '../../lib/auth';
import { signInUrl } from './session-expired';

export type GateLevel = 'session' | 'account';

export interface GateDeps {
  /** Default: authClient.$store.atoms.session. `null`: fall back to a memoised getSession(). */
  atom?: SessionAtomLike | null;
  /** Default: localStorage. Read for LAST_PLAYER_KEY when the session read fails (offline). */
  device?: Pick<Storage, 'getItem'> | null;
  /** Default: 3000 ms. The gate never blocks a navigation longer than this. */
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 3000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Pure: what a Better Auth session payload is worth. Exported for the route files and tests. */
export function sessionLevel(data: unknown): 'none' | 'anonymous' | 'account' {
  if (!isRecord(data) || !isRecord(data.user)) return 'none';
  return data.user.isAnonymous === false ? 'account' : 'anonymous';
}

// --- reading the atom, once, per navigation ---------------------------------------------------------------------------

const settled = (value: SessionAtomValue): boolean => value.isPending !== true && value.isRefetching !== true;

/**
 * The atom's first SETTLED value, waiting for it if it is not settled yet, and never longer than `timeoutMs`. A
 * value that never settles in time comes back as a synthetic failed read (an `error`, no `data`), matched by the
 * offline fallback below. Subscribes exactly once and always unsubscribes, whether it resolved from the atom's own
 * value or from the timeout.
 */
function readAtom(atom: SessionAtomLike, timeoutMs: number): Promise<SessionAtomValue> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: SessionAtomValue): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };

    unsubscribe = atom.subscribe((value) => {
      if (settled(value)) finish(value);
    });
    // A nanostores atom calls its listener synchronously, with the CURRENT value, from inside `subscribe` itself: if
    // that value was already settled, `finish` ran above before `unsubscribe` was assigned. Detach it now.
    if (done) {
      unsubscribe();
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ error: new Error('route-guard: timed out waiting for the session') }), timeoutMs);
    }
  });
}

/** `atom: null`: a one-off, memoised `getSession()` read instead of the shared atom (used by nothing in this app yet). */
let sessionMemo: Promise<SessionAtomValue> | undefined;

function readMemoisedSession(): Promise<SessionAtomValue> {
  sessionMemo ??= authClient
    .getSession()
    .then((reply: { data?: unknown; error?: unknown }): SessionAtomValue => ({ data: reply.data, error: reply.error }))
    .catch((error: unknown): SessionAtomValue => ({ error }));
  return sessionMemo;
}

function readSession(deps: GateDeps): Promise<SessionAtomValue> {
  if (deps.atom === null) return readMemoisedSession();
  return readAtom(deps.atom ?? authClient.$store.atoms.session, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

// --- the remembered-player fallback (offline) -------------------------------------------------------------------------

function defaultDevice(): Pick<Storage, 'getItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode: touching the accessor itself can throw
  }
}

/** True when this device remembers a player. A storage that throws, or has nothing, counts as "nothing remembered". */
function remembersPlayer(device: GateDeps['device']): boolean {
  const store = device === undefined ? defaultDevice() : device;
  if (!store) return false;
  try {
    return store.getItem(LAST_PLAYER_KEY) !== null;
  } catch {
    return false;
  }
}

// --- the guard -----------------------------------------------------------------------------------------------------------

interface NavigationContext {
  location: { href: string };
}

function redirectToSignIn(ctx: NavigationContext): never {
  throw redirect({ href: signInUrl(ctx.location.href), replace: true });
}

/** Throws a TanStack `redirect` to the sign-in gate when the level is not met. */
export function requireLevel(level: GateLevel, deps: GateDeps = {}): (ctx: NavigationContext) => Promise<void> {
  return async (ctx) => {
    const value = await readSession(deps);
    const gotLevel = sessionLevel(value.data);

    if (gotLevel !== 'none') {
      // A user is in the answer: settled with a session (case 1), or a stale-but-real user carried alongside an
      // error the read otherwise had. Either way this is an ANSWER, not a failure, so it decides on its own.
      if (level === 'account' && gotLevel !== 'account') redirectToSignIn(ctx);
      return;
    }

    const readFailed = value.error !== null && value.error !== undefined;
    if (readFailed) {
      // Offline (or timed out): never sign a remembered child out because the network is gone.
      if (remembersPlayer(deps.device)) return;
      redirectToSignIn(ctx);
      return;
    }

    // A clean, settled "no session" answer (case 2): nothing to fall back on, nothing to wait for.
    redirectToSignIn(ctx);
  };
}

/** Sugar for route files: `beforeLoad: requireSession()`. */
export const requireSession = (deps?: GateDeps) => requireLevel('session', deps);

/** Sugar for route files: `beforeLoad: requireAccount()`. */
export const requireAccount = (deps?: GateDeps) => requireLevel('account', deps);
