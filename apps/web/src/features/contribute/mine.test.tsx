import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Contribution } from '@api-types/contributions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/contribute/mine';
import messages from './mine.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as impact.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Contract under test (fc-mol-70i.9): /contribute/mine lists the coach's contributions from GET /api/contributions/mine
 * (Contribution[], apps/api/src/shared/contributions.ts) with a state tag (pending, changes requested, approved, rejected,
 * withdrawn), the reviewer's note, a link to the published drill when approved, "Edit and resubmit" for changes-requested items and
 * "Withdraw" (behind a confirm dialog, DELETE /api/contributions/:id) for undecided ones. The screen has loading, empty, error,
 * disabled and success states, its mutation buttons are disabled while a request is in flight, and every string exists in kk, ru
 * and en. An anonymous player is not a contributor: the API answers 403, and the screen sends them to sign-in with a return path.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query inside a real (memory-history) router; the only
 * stand-in is the network (globalThis.fetch). Fixtures are parsed with the shared contract schema, so they cannot drift from it.
 * Kazakh and Russian copy still needs a native-speaker review: for those locales these tests pin only that text exists, is
 * Cyrillic and never leaks 'undefined', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "undecided ones" = the states the API lets the owner withdraw from: pending and changes_requested.
 * - "Edit and resubmit" is a link to the contribute form with the id: /contribute?edit=<id> (the form belongs to another bead).
 * - The list keeps the order the API sends (newest first).
 * - "mutation buttons are disabled while a request is in flight": while a withdrawal runs, every Withdraw button, both dialog
 *   buttons and Refresh are disabled, and the dialog cannot be dismissed.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const SENT = '2026-09-01T09:00:00.000Z';
const UPDATED = '2026-09-03T09:00:00.000Z';

const contribution = (id: string, state: Contribution['state'], name: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  Contribution.parse({
    id,
    state,
    payload: {
      kind: 'new',
      locale: 'en',
      name,
      sport: 'football',
      skill: 'passing-basics',
      ageMin: 8,
      ageMax: 12,
      level: 'beginner',
      goal: 'passing',
      instructions: 'Pass to a partner.',
      durationMin: 10,
      equipment: 'ball',
      mistakes: '',
      progression: '',
      regression: '',
      safety: '',
      source: 'My own session',
      author: 'Aidar Coach',
      ...payload,
    },
    attachments: [],
    createdAt: SENT,
    updatedAt: UPDATED,
    ...extra,
  });

const PENDING = contribution('c-pending', 'pending', 'Wall passes', {}, { kind: 'improvement', targetDrillSlug: 'wall-passes-basic' });
const CHANGES = contribution('c-changes', 'changes_requested', 'Cone slalom', { reviewerNote: 'Please add a safety note for the cones.' });
const APPROVED = contribution('c-approved', 'approved', 'Two-touch turns', { reviewerNote: 'Thanks, this is published.', resultingDrillSlug: 'two-touch-turns' });
const REJECTED = contribution('c-rejected', 'rejected', 'Sprint relay', { reviewerNote: 'This is a fitness drill without a ball.' });
const WITHDRAWN = contribution('c-withdrawn', 'withdrawn', 'Old idea');

/** The order the API sends: newest first. */
const ITEMS = [PENDING, CHANGES, APPROVED, REJECTED, WITHDRAWN];

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors: [] }, { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
type Answer = () => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

/** Every request the screen makes lands in `calls` and is answered by `handler`. */
function stubNetwork(handler: Handler): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const MINE_PATH = '/api/contributions/mine';
const listCalls = () => calls.filter((call) => call.url.pathname === MINE_PATH);
const deleteCalls = () => calls.filter((call) => call.init?.method === 'DELETE');

/**
 * `list`: answers to GET /api/contributions/mine, one per call (the last repeats). `del`: answers to DELETE
 * /api/contributions/:id, one per call (the last repeats). Anything else is a 404.
 */
function serve({ list = [() => json(ITEMS)], del = [] }: { list?: Answer[]; del?: Answer[] } = {}): void {
  let listed = 0;
  let deleted = 0;
  stubNetwork((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === MINE_PATH && method === 'GET') {
      const next = list[Math.min(listed, list.length - 1)]!;
      listed += 1;
      return next();
    }
    if (url.pathname.startsWith('/api/contributions/') && method === 'DELETE' && del.length > 0) {
      const next = del[Math.min(deleted, del.length - 1)]!;
      deleted += 1;
      return next();
    }
    return problem(404, 'Not Found');
  });
}

/** A response the test releases by hand, to hold a request in flight. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
}

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.history.pushState({}, '', '/');
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './mine.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The real route component inside a real (memory) router that also knows the screens it links to. */
function renderMine(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const mineRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contribute/mine', component: Route.options.component });
  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account/sign-in',
    validateSearch: (search: Record<string, unknown>) => ({ redirect: typeof search.redirect === 'string' ? search.redirect : undefined }),
    component: () => <p>sign-in screen</p>,
  });
  const formRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/contribute',
    validateSearch: (search: Record<string, unknown>) => ({ edit: typeof search.edit === 'string' ? search.edit : undefined }),
    component: () => <p>contribute form</p>,
  });
  const drillRoute = createRoute({ getParentRoute: () => rootRoute, path: '/commons/$slug', component: () => <p>drill page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([mineRoute, signInRoute, formRoute, drillRoute]),
    history: createMemoryHistory({ initialEntries: ['/contribute/mine'] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, queryClient, router };
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const LEAKS = ['undefined', 'NaN', 'null', '{{', '[object'];
const date = (iso: string, locale: Locale = 'en') => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

/** Renders and waits for the list, so every later assertion sees the loaded screen. */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderMine(locale);
  await screen.findByRole('list', { name: messages[locale].list });
  return view;
}

/** The list item (card) of the contribution named `name`. */
const item = (name: string): HTMLElement => {
  const found = screen.getByRole('heading', { level: 2, name }).closest('li');
  if (found === null) throw new Error(`no item for "${name}"`);
  return found;
};
const withdrawButton = (name: string) => within(item(name)).queryByRole('button', { name: `Withdraw “${name}”` }) as HTMLButtonElement | null;
const editLink = (name: string) => within(item(name)).queryByRole('link', { name: `Edit and resubmit “${name}”` });
const viewLink = (name: string) => within(item(name)).queryByRole('link', { name: `View the published drill “${name}”` });
const refreshButton = () => screen.getByRole('button', { name: /^(Refresh|Refreshing…)$/ }) as HTMLButtonElement;
const DIALOG = 'Withdraw this contribution?';
const dialog = () => screen.findByRole('dialog', { name: DIALOG });

async function openDialog(user: ReturnType<typeof userEvent.setup>, name = 'Wall passes') {
  await user.click(withdrawButton(name)!);
  return dialog();
}

// --- the request --------------------------------------------------------------------------------

describe('the request', () => {
  test('loads with exactly one GET /api/contributions/mine and sends nothing else', async () => {
    await renderLoaded();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.init?.method).toBe('GET');
    expect(calls).toHaveLength(1);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the list arrives, with the title but no invented item', async () => {
    const held = deferred();
    serve({ list: [() => held.promise] });
    renderMine();

    const status = await screen.findByRole('status', { name: 'Loading your contributions' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'My contributions' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Your contributions' }) === null).toBe(true);
    expect(screen.queryByText('You have not sent a method yet') === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);

    held.release(json(ITEMS));
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(screen.queryByRole('status', { name: 'Loading your contributions' }) === null).toBe(true);
  });
});

// --- success ------------------------------------------------------------------------------------

describe('success: the contributions from the response', () => {
  test('one item per contribution, titled with its name, in the order the API sent them', async () => {
    await renderLoaded();
    const names = within(screen.getByRole('list', { name: 'Your contributions' }))
      .getAllByRole('heading', { level: 2 })
      .map(text);
    expect(names).toEqual(['Wall passes', 'Cone slalom', 'Two-touch turns', 'Sprint relay', 'Old idea']);
    expect(screen.getByRole('heading', { level: 1, name: 'My contributions' })).toBeTruthy();
  });

  test('every item carries its state as a written tag, and each state has its own word', async () => {
    await renderLoaded();
    const expected: Record<string, string> = {
      'Wall passes': 'Pending',
      'Cone slalom': 'Changes requested',
      'Two-touch turns': 'Approved',
      'Sprint relay': 'Rejected',
      'Old idea': 'Withdrawn',
    };
    for (const [name, tag] of Object.entries(expected)) {
      const tags = Array.from(item(name).querySelectorAll('[data-tone]')).map(text);
      expect(tags).toContain(tag);
    }
    // A state sentence says what the tag means, so a tag is never left to be guessed.
    expect(text(item('Cone slalom'))).toContain('A reviewer asked for changes before it can be published.');
    expect(text(item('Two-touch turns'))).toContain('Published in the commons.');
  });

  test('says whether it is a new method or an improvement to an existing drill, and when it was sent and last changed', async () => {
    await renderLoaded();
    expect(text(item('Wall passes'))).toContain('Improvement to an existing drill');
    expect(text(item('Cone slalom'))).toContain('New method');
    expect(text(item('Cone slalom'))).toContain(`Sent ${date(SENT)}`);
    expect(text(item('Cone slalom'))).toContain(`Updated ${date(UPDATED)}`);
  });

  test('a contribution that has not changed since it was sent shows no "Updated" date', async () => {
    serve({ list: [() => json([contribution('c-same', 'pending', 'Untouched', { updatedAt: SENT })])] });
    renderMine();
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(text(item('Untouched'))).toContain(`Sent ${date(SENT)}`);
    expect(text(item('Untouched'))).not.toContain('Updated');
  });

  test('the reviewer’s note is shown, word for word, on the items that have one, and nowhere else', async () => {
    await renderLoaded();
    expect(text(item('Cone slalom'))).toContain('Reviewer’s note');
    expect(text(item('Cone slalom'))).toContain('Please add a safety note for the cones.');
    expect(text(item('Sprint relay'))).toContain('This is a fitness drill without a ball.');
    expect(text(item('Two-touch turns'))).toContain('Thanks, this is published.');
    for (const name of ['Wall passes', 'Old idea']) {
      expect(text(item(name))).not.toContain('Reviewer’s note');
    }
  });

  test('"Edit and resubmit" appears only on changes-requested items and leads to the form with that id', async () => {
    await renderLoaded();
    const link = editLink('Cone slalom');
    expect(link === null).toBe(false);
    expect(link!.getAttribute('href')).toBe('/contribute?edit=c-changes');
    for (const name of ['Wall passes', 'Two-touch turns', 'Sprint relay', 'Old idea']) {
      expect(editLink(name) === null).toBe(true);
    }
    expect(screen.getAllByRole('link', { name: /^Edit and resubmit/ })).toHaveLength(1);
  });

  test('"Withdraw" appears only on undecided items (pending and changes requested)', async () => {
    await renderLoaded();
    expect(withdrawButton('Wall passes') === null).toBe(false);
    expect(withdrawButton('Cone slalom') === null).toBe(false);
    for (const name of ['Two-touch turns', 'Sprint relay', 'Old idea']) {
      expect(withdrawButton(name) === null).toBe(true);
    }
    expect(screen.getAllByRole('button', { name: /^Withdraw/ })).toHaveLength(2);
    // Enabled and named at rest; nothing has been sent by rendering.
    expect(withdrawButton('Wall passes')!.disabled).toBe(false);
    expect(deleteCalls()).toHaveLength(0);
  });

  test('an approved item links to the published drill; no other state does, even with a slug', async () => {
    serve({ list: [() => json([APPROVED, contribution('c-odd', 'rejected', 'Odd one', { resultingDrillSlug: 'should-not-show' })])] });
    renderMine();
    await screen.findByRole('list', { name: 'Your contributions' });
    const link = viewLink('Two-touch turns');
    expect(link === null).toBe(false);
    expect(link!.getAttribute('href')).toBe('/commons/two-touch-turns');
    expect(viewLink('Odd one') === null).toBe(true);
    expect(screen.getAllByRole('link', { name: /^View the published drill/ })).toHaveLength(1);
  });

  test('an approved item without a slug shows no link rather than a broken one', async () => {
    serve({ list: [() => json([contribution('c-a', 'approved', 'No slug yet')])] });
    renderMine();
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(viewLink('No slug yet') === null).toBe(true);
    expect(text(item('No slug yet'))).toContain('Approved');
  });

  test('an all-terminal list has no action buttons at all', async () => {
    serve({ list: [() => json([APPROVED, REJECTED, WITHDRAWN])] });
    renderMine();
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(screen.queryAllByRole('button', { name: /^Withdraw/ })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: /^Edit and resubmit/ })).toHaveLength(0);
  });

  test('a way to contribute another method is at hand, and no text leaks a key or placeholder', async () => {
    await renderLoaded();
    const link = screen.getByRole('link', { name: 'Contribute another method' });
    expect(link.getAttribute('href')).toBe('/contribute');
    const all = text(screen.getByRole('main'));
    for (const leak of LEAKS) expect(all).not.toContain(leak);
    expect(all).not.toMatch(/\b(state|actions|dialog|kind|note|empty|error)\.[a-z]/i);
  });
});

// --- the withdraw confirm flow ------------------------------------------------------------------

describe('withdraw: confirm flow', () => {
  test('Withdraw only opens a dialog that names the contribution: nothing is sent yet', async () => {
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user);
    expect(text(box)).toContain('“Wall passes”');
    expect(text(box)).toMatch(/leaves review/i);
    expect(within(box).getByRole('button', { name: 'Keep it' })).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Yes, withdraw' })).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
  });

  test('"Keep it" closes the dialog and sends nothing; so does Escape; the item is unchanged', async () => {
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user);
    await user.click(within(box).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));

    await openDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));

    expect(deleteCalls()).toHaveLength(0);
    expect(withdrawButton('Wall passes') === null).toBe(false);
    expect(text(item('Wall passes'))).toContain('Pending');
  });

  test('"Yes, withdraw" sends one DELETE for that id, then shows the returned state and closes the dialog', async () => {
    const withdrawn = contribution('c-pending', 'withdrawn', 'Wall passes', {}, { kind: 'improvement', targetDrillSlug: 'wall-passes-basic' });
    serve({ del: [() => json(withdrawn)] });
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user);
    await user.click(within(box).getByRole('button', { name: 'Yes, withdraw' }));

    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0]!.url.pathname).toBe('/api/contributions/c-pending');

    // The item shows the state the server returned, with no action left on it; the others are untouched.
    expect(Array.from(item('Wall passes').querySelectorAll('[data-tone]')).map(text)).toContain('Withdrawn');
    expect(withdrawButton('Wall passes') === null).toBe(true);
    expect(withdrawButton('Cone slalom') === null).toBe(false);
    expect(text(item('Cone slalom'))).toContain('Changes requested');
    // The mutation returned the resource, so the list is not fetched again.
    expect(listCalls()).toHaveLength(1);
    // The success is said in words, and the focus lands on the item rather than being lost with the button.
    expect(screen.getByText('Withdrawn: “Wall passes”. It is no longer in review.')).toBeTruthy();
    expect(document.activeElement === screen.getByRole('heading', { level: 2, name: 'Wall passes' })).toBe(true);
  });

  test('a changes-requested item can be withdrawn too, and the DELETE names its own id', async () => {
    serve({ del: [() => json(contribution('c-changes', 'withdrawn', 'Cone slalom'))] });
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user, 'Cone slalom');
    expect(text(box)).toContain('“Cone slalom”');
    await user.click(within(box).getByRole('button', { name: 'Yes, withdraw' }));
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]!.url.pathname).toBe('/api/contributions/c-changes');
    await waitFor(() => expect(Array.from(item('Cone slalom').querySelectorAll('[data-tone]')).map(text)).toContain('Withdrawn'));
  });

  test('while the request runs every mutation button is disabled, the dialog cannot be dismissed, and nothing is sent twice', async () => {
    const held = deferred();
    serve({ del: [() => held.promise] });
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user);
    await user.click(within(box).getByRole('button', { name: 'Yes, withdraw' }));
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));

    const inBox = () => within(screen.getByRole('dialog'));
    const confirm = () => inBox().getByRole('button', { name: 'Yes, withdraw' }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    expect(confirm().getAttribute('aria-busy')).toBe('true');
    expect((inBox().getByRole('button', { name: 'Keep it' }) as HTMLButtonElement).disabled).toBe(true);
    // Outside the dialog too: the page behind it is inert (hidden from assistive tech), but its buttons are disabled as well.
    const behind = screen.getAllByRole('button', { name: /^Withdraw/, hidden: true }) as HTMLButtonElement[];
    expect(behind).toHaveLength(2);
    expect(behind.every((button) => button.disabled)).toBe(true);
    expect((screen.getByRole('button', { name: /^(Refresh|Refreshing…)$/, hidden: true }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog') === null).toBe(false);
    await user.click(confirm());
    expect(deleteCalls()).toHaveLength(1);

    held.release(json(contribution('c-pending', 'withdrawn', 'Wall passes')));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(deleteCalls()).toHaveLength(1);
    expect(withdrawButton('Cone slalom')!.disabled).toBe(false);
  });

  test('a failed withdrawal keeps the dialog open with a message in words, changes nothing, and can be tried again', async () => {
    serve({ del: [() => problem(500, 'Boom'), () => json(contribution('c-pending', 'withdrawn', 'Wall passes'))] });
    await renderLoaded();
    const user = userEvent.setup();
    let box = await openDialog(user);
    await user.click(within(box).getByRole('button', { name: 'Yes, withdraw' }));

    box = await dialog();
    const alert = await within(box).findByRole('alert');
    expect(text(alert)).toContain('We could not withdraw it');
    expect(text(alert)).not.toContain('(server text)');
    expect(text(alert)).not.toContain('Boom');
    // The page behind a modal dialog is aria-hidden, so it is looked up with hidden: true.
    const behind = screen.getByRole('heading', { level: 2, name: 'Wall passes', hidden: true }).closest('li') as Element;
    expect(text(behind)).toContain('Pending');
    const again = within(box).getByRole('button', { name: 'Yes, withdraw' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(again.getAttribute('aria-busy')).not.toBe('true');

    await user.click(again);
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(deleteCalls()).toHaveLength(2);
    expect(Array.from(item('Wall passes').querySelectorAll('[data-tone]')).map(text)).toContain('Withdrawn');
  });

  test('a conflict (someone decided meanwhile) reloads the list: the item shows its real state and the dialog goes away', async () => {
    serve({
      list: [() => json(ITEMS), () => json([contribution('c-pending', 'approved', 'Wall passes', { resultingDrillSlug: 'wall-passes' }), CHANGES])],
      del: [() => problem(409, 'Conflict')],
    });
    await renderLoaded();
    const user = userEvent.setup();
    const box = await openDialog(user);
    await user.click(within(box).getByRole('button', { name: 'Yes, withdraw' }));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(Array.from(item('Wall passes').querySelectorAll('[data-tone]')).map(text)).toContain('Approved');
    expect(withdrawButton('Wall passes') === null).toBe(true);
    expect(deleteCalls()).toHaveLength(1);
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty', () => {
  test('no contributions shows one calm empty state that leads to the form, and no list or action button', async () => {
    serve({ list: [() => json([])] });
    renderMine();
    await screen.findByText('You have not sent a method yet');

    expect(screen.getByText(/goes to a reviewer before anyone else sees it/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Contribute a method' });
    expect(link.getAttribute('href')).toBe('/contribute');
    expect(screen.queryByRole('list', { name: 'Your contributions' }) === null).toBe(true);
    expect(screen.queryAllByRole('button', { name: /^Withdraw/ })).toHaveLength(0);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'My contributions' })).toBeTruthy();
    // The screen can still be refreshed.
    expect(refreshButton().disabled).toBe(false);
    const all = text(screen.getByRole('main'));
    for (const leak of LEAKS) expect(all).not.toContain(leak);
  });

  test('emptiness is only for an empty answer: a list with one item is not the empty state', async () => {
    serve({ list: [() => json([WITHDRAWN])] });
    renderMine();
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(screen.queryByText('You have not sent a method yet') === null).toBe(true);
  });
});

// --- error --------------------------------------------------------------------------------------

describe('error', () => {
  test('a failed load is an alert with words and a retry; the server text is never shown; no item and no empty state', async () => {
    serve({ list: [() => problem(500, 'Boom')] });
    renderMine();

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load your contributions');
    expect(text(alert)).not.toContain('(server text)');
    expect(text(alert)).not.toContain('Boom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Your contributions' }) === null).toBe(true);
    expect(screen.queryByText('You have not sent a method yet') === null).toBe(true);
  });

  test('a network failure is the error state', async () => {
    stubNetwork(() => {
      throw new TypeError('Failed to fetch');
    });
    renderMine();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load your contributions');
  });

  test('an answer that does not match the contract is an error, never a blank item', async () => {
    serve({ list: [() => json([{ ...ITEMS[0], state: 'bogus' }])] });
    renderMine();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load your contributions');
    for (const leak of LEAKS) expect(text(screen.getByRole('main'))).not.toContain(leak);
  });

  test('Try again asks again, is disabled and busy while the request runs, then shows the list', async () => {
    const held = deferred();
    serve({ list: [() => problem(500, 'Boom'), () => held.promise] });
    renderMine();
    await screen.findByRole('alert');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    await user.click(retry);
    expect(listCalls()).toHaveLength(2);

    held.release(json(ITEMS));
    await screen.findByRole('list', { name: 'Your contributions' });
    expect(screen.queryByRole('alert') === null).toBe(true);
  });
});

// --- refresh ------------------------------------------------------------------------------------

describe('refresh', () => {
  test('Refresh is disabled and busy while it runs, keeps the list on screen, then shows the new state', async () => {
    const held = deferred();
    serve({ list: [() => json(ITEMS), () => held.promise] });
    await renderLoaded();
    expect(refreshButton().disabled).toBe(false);

    const user = userEvent.setup();
    await user.click(refreshButton());
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    const busy = refreshButton();
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe('Refreshing…');
    // Not a return to loading: the items stay.
    expect(text(item('Cone slalom'))).toContain('Changes requested');
    expect(screen.queryByRole('status', { name: 'Loading your contributions' }) === null).toBe(true);
    await user.click(busy);
    expect(listCalls()).toHaveLength(2);

    held.release(json([contribution('c-changes', 'pending', 'Cone slalom')]));
    await waitFor(() => expect(text(item('Cone slalom'))).toContain('Pending'));
    expect(editLink('Cone slalom') === null).toBe(true);
    expect(refreshButton().disabled).toBe(false);
  });

  test('a refresh that fails keeps the last good list and says so in words', async () => {
    serve({ list: [() => json(ITEMS), () => problem(500, 'Boom')] });
    await renderLoaded();
    const user = userEvent.setup();
    await user.click(refreshButton());

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not refresh the list');
    expect(text(alert)).not.toContain('(server text)');
    expect(text(item('Cone slalom'))).toContain('Changes requested');
    expect(refreshButton().disabled).toBe(false);
  });
});

// --- anonymous players --------------------------------------------------------------------------

describe('anonymous players are not contributors', () => {
  test('a 403 sends them to sign-in with this page as the return path, and shows no list and no error', async () => {
    serve({ list: [() => problem(403, 'Forbidden')] });
    const { router } = renderMine();

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect((router.state.location.search as { redirect?: string }).redirect).toBe('/contribute/mine');
    await screen.findByText('sign-in screen');
    expect(screen.queryByRole('list', { name: 'Your contributions' }) === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(listCalls()).toHaveLength(1);
    // Going to sign-in replaces this page, so Back does not bounce the visitor into the redirect again.
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/contribute/mine'));
  });

  test('the redirect replaces this page in the history instead of stacking sign-in on top of it', async () => {
    serve({ list: [() => problem(403, 'Forbidden')] });
    const { router } = renderMine();
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect(router.history.length).toBe(1);
  });

  test('while the redirect happens the page says why and offers the sign-in link', async () => {
    const held = deferred();
    serve({ list: [() => held.promise] });
    const { router } = renderMine();
    await screen.findByRole('status', { name: 'Loading your contributions' });
    held.release(problem(403, 'Forbidden'));
    // The visitor is either still looking at the explanation or already on the sign-in page: never at an error.
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a 401 (no session at all) is treated the same way', async () => {
    // A 401 in a coach area is not retried as an anonymous player (features/account/session-expired.ts): be in one.
    window.history.pushState({}, '', '/contribute/mine');
    serve({ list: [() => problem(401, 'Unauthorized')] });
    const { router } = renderMine();
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sign-in'));
    expect((router.state.location.search as { redirect?: string }).redirect).toBe('/contribute/mine');
  });

  test('a 404 or a 500 is an ordinary error, not a sign-in redirect', async () => {
    serve({ list: [() => problem(404, 'Not Found')] });
    const { router } = renderMine();
    await screen.findByRole('alert');
    expect(router.state.location.pathname).toBe('/contribute/mine');
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  test('every locale renders the whole success screen with real text and no leaked key or placeholder', async () => {
    const titles = new Set<string>();
    const pendingTags = new Set<string>();
    for (const locale of LOCALES) {
      const view = await renderLoaded(locale);
      const main = screen.getByRole('main');
      const all = text(main);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(state|actions|dialog|kind|note|empty|error)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      titles.add(text(screen.getByRole('heading', { level: 1 })));
      // Every state has its own tag text in every language.
      const tags = Array.from(main.querySelectorAll('[data-tone]')).map(text);
      expect(new Set(tags).size).toBe(5);
      pendingTags.add(messages[locale].state.pending);
      // The dates are written in the language of the screen.
      expect(all).toContain(date(SENT, locale));
      // The two actions exist in every language.
      expect(screen.getAllByRole('button', { name: new RegExp(`^${messages[locale].actions.withdraw}`) })).toHaveLength(2);
      expect(screen.getAllByRole('link', { name: new RegExp(`^${messages[locale].actions.edit}`) })).toHaveLength(1);
      view.unmount();
    }
    expect(titles.size).toBe(3);
    expect(pendingTags.size).toBe(3);
  });

  test('the dialog, the empty state and the error state are also written in every locale', async () => {
    for (const locale of LOCALES) {
      // dialog
      let view = await renderLoaded(locale);
      const user = userEvent.setup();
      await user.click(screen.getAllByRole('button', { name: new RegExp(`^${messages[locale].actions.withdraw}`) })[0]!);
      const box = await screen.findByRole('dialog', { name: messages[locale].dialog.title });
      let all = text(box);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(state|actions|dialog|kind|note|empty|error)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();

      // empty
      serve({ list: [() => json([])] });
      view = renderMine(locale);
      await screen.findByText(messages[locale].empty.title);
      all = text(screen.getByRole('main'));
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(state|actions|dialog|kind|note|empty|error)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();

      // error
      serve({ list: [() => problem(500, 'Boom')] });
      view = renderMine(locale);
      const alert = await screen.findByRole('alert');
      all = text(alert);
      for (const leak of LEAKS) expect(all).not.toContain(leak);
      expect(all).not.toMatch(/\b(state|actions|dialog|kind|note|empty|error)\.[a-z]/i);
      if (locale !== 'en') expect(all).toMatch(/[Ѐ-ӿ]{4,}/);
      view.unmount();
      serve();
    }
  });
});
