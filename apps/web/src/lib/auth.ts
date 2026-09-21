/**
 * The Better Auth client for the web app, plus the silent anonymous sign-in every player gets.
 *
 *   await ensurePlayerSession();   // once, early: resolves the session, creating an anonymous one if there is none
 *   const { data } = useSession(); // React hook (Better Auth's): refreshes by itself after sign-in / sign-out
 *   resetPlayerSession();          // forgets the remembered session (see "The memo does not revalidate")
 *
 * ensurePlayerSession():
 *  1. reads the session (`getSession`). A session with a user object, ANONYMOUS ones included, is the answer: zero sign-ins
 *     (the server refuses a second anonymous sign-in for an anonymous session anyway). `null`/`undefined` data with no error
 *     is "no session". Any other non-null data (an HTML string from a proxy or the SPA fallback, `{}`, `{ user: null }`) is a
 *     READ FAILURE: it rejects and never signs in, because signing in on top of an unreadable session could mint a second
 *     identity.
 *  2. no session: `signIn.anonymous()` once, and that session is the answer.
 *  3. concurrent callers share ONE in-flight promise (one read, one sign-in); a success is remembered.
 *  4. a FAILED attempt is not remembered: every caller of that attempt rejects with the same error and the next call starts
 *     a new attempt. If `getSession` itself fails it does NOT fall through to a sign-in (a flaky network could otherwise
 *     create a duplicate identity for a player who already has a cookie).
 *  5. two tabs on first load: (a) the read + sign-in runs inside `navigator.locks.request('first-coach-player-session', ...)`
 *     when a lock manager exists (option `locks`; `null` disables it), so a second tab waits and then reads the first tab's
 *     cookie; without one it runs directly. (b) on ANY sign-in failure the session is re-read ONCE: if a user is there now
 *     (another tab won, or the server said "already anonymous") that session is the answer; if not, the ORIGINAL sign-in
 *     error is the rejection's cause.
 *
 * ensurePlayerSessionOutcome() (additive, fc-mol-9l4.16) is ensurePlayerSession() plus one fact: `{ session, created }`.
 * `created` is true only when THIS attempt had to sign in anonymously (a brand-new player, who cannot be onboarded yet, so a
 * screen may skip asking the API "are you onboarded?"). It is false for a session that already existed, for one another tab
 * created (the recovered re-read), and for every call made after the attempt has settled: "just created" is a one-shot fact
 * of the call that triggered the creation, never a property of the memoised session (a player who has since onboarded must
 * not be sent back to onboarding). It resolves the very session ensurePlayerSession() does; nothing about that call changed.
 *
 * Every rejection is a `PlayerSessionError`: `kind` is 'offline' when the cause is a network failure (fetch rejects with a
 * TypeError) or `online()` is false (default `navigator.onLine !== false`, read when the failure happens), else 'failed';
 * `cause` is what the client reported (a fresh Error for a malformed payload: the payload itself is never attached, it could
 * hold a token). The message says what failed and nothing else. Nothing is logged.
 *
 * The memo does NOT revalidate. A remembered session stays the answer until `resetPlayerSession()` is called, even if the
 * cookie has expired, been revoked or been replaced. So every 401 / expiry handler, and every direct
 * `authClient.signOut()` or email sign-in, MUST call `resetPlayerSession()` BEFORE calling `ensurePlayerSession()` again;
 * otherwise a stale session is handed back and a 401 loop is possible. After a reset the next call re-reads the session
 * (and signs in anonymously only if there is none).
 *
 * Base URL: the page's own origin (`location.origin`) with Better Auth's default `/api/auth` base path, which is the
 * server's `basePath`. With no usable origin (no `location`, or an opaque one such as "null") no base URL is passed and
 * Better Auth falls back to the relative `/api/auth`, which the browser resolves against the page. Building the client does
 * no network I/O (the session atom fetches only once something subscribes).
 *
 * Tests inject a client, a lock manager and `online` into `createPlayerAuth` and a `fetch` into `createPlayerAuthClient`.
 * This module imports no zod, no sonner and no `@api-types` value.
 */
import { createAuthClient } from 'better-auth/react';
import { adminClient, anonymousClient } from 'better-auth/client/plugins';

export interface PlayerUser {
  id: string;
  isAnonymous?: boolean | null;
}

/** What a session is to this module: it has a user. (The real payloads carry more; it is passed through untouched.) */
export interface PlayerSession {
  user: PlayerUser;
}

/** The reply shape of a Better Auth client call. `data` is unknown on purpose: it is validated here, not trusted. */
type Reply = { data?: unknown; error?: unknown };

/** The part of the Better Auth client that ensurePlayerSession uses; the real client is assignable to it. */
export interface PlayerAuthClient {
  getSession(): Promise<Reply>;
  signIn: { anonymous(): Promise<Reply> };
}

/** What ensurePlayerSessionOutcome resolves: the session, and whether this attempt created it (see the header). */
export interface PlayerSessionOutcome {
  session: PlayerSession;
  created: boolean;
}

/** The part of `navigator.locks` that is used (the real LockManager is assignable to it). */
export interface PlayerLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface PlayerAuthDeps {
  client: PlayerAuthClient;
  /** Default: `navigator.locks`, looked up when an attempt runs. `null`: no lock, run directly. */
  locks?: PlayerLocks | null;
  /** Default: `navigator.onLine !== false`, read when a failure happens. */
  online?: () => boolean;
}

export type PlayerSessionErrorKind = 'offline' | 'failed';

/** What every rejection of ensurePlayerSession is. `cause` is the client's own error. */
export class PlayerSessionError extends Error {
  readonly kind: PlayerSessionErrorKind;

  constructor(message: string, options: { kind: PlayerSessionErrorKind; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'PlayerSessionError';
    this.kind = options.kind;
  }
}

const LOCK_NAME = 'first-coach-player-session';
const READ_FAILED = 'ensurePlayerSession: could not read the current session';
const SIGN_IN_FAILED = 'ensurePlayerSession: anonymous sign-in failed';
const SIGN_IN_NO_USER = 'ensurePlayerSession: anonymous sign-in returned no user';

const failed = (error: unknown): boolean => error !== null && error !== undefined;

const isSession = (data: unknown): data is PlayerSession =>
  typeof data === 'object' && data !== null && typeof (data as { user?: unknown }).user === 'object' && (data as { user?: unknown }).user !== null;

/** A fetch that rejects does so with a TypeError; a name check also covers one from another realm. */
const isNetworkFailure = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'TypeError';

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

export function createPlayerAuth(deps: PlayerAuthDeps) {
  const { client } = deps;
  const online = deps.online ?? browserOnline;
  let attempt: Promise<PlayerSession> | undefined;
  /** True once the current attempt has resolved: later callers get the memo, and nothing was created for them. */
  let attemptSettled = false;
  /** The sessions an anonymous sign-in returned (never one that was only read), so `created` can tell them apart. */
  const signedIn = new WeakSet<PlayerSession>();

  const fail = (message: string, cause?: unknown) =>
    new PlayerSessionError(message, { kind: isNetworkFailure(cause) || !online() ? 'offline' : 'failed', cause });

  /** The current session, or null when there is none. A failed or unintelligible read throws. */
  async function read(): Promise<PlayerSession | null> {
    let reply: Reply;
    try {
      reply = await client.getSession();
    } catch (cause) {
      throw fail(READ_FAILED, cause);
    }
    if (failed(reply.error)) throw fail(READ_FAILED, reply.error);
    if (reply.data === null || reply.data === undefined) return null;
    if (isSession(reply.data)) return reply.data;
    throw fail(READ_FAILED, new Error('the session response has no user'));
  }

  async function signIn(): Promise<PlayerSession> {
    let reply: Reply;
    try {
      reply = await client.signIn.anonymous();
    } catch (cause) {
      throw fail(SIGN_IN_FAILED, cause);
    }
    if (failed(reply.error)) throw fail(SIGN_IN_FAILED, reply.error);
    if (!isSession(reply.data)) throw fail(SIGN_IN_NO_USER);
    signedIn.add(reply.data);
    return reply.data;
  }

  async function readOrSignIn(): Promise<PlayerSession> {
    const existing = await read();
    if (existing) return existing;
    try {
      return await signIn();
    } catch (signInError) {
      // Another tab may have signed in first: look once more before giving up. The sign-in error stays the reported one.
      try {
        const recovered = await read();
        if (recovered) return recovered;
      } catch {
        // an unreadable re-read changes nothing
      }
      throw signInError;
    }
  }

  async function underLock(): Promise<PlayerSession> {
    const locks = deps.locks === undefined ? (globalThis.navigator?.locks ?? null) : deps.locks;
    if (locks === null) return readOrSignIn();
    let granted = false;
    try {
      return await locks.request(LOCK_NAME, () => {
        granted = true;
        return readOrSignIn();
      });
    } catch (error) {
      if (granted) throw error; // the attempt itself failed: it has already run once, never run it twice
      return readOrSignIn(); // the lock manager refused (e.g. an insecure context): no lock, run directly
    }
  }

  function ensurePlayerSession(): Promise<PlayerSession> {
    if (attempt) return attempt;
    attemptSettled = false;
    const started: Promise<PlayerSession> = underLock().then(
      (session) => {
        if (attempt === started) attemptSettled = true;
        return session;
      },
      (error: unknown) => {
        // Only this attempt's own slot: a reset may already have replaced it with a newer attempt.
        if (attempt === started) attempt = undefined;
        throw error;
      },
    );
    attempt = started;
    return started;
  }

  /** ensurePlayerSession() that also says whether this call's attempt created the (anonymous) session. */
  async function ensurePlayerSessionOutcome(): Promise<PlayerSessionOutcome> {
    const joinsAttempt = attempt === undefined || !attemptSettled;
    const session = await ensurePlayerSession();
    return { session, created: joinsAttempt && signedIn.has(session) };
  }

  /** Forgets the remembered session: the next ensurePlayerSession() reads it again. */
  function resetPlayerSession(): void {
    attempt = undefined;
  }

  return { ensurePlayerSession, ensurePlayerSessionOutcome, resetPlayerSession };
}

/** The page origin when it is a usable http(s) one, else undefined (Better Auth then uses the relative `/api/auth`). */
export function authBaseUrl(location?: { origin?: string }): string | undefined {
  const origin = location?.origin;
  return typeof origin === 'string' && /^https?:\/\/[^/]/.test(origin) ? origin : undefined;
}

export interface PlayerAuthClientOptions {
  /** Default: none, i.e. Better Auth's relative `/api/auth`. */
  baseURL?: string;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
}

export function createPlayerAuthClient(options: PlayerAuthClientOptions = {}) {
  return createAuthClient({
    baseURL: options.baseURL,
    basePath: '/api/auth',
    plugins: [anonymousClient(), adminClient()],
    ...(options.fetch ? { fetchOptions: { customFetchImpl: options.fetch } } : {}),
  });
}

/** The app-wide client: same origin, real fetch. */
export const authClient = createPlayerAuthClient({ baseURL: authBaseUrl(globalThis.location) });

export const { ensurePlayerSession, ensurePlayerSessionOutcome, resetPlayerSession } = createPlayerAuth({ client: authClient });

export const useSession = authClient.useSession;
