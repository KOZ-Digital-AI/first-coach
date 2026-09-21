import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DecisionResponse, ModerationQueueItem } from '@api-types/admin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/admin/index';
import messages from './queue.messages';

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
 * Contract under test (fc-mol-0v3.9): /admin is the review queue. It lists contributions from GET /api/admin/contributions
 * (ModerationQueueItem[], apps/api/src/shared/admin.ts) in one tab per state (pending first): title, kind (new method, or an
 * improvement with its target drill), skill, submitter, date, an attachment indicator and a possible-duplicate warning. Every row
 * opens the review of that contribution; an empty list says 'The queue is empty.'. The review shows the full payload the list
 * already carries (no second call), the diff of an improvement, the duplicate flag and the decision: Approve, Request changes and
 * Reject with a note (required for the last two), POST /api/admin/contributions/:id/decision. The screen has loading, empty,
 * error, disabled and success states, its mutation buttons are disabled while a request is in flight, and every string exists in
 * kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query inside a real (memory-history) router; the only
 * stand-in is the network (globalThis.fetch). Fixtures are parsed with the shared contract schemas, so they cannot drift from
 * them. Kazakh and Russian copy still needs a native-speaker review: for those locales these tests pin only that text exists, is
 * Cyrillic and never leaks 'undefined', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "each opens the review screen": the review is a view of this same route (the route file is the only page this bead owns), so
 *   opening one costs no request: the list already carries the full payload. Back returns to the list.
 * - One request per tab: GET /api/admin/contributions?state=<tab>. Pending is the first tab and the one shown first.
 * - "attachment indicator" is shown only when the contribution has files ("Files: 2"); a possible duplicate is a written tag.
 * - The decision offers only the actions the shared CONTRIBUTION_TRANSITIONS table allows for the state (a pending contribution:
 *   all three; any other state: none, with a sentence saying why).
 * - A blank note on Request changes or Reject is refused on the screen with no request; the server's 422 pointer /note is shown
 *   at the same field. An approval may carry a note; a blank one is not sent.
 * - "roll back / refresh on 409": nothing is applied before the server answers, so there is nothing to roll back; a 409 (or 404)
 *   says nothing was saved and reads the list again, and the contribution then leaves the pending list.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const SENT = '2026-09-01T09:00:00.000Z';
const UPDATED = '2026-09-03T09:00:00.000Z';

interface Options {
  payload?: Record<string, unknown>;
  contribution?: Record<string, unknown>;
  submitter?: { id: string; name: string };
  diff?: unknown[];
  duplicateOf?: string;
}

const queueItem = (id: string, state: string, name: string, options: Options = {}) =>
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
        ...options.payload,
      },
      attachments: [],
      createdAt: SENT,
      updatedAt: UPDATED,
      ...options.contribution,
    },
    submitter: options.submitter ?? { id: 'u-1', name: 'Aidar Coach' },
    ...(options.diff === undefined ? {} : { diff: options.diff }),
    ...(options.duplicateOf === undefined ? {} : { duplicateOf: options.duplicateOf }),
  });

const NEW_ITEM = queueItem('c-new', 'pending', 'Cone slalom', {
  duplicateOf: 'c-dup',
  payload: {
    instructions: 'Weave the ball through six cones.\nKeep your head up.',
    mistakes: 'Looking only at the ball.',
    safety: 'Use soft cones.',
    sourceUrl: 'https://example.org/cone-slalom',
  },
  contribution: {
    attachments: [
      { id: 'a-1', kind: 'video', url: '/uploads/a-1.mp4', filename: 'slalom.mp4', mimeType: 'video/mp4', size: 3_145_728 },
      { id: 'a-2', kind: 'image', url: '/uploads/a-2.png', filename: 'cones.png', mimeType: 'image/png', size: 20_480 },
    ],
  },
});

const DIFF = [
  { field: 'instructions.en', before: 'Pass hard.', after: 'Pass firmly, then trap the ball.' },
  { field: 'ageMin', before: 8, after: 6 },
  { field: 'safety.en', before: null, after: 'Mind the wall behind you.' },
];

const IMPROVEMENT = queueItem('c-imp', 'pending', 'Wall passes', {
  submitter: { id: 'u-2', name: 'Dana Coach' },
  diff: DIFF,
  payload: { kind: 'improvement', targetDrillSlug: 'wall-passes-basic', improvementKind: 'explanation', skill: 'passing-basics', goal: 'passing' },
});

const DUPLICATE = queueItem('c-dup', 'pending', 'Cone slalom again', { duplicateOf: 'c-new', submitter: { id: 'u-3', name: 'Marat Coach' } });

/** The order the API sends: oldest first. */
const PENDING = [NEW_ITEM, IMPROVEMENT, DUPLICATE];

const CHANGES = [
  queueItem('c-changes', 'changes_requested', 'Zig-zag runs', { contribution: { reviewerNote: 'Please add a safety note for the cones.' } }),
];
const APPROVED = [
  queueItem('c-approved', 'approved', 'Two-touch turns', {
    contribution: { reviewerNote: 'Thanks, this is published.', resultingDrillSlug: 'two-touch-turns' },
  }),
];
const REJECTED: unknown[] = [];

const BY_STATE: Record<string, unknown[]> = {
  pending: PENDING,
  changes_requested: CHANGES,
  approved: APPROVED,
  rejected: REJECTED,
};

/** What the API answers to an approval: the updated contribution and the drill it created. */
const approvedResponse = (from: ReturnType<typeof queueItem>, slug = 'cone-slalom') =>
  DecisionResponse.parse({
    contribution: { ...from.contribution, state: 'approved', resultingDrillSlug: slug, updatedAt: '2026-09-05T09:00:00.000Z' },
    drill: {
      slug,
      versionId: 'ver-1',
      content: {
        title: { en: from.contribution.payload.name },
        goal: { en: 'Dribbling' },
        instructions: { en: 'Weave.' },
        dose: { reps: 5 },
        conditions: { equipment: 'cones', spaces: ['field'], partner: false },
      },
      attribution: { author: 'Aidar Coach', source: 'My own session', license: 'CC-BY-SA-4.0', createdAt: '2026-09-05T09:00:00.000Z', semver: '1.0.0' },
      history: [],
      reviews: [],
    },
  });

const decidedResponse = (from: ReturnType<typeof queueItem>, state: 'rejected' | 'changes_requested', note: string) =>
  DecisionResponse.parse({ contribution: { ...from.contribution, state, reviewerNote: note, updatedAt: '2026-09-05T09:00:00.000Z' } });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string, errors: Array<{ pointer: string; detail: string }> = []) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors }, { status }, 'application/problem+json');

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

const LIST_PATH = '/api/admin/contributions';
const listCalls = () => calls.filter((call) => call.url.pathname === LIST_PATH);
const decisionCalls = () => calls.filter((call) => call.url.pathname.endsWith('/decision'));
const bodyOf = (call: { init: RequestInit | undefined } | undefined): unknown => JSON.parse(String(call?.init?.body));

/**
 * `lists`: per state, the answers to GET /api/admin/contributions?state=<state>, one per call (the last repeats); a state with no
 * entry answers with BY_STATE. `decide`: the answers to POST /api/admin/contributions/:id/decision, one per call (the last repeats).
 * Anything else is a 404.
 */
function serve({ lists = {}, decide = [] }: { lists?: Record<string, Answer[]>; decide?: Answer[] } = {}): void {
  const listed: Record<string, number> = {};
  let decided = 0;
  stubNetwork((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === LIST_PATH && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'all';
      const answers = lists[state] ?? [() => json(BY_STATE[state] ?? [])];
      const index = listed[state] ?? 0;
      listed[state] = index + 1;
      return answers[Math.min(index, answers.length - 1)]!();
    }
    if (url.pathname.startsWith(`${LIST_PATH}/`) && url.pathname.endsWith('/decision') && method === 'POST' && decide.length > 0) {
      const next = decide[Math.min(decided, decide.length - 1)]!;
      decided += 1;
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
  './queue.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The real route component inside a real (memory) router that also knows the screen an approval links to. */
function renderQueue(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: Route.options.component });
  const drillRoute = createRoute({ getParentRoute: () => rootRoute, path: '/commons/$slug', component: () => <p>drill page</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([queueRoute, drillRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin'] }),
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
const CYRILLIC = /[Ѐ-ӿ]/;

/** Renders and waits for the pending list, so every later assertion sees the loaded screen. */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderQueue(locale);
  await screen.findByRole('list', { name: messages[locale].list });
  return view;
}

const tab = (name: string) => screen.getByRole('tab', { name }) as HTMLElement;
/** The list item (row) of the contribution named `name`. */
const row = (name: string): HTMLElement => {
  const found = screen.getByRole('heading', { level: 2, name }).closest('li');
  if (found === null) throw new Error(`no row for "${name}"`);
  return found;
};
const titles = (): string[] => screen.getAllByRole('heading', { level: 2 }).map(text);
const reviewButton = (name: string) => within(row(name)).getByRole('button', { name: `Review “${name}”` }) as HTMLButtonElement;
const refreshButton = () => screen.getByRole('button', { name: /^(Refresh|Refreshing…)$/ }) as HTMLButtonElement;
const backButton = () => screen.getByRole('button', { name: 'Back to the queue' }) as HTMLButtonElement;
const approveButton = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
const changesButton = () => screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement;
const rejectButton = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
const noteBox = () => screen.getByRole('textbox', { name: /^Note to the coach/ }) as HTMLTextAreaElement;

type User = ReturnType<typeof userEvent.setup>;

/** Opens the review of `name` and waits for its page title. */
async function openReview(user: User, name: string) {
  await user.click(reviewButton(name));
  return screen.findByRole('heading', { level: 1, name });
}

// --- the request --------------------------------------------------------------------------------

describe('the request', () => {
  test('loads with exactly one GET /api/admin/contributions?state=pending and sends nothing else', async () => {
    await renderLoaded();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.init?.method).toBe('GET');
    expect(listCalls()[0]?.url.searchParams.get('state')).toBe('pending');
    expect(calls).toHaveLength(1);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the queue arrives, with the title but no invented row', async () => {
    const held = deferred();
    serve({ lists: { pending: [() => held.promise] } });
    renderQueue();

    const status = await screen.findByRole('status', { name: 'Loading the review queue' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Review queue' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Contributions' }) === null).toBe(true);
    expect(screen.queryByText('The queue is empty.') === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);

    held.release(json(PENDING));
    await screen.findByRole('list', { name: 'Contributions' });
    expect(screen.queryByRole('status', { name: 'Loading the review queue' }) === null).toBe(true);
  });
});

// --- tabs ---------------------------------------------------------------------------------------

describe('tabs by state', () => {
  test('four tabs in a named tab list, pending first and selected', async () => {
    await renderLoaded();
    const list = screen.getByRole('tablist', { name: 'Contribution state' });
    expect(within(list).getAllByRole('tab').map(text)).toEqual(['Pending', 'Changes requested', 'Approved', 'Rejected']);
    expect(tab('Pending').getAttribute('aria-selected')).toBe('true');
    for (const name of ['Changes requested', 'Approved', 'Rejected']) expect(tab(name).getAttribute('aria-selected')).toBe('false');
  });

  test('the pending list shows one row per contribution, titled with its name, in the order the API sent them', async () => {
    await renderLoaded();
    expect(titles()).toEqual(['Cone slalom', 'Wall passes', 'Cone slalom again']);
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });

  test('choosing a tab asks for that state and shows only its contributions', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(tab('Changes requested'));
    await screen.findByRole('heading', { level: 2, name: 'Zig-zag runs' });
    expect(listCalls().map((call) => call.url.searchParams.get('state'))).toEqual(['pending', 'changes_requested']);
    expect(titles()).toEqual(['Zig-zag runs']);
    expect(tab('Changes requested').getAttribute('aria-selected')).toBe('true');
    expect(tab('Pending').getAttribute('aria-selected')).toBe('false');

    await user.click(tab('Approved'));
    await screen.findByRole('heading', { level: 2, name: 'Two-touch turns' });
    expect(listCalls().at(-1)?.url.searchParams.get('state')).toBe('approved');
    expect(titles()).toEqual(['Two-touch turns']);

    await user.click(tab('Pending'));
    await screen.findByRole('heading', { level: 2, name: 'Wall passes' });
    expect(titles()).toEqual(['Cone slalom', 'Wall passes', 'Cone slalom again']);
  });

  test('a tab with nothing in it shows the empty state, not the previous tab', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(tab('Rejected'));
    await screen.findByText('The queue is empty.');
    expect(listCalls().at(-1)?.url.searchParams.get('state')).toBe('rejected');
    expect(screen.queryByRole('list', { name: 'Contributions' }) === null).toBe(true);
    expect(screen.queryByText('Cone slalom') === null).toBe(true);
  });

  test('the arrow keys move between tabs and choose the one they land on', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    tab('Pending').focus();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 2, name: 'Zig-zag runs' });
    expect(document.activeElement === tab('Changes requested')).toBe(true);
    expect(tab('Changes requested').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowLeft}');
    await screen.findByRole('heading', { level: 2, name: 'Wall passes' });
    expect(document.activeElement === tab('Pending')).toBe(true);
  });
});

// --- rows ---------------------------------------------------------------------------------------

describe('a row', () => {
  test('names the kind, the skill, the submitter and the date; a new method is labelled new', async () => {
    await renderLoaded();
    const facts = text(row('Cone slalom'));
    expect(facts).toContain('New method');
    expect(facts).toContain('Skill: dribbling-basics');
    expect(facts).toContain('Sent by: Aidar Coach');
    expect(facts).toContain(`Sent: ${date(SENT)}`);
    expect(facts).not.toContain('Improves');
  });

  test('an improvement is labelled as one and names the drill it improves and the kind of change', async () => {
    await renderLoaded();
    const facts = text(row('Wall passes'));
    expect(facts).toContain('Improvement');
    expect(facts).not.toContain('New method');
    expect(facts).toContain('Improves: wall-passes-basic');
    expect(facts).toContain('Change: Explanation');
    expect(facts).toContain('Skill: passing-basics');
    expect(facts).toContain('Sent by: Dana Coach');
  });

  test('a contribution with files shows a written attachment indicator with the count; one without shows none', async () => {
    await renderLoaded();
    expect(text(row('Cone slalom'))).toContain('Files: 2');
    expect(text(row('Wall passes'))).not.toContain('Files');
  });

  test('a possible duplicate is a written warning on the rows the API flags, and only on those', async () => {
    await renderLoaded();
    expect(within(row('Cone slalom')).queryByText('Possible duplicate') === null).toBe(false);
    expect(within(row('Cone slalom again')).queryByText('Possible duplicate') === null).toBe(false);
    expect(within(row('Wall passes')).queryByText('Possible duplicate') === null).toBe(true);
  });

  test('every row has its own Review button, named for the contribution', async () => {
    await renderLoaded();
    for (const name of ['Cone slalom', 'Wall passes', 'Cone slalom again']) {
      expect(reviewButton(name).disabled).toBe(false);
      expect(reviewButton(name).textContent).toContain('Review');
    }
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty', () => {
  test("an empty queue says 'The queue is empty.' and lists nothing", async () => {
    serve({ lists: { pending: [() => json([])] } });
    renderQueue();
    await screen.findByText('The queue is empty.');
    expect(screen.queryByRole('list', { name: 'Contributions' }) === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
    // The tabs stay, so the admin can look at another state.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });
});

// --- error --------------------------------------------------------------------------------------

describe('error', () => {
  test('a failed load shows an alert with the plain message and a Try again button, and no list', async () => {
    serve({ lists: { pending: [() => problem(500, 'Boom')] } });
    renderQueue();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load the review queue');
    expect(text(alert)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(text(alert)).not.toContain('server text');
    expect(screen.queryByRole('list', { name: 'Contributions' }) === null).toBe(true);
    expect(screen.queryByText('The queue is empty.') === null).toBe(true);
  });

  test('Try again asks once more, is disabled and busy meanwhile, and the list replaces the alert on success', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ lists: { pending: [() => problem(500, 'Boom'), () => held.promise] } });
    renderQueue();
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    await user.click(retry);
    expect(listCalls()).toHaveLength(2);

    held.release(json(PENDING));
    await screen.findByRole('list', { name: 'Contributions' });
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a refusal (403) is an ordinary load failure with the "no access" message', async () => {
    serve({ lists: { pending: [() => problem(403, 'Forbidden')] } });
    renderQueue();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain("You don't have access to this.");
  });

  test('a failed refresh keeps the last good list and says so', async () => {
    const user = userEvent.setup();
    serve({ lists: { pending: [() => json(PENDING), () => problem(500, 'Boom')] } });
    await renderLoaded();
    await user.click(refreshButton());
    const notice = await screen.findByText('We could not refresh the queue. What you see is from the last successful load.');
    expect(notice).toBeTruthy();
    expect(titles()).toEqual(['Cone slalom', 'Wall passes', 'Cone slalom again']);
  });
});

// --- disabled -----------------------------------------------------------------------------------

describe('disabled while a request is in flight', () => {
  test('Refresh is disabled and busy while the list loads again, the last list stays, and a second click sends nothing', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ lists: { pending: [() => json(PENDING), () => held.promise] } });
    await renderLoaded();

    await user.click(refreshButton());
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(refreshButton().disabled).toBe(true);
    expect(refreshButton().getAttribute('aria-busy')).toBe('true');
    expect(titles()).toEqual(['Cone slalom', 'Wall passes', 'Cone slalom again']);
    await user.click(refreshButton());
    expect(listCalls()).toHaveLength(2);

    held.release(json(PENDING));
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
  });
});

// --- the review ---------------------------------------------------------------------------------

describe('opening a review', () => {
  test('shows the contribution by name with its state, kind and submitter, and costs no request', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const heading = await openReview(user, 'Cone slalom');
    expect(document.activeElement === heading).toBe(true);
    expect(calls).toHaveLength(1);
    const page = text(screen.getByRole('main'));
    expect(page).toContain('Pending');
    expect(page).toContain('New method');
    expect(page).toContain('Aidar Coach');
    expect(page).toContain(date(SENT));
    expect(page).toContain('dribbling-basics');
  });

  test('shows the full payload the list carries: instructions, mistakes, safety, and what was left blank', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    const page = text(screen.getByRole('main'));
    expect(page).toContain('Weave the ball through six cones.');
    expect(page).toContain('Keep your head up.');
    expect(page).toContain('Looking only at the ball.');
    expect(page).toContain('Use soft cones.');
    // progression and regression were sent blank: said so, not left as an empty heading
    expect(page).toContain('Not filled in');
    const source = screen.getByRole('link', { name: 'https://example.org/cone-slalom' }) as HTMLAnchorElement;
    expect(source.getAttribute('href')).toBe('https://example.org/cone-slalom');
    expect(source.getAttribute('rel')).toContain('noopener');
  });

  test('lists the attachments as links to their files, with the kind and the size', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    const files = screen.getByRole('list', { name: 'Files' });
    const links = within(files).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/uploads/a-1.mp4', '/uploads/a-2.png']);
    expect(text(within(files).getAllByRole('listitem')[0]!)).toContain('slalom.mp4');
    expect(text(within(files).getAllByRole('listitem')[0]!)).toContain('Video');
    expect(text(within(files).getAllByRole('listitem')[0]!)).toContain('3');
    expect(text(within(files).getAllByRole('listitem')[1]!)).toContain('Image');
  });

  test('a file whose address is not a web address or a site path is not turned into a link', async () => {
    const user = userEvent.setup();
    const item = queueItem('c-x', 'pending', 'Odd file', {
      contribution: { attachments: [{ id: 'a-x', kind: 'document', url: 'javascript:alert(1)', filename: 'notes.pdf' }] },
    });
    serve({ lists: { pending: [() => json([item])] } });
    await renderLoaded();
    await openReview(user, 'Odd file');
    const files = screen.getByRole('list', { name: 'Files' });
    expect(within(files).queryAllByRole('link')).toHaveLength(0);
    expect(text(files)).toContain('notes.pdf');
  });

  test('the duplicate flag is a written warning naming the other contribution, and only on a flagged one', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom again');
    const warning = screen.getByRole('alert');
    expect(text(warning)).toContain('Possible duplicate');
    expect(text(warning)).toContain('c-new');
    await user.click(backButton());
    await openReview(user, 'Wall passes');
    expect(screen.queryByText('Possible duplicate') === null).toBe(true);
  });

  test('an improvement shows the drill it improves and a before and after for every changed field', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Wall passes');
    const page = text(screen.getByRole('main'));
    expect(page).toContain('Improvement');
    expect(page).toContain('wall-passes-basic');
    expect(page).toContain('Explanation');

    const diff = screen.getByRole('list', { name: 'What changes' });
    const entries = within(diff).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    const first = text(entries[0]!);
    expect(first).toContain('Instructions (English)');
    expect(first).toContain('Before');
    expect(first).toContain('Pass hard.');
    expect(first).toContain('After');
    expect(first).toContain('Pass firmly, then trap the ball.');
    const age = text(entries[1]!);
    expect(age).toContain('Youngest age');
    expect(age).toContain('8');
    expect(age).toContain('6');
    // a field the drill lacks (before null) reads as empty, never as the word null
    const safety = text(entries[2]!);
    expect(safety).toContain('(empty)');
    expect(safety).toContain('Mind the wall behind you.');
    expect(safety).not.toContain('null');
  });

  test('a new method shows no comparison', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    expect(screen.queryByRole('list', { name: 'What changes' }) === null).toBe(true);
  });

  test('an improvement the API sent no diff for says the comparison is not available', async () => {
    const user = userEvent.setup();
    const item = queueItem('c-nodiff', 'pending', 'Old drill fix', { payload: { kind: 'improvement', targetDrillSlug: 'gone-drill', improvementKind: 'safety' } });
    serve({ lists: { pending: [() => json([item])] } });
    await renderLoaded();
    await openReview(user, 'Old drill fix');
    expect(screen.queryByRole('list', { name: 'What changes' }) === null).toBe(true);
    expect(text(screen.getByRole('main'))).toContain('No comparison is available for this improvement.');
  });

  test('Back returns to the list, on the same tab, with focus on the Review button it came from and no new request', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Wall passes');
    await user.click(backButton());
    await screen.findByRole('list', { name: 'Contributions' });
    expect(titles()).toEqual(['Cone slalom', 'Wall passes', 'Cone slalom again']);
    expect(document.activeElement === reviewButton('Wall passes')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('a contribution that is not pending has no decision buttons, says why, and shows the reviewer note', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(tab('Changes requested'));
    await screen.findByRole('heading', { level: 2, name: 'Zig-zag runs' });
    await openReview(user, 'Zig-zag runs');
    expect(screen.queryByRole('button', { name: 'Approve' }) === null).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reject' }) === null).toBe(true);
    expect(screen.queryByRole('button', { name: 'Request changes' }) === null).toBe(true);
    expect(screen.queryByRole('textbox', { name: /^Note to the coach/ }) === null).toBe(true);
    const page = text(screen.getByRole('main'));
    expect(page).toContain('Waiting for the coach to send a new version.');
    expect(page).toContain('Please add a safety note for the cones.');
    expect(page).toContain('Changes requested');
  });

  test('an approved contribution has no decision buttons and links to its published drill', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(tab('Approved'));
    await screen.findByRole('heading', { level: 2, name: 'Two-touch turns' });
    await openReview(user, 'Two-touch turns');
    expect(screen.queryByRole('button', { name: 'Approve' }) === null).toBe(true);
    const link = screen.getByRole('link', { name: 'Open the published drill “Two-touch turns”' });
    expect(link.getAttribute('href')).toBe('/commons/two-touch-turns');
  });
});

// --- deciding -----------------------------------------------------------------------------------

describe('deciding: approve', () => {
  test('offers the three actions and a note field that says when a note is needed', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    expect(approveButton().disabled).toBe(false);
    expect(changesButton().disabled).toBe(false);
    expect(rejectButton().disabled).toBe(false);
    expect(noteBox().getAttribute('aria-describedby')).toBeTruthy();
    expect(text(screen.getByRole('main'))).toContain('Required to reject or ask for changes. Optional when you approve.');
  });

  test('sends one POST with action approve and no note when the note is blank, and shows the outcome with a link to the drill', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(approveButton());

    await screen.findByText('Approved. The method is now in the commons.');
    expect(decisionCalls()).toHaveLength(1);
    const call = decisionCalls()[0];
    expect(call?.url.pathname).toBe('/api/admin/contributions/c-new/decision');
    expect(call?.init?.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ action: 'approve' });
    const link = screen.getByRole('link', { name: 'Open the published drill “Cone slalom”' });
    expect(link.getAttribute('href')).toBe('/commons/cone-slalom');
    // decided: the decision form is gone, the state now reads Approved
    expect(screen.queryByRole('button', { name: 'Approve' }) === null).toBe(true);
    expect(screen.queryByRole('textbox', { name: /^Note to the coach/ }) === null).toBe(true);
    expect(text(screen.getByRole('main'))).toContain('Approved');
  });

  test('an approval may carry a note; it is sent trimmed', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.type(noteBox(), '  Great drill, thank you.  ');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    expect(bodyOf(decisionCalls()[0])).toEqual({ action: 'approve', note: 'Great drill, thank you.' });
  });

  test('after Back the decided contribution is gone from the pending list, without another request for it', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => json(approvedResponse(NEW_ITEM))] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(approveButton());
    await screen.findByText('Approved. The method is now in the commons.');
    await user.click(backButton());
    await screen.findByRole('list', { name: 'Contributions' });
    expect(titles()).toEqual(['Wall passes', 'Cone slalom again']);
    expect(listCalls()).toHaveLength(1);
  });
});

describe('deciding: request changes and reject', () => {
  test.each([
    { label: 'Request changes', action: 'request_changes', state: 'changes_requested', outcome: 'Sent back. The coach can now edit the method and send it again.' },
    { label: 'Reject', action: 'reject', state: 'rejected', outcome: 'Rejected. The coach can read your note.' },
  ] as const)('$label with a blank note is refused on the screen: an error at the note field, focus there, no request', async ({ label }) => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(screen.getByRole('button', { name: label }));

    const box = noteBox();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement === box).toBe(true);
    const error = screen.getByText('A note is required to reject or to ask for changes. Tell the coach what to do.');
    expect(error.closest('[role="alert"]') === null).toBe(false);
    expect(box.getAttribute('aria-describedby')).toContain(error.closest('[id]')?.id ?? 'missing');
    expect(decisionCalls()).toHaveLength(0);
    // a note of only spaces is blank too
    await user.type(box, '   ');
    await user.click(screen.getByRole('button', { name: label }));
    expect(decisionCalls()).toHaveLength(0);
  });

  test.each([
    { label: 'Request changes', action: 'request_changes', state: 'changes_requested', outcome: 'Sent back. The coach can now edit the method and send it again.' },
    { label: 'Reject', action: 'reject', state: 'rejected', outcome: 'Rejected. The coach can read your note.' },
  ] as const)('$label with a note sends it, says what happened and removes the decision form', async ({ label, action, state, outcome }) => {
    const user = userEvent.setup();
    serve({ decide: [() => json(decidedResponse(NEW_ITEM, state, 'Add the age range.'))] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.type(noteBox(), ' Add the age range. ');
    await user.click(screen.getByRole('button', { name: label }));

    await screen.findByText(outcome);
    expect(decisionCalls()).toHaveLength(1);
    expect(bodyOf(decisionCalls()[0])).toEqual({ action, note: 'Add the age range.' });
    expect(screen.queryByRole('button', { name: 'Approve' }) === null).toBe(true);
    // the drill link belongs to an approval only
    expect(screen.queryByRole('link', { name: /Open the published drill/ }) === null).toBe(true);
    await user.click(backButton());
    await screen.findByRole('list', { name: 'Contributions' });
    expect(titles()).toEqual(['Wall passes', 'Cone slalom again']);
  });

  test("the server's 422 on /note is shown at the note field, in plain words, and keeps what was typed", async () => {
    const user = userEvent.setup();
    serve({ decide: [() => problem(422, 'Unprocessable Entity', [{ pointer: '/note', detail: 'A note is required to reject' }])] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());

    await screen.findByText('A note is required to reject or to ask for changes. Tell the coach what to do.');
    expect(noteBox().getAttribute('aria-invalid')).toBe('true');
    expect(noteBox().value).toBe('Not for us.');
    expect(screen.queryByText('A note is required to reject') === null).toBe(true);
    expect(rejectButton().disabled).toBe(false);
  });
});

describe('deciding: in flight', () => {
  test('every mutation button, the note and Back are locked while the request runs, and one click sends one request', async () => {
    const user = userEvent.setup();
    const held = deferred();
    serve({ decide: [() => held.promise] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(approveButton());
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));

    expect(approveButton().disabled).toBe(true);
    expect(approveButton().getAttribute('aria-busy')).toBe('true');
    expect(changesButton().disabled).toBe(true);
    expect(rejectButton().disabled).toBe(true);
    expect(backButton().disabled).toBe(true);
    expect(noteBox().disabled || noteBox().readOnly).toBe(true);
    await user.click(approveButton());
    await user.click(rejectButton());
    expect(decisionCalls()).toHaveLength(1);

    held.release(json(approvedResponse(NEW_ITEM)));
    await screen.findByText('Approved. The method is now in the commons.');
    expect(backButton().disabled).toBe(false);
  });
});

describe('deciding: failures', () => {
  test('a server error says the decision was not saved, keeps the form and the note, and can be tried again', async () => {
    const user = userEvent.setup();
    serve({ decide: [() => problem(500, 'Boom'), () => json(decidedResponse(NEW_ITEM, 'rejected', 'Not for us.'))] });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());

    const alert = await screen.findByText('The decision was not saved');
    expect(text(alert.closest('[role="alert"]')!)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(noteBox().value).toBe('Not for us.');
    expect(approveButton().disabled).toBe(false);
    expect(rejectButton().disabled).toBe(false);
    expect(backButton().disabled).toBe(false);
    // the list was not touched: still one list request, and the contribution is still pending
    expect(listCalls()).toHaveLength(1);
    expect(text(screen.getByRole('main'))).toContain('Pending');

    await user.click(rejectButton());
    await screen.findByText('Rejected. The coach can read your note.');
    expect(decisionCalls()).toHaveLength(2);
  });

  test('a 409 says nothing was saved, reads the queue again, and the contribution leaves the pending list', async () => {
    const user = userEvent.setup();
    const others = [IMPROVEMENT, DUPLICATE];
    serve({
      lists: { pending: [() => json(PENDING), () => json(others)] },
      decide: [() => problem(409, 'Conflict')],
    });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(approveButton());

    await screen.findByText(/Someone else has already dealt with this contribution/);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(decisionCalls()).toHaveLength(1);
    // no stale decision buttons once the queue has been read again
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' }) === null).toBe(true));
    expect(text(screen.getByRole('main'))).toContain('no longer in this list');

    await user.click(backButton());
    await screen.findByRole('list', { name: 'Contributions' });
    expect(titles()).toEqual(['Wall passes', 'Cone slalom again']);
  });

  test('a 404 (the contribution is gone) is handled like a 409: nothing saved, queue read again', async () => {
    const user = userEvent.setup();
    serve({
      lists: { pending: [() => json(PENDING), () => json([IMPROVEMENT, DUPLICATE])] },
      decide: [() => problem(404, 'Not Found')],
    });
    await renderLoaded();
    await openReview(user, 'Cone slalom');
    await user.click(rejectButton());
    // a blank note stops the reject on the screen, so give it one
    await user.type(noteBox(), 'Not for us.');
    await user.click(rejectButton());
    await screen.findByText(/Someone else has already dealt with this contribution/);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });
});

// --- languages ----------------------------------------------------------------------------------

describe.each(['kk', 'ru'] as const)('%s', (locale) => {
  test('the list, the tabs and the empty state are in that language, in Cyrillic, with no leaked key or value', async () => {
    const user = userEvent.setup();
    await renderLoaded(locale);
    const chrome = text(screen.getByRole('main'));
    expect(CYRILLIC.test(chrome)).toBe(true);
    for (const leak of LEAKS) expect(chrome).not.toContain(leak);
    expect(screen.getByRole('heading', { level: 1, name: messages[locale].title })).toBeTruthy();
    for (const state of ['pending', 'changes_requested', 'approved', 'rejected'] as const) {
      expect(screen.getByRole('tab', { name: messages[locale].tabs[state] })).toBeTruthy();
    }

    await user.click(screen.getByRole('tab', { name: messages[locale].tabs.rejected }));
    await waitFor(() => expect(screen.queryByRole('list', { name: messages[locale].list }) === null).toBe(true));
    const empty = text(screen.getByRole('tabpanel'));
    expect(CYRILLIC.test(empty)).toBe(true);
    for (const leak of LEAKS) expect(empty).not.toContain(leak);
  });

  test('the review, the diff and the decision form are in that language too', async () => {
    const user = userEvent.setup();
    await renderLoaded(locale);
    await user.click(screen.getAllByRole('button', { name: /Wall passes/ })[0]!);
    await screen.findByRole('heading', { level: 1, name: 'Wall passes' });
    const page = text(screen.getByRole('main'));
    expect(CYRILLIC.test(page)).toBe(true);
    for (const leak of LEAKS) expect(page).not.toContain(leak);
    expect(screen.getByRole('button', { name: messages[locale].review.back })).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(4);
  });
});

describe('en', () => {
  test('the list and a review of an improvement leak no key, placeholder or raw value', async () => {
    const user = userEvent.setup();
    await renderLoaded('en');
    const list = text(screen.getByRole('main'));
    for (const leak of LEAKS) expect(list).not.toContain(leak);
    await openReview(user, 'Wall passes');
    const page = text(screen.getByRole('main'));
    for (const leak of LEAKS) expect(page).not.toContain(leak);
  });
});
