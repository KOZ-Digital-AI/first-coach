import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModerationQueueItem } from '@api-types/admin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route as QueueRoute } from '../../routes/admin/index';
import { AdminLayoutView } from '../../routes/admin/route';
import layoutMessages from './admin-layout.messages';
import queueMessages from './queue.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as impact.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * Contract under test (fc-ndo, a bug fix on fc-mol-0v3.8 / 0v3.9 / 0v3.10):
 *  - the admin layout's "Review queue" link goes to /admin, the route that serves the queue (it used to go to /admin/queue, which
 *    no route serves);
 *  - each queue row links to the dedicated review screen, /admin/contributions/<id> (fc-mol-0v3.10, merged, so the link is
 *    unconditional).
 * The nav stays accessible: the current page carries aria-current (and a check icon), labels are localised, the links are 44px
 * tall and keep their keyboard order.
 *
 * The real layout (AdminLayoutView, with a session handed in as in admin-layout.test.tsx) and the real queue route component run
 * inside a real memory-history router that has the routes the links point at; the only stand-in is the network (globalThis.fetch).
 *
 * Readings of the criteria (the simplest each time):
 * - The row's link is its TITLE (the h2 becomes a link): queue.messages.ts is not owned by this bead, so a new "open" string
 *   cannot be added, and the title needs none. The existing inline Review button of the row is unchanged.
 * - "Review queue" is current only on the queue page itself (/admin), not on the other admin pages nor on a review screen: /admin
 *   is a prefix of every admin URL, so this link must match exactly.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const SENT = '2026-09-01T09:00:00.000Z';

const queueItem = (id: string, state: string, name: string) =>
  ModerationQueueItem.parse({
    contribution: {
      id,
      state,
      payload: {
        kind: 'new',
        locale: 'en',
        name,
        sport: 'football',
        skill: 'dribbling-basics',
        ageMin: 8,
        ageMax: 12,
        level: 'beginner',
        goal: 'dribbling',
        instructions: 'Weave the ball through the cones.',
        durationMin: 10,
        equipment: 'cones',
        mistakes: '',
        progression: '',
        regression: '',
        safety: '',
        source: 'My own session',
        author: 'Aidar Coach',
      },
      attachments: [],
      createdAt: SENT,
      updatedAt: SENT,
    },
    submitter: { id: 'u-1', name: 'Aidar Coach' },
  });

const BY_STATE: Record<string, unknown[]> = {
  pending: [queueItem('c-new', 'pending', 'Cone slalom'), queueItem('c-imp', 'pending', 'Wall passes')],
  changes_requested: [],
  approved: [queueItem('c-approved', 'approved', 'Two-touch turns')],
  rejected: [],
};

const ADMIN_SESSION = {
  data: { user: { id: 'u-admin', name: 'Ada', role: 'admin', isAnonymous: false } },
  isPending: false,
  error: null,
  refetch: () => {},
};

const NAV_LABEL = 'Admin sections';
const REVIEW_BASE = '/admin/contributions/';

// --- the network and the window -----------------------------------------------------------------

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const body = url.pathname === '/api/admin/contributions' ? (BY_STATE[url.searchParams.get('state') ?? 'pending'] ?? []) : null;
    return new Response(JSON.stringify(body ?? { type: 'about:blank', title: 'Not Found', status: 404 }), {
      status: body === null ? 404 : 200,
      headers: { 'content-type': body === null ? 'application/problem+json' : 'application/json' },
    });
  }) as unknown as typeof fetch;
});

/*
 * Cross-file hygiene. bun runs every test file of the web package in ONE process with ONE happy-dom window, so whatever this
 * file leaves on the window/document is still there for the files that run after it. happy-dom records every element query it
 * has answered (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the document and on <html>
 * (`affectsCache`, `affectsComputedStyleCache`) and in the window's selector cache, and never trims them; a heavy file leaves
 * thousands of entries there and slows the files that run after it. After every test the DOM is empty, so the lists are emptied
 * the way happy-dom itself empties them when a node changes: every recorded result is invalidated first, then the list is
 * cleared. Written against happy-dom 20.x symbols by description; if they are not there it does nothing.
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

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './admin-layout.messages.ts': { default: layoutMessages },
  './queue.messages.ts': { default: queueMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

function ReviewStub() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <p>Review screen of {id}</p>;
}

/** The layout and the queue as the real route tree nests them: /admin (layout) > index (the queue), drills, contributions/$id. */
function renderAdmin(path: string, locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const root = createRootRoute({ component: Outlet });
  const layout = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    component: () => <AdminLayoutView session={ADMIN_SESSION} />,
  });
  const queue = createRoute({ getParentRoute: () => layout, path: '/', component: QueueRoute.options.component });
  const drills = createRoute({ getParentRoute: () => layout, path: 'drills', component: () => <p>Drills page content</p> });
  const review = createRoute({ getParentRoute: () => layout, path: 'contributions/$id', component: ReviewStub });
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([queue, drills, review])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const trimSlash = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname);
const nav = () => screen.findByRole('navigation', { name: NAV_LABEL });
const navLinks = () => within(screen.getByRole('navigation', { name: NAV_LABEL })).getAllByRole('link');
const currentLinks = () => navLinks().filter((link) => link.getAttribute('aria-current') === 'page');
const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
/** The list item (row) of the contribution named `name`. */
const row = (name: string): HTMLElement => {
  const found = screen.getByRole('heading', { level: 2, name }).closest('li');
  if (found === null) throw new Error(`no row for "${name}"`);
  return found;
};
const rowLink = (name: string) => within(row(name)).getByRole('link', { name }) as HTMLAnchorElement;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

// --- the nav link -------------------------------------------------------------------------------

describe('the admin nav: Review queue', () => {
  test('is the first link and goes to /admin, the route that serves the queue', async () => {
    renderAdmin('/admin/drills');
    await nav();
    const first = navLinks()[0]!;
    expect(text(first)).toBe('Review queue');
    expect(first.getAttribute('href')).toBe('/admin');
    // The other three keep their own pages.
    expect(navLinks().map((link) => link.getAttribute('href'))).toEqual(['/admin', '/admin/drills', '/admin/impact', '/admin/settings']);
    expect(navLinks().some((link) => link.getAttribute('href') === '/admin/queue')).toBe(false);
  });

  test('following it from another admin page lands on the queue itself', async () => {
    const user = userEvent.setup();
    const { router } = renderAdmin('/admin/drills');
    await nav();
    expect(await screen.findByText('Drills page content')).toBeTruthy();

    await user.click(within(screen.getByRole('navigation', { name: NAV_LABEL })).getByRole('link', { name: 'Review queue' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Review queue' })).toBeTruthy();
    expect(trimSlash(router.history.location.pathname)).toBe('/admin');
    expect(screen.queryByText('Drills page content') === null).toBe(true);
    // The layout stays around the page it navigated to.
    expect(screen.getByRole('navigation', { name: NAV_LABEL }) === null).toBe(false);
  });

  test('is marked current (aria-current and a check icon) on the queue page', async () => {
    renderAdmin('/admin');
    await nav();
    await screen.findByRole('heading', { level: 1, name: 'Review queue' });
    expect(currentLinks().map(text)).toEqual(['Review queue']);
    expect(currentLinks()[0]?.querySelector('svg') === null).toBe(false);
  });

  test('is not marked current on another admin page (/admin is a prefix of every admin URL)', async () => {
    renderAdmin('/admin/drills');
    await nav();
    expect(currentLinks().map(text)).toEqual(['Drills']);
    const queueLink = navLinks()[0]!;
    expect(queueLink.getAttribute('aria-current')).toBeNull();
    expect(queueLink.querySelector('svg') === null).toBe(true);
  });

  test('is not marked current on a review screen either (that page is not the queue)', async () => {
    renderAdmin(`${REVIEW_BASE}c-new`);
    await screen.findByText('Review screen of c-new');
    expect(currentLinks().map(text)).toEqual([]);
  });

  test('keeps the four links in keyboard order and reachable with Tab', async () => {
    const user = userEvent.setup();
    renderAdmin('/admin/drills');
    await nav();
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      seen.push(text(document.activeElement!));
    }
    expect(seen).toEqual(['Review queue', 'Drills', 'Impact', 'Settings']);
  });

  test('can be followed with the keyboard (Enter)', async () => {
    const user = userEvent.setup();
    const { router } = renderAdmin('/admin/drills');
    await nav();
    await user.tab();
    expect(text(document.activeElement!)).toBe('Review queue');
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { level: 1, name: 'Review queue' });
    expect(trimSlash(router.history.location.pathname)).toBe('/admin');
  });

  test('is still 44px tall (min-h-tap)', async () => {
    renderAdmin('/admin/drills');
    await nav();
    expect(Array.from(navLinks()[0]!.classList)).toContain('min-h-tap');
  });

  for (const locale of LOCALES) {
    test(`says its own word in ${locale} (never a raw key) and goes to the same place`, async () => {
      renderAdmin('/admin/drills', locale);
      await screen.findByRole('navigation', { name: layoutMessages[locale].navLabel });
      const first = navLinks()[0]!;
      expect(text(first)).toBe(layoutMessages[locale].reviewQueue);
      expect(text(first)).not.toContain('reviewQueue');
      expect(first.getAttribute('href')).toBe('/admin');
    });
  }
});

// --- the rows -----------------------------------------------------------------------------------

describe('the queue rows', () => {
  test('each row links to /admin/contributions/<its own id>, named for the contribution', async () => {
    renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    expect(rowLink('Cone slalom').getAttribute('href')).toBe(`${REVIEW_BASE}c-new`);
    expect(rowLink('Wall passes').getAttribute('href')).toBe(`${REVIEW_BASE}c-imp`);
  });

  test('the link sits in the row heading, so the list still reads as titles and each row still has its Review button', async () => {
    renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    const titles = screen.getAllByRole('heading', { level: 2 }).map(text);
    expect(titles).toEqual(['Cone slalom', 'Wall passes']);
    for (const name of titles) {
      expect(within(row(name)).getByRole('heading', { level: 2 }).contains(rowLink(name))).toBe(true);
      expect(within(row(name)).getByRole('button', { name: `Review “${name}”` }) === null).toBe(false);
    }
  });

  test('rows of every tab link the same way (a decided contribution too)', async () => {
    const user = userEvent.setup();
    renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    await user.click(screen.getByRole('tab', { name: 'Approved' }));
    await screen.findByRole('heading', { level: 2, name: 'Two-touch turns' });
    expect(rowLink('Two-touch turns').getAttribute('href')).toBe(`${REVIEW_BASE}c-approved`);
  });

  test('following a row link opens the review screen of that contribution, inside the admin layout', async () => {
    const user = userEvent.setup();
    const { router } = renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    await user.click(rowLink('Wall passes'));
    expect(await screen.findByText('Review screen of c-imp')).toBeTruthy();
    expect(router.history.location.pathname).toBe(`${REVIEW_BASE}c-imp`);
    expect(screen.getByRole('navigation', { name: NAV_LABEL }) === null).toBe(false);
  });

  test('the link can be reached and followed with the keyboard', async () => {
    const user = userEvent.setup();
    const { router } = renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    rowLink('Cone slalom').focus();
    expect(document.activeElement === rowLink('Cone slalom')).toBe(true);
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Review screen of c-new')).toBeTruthy();
    expect(router.history.location.pathname).toBe(`${REVIEW_BASE}c-new`);
  });

  test('the link is at least 44px tall (min-h-tap) and is underlined, so it is never told apart by colour alone', async () => {
    renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    const classes = Array.from(rowLink('Cone slalom').classList);
    expect(classes).toContain('min-h-tap');
    expect(classes).toContain('underline');
  });

  test('the inline Review button still opens the review in place, with no navigation', async () => {
    const user = userEvent.setup();
    const { router } = renderAdmin('/admin');
    await screen.findByRole('list', { name: queueMessages.en.list });
    await user.click(within(row('Cone slalom')).getByRole('button', { name: 'Review “Cone slalom”' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Cone slalom' })).toBeTruthy();
    await settle();
    expect(trimSlash(router.history.location.pathname)).toBe('/admin');
  });

  for (const locale of ['kk', 'ru'] as const) {
    test(`a row link exists in ${locale} and goes to the same review screen`, async () => {
      renderAdmin('/admin', locale);
      await screen.findByRole('list', { name: queueMessages[locale].list });
      await waitFor(() => expect(rowLink('Cone slalom').getAttribute('href')).toBe(`${REVIEW_BASE}c-new`));
    });
  }
});
