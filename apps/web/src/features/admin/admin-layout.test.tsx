import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import { AdminLayoutView, Route as AdminRoute } from '../../routes/admin/route';
import messages from './admin-layout.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as lib/i18n.test.ts).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

type Locale = (typeof LOCALES)[number];

/*
 * Contract under test (fc-mol-0v3.8): routes/admin/route.tsx is the layout for every /admin/* page.
 *  - signed-out (no session, or only the silent anonymous player session) -> the sign-in page, carrying the page the person
 *    came from as `redirect`;
 *  - signed-in but not an admin -> the unauthorized page, no redirect;
 *  - admin -> a sub-navigation (Review queue, Drills, Impact, Settings) and the page.
 * The guard FAILS CLOSED: while the session is loading, when reading it failed, or when it is not something we can read, no
 * admin content is rendered. The guard is cosmetic (the API's requireAdmin is the real gate); these tests pin the UX only.
 *
 * Kazakh copy is flagged for a native-speaker review (bead fc-cjh): the tests pin structure and English words, and for kk/ru
 * only that text exists, is in the right script and never leaks 'undefined' or a raw key.
 */

// --- fixtures ----------------------------------------------------------------------------------

type SessionState = { data?: unknown; isPending: boolean; isRefetching?: boolean; error?: unknown; refetch: () => unknown };

const adminSession = { user: { id: 'u-admin', name: 'Ada', role: 'admin', isAnonymous: false } };
const sessionWith = (user: Record<string, unknown>) => ({ user: { id: 'u-1', name: 'Sam', isAnonymous: false, ...user } });

const ready = (data: unknown, refetch: () => unknown = () => {}): SessionState => ({ data, isPending: false, error: null, refetch });

const CHILD_TEXT = 'Drills page content';
const NAV_LABEL = 'Admin sections';
const NAV = [
  { name: 'Review queue', href: '/admin' },
  { name: 'Drills', href: '/admin/drills' },
  { name: 'Impact', href: '/admin/impact' },
  { name: 'Settings', href: '/admin/settings' },
] as const;

const modules = { './admin-layout.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };

/** A session store the layout subscribes to, so a test can change the session while the page is open. */
function createStore(initial: SessionState) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next: SessionState) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
type Store = ReturnType<typeof createStore>;

/** Every route the layout can meet: the four admin pages under it, plus the sign-in page it redirects to. */
function buildRouter(layout: (root: AnyRoute) => AnyRoute, path: string) {
  const root = createRootRoute({ component: Outlet });
  const adminLayout = layout(root);
  const page = (slug: string, text: string) =>
    createRoute({ getParentRoute: () => adminLayout, path: slug, component: () => <p>{text}</p> });
  const signIn = createRoute({ getParentRoute: () => root, path: '/account/sign-in', component: () => <p>Sign-in page</p> });
  return createRouter({
    routeTree: root.addChildren([
      adminLayout.addChildren([
        page('queue', 'Queue page content'),
        page('drills', CHILD_TEXT),
        page('impact', 'Impact page content'),
        page('settings', 'Settings page content'),
      ]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

function mount(router: ReturnType<typeof buildRouter>, locale: Locale) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  return render(
    <I18nextProvider i18n={instance}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
}

/** AdminLayoutView (the layout with the session handed in) mounted at /admin as the real route tree would. */
function renderLayout(session: SessionState, options: { path?: string; locale?: Locale } = {}) {
  const store: Store = createStore(session);
  const router = buildRouter(
    (root) =>
      createRoute({
        getParentRoute: () => root,
        path: '/admin',
        component: function TestAdminLayout() {
          return <AdminLayoutView session={useSyncExternalStore(store.subscribe, store.get)} />;
        },
      }),
    options.path ?? '/admin/drills',
  );
  const view = mount(router, options.locale ?? 'en');
  return { ...view, router, store };
}

const where = (router: ReturnType<typeof buildRouter>) => {
  const { pathname, search } = router.history.location;
  return { pathname, search, redirect: new URLSearchParams(search).get('redirect') };
};

/** Let the layout's effects, the router's load and any redirect run to the end. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

const noAdminContent = () => {
  expect(screen.queryByText(CHILD_TEXT), 'the admin page rendered').toBeNull();
  expect(screen.queryByRole('navigation', { name: NAV_LABEL }), 'the admin sub-navigation rendered').toBeNull();
  expect(screen.queryByRole('link', { name: 'Impact' }), 'an admin link rendered').toBeNull();
};

afterEach(() => {
  cleanup();
});

// --- signed-out: sign-in with redirect ---------------------------------------------------------

describe('a signed-out visitor', () => {
  test('is sent to sign-in, carrying the page they asked for as `redirect`, and sees nothing of the admin area', async () => {
    const { router } = renderLayout(ready(null), { path: '/admin/drills' });
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/admin/drills');
    await settle();
    expect(screen.getByText('Sign-in page')).toBeTruthy();
    noAdminContent();
  });

  test('keeps the query string and hash of the requested page in `redirect`', async () => {
    const { router } = renderLayout(ready(undefined), { path: '/admin/drills?status=pending#top' });
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/admin/drills?status=pending#top');
  });

  test('the redirect target is /account/sign-in?redirect=<the requested page>', async () => {
    const { router } = renderLayout(ready(null), { path: '/admin/impact' });
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    const { pathname, search } = where(router);
    expect(`${pathname}${search}`.startsWith('/account/sign-in?redirect=')).toBe(true);
    expect(`${pathname}${search}`).toBe(`/account/sign-in?redirect=${encodeURIComponent('/admin/impact')}`);
  });

  test('is not shown the unauthorized page (that is for people who are signed in)', async () => {
    const { router } = renderLayout(ready(null));
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(screen.queryByRole('heading', { name: /administrators/i })).toBeNull();
  });

  test.each([
    ['an anonymous player session', sessionWith({ isAnonymous: true, role: 'admin' })],
    ['a session that does not say whether it is anonymous', { user: { id: 'u-2', role: 'admin' } }],
    ['a session whose isAnonymous is null', sessionWith({ isAnonymous: null, role: 'admin' })],
  ])('%s counts as signed-out (an admin needs a real account)', async (_name, data) => {
    const { router } = renderLayout(ready(data));
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/admin/drills');
    noAdminContent();
  });

  test('is sent to sign-in when a session ends while the page is open, and the admin page goes away', async () => {
    const { router, store } = renderLayout(ready(adminSession));
    expect(await screen.findByText(CHILD_TEXT)).toBeTruthy();
    await act(async () => {
      store.set(ready(null));
    });
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    noAdminContent();
  });
});

// --- signed-in non-admin: the unauthorized page ------------------------------------------------

describe('a signed-in person who is not an admin', () => {
  test('sees the unauthorized page in place: a heading, a way home, no redirect, no admin content', async () => {
    const { router } = renderLayout(ready(sessionWith({ role: 'contributor' })));
    const heading = await screen.findByRole('heading', { level: 1, name: /administrators/i });
    expect(heading).toBeTruthy();
    const home = screen.getByRole('link', { name: /home/i });
    expect(home.getAttribute('href')).toBe('/');
    await settle();
    expect(where(router).pathname).toBe('/admin/drills');
    noAdminContent();
  });

  test('a session with no role at all is a contributor: unauthorized, not admin', async () => {
    renderLayout(ready(sessionWith({})));
    expect(await screen.findByRole('heading', { level: 1, name: /administrators/i })).toBeTruthy();
    noAdminContent();
  });

  test.each([
    ['a contributor', 'contributor'],
    ['a role that only contains the word', 'superadmin'],
    ['a role with stray whitespace', ' admin'],
    ['a different case', 'Admin'],
    ['an empty role', ''],
    ['a role that is not a string', 42],
    ['a role that is null', null],
  ])('%s is not an admin', async (_name, role) => {
    renderLayout(ready(sessionWith({ role })));
    expect(await screen.findByRole('heading', { level: 1, name: /administrators/i })).toBeTruthy();
    noAdminContent();
  });

  test('a banned admin is not shown the admin area', async () => {
    renderLayout(ready(sessionWith({ role: 'admin', banned: true })));
    expect(await screen.findByRole('heading', { level: 1, name: /administrators/i })).toBeTruthy();
    noAdminContent();
  });
});

// --- admin: sub-navigation and the page --------------------------------------------------------

describe('an admin', () => {
  test('gets the sub-navigation in order (Review queue, Drills, Impact, Settings), each link going to its own admin page', async () => {
    renderLayout(ready(adminSession));
    const nav = await screen.findByRole('navigation', { name: NAV_LABEL });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent?.trim())).toEqual(NAV.map(({ name }) => name));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(NAV.map(({ href }) => href));
  });

  test('gets the page of the current route inside the layout', async () => {
    renderLayout(ready(adminSession), { path: '/admin/drills' });
    expect(await screen.findByText(CHILD_TEXT)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /administrators/i })).toBeNull();
  });

  test('a role list that includes admin is enough', async () => {
    renderLayout(ready(sessionWith({ role: 'contributor,admin' })));
    expect(await screen.findByRole('navigation', { name: NAV_LABEL })).toBeTruthy();
    expect(screen.getByText(CHILD_TEXT)).toBeTruthy();
  });

  test('sees the current section marked in words and shape (aria-current), never colour alone', async () => {
    renderLayout(ready(adminSession), { path: '/admin/drills' });
    const nav = await screen.findByRole('navigation', { name: NAV_LABEL });
    const current = within(nav).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Drills']);
    // A check icon is the second signal next to the label.
    expect(current[0]?.querySelector('svg')).not.toBeNull();
    const others = within(nav).getAllByRole('link').filter((link) => link !== current[0]);
    for (const link of others) expect(link.querySelector('svg')).toBeNull();
  });

  test('keeps a section marked current on its sub-pages', async () => {
    const { router } = renderLayout(ready(adminSession), { path: '/admin/drills' });
    await screen.findByRole('navigation', { name: NAV_LABEL });
    await act(async () => {
      await router.navigate({ to: '/admin/impact' as never });
    });
    const nav = screen.getByRole('navigation', { name: NAV_LABEL });
    const current = within(nav).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Impact']);
  });

  test('follows a nav link without leaving the layout (client-side navigation)', async () => {
    const { router } = renderLayout(ready(adminSession), { path: '/admin/drills' });
    const nav = await screen.findByRole('navigation', { name: NAV_LABEL });
    await userEvent.click(within(nav).getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Settings page content')).toBeTruthy();
    expect(where(router).pathname).toBe('/admin/settings');
    expect(screen.getByRole('navigation', { name: NAV_LABEL })).toBeTruthy();
  });

  test('every nav link is at least 44px tall (min-h-tap) so a thumb can hit it', async () => {
    renderLayout(ready(adminSession));
    const nav = await screen.findByRole('navigation', { name: NAV_LABEL });
    for (const link of within(nav).getAllByRole('link')) {
      expect(Array.from(link.classList), link.textContent ?? '').toContain('min-h-tap');
    }
  });
});

// --- fail closed: loading, error, unreadable ---------------------------------------------------

describe('fail closed', () => {
  test('while the session is loading: a busy status, no admin content, no unauthorized page, no redirect', async () => {
    const { router } = renderLayout({ data: null, isPending: true, error: null, refetch: () => {} });
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/checking/i);
    await settle();
    noAdminContent();
    expect(screen.queryByRole('heading', { name: /administrators/i })).toBeNull();
    expect(where(router).pathname).toBe('/admin/drills');
  });

  test('a session that is still loading is not trusted even when stale admin data is attached', async () => {
    renderLayout({ data: adminSession, isPending: true, error: null, refetch: () => {} });
    await screen.findByRole('status');
    await settle();
    noAdminContent();
  });

  // Better Auth's session atom keeps the OLD data with isPending false while it refetches (isRefetching: true), e.g. right
  // after a sign-out or a sign-in on this tab. That data may belong to the previous person: it must never be acted on.
  const refetching = (data: unknown): SessionState => ({ data, isPending: false, isRefetching: true, error: null, refetch: () => {} });

  test('stale admin data while the session is refetching: the loading state, no nav, no page, no redirect', async () => {
    const { router } = renderLayout(refetching(adminSession));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/checking/i);
    await settle();
    noAdminContent();
    expect(screen.queryByRole('heading', { name: /administrators/i })).toBeNull();
    expect(where(router).pathname).toBe('/admin/drills');
  });

  test('stale anonymous data while the session is refetching does not redirect to sign-in', async () => {
    const { router } = renderLayout(refetching(sessionWith({ isAnonymous: true })));
    expect((await screen.findByRole('status')).textContent).toMatch(/checking/i);
    await settle();
    expect(where(router).pathname).toBe('/admin/drills');
    noAdminContent();
  });

  test.each([
    ['no session', null],
    ['a contributor', sessionWith({ role: 'contributor' })],
    ['an unreadable payload', {}],
  ])('stale data (%s) while refetching is the loading state: no redirect, no unauthorized page, no error', async (_name, data) => {
    const { router } = renderLayout(refetching(data));
    await screen.findByRole('status');
    await settle();
    expect(where(router).pathname).toBe('/admin/drills');
    expect(screen.queryByRole('heading', { name: /administrators/i })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    noAdminContent();
  });

  test('an error while refetching is still the loading state (a retry in flight), never admin content', async () => {
    renderLayout({ data: adminSession, isPending: false, isRefetching: true, error: new Error('x'), refetch: () => {} });
    await screen.findByRole('status');
    await settle();
    noAdminContent();
  });

  test('after the refetch settles with a non-admin (a different person signed in): the unauthorized page', async () => {
    const { store } = renderLayout(refetching(adminSession));
    await screen.findByRole('status');
    noAdminContent();
    await act(async () => {
      store.set(ready(sessionWith({ role: 'contributor' })));
    });
    expect(await screen.findByRole('heading', { level: 1, name: /administrators/i })).toBeTruthy();
    noAdminContent();
  });

  test('after the refetch settles with an admin: the admin area', async () => {
    const { store } = renderLayout(refetching(adminSession));
    await screen.findByRole('status');
    await act(async () => {
      store.set(ready(adminSession));
    });
    expect(await screen.findByRole('navigation', { name: NAV_LABEL })).toBeTruthy();
    expect(screen.getByText(CHILD_TEXT)).toBeTruthy();
  });

  test('after the refetch settles with no session (signed out on this tab): sign-in, carrying the page', async () => {
    const { router, store } = renderLayout(refetching(adminSession));
    await screen.findByRole('status');
    await act(async () => {
      store.set(ready(null));
    });
    await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'));
    expect(where(router).redirect).toBe('/admin/drills');
    noAdminContent();
  });

  test('when reading the session failed: an alert with a retry, no admin content, no redirect', async () => {
    const refetch = mock(() => {});
    const { router } = renderLayout({ data: null, isPending: false, error: new Error('network'), refetch });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeTruthy();
    await settle();
    noAdminContent();
    expect(where(router).pathname).toBe('/admin/drills');
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('an error wins over stale admin data: nothing of the admin area is shown', async () => {
    renderLayout({ data: adminSession, isPending: false, error: { status: 500 }, refetch: () => {} });
    await screen.findByRole('alert');
    noAdminContent();
  });

  test.each([
    ['an HTML string from a proxy', '<!doctype html><html></html>'],
    ['an empty object', {}],
    ['a session whose user is null', { user: null }],
    ['a session whose user is a string', { user: 'admin' }],
    ['a number', 1],
  ])('%s is an unreadable session: the error state, never the admin area', async (_name, data) => {
    renderLayout(ready(data));
    await screen.findByRole('alert');
    noAdminContent();
  });

  test('coming back from an error, a retry that finds an admin shows the admin area', async () => {
    const { store } = renderLayout({ data: null, isPending: false, error: new Error('network'), refetch: () => {} });
    await screen.findByRole('alert');
    await act(async () => {
      store.set(ready(adminSession));
    });
    expect(await screen.findByRole('navigation', { name: NAV_LABEL })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// --- the route itself is wired to the real session hook ---------------------------------------

describe('routes/admin/route.tsx', () => {
  // The route file is registered as /admin by the generated route tree; in a test that step is done by hand.
  function buildFileRouter(path: string) {
    return buildRouter(
      (root) =>
        (AdminRoute as unknown as { update(options: object): AnyRoute }).update({
          id: '/admin',
          path: '/admin',
          getParentRoute: () => root,
        }),
      path,
    );
  }

  // The app-wide Better Auth client captures the global fetch when lib/auth.ts is first imported (see lib/auth.test.ts), so a
  // stub installed here would not be used and an admin session cannot be served: the real hook's read fails (the test
  // environment has no API on the page origin), which is the OFFLINE branch of the beforeLoad guard (route-guard.ts §2.3) —
  // with nothing remembered on this device (no `fc:last-player`), that is a redirect, exactly like a clean "no session"
  // answer.
  //
  // UPDATED (auth-gate spec §2, P1): this test used to pin the gap the file's doc comment documented ("there is no
  // beforeLoad gate… a child route's own beforeLoad/loader still starts for a signed-out visitor"), so it mounted the route,
  // watched the layout's own render-time "checking access…" status appear, and only ever asserted the WEAKER "no admin
  // content" / "did not navigate to /admin/impact". `admin/route.tsx` now has `beforeLoad: requireAccount()`, so a
  // signed-out visitor is redirected to sign-in before the layout — and its "checking access…" status — ever renders at
  // all: the previous assertions were checking a state (`role="status"`) this route can no longer reach on a first visit.
  test('a signed-out visitor is redirected by beforeLoad, before the admin layout renders and before any /api/admin call', async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(typeof input === 'string' ? input : input.toString());
      return realFetch(input as never, init);
    }) as typeof fetch;
    try {
      const router = buildFileRouter('/admin/drills');
      mount(router, 'en');
      await waitFor(() => expect(where(router).pathname).toBe('/account/sign-in'), { timeout: 4000 });
      expect(where(router).redirect).toBe('/admin/drills');
      // The layout's own render-time "checking access…" status never appears: beforeLoad decided before it could mount.
      expect(screen.queryByRole('status')).toBeNull();
      noAdminContent();
      expect(calls.some((url) => url.includes('/api/admin'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// --- copy: kk / ru / en ------------------------------------------------------------------------

type Tree = { [key: string]: string | Tree };
function leaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`),
  );
}

describe('admin layout messages', () => {
  test('kk, ru and en carry exactly the same keys', () => {
    const shape = (locale: Locale) => leaves(messages[locale] as Tree).map(([key]) => key).sort();
    expect(shape('kk')).toEqual(shape('en'));
    expect(shape('ru')).toEqual(shape('en'));
  });

  test('no message is blank or a leftover placeholder', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(messages[locale] as Tree)) {
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(value, `${locale} ${key}`).not.toMatch(/todo|tbd|lorem|undefined/i);
      }
    }
  });

  test('the Kazakh and Russian messages are written in Cyrillic', () => {
    for (const locale of ['kk', 'ru'] as const) {
      for (const [key, value] of leaves(messages[locale] as Tree)) {
        expect(value, `${locale} ${key}`).toMatch(/\p{Script=Cyrillic}/u);
      }
    }
  });

  test.each([...LOCALES])('%s: the sub-navigation shows four different, non-empty labels', async (locale) => {
    renderLayout(ready(adminSession), { locale });
    const nav = await screen.findByRole('navigation');
    const labels = within(nav).getAllByRole('link').map((link) => (link.textContent ?? '').trim());
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/undefined|\./);
    }
    expect(nav.getAttribute('aria-label')?.trim().length ?? 0).toBeGreaterThan(0);
  });

  test.each([...LOCALES])('%s: the unauthorized page is worded, not blank and not a raw key', async (locale) => {
    renderLayout(ready(sessionWith({ role: 'contributor' })), { locale });
    const heading = await screen.findByRole('heading', { level: 1 });
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect((heading.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/undefined|admin-layout|unauthorized\.|\{\{/i);
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
  });

  test.each([...LOCALES])('%s: loading and error states are worded', async (locale) => {
    const first = renderLayout({ data: null, isPending: true, error: null, refetch: () => {} }, { locale });
    expect(((await screen.findByRole('status')).textContent ?? '').trim().length).toBeGreaterThan(0);
    first.unmount();
    renderLayout({ data: null, isPending: false, error: new Error('x'), refetch: () => {} }, { locale });
    const alert = await screen.findByRole('alert');
    expect((alert.textContent ?? '').replace(/\s+/g, ' ')).not.toMatch(/undefined|admin-layout|\{\{/i);
    expect(within(alert).getByRole('button').textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
