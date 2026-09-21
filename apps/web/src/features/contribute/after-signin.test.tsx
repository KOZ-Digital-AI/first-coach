import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ContributionMeta } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createPlayerAuthClient } from '../../lib/auth';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route as SignInRoute, SignInDepsContext } from '../../routes/account/sign-in';
import { ContributeDepsContext, Route as ContributeRoute } from '../../routes/contribute/index';
import signInMessages from '../account/sign-in.messages';
import formMessages from './form.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as form.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * Contract under test (bug fc-mol-70i.13, found by the gate script j5-contribute.sh): after a successful sign-up or sign-in
 * from /account/sign-in?redirect=/contribute the browser ends on /contribute showing the contribute form. It must not be sent
 * back to /account/sign-in ("You are already signed in. Continue").
 *
 * Root cause: the sign-in screen navigated as soon as signUp.email / signIn.email resolved, but Better Auth refreshes its
 * session atom only ~10 ms LATER (a `setTimeout` that toggles `$sessionSignal`). For that moment the atom still held the
 * ANONYMOUS guest session, not refetching and not pending, so the /contribute gate read "signed out" and sent the fresh coach
 * back to sign-in. The fix is at the cause: the sign-in screen waits for the shared session atom to settle on the new session
 * before it navigates. Nothing here waits for a fixed time, and the gate itself is not made more lenient.
 *
 * What is real: Better Auth's own client and session atom (createPlayerAuthClient over a fake HTTP server, with its real
 * signal timing), the real sign-in screen, the real /contribute gate and its form, TanStack Router with a memory history. What
 * is faked: the HTTP server (get-session, sign-up, sign-in and the form's meta call).
 *
 * Readings: the redirect params of /contribute/mine and /contribute/:id/edit are covered by the same fix, because it is the
 * sign-in screen that waits (those two routes decide from the API's 401/403 on their own request, not from the session atom).
 */

// --- the fake server ----------------------------------------------------------------------------------------------

const META = ContributionMeta.parse({
  sports: [{ slug: 'football', name: { kk: 'Футбол', ru: 'Футбол', en: 'Football' } }],
  skills: [{ slug: 'passing', name: { kk: 'Пас беру', ru: 'Передачи', en: 'Passing' }, children: [] }],
  levels: ['beginner', 'basic', 'intermediate'],
  equipment: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
  spaces: ['home_3x3', 'yard', 'field', 'gym'],
  licenses: ['CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0-1.0'],
  improvementKinds: ['explanation', 'progression'],
  upload: { maxMb: 50, mimeTypes: ['video/mp4'] },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionOf = (user: Record<string, unknown>) => ({
  session: { id: `s-${String(user.id)}`, userId: user.id, token: 't', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T09:00:00.000Z' },
  user: { name: 'x', email: 'x@example.com', emailVerified: false, createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T09:00:00.000Z', ...user },
});
const GUEST = { id: 'guest-1', isAnonymous: true };
const COACH = { id: 'coach-1', isAnonymous: false };

interface Server {
  /** Who the cookie belongs to. Signing up or in turns the guest into the coach. */
  who: 'guest' | 'coach';
  /** While set, every get-session waits for it (a slow network). */
  hold: Promise<void> | null;
  /** While true, every get-session answers 500. */
  failReads: boolean;
  sessionReads: number;
}

let server: Server;
const freshServer = (): Server => ({ who: 'guest', hold: null, failReads: false, sessionReads: 0 });

async function serveAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.pathname === '/api/auth/get-session' && method === 'GET') {
    server.sessionReads += 1;
    await server.hold;
    if (server.failReads) return json({ message: 'boom' }, 500);
    return json(sessionOf(server.who === 'coach' ? COACH : GUEST));
  }
  if (method === 'POST' && (url.pathname === '/api/auth/sign-up/email' || url.pathname === '/api/auth/sign-in/email')) {
    server.who = 'coach';
    return json({ token: 't', user: COACH });
  }
  return json({ message: 'not found' }, 404);
}

const realFetch = globalThis.fetch;

/*
 * Cross-file hygiene. bun runs every test file of the web package in ONE process with ONE happy-dom window, so whatever this
 * file leaves on the window/document is still there for the files that run after it. happy-dom records every element query it
 * has answered (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the document and on <html>
 * (`affectsCache`, `affectsComputedStyleCache`) and in the window's selector cache, and never trims them. After every test the
 * DOM is empty, so the lists are emptied the way happy-dom itself empties them when a node changes: every recorded result is
 * invalidated first, then the list is cleared. Written against happy-dom 20.x symbols by description; if they are not there it
 * does nothing. (Same helper as form.test.tsx.)
 */
function resetHappyDomCaches(): void {
  const targets: object[] = [document, document.documentElement, document.body, window];
  for (const target of targets) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if ((symbol.description === 'affectsCache' || symbol.description === 'affectsComputedStyleCache') && Array.isArray(value)) {
        for (const item of value) if (typeof item === 'object' && item !== null) (item as { result: unknown }).result = null;
        value.length = 0;
      } else if (symbol.description === 'querySelectorCache' && value instanceof Map) {
        value.clear();
      }
    }
  }
}

beforeEach(() => {
  server = freshServer();
  // The contribute form's own request (GET /api/contribute/meta) goes through the global fetch.
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    return url.pathname === '/api/contribute/meta' ? json(META) : json({ title: 'Not Found', status: 404 }, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------------------------

const modules = {
  './sign-in.messages.ts': { default: signInMessages },
  './form.messages.ts': { default: formMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** What the app shell does: subscribes to Better Auth's session atom and hands the result to the contributor screens. */
function Shell({ client, children }: { client: ReturnType<typeof createPlayerAuthClient>; children: ReactNode }) {
  const session = client.useSession();
  return (
    <ContributeDepsContext.Provider
      value={{
        session,
        createXhr: () => {
          throw new Error('no upload in this file');
        },
        storage: null,
      }}
    >
      {children}
    </ContributeDepsContext.Provider>
  );
}

function renderApp(start: string) {
  const client = createPlayerAuthClient({ baseURL: 'http://localhost', fetch: serveAuth as typeof fetch });
  const instance = createI18n({ modules, languages: ['en'], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const signIn = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account/sign-in',
    component: SignInRoute.options.component,
    validateSearch: SignInRoute.options.validateSearch,
  });
  const contribute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute', component: ContributeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([signIn, contribute]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  // Every location the router moves to after the first render, in order, and what the shared session atom held at that instant.
  const visited: string[] = [];
  const arrivals: Array<{ path: string; reading: boolean; userId: unknown }> = [];
  router.history.subscribe(({ location }) => {
    visited.push(location.pathname);
    const atom = client.$store.atoms.session.get() as { data?: { user?: { id?: unknown } } | null; isPending?: boolean; isRefetching?: boolean };
    arrivals.push({ path: location.pathname, reading: atom.isPending === true || atom.isRefetching === true, userId: atom.data?.user?.id });
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <SignInDepsContext.Provider
          value={{
            // The real Better Auth client: its session atom is the one the /contribute gate reads through the shell.
            client,
            storage: null,
            // The player-session memo and the 401 latch are other modules' business; nothing here reads them.
            resetSession: () => {},
            resetSessionExpired: () => {},
          }}
        >
          <Shell client={client}>
            <RouterProvider router={router} />
          </Shell>
        </SignInDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, visited, arrivals };
}

const SIGN_IN_FROM_CONTRIBUTE = `/account/sign-in?redirect=${encodeURIComponent('/contribute')}`;
const SUBMIT_FORM = /^Send for review$/;

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The sign-in screen has loaded and the visitor is known to be a guest (the atom has answered too). */
async function waitForGuestScreen() {
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(server.sessionReads).toBeGreaterThan(0));
}

async function signUp() {
  type(/^display name/i, 'Aigerim Coach');
  type(/^email/i, 'aigerim@example.com');
  type(/^password/i, 'correct horse battery');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^create coach account$/i }));
  });
}

async function signInWithAccount() {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /^sign in$/i }));
  });
  type(/^email/i, 'aigerim@example.com');
  type(/^password/i, 'correct horse battery');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  });
}

const continueButton = () => screen.queryByRole('button', { name: /^continue$/i });

// --- the journey --------------------------------------------------------------------------------------------------

describe('after signing in with ?redirect=/contribute the coach lands on the form', () => {
  test('sign-up: ends on /contribute with the form; the gate never sends the fresh coach back to sign-in', async () => {
    const { visited, router, arrivals } = renderApp(SIGN_IN_FROM_CONTRIBUTE);
    await waitForGuestScreen();

    await signUp();

    await screen.findByRole('button', { name: SUBMIT_FORM });
    expect(router.state.location.pathname).toBe('/contribute');
    // The screen left for /contribute only once the shared session atom had settled on the NEW session, not the guest's.
    expect(arrivals[0]).toEqual({ path: '/contribute', reading: false, userId: COACH.id });
    // Every move the router made was to /contribute: no bounce back to /account/sign-in, at any point.
    expect(visited.length).toBeGreaterThan(0);
    expect(visited.every((path) => path === '/contribute')).toBe(true);
    // ... and no second sign-in screen waiting for a manual "Continue" press.
    expect(continueButton() === null).toBe(true);
  });

  test('sign-in tab with an existing account: ends on /contribute with the form', async () => {
    const { visited, router, arrivals } = renderApp(SIGN_IN_FROM_CONTRIBUTE);
    await waitForGuestScreen();

    await signInWithAccount();

    await screen.findByRole('button', { name: SUBMIT_FORM });
    expect(router.state.location.pathname).toBe('/contribute');
    expect(arrivals[0]).toEqual({ path: '/contribute', reading: false, userId: COACH.id });
    expect(visited.every((path) => path === '/contribute')).toBe(true);
    expect(continueButton() === null).toBe(true);
  });

  test('while the session is still being read after sign-up the coach waits, and is never sent to sign-in; the form shows once it settles', async () => {
    const { visited, router, arrivals } = renderApp(SIGN_IN_FROM_CONTRIBUTE);
    await waitForGuestScreen();
    await waitFor(() => expect(screen.queryByText(signInMessages.en.guest.checking) === null).toBe(true));

    // A slow network: every session read from here on is held until the test lets it go.
    let release: () => void = () => {};
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const readsBefore = server.sessionReads;
    await signUp();

    // The session is being re-read (Better Auth's own refresh, or the sign-in screen's): the answer is not in yet.
    await waitFor(() => expect(server.sessionReads).toBeGreaterThan(readsBefore));
    // Whatever the screen shows while it waits, it is neither the form nor a redirect back to sign-in.
    expect(screen.queryByRole('button', { name: SUBMIT_FORM }) === null).toBe(true);
    expect(visited.includes('/account/sign-in')).toBe(false);
    // The sign-in screen has not left yet: it is waiting for the answer.
    expect(visited.length).toBe(0);

    server.hold = null;
    release();

    await screen.findByRole('button', { name: SUBMIT_FORM });
    expect(router.state.location.pathname).toBe('/contribute');
    expect(visited.includes('/account/sign-in')).toBe(false);
    // It left when NO read was running any more (Better Auth's own refresh may have replaced the first one) and the atom held the coach.
    expect(arrivals[0]).toEqual({ path: '/contribute', reading: false, userId: COACH.id });
  });

  test('if the session read after sign-in fails, the coach reaches /contribute and can retry there; nothing bounces them to sign-in', async () => {
    const { visited, router } = renderApp(SIGN_IN_FROM_CONTRIBUTE);
    await waitForGuestScreen();

    server.failReads = true;
    await signUp();

    await screen.findByText(formMessages.en.gate.error.title);
    expect(router.state.location.pathname).toBe('/contribute');
    expect(visited.includes('/account/sign-in')).toBe(false);

    server.failReads = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: formMessages.en.gate.error.retry }));
    });
    await screen.findByRole('button', { name: SUBMIT_FORM });
    expect(visited.includes('/account/sign-in')).toBe(false);
  });
});

describe('the gate stays closed to a visitor who did not sign in', () => {
  test('a guest opening /contribute is still sent to /account/sign-in?redirect=/contribute (real session atom)', async () => {
    const { router, visited } = renderApp('/contribute');

    await screen.findByRole('button', { name: /^create coach account$/i });
    expect(router.state.location.pathname).toBe('/account/sign-in');
    expect(router.state.location.search).toEqual({ redirect: '/contribute' });
    expect(visited.includes('/account/sign-in')).toBe(true);
    expect(screen.queryByRole('button', { name: SUBMIT_FORM }) === null).toBe(true);
  });
});
