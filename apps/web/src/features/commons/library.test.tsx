import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrillListResponse, DrillSummary } from '@api-types/commons';
import { type Locale, type LocalizedText, EQUIPMENT, EXPERIENCE_LEVELS, TRUST_STATUSES } from '@api-types/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import detailMessages from './detail.messages';
import messages from './library.messages';
import trustMessages from './trust-badge.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as detail.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the route only now, after happy-dom is registered (the same rule as detail.test.tsx).
const { Route } = await import('../../routes/commons/index');

/*
 * The drill library screen (/commons), written from the bead's acceptance criteria (fc-mol-hum.4):
 *  - lists the drills of GET /api/commons/drills as cards: title, track, level, minutes, equipment, age, TrustBadge, source and
 *    licence (all of them from the list itself, the extension of fc-mol-hum.6);
 *  - filters for track, status, equipment and level whose options are the FACETS of the response (no hard-coded enums), plus a
 *    text search; the filters live in the URL search params (TanStack Router validateSearch), so a filtered view is shareable;
 *  - header: the "Sport knowledge as public infrastructure" intro, "Download Commons JSON" (export.json), "Contribute a method";
 *  - an empty result shows an EmptyState with "clear filters";
 *  - loading, empty, error, disabled and success states; every string in kk, ru and en.
 * The only stand-in is the network (globalThis.fetch): a small fake of the list endpoint that filters, pages and computes
 * facets over the filtered set like the real one, so the screen runs through the real typed client and React Query. The
 * route is mounted in a real (memory-history) router. Fixtures are parsed with the shared contract schemas, so they cannot
 * drift from the API. Kazakh copy needs a native review; the Kazakh assertions pin few strings.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const GENESIS = 'FIRST COACH Community Draft';

const SKILL_NAMES: Record<string, LocalizedText> = {
  'ball-mastery': { kk: 'Допты меңгеру', ru: 'Владение мячом', en: 'Ball mastery' },
  passing: { kk: 'Пас беру', ru: 'Передачи', en: 'Passing' },
  dribbling: { kk: 'Жүргізу', ru: 'Ведение', en: 'Dribbling' },
};

const TITLES: Record<string, LocalizedText> = {
  'ghost-ball': { kk: 'Елес доп', ru: 'Воображаемый мяч', en: 'Ghost Ball' },
  'wall-passing': { kk: 'Қабырғаға пас', ru: 'Пас в стену', en: 'Wall Passing' },
  'cone-weave': { kk: 'Конус арасында жүру', ru: 'Змейка между конусами', en: 'Cone Weave' },
  'juggling-basics': { kk: 'Допты ұстау негіздері', ru: 'Основы жонглирования', en: 'Juggling Basics' },
  'pitch-shuttle': { kk: 'Алаңдағы жүгіру', ru: 'Челнок по полю', en: 'Pitch Shuttle' },
};

const summary = (input: Record<string, unknown>): DrillSummary => DrillSummary.parse({ versionId: `ver-${input.slug}`, space: 'yard', ...input });

const DRILLS: DrillSummary[] = [
  summary({
    slug: 'ghost-ball',
    title: TITLES['ghost-ball'],
    track: 'ball-mastery',
    level: 'beginner',
    minutes: 10,
    equipment: 'nothing',
    status: 'COMMUNITY',
    ageMin: 5,
    ageMax: 99,
    source: GENESIS,
    license: 'CC-BY-SA-4.0',
  }),
  summary({
    slug: 'wall-passing',
    title: TITLES['wall-passing'],
    track: 'passing',
    level: 'basic',
    minutes: 15,
    equipment: 'ball_wall',
    status: 'EXPERT_VERIFIED',
    ageMin: 8,
    ageMax: 12,
    source: 'Test Source Book',
    license: 'CC-BY-4.0',
    orgLabel: 'Test Academy',
  }),
  // The older shape: no age, no source, no licence, no organisation.
  summary({
    slug: 'cone-weave',
    title: TITLES['cone-weave'],
    track: 'dribbling',
    level: 'intermediate',
    minutes: 20,
    equipment: 'cones',
    status: 'REVIEWED',
  }),
  summary({
    slug: 'juggling-basics',
    title: TITLES['juggling-basics'],
    track: 'ball-mastery',
    level: 'beginner',
    minutes: 8,
    equipment: 'ball',
    status: 'COMMUNITY',
    ageMin: 6,
    source: GENESIS,
    license: 'CC-BY-SA-4.0',
  }),
  summary({
    slug: 'pitch-shuttle',
    title: TITLES['pitch-shuttle'],
    track: 'dribbling',
    level: 'intermediate',
    minutes: 25,
    equipment: 'full_field',
    status: 'ACADEMY_VERIFIED',
    ageMax: 12,
    source: 'Kairat Academy Handbook',
    license: 'CC0-1.0',
    orgLabel: 'Kairat Academy',
  }),
];

const titleOf = (drill: DrillSummary, locale: Locale): string => (drill.title as Record<string, string | undefined>)[locale] ?? '';

// --- the network: a small fake of GET /api/commons/drills -----------------------------------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number) => json({ type: 'about:blank', title: 'Problem', status }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** How many drills the fake returns per page (the real default is 20). */
let pageSize = 20;

/** The real endpoint in miniature: filters, sorts by title, pages with an opaque cursor, and counts facets over the FILTERED set. */
function serve(url: URL): DrillListResponse {
  const query = url.searchParams;
  const locale = (query.get('locale') ?? 'ru') as Locale;
  const needle = (query.get('q') ?? '').trim().toLowerCase();
  const matching = DRILLS.filter(
    (drill) =>
      (query.get('skill') === null || drill.track === query.get('skill')) &&
      (query.get('status') === null || drill.status === query.get('status')) &&
      (query.get('equipment') === null || drill.equipment === query.get('equipment')) &&
      (query.get('level') === null || drill.level === query.get('level')) &&
      (needle === '' || titleOf(drill, locale).toLowerCase().includes(needle)),
  ).sort((a, b) => titleOf(a, 'en').localeCompare(titleOf(b, 'en')));

  const from = Number(query.get('cursor') ?? '0');
  const page = matching.slice(from, from + pageSize);
  const tracks = [...new Set(matching.map((drill) => drill.track))];
  const count = (value: string, pick: (drill: DrillSummary) => string) => matching.filter((drill) => pick(drill) === value).length;
  const facet = <T extends string>(order: readonly T[], pick: (drill: DrillSummary) => string) =>
    order.map((value) => ({ value, count: count(value, pick) })).filter((entry) => entry.count > 0);

  return DrillListResponse.parse({
    items: page,
    nextCursor: from + pageSize < matching.length ? String(from + pageSize) : null,
    total: matching.length,
    facets: {
      // Like the real API: most drills first, then by slug.
      skills: tracks
        .map((slug) => ({ slug, names: { [locale]: SKILL_NAMES[slug]?.[locale] }, count: count(slug, (drill) => drill.track) }))
        .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)),
      statuses: facet(TRUST_STATUSES, (drill) => drill.status),
      equipment: facet(EQUIPMENT, (drill) => drill.equipment),
      levels: facet(EXPERIENCE_LEVELS, (drill) => drill.level),
    },
  });
}

type Call = { method: string; path: string; params: URLSearchParams; headers: Headers };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
/** The requests of the list endpoint only. */
const listCalls = (): Call[] => calls.filter((call) => call.path === '/api/commons/drills');

/** Every request lands here; only the list endpoint is answered (anything else is a 404 the test would notice). */
function stubNetwork(answer: (url: URL) => Response | Promise<Response> = (url) => json(serve(url))): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, headers: new Headers(init?.headers) });
    if (url.pathname === '/api/commons/drills') return answer(url);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  pageSize = 20;
  stubNetwork();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './library.messages.ts': { default: messages },
  './trust-badge.messages.ts': { default: trustMessages },
  './detail.messages.ts': { default: detailMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

type RenderOptions = { locale?: Locale; search?: string };

/** The route in a real router at /commons (the way the file route mounts it), with a stand-in for the drill detail it links to. */
async function renderLibrary({ locale = 'en', search = '' }: RenderOptions = {}) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  const rootRoute = createRootRoute();
  const libraryRoute = Route.update({ id: '/commons', path: '/commons', getParentRoute: () => rootRoute } as never);
  const detail = createRoute({ getParentRoute: () => rootRoute, path: '/commons/$slug', component: () => <p>DETAIL STAND-IN</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([libraryRoute as never, detail as never]),
    history: createMemoryHistory({ initialEntries: [`/commons${search}`] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user: userEvent.setup() };
}

/** Renders and waits for the first card (the h1 is there in every state, so the wait is for a drill). */
async function renderLoaded(options: RenderOptions = {}) {
  const view = await renderLibrary(options);
  await screen.findAllByRole('heading', { level: 2 });
  return view;
}

const cardOf = (title: string): HTMLElement => screen.getByRole('heading', { level: 2, name: title }).closest('li') as HTMLElement;
const titlesOnScreen = (): string[] => screen.queryAllByRole('heading', { level: 2 }).map((each) => each.textContent ?? '');
const select = (label: string): HTMLSelectElement => screen.getByLabelText(label) as HTMLSelectElement;
const optionsOf = (control: HTMLElement): string[] => within(control).getAllByRole('option').map((option) => option.textContent ?? '');

// --- success: the header, the cards ----------------------------------------------------------------------------------

describe('the loaded screen', () => {
  test('makes one call, GET /api/commons/drills, in the active language and with no filter', async () => {
    await renderLoaded({ locale: 'ru' });
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.method).toBe('GET');
    expect(listCalls()[0]?.params.get('locale')).toBe('ru');
    for (const key of ['skill', 'status', 'equipment', 'level', 'q', 'cursor']) expect(listCalls()[0]?.params.has(key)).toBe(false);
  });

  test('the h1 is the "Sport knowledge as public infrastructure" intro, and there is exactly one', async () => {
    await renderLoaded();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sport knowledge as public infrastructure');
  });

  test('"Download Commons JSON" is a link to export.json and "Contribute a method" a link to the contribution flow', async () => {
    await renderLoaded();
    const download = screen.getByRole('link', { name: 'Download Commons JSON' });
    expect(download.getAttribute('href')).toBe('/api/commons/export.json');
    expect(download.hasAttribute('download')).toBe(true);
    const contribute = screen.getByRole('link', { name: 'Contribute a method' });
    expect(contribute.getAttribute('href')).toBe('/contribute');
  });

  test('lists every drill of the response as one card, in the order the API gave', async () => {
    await renderLoaded();
    expect(titlesOnScreen()).toEqual(['Cone Weave', 'Ghost Ball', 'Juggling Basics', 'Pitch Shuttle', 'Wall Passing']);
    expect(within(screen.getByRole('list', { name: 'Drills' })).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Showing 5 of 5')).toBeTruthy();
  });

  test('a card shows title, track, level, minutes, equipment, age, trust, source and licence', async () => {
    await renderLoaded();
    const card = within(cardOf('Wall Passing'));
    expect(card.getByText('Passing')).toBeTruthy(); // the track, by its localized name from the facets
    expect(card.getByText('Level: Basic')).toBeTruthy();
    expect(card.getByText('15 min')).toBeTruthy();
    expect(card.getByText('Equipment: Ball + wall')).toBeTruthy();
    expect(card.getByText('Age 8–12')).toBeTruthy();
    expect(card.getByText('Verified by Test Academy')).toBeTruthy(); // TrustBadge, with the organisation of the list item
    expect(card.getByText('Source: Test Source Book')).toBeTruthy();
    expect(card.getByText('Licence: CC BY 4.0')).toBeTruthy();
  });

  test('the title is a link to the drill detail', async () => {
    const { user, router } = await renderLoaded();
    const link = within(cardOf('Ghost Ball')).getByRole('link', { name: 'Ghost Ball' });
    expect(link.getAttribute('href')).toBe('/commons/ghost-ball');
    await user.click(link);
    await screen.findByText('DETAIL STAND-IN');
    expect(router.state.location.pathname).toBe('/commons/ghost-ball');
  });

  test('the trust badge follows the list item: the Genesis draft reads "Community Draft", a review status its own word', async () => {
    await renderLoaded();
    expect(within(cardOf('Ghost Ball')).getByText('Community Draft')).toBeTruthy();
    expect(within(cardOf('Cone Weave')).getByText('Reviewed')).toBeTruthy();
    expect(within(cardOf('Pitch Shuttle')).getByText('Verified by Kairat Academy')).toBeTruthy();
  });

  test('the seeded "no upper age limit" (99) reads as open-ended, never as a range to 99', async () => {
    await renderLoaded();
    const card = within(cardOf('Ghost Ball'));
    expect(card.getByText('Age from 5')).toBeTruthy();
    expect(card.queryByText(/99/)).toBeNull();
  });

  test('only one age bound is written as "from" or "up to"', async () => {
    await renderLoaded();
    expect(within(cardOf('Juggling Basics')).getByText('Age from 6')).toBeTruthy();
    expect(within(cardOf('Pitch Shuttle')).getByText('Age up to 12')).toBeTruthy();
  });

  test('a drill without age, source or licence shows none of them, and no "undefined"', async () => {
    await renderLoaded();
    const card = cardOf('Cone Weave');
    expect(within(card).queryByText(/^Age/)).toBeNull();
    expect(within(card).queryByText(/^Source:/)).toBeNull();
    expect(within(card).queryByText(/^Licence:/)).toBeNull();
    expect(card.textContent).not.toContain('undefined');
    expect(within(card).getByText('Level: Intermediate')).toBeTruthy();
  });

  test('the licence is written as a name, not as the API id', async () => {
    await renderLoaded();
    expect(within(cardOf('Ghost Ball')).getByText('Licence: CC BY-SA 4.0')).toBeTruthy();
    expect(within(cardOf('Pitch Shuttle')).getByText('Licence: CC0 1.0')).toBeTruthy();
    expect(within(cardOf('Ghost Ball')).queryByText(/CC-BY-SA-4\.0/)).toBeNull();
  });

  test('the list is cached under the persisted key ["commons", "list", ...]', async () => {
    const { queryClient } = await renderLoaded();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['commons', 'list'] }).length).toBeGreaterThan(0);
  });
});

// --- the filters: options are the facets ------------------------------------------------------------------------------

describe('filters built from the facets', () => {
  test('the four filters and the search are labelled controls', async () => {
    await renderLoaded();
    for (const label of ['Track', 'Status', 'Equipment', 'Level']) expect(select(label).tagName).toBe('SELECT');
    const box = screen.getByLabelText('Search drills') as HTMLInputElement;
    expect(box.tagName).toBe('INPUT');
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
  });

  test('every facet value is an option, after "All", labelled in the active language', async () => {
    await renderLoaded();
    expect(optionsOf(select('Track'))).toEqual(['All', 'Ball mastery', 'Dribbling', 'Passing']);
    expect(optionsOf(select('Status'))).toEqual(['All', 'Community', 'Reviewed', 'Expert verified', 'Academy verified']);
    expect(optionsOf(select('Equipment'))).toEqual(['All', 'Nothing', 'Ball', 'Ball + wall', 'Cones', 'Full field']);
    expect(optionsOf(select('Level'))).toEqual(['All', 'Beginner', 'Basic', 'Intermediate']);
  });

  test('option values are the API values (track slug, status code), so they go to the API untouched', async () => {
    await renderLoaded();
    const values = (control: HTMLElement) => within(control).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
    expect(values(select('Track'))).toEqual(['', 'ball-mastery', 'dribbling', 'passing']);
    expect(values(select('Status'))).toContain('EXPERT_VERIFIED');
  });

  test('a value the response does not list is not offered: the options come from the facets, not from the enums', async () => {
    stubNetwork((url) => {
      const only = serve(url);
      return json({
        ...only,
        items: only.items.filter((drill) => drill.status === 'COMMUNITY'),
        total: 2,
        facets: {
          ...only.facets,
          statuses: [{ value: 'COMMUNITY', count: 2 }],
          equipment: [{ value: 'ball', count: 2 }],
          levels: [{ value: 'beginner', count: 2 }],
        },
      });
    });
    await renderLoaded();
    expect(optionsOf(select('Status'))).toEqual(['All', 'Community']);
    expect(optionsOf(select('Equipment'))).toEqual(['All', 'Ball']);
    expect(optionsOf(select('Level'))).toEqual(['All', 'Beginner']);
  });

  test('every control is disabled, and says so, until the first answer brings the facets', async () => {
    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    await renderLibrary();
    await screen.findByRole('status', { name: 'Loading drills…' });
    for (const label of ['Track', 'Status', 'Equipment', 'Level']) expect(select(label).disabled).toBe(true);
    gate.resolve(json(serve(new URL('http://localhost/api/commons/drills'))));
    await screen.findByRole('heading', { level: 2, name: 'Ghost Ball' });
    for (const label of ['Track', 'Status', 'Equipment', 'Level']) expect(select(label).disabled).toBe(false);
  });
});

// --- the filters: refetch with the right query, and the URL --------------------------------------------------------

describe('changing a filter', () => {
  test('refetches with exactly that filter and shows the narrowed list', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    const second = listCalls()[1]?.params;
    expect(second?.get('status')).toBe('REVIEWED');
    expect(second?.get('locale')).toBe('en');
    for (const key of ['skill', 'equipment', 'level', 'q', 'cursor']) expect(second?.has(key)).toBe(false);
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    expect(screen.getByText('Showing 1 of 1')).toBeTruthy();
  });

  test('each of track, equipment and level maps to its own query parameter (track is "skill")', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Track'), 'Dribbling');
    await waitFor(() => expect(listCalls().at(-1)?.params.get('skill')).toBe('dribbling'));
    await user.selectOptions(select('Equipment'), 'Cones');
    await waitFor(() => expect(listCalls().at(-1)?.params.get('equipment')).toBe('cones'));
    await user.selectOptions(select('Level'), 'Intermediate');
    await waitFor(() => expect(listCalls().at(-1)?.params.get('level')).toBe('intermediate'));
    // The earlier filters are still applied: the filters combine.
    const last = listCalls().at(-1)?.params;
    expect(last?.get('skill')).toBe('dribbling');
    expect(last?.get('equipment')).toBe('cones');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
  });

  test('choosing "All" again removes that filter from the request', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    await user.selectOptions(select('Status'), 'All');
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(5));
    expect(listCalls().at(-1)?.params.has('status')).toBe(false);
  });

  test('the options seen earlier stay available after the facets narrow, so the filter can be switched in one step', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    // The response now lists only REVIEWED, yet every other status is still a choice.
    expect(optionsOf(select('Status'))).toEqual(['All', 'Community', 'Reviewed', 'Expert verified', 'Academy verified']);
    expect(select('Status').value).toBe('REVIEWED');
    await user.selectOptions(select('Status'), 'Community');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Ghost Ball', 'Juggling Basics']));
  });

  test('a search is sent when submitted (button or Enter), trimmed, and an empty search removes q', async () => {
    const { user } = await renderLoaded();
    const box = screen.getByLabelText('Search drills');
    await user.type(box, '  wall ');
    expect(listCalls()).toHaveLength(1); // typing alone does not send a request per keystroke
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(listCalls().at(-1)?.params.get('q')).toBe('wall'));
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Wall Passing']));

    await user.clear(box);
    await user.type(box, 'ghost{Enter}');
    await waitFor(() => expect(listCalls().at(-1)?.params.get('q')).toBe('ghost'));
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Ghost Ball']));

    await user.clear(box);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(listCalls().at(-1)?.params.has('q')).toBe(false));
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(5));
  });

  test('the filters and the search are kept in the URL, so a filtered view can be shared', async () => {
    const { user, router } = await renderLoaded();
    await user.selectOptions(select('Level'), 'Beginner');
    await waitFor(() => expect(router.state.location.search).toEqual({ level: 'beginner' }));
    await user.selectOptions(select('Track'), 'Ball mastery');
    await waitFor(() => expect(router.state.location.search).toEqual({ level: 'beginner', skill: 'ball-mastery' }));
    await user.type(screen.getByLabelText('Search drills'), 'ghost{Enter}');
    await waitFor(() => expect(router.state.location.search).toEqual({ level: 'beginner', skill: 'ball-mastery', q: 'ghost' }));
    expect(router.state.location.pathname).toBe('/commons');
    expect(router.state.location.searchStr).toContain('level=beginner');
  });

  test('opening a shared URL applies it: the request, the selects and the search box all show the filters', async () => {
    await renderLoaded({ search: '?status=REVIEWED&level=intermediate&q=cone' });
    expect(listCalls()[0]?.params.get('status')).toBe('REVIEWED');
    expect(listCalls()[0]?.params.get('level')).toBe('intermediate');
    expect(listCalls()[0]?.params.get('q')).toBe('cone');
    expect(select('Status').value).toBe('REVIEWED');
    expect(select('Level').value).toBe('intermediate');
    expect((screen.getByLabelText('Search drills') as HTMLInputElement).value).toBe('cone');
    expect(titlesOnScreen()).toEqual(['Cone Weave']);
  });

  test('a value in the URL that no filter can have is dropped instead of becoming a failing request', async () => {
    await renderLoaded({ search: '?status=BOGUS&level=expert&equipment=jetpack&colour=blue' });
    const params = listCalls()[0]?.params;
    expect(params?.has('status')).toBe(false);
    expect(params?.has('equipment')).toBe(false);
    expect(params?.has('colour')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(titlesOnScreen().length).toBeGreaterThan(0);
  });

  test('the Route validates its search: known filters are kept, anything else is dropped', () => {
    const validate = Route.options.validateSearch as (input: Record<string, unknown>) => Record<string, unknown>;
    expect(validate({ skill: 'passing', status: 'REVIEWED', equipment: 'cones', level: 'basic', q: 'wall' })).toEqual({
      skill: 'passing',
      status: 'REVIEWED',
      equipment: 'cones',
      level: 'basic',
      q: 'wall',
    });
    expect(validate({ status: 'NOPE', level: 7, q: '', extra: 'x' })).toEqual({});
    // The default search parser turns "?q=2024" into the number 2024: a search for digits must survive it.
    expect(validate({ q: 2024 })).toEqual({ q: '2024' });
    expect(validate({})).toEqual({});
  });
});

// --- pages ---------------------------------------------------------------------------------------------------------------

describe('paging', () => {
  test('"Show more drills" asks for the page the cursor points to, adds it to the list and goes away at the end', async () => {
    pageSize = 2;
    const { user } = await renderLoaded();
    expect(titlesOnScreen()).toEqual(['Cone Weave', 'Ghost Ball']);
    expect(screen.getByText('Showing 2 of 5')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Show more drills' }));
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(4));
    expect(listCalls().at(-1)?.params.get('cursor')).toBe('2');
    expect(titlesOnScreen()).toEqual(['Cone Weave', 'Ghost Ball', 'Juggling Basics', 'Pitch Shuttle']);
    expect(screen.getByText('Showing 4 of 5')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Show more drills' }));
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(5));
    expect(screen.queryByRole('button', { name: 'Show more drills' })).toBeNull();
  });

  test('with no next page there is no "Show more" button', async () => {
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'Show more drills' })).toBeNull();
  });

  test('"Show more" is disabled (natively) and busy while its request runs', async () => {
    pageSize = 2;
    const gate = deferred<Response>();
    const { user } = await renderLoaded();
    stubNetwork((url) => (url.searchParams.has('cursor') ? gate.promise : json(serve(url))));
    await user.click(screen.getByRole('button', { name: 'Show more drills' }));
    const more = screen.getByRole('button', { name: 'Show more drills' }) as HTMLButtonElement;
    await waitFor(() => expect(more.disabled).toBe(true));
    expect(more.getAttribute('aria-busy')).toBe('true');
    expect(titlesOnScreen()).toHaveLength(2); // the cards already there stay

    const next = new URL('http://localhost/api/commons/drills?locale=en&cursor=2');
    gate.resolve(json(serve(next)));
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(4));
  });

  test('a failing next page keeps the cards, says so in words, and can be retried', async () => {
    pageSize = 2;
    const { user } = await renderLoaded();
    let fail = true;
    stubNetwork((url) => (url.searchParams.has('cursor') && fail ? problem(500) : json(serve(url))));
    await user.click(screen.getByRole('button', { name: 'Show more drills' }));
    await screen.findByText('Something went wrong on our side. Try again in a moment.');
    expect(titlesOnScreen()).toEqual(['Cone Weave', 'Ghost Ball']);

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(titlesOnScreen()).toHaveLength(4));
    expect(screen.queryByText('Something went wrong on our side. Try again in a moment.')).toBeNull();
  });
});

// --- the other states -----------------------------------------------------------------------------------------------------

describe('loading', () => {
  test('is a named busy status under the header until the answer arrives, then the cards replace it', async () => {
    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    await renderLibrary();
    const busy = await screen.findByRole('status', { name: 'Loading drills…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sport knowledge as public infrastructure');
    expect(screen.getByRole('link', { name: 'Download Commons JSON' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();

    gate.resolve(json(serve(new URL('http://localhost/api/commons/drills'))));
    await screen.findByRole('heading', { level: 2, name: 'Ghost Ball' });
    expect(screen.queryByRole('status', { name: 'Loading drills…' })).toBeNull();
  });

  test('a filter change keeps the earlier cards on screen, marked busy, until the new answer arrives', async () => {
    const { user } = await renderLoaded();
    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(titlesOnScreen()).toHaveLength(5);
    expect(screen.getByRole('list', { name: 'Drills' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Updating…')).toBeTruthy();

    gate.resolve(json(serve(new URL('http://localhost/api/commons/drills?locale=en&status=REVIEWED'))));
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    expect(screen.getByRole('list', { name: 'Drills' }).getAttribute('aria-busy')).not.toBe('true');
  });
});

describe('an empty result', () => {
  test('with filters on, says nothing matches and offers "Clear filters"', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    await user.selectOptions(select('Level'), 'Beginner'); // no reviewed beginner drill exists
    await screen.findByText('No drills match these filters');
    expect(screen.getByText('Try fewer filters or a different word.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  test('the filters and the search stay visible, with the current values, so one of them can be loosened', async () => {
    const { user } = await renderLoaded();
    await user.selectOptions(select('Status'), 'Reviewed');
    await waitFor(() => expect(titlesOnScreen()).toEqual(['Cone Weave']));
    await user.selectOptions(select('Level'), 'Beginner');
    await screen.findByText('No drills match these filters');
    // The empty response lists no facets at all; the chosen values are still there to read and to change.
    expect(select('Status').value).toBe('REVIEWED');
    expect(select('Level').value).toBe('beginner');
    expect(optionsOf(select('Level'))).toContain('Beginner');
  });

  test('"Clear filters" removes every filter and the search from the request and the URL, and the drills come back', async () => {
    const { user, router } = await renderLibrary({ search: '?status=REVIEWED&level=beginner&q=zzz' });
    await screen.findByText('No drills match these filters');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByRole('heading', { level: 2, name: 'Ghost Ball' });
    const last = listCalls().at(-1)?.params;
    for (const key of ['skill', 'status', 'equipment', 'level', 'q']) expect(last?.has(key)).toBe(false);
    expect(router.state.location.search).toEqual({});
    expect(select('Status').value).toBe('');
    expect((screen.getByLabelText('Search drills') as HTMLInputElement).value).toBe('');
  });

  test('with no filter on, an empty commons is said in its own words and has nothing to clear', async () => {
    stubNetwork(() => json({ items: [], nextCursor: null, total: 0, facets: { skills: [], statuses: [], equipment: [], levels: [] } }));
    await renderLibrary();
    await screen.findByText('No drills are published yet');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(screen.queryByText('No drills match these filters')).toBeNull();
  });
});

describe('an error', () => {
  test('a server failure shows generic words and Try again, never the server text; the header stays', async () => {
    stubNetwork(() => json({ type: 'about:blank', title: 'SECRET-BOOM', detail: 'stack trace here', status: 500 }, 500, 'application/problem+json'));
    await renderLibrary();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The drills did not load')).toBeTruthy();
    expect(alert.textContent).not.toContain('SECRET-BOOM');
    expect(alert.textContent).not.toContain('stack trace');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  test('a body that is not a drill list is an error too, not a half-drawn screen', async () => {
    stubNetwork(() => json({ items: 'nope' }));
    await renderLibrary();
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  test('Try again is disabled (natively) and busy while the request runs, and the cards appear when it works', async () => {
    let attempt = 0;
    const gate = deferred<Response>();
    stubNetwork((url) => {
      attempt += 1;
      return attempt === 1 ? problem(500) : gate.promise.then(() => json(serve(url)));
    });
    const { user } = await renderLibrary();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    const retry = (await screen.findByRole('button', { name: 'Try again' })) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(true));
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('alert')).toBeTruthy(); // the failure stays put, no flash to skeletons
    expect(listCalls()).toHaveLength(2);

    gate.resolve(new Response());
    await screen.findByRole('heading', { level: 2, name: 'Ghost Ball' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('offline says so in the words of the shared problem messages', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await renderLibrary();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/connection|Check your internet/i);
  });

  test('the selects are disabled while no facets have arrived, and are usable once the retry brings them', async () => {
    let attempt = 0;
    stubNetwork((url) => {
      attempt += 1;
      return attempt === 1 ? problem(500) : json(serve(url));
    });
    const { user } = await renderLibrary();
    await screen.findByRole('alert');
    expect(select('Status').disabled).toBe(true); // nothing to choose from yet: no facets came
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 2, name: 'Ghost Ball' });
    expect(select('Status').disabled).toBe(false);
  });
});

// --- languages ----------------------------------------------------------------------------------------------------------

// Natural forms for each language. Kazakh still needs the scheduled native review; these are the shipped strings.
const WORDS: Record<Locale, { h1: string; download: string; contribute: string; status: string; all: string; level: string; loading: string; clear: string; empty: string }> = {
  en: {
    h1: 'Sport knowledge as public infrastructure',
    download: 'Download Commons JSON',
    contribute: 'Contribute a method',
    status: 'Status',
    all: 'All',
    level: 'Level: Beginner',
    loading: 'Loading drills…',
    clear: 'Clear filters',
    empty: 'No drills match these filters',
  },
  ru: {
    h1: 'Спортивные знания как общественная инфраструктура',
    download: 'Скачать Commons JSON',
    contribute: 'Предложить метод',
    status: 'Статус',
    all: 'Все',
    level: 'Уровень: Начальный',
    loading: 'Загружаем упражнения…',
    clear: 'Сбросить фильтры',
    empty: 'Нет упражнений по этим фильтрам',
  },
  kk: {
    h1: 'Спорт білімі — қоғамдық инфрақұрылым',
    download: 'Commons JSON жүктеу',
    contribute: 'Әдіс ұсыну',
    status: 'Мәртебе',
    all: 'Барлығы',
    level: 'Деңгейі: Бастаушы',
    loading: 'Жаттығуларды жүктеп жатырмыз…',
    clear: 'Сүзгілерді тазалау',
    empty: 'Бұл сүзгілерге сәйкес жаттығу жоқ',
  },
};

for (const locale of LOCALES) describe(`in ${locale}`, () => {
  const words = WORDS[locale];

  test('asks for the drills in this language and shows the header, the filter and the cards in it', async () => {
    await renderLoaded({ locale });
    expect(listCalls()[0]?.params.get('locale')).toBe(locale);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(words.h1);
    expect(screen.getByRole('link', { name: words.download })).toBeTruthy();
    expect(screen.getByRole('link', { name: words.contribute })).toBeTruthy();
    expect(optionsOf(select(words.status))[0]).toBe(words.all);
    expect(within(cardOf(titleOf(DRILLS[0] as DrillSummary, locale))).getByText(words.level)).toBeTruthy();
    // The track, from the facets, comes in the same language.
    expect(within(cardOf(titleOf(DRILLS[0] as DrillSummary, locale))).getByText(SKILL_NAMES['ball-mastery']?.[locale] as string)).toBeTruthy();
  });

  test('no message key or "undefined" leaks onto the screen', async () => {
    await renderLoaded({ locale });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/\blibrary\.|trust-badge:|\{\{/);
  });

  test('the loading and the empty words are in this language', async () => {
    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    const first = await renderLibrary({ locale });
    expect(await screen.findByRole('status', { name: words.loading })).toBeTruthy();
    first.unmount();

    stubNetwork(() => json({ items: [], nextCursor: null, total: 0, facets: { skills: [], statuses: [], equipment: [], levels: [] } }));
    await renderLibrary({ locale, search: '?q=zzz' });
    expect(await screen.findByText(words.empty)).toBeTruthy();
    expect(screen.getByRole('button', { name: words.clear })).toBeTruthy();
  });
});
