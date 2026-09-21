/**
 * The Better Auth client for the web app, plus the silent anonymous sign-in every player gets.
 *
 *   await ensurePlayerSession();   // once, early: resolves the session, creating an anonymous one if there is none
 *   const { data } = useSession(); // React hook (Better Auth's): refreshes by itself after sign-in / sign-out
 *   resetPlayerSession();          // the sign-out flow calls this so the next ensurePlayerSession() starts over
 *
 * ensurePlayerSession():
 *  1. reads the session (`getSession`). A session with a user, ANONYMOUS ones included, is the answer: zero sign-ins. (The
 *     server refuses a second anonymous sign-in for an anonymous session anyway.)
 *  2. no session: `signIn.anonymous()` exactly once, and that session is the answer.
 *  3. concurrent callers share ONE in-flight promise (one getSession, one sign-in); a success is remembered, so later calls
 *     do not touch the client again.
 *  4. a FAILED attempt is not remembered: every caller of that attempt rejects with the same Error (`cause` = what the
 *     client reported), and the next call starts a new attempt.
 *  5. if `getSession` itself fails (network, 5xx) it does NOT fall through to a sign-in: on a flaky connection that could
 *     mint a second identity for a player who already has a cookie. It rejects with the cause instead.
 *
 * Nothing is logged here (the errors carry the client's own error as `cause`; callers decide what to show).
 *
 * Base URL: the page's own origin (`location.origin`) with Better Auth's default `/api/auth` base path, which is the
 * server's `basePath`. With no usable origin (no `location`, or an opaque one such as "null") no base URL is passed and
 * Better Auth falls back to the relative `/api/auth`, which the browser resolves against the page. Nothing is read at import
 * beyond that: building the client does no network I/O (the session atom fetches only once something subscribes).
 *
 * Tests inject a client into `createPlayerAuth` and a `fetch` into `createPlayerAuthClient`; nothing global is patched. This
 * module imports no zod, no sonner and no `@api-types` value.
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

type Reply = { data: PlayerSession | null; error?: unknown };

/** The part of the Better Auth client that ensurePlayerSession uses; the real client is assignable to it. */
export interface PlayerAuthClient {
  getSession(): Promise<Reply>;
  signIn: { anonymous(): Promise<Reply> };
}

const failed = (error: unknown): boolean => error !== null && error !== undefined;

export function createPlayerAuth({ client }: { client: PlayerAuthClient }) {
  let attempt: Promise<PlayerSession> | undefined;

  async function run(): Promise<PlayerSession> {
    let current: Reply;
    try {
      current = await client.getSession();
    } catch (cause) {
      throw new Error('ensurePlayerSession: could not read the current session', { cause });
    }
    if (failed(current.error)) throw new Error('ensurePlayerSession: could not read the current session', { cause: current.error });
    if (current.data?.user) return current.data;

    let created: Reply;
    try {
      created = await client.signIn.anonymous();
    } catch (cause) {
      throw new Error('ensurePlayerSession: anonymous sign-in failed', { cause });
    }
    if (failed(created.error)) throw new Error('ensurePlayerSession: anonymous sign-in failed', { cause: created.error });
    if (!created.data?.user) throw new Error('ensurePlayerSession: anonymous sign-in returned no user');
    return created.data;
  }

  function ensurePlayerSession(): Promise<PlayerSession> {
    if (attempt) return attempt;
    const started: Promise<PlayerSession> = run().catch((error: unknown) => {
      // Only this attempt's own slot: a reset may already have replaced it with a newer attempt.
      if (attempt === started) attempt = undefined;
      throw error;
    });
    attempt = started;
    return started;
  }

  /** Forgets the remembered session (sign-out): the next ensurePlayerSession() reads it again. */
  function resetPlayerSession(): void {
    attempt = undefined;
  }

  return { ensurePlayerSession, resetPlayerSession };
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

export const { ensurePlayerSession, resetPlayerSession } = createPlayerAuth({ client: authClient });

export const useSession = authClient.useSession;
