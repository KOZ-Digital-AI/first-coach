import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createApi } from '../../lib/api';
import { ApiProblem } from '../../lib/problem';
import { i18n } from '../../lib/i18n';
import sessionMessages from './session-expired.messages';
import { areaOf, installSessionExpired, registerDraft, signInUrl, takeDraft, withSessionRetry, type SessionExpiredDeps } from './session-expired';

// --- global hygiene ----------------------------------------------------------------------------------------------------
// Nothing global is patched: location, navigation, toast, storage, the auth session and fetch are all injected. The globals
// these tests touch are the i18n singleton (a `session-expired` bundle it does not have under bun, because import.meta.glob
// is undefined there, and its language), the onUnauthorized registry and the draft registry; each is undone in afterEach.
// Runs from apps/web (preload registers happy-dom) and from the repo root (no DOM): neither needs a document here.

const EXPIRED_EN = 'Your session expired — sign in again';
const INITIAL_LANGUAGE = i18n.language;
const NAMESPACE = 'session-expired';
const LOCALES = ['kk', 'ru', 'en'] as const;

const cleanups: Array<() => void> = [];

beforeAll(async () => {
  for (const locale of LOCALES) {
    if (!i18n.hasResourceBundle(locale, NAMESPACE)) i18n.addResourceBundle(locale, NAMESPACE, sessionMessages[locale], true, true);
  }
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  for (const locale of LOCALES) i18n.removeResourceBundle(locale, NAMESPACE);
  await i18n.changeLanguage(INITIAL_LANGUAGE);
});

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await i18n.changeLanguage('en');
  // Lets the coalescing microtask of any notifyUnauthorized burst run before the next test starts.
  await Promise.resolve();
});

// --- helpers -----------------------------------------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

type Where = { pathname: string; search?: string; hash?: string };

/** Everything the module talks to, faked, with one ordered log of the side effects. */
function rig(where: Where, overrides: Partial<SessionExpiredDeps> = {}) {
  const log: string[] = [];
  const storage = memoryStorage();
  const navigations: string[] = [];
  const toasts: string[] = [];
  /** What the draft storage held at the moment of each navigation. */
  const storageAtNavigate: Array<Map<string, string>> = [];
  const session = {
    resets: 0,
    ensures: 0,
    ensure: async (): Promise<unknown> => {
      session.ensures += 1;
      log.push('ensure');
      return { user: { id: 'anon', isAnonymous: true } };
    },
    reset: () => {
      session.resets += 1;
      log.push('reset');
    },
  };
  const deps: SessionExpiredDeps = {
    location: () => ({ pathname: where.pathname, search: where.search ?? '', hash: where.hash ?? '' }),
    navigate: (url) => {
      log.push('navigate');
      navigations.push(url);
      storageAtNavigate.push(new Map(storage.data));
    },
    notify: (message) => {
      log.push('notify');
      toasts.push(message);
    },
    storage,
    session: { ensure: session.ensure, reset: session.reset },
    ...overrides,
  };
  return { deps, log, storage, navigations, toasts, storageAtNavigate, session };
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const anySchema = { safeParse: (data: unknown) => ({ success: true as const, data }) };

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** A fake server: answers call number n (1-based) with `answer(n)`. */
function fakeFetch(answer: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method, body: init?.body });
    return answer(calls.length);
  };
  return { fetch, calls };
}

/** The real api wrapper over a fake fetch, going through the retry decorator. */
function apiOver(fetch: (input: string, init?: RequestInit) => Promise<Response>, deps: SessionExpiredDeps) {
  return createApi({ fetch: withSessionRetry(fetch, deps), online: () => true, language: () => 'en' });
}

function install(deps: SessionExpiredDeps) {
  cleanups.push(installSessionExpired(deps));
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

// --- areas and URLs ----------------------------------------------------------------------------------------------------

describe('areaOf', () => {
  test.each(['/admin', '/admin/settings', '/admin/drills/x', '/contribute', '/contribute/mine', '/contribute/edit/abc'])(
    '%s is a coach/admin area',
    (path) => expect(areaOf(path)).toBe('coach'),
  );

  test.each(['/', '/today', '/train/abc', '/skills', '/administrators', '/adminx/y', '/contributed', '/contribute-x'])(
    '%s is a player route',
    (path) => expect(areaOf(path)).toBe('player'),
  );

  test.each(['/account/sign-in', '/account', '/account/anything'])('%s is the account area, which is neither', (path) => {
    expect(areaOf(path)).toBe('account');
  });
});

describe('signInUrl', () => {
  test('carries the return path, URL-encoded, in the redirect search param', () => {
    expect(signInUrl('/contribute/form?draft=1#top')).toBe('/account/sign-in?redirect=%2Fcontribute%2Fform%3Fdraft%3D1%23top');
  });

  test.each(['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'contribute', '/a\tb', '/a\nb', ''])(
    'never carries the unsafe return path %j',
    (path) => {
      expect(signInUrl(path)).toBe('/account/sign-in');
    },
  );
});

// --- coach / admin: message, draft, redirect ---------------------------------------------------------------------------

describe('coach and admin areas: a 401 shows the expiry message and redirects to sign-in with the return path', () => {
  test('coach path: redirects with the return URL, shows the message, and still throws the 401', async () => {
    const r = rig({ pathname: '/contribute/form', search: '?from=mine', hash: '#step-2' });
    install(r.deps);
    const api = apiOver(fakeFetch(() => json(401, { title: 'Unauthorized', status: 401 })).fetch, r.deps);

    const error = await rejection(api.get('/api/contributions/mine', { schema: anySchema }));

    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).status).toBe(401);
    expect(r.navigations).toEqual(['/account/sign-in?redirect=%2Fcontribute%2Fform%3Ffrom%3Dmine%23step-2']);
    expect(r.toasts).toEqual([EXPIRED_EN]);
  });

  test('admin path: same redirect and message', async () => {
    const r = rig({ pathname: '/admin/settings' });
    install(r.deps);
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/admin/settings', { schema: anySchema }));

    expect(r.navigations).toEqual(['/account/sign-in?redirect=%2Fadmin%2Fsettings']);
    expect(r.toasts).toEqual([EXPIRED_EN]);
  });

  test('a coach request is never retried and never signs anyone in anonymously', async () => {
    const r = rig({ pathname: '/admin/drills' });
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    await rejection(api.get('/api/admin/drills', { schema: anySchema }));

    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(0);
  });

  test('the remembered session is forgotten before leaving, so nothing stale survives the redirect', async () => {
    const r = rig({ pathname: '/contribute/mine' });
    install(r.deps);
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/contributions/mine', { schema: anySchema }));

    expect(r.session.resets).toBeGreaterThanOrEqual(1);
    expect(r.log.indexOf('reset')).toBeLessThan(r.log.indexOf('navigate'));
  });

  test('unsent drafts are saved before the redirect and can be taken back once', async () => {
    const r = rig({ pathname: '/contribute/form' });
    install(r.deps);
    const draft = { title: 'Pass and move', steps: ['a', 'b'], reps: 12 };
    cleanups.push(registerDraft('contribute-form', () => draft));
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.post('/api/contributions', { body: { title: 'x' }, schema: anySchema }));

    // Already in storage when navigate ran: a hard navigation would have thrown the in-memory form away.
    expect(r.storageAtNavigate).toHaveLength(1);
    expect([...(r.storageAtNavigate[0] ?? new Map()).values()].map((raw) => JSON.parse(raw))).toEqual([draft]);
    expect(takeDraft('contribute-form', r.storage)).toEqual(draft);
    expect(takeDraft('contribute-form', r.storage)).toBeUndefined();
  });

  test('a draft reader that throws, or has nothing, does not stop the other drafts or the redirect', async () => {
    const r = rig({ pathname: '/contribute/edit/abc' });
    install(r.deps);
    cleanups.push(
      registerDraft('broken', () => {
        throw new Error('form unmounted');
      }),
    );
    cleanups.push(registerDraft('empty', () => undefined));
    cleanups.push(registerDraft('good', () => ({ note: 'keep me' })));
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/contributions/abc', { schema: anySchema }));

    expect(r.navigations).toHaveLength(1);
    expect(takeDraft('good', r.storage)).toEqual({ note: 'keep me' });
    expect(takeDraft('broken', r.storage)).toBeUndefined();
    expect(takeDraft('empty', r.storage)).toBeUndefined();
  });

  test('fails closed: a failing draft store or toast cannot keep the coach on the expired page', async () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };
    const r = rig(
      { pathname: '/contribute/mine' },
      {
        storage: throwingStorage,
        notify: () => {
          throw new Error('no toaster mounted');
        },
      },
    );
    install(r.deps);
    cleanups.push(registerDraft('contribute-form', () => ({ a: 1 })));
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/contributions/mine', { schema: anySchema }));

    expect(r.navigations).toEqual(['/account/sign-in?redirect=%2Fcontribute%2Fmine']);
  });

  test('a return path that cannot be trusted is dropped: the redirect goes to plain sign-in', async () => {
    const r = rig({ pathname: '/admin/x', search: '?q=\nhttps://evil.example' });
    install(r.deps);
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/admin/x', { schema: anySchema }));

    expect(r.navigations).toEqual(['/account/sign-in']);
  });

  test('the message follows the active language: kk, ru and en', async () => {
    for (const locale of LOCALES) {
      await i18n.changeLanguage(locale);
      const r = rig({ pathname: '/admin' });
      const off = installSessionExpired(r.deps);
      const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);
      await rejection(api.get('/api/admin/x', { schema: anySchema }));
      await Promise.resolve();
      off();
      expect(r.toasts).toEqual([sessionMessages[locale].message as string]);
    }
    expect(sessionMessages.en.message).toBe(EXPIRED_EN);
    expect(new Set(LOCALES.map((locale) => sessionMessages[locale].message)).size).toBe(3);
  });

  test('the account area (sign-in itself) is left alone: no redirect loop', async () => {
    const r = rig({ pathname: '/account/sign-in', search: '?redirect=%2Fadmin' });
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    await rejection(api.get('/api/anything', { schema: anySchema }));

    expect(r.navigations).toEqual([]);
    expect(r.toasts).toEqual([]);
    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(0);
  });

  test('uninstalling removes the handler', async () => {
    const r = rig({ pathname: '/admin' });
    const off = installSessionExpired(r.deps);
    off();
    off(); // safe to call twice
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/admin/x', { schema: anySchema }));

    expect(r.navigations).toEqual([]);
  });
});

// --- player routes: silent re-establish once, retry once ---------------------------------------------------------------

describe('player routes: the anonymous session is silently re-established once and the request retried once', () => {
  /** A server whose cookie is bad until the session has been re-established; decided when the request is sent. */
  function cookieServer(r: ReturnType<typeof rig>, body: unknown = { ok: true }) {
    return fakeFetch(() => (r.session.ensures > 0 ? json(200, body) : json(401)));
  }

  test('player path retries exactly once and the caller just gets the answer', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = cookieServer(r, { session: 'today' });
    const api = apiOver(server.fetch, r.deps);

    const data = await api.get('/api/today', { schema: anySchema });

    expect(data).toEqual({ session: 'today' });
    expect(server.calls.map((c) => c.url)).toEqual(['/api/today', '/api/today']);
    expect(r.session.ensures).toBe(1);
  });

  test('it is silent: no message, no redirect, and nothing surfaces', async () => {
    const r = rig({ pathname: '/train/abc' });
    install(r.deps);
    const api = apiOver(cookieServer(r).fetch, r.deps);

    await api.get('/api/today', { schema: anySchema });

    expect(r.toasts).toEqual([]);
    expect(r.navigations).toEqual([]);
  });

  test('the stale session is forgotten first, then re-established, then the request is sent again', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = fakeFetch((n) => {
      r.log.push(`fetch#${n}`);
      return r.session.ensures > 0 ? json(200) : json(401);
    });
    const api = apiOver(server.fetch, r.deps);

    await api.get('/api/today', { schema: anySchema });

    expect(r.log).toEqual(['fetch#1', 'reset', 'ensure', 'fetch#2']);
  });

  test('exactly once: when the retry is refused too, it is not retried again and the 401 surfaces', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    const error = await rejection(api.get('/api/today', { schema: anySchema }));

    expect(server.calls).toHaveLength(2);
    expect(r.session.ensures).toBe(1);
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).status).toBe(401);
    expect(r.navigations).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  test('a 401 that survives the retry leaves no remembered session behind', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/today', { schema: anySchema }));

    expect(r.log.at(-1)).toBe('reset');
  });

  test('fails closed: when the session cannot be re-established the request is not sent again and the 401 surfaces', async () => {
    const r = rig({ pathname: '/today' });
    r.deps.session = {
      reset: r.session.reset,
      ensure: async () => {
        r.session.ensures += 1;
        throw new Error('offline');
      },
    };
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    const error = await rejection(api.get('/api/today', { schema: anySchema }));

    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(1);
    expect((error as ApiProblem).status).toBe(401);
  });

  test('a later expiry is recovered again: the once is per request, not per page load', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    let expired = true;
    const server = fakeFetch(() => (expired ? json(401) : json(200, { ok: true })));
    const api = apiOver(server.fetch, {
      ...r.deps,
      session: {
        reset: r.session.reset,
        ensure: async () => {
          expired = false;
          return r.session.ensure();
        },
      },
    });

    await api.get('/api/today', { schema: anySchema });
    expired = true;
    await api.get('/api/today', { schema: anySchema });

    expect(r.session.ensures).toBe(2);
    expect(server.calls).toHaveLength(4);
  });

  test('concurrent 401s share ONE re-establish, then each request is retried once', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = cookieServer(r, { ok: 1 });
    const api = apiOver(server.fetch, r.deps);

    const results = await Promise.all([
      api.get('/api/a', { schema: anySchema }),
      api.get('/api/b', { schema: anySchema }),
      api.get('/api/c', { schema: anySchema }),
    ]);

    expect(results).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
    expect(r.session.ensures).toBe(1);
    expect(server.calls).toHaveLength(6);
  });

  test('a 401 for a request sent BEFORE the session was re-established is retried without a second re-establish', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let n = 0;
    const server = fakeFetch(() => {
      n += 1;
      if (r.session.ensures > 0) return json(200, { ok: true });
      // The first request was sent with the old cookie but its refusal only arrives after the recovery finished.
      return n === 1 ? gate.then(() => json(401)) : json(401);
    });
    const api = apiOver(server.fetch, r.deps);

    const slow = api.get('/api/slow', { schema: anySchema });
    // Two quick requests are made after it; their refusals trigger the recovery.
    const quick = Promise.all([api.get('/api/a', { schema: anySchema }), api.get('/api/b', { schema: anySchema })]);
    await quick;
    expect(r.session.ensures).toBe(1);
    openGate();

    expect(await slow).toEqual({ ok: true });
    expect(r.session.ensures).toBe(1);
  });

  test('the same request is replayed: method, path and body are unchanged', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = cookieServer(r, { ok: true });
    const api = apiOver(server.fetch, r.deps);

    await api.post('/api/events', { body: { at: 1 }, schema: anySchema });

    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(server.calls[1]?.method).toBe('POST');
    expect(server.calls[1]?.body).toBe(JSON.stringify({ at: 1 }));
  });

  test.each([200, 204, 403, 404, 429, 500])('a %i is never retried and never touches the session', async (status) => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = fakeFetch(() => (status === 204 ? new Response(null, { status }) : json(status, { ok: true })));
    const api = apiOver(server.fetch, r.deps);

    await (status === 204 ? api.get('/api/today', { schema: 'none' }) : api.get('/api/today', { schema: anySchema })).catch(() => undefined);

    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(0);
    expect(r.session.resets).toBe(0);
  });

  test('auth endpoints are never retried (a 401 there means wrong credentials, not an expired session)', async () => {
    const r = rig({ pathname: '/today' });
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    await rejection(api.post('/api/auth/sign-in/email', { body: { email: 'a@b.c', password: 'x' }, schema: anySchema, skipUnauthorized: true }));

    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(0);
  });

  test('the retry does nothing on the account area, where a 401 is a credentials answer', async () => {
    const r = rig({ pathname: '/account/sign-in' });
    install(r.deps);
    const server = fakeFetch(() => json(401));
    const api = apiOver(server.fetch, r.deps);

    await rejection(api.get('/api/something', { schema: anySchema }));

    expect(server.calls).toHaveLength(1);
    expect(r.session.ensures).toBe(0);
  });

  test('a transport failure passes through untouched', async () => {
    const r = rig({ pathname: '/today' });
    const boom = new TypeError('Failed to fetch');
    const decorated = withSessionRetry(async () => {
      throw boom;
    }, r.deps);

    expect(await rejection(decorated('/api/today', {}))).toBe(boom);
    expect(r.session.ensures).toBe(0);
  });
});

// --- drafts ------------------------------------------------------------------------------------------------------------

describe('draft registry', () => {
  test('takeDraft returns undefined for an unknown key and for a corrupt entry', () => {
    const storage = memoryStorage();
    expect(takeDraft('nope', storage)).toBeUndefined();
    storage.setItem('fc:draft:corrupt', '{not json');
    expect(takeDraft('corrupt', storage)).toBeUndefined();
  });

  test('the unregister function removes a draft source', async () => {
    const r = rig({ pathname: '/contribute' });
    install(r.deps);
    const off = registerDraft('gone', () => ({ a: 1 }));
    off();
    const api = apiOver(fakeFetch(() => json(401)).fetch, r.deps);

    await rejection(api.get('/api/x', { schema: anySchema }));

    expect(takeDraft('gone', r.storage)).toBeUndefined();
  });
});
