import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type AnyRoute, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as route-guard.test.ts's siblings).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor } = await import('@testing-library/react');

/*
 * Contract under test (auth-gate spec §1–2, P1): the gate WIRED INTO REAL ROUTING. Unlike route-guard.test.ts (the guard
 * function in isolation), this file exercises the real `Route` objects that routes/{train,progress,video,settings,
 * contribute}/route.tsx export, mounted into a TanStack memory router, so a bug in the wiring (a beforeLoad that never runs,
 * the wrong level on the wrong route) shows up the way it would in the app.
 *
 * The app-wide Better Auth session ATOM (authClient.$store.atoms.session, lib/auth.ts) is replaced with a controllable fake
 * so no network is needed and the outcome is deterministic — the same `mock.module('../../lib/auth', ...)` technique as
 * features/offline/today-extra.lastplayer.test.tsx, restored in afterAll so later files see the real module. The route
 * files themselves are re-imported (dynamic `import`) AFTER the mock is installed, so their `requireSession()` /
 * `requireAccount()` closures read the fake atom regardless of what another test file already imported.
 *
 * Each gated area's own page is stood in by a one-line fixture component (this package owns no page files): /train's
 * fixture also fires `fetch('/api/player/today')` on mount, the same call the real page makes, so "no player API call
 * before the redirect" is a real assertion — if the guard ever let a signed-out visitor through, this would catch it.
 */

type SessionAtomValue = { data?: unknown; error?: unknown; isPending?: boolean; isRefetching?: boolean };

function fakeAtom(initial: SessionAtomValue) {
  let current = initial;
  const listeners = new Set<(value: SessionAtomValue) => void>();
  return {
    subscribe(listener: (value: SessionAtomValue) => void) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const NONE: SessionAtomValue = { data: null, error: null, isPending: false };
const ANONYMOUS: SessionAtomValue = { data: { user: { id: 'player-1', isAnonymous: true } }, error: null, isPending: false };
const ACCOUNT: SessionAtomValue = { data: { user: { id: 'coach-1', isAnonymous: false } }, error: null, isPending: false };

/** What the fake atom answers right now; reassigned per test BEFORE the router (and its beforeLoad) is built. */
let sessionAtom = fakeAtom(NONE);

const realAuth = await import('../../lib/auth');

let TrainRouteRoute: AnyRoute;
let ProgressRouteRoute: AnyRoute;
let VideoRouteRoute: AnyRoute;
let SettingsRouteRoute: AnyRoute;
let ContributeRouteRoute: AnyRoute;

/** Re-attaches a file route (its id/path fixed by `createFileRoute`) to a test-built root, exactly like
 * admin-layout.test.tsx's `buildFileRouter`: `AnyRoute` does not model `.update()`'s real (file-route-specific) options type. */
const reattach = (route: AnyRoute, options: { id: string; path: string; getParentRoute: () => AnyRoute }): AnyRoute =>
  (route as unknown as { update(options: object): AnyRoute }).update(options);

beforeAll(async () => {
  mock.module('../../lib/auth', () => ({
    ...realAuth,
    authClient: {
      ...realAuth.authClient,
      $store: { atoms: { session: { subscribe: (listener: (value: SessionAtomValue) => void) => sessionAtom.subscribe(listener) } } },
    },
  }));
  ({ Route: TrainRouteRoute } = await import('../../routes/train/route'));
  ({ Route: ProgressRouteRoute } = await import('../../routes/progress/route'));
  ({ Route: VideoRouteRoute } = await import('../../routes/video/route'));
  ({ Route: SettingsRouteRoute } = await import('../../routes/settings/route'));
  ({ Route: ContributeRouteRoute } = await import('../../routes/contribute/route'));
});

// bun's module mocks outlive this file: put the real module back for the files that run after it.
afterAll(() => {
  mock.module('../../lib/auth', () => ({ ...realAuth }));
});

// --- fixtures ------------------------------------------------------------------------------------------------------------

const TRAIN_TEXT = 'Train page content';
const PROGRESS_TEXT = 'Progress page content';
const VIDEO_TEXT = 'Video page content';
const SETTINGS_PRIVACY_TEXT = 'Settings privacy page content';
const CONTRIBUTE_TEXT = 'Contribute page content';

// Every fetch this file's fixtures make (never a real one: there is no server on the test's origin). Reset per test.
let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

function TrainFixture() {
  // What the real /train page does first: a signed-out visitor must never trigger this.
  useEffect(() => {
    void fetch('/api/player/today');
  }, []);
  return <p>{TRAIN_TEXT}</p>;
}

function buildRouter(path: string) {
  const root = createRootRoute({ component: Outlet });

  const trainLayout = reattach(TrainRouteRoute, { id: '/train', path: '/train', getParentRoute: () => root });
  const trainIndex = createRoute({ getParentRoute: () => trainLayout, path: '/', component: TrainFixture });

  const progressLayout = reattach(ProgressRouteRoute, { id: '/progress', path: '/progress', getParentRoute: () => root });
  const progressIndex = createRoute({ getParentRoute: () => progressLayout, path: '/', component: () => <p>{PROGRESS_TEXT}</p> });

  const videoLayout = reattach(VideoRouteRoute, { id: '/video', path: '/video', getParentRoute: () => root });
  const videoIndex = createRoute({ getParentRoute: () => videoLayout, path: '/', component: () => <p>{VIDEO_TEXT}</p> });

  const settingsLayout = reattach(SettingsRouteRoute, { id: '/settings', path: '/settings', getParentRoute: () => root });
  const settingsPrivacy = createRoute({
    getParentRoute: () => settingsLayout,
    path: 'privacy',
    component: () => <p>{SETTINGS_PRIVACY_TEXT}</p>,
  });

  const contributeLayout = reattach(ContributeRouteRoute, { id: '/contribute', path: '/contribute', getParentRoute: () => root });
  const contributeIndex = createRoute({ getParentRoute: () => contributeLayout, path: '/', component: () => <p>{CONTRIBUTE_TEXT}</p> });

  const signIn = createRoute({ getParentRoute: () => root, path: '/account/sign-in', component: () => <p>Sign-in page</p> });

  return createRouter({
    routeTree: root.addChildren([
      trainLayout.addChildren([trainIndex]),
      progressLayout.addChildren([progressIndex]),
      videoLayout.addChildren([videoIndex]),
      settingsLayout.addChildren([settingsPrivacy]),
      contributeLayout.addChildren([contributeIndex]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

const mount = (router: ReturnType<typeof buildRouter>) => render(<RouterProvider router={router} />);

const where = (router: ReturnType<typeof buildRouter>) => {
  const { pathname, search } = router.history.location;
  return { pathname, search, href: `${pathname}${search}`, redirect: new URLSearchParams(search).get('redirect') };
};

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // not every environment has one; the tests below never rely on it
  }
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(typeof input === 'string' ? input : input.toString());
    return new Response(null, { status: 599 }); // no real request leaves the test: only that it was ATTEMPTED matters
  }) as typeof fetch;
});

/*
 * Cross-file hygiene (copied from features/contribute/form.test.tsx). bun runs every test file of the web package in ONE
 * process with ONE happy-dom window, so whatever this file leaves on the window/document is still there for the files that
 * run after it: happy-dom records every element query it has answered in bookkeeping lists that are never trimmed, and a
 * later file's FAILING `expect(element)...` (which bun pretty-prints, together with that bookkeeping) can then blow its
 * timeout. After every test the DOM is empty, so the lists are emptied the way happy-dom itself empties them when a node
 * changes. Written against happy-dom 20.x symbols by description; if they are not there it does nothing.
 */
function resetHappyDomCaches(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
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

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

// --- a signed-out visitor: redirected, nothing gated ever renders --------------------------------------------------------

describe('a signed-out visitor', () => {
  test('asking for /train lands on /account/sign-in?redirect=%2Ftrain and the Train page never renders', async () => {
    sessionAtom = fakeAtom(NONE);
    const router = buildRouter('/train');
    mount(router);
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).href).toBe('/account/sign-in?redirect=%2Ftrain');
    expect(screen.queryByText(TRAIN_TEXT)).toBeNull();
  });

  test('no player API call is made before the redirect (GET /api/player/today is never requested)', async () => {
    sessionAtom = fakeAtom(NONE);
    const router = buildRouter('/train');
    mount(router);
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    // Give a wrongly-mounted Train fixture a moment to fire its effect, if the guard had let it through.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls.some((url) => url.includes('/api/player/today'))).toBe(false);
  });

  test.each([
    ['/progress', PROGRESS_TEXT],
    ['/video', VIDEO_TEXT],
    ['/settings/privacy', SETTINGS_PRIVACY_TEXT],
  ])('%s redirects with its own return path, and its page never renders', async (path, text) => {
    sessionAtom = fakeAtom(NONE);
    const router = buildRouter(path);
    mount(router);
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe(path);
    expect(screen.queryByText(text)).toBeNull();
  });

  test('asking for /contribute lands on the sign-in gate too (an account, not just a session, is required there)', async () => {
    sessionAtom = fakeAtom(NONE);
    const router = buildRouter('/contribute');
    mount(router);
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/contribute');
  });
});

// --- an anonymous player: any-session routes render, the account-only one still gates -----------------------------------

describe('an anonymous player', () => {
  test('asking for /train renders the page (any session is enough to train)', async () => {
    sessionAtom = fakeAtom(ANONYMOUS);
    const router = buildRouter('/train');
    mount(router);
    expect(await screen.findByText(TRAIN_TEXT)).toBeTruthy();
    expect(where(router).pathname).toBe('/train');
  });

  test.each([
    ['/progress', PROGRESS_TEXT],
    ['/video', VIDEO_TEXT],
    ['/settings/privacy', SETTINGS_PRIVACY_TEXT],
  ])('asking for %s renders the page', async (path, text) => {
    sessionAtom = fakeAtom(ANONYMOUS);
    const router = buildRouter(path);
    mount(router);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  test('asking for /contribute lands on the sign-in gate (an anonymous session cannot contribute)', async () => {
    sessionAtom = fakeAtom(ANONYMOUS);
    const router = buildRouter('/contribute');
    mount(router);
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/contribute');
    expect(screen.queryByText(CONTRIBUTE_TEXT)).toBeNull();
  });
});

// --- a coach account: everything renders, including the account-only route -----------------------------------------------

describe('a coach account', () => {
  test('asking for /contribute renders the page', async () => {
    sessionAtom = fakeAtom(ACCOUNT);
    const router = buildRouter('/contribute');
    mount(router);
    expect(await screen.findByText(CONTRIBUTE_TEXT)).toBeTruthy();
    expect(where(router).pathname).toBe('/contribute');
  });

  test('asking for /train still renders the page (an account satisfies the lighter "any session" gate too)', async () => {
    sessionAtom = fakeAtom(ACCOUNT);
    const router = buildRouter('/train');
    mount(router);
    expect(await screen.findByText(TRAIN_TEXT)).toBeTruthy();
  });
});
