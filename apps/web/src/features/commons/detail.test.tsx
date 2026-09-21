import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrillDetail } from '@api-types/commons';
import { EQUIPMENT, SPACES } from '@api-types/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import messages from './detail.messages';
import trustMessages from './trust-badge.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as plan.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the route only now, after happy-dom is registered (the same rule as plan.test.tsx).
const { DrillDetailDepsContext, Route } = await import('../../routes/commons/$slug');

/*
 * The drill detail screen (/commons/:slug), written from the bead's acceptance criteria (fc-mol-hum.5):
 *  - shows one drill from GET /api/commons/drills/:slug: goal, numbered instructions, reps/time, common mistakes, progression,
 *    regression, required conditions (equipment, space, partner, age), safety, optional video (lazy, never autoplay),
 *    TrustBadge with reviewers, attribution block (author, source link, licence, date, semver) and a version history list
 *    where an older version can be opened read-only;
 *  - renders every component of the drill-detail slot below the content;
 *  - an unknown slug shows the not-found state;
 *  - loading, empty, error, disabled and success states; every string in kk, ru and en.
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch). The route is mounted in a real (memory-history) router. Fixtures are parsed with the shared contract
 * schema, so they cannot drift from the API. Kazakh copy needs a native review; the Kazakh assertions pin few strings.
 *
 * Known API gaps the tests do NOT paper over (backlog fc-3vc and fc-h2p): the history has no "unpublished" marker and the text
 * of a superseded version cannot be read, so opening an older version shows only what the history entry says.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const SLUG = 'ball-mastery-ghost-ball';

const INPUT = {
  slug: SLUG,
  versionId: 'ver-3',
  content: {
    title: { kk: 'Елес доп', ru: 'Воображаемый мяч', en: 'Ghost Ball' },
    goal: {
      kk: 'Нағыз допқа көшпес бұрын жұмсақ жанасуға үйрен.',
      ru: 'Привыкни к мягким касаниям ещё до настоящего мяча.',
      en: 'Get used to soft, quiet foot touches before you use a real ball.',
    },
    instructions: {
      kk: '1. Түзу тұр.\n2. Елес допты түрт.\n3. Бүйірге жылжыт.\n4. Бір аяқта тұр.',
      ru: '1. Встань прямо.\n2. Постучи по воображаемому мячу.\n3. Сдвинь мяч в сторону.\n4. Постой на одной ноге.',
      en: '1. Stand tall with your knees a little bent.\n2. Tap the pretend ball softly.\n3. Slide the pretend ball sideways.\n4. Finish on one leg for a slow count of three.',
    },
    dose: { reps: 10, sets: 2 },
    mistakes: [{ en: 'You stamp your foot down.' }, { en: 'Your shoulders are lifted.' }],
    progressions: [{ en: 'Try it with a real ball.' }],
    regressions: [{ en: 'Hold a chair while you balance.' }],
    conditions: { equipment: 'nothing', spaces: ['home_3x3', 'yard'], partner: false, ageMin: 5, ageMax: 99 },
    safety: [{ en: 'Shake out both ankles before you start.' }, { en: 'Stand next to a sturdy chair.' }],
    media: [{ kind: 'video', url: '/media/ghost-ball.mp4', caption: { en: 'Ghost Ball from the side' } }],
  },
  attribution: {
    author: 'Test Author',
    source: 'Test Source Book',
    sourceUrl: 'https://example.org/ghost-ball',
    license: 'CC-BY-SA-4.0',
    createdAt: '2026-05-12T10:00:00.000Z',
    semver: '1.2.0',
  },
  history: [
    { versionId: 'ver-3', semver: '1.2.0', createdAt: '2026-05-12T10:00:00.000Z', note: 'Added a video.' },
    { versionId: 'ver-2', semver: '1.1.0', createdAt: '2026-03-02T09:00:00.000Z', note: 'Clearer step three.' },
    { versionId: 'ver-1', semver: '1.0.0', createdAt: '2026-01-15T08:00:00.000Z' },
  ],
  reviews: [
    {
      reviewer: 'Test Reviewer',
      orgLabel: 'Test Academy',
      from: 'REVIEWED',
      to: 'EXPERT_VERIFIED',
      note: 'Safe for age six and up.',
      at: '2026-05-20T12:00:00.000Z',
    },
    {
      reviewer: 'Volunteer Coach',
      orgLabel: 'Community group',
      from: 'COMMUNITY',
      to: 'REVIEWED',
      note: 'Tried with an under-8 group.',
      at: '2026-02-01T12:00:00.000Z',
    },
  ],
};

type Input = typeof INPUT;

/** A parsed copy of the fixture with `edit` applied to the raw input first. */
function drill(edit: (draft: Input) => void = () => {}): DrillDetail {
  const draft = structuredClone(INPUT);
  edit(draft);
  return DrillDetail.parse(draft);
}

const DRILL = drill();

// --- the network --------------------------------------------------------------------------------

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

type Call = { method: string; path: string; search: string; headers: Headers };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Every request lands here; only the drill endpoint is answered (anything else is a 404 the test would notice). */
function stubNetwork(answer: () => Response | Promise<Response> = () => json(DRILL)): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, headers: new Headers(init?.headers) });
    if (url.pathname.startsWith('/api/commons/drills/')) return answer();
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => stubNetwork());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './detail.messages.ts': { default: messages },
  './trust-badge.messages.ts': { default: trustMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

type RenderOptions = { locale?: Locale; slug?: string; slots?: readonly ComponentType[] };

/** The route in a real router at /commons/:slug, with a stand-in for the library it links back to. */
async function renderDetail({ locale = 'en', slug = SLUG, slots }: RenderOptions = {}) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  const rootRoute = createRootRoute();
  const detailRoute = Route.update({ id: '/commons/$slug', path: '/commons/$slug', getParentRoute: () => rootRoute } as never);
  const library = createRoute({ getParentRoute: () => rootRoute, path: '/commons', component: () => <p>LIBRARY STAND-IN</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute as never, library as never]),
    history: createMemoryHistory({ initialEntries: [`/commons/${encodeURIComponent(slug)}`] }),
  });
  await router.load();
  const tree = (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  const view = render(slots === undefined ? tree : <DrillDetailDepsContext.Provider value={{ slots }}>{tree}</DrillDetailDepsContext.Provider>);
  return { ...view, router, queryClient, user: userEvent.setup() };
}

/**
 * Renders and waits for the drill. The page has an h1 in every state (a generic one until the drill's own title is known), so
 * the wait is for the goal text, which only the loaded screen has.
 */
async function renderLoaded(options: RenderOptions = {}) {
  const view = await renderDetail(options);
  await screen.findByText(INPUT.content.goal[options.locale ?? 'en']);
  return view;
}

const heading = (name: string, level = 2): HTMLElement => screen.getByRole('heading', { level, name });
const sectionOf = (name: string): HTMLElement => heading(name).closest('section') as HTMLElement;
/** The value (`<dd>`) next to a label (`<dt>`). */
const fact = (label: string): string | undefined => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? undefined;
const items = (root: HTMLElement): string[] => within(root).getAllByRole('listitem').map((li) => li.textContent ?? '');

// --- success: every section ---------------------------------------------------------------------------------------

describe('the loaded screen', () => {
  test('makes exactly one call, GET /api/commons/drills/:slug, in the active language', async () => {
    await renderLoaded({ locale: 'ru' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe(`/api/commons/drills/${SLUG}`);
    expect(calls[0]?.search).toBe('?locale=ru');
  });

  test('the title is the one h1 and the goal sits under its own heading', async () => {
    await renderLoaded();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(heading('Ghost Ball', 1)).toBeTruthy();
    expect(within(sectionOf('Goal')).getByText('Get used to soft, quiet foot touches before you use a real ball.')).toBeTruthy();
  });

  test('a drill without a title falls back to its humanised slug, never to a blank heading', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          delete (draft.content as { title?: unknown }).title;
        }),
      ),
    );
    await renderLoaded();
    expect(heading('Ball mastery ghost ball', 1)).toBeTruthy();
  });

  test('the instructions are a numbered list, one item per step, without the "1." typed into the text', async () => {
    await renderLoaded();
    const list = within(sectionOf('How to do it')).getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(items(list)).toEqual([
      'Stand tall with your knees a little bent.',
      'Tap the pretend ball softly.',
      'Slide the pretend ball sideways.',
      'Finish on one leg for a slow count of three.',
    ]);
  });

  test('instructions written as one paragraph (no numbering) still show as a single step', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.instructions = { en: 'Just kick the ball against the wall.' } as never;
        }),
      ),
    );
    await renderLoaded();
    expect(items(within(sectionOf('How to do it')).getByRole('list'))).toEqual(['Just kick the ball against the wall.']);
  });

  test('reps and sets come from the dose; time is left out when the dose has none', async () => {
    await renderLoaded();
    expect(fact('Reps')).toBe('10');
    expect(fact('Sets')).toBe('2');
    expect(screen.queryByText('Time', { selector: 'dt' })).toBeNull();
  });

  test('a timed dose shows the seconds', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.dose = { durationSec: 45 } as never;
        }),
      ),
    );
    await renderLoaded();
    expect(fact('Time')).toBe('45 s');
    expect(screen.queryByText('Reps', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Sets', { selector: 'dt' })).toBeNull();
  });

  test('required conditions: equipment, every space, partner and age', async () => {
    await renderLoaded();
    expect(fact('Equipment')).toBe('Nothing');
    expect(fact('Where')).toBe('Home 3×3 m, Yard');
    expect(fact('Partner')).toBe('Not needed');
    expect(fact('Age')).toBe('from 5');
  });

  test('a drill that needs a partner and has an age range says so', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.conditions = { equipment: 'ball_wall', spaces: ['field'], partner: true, ageMin: 6, ageMax: 12 } as never;
        }),
      ),
    );
    await renderLoaded();
    expect(fact('Equipment')).toBe('Ball + wall');
    expect(fact('Where')).toBe('Field');
    expect(fact('Partner')).toBe('Needed');
    expect(fact('Age')).toBe('6–12');
  });

  test('with no age limits given, the age line is left out', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.conditions = { equipment: 'ball', spaces: ['yard'], partner: false } as never;
        }),
      ),
    );
    await renderLoaded();
    expect(screen.queryByText('Age', { selector: 'dt' })).toBeNull();
  });

  test('common mistakes, progression and regression are separate lists', async () => {
    await renderLoaded();
    expect(items(sectionOf('Common mistakes'))).toEqual(['You stamp your foot down.', 'Your shoulders are lifted.']);
    expect(items(sectionOf('Make it harder'))).toEqual(['Try it with a real ball.']);
    expect(items(sectionOf('Make it easier'))).toEqual(['Hold a chair while you balance.']);
  });

  test('empty lists leave their sections out (no empty heading)', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.mistakes = [];
          draft.content.progressions = [];
          draft.content.regressions = [];
          draft.content.safety = [];
          draft.content.media = [];
        }),
      ),
    );
    await renderLoaded();
    for (const name of ['Common mistakes', 'Make it harder', 'Make it easier', 'Safety', 'Video']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
    }
    expect(document.querySelector('video')).toBeNull();
  });

  test('safety is a labelled group of every safety note, with an icon and a heading rather than a colour alone', async () => {
    await renderLoaded();
    const safety = sectionOf('Safety');
    expect(items(safety)).toEqual(['Shake out both ankles before you start.', 'Stand next to a sturdy chair.']);
    expect(safety.querySelector('svg')).not.toBeNull();
  });

  test('safety comes before the instructions, so it is read before the child starts', async () => {
    await renderLoaded();
    const order = heading('Safety').compareDocumentPosition(heading('How to do it'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the video is lazy and never autoplays: controls, preload none, no autoplay, no source fetched up front', async () => {
    await renderLoaded();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/media/ghost-ball.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(within(sectionOf('Video')).getByText('Ghost Ball from the side')).toBeTruthy();
    // The page itself never asked for the file.
    expect(calls.some((call) => call.path.startsWith('/media/'))).toBe(false);
  });

  test('only a video is shown as a video: an image or document entry does not become a player', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.content.media = [{ kind: 'document', url: '/media/sheet.pdf' }] as never;
        }),
      ),
    );
    await renderLoaded();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Video' })).toBeNull();
  });
});

// --- trust and attribution ----------------------------------------------------------------------------------------

describe('trust and reviewers', () => {
  test('the header badge takes the status the NEWEST review moved the drill to, and names its organisation', async () => {
    await renderLoaded();
    const header = heading('Ghost Ball', 1).closest('header') as HTMLElement;
    const badge = header.querySelector('[data-status]') as HTMLElement;
    expect(badge.getAttribute('data-status')).toBe('EXPERT_VERIFIED');
    expect(badge.textContent).toBe('Verified by Test Academy');
  });

  test('every review is listed with its reviewer, organisation, date and note', async () => {
    await renderLoaded();
    const reviews = sectionOf('Who checked this drill');
    const rows = within(reviews).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Test Reviewer');
    expect(rows[0]?.textContent).toContain('Test Academy');
    expect(rows[0]?.textContent).toContain('May 20, 2026');
    expect(rows[0]?.textContent).toContain('Safe for age six and up.');
    expect(rows[1]?.textContent).toContain('Volunteer Coach');
    expect(rows[1]?.textContent).toContain('Tried with an under-8 group.');
  });

  test('a drill nobody has reviewed is a community drill and says that nobody has reviewed it', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.reviews = [];
        }),
      ),
    );
    await renderLoaded();
    const header = heading('Ghost Ball', 1).closest('header') as HTMLElement;
    expect((header.querySelector('[data-status]') as HTMLElement).getAttribute('data-status')).toBe('COMMUNITY');
    expect(within(sectionOf('Who checked this drill')).getByText('No one has reviewed this drill yet.')).toBeTruthy();
    expect(within(sectionOf('Who checked this drill')).queryByRole('list')).toBeNull();
  });
});

describe('the attribution block', () => {
  test('names the author, links the source, gives the licence, the date and the semver', async () => {
    await renderLoaded();
    expect(fact('Author')).toBe('Test Author');
    expect(fact('Date')).toBe('May 12, 2026');
    expect(fact('Version')).toBe('1.2.0');

    const source = screen.getByRole('link', { name: 'Test Source Book' }) as HTMLAnchorElement;
    expect(source.getAttribute('href')).toBe('https://example.org/ghost-ball');
    expect(source.getAttribute('rel')).toContain('noopener');

    const licence = screen.getByRole('link', { name: 'CC BY-SA 4.0' }) as HTMLAnchorElement;
    expect(licence.getAttribute('href')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
  });

  test('a source without a URL is plain text, not a dead link', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          delete (draft.attribution as { sourceUrl?: unknown }).sourceUrl;
        }),
      ),
    );
    await renderLoaded();
    expect(fact('Source')).toBe('Test Source Book');
    expect(screen.queryByRole('link', { name: 'Test Source Book' })).toBeNull();
  });
});

// --- version history ------------------------------------------------------------------------------------------------

describe('the version history', () => {
  const historyRows = () => within(sectionOf('Version history')).getAllByRole('listitem');

  test('lists every version newest first, with its date and note, and marks the current one with a word', async () => {
    await renderLoaded();
    const rows = historyRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('1.2.0');
    expect(rows[0]?.textContent).toContain('May 12, 2026');
    expect(rows[0]?.textContent).toContain('Added a video.');
    expect(within(rows[0] as HTMLElement).getByText('Current')).toBeTruthy();
    expect(rows[1]?.textContent).toContain('1.1.0');
    expect(rows[1]?.textContent).toContain('Clearer step three.');
    expect(rows[2]?.textContent).toContain('1.0.0');
  });

  test('an older version has an open button; the current one has none', async () => {
    await renderLoaded();
    const rows = historyRows();
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Open version 1.1.0' })).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByRole('button', { name: 'Open version 1.0.0' })).toBeTruthy();
  });

  test('opening an older version shows it read-only, replacing the current content, with no new request', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open version 1.1.0' }));

    const panel = heading('Version 1.1.0').closest('section') as HTMLElement;
    expect(document.activeElement).toBe(heading('Version 1.1.0'));
    expect(within(panel).getByText('You are reading an earlier version. It is read-only.')).toBeTruthy();
    expect(within(panel).getByText('Mar 2, 2026', { selector: 'dd' })).toBeTruthy();
    expect(within(panel).getByText('Clearer step three.', { selector: 'dd' })).toBeTruthy();
    // The gap is said out loud rather than papered over with the current text (backlog fc-h2p).
    expect(within(panel).getByText('The text of earlier versions is not published yet, so only this record is shown.')).toBeTruthy();

    // The current version's content is gone: it must not be passed off as the older text.
    for (const name of ['How to do it', 'Common mistakes', 'Safety', 'Where this drill comes from', 'Goal']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
    }
    // Still the same drill, still the same page: the title and the list of versions stay.
    expect(heading('Ghost Ball', 1)).toBeTruthy();
    expect(historyRows()).toHaveLength(3);
    // Nothing was requested for it (the API has no per-version read).
    expect(calls).toHaveLength(1);
  });

  test('the version being read is marked in the list by a word and aria-current', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open version 1.1.0' }));
    const rows = historyRows();
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    expect(within(rows[1] as HTMLElement).getByText('Viewing')).toBeTruthy();
    expect(rows[0]?.getAttribute('aria-current')).toBeNull();
    expect(within(rows[0] as HTMLElement).getByText('Current')).toBeTruthy();
  });

  test('an older version with no note says there is none', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open version 1.0.0' }));
    const panel = heading('Version 1.0.0').closest('section') as HTMLElement;
    expect(within(panel).getByText('No note was left for this change.', { selector: 'dd' })).toBeTruthy();
  });

  test('you can go from one older version straight to another', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open version 1.1.0' }));
    await user.click(screen.getByRole('button', { name: 'Open version 1.0.0' }));
    expect(heading('Version 1.0.0')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Version 1.1.0' })).toBeNull();
  });

  test('"Back to the current version" restores the whole drill and puts the focus on its title', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open version 1.1.0' }));
    await user.click(screen.getByRole('button', { name: 'Back to the current version' }));

    expect(screen.queryByRole('heading', { name: 'Version 1.1.0' })).toBeNull();
    expect(heading('How to do it')).toBeTruthy();
    expect(heading('Where this drill comes from')).toBeTruthy();
    expect(document.activeElement).toBe(heading('Ghost Ball', 1));
  });

  test('a drill with no history rows has no history section', async () => {
    stubNetwork(() =>
      json(
        drill((draft) => {
          draft.history = [];
        }),
      ),
    );
    await renderLoaded();
    expect(screen.queryByRole('heading', { name: 'Version history' })).toBeNull();
  });
});

// --- the drill-detail slot ------------------------------------------------------------------------------------------

describe('the drill-detail slot', () => {
  const One = () => <p>slot one</p>;
  const Two = () => <p>slot two</p>;

  test('renders every component of the slot, in order, below the content', async () => {
    await renderLoaded({ slots: [One, Two] });
    const region = document.querySelector('[data-slot="drill-detail"]') as HTMLElement;
    expect(within(region).getAllByText(/^slot /).map((node) => node.textContent)).toEqual(['slot one', 'slot two']);
    // Below the content: after the last section of the drill (the version history).
    const lastSection = sectionOf('Version history');
    expect(lastSection.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('still renders while an older version is open (it is below the content, not part of it)', async () => {
    const { user } = await renderLoaded({ slots: [One] });
    await user.click(screen.getByRole('button', { name: 'Open version 1.1.0' }));
    expect(screen.getByText('slot one')).toBeTruthy();
  });

  test('adds no region when nothing fills the slot', async () => {
    await renderLoaded({ slots: [] });
    expect(document.querySelector('[data-slot="drill-detail"]')).toBeNull();
  });

  test('renders nothing for a drill that was not found', async () => {
    stubNetwork(() => problem(404));
    await renderDetail({ slots: [One] });
    await screen.findByText('We could not find this drill');
    expect(screen.queryByText('slot one')).toBeNull();
  });
});

// --- the other states -----------------------------------------------------------------------------------------------

describe('loading', () => {
  test('is a named busy status until the answer arrives, then the drill replaces it', async () => {
    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    await renderDetail();
    const busy = await screen.findByRole('status', { name: 'Loading the drill…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1, name: 'Ghost Ball' })).toBeNull();

    gate.resolve(json(DRILL));
    await screen.findByRole('heading', { level: 1, name: 'Ghost Ball' });
    expect(screen.queryByRole('status', { name: 'Loading the drill…' })).toBeNull();
  });
});

describe('an unknown drill (the not-found state)', () => {
  test('a 404 says the drill was not found and leads back to the library, without a retry or an alarm', async () => {
    stubNetwork(() => problem(404));
    await renderDetail({ slug: 'no-such-drill' });
    await screen.findByText('We could not find this drill');
    expect(calls[0]?.path).toBe('/api/commons/drills/no-such-drill');
    const back = screen.getByRole('link', { name: 'Open the drill library' });
    expect(back.getAttribute('href')).toBe('/commons');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull(); // no drill section is drawn
  });

  test('a slug the API refuses as malformed (400) is the same not-found state: no drill can have it', async () => {
    stubNetwork(() => problem(400));
    await renderDetail({ slug: 'bad slug!' });
    await screen.findByText('We could not find this drill');
  });
});

describe('an error', () => {
  test('a server failure shows generic words and Try again, never the server text', async () => {
    stubNetwork(() => json({ type: 'about:blank', title: 'SECRET-BOOM', detail: 'stack trace here', status: 500 }, 500, 'application/problem+json'));
    await renderDetail();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The drill did not load')).toBeTruthy();
    expect(alert.textContent).not.toContain('SECRET-BOOM');
    expect(alert.textContent).not.toContain('stack trace');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('a body that is not a drill is an error too, not a half-drawn screen', async () => {
    stubNetwork(() => json({ slug: SLUG }));
    await renderDetail();
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull(); // no drill section is drawn
  });

  test('Try again is disabled (natively) and busy while the request runs, and the drill appears when it works', async () => {
    let attempt = 0;
    const gate = deferred<Response>();
    stubNetwork(() => {
      attempt += 1;
      return attempt === 1 ? problem(500) : gate.promise;
    });
    const { user } = await renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    const retry = (await screen.findByRole('button', { name: 'Try again' })) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(true));
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('alert')).toBeTruthy(); // the failure stays put, no flash to skeletons
    expect(calls).toHaveLength(2);

    gate.resolve(json(DRILL));
    await screen.findByRole('heading', { level: 1, name: 'Ghost Ball' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('offline says so in the words of the shared problem messages', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await renderDetail();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/connection|Check your internet/i);
  });
});

// --- languages ----------------------------------------------------------------------------------------------------------

// Natural forms for each language. Kazakh still needs the scheduled native review; these are the shipped strings.
const WORDS: Record<Locale, { goal: string; safety: string; how: string; open: (semver: string) => string; loading: string; notFound: string }> = {
  en: {
    goal: 'Goal',
    safety: 'Safety',
    how: 'How to do it',
    open: (semver) => `Open version ${semver}`,
    loading: 'Loading the drill…',
    notFound: 'We could not find this drill',
  },
  ru: {
    goal: 'Цель',
    safety: 'Безопасность',
    how: 'Как выполнять',
    open: (semver) => `Открыть версию ${semver}`,
    loading: 'Загружаем упражнение…',
    notFound: 'Мы не нашли это упражнение',
  },
  kk: {
    goal: 'Мақсат',
    safety: 'Қауіпсіздік',
    how: 'Қалай орындаймыз',
    open: (semver) => `${semver} нұсқасын ашу`,
    loading: 'Жаттығуды жүктеп жатырмыз…',
    notFound: 'Бұл жаттығу табылмады',
  },
};

describe.each(LOCALES)('in %s', (locale) => {
  const words = WORDS[locale];

  test('asks for the drill in this language and shows its title and the headings in it', async () => {
    await renderLoaded({ locale });
    expect(calls[0]?.search).toBe(`?locale=${locale}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(INPUT.content.title[locale]);
    expect(heading(words.goal)).toBeTruthy();
    expect(heading(words.safety)).toBeTruthy();
    expect(heading(words.how)).toBeTruthy();
    // The drill's own text arrives in the same language.
    expect(screen.getByText(INPUT.content.goal[locale])).toBeTruthy();
  });

  test('the history button, the loading status and the not-found state are in this language', async () => {
    const { user } = await renderLoaded({ locale });
    expect(screen.getByRole('button', { name: words.open('1.1.0') })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: words.open('1.1.0') }));
    expect(screen.queryByRole('heading', { name: words.how })).toBeNull();
    cleanup();

    const gate = deferred<Response>();
    stubNetwork(() => gate.promise);
    await renderDetail({ locale });
    expect(await screen.findByRole('status', { name: words.loading })).toBeTruthy();
    cleanup();

    stubNetwork(() => problem(404));
    await renderDetail({ locale });
    expect(await screen.findByText(words.notFound)).toBeTruthy();
  });

  test('the date is written the way this language writes it, and the year is there', async () => {
    await renderLoaded({ locale });
    const shown = screen.getAllByText(/2026/, { selector: 'dd' })[0]?.textContent ?? '';
    expect(shown).toBe(new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date('2026-05-12T10:00:00.000Z')));
  });
});

describe('the messages file', () => {
  const leafKeys = (tree: object, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
    );
  const leafValues = (tree: object): string[] =>
    Object.values(tree).flatMap((value) => (typeof value === 'string' ? [value] : leafValues(value as object)));

  test('has the same keys in kk, ru and en, and no blank string', () => {
    const en = leafKeys(messages.en).sort();
    expect(leafKeys(messages.ru).sort()).toEqual(en);
    expect(leafKeys(messages.kk).sort()).toEqual(en);
    for (const locale of LOCALES) for (const value of leafValues(messages[locale])) expect(value.trim()).not.toBe('');
  });

  test('has words for every equipment and space the contract can send', () => {
    const keys = new Set(leafKeys(messages.en));
    for (const equipment of EQUIPMENT) expect(keys.has(`equipment.${equipment}`)).toBe(true);
    for (const space of SPACES) expect(keys.has(`space.${space}`)).toBe(true);
  });
});
