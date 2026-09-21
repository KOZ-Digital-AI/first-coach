import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authBaseUrl,
  authClient,
  createPlayerAuth,
  createPlayerAuthClient,
  ensurePlayerSession,
  resetPlayerSession,
  useSession,
  type PlayerAuthClient,
  type PlayerSession,
} from './auth';

// --- global hygiene ----------------------------------------------------------------------------------------------------
// Nothing global is patched for the memo logic: the Better Auth client reaches createPlayerAuth as an injected fake, and the
// real client reaches the network only through createPlayerAuthClient's `fetch` seam. The one global these tests touch is
// console (to prove failures are not logged) and globalThis.fetch inside the import test; both are restored in `restores`.
// Runs from apps/web (preload registers happy-dom) and from the repo root (no DOM): neither needs a document here.

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// --- helpers -----------------------------------------------------------------------------------------------------------

type Reply = { data: PlayerSession | null; error?: unknown };

const player = (id: string, isAnonymous = false): PlayerSession => ({ user: { id, isAnonymous } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-queued microtask (and the promise chains they start) run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fake Better Auth client: counts calls and answers with the script (default: no session, anonymous sign-in works). */
function fake(script: { getSession?: () => Promise<Reply>; anonymous?: () => Promise<Reply> } = {}) {
  const calls = { getSession: 0, anonymous: 0 };
  const client: PlayerAuthClient = {
    getSession: () => {
      calls.getSession += 1;
      return (script.getSession ?? (async () => ({ data: null, error: null })))();
    },
    signIn: {
      anonymous: () => {
        calls.anonymous += 1;
        return (script.anonymous ?? (async () => ({ data: player('anon-1', true), error: null })))();
      },
    },
  };
  return { client, calls };
}

/** What the promise rejects with, so a test can inspect it. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  throw new Error('expected the promise to reject');
}

// --- ensurePlayerSession: the decision ---------------------------------------------------------------------------------

describe('ensurePlayerSession: reads the session first', () => {
  test('an existing session triggers no sign-in and is what resolves', async () => {
    const existing = player('coach-1');
    const { client, calls } = fake({ getSession: async () => ({ data: existing, error: null }) });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(existing);
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });
  });

  test('an ANONYMOUS session is a session: no second anonymous sign-in', async () => {
    const existing = player('anon-9', true);
    const { client, calls } = fake({ getSession: async () => ({ data: existing, error: null }) });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(existing);
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });
  });

  test('no session signs in anonymously exactly once and resolves the new session', async () => {
    const created = player('anon-2', true);
    const { client, calls } = fake({ anonymous: async () => ({ data: created, error: null }) });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(created);
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('a session payload without a user is not a session', async () => {
    const created = player('anon-3', true);
    const { client, calls } = fake({
      getSession: async () => ({ data: { user: null } as unknown as PlayerSession, error: null }),
      anonymous: async () => ({ data: created, error: null }),
    });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(created);
    expect(calls.anonymous).toBe(1);
  });
});

// --- ensurePlayerSession: sharing and caching ---------------------------------------------------------------------------

describe('ensurePlayerSession: one attempt, shared and remembered', () => {
  test('five concurrent callers share one getSession and one sign-in', async () => {
    const read = deferred<Reply>();
    const signIn = deferred<Reply>();
    const { client, calls } = fake({ getSession: () => read.promise, anonymous: () => signIn.promise });
    const auth = createPlayerAuth({ client });

    const pending = Array.from({ length: 5 }, () => auth.ensurePlayerSession());
    await settle();
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });

    read.resolve({ data: null, error: null });
    await settle();
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });

    const created = player('anon-4', true);
    signIn.resolve({ data: created, error: null });
    const sessions = await Promise.all(pending);
    expect(sessions).toHaveLength(5);
    for (const session of sessions) expect(session).toBe(created);
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('concurrent callers with an existing session share one getSession and never sign in', async () => {
    const read = deferred<Reply>();
    const { client, calls } = fake({ getSession: () => read.promise });
    const auth = createPlayerAuth({ client });

    const pending = Array.from({ length: 5 }, () => auth.ensurePlayerSession());
    read.resolve({ data: player('coach-2'), error: null });
    await Promise.all(pending);
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });
  });

  test('after a success later calls reuse the result without touching the client', async () => {
    const { client, calls } = fake();
    const auth = createPlayerAuth({ client });

    const first = await auth.ensurePlayerSession();
    const second = await auth.ensurePlayerSession();
    const third = await auth.ensurePlayerSession();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('two instances keep separate memos', async () => {
    const a = fake();
    const b = fake();
    await createPlayerAuth({ client: a.client }).ensurePlayerSession();
    await createPlayerAuth({ client: b.client }).ensurePlayerSession();
    expect(a.calls.anonymous).toBe(1);
    expect(b.calls.anonymous).toBe(1);
  });
});

// --- ensurePlayerSession: failures do not poison ------------------------------------------------------------------------

describe('ensurePlayerSession: failures', () => {
  test('a failed sign-in rejects every caller of that attempt with the same Error, cause = the client error', async () => {
    const clientError = { status: 500, statusText: 'Internal Server Error', message: 'boom' };
    const signIn = deferred<Reply>();
    const { client, calls } = fake({ anonymous: () => signIn.promise });
    const auth = createPlayerAuth({ client });

    const pending = Array.from({ length: 3 }, () => auth.ensurePlayerSession());
    await settle();
    signIn.resolve({ data: null, error: clientError });
    const settled = await Promise.allSettled(pending);

    const errors = settled.map((result) => {
      expect(result.status).toBe('rejected');
      return (result as PromiseRejectedResult).reason as Error;
    });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toMatch(/anonymous sign-in failed/i);
    expect(errors[0]?.cause).toBe(clientError);
    expect(errors[1]).toBe(errors[0]);
    expect(errors[2]).toBe(errors[0]);
    expect(calls.anonymous).toBe(1);
  });

  test('the next call after a failed sign-in retries with a new sign-in, and that success is then cached', async () => {
    let attempt = 0;
    const created = player('anon-5', true);
    const { client, calls } = fake({
      anonymous: async () => {
        attempt += 1;
        return attempt === 1 ? { data: null, error: { status: 503 } } : { data: created, error: null };
      },
    });
    const auth = createPlayerAuth({ client });

    await failure(auth.ensurePlayerSession());
    expect(calls.anonymous).toBe(1);

    expect(await auth.ensurePlayerSession()).toBe(created);
    expect(calls.anonymous).toBe(2);

    expect(await auth.ensurePlayerSession()).toBe(created);
    expect(calls).toEqual({ getSession: 2, anonymous: 2 });
  });

  test('a sign-in that throws (network) is reported with the thrown value as cause, then retried', async () => {
    const networkError = new TypeError('fetch failed');
    let attempt = 0;
    const { client, calls } = fake({
      anonymous: async () => {
        attempt += 1;
        if (attempt === 1) throw networkError;
        return { data: player('anon-6', true), error: null };
      },
    });
    const auth = createPlayerAuth({ client });

    const error = await failure(auth.ensurePlayerSession());
    expect(error.message).toMatch(/anonymous sign-in failed/i);
    expect(error.cause).toBe(networkError);

    await auth.ensurePlayerSession();
    expect(calls.anonymous).toBe(2);
  });

  test('a sign-in that answers neither data nor error is a failure, not a session', async () => {
    const { client } = fake({ anonymous: async () => ({ data: null, error: null }) });
    const auth = createPlayerAuth({ client });

    const error = await failure(auth.ensurePlayerSession());
    expect(error.message).toMatch(/no user/i);
  });

  test('a getSession ERROR does not sign in blindly: it rejects with the cause and signs in zero times', async () => {
    const clientError = { status: 0, statusText: '', message: 'Failed to fetch' };
    const { client, calls } = fake({ getSession: async () => ({ data: null, error: clientError }) });
    const auth = createPlayerAuth({ client });

    const error = await failure(auth.ensurePlayerSession());
    expect(error.message).toMatch(/read the current session/i);
    expect(error.cause).toBe(clientError);
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });
  });

  test('a getSession that throws does not sign in either, and the next call reads the session again', async () => {
    const networkError = new TypeError('fetch failed');
    let reads = 0;
    const existing = player('coach-3');
    const { client, calls } = fake({
      getSession: async () => {
        reads += 1;
        if (reads === 1) throw networkError;
        return { data: existing, error: null };
      },
    });
    const auth = createPlayerAuth({ client });

    const error = await failure(auth.ensurePlayerSession());
    expect(error.cause).toBe(networkError);
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });

    expect(await auth.ensurePlayerSession()).toBe(existing);
    expect(calls).toEqual({ getSession: 2, anonymous: 0 });
  });

  test('failures are surfaced to the caller only: nothing is logged', async () => {
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((method) => {
      const spy = spyOn(console, method).mockImplementation(() => {});
      restores.push(() => spy.mockRestore());
      return spy;
    });
    const { client } = fake({ anonymous: async () => ({ data: null, error: { message: 'token=secret' } }) });
    const auth = createPlayerAuth({ client });

    const error = await failure(auth.ensurePlayerSession());
    expect(error.message).not.toContain('secret');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// --- resetPlayerSession -------------------------------------------------------------------------------------------------

describe('resetPlayerSession', () => {
  test('clears the remembered session: the next call reads it again (and signs in again after a sign-out)', async () => {
    let signedIn = false;
    const { client, calls } = fake({
      getSession: async () => ({ data: signedIn ? player('anon-7', true) : null, error: null }),
      anonymous: async () => {
        signedIn = true;
        return { data: player('anon-7', true), error: null };
      },
    });
    const auth = createPlayerAuth({ client });

    await auth.ensurePlayerSession();
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });

    signedIn = false; // the sign-out flow: the cookie is gone
    auth.resetPlayerSession();
    await auth.ensurePlayerSession();
    expect(calls).toEqual({ getSession: 2, anonymous: 2 });
  });

  test('a stale failing attempt does not clear the slot of the attempt that replaced it', async () => {
    const firstRead = deferred<Reply>();
    const secondRead = deferred<Reply>();
    const reads = [firstRead, secondRead];
    const { client, calls } = fake({ getSession: () => (reads.shift() as ReturnType<typeof deferred<Reply>>).promise });
    const auth = createPlayerAuth({ client });

    const stale = auth.ensurePlayerSession(); // attempt A
    await settle();
    auth.resetPlayerSession();
    const fresh = auth.ensurePlayerSession(); // attempt B
    await settle();
    expect(calls.getSession).toBe(2);

    firstRead.resolve({ data: null, error: { status: 500 } }); // A fails after B started
    await failure(stale);

    const joiner = auth.ensurePlayerSession(); // must join B, not start attempt C
    await settle();
    expect(calls.getSession).toBe(2);

    secondRead.resolve({ data: player('coach-4'), error: null });
    expect(await joiner).toBe(await fresh);
  });

  test('is safe to call with nothing remembered', () => {
    const { client } = fake();
    const auth = createPlayerAuth({ client });
    expect(() => auth.resetPlayerSession()).not.toThrow();
  });
});

// --- the real client ----------------------------------------------------------------------------------------------------

describe('authBaseUrl: same origin at run time', () => {
  test('is the page origin when there is one', () => {
    expect(authBaseUrl({ origin: 'https://coach.example' })).toBe('https://coach.example');
    expect(authBaseUrl({ origin: 'http://localhost:5173' })).toBe('http://localhost:5173');
  });

  test('is undefined (Better Auth falls back to the relative /api/auth) when there is no usable origin', () => {
    expect(authBaseUrl(undefined)).toBeUndefined();
    expect(authBaseUrl({})).toBeUndefined();
    expect(authBaseUrl({ origin: '' })).toBeUndefined();
    expect(authBaseUrl({ origin: 'null' })).toBeUndefined(); // an opaque origin (sandboxed frame, file:)
    expect(authBaseUrl({ origin: 'file://' })).toBeUndefined();
  });
});

type Seen = { url: string; method: string };

/** A fetch seam for the REAL Better Auth client: records every call, answers per route. */
function wire(answer: (call: Seen) => unknown) {
  const seen: Seen[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const call = {
      url: request ? request.url : String(input),
      method: (request?.method ?? init?.method ?? 'GET').toUpperCase(),
    };
    seen.push(call);
    return new Response(JSON.stringify(answer(call)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

describe('the real Better Auth client behind ensurePlayerSession', () => {
  test('no session: GET /api/auth/get-session on the given origin, then ONE POST /api/auth/sign-in/anonymous', async () => {
    const { fetch: stub, seen } = wire((call) =>
      call.url.endsWith('/get-session') ? null : { token: 't', user: { id: 'anon-8', isAnonymous: true, role: 'contributor' } },
    );
    const auth = createPlayerAuth({ client: createPlayerAuthClient({ baseURL: 'http://app.test', fetch: stub }) });

    const session = await Promise.all([auth.ensurePlayerSession(), auth.ensurePlayerSession()]);
    expect(session[0].user.id).toBe('anon-8');
    expect(session[1]).toBe(session[0]);
    expect(seen).toEqual([
      { url: 'http://app.test/api/auth/get-session', method: 'GET' },
      { url: 'http://app.test/api/auth/sign-in/anonymous', method: 'POST' },
    ]);
  });

  test('an existing anonymous session: only the GET, no sign-in', async () => {
    const { fetch: stub, seen } = wire(() => ({
      session: { id: 's1', userId: 'anon-8' },
      user: { id: 'anon-8', isAnonymous: true, role: 'contributor' },
    }));
    const auth = createPlayerAuth({ client: createPlayerAuthClient({ baseURL: 'http://app.test', fetch: stub }) });

    const session = await auth.ensurePlayerSession();
    expect(session.user.id).toBe('anon-8');
    expect(seen).toEqual([{ url: 'http://app.test/api/auth/get-session', method: 'GET' }]);
  });

  test('has the admin plugin: the client-side role check knows the server roles', () => {
    const client = createPlayerAuthClient({ baseURL: 'http://app.test', fetch: wire(() => null).fetch });
    expect(client.admin.checkRolePermission({ role: 'admin', permissions: { user: ['list'] } })).toBe(true);
  });
});

// --- the module's default instance --------------------------------------------------------------------------------------

describe('the module-level default instance', () => {
  test('exports the client, both session functions and the useSession hook', () => {
    expect(typeof authClient.signIn.anonymous).toBe('function');
    expect(typeof ensurePlayerSession).toBe('function');
    expect(typeof resetPlayerSession).toBe('function');
    expect(useSession).toBe(authClient.useSession);
  });

  test('importing auth.ts does not throw and does no network I/O', async () => {
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched += 1;
      return Promise.reject(new Error('the import must not fetch'));
    }) as unknown as typeof fetch;
    try {
      // A query string makes bun evaluate the module a second time, so its top level really runs under the spy.
      const fresh = (await import(`./auth.ts?fresh=${Math.random()}`)) as typeof import('./auth');
      expect(fresh.authClient).not.toBe(authClient);
      expect(typeof fresh.ensurePlayerSession).toBe('function');
      await settle();
    } finally {
      globalThis.fetch = original;
    }
    expect(fetched).toBe(0);
  });

  test("auth.ts's own source imports no zod and no sonner", () => {
    const source = readFileSync(join(import.meta.dir, 'auth.ts'), 'utf8');
    expect(source).toContain('createPlayerAuth');
    expect(source).not.toMatch(/from\s+['"](zod|sonner)(\/[^'"]*)?['"]/);
  });
});
