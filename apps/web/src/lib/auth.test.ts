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
  PlayerSessionError,
  useSession,
  type PlayerAuthClient,
  type PlayerLocks,
  type PlayerSession,
} from './auth';

// --- global hygiene ----------------------------------------------------------------------------------------------------
// Nothing global is patched for the memo logic: the Better Auth client reaches createPlayerAuth as an injected fake, and the
// real client reaches the network only through createPlayerAuthClient's `fetch` seam. The one global these tests touch is
// console (to prove failures are not logged), globalThis.fetch inside the fresh-import tests (Better Auth captures the global
// fetch when a client is built), and navigator.locks in the one test of the default lock manager; each is restored.
// Runs from apps/web (preload registers happy-dom) and from the repo root (no DOM): neither needs a document here.

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// --- helpers -----------------------------------------------------------------------------------------------------------

type Reply = { data?: unknown; error?: unknown };

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

  test('a reply that OMITS the error key is a success, for both the read and the sign-in', async () => {
    const existing = player('coach-5');
    const read = fake({ getSession: async () => ({ data: existing }) });
    expect(await createPlayerAuth({ client: read.client }).ensurePlayerSession()).toBe(existing);
    expect(read.calls).toEqual({ getSession: 1, anonymous: 0 });

    const created = player('anon-3', true);
    const signIn = fake({ getSession: async () => ({}), anonymous: async () => ({ data: created }) });
    expect(await createPlayerAuth({ client: signIn.client }).ensurePlayerSession()).toBe(created);
    expect(signIn.calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('null or undefined data with no error is "no session": it signs in', async () => {
    for (const reply of [{ data: null, error: null }, { data: undefined, error: null }, { data: null }, {}] as Reply[]) {
      const created = player('anon-3', true);
      const { client, calls } = fake({ getSession: async () => reply, anonymous: async () => ({ data: created }) });
      expect(await createPlayerAuth({ client }).ensurePlayerSession()).toBe(created);
      expect(calls.anonymous).toBe(1);
    }
  });

  // A 200 whose body is not a session (the SPA's index.html for a missing route, a proxy page) is a read failure: signing
  // in on top of an unreadable session could mint a second identity.
  const NOT_A_SESSION: Array<[string, unknown]> = [
    ['an HTML string', '<html></html>'],
    ['an empty object', {}],
    ['a null user', { user: null }],
    ['a string user', { user: 'coach' }],
    ['an array', []],
  ];
  for (const [label, data] of NOT_A_SESSION) {
    test(`data that is ${label} is a read failure: it rejects and never signs in`, async () => {
      const { client, calls } = fake({ getSession: async () => ({ data, error: null }) });
      const auth = createPlayerAuth({ client });

      const error = await failure(auth.ensurePlayerSession());
      expect(error).toBeInstanceOf(PlayerSessionError);
      expect(error.message).toMatch(/read the current session/i);
      expect(calls).toEqual({ getSession: 1, anonymous: 0 });
    });
  }

  test('a malformed payload never leaks into the error: the cause is a fresh Error, the message has no payload', async () => {
    const { client } = fake({ getSession: async () => ({ data: { session: { token: 'secret-token' } }, error: null }) });
    const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());

    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).not.toContain('secret-token');
    expect(String((error.cause as Error).message)).not.toContain('secret-token');
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
    // attempt 1: read + sign-in + the one recovery re-read; attempt 2: read + sign-in; the third call is cached.
    expect(calls).toEqual({ getSession: 3, anonymous: 2 });
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

// --- PlayerSessionError ---------------------------------------------------------------------------------------------------

describe('PlayerSessionError: every rejection, with a kind', () => {
  test('is an Error subclass that names what failed and keeps the client error as cause', async () => {
    const clientError = { status: 500, statusText: 'Internal Server Error' };
    const { client } = fake({ getSession: async () => ({ data: null, error: clientError }) });

    const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());
    expect(error).toBeInstanceOf(PlayerSessionError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PlayerSessionError');
    expect(error.message).toMatch(/read the current session/i);
    expect(error.cause).toBe(clientError);
    expect((error as PlayerSessionError).kind).toBe('failed');
  });

  test('a sign-in failure is one too: kind "failed", cause = the sign-in error', async () => {
    const clientError = { status: 500, statusText: 'Internal Server Error' };
    const { client } = fake({ anonymous: async () => ({ data: null, error: clientError }) });

    const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());
    expect(error).toBeInstanceOf(PlayerSessionError);
    expect(error.message).toMatch(/anonymous sign-in failed/i);
    expect(error.cause).toBe(clientError);
    expect((error as PlayerSessionError).kind).toBe('failed');
  });

  test('a fetch TypeError while reading the session is kind "offline", cause preserved', async () => {
    const networkError = new TypeError('Failed to fetch');
    const { client } = fake({ getSession: async () => Promise.reject(networkError) });

    const error = (await failure(createPlayerAuth({ client }).ensurePlayerSession())) as PlayerSessionError;
    expect(error).toBeInstanceOf(PlayerSessionError);
    expect(error.kind).toBe('offline');
    expect(error.cause).toBe(networkError);
  });

  test('a fetch TypeError while signing in is kind "offline", cause preserved', async () => {
    const networkError = new TypeError('Failed to fetch');
    const { client } = fake({ anonymous: async () => Promise.reject(networkError) });

    const error = (await failure(createPlayerAuth({ client }).ensurePlayerSession())) as PlayerSessionError;
    expect(error.kind).toBe('offline');
    expect(error.message).toMatch(/anonymous sign-in failed/i);
    expect(error.cause).toBe(networkError);
  });

  test('when the browser reports offline, any failure is kind "offline"; when online, only a network cause is', async () => {
    const clientError = { status: 500, statusText: 'Internal Server Error' };
    const read = fake({ getSession: async () => ({ data: null, error: clientError }) });
    const signIn = fake({ anonymous: async () => ({ data: null, error: clientError }) });
    const malformed = fake({ getSession: async () => ({ data: '<html></html>' }) });

    for (const { client } of [read, signIn, malformed]) {
      const offline = (await failure(createPlayerAuth({ client, online: () => false }).ensurePlayerSession())) as PlayerSessionError;
      expect(offline.kind).toBe('offline');
      const online = (await failure(createPlayerAuth({ client, online: () => true }).ensurePlayerSession())) as PlayerSessionError;
      expect(online.kind).toBe('failed');
    }
  });

  test('the offline check is read at failure time, not frozen when the factory is created', async () => {
    let online = true;
    const { client } = fake({ getSession: async () => ({ data: null, error: { status: 500 } }) });
    const auth = createPlayerAuth({ client, online: () => online });

    expect(((await failure(auth.ensurePlayerSession())) as PlayerSessionError).kind).toBe('failed');
    online = false;
    expect(((await failure(auth.ensurePlayerSession())) as PlayerSessionError).kind).toBe('offline');
  });

  test('a sign-in that yields no user is a PlayerSessionError too', async () => {
    const { client } = fake({ anonymous: async () => ({ data: {}, error: null }) });
    const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());
    expect(error).toBeInstanceOf(PlayerSessionError);
    expect(error.message).toMatch(/no user/i);
  });
});

// --- two tabs on first load ---------------------------------------------------------------------------------------------

const ALREADY_ANONYMOUS = { status: 400, statusText: 'Bad Request', code: 'ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY' };

/** A fake lock manager: one queue per name, like navigator.locks; records the names asked for. */
function fakeLocks(): PlayerLocks & { names: string[] } {
  const names: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  return {
    names,
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

/** One browser: a single cookie jar shared by its tabs, and a server that refuses a second anonymous sign-in. */
function browser() {
  let cookie: PlayerSession | null = null;
  let minted = 0;
  const tab = () => {
    const calls = { getSession: 0, anonymous: 0 };
    const client: PlayerAuthClient = {
      getSession: async () => {
        calls.getSession += 1;
        await settle();
        return { data: cookie, error: null };
      },
      signIn: {
        anonymous: async () => {
          calls.anonymous += 1;
          await settle();
          if (cookie) return { data: null, error: ALREADY_ANONYMOUS };
          minted += 1;
          cookie = player(`anon-tab-${minted}`, true);
          return { data: cookie, error: null };
        },
      },
    };
    return { client, calls };
  };
  return { tab, minted: () => minted };
}

describe('two tabs racing on first load', () => {
  test('a sign-in that fails while the re-read then finds a user resolves with that user: 2 reads, 1 sign-in', async () => {
    const other = player('anon-other-tab', true);
    let reads = 0;
    const { client, calls } = fake({
      getSession: async () => ({ data: (reads += 1) === 1 ? null : other, error: null }),
      anonymous: async () => ({ data: null, error: ALREADY_ANONYMOUS }),
    });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(other);
    expect(calls).toEqual({ getSession: 2, anonymous: 1 });

    expect(await auth.ensurePlayerSession()).toBe(other); // and the recovered session is remembered
    expect(calls).toEqual({ getSession: 2, anonymous: 1 });
  });

  test('the recovery covers every kind of sign-in failure: an error result, a throw and a reply without a user', async () => {
    const other = player('anon-other-tab', true);
    for (const anonymous of [
      async (): Promise<Reply> => ({ data: null, error: ALREADY_ANONYMOUS }),
      async (): Promise<Reply> => Promise.reject(new TypeError('Failed to fetch')),
      async (): Promise<Reply> => ({ data: null, error: null }),
      async (): Promise<Reply> => ({ data: {}, error: null }),
    ]) {
      let reads = 0;
      const { client, calls } = fake({ getSession: async () => ({ data: (reads += 1) === 1 ? null : other }), anonymous });
      expect(await createPlayerAuth({ client }).ensurePlayerSession()).toBe(other);
      expect(calls).toEqual({ getSession: 2, anonymous: 1 });
    }
  });

  test('when the re-read finds no user either, it rejects with the ORIGINAL sign-in error as cause, after exactly 2 reads', async () => {
    const { client, calls } = fake({ anonymous: async () => ({ data: null, error: ALREADY_ANONYMOUS }) });

    const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());
    expect(error).toBeInstanceOf(PlayerSessionError);
    expect(error.message).toMatch(/anonymous sign-in failed/i);
    expect(error.cause).toBe(ALREADY_ANONYMOUS);
    expect(calls).toEqual({ getSession: 2, anonymous: 1 });
  });

  test('when the re-read itself fails (error, throw or malformed), the original sign-in error is still the cause', async () => {
    for (const reread of [
      async (): Promise<Reply> => ({ data: null, error: { status: 500, message: 'read failed' } }),
      async (): Promise<Reply> => Promise.reject(new TypeError('Failed to fetch')),
      async (): Promise<Reply> => ({ data: '<html></html>' }),
    ]) {
      let reads = 0;
      const { client, calls } = fake({
        getSession: async () => (reads++ === 0 ? { data: null, error: null } : reread()),
        anonymous: async () => ({ data: null, error: ALREADY_ANONYMOUS }),
      });
      const error = await failure(createPlayerAuth({ client }).ensurePlayerSession());
      expect(error.message).toMatch(/anonymous sign-in failed/i);
      expect(error.cause).toBe(ALREADY_ANONYMOUS);
      expect(calls).toEqual({ getSession: 2, anonymous: 1 });
    }
  });

  test('a failed READ is never re-read: only a failed sign-in is', async () => {
    const { client, calls } = fake({ getSession: async () => ({ data: null, error: { status: 500 } }) });
    await failure(createPlayerAuth({ client }).ensurePlayerSession());
    expect(calls).toEqual({ getSession: 1, anonymous: 0 });
  });

  test('without locks, two tabs both sign in and the loser recovers through the re-read', async () => {
    const jar = browser();
    const a = jar.tab();
    const b = jar.tab();

    const [first, second] = await Promise.all([
      createPlayerAuth({ client: a.client, locks: null }).ensurePlayerSession(),
      createPlayerAuth({ client: b.client, locks: null }).ensurePlayerSession(),
    ]);
    expect(first.user.id).toBe('anon-tab-1');
    expect(second.user.id).toBe('anon-tab-1');
    expect(a.calls.anonymous + b.calls.anonymous).toBe(2);
    expect(jar.minted()).toBe(1);
  });

  test('with a shared lock the second tab waits, then finds the first tab\'s session and signs in ZERO times', async () => {
    const jar = browser();
    const locks = fakeLocks();
    const a = jar.tab();
    const b = jar.tab();

    const [first, second] = await Promise.all([
      createPlayerAuth({ client: a.client, locks }).ensurePlayerSession(),
      createPlayerAuth({ client: b.client, locks }).ensurePlayerSession(),
    ]);
    expect(first.user.id).toBe('anon-tab-1');
    expect(second.user.id).toBe('anon-tab-1');
    expect(a.calls).toEqual({ getSession: 1, anonymous: 1 });
    expect(b.calls).toEqual({ getSession: 1, anonymous: 0 });
    expect(locks.names).toEqual(['first-coach-player-session', 'first-coach-player-session']);
  });

  test('the whole attempt, read and sign-in, runs inside the lock (and once: a failure is not re-run by the lock wrapper)', async () => {
    const events: string[] = [];
    const locks: PlayerLocks = {
      async request(_name, callback) {
        events.push('acquire');
        try {
          return await callback();
        } finally {
          events.push('release');
        }
      },
    };
    const { client, calls } = fake({
      getSession: async () => {
        events.push('read');
        return { data: null, error: null };
      },
      anonymous: async () => {
        events.push('sign-in');
        return { data: null, error: { status: 500 } };
      },
    });

    await failure(createPlayerAuth({ client, locks }).ensurePlayerSession());
    expect(events).toEqual(['acquire', 'read', 'sign-in', 'read', 'release']);
    expect(calls).toEqual({ getSession: 2, anonymous: 1 });
  });

  test('a lock manager that refuses to grant (e.g. an insecure context) falls back to running directly', async () => {
    const denied: PlayerLocks = { request: () => Promise.reject(new DOMException('no locks here', 'SecurityError')) };
    const { client, calls } = fake();

    const session = await createPlayerAuth({ client, locks: denied }).ensurePlayerSession();
    expect(session.user.id).toBe('anon-1');
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('no lock manager at all (null) still works', async () => {
    const { client, calls } = fake();
    const auth = createPlayerAuth({ client, locks: null });
    expect((await auth.ensurePlayerSession()).user.id).toBe('anon-1');
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('the default lock manager is navigator.locks, looked up when the attempt runs', async () => {
    const locks = fakeLocks();
    const own = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true, writable: true });
    restores.push(() => {
      if (own) Object.defineProperty(globalThis.navigator, 'locks', own);
      else delete (globalThis.navigator as { locks?: unknown }).locks;
    });
    const { client } = fake();

    await createPlayerAuth({ client }).ensurePlayerSession();
    expect(locks.names).toEqual(['first-coach-player-session']);
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

  test('after a reset a session change is picked up: the new ensure re-reads and resolves the NEW user, not the stale one', async () => {
    let current = player('coach-old');
    const { client, calls } = fake({ getSession: async () => ({ data: current, error: null }) });
    const auth = createPlayerAuth({ client });

    expect(await auth.ensurePlayerSession()).toBe(current);
    const stale = current;
    current = player('coach-new'); // signed out and in as someone else through authClient directly
    expect(await auth.ensurePlayerSession()).toBe(stale); // the memo never revalidates on its own

    auth.resetPlayerSession();
    expect((await auth.ensurePlayerSession()).user.id).toBe('coach-new');
    expect(calls).toEqual({ getSession: 2, anonymous: 0 });
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
    expect(authBaseUrl({ origin: 'http://' })).toBeUndefined(); // a scheme with no host
    expect(authBaseUrl({ origin: 'https://' })).toBeUndefined();
    expect(authBaseUrl({ origin: 'http:///' })).toBeUndefined();
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

  // useSession's atom refetches on `$sessionSignal`, which Better Auth flips (after 10 ms) when a sign-in succeeds. Driving the
  // atom's own fetch needs a window (Better Auth skips it on a server), so this asserts the signal instead: the observable
  // that makes useSession() pick the new player up.
  test('an anonymous sign-in flips the $sessionSignal that useSession listens to; a plain read does not', async () => {
    const signedIn = wire((call) => (call.url.endsWith('/get-session') ? null : { token: 't', user: { id: 'anon-9', isAnonymous: true } }));
    const client = createPlayerAuthClient({ baseURL: 'http://app.test', fetch: signedIn.fetch });
    let flips = 0;
    client.$store.listen('$sessionSignal', () => (flips += 1));
    const baseline = flips; // subscribing reports the current value once

    await createPlayerAuth({ client }).ensurePlayerSession();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(flips).toBeGreaterThan(baseline);

    const existing = wire(() => ({ session: { id: 's1' }, user: { id: 'anon-9', isAnonymous: true } }));
    const quiet = createPlayerAuthClient({ baseURL: 'http://app.test', fetch: existing.fetch });
    let quietFlips = 0;
    quiet.$store.listen('$sessionSignal', () => (quietFlips += 1));
    const quietBaseline = quietFlips;
    await createPlayerAuth({ client: quiet }).ensurePlayerSession();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(quietFlips).toBe(quietBaseline);
  });

  test('a network failure and an HTML 200 through the real client are PlayerSessionErrors: offline, and a read failure', async () => {
    const down = createPlayerAuthClient({
      baseURL: 'http://app.test',
      fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });
    const offline = (await failure(createPlayerAuth({ client: down }).ensurePlayerSession())) as PlayerSessionError;
    expect(offline.kind).toBe('offline');

    const html = createPlayerAuthClient({
      baseURL: 'http://app.test',
      fetch: (async () => new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
    });
    const signIns: string[] = [];
    const spy = createPlayerAuth({
      client: {
        getSession: () => html.getSession(),
        signIn: {
          anonymous: () => {
            signIns.push('sign-in');
            return html.signIn.anonymous();
          },
        },
      },
    });
    const malformed = (await failure(spy.ensurePlayerSession())) as PlayerSessionError;
    expect(malformed.message).toMatch(/read the current session/i);
    expect(signIns).toEqual([]);
  });

  test('has the admin plugin: its client-side role check answers without a network call', () => {
    const { fetch: stub, seen } = wire(() => null);
    const client = createPlayerAuthClient({ baseURL: 'http://app.test', fetch: stub });
    expect(client.admin.checkRolePermission({ role: 'admin', permissions: { user: ['list'] } })).toBe(true);
    expect(seen).toEqual([]);
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

  test('the module-level ensurePlayerSession drives the EXPORTED authClient, not another instance', async () => {
    const { fetch: stub, seen } = wire((call) =>
      call.url.endsWith('/get-session') ? null : { token: 't', user: { id: 'anon-10', isAnonymous: true } },
    );
    const original = globalThis.fetch;
    globalThis.fetch = stub; // Better Auth captures the global fetch when the client is built, i.e. at this fresh import
    let flips = 0;
    let baseline = 0;
    let session: PlayerSession;
    try {
      const fresh = (await import(`./auth.ts?fresh=${Math.random()}`)) as typeof import('./auth');
      globalThis.fetch = original;
      fresh.authClient.$store.listen('$sessionSignal', () => (flips += 1));
      baseline = flips;
      session = await fresh.ensurePlayerSession();
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      globalThis.fetch = original;
    }
    expect(session.user.id).toBe('anon-10');
    expect(seen.map((call) => `${call.method} ${call.url.replace(/^https?:\/\/[^/]+/, '')}`)).toEqual([
      'GET /api/auth/get-session',
      'POST /api/auth/sign-in/anonymous',
    ]);
    expect(flips).toBeGreaterThan(baseline); // the sign-in went through the client whose store this test listens to
  });

  test("auth.ts's own source imports no zod and no sonner", () => {
    const source = readFileSync(join(import.meta.dir, 'auth.ts'), 'utf8');
    expect(source).toContain('createPlayerAuth');
    expect(source).not.toMatch(/from\s+['"](zod|sonner)(\/[^'"]*)?['"]/);
  });
});
