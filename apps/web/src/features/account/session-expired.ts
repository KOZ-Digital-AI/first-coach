/**
 * What the web client does when the server says 401 (the session is gone).
 *
 *   installSessionExpired();                                   // once at start-up: registers the onUnauthorized handler
 *   const api = createApi({ fetch: withSessionRetry(fetch) }); // the fetch the app-wide api must use (see below)
 *   registerDraft('contribute-form', () => form.values);       // a form offers its unsent draft; returns an unregister fn
 *   takeDraft('contribute-form');                              // after sign-in the form asks for it back (once, <= 30 min old)
 *   takeExpiredNotice();                                       // the sign-in page: { message } once after an expiry, else null
 *   clearDrafts();                                             // sign-out: no draft may outlive the user who wrote it
 *   resetSessionExpired();                                     // sign-in success: arms the handler again
 *
 * Areas (`areaOf(pathname)`, by FIRST path segment, lower-cased and percent-decoded because TanStack Router matches paths
 * case-insensitively): `admin` and `contribute` are COACH areas; `account` (sign-in itself) is the ACCOUNT area; everything
 * else is a PLAYER route. `/administrators` is not `/admin`: the whole segment must match.
 *
 * - COACH area, a 401 reaches the onUnauthorized handler, which in this order (each step is guarded, so a failing one can
 *   neither hide the next nor keep the coach on the expired page): forgets the remembered player session; saves every
 *   registered draft to sessionStorage (`fc:draft:<key>` = { savedAt, value }; tab-scoped, and a draft older than 30 minutes
 *   is ignored and purged by takeDraft, so it never reaches the next person on a shared device); tells the coach the
 *   session expired; navigates to `/account/sign-in?redirect=<current path+search+hash>`. A return path that is not a plain
 *   same-origin path (starts with one "/", no control characters) is dropped and the redirect goes to plain sign-in. A coach
 *   request is never retried and never signs anyone in anonymously.
 *   "Tells the coach" depends on the navigation. The DEFAULT navigation is a full page load (`location.assign`), which would
 *   destroy an in-page toast, so instead `fc:session-expired-notice` = { savedAt } is written to sessionStorage BEFORE the
 *   page is left and the sign-in page shows it via `takeExpiredNotice()` (once; a notice older than 5 minutes is ignored).
 *   When the app injects its own (client-side) `navigate`, the page survives, so the toast is shown right away and no flag
 *   is written (the sign-in page would otherwise show it twice). The text is "Your session expired — sign in again" (kk/ru/en,
 *   `session-expired.messages.ts`), worded in the language active when it is shown.
 *   ONE expiry, ONE redirect: once a coach area has been handled, later coach-area 401s (any tick) only forget the session
 *   memo; they do not save drafts, notify or navigate again until a fresh page load or `resetSessionExpired()`. The latch is
 *   per installSessionExpired() call. A navigation that throws releases it, so the next 401 tries again.
 * - PLAYER route, `withSessionRetry(fetch)` makes the request once more after silently re-establishing the anonymous
 *   session (resetPlayerSession -> ensurePlayerSession). Concurrent 401s share ONE re-establish; a 401 for a request that
 *   was already in flight when the session was re-established is retried without another one. The retry is the final
 *   answer: a second 401 is returned as is (no loop) and then reaches the handler, which forgets the remembered session so
 *   the next ensurePlayerSession() re-reads it. If the session cannot be re-established the original 401 is returned and
 *   nothing is re-sent. Requests to `/api/auth/*` are never retried (401 there means wrong credentials).
 * - ACCOUNT area: nothing, so the sign-in page can never redirect to itself.
 *
 * READING OF THE CRITERION. An onUnauthorized handler receives only the ApiProblem (no method, path or body), so it cannot
 * re-send a request. The retry therefore lives in a `fetch` decorator that `createApi({ fetch })` already accepts, and the
 * handler is what "registers" for the coach areas. The app-wide `api` in lib/api.ts is `createApi()` with the real fetch:
 * wiring `createApi({ fetch: withSessionRetry(...) })` and calling `installSessionExpired()` at start-up is not in this
 * bead's owned paths. Sign-in and start-up wiring (main.tsx) belong to other beads; so does restoring a draft on the form.
 *
 * KNOWN LIMITS (accepted, not fixed here):
 * - Retry identity downgrade: on a player route the retry re-establishes an ANONYMOUS session. A signed-in coach who happens
 *   to be on a player route when their session ends continues as an anonymous player (their coach session is not revived).
 * - The `/account` exemption is by area, not by request: a 401 while on any `/account/*` page is ignored (no redirect, no
 *   retry), so an account page must handle its own 401s.
 * - The redirect consumer is not here: `/account/sign-in` (bead fc-mol-70i.7) must read the `redirect` search param,
 *   validate it as a same-origin path again, call takeExpiredNotice(), call resetSessionExpired() on success, and forms must
 *   call takeDraft(). Until then a redirect leads to a sign-in page that ignores them.
 */
import type { FetchLike } from '../../lib/api';
import { ensurePlayerSession, resetPlayerSession } from '../../lib/auth';
import { i18n } from '../../lib/i18n';
import { onUnauthorized } from '../../lib/problem';

export type SessionArea = 'coach' | 'player' | 'account';

export const SIGN_IN_PATH = '/account/sign-in';
const DRAFT_PREFIX = 'fc:draft:';
const NOTICE_KEY = 'fc:session-expired-notice';
const MESSAGE_KEY = 'session-expired:message';
const DRAFT_MAX_AGE_MS = 30 * 60_000;
const NOTICE_MAX_AGE_MS = 5 * 60_000;

/** The part of Web Storage that is used. `key`/`length` are only needed to clear every draft. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;

export interface SessionLocation {
  pathname: string;
  search?: string;
  hash?: string;
  /** What the default navigation calls; default: the real `location.assign`. */
  assign?: (url: string) => void;
}

export interface SessionExpiredDeps {
  /** Default: `globalThis.location`. */
  location?: () => SessionLocation;
  /** Default: a full page load (`location.assign`). Injecting one means a client-side navigation: the toast is shown. */
  navigate?: (url: string) => void;
  /** Default: an error toast through sonner (loaded on first use). Used only with an injected `navigate`. */
  notify?: (message: string) => void;
  /** Default: `sessionStorage`, looked up when used. `null`: nothing is saved or read. */
  storage?: DraftStorage | null;
  /** Default: the player session of lib/auth. */
  session?: { ensure(): Promise<unknown>; reset(): void };
  /** Default: `Date.now`. */
  now?: () => number;
}

// --- areas and URLs ------------------------------------------------------------------------------------------------------

export function areaOf(pathname: string): SessionArea {
  const raw = /^\/([^/?#]*)/.exec(pathname)?.[1];
  if (raw === undefined) return 'player';
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    // a malformed escape: the raw text cannot equal a coach segment, so this is a player route
  }
  segment = segment.toLowerCase();
  if (segment === 'admin' || segment === 'contribute') return 'coach';
  if (segment === 'account') return 'account';
  return 'player';
}

// One "/", then not another "/" or "\" (both make a URL protocol-relative); no control characters (URL parsers strip tab/CR/LF).
const isSafeReturnPath = (path: string): boolean => /^\/(?![/\\])/.test(path) && !/[\u0000-\u001f\u007f]/.test(path);

/** The sign-in URL for a return path; an untrustworthy return path is left out. */
export function signInUrl(returnPath: string): string {
  return isSafeReturnPath(returnPath) ? `${SIGN_IN_PATH}?redirect=${encodeURIComponent(returnPath)}` : SIGN_IN_PATH;
}

// --- storage -------------------------------------------------------------------------------------------------------------

function browserStorage(): DraftStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked storage)
  }
}

const storageOf = (deps: { storage?: DraftStorage | null }): DraftStorage | null => (deps.storage === undefined ? browserStorage() : deps.storage);

/** A stored `{ savedAt }` is trusted only when it is a finite time no later than now and no older than `maxAge`. */
function isFresh(savedAt: unknown, now: number, maxAge: number): boolean {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return false;
  const age = now - savedAt;
  return age >= 0 && age <= maxAge;
}

// --- drafts --------------------------------------------------------------------------------------------------------------

const draftSources = new Map<string, () => unknown>();

/** A form offers its unsent draft (any JSON-able value; undefined = nothing to keep). Returns the unregister function. */
export function registerDraft(key: string, read: () => unknown): () => void {
  draftSources.set(key, read);
  return () => {
    if (draftSources.get(key) === read) draftSources.delete(key);
  };
}

/**
 * The draft saved for `key`, once: it is removed as it is read. Undefined when there is none, when it is unreadable or has
 * no sane timestamp, or when it is older than 30 minutes (it is purged either way). It is parsed JSON from storage, so it
 * is `unknown`: the form validates it before use.
 */
export function takeDraft(key: string, storage: DraftStorage | null = browserStorage(), now: () => number = Date.now): unknown {
  if (storage === null) return undefined;
  try {
    const raw = storage.getItem(DRAFT_PREFIX + key);
    if (raw === null) return undefined;
    storage.removeItem(DRAFT_PREFIX + key);
    const stored = JSON.parse(raw) as { savedAt?: unknown; value?: unknown } | null;
    return stored !== null && typeof stored === 'object' && isFresh(stored.savedAt, now(), DRAFT_MAX_AGE_MS) ? stored.value : undefined;
  } catch {
    return undefined;
  }
}

/** Removes every saved draft (sign-out: a draft must never outlive the person who wrote it). Never throws. */
export function clearDrafts(storage: DraftStorage | null = browserStorage()): void {
  if (storage === null) return;
  let keys: string[] = [];
  try {
    if (storage.key === undefined || storage.length === undefined) return;
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name !== null && name.startsWith(DRAFT_PREFIX)) keys.push(name);
    }
  } catch {
    keys = [];
  }
  for (const name of keys) {
    try {
      storage.removeItem(name);
    } catch {
      // keep going: the others still have to go
    }
  }
}

function saveDrafts(storage: DraftStorage | null, now: number): void {
  if (storage === null) return;
  for (const [key, read] of [...draftSources]) {
    try {
      const value = read();
      if (JSON.stringify(value) !== undefined) storage.setItem(DRAFT_PREFIX + key, JSON.stringify({ savedAt: now, value }));
    } catch {
      // one broken form (or a full store) must not cost the others their draft, or keep the coach on the expired page
    }
  }
}

// --- the notice for the sign-in page -------------------------------------------------------------------------------------

/**
 * For the sign-in page: `{ message }` (worded in the active language) once after a session expiry that ended in a full page
 * load, else null. It is consumed as it is read; a notice older than 5 minutes, or a malformed one, is ignored.
 */
export function takeExpiredNotice(deps: Pick<SessionExpiredDeps, 'storage' | 'now'> = {}): { message: string } | null {
  const storage = storageOf(deps);
  if (storage === null) return null;
  try {
    const raw = storage.getItem(NOTICE_KEY);
    if (raw === null) return null;
    storage.removeItem(NOTICE_KEY);
    const stored = JSON.parse(raw) as { savedAt?: unknown } | null;
    if (stored === null || typeof stored !== 'object') return null;
    return isFresh(stored.savedAt, (deps.now ?? Date.now)(), NOTICE_MAX_AGE_MS) ? { message: i18n.t(MESSAGE_KEY) } : null;
  } catch {
    return null;
  }
}

function saveNotice(storage: DraftStorage | null, now: number): void {
  try {
    storage?.setItem(NOTICE_KEY, JSON.stringify({ savedAt: now }));
  } catch {
    // no store, no notice: the redirect matters more
  }
}

// --- dependencies --------------------------------------------------------------------------------------------------------

const currentLocation = (deps: SessionExpiredDeps): SessionLocation | undefined => {
  try {
    return (deps.location ?? (() => globalThis.location))();
  } catch {
    return undefined;
  }
};

const sessionOf = (deps: SessionExpiredDeps) => deps.session ?? { ensure: ensurePlayerSession, reset: resetPlayerSession };

const defaultNotify = (message: string): void => {
  void import('sonner').then(({ toast }) => void toast.error(message)).catch(() => undefined);
};

// --- coach / admin: the onUnauthorized handler ---------------------------------------------------------------------------

const latchResets = new Set<() => void>();

/** Arms every installed handler again (a fresh sign-in): the next coach-area 401 redirects once more. */
export function resetSessionExpired(): void {
  for (const release of [...latchResets]) release();
}

/** Registers the handler for 401s. Returns the unsubscribe function. */
export function installSessionExpired(deps: SessionExpiredDeps = {}): () => void {
  let handled = false; // one expiry, one redirect
  const release = () => {
    handled = false;
  };
  latchResets.add(release);

  const unsubscribe = onUnauthorized(() => {
    try {
      sessionOf(deps).reset(); // never keep a stale session memo, on any 401
    } catch {
      // nothing to do: the redirect below matters more
    }
    const where = currentLocation(deps);
    if (where === undefined || areaOf(where.pathname) !== 'coach' || handled) return;
    handled = true;

    const storage = storageOf(deps);
    const now = (deps.now ?? Date.now)();
    const url = signInUrl(`${where.pathname}${where.search ?? ''}${where.hash ?? ''}`);
    try {
      saveDrafts(storage, now);
      if (deps.navigate === undefined) {
        // A full page load destroys an in-page toast: leave the notice for the sign-in page, BEFORE leaving.
        saveNotice(storage, now);
        if (where.assign) where.assign(url);
        else globalThis.location.assign(url);
      } else {
        try {
          (deps.notify ?? defaultNotify)(i18n.t(MESSAGE_KEY));
        } catch {
          // no toaster is no reason to stay on the expired page
        }
        deps.navigate(url);
      }
    } catch (error) {
      handled = false; // the coach is still on the expired page: the next 401 must try again
      throw error;
    }
  });

  return () => {
    latchResets.delete(release);
    unsubscribe();
  };
}

// --- player routes: re-establish once, retry once ------------------------------------------------------------------------

function retryable(input: string, deps: SessionExpiredDeps): boolean {
  const where = currentLocation(deps);
  if (where === undefined || areaOf(where.pathname) !== 'player') return false;
  try {
    return !/^\/api\/auth(?:\/|$)/.test(new URL(input, 'http://localhost').pathname);
  } catch {
    return false;
  }
}

/** A fetch that, on a player route, answers a 401 by silently re-establishing the anonymous session and sending the same request once more. */
export function withSessionRetry(inner: FetchLike, deps: SessionExpiredDeps = {}): FetchLike {
  let generation = 0; // counts completed re-establishes
  let recovery: Promise<void> | undefined;

  function recover(): Promise<void> {
    recovery ??= (async () => {
      const session = sessionOf(deps);
      session.reset();
      await session.ensure();
      generation += 1;
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  }

  return async (input, init) => {
    const sentAt = generation;
    const response = await inner(input, init);
    if (response.status !== 401 || !retryable(input, deps)) return response;
    // Sent before the last re-establish: its 401 is about the old session, so it goes straight to the retry.
    if (sentAt === generation) {
      try {
        await recover();
      } catch {
        return response; // could not re-establish: the caller sees the original 401, nothing is re-sent
      }
    }
    try {
      await response.body?.cancel();
    } catch {
      // the refused response is being discarded anyway
    }
    return inner(input, init);
  };
}
