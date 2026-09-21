import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetSessionExpired } from '../features/account/session-expired';
import { isApiProblem } from './problem';

// fc-1ik: the app-wide `api` must be created with the retrying fetch, and the 401 handler must be installed at start-up.
// Everything here goes through the REAL `api` export (and the real bootstrap seam); what is stubbed is the global fetch
// (looked up per call), `location` (happy-dom's, moved with history.pushState) and lib/auth's ensurePlayerSession /
// resetPlayerSession (the real ones hold a Better Auth client that captured the global fetch when the module loaded).
//
// Reading of "installSessionExpired() exactly once": bootstrap.installAppSessionExpired(navigate) keeps ONE installed
// handler at any time (a second call replaces the first instead of stacking), and main.tsx calls it once, before render.

const realAuth = await import('./auth');
const realFetch = globalThis.fetch;

let ensureCalls = 0;
let resetCalls = 0;
let ensureImpl: () => Promise<unknown> = async () => ({ user: { id: 'anon', isAnonymous: true } });

beforeAll(() => {
  mock.module('./auth', () => ({
    ...realAuth,
    ensurePlayerSession: () => {
      ensureCalls += 1;
      return ensureImpl();
    },
    resetPlayerSession: () => {
      resetCalls += 1;
    },
  }));
});

// bun's module mocks outlive this file: put the real module back for the files that run after it.
afterAll(() => {
  mock.module('./auth', () => ({ ...realAuth }));
  globalThis.fetch = realFetch;
});

interface Sent {
  url: string;
  method: string | undefined;
}

let sent: Sent[] = [];
let answers: Response[] = [];
let navigations: string[] = [];
let uninstall: (() => void) | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthorized = () => json({ type: 'about:blank', title: 'Unauthorized', status: 401 }, 401);
const ok = () => json({ ok: true });
const Ok = { safeParse: (input: unknown) => ({ success: true as const, data: input as { ok: boolean } }) };

const stubFetch = () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method });
    const next = answers.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  }) as typeof fetch;
};

const goTo = (path: string) => history.pushState({}, '', path);

async function loadApi() {
  return (await import('./api')).api;
}

/** Installs the app's 401 handler the way main.tsx does, with a recording navigate. */
async function installLikeMain() {
  const { installAppSessionExpired } = await import('../bootstrap');
  uninstall = installAppSessionExpired((url) => void navigations.push(url));
}

beforeEach(() => {
  ensureCalls = 0;
  resetCalls = 0;
  ensureImpl = async () => ({ user: { id: 'anon', isAnonymous: true } });
  sent = [];
  answers = [];
  navigations = [];
  goTo('/');
  stubFetch();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  resetSessionExpired();
  globalThis.fetch = realFetch;
  goTo('/');
});

describe('the app-wide api on a player route: one silent re-establish, one retry', () => {
  test('a 401 re-establishes the anonymous session once and the request is sent again, and its answer is returned', async () => {
    goTo('/train/today');
    answers = [unauthorized(), ok()];
    const api = await loadApi();

    const result = await api.get('/api/player/today', { schema: Ok });

    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([
      { url: '/api/player/today', method: 'GET' },
      { url: '/api/player/today', method: 'GET' },
    ]);
    expect(ensureCalls).toBe(1);
  });

  test('a retry is sent with the same method and body', async () => {
    goTo('/');
    answers = [unauthorized(), ok()];
    const api = await loadApi();
    let bodies: unknown[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body);
      return inner(input, init);
    }) as typeof fetch;

    await api.post('/api/player/session-events', { body: { a: 1 }, schema: Ok });

    expect(sent.map((s) => s.method)).toEqual(['POST', 'POST']);
    expect(bodies).toEqual(['{"a":1}', '{"a":1}']);
  });

  test('a second 401 is the final answer: exactly two requests, then the ApiProblem (no loop)', async () => {
    goTo('/train/today');
    answers = [unauthorized(), unauthorized(), ok()];
    const api = await loadApi();

    const failure = await api.get('/api/player/today', { schema: Ok }).catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(sent).toHaveLength(2);
    expect(ensureCalls).toBe(1);
  });

  test('when the session cannot be re-established the original 401 is thrown and nothing is re-sent', async () => {
    goTo('/train/today');
    ensureImpl = async () => {
      throw new Error('offline');
    };
    answers = [unauthorized(), ok()];
    const api = await loadApi();

    const failure = await api.get('/api/player/today', { schema: Ok }).catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(sent).toHaveLength(1);
  });

  test('a request that succeeds first time never touches the session', async () => {
    goTo('/train/today');
    answers = [ok()];
    const api = await loadApi();

    await api.get('/api/player/today', { schema: Ok });

    expect(sent).toHaveLength(1);
    expect(ensureCalls).toBe(0);
  });
});

describe('never retried: /api/auth/* and /account/*', () => {
  test('a 401 from /api/auth/* on a player route is not retried and the session is not re-established', async () => {
    goTo('/train/today');
    answers = [unauthorized(), ok()];
    const api = await loadApi();

    const failure = await api.post('/api/auth/sign-in/email', { body: { email: 'a@b.c', password: 'x' }, schema: Ok }).catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(sent).toHaveLength(1);
    expect(ensureCalls).toBe(0);
  });

  test('a 401 while on an /account/* page is not retried and does not redirect', async () => {
    await installLikeMain();
    goTo('/account/sign-in');
    answers = [unauthorized(), ok()];
    const api = await loadApi();

    const failure = await api.get('/api/player/today', { schema: Ok }).catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(sent).toHaveLength(1);
    expect(ensureCalls).toBe(0);
    expect(navigations).toEqual([]);
  });
});

describe('the app-wide api in a coach area: redirect to sign-in, never a retry', () => {
  test('a 401 on /admin sends the coach to /account/sign-in?redirect=<path> once, and the request is not retried', async () => {
    await installLikeMain();
    goTo('/admin/drills?page=2');
    answers = [unauthorized(), ok()];
    const api = await loadApi();

    const failure = await api.get('/api/admin/drills', { schema: Ok }).catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(navigations).toEqual(['/account/sign-in?redirect=%2Fadmin%2Fdrills%3Fpage%3D2']);
    expect(sent).toHaveLength(1);
    expect(ensureCalls).toBe(0);
  });

  test('a 401 on /contribute redirects the same way', async () => {
    await installLikeMain();
    goTo('/contribute');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.get('/api/contribute/mine', { schema: Ok }).catch(() => undefined);

    expect(navigations).toEqual(['/account/sign-in?redirect=%2Fcontribute']);
  });

  test('a player-route 401 does not redirect anywhere, even after the retry also fails', async () => {
    await installLikeMain();
    goTo('/train/today');
    answers = [unauthorized(), unauthorized()];
    const api = await loadApi();

    await api.get('/api/player/today', { schema: Ok }).catch(() => undefined);

    expect(navigations).toEqual([]);
  });

  test('without the installed handler nothing redirects (the wiring is what installs it)', async () => {
    goTo('/admin');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.get('/api/admin/drills', { schema: Ok }).catch(() => undefined);

    expect(navigations).toEqual([]);
  });
});

describe('skipUnauthorized calls (login) still skip the notification', () => {
  test('a login 401 from a coach area does not redirect', async () => {
    await installLikeMain();
    goTo('/admin');
    answers = [unauthorized()];
    const api = await loadApi();

    const failure = await api
      .post('/api/auth/sign-in/email', { body: { email: 'a@b.c', password: 'bad' }, schema: Ok, skipUnauthorized: true })
      .catch((error: unknown) => error);

    expect(isApiProblem(failure) && failure.kind).toBe('unauthorized');
    expect(navigations).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test('skipUnauthorized on a coach-area request to another path also skips the redirect', async () => {
    await installLikeMain();
    goTo('/contribute');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.post('/api/contribute/recover', { schema: Ok, skipUnauthorized: true }).catch(() => undefined);

    expect(navigations).toEqual([]);
  });
});

describe('the real fetch is resolved at call time', () => {
  test('a fetch installed after the api module was loaded, and swapped between calls, is the one used', async () => {
    const api = await loadApi();
    const seen: string[] = [];
    globalThis.fetch = (async () => {
      seen.push('first');
      return ok();
    }) as unknown as typeof fetch;
    await api.get('/api/x', { schema: Ok });

    globalThis.fetch = (async () => {
      seen.push('second');
      return ok();
    }) as unknown as typeof fetch;
    await api.get('/api/x', { schema: Ok });

    expect(seen).toEqual(['first', 'second']);
  });
});

describe('bootstrap.installAppSessionExpired: one handler, router-aware navigation', () => {
  test('one expiry produces one navigation to the injected navigate (a client-side navigation, not a page load)', async () => {
    await installLikeMain();
    goTo('/admin');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.get('/api/admin/drills', { schema: Ok }).catch(() => undefined);

    expect(navigations).toEqual(['/account/sign-in?redirect=%2Fadmin']);
  });

  test('installing again replaces the handler instead of stacking a second one', async () => {
    const { installAppSessionExpired } = await import('../bootstrap');
    const first: string[] = [];
    const second: string[] = [];
    installAppSessionExpired((url) => void first.push(url));
    uninstall = installAppSessionExpired((url) => void second.push(url));
    goTo('/admin');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.get('/api/admin/drills', { schema: Ok }).catch(() => undefined);

    expect(first).toEqual([]);
    expect(second).toEqual(['/account/sign-in?redirect=%2Fadmin']);
  });

  test('the returned function uninstalls it', async () => {
    await installLikeMain();
    uninstall?.();
    uninstall = undefined;
    goTo('/admin');
    answers = [unauthorized()];
    const api = await loadApi();

    await api.get('/api/admin/drills', { schema: Ok }).catch(() => undefined);

    expect(navigations).toEqual([]);
  });
});

describe('main.tsx installs the handler through the seam, before the first render', () => {
  const mainSource = readFileSync(join(import.meta.dir, '..', 'main.tsx'), 'utf8');

  test("imports installAppSessionExpired from './bootstrap'", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*\binstallAppSessionExpired\b[^}]*\}\s*from\s*['"]\.\/bootstrap['"]/);
  });

  test('calls it exactly once, with a navigate built from the router, before .render(', () => {
    const calls = [...mainSource.matchAll(/installAppSessionExpired\(/g)];
    expect(calls).toHaveLength(1);
    const at = calls[0]?.index ?? -1;
    expect(at).toBeGreaterThan(mainSource.search(/createRouter\(/));
    expect(at).toBeLessThan(mainSource.search(/\.render\(/));
    const call = mainSource.slice(at, mainSource.indexOf(';', at));
    expect(call).toMatch(/\brouter\b/);
  });
});
