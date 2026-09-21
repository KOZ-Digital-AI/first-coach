import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import { collectSlot } from '../../lib/slots';
import * as headerModule from './header-extra';
import { AccountControls, type AccountDeps, type AccountSessionState } from './header-extra';
import accountMessages from './account.messages';
import { ApiProblem, notifyUnauthorized } from '../../lib/problem';
import { beginSignOut, clearDrafts, installSessionExpired, registerDraft, resetSessionExpired } from './session-expired';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported when there is no DOM (same rule and guard as features/shell/shell.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

afterEach(() => {
  cleanup();
  globalThis.sessionStorage?.clear();
  globalThis.localStorage?.clear();
});

// --- sessions (the shape of Better Auth's useSession() payload) --------------------------------------------------------

const anonymous: AccountSessionState = { data: { user: { id: 'anon-1', isAnonymous: true } } };
const noSession: AccountSessionState = { data: null };
const pending: AccountSessionState = { data: null, isPending: true };
const coach: AccountSessionState = {
  data: { user: { id: 'coach-1', name: 'Aigerim Sadykova', email: 'aigerim@example.kz', isAnonymous: false, role: 'user' } },
};
const admin: AccountSessionState = {
  data: { user: { id: 'admin-1', name: 'Dana Admin', email: 'dana@example.kz', isAnonymous: false, role: 'admin' } },
};
const withUser = (user: Record<string, unknown>): AccountSessionState => ({ data: { user: { id: 'u', ...user } } });

// --- rig -----------------------------------------------------------------------------------------------------------------

const noStorage = { getItem: () => null, setItem: () => {} };
const ROUTES = ['/', '/train', '/contribute', '/admin', '/account/sign-in'];

interface Rig {
  log: string[];
  queryClient: QueryClient;
  setSession(next: AccountSessionState): void;
  pathname(): string;
}

interface RigOptions {
  session?: AccountSessionState;
  locale?: Locale;
  path?: string;
  deps?: Partial<AccountDeps>;
  queryClient?: QueryClient;
}

/** A real router (memory history), a real QueryClient and real i18n; only the network sign-out is a stand-in. */
async function renderAccount({ session = coach, locale = 'en', path = '/train', deps = {}, queryClient }: RigOptions = {}): Promise<Rig> {
  const log: string[] = [];
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const allDeps: AccountDeps = {
    signOut: async () => {
      log.push('signOut');
      return { data: { success: true }, error: null };
    },
    beginSignOut: () => void log.push('beginSignOut'),
    resetPlayerSession: () => void log.push('resetPlayerSession'),
    clearDrafts: () => void log.push('clearDrafts'),
    resetSessionExpired: () => void log.push('resetSessionExpired'),
    ...deps,
  };
  const instance = createI18n({
    modules: { './account.messages.ts': { default: accountMessages } },
    languages: [locale],
    storage: noStorage,
    root: { lang: '' },
    dev: false,
  });

  let setSession: (next: AccountSessionState) => void = () => {};
  function Harness() {
    const [current, set] = useState<AccountSessionState>(session);
    setSession = set;
    return (
      <>
        <header>
          <AccountControls session={current} deps={allDeps} />
        </header>
        <Outlet />
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Harness });
  const children = ROUTES.map((routePath) =>
    createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => <p>page {routePath}</p> }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('banner');
  return {
    log,
    queryClient: client,
    setSession: (next) => act(() => setSession(next)),
    pathname: () => router.state.location.pathname,
  };
}

const header = () => within(screen.getByRole('banner'));
const trigger = (name: string | RegExp) => header().getByRole('button', { name });
const signOutButton = () => screen.getByRole('button', { name: /^sign(ing)? out/i });
/** What a successful sign-out does after the server said yes, in order; re-arming the handler comes last, after the navigation. */
const AFTER_CONFIRMED = ['resetPlayerSession', 'clearDrafts', 'resetSessionExpired'];

async function openMenu(name: string | RegExp = /Aigerim/) {
  fireEvent.click(trigger(name));
  await waitFor(() => expect(trigger(name).getAttribute('aria-expanded')).toBe('true'));
}

/** A promise settled from outside, to hold sign-out (or a query) in flight. */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function seedCaches(queryClient: QueryClient) {
  queryClient.setQueryData(['me'], { name: 'Aigerim' });
  queryClient.setQueryData(['journey'], { sessions: 12 });
  queryClient.setQueryData(['admin', 'queue'], [{ id: 'c-1' }]);
}

// --- who sees what -------------------------------------------------------------------------------------------------------

describe('anonymous players', () => {
  test('see only a discreet "Coach sign-in" link to the sign-in page, and no menu', async () => {
    await renderAccount({ session: anonymous });
    const link = header().getByRole('link', { name: 'Coach sign-in' });
    expect(link.getAttribute('href')).toBe('/account/sign-in');
    expect(header().queryByRole('button')).toBeNull();
    expect(header().getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText(/sign out/i)).toBeNull();
    expect(screen.queryByText(/my contributions/i)).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
  });

  test('no session at all (the silent sign-in has not landed) shows the same single link', async () => {
    await renderAccount({ session: noSession });
    expect(header().getByRole('link', { name: 'Coach sign-in' }).getAttribute('href')).toBe('/account/sign-in');
    expect(header().queryByRole('button')).toBeNull();
  });

  test('an anonymous user is never given the menu, even one carrying the admin role', async () => {
    await renderAccount({ session: withUser({ isAnonymous: true, role: 'admin', name: 'Ghost' }) });
    expect(header().queryByRole('button')).toBeNull();
    expect(screen.queryByText('Ghost')).toBeNull();
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
  });

  test('only an explicit isAnonymous === false is an account: a missing flag is not', async () => {
    await renderAccount({ session: withUser({ role: 'admin', name: 'Unflagged' }) });
    expect(header().queryByRole('button')).toBeNull();
    expect(screen.queryByText('Unflagged')).toBeNull();
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
  });

  test('an unreadable session payload is not an account', async () => {
    await renderAccount({ session: { data: '<html>proxy error</html>' } });
    expect(header().queryByRole('button')).toBeNull();
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
  });
});

describe('while the session is loading', () => {
  test('nothing is drawn: no sign-in link that a signed-in coach would then lose, and no menu', async () => {
    await renderAccount({ session: pending });
    expect(header().queryByRole('link')).toBeNull();
    expect(header().queryByRole('button')).toBeNull();
  });

  test('the link appears once loading ends without an account', async () => {
    const rig = await renderAccount({ session: pending });
    await rig.setSession(anonymous);
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
  });
});

describe('while the session is being re-read (isRefetching)', () => {
  // Better Auth keeps the previous payload while it refetches, so that payload can belong to the person who just left.
  test('a coach payload that is being re-read is not shown: no name, no Admin, no sign-in link; the controls return afterwards', async () => {
    const rig = await renderAccount({ session: { ...admin, isRefetching: true } });
    expect(header().queryByRole('button')).toBeNull();
    expect(header().queryByRole('link')).toBeNull();
    expect(screen.queryByText(/Dana/)).toBeNull();
    await rig.setSession(admin);
    await openMenu(/Dana/);
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
  });

  test('an open menu, its Admin item included, goes away while the re-read runs', async () => {
    const rig = await renderAccount({ session: admin });
    await openMenu(/Dana/);
    await rig.setSession({ ...admin, isRefetching: true });
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/Dana/)).toBeNull();
  });

  test('a re-read that ends with an anonymous session shows the sign-in link', async () => {
    const rig = await renderAccount({ session: { ...coach, isRefetching: true } });
    await rig.setSession(anonymous);
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
  });
});

describe('signed-in coach', () => {
  test('sees the display name on a menu button that is collapsed until pressed, and no sign-in link', async () => {
    await renderAccount({ session: coach });
    const button = trigger(/Aigerim Sadykova/);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(header().queryByRole('link', { name: 'Coach sign-in' })).toBeNull();
    expect(screen.queryByRole('link', { name: /my contributions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  test('the menu lists My contributions and Sign out, and no Admin item', async () => {
    await renderAccount({ session: coach });
    await openMenu();
    expect(trigger(/Aigerim/).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'My contributions' }).getAttribute('href')).toBe('/contribute');
    expect(signOutButton().textContent).toContain('Sign out');
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  test('the menu button is tied to its panel (aria-controls) and the panel is a plain disclosure, not a role=menu', async () => {
    await renderAccount({ session: coach });
    await openMenu();
    const controls = trigger(/Aigerim/).getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const panel = document.getElementById(controls as string);
    expect(panel).not.toBeNull();
    expect(panel?.contains(signOutButton())).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a comma-separated role list without an exact "admin" is not an admin', async () => {
    await renderAccount({ session: withUser({ isAnonymous: false, name: 'Almas', role: 'superadmin,coach' }) });
    await openMenu(/Almas/);
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  test('falls back to the email, then to a plain "Account", when there is no name', async () => {
    await renderAccount({ session: withUser({ isAnonymous: false, name: '  ', email: 'only-mail@example.kz' }) });
    expect(trigger(/only-mail@example.kz/)).toBeTruthy();
    cleanup();
    await renderAccount({ session: withUser({ isAnonymous: false }) });
    expect(trigger(/Account/)).toBeTruthy();
  });
});

describe('signed-in admin', () => {
  test('sees the same menu plus an Admin item that goes to /admin', async () => {
    await renderAccount({ session: admin });
    await openMenu(/Dana Admin/);
    expect(screen.getByRole('link', { name: 'Admin' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: 'My contributions' })).toBeTruthy();
    expect(signOutButton()).toBeTruthy();
  });

  test('admin among several roles still counts', async () => {
    await renderAccount({ session: withUser({ isAnonymous: false, name: 'Multi', role: 'coach,admin' }) });
    await openMenu(/Multi/);
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
  });
});

// --- menu behaviour and accessibility ------------------------------------------------------------------------------------

describe('menu behaviour', () => {
  test('Escape closes the menu and puts focus back on the menu button', async () => {
    await renderAccount({ session: coach });
    await openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('link', { name: /my contributions/i })).toBeNull());
    expect(trigger(/Aigerim/).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(/Aigerim/));
  });

  test('a press outside the menu closes it', async () => {
    await renderAccount({ session: coach });
    await openMenu();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('link', { name: /my contributions/i })).toBeNull());
  });

  test('pressing the menu button again closes it', async () => {
    await renderAccount({ session: coach });
    await openMenu();
    fireEvent.click(trigger(/Aigerim/));
    expect(screen.queryByRole('link', { name: /my contributions/i })).toBeNull();
  });

  test('choosing My contributions navigates there and closes the menu', async () => {
    const rig = await renderAccount({ session: coach });
    await openMenu();
    fireEvent.click(screen.getByRole('link', { name: 'My contributions' }));
    await waitFor(() => expect(rig.pathname()).toBe('/contribute'));
    expect(screen.queryByRole('link', { name: /my contributions/i })).toBeNull();
  });

  test('every control is at least 44px tall (the min-h-tap token), and none is a bare icon', async () => {
    await renderAccount({ session: admin });
    await openMenu(/Dana/);
    for (const element of [trigger(/Dana/), screen.getByRole('link', { name: 'My contributions' }), screen.getByRole('link', { name: 'Admin' }), signOutButton()]) {
      expect(element.className).toContain('min-h-tap');
      expect((element.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
    cleanup();
    await renderAccount({ session: anonymous });
    expect(header().getByRole('link', { name: 'Coach sign-in' }).className).toContain('min-h-tap');
  });
});

// --- sign out ------------------------------------------------------------------------------------------------------------

describe('sign out', () => {
  test('ends the session, resets the player memo, clears drafts, re-arms the expiry handler, and only after the server said yes', async () => {
    const held = gate<{ data: unknown; error: unknown }>();
    const log: string[] = [];
    const rig = await renderAccount({
      session: coach,
      deps: {
        beginSignOut: () => void log.push('beginSignOut'),
        signOut: () => {
          log.push('signOut');
          return held.promise;
        },
        resetPlayerSession: () => void log.push('resetPlayerSession'),
        clearDrafts: () => void log.push('clearDrafts'),
        resetSessionExpired: () => void log.push('resetSessionExpired'),
      },
    });
    await openMenu();
    fireEvent.click(signOutButton());
    // The expiry handler is switched off BEFORE the request goes out, and nothing else has run while the server may still refuse.
    await waitFor(() => expect(log).toEqual(['beginSignOut', 'signOut']));
    expect(rig.pathname()).toBe('/train');
    await act(async () => held.resolve({ data: { success: true }, error: null }));
    await waitFor(() => expect(log).toEqual(['beginSignOut', 'signOut', ...AFTER_CONFIRMED]));
    await waitFor(() => expect(rig.pathname()).toBe('/'));
  });

  test('re-arms the expiry handler only once the navigation home has landed and the cache is empty', async () => {
    const queryClient = new QueryClient();
    seedCaches(queryClient);
    const seen: { path: string; cached: number }[] = [];
    const rig = await renderAccount({
      session: coach,
      queryClient,
      deps: {
        resetSessionExpired: () => {
          seen.push({ path: rig.pathname(), cached: queryClient.getQueryCache().getAll().length });
        },
      },
    });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ path: '/', cached: 0 });
  });

  test('empties the query cache of everything the coach loaded (nothing of the previous user stays)', async () => {
    const queryClient = new QueryClient();
    seedCaches(queryClient);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(3);
    await renderAccount({ session: coach, queryClient });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
    expect(queryClient.getQueryData(['admin', 'queue'])).toBeUndefined();
  });

  test('a request still in flight when the coach signs out cannot put their data back into the cache', async () => {
    const queryClient = new QueryClient();
    const slow = gate<{ secret: string }>();
    const running = queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => slow.promise }).catch(() => undefined);
    await renderAccount({ session: coach, queryClient });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
    slow.resolve({ secret: 'previous coach data' });
    await running;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll().filter((q) => q.state.data !== undefined)).toHaveLength(0);
  });

  test('returns home', async () => {
    const rig = await renderAccount({ session: admin, path: '/admin' });
    expect(rig.pathname()).toBe('/admin');
    await openMenu(/Dana/);
    fireEvent.click(signOutButton());
    await waitFor(() => expect(rig.pathname()).toBe('/'));
  });

  test('clears the unsent drafts in sessionStorage but leaves the device\'s anonymous player data alone', async () => {
    sessionStorage.setItem('fc:draft:contribute-form', JSON.stringify({ savedAt: Date.now(), value: { name: 'Half-typed' } }));
    sessionStorage.setItem('unrelated', 'kept');
    localStorage.setItem('fc:anon-player-9:outbox', '[{"kind":"session"}]');
    localStorage.setItem('fc:lang', 'kk');
    const rig = await renderAccount({ session: coach, deps: { clearDrafts } });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(rig.pathname()).toBe('/'));
    expect(sessionStorage.getItem('fc:draft:contribute-form')).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
    expect(localStorage.getItem('fc:anon-player-9:outbox')).toBe('[{"kind":"session"}]');
    expect(localStorage.getItem('fc:lang')).toBe('kk');
  });

  test('while it runs the button says so, ignores a second press, and the server is asked once', async () => {
    const held = gate<{ data: unknown; error: unknown }>();
    let asked = 0;
    await renderAccount({
      session: coach,
      deps: {
        signOut: () => {
          asked += 1;
          return held.promise;
        },
      },
    });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(signOutButton().getAttribute('aria-disabled')).toBe('true'));
    expect(signOutButton().textContent).toContain('Signing out');
    fireEvent.click(signOutButton());
    fireEvent.click(signOutButton());
    expect(asked).toBe(1);
    await act(async () => held.resolve({ data: { success: true }, error: null }));
  });

  test('after success the controls of the previous user are hidden until the session is re-read, then follow the new session', async () => {
    const rig = await renderAccount({ session: coach });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(rig.pathname()).toBe('/'));
    // The session hook still holds the previous user's payload (a refetch is in flight): their name must not show.
    expect(screen.queryByText(/Aigerim/)).toBeNull();
    expect(header().queryByRole('button')).toBeNull();
    // The re-read lands: a fresh anonymous session -> the sign-in link.
    await rig.setSession(anonymous);
    expect(header().getByRole('link', { name: 'Coach sign-in' })).toBeTruthy();
    // The same coach signs in again later: the menu returns.
    await rig.setSession(coach);
    expect(trigger(/Aigerim/)).toBeTruthy();
  });

  test('a failing cleanup step neither hides the others nor keeps the coach on the page', async () => {
    const queryClient = new QueryClient();
    seedCaches(queryClient);
    const log: string[] = [];
    const rig = await renderAccount({
      session: coach,
      queryClient,
      deps: {
        beginSignOut: () => {
          log.push('beginSignOut');
          throw new Error('registry exploded');
        },
        resetPlayerSession: () => {
          log.push('resetPlayerSession');
          throw new Error('memo exploded');
        },
        clearDrafts: () => {
          log.push('clearDrafts');
          throw new Error('storage blocked');
        },
        resetSessionExpired: () => void log.push('resetSessionExpired'),
      },
    });
    await openMenu();
    fireEvent.click(signOutButton());
    await waitFor(() => expect(rig.pathname()).toBe('/'));
    expect(log).toEqual(['beginSignOut', 'resetPlayerSession', 'clearDrafts', 'resetSessionExpired']);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('sign out against the real session-expired handler', () => {
  const unauthorized = () => new ApiProblem({ kind: 'unauthorized', status: 401 });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const savedDrafts = () => Object.keys(sessionStorage).filter((key) => key.startsWith('fc:draft:'));

  /** A handler for a coach-area page, installed the way the app does, with its side effects observable. */
  function installHandler() {
    const navigations: string[] = [];
    const off = installSessionExpired({
      location: () => ({ pathname: '/admin' }),
      navigate: (url) => void navigations.push(url),
      notify: () => {},
      storage: sessionStorage,
      session: { ensure: async () => ({}), reset: () => {} },
    });
    const unregister = registerDraft('contribute-form', () => ({ name: 'half typed' }));
    return {
      navigations,
      stop: () => {
        unregister();
        off();
        resetSessionExpired();
      },
    };
  }

  test('a coach-area 401 that comes back while the request is in flight does not redirect, and no draft is saved for the next person', async () => {
    const handler = installHandler();
    try {
      const held = gate<{ data: unknown; error: unknown }>();
      await renderAccount({ session: coach, deps: { beginSignOut, resetSessionExpired, signOut: () => held.promise } });
      await openMenu();
      fireEvent.click(signOutButton());
      await waitFor(() => expect(signOutButton().getAttribute('aria-disabled')).toBe('true'));

      notifyUnauthorized(unauthorized());
      await tick();

      expect(handler.navigations).toEqual([]);
      expect(savedDrafts()).toEqual([]);
      await act(async () => held.resolve({ data: { success: true }, error: null }));
    } finally {
      handler.stop();
    }
  });

  test('a 401 caused by the cache being cleared does not redirect either, and the handler is armed again afterwards', async () => {
    const handler = installHandler();
    try {
      const queryClient = new QueryClient();
      seedCaches(queryClient);
      const rig = await renderAccount({
        session: coach,
        queryClient,
        deps: {
          beginSignOut,
          resetSessionExpired,
          // runs after the server confirmed and before the navigation home has landed: where refetch 401s would arrive
          clearDrafts: () => {
            clearDrafts();
            notifyUnauthorized(unauthorized());
          },
        },
      });
      await openMenu();
      fireEvent.click(signOutButton());
      await waitFor(() => expect(rig.pathname()).toBe('/'));
      await tick();
      expect(handler.navigations).toEqual([]);
      expect(savedDrafts()).toEqual([]);
      await tick();

      // Re-armed after the navigation: a later coach-area expiry redirects again.
      notifyUnauthorized(unauthorized());
      await tick();
      expect(handler.navigations).toEqual(['/account/sign-in?redirect=%2Fadmin']);
    } finally {
      handler.stop();
    }
  });

  test('when the server refuses to sign out, the expiry redirect works again', async () => {
    const handler = installHandler();
    try {
      await renderAccount({
        session: coach,
        deps: { beginSignOut, resetSessionExpired, signOut: async () => ({ data: null, error: { status: 500 } }) },
      });
      await openMenu();
      fireEvent.click(signOutButton());
      await screen.findByRole('alert');

      notifyUnauthorized(unauthorized());
      await tick();

      expect(handler.navigations).toEqual(['/account/sign-in?redirect=%2Fadmin']);
    } finally {
      handler.stop();
    }
  });
});

describe('sign out that fails', () => {
  for (const [label, failing] of [
    ['answers with an error', async () => ({ data: null, error: { status: 500, message: 'boom' } })],
    ['rejects (offline)', async () => Promise.reject(new TypeError('Failed to fetch'))],
  ] as const) {
    test(`when the server ${label}: says so in words, keeps everything as it was, and can be retried`, async () => {
      const queryClient = new QueryClient();
      seedCaches(queryClient);
      sessionStorage.setItem('fc:draft:contribute-form', JSON.stringify({ savedAt: Date.now(), value: 1 }));
      let fail = true;
      const rig = await renderAccount({
        session: coach,
        queryClient,
        deps: {
          signOut: async () => {
            rig.log.push('signOut');
            return fail ? failing() : { data: { success: true }, error: null };
          },
        },
      });
      await openMenu();
      fireEvent.click(signOutButton());
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/could not sign out/i);
      // The session is still there, so the expiry redirect must keep working: the handler is re-armed, and nothing else is undone.
      expect(rig.log).toEqual(['beginSignOut', 'signOut', 'resetSessionExpired']);
      expect(rig.pathname()).toBe('/train');
      expect(queryClient.getQueryCache().getAll()).toHaveLength(3);
      expect(sessionStorage.getItem('fc:draft:contribute-form')).not.toBeNull();
      // still signed in, and the button is usable again
      expect(trigger(/Aigerim/)).toBeTruthy();
      expect(signOutButton().getAttribute('aria-disabled')).not.toBe('true');

      fail = false;
      fireEvent.click(signOutButton());
      await waitFor(() => expect(rig.pathname()).toBe('/'));
      expect(rig.log.slice(3)).toEqual(['beginSignOut', 'signOut', ...AFTER_CONFIRMED]);
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
  }
});

// --- languages -----------------------------------------------------------------------------------------------------------

describe('languages', () => {
  const LOCALE_LIST: readonly Locale[] = ['kk', 'ru', 'en'];

  test('the three bundles carry the same keys, all non-empty strings', () => {
    const keysOf = (tree: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value as Record<string, unknown>, `${prefix}${key}.`),
      );
    const reference = keysOf(accountMessages.en).sort();
    expect(reference.length).toBeGreaterThan(5);
    for (const locale of LOCALE_LIST) {
      expect(keysOf(accountMessages[locale]).sort()).toEqual(reference);
      for (const key of reference) {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], accountMessages[locale]);
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
      }
    }
  });

  for (const locale of ['kk', 'ru'] as const) {
    test(`the anonymous link and the menu are written in ${locale}, not English`, async () => {
      const messages = accountMessages[locale];
      await renderAccount({ session: anonymous, locale });
      expect(header().getByRole('link', { name: messages.coachSignIn })).toBeTruthy();
      expect(messages.coachSignIn).not.toBe(accountMessages.en.coachSignIn);
      cleanup();

      await renderAccount({ session: admin, locale });
      await openMenu(/Dana/);
      expect(screen.getByRole('link', { name: messages.myContributions })).toBeTruthy();
      expect(screen.getByRole('link', { name: messages.admin })).toBeTruthy();
      expect(screen.getByRole('button', { name: messages.signOut })).toBeTruthy();
      expect(messages.myContributions).not.toBe(accountMessages.en.myContributions);
      expect(messages.signOut).not.toBe(accountMessages.en.signOut);
    });
  }
});

// --- the header slot -----------------------------------------------------------------------------------------------------

describe('header slot', () => {
  test('features/account/header-extra.tsx default-exports a component that the slot registry collects', () => {
    const collected = collectSlot({ header: { '../features/account/header-extra.tsx': headerModule as Record<string, unknown> } }, 'header');
    expect(collected).toHaveLength(1);
    expect(collected[0]).toBe(headerModule.default);
  });
});
