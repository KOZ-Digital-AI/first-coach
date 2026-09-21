import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Journey as JourneySchema, type Journey } from '@api-types/journey';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/progress/index';
import messages from './journey.messages';
import skillTreeMessages from './skill-tree.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as SkillTree.test.tsx and terms.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * The My Journey screen (/progress): ONE call, GET /api/player/journey, drives everything. Real data goes through the
 * real typed client (lib/api.ts) and React Query; the only stand-in is the network (globalThis.fetch), so the tests see
 * exactly what the browser would send. The fixtures are parsed with the shared contract schema below, so they cannot
 * drift from the API.
 *
 * Kazakh copy is flagged for a native-speaker review; the Kazakh assertions pin a few load-bearing strings only.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const JUGGLING = {
  testSlug: 'juggling-max-touches',
  name: 'Juggling',
  unit: 'touches',
  direction: 'higher',
  history: [
    { value: 14, at: '2026-08-01T10:00:00.000Z' },
    { value: 21, at: '2026-08-15T10:00:00.000Z' },
  ],
  previous: 14,
  latest: 21,
  changePct: 50,
  personalBest: 21,
  retestDueAt: '2026-08-29T10:00:00.000Z',
} as const satisfies Journey['tests'][number];

/** A lower-is-better test: 30 s -> 24 s is +20 (the API reports a positive number for every improvement). */
const SLALOM = {
  testSlug: 'slalom-30s',
  name: 'Dribbling',
  unit: 's',
  direction: 'lower',
  history: [
    { value: 30, at: '2026-08-01T10:00:00.000Z' },
    { value: 24, at: '2026-08-15T10:00:00.000Z' },
  ],
  previous: 30,
  latest: 24,
  changePct: 20,
  personalBest: 24,
  retestDueAt: '2099-01-01T10:00:00.000Z',
} as const satisfies Journey['tests'][number];

const WALL_PASS = {
  testSlug: 'wall-pass-60',
  name: 'Passing',
  unit: 'passes',
  direction: 'higher',
  history: [
    { value: 20, at: '2026-08-01T10:00:00.000Z' },
    { value: 17, at: '2026-08-15T10:00:00.000Z' },
  ],
  previous: 20,
  latest: 17,
  changePct: -15,
  personalBest: 20,
  retestDueAt: '2099-01-01T10:00:00.000Z',
} as const satisfies Journey['tests'][number];

/** One result only: nothing to compare with yet, so no previous and no percentage. */
const WEAK_FOOT = {
  testSlug: 'weak-foot-10',
  name: 'Weak foot',
  unit: 'of 10',
  direction: 'higher',
  history: [{ value: 8, at: '2026-08-15T10:00:00.000Z' }],
  latest: 8,
  personalBest: 8,
  retestDueAt: '2099-01-01T10:00:00.000Z',
} as const satisfies Journey['tests'][number];

const JOURNEY: Journey = {
  metrics: { sessionsCompleted: 12, minutesTrained: 1234, streakDays: 4, skillsImproving: 2 },
  tree: [
    {
      track: 'ball-mastery',
      nodes: [
        { slug: 'basic-touches', name: 'Basic touches', state: 'mastered', level: 1 },
        { slug: 'inside-touches', name: 'Inside touches', state: 'training', level: 2 },
        { slug: 'direction-change', name: 'Direction change', state: 'locked', level: 3 },
      ],
    },
  ],
  tests: [JUGGLING, SLALOM, WALL_PASS, WEAK_FOOT],
  milestones: [{ key: 'FIRST_SESSION', achievedAt: '2026-07-20T10:00:00.000Z' }],
  retestsDue: ['juggling-max-touches'],
};

/** A signed-in player who has not done anything yet. */
const NOTHING_YET: Journey = {
  metrics: { sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0 },
  tree: [],
  tests: [],
  milestones: [],
  retestsDue: [],
};

const with_ = (patch: Partial<Journey>): Journey => ({ ...JOURNEY, ...patch });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string, detail: string) =>
  json({ type: 'about:blank', title, status, detail }, { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
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
const answering = (body: unknown) => stubNetwork(() => json(JourneySchema.parse(body)));
const journeyCalls = () => calls.filter((call) => call.url.pathname === '/api/player/journey');

beforeEach(() => stubNetwork(() => json(JOURNEY)));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './journey.messages.ts': { default: messages },
  './skill-tree.messages.ts': { default: skillTreeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const JourneyPage = Route.options.component as () => ReactNode;

function renderJourney(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <JourneyPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, queryClient };
}

/** Renders and waits for the success state (the h1 is there from the first frame, so wait for the tests section). */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderJourney(locale);
  await screen.findAllByRole('heading', { level: 3 });
  return view;
}

/** The card of one test: the list item around its heading. */
function testCard(name: string): HTMLElement {
  const item = screen.getByRole('heading', { level: 3, name }).closest('li');
  if (item === null) throw new Error(`no list item around the "${name}" heading`);
  return item;
}

/** The metric card that carries this label. */
function metric(label: string): HTMLElement {
  const card = screen.getByText(label).closest('div');
  if (card === null) throw new Error(`no card around "${label}"`);
  return card;
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ');

/** What sits beside a label inside a card: the label's own block ("Last time" + "14 touches"). A value can also appear in the history and the personal best, so it is read by its label. */
function beside(card: HTMLElement, label: string): string {
  const block = within(card).getByText(label).parentElement;
  if (block === null) throw new Error(`"${label}" has no block around it`);
  return text(block);
}

// --- the request --------------------------------------------------------------------------------

describe('the request', () => {
  test('one GET /api/player/journey feeds the whole screen, in the active language and the browser time zone', async () => {
    await renderLoaded('ru');
    expect(journeyCalls()).toHaveLength(1);
    const { url, init } = journeyCalls()[0]!;
    expect(init?.method).toBe('GET');
    expect(url.searchParams.get('locale')).toBe('ru');
    expect(new Headers(init?.headers).get('x-timezone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // Nothing else is fetched: the skill tree, milestones and retests all come out of that one response.
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/player/journey']);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the journey arrives, and no numbers are invented meanwhile', async () => {
    let release: (response: Response) => void = () => {};
    stubNetwork(() => new Promise<Response>((resolve) => (release = resolve)));
    renderJourney();

    const status = await screen.findByRole('status', { name: /loading your journey/i });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Sessions completed')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: /my journey/i })).toBeTruthy();

    release(json(JOURNEY));
    await screen.findByText('Sessions completed');
    expect(screen.queryByRole('status', { name: /loading your journey/i })).toBeNull();
  });
});

// --- success ------------------------------------------------------------------------------------

describe('success: metric cards', () => {
  test('shows sessions completed, minutes trained, current streak and skills improving', async () => {
    await renderLoaded();
    expect(text(metric('Sessions completed'))).toContain('12');
    expect(text(metric('Minutes trained'))).toContain('1,234'); // grouped by the active language
    expect(text(metric('Current streak (days)'))).toContain('4');
    expect(text(metric('Skills improving'))).toContain('2');
  });

  test('a zero streak is shown as a plain 0, without a warning or an alarm', async () => {
    answering(with_({ metrics: { ...JOURNEY.metrics, streakDays: 0 } }));
    await renderLoaded();
    expect(text(metric('Current streak (days)'))).toContain('0');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('success: assessment history', () => {
  test('a higher-is-better test reads previous -> latest with its unit and a signed percentage', async () => {
    await renderLoaded();
    const element = testCard('Juggling');
    const card = within(element);
    expect(beside(element, 'Last time')).toContain('14 touches');
    expect(beside(element, 'Now')).toContain('21 touches');
    expect(card.getByText('+50%')).toBeTruthy();
    expect(card.getByText(/better than last time/i)).toBeTruthy();
  });

  test('a lower-is-better test keeps its unit, says that less is better, and shows its improvement as positive', async () => {
    await renderLoaded();
    const element = testCard('Dribbling');
    const card = within(element);
    expect(beside(element, 'Last time')).toContain('30 s');
    expect(beside(element, 'Now')).toContain('24 s');
    expect(card.getByText('+20%')).toBeTruthy();
    expect(card.getByText(/less is better/i)).toBeTruthy();
    expect(within(testCard('Juggling')).getByText(/more is better/i)).toBeTruthy();
  });

  test('a fall carries a real minus sign and calm words, no scolding', async () => {
    await renderLoaded();
    const card = within(testCard('Passing'));
    expect(card.getByText('−15%')).toBeTruthy();
    expect(card.getByText(/lower than last time/i)).toBeTruthy();
    expect(card.queryByText('+15%')).toBeNull();
    expect(text(testCard('Passing'))).not.toMatch(/fail|bad|worse|wrong|lose|lost/i);
  });

  test('the percentage is rounded to one decimal and formatted for the language', async () => {
    answering(with_({ tests: [{ ...JUGGLING, changePct: 33.3333 }, { ...WALL_PASS, changePct: -12.46 }], retestsDue: [] }));
    await renderLoaded('ru');
    expect(within(testCard('Juggling')).getByText('+33,3%')).toBeTruthy();
    expect(within(testCard('Passing')).getByText('−12,5%')).toBeTruthy();
  });

  test('no change is shown as 0% with no sign', async () => {
    answering(with_({ tests: [{ ...JUGGLING, previous: 21, changePct: 0 }], retestsDue: [] }));
    await renderLoaded();
    const card = within(testCard('Juggling'));
    expect(card.getByText('0%')).toBeTruthy();
    expect(card.getByText(/same as last time/i)).toBeTruthy();
  });

  test('a single result shows as the first result, with no previous value and no percentage', async () => {
    await renderLoaded();
    const card = testCard('Weak foot');
    expect(beside(card, 'First result')).toContain('8 of 10');
    expect(text(card)).not.toMatch(/%/);
    expect(text(card)).not.toMatch(/last time/i);
  });

  test('every result stays reachable in a native disclosure, oldest first', async () => {
    await renderLoaded();
    const card = testCard('Juggling');
    const summary = within(card).getByText(/all results \(2\)/i);
    expect(summary.closest('details')).not.toBeNull();
    const items = within(summary.closest('details') as HTMLElement).getAllByRole('listitem');
    expect(items.map((item) => text(item))).toEqual([expect.stringContaining('14 touches'), expect.stringContaining('21 touches')]);
    expect(text(items[0]!)).toMatch(/2026/);
  });

  test('personal bests are shown per test, with the unit', async () => {
    await renderLoaded();
    expect(text(testCard('Juggling'))).toMatch(/personal best\D*21 touches/i);
    expect(text(testCard('Dribbling'))).toMatch(/personal best\D*24 s/i);
    expect(text(testCard('Passing'))).toMatch(/personal best\D*20 passes/i);
  });

  test('says so, calmly, when there are sessions but no skill check yet', async () => {
    answering(with_({ tests: [], retestsDue: [] }));
    await renderLoaded();
    expect(await screen.findByText(/no skill checks yet/i)).toBeTruthy();
    expect(screen.getByText('Sessions completed')).toBeTruthy();
  });
});

describe('success: retest prompts', () => {
  test('a due test shows a Retest now prompt inside its own card', async () => {
    await renderLoaded();
    const links = screen.getAllByRole('link', { name: /retest now/i });
    expect(links).toHaveLength(1);
    expect(within(testCard('Juggling')).getByRole('link', { name: /retest now/i })).toBe(links[0]!);
    // The accessible name says which test, so a screen-reader list of links is not four identical entries.
    expect(links[0]!.textContent).toMatch(/juggling/i);
    expect(links[0]!.getAttribute('href')).toMatch(/^\/[a-z]/);
  });

  test('a test that is not due gets no prompt, only the date of its next retest', async () => {
    await renderLoaded();
    for (const name of ['Dribbling', 'Passing', 'Weak foot']) {
      expect(within(testCard(name)).queryByRole('link', { name: /retest/i })).toBeNull();
      expect(text(testCard(name))).toMatch(/next retest/i);
    }
    expect(text(testCard('Juggling'))).not.toMatch(/next retest/i);
  });

  test('every due test gets its own prompt', async () => {
    answering(with_({ retestsDue: ['juggling-max-touches', 'wall-pass-60'] }));
    await renderLoaded();
    expect(screen.getAllByRole('link', { name: /retest now/i })).toHaveLength(2);
    expect(within(testCard('Passing')).getByRole('link', { name: /retest now/i })).toBeTruthy();
    expect(within(testCard('Dribbling')).queryByRole('link', { name: /retest now/i })).toBeNull();
  });
});

describe('success: milestones', () => {
  test('achieved and upcoming milestones are quiet badges that say which they are in words', async () => {
    await renderLoaded();
    const list = screen.getByRole('list', { name: /milestones/i });
    const badges = within(list).getAllByRole('listitem');
    expect(badges).toHaveLength(6); // the one achieved + the five the player has yet to reach

    const first = badges.find((badge) => /first session/i.test(text(badge)))!;
    expect(text(first)).toMatch(/achieved/i);
    expect(text(first)).toMatch(/2026/);
    expect(text(first)).not.toMatch(/coming up/i);

    const upcoming = badges.filter((badge) => badge !== first);
    expect(upcoming).toHaveLength(5);
    for (const badge of upcoming) {
      expect(text(badge)).toMatch(/coming up/i);
      expect(text(badge)).not.toMatch(/achieved/i);
    }
    expect(upcoming.map((badge) => text(badge)).join(' ')).toMatch(/10 training days/i);
  });

  test('a milestone that is achieved moves out of the upcoming ones', async () => {
    answering(
      with_({
        milestones: [
          { key: 'FIRST_SESSION', achievedAt: '2026-07-20T10:00:00.000Z' },
          { key: 'FIRST_RETEST', achievedAt: '2026-08-15T10:00:00.000Z' },
        ],
      }),
    );
    await renderLoaded();
    const badges = within(screen.getByRole('list', { name: /milestones/i })).getAllByRole('listitem');
    expect(badges).toHaveLength(6);
    expect(badges.filter((badge) => /achieved/i.test(text(badge)))).toHaveLength(2);
    expect(badges.filter((badge) => /coming up/i.test(text(badge)))).toHaveLength(4);
  });

  test('a milestone key this screen does not know still shows, under a plain generic name, never the raw key', async () => {
    answering(with_({ milestones: [{ key: 'SOMETHING_NEW', achievedAt: '2026-08-15T10:00:00.000Z' }] }));
    await renderLoaded();
    expect(document.body.textContent).not.toContain('SOMETHING_NEW');
    const badges = within(screen.getByRole('list', { name: /milestones/i })).getAllByRole('listitem');
    expect(badges.filter((badge) => /achieved/i.test(text(badge)))).toHaveLength(1);
  });
});

describe('success: skill tree', () => {
  test('mounts the SkillTree component with the tree from the same response', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { level: 2, name: /skill tree/i })).toBeTruthy();
    const tree = screen.getByRole('list', { name: /skill tracks/i });
    expect(within(tree).getByText('Basic touches')).toBeTruthy();
    expect(within(tree).getByText('Mastered')).toBeTruthy();
    expect(within(tree).getByText('Training now')).toBeTruthy();
    expect(within(tree).getByText('Locked')).toBeTruthy();
  });
});

describe('success: only the player against their own past', () => {
  test('the page says so, and shows no rank, leaderboard or other player anywhere', async () => {
    await renderLoaded();
    const all = text(document.body);
    expect(all).toMatch(/your own/i);
    expect(all).not.toMatch(/leaderboard|ranking|rank\b|percentile|top \d|other players|other kids|everyone|average/i);
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty', () => {
  test('a player who is not onboarded (404) sees an empty state that leads to START TRAINING', async () => {
    stubNetwork(() => problem(404, 'Not Found', 'The player is not onboarded yet.'));
    renderJourney();
    const start = await screen.findByRole('link', { name: /start training/i });
    expect(start.getAttribute('href')).toBe('/train');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Sessions completed')).toBeNull();
    expect(screen.queryByRole('list', { name: /skill tracks/i })).toBeNull();
    // Warm, not blaming: and no server text is shown.
    expect(document.body.textContent).not.toMatch(/not onboarded/i);
  });

  test('a visitor with no session yet (401) has no journey either: the same empty state, not an error', async () => {
    stubNetwork(() => problem(401, 'Unauthorized', 'Sign in required.'));
    renderJourney();
    const start = await screen.findByRole('link', { name: /start training/i });
    expect(start.getAttribute('href')).toBe('/train');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/expired|sign in/i);
  });

  test('a journey with no sessions, no tests and no milestones is empty too', async () => {
    answering(NOTHING_YET);
    renderJourney();
    const start = await screen.findByRole('link', { name: /start training/i });
    expect(start.getAttribute('href')).toBe('/train');
    expect(screen.queryByText('Minutes trained')).toBeNull();
    expect(screen.queryByRole('link', { name: /retest/i })).toBeNull();
  });

  test('one finished session is enough for the real screen: it is not empty', async () => {
    answering({ ...NOTHING_YET, metrics: { ...NOTHING_YET.metrics, sessionsCompleted: 1, minutesTrained: 5 } });
    renderJourney();
    expect(await screen.findByText('Sessions completed')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /start training/i })).toBeNull();
  });

  test('an achieved milestone alone is enough for the real screen: it is not empty', async () => {
    answering({ ...NOTHING_YET, milestones: [{ key: 'FIRST_SESSION', achievedAt: '2026-07-20T10:00:00.000Z' }] });
    renderJourney();
    expect(await screen.findByText('Sessions completed')).toBeTruthy();
  });
});

// --- error --------------------------------------------------------------------------------------

describe('error', () => {
  test('a server failure shows an alert with generic localised words and a Try again button, not the server text', async () => {
    stubNetwork(() => problem(500, 'Internal Server Error', 'SQLITE_BUSY: database is locked'));
    renderJourney();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(text(alert)).toMatch(/our side/i); // problem.messages.ts `server`
    expect(document.body.textContent).not.toMatch(/SQLITE|Internal Server Error/);
    expect(screen.queryByText('Sessions completed')).toBeNull();
  });

  test('a network failure is the offline message, with the same way out', async () => {
    stubNetwork(() => {
      throw new TypeError('fetch failed');
    });
    renderJourney();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toMatch(/connection/i);
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  test('a response that breaks the contract is an error, never a half-drawn screen', async () => {
    stubNetwork(() => json({ metrics: { sessionsCompleted: 'twelve' } }));
    renderJourney();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Sessions completed')).toBeNull();
  });

  test('Try again is disabled and busy while the request is in flight, and the screen recovers on success', async () => {
    let release: (response: Response) => void = () => {};
    let attempt = 0;
    stubNetwork(() => {
      attempt += 1;
      return attempt === 1 ? problem(500, 'Internal Server Error', 'boom') : new Promise<Response>((resolve) => (release = resolve));
    });
    const user = userEvent.setup();
    renderJourney();

    const retry = within(await screen.findByRole('alert')).getByRole('button', { name: /try again/i }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await user.click(retry);

    await waitFor(() => expect(journeyCalls()).toHaveLength(2));
    const busy = within(screen.getByRole('alert')).getByRole('button', { name: /try again/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // A second click while in flight sends nothing.
    await user.click(busy);
    expect(journeyCalls()).toHaveLength(2);

    release(json(JOURNEY));
    await screen.findByText('Sessions completed');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(journeyCalls()).toHaveLength(2);
  });
});

// --- languages ----------------------------------------------------------------------------------

const EXPECTED: Record<Locale, { title: RegExp; sessions: string; retest: RegExp; start: RegExp; milestones: RegExp; better: RegExp }> = {
  en: { title: /my journey/i, sessions: 'Sessions completed', retest: /retest now/i, start: /start training/i, milestones: /milestones/i, better: /better than last time/i },
  ru: { title: /мой путь/i, sessions: 'Завершено тренировок', retest: /пройти тест сейчас/i, start: /начать тренировку/i, milestones: /достижения/i, better: /лучше, чем в прошлый раз/i },
  kk: { title: /менің жолым/i, sessions: 'Аяқталған жаттығулар', retest: /тестті қазір қайта тапсыру/i, start: /жаттығуды бастау/i, milestones: /жетістіктер/i, better: /алдыңғы жолдан жақсы/i },
};

describe.each(LOCALES)('language %s', (locale) => {
  test('the success screen is fully worded, with no raw keys and no "undefined"', async () => {
    const want = EXPECTED[locale];
    await renderLoaded(locale);
    expect(screen.getByRole('heading', { level: 1, name: want.title })).toBeTruthy();
    expect(screen.getByText(want.sessions)).toBeTruthy();
    expect(screen.getByRole('link', { name: want.retest })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: want.milestones })).toBeTruthy();
    expect(within(testCard('Juggling')).getByText(want.better)).toBeTruthy();
    const all = text(document.body);
    expect(all).not.toMatch(/undefined|journey:|milestones\.|states\./i);
    expect(all).not.toMatch(/\{\{|\}\}/);
  });

  test('the empty state is worded and leads to START TRAINING', async () => {
    answering(NOTHING_YET);
    renderJourney(locale);
    expect(await screen.findByRole('link', { name: EXPECTED[locale].start })).toBeTruthy();
    expect(text(document.body)).not.toMatch(/undefined|journey:|\{\{/i);
  });

  test('the error state is worded', async () => {
    stubNetwork(() => problem(500, 'Internal Server Error', 'boom'));
    renderJourney(locale);
    const alert = await screen.findByRole('alert');
    expect(text(alert).length).toBeGreaterThan(20);
    expect(text(alert)).not.toMatch(/undefined|journey:|\{\{/i);
  });
});

type Tree = { [key: string]: string | Tree };
const leafKeys = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`)));
const leafAt = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);

describe('journey.messages.ts', () => {
  test('has the same keys in kk, ru and en, every string non-blank', () => {
    const [kk, ru, en] = [messages.kk, messages.ru, messages.en].map((tree) => leafKeys(tree as Tree).sort());
    expect(kk!.length).toBeGreaterThanOrEqual(30);
    expect(ru).toEqual(kk!);
    expect(en).toEqual(kk!);
    for (const locale of LOCALES) {
      for (const key of kk!) expect(String(leafAt(messages[locale] as Tree, key)).trim().length).toBeGreaterThan(0);
    }
  });

  test('every milestone the API can produce has a name in every language', () => {
    // Spelled out on purpose (the six keys of apps/api/src/player/milestones.ts MILESTONE_KEYS): read from the page they would pass for any page.
    for (const key of ['FIRST_SESSION', 'TEN_TRAINING_DAYS', 'THOUSAND_TOUCHES', 'WEAK_FOOT_LEVEL_2', 'FIVE_HOURS_TRAINED', 'FIRST_RETEST']) {
      for (const locale of LOCALES) expect(typeof leafAt(messages[locale] as Tree, `milestones.names.${key}`)).toBe('string');
    }
  });

  test('the fixtures are valid contract journeys', () => {
    expect(JourneySchema.safeParse(JOURNEY).success).toBe(true);
    expect(JourneySchema.safeParse(NOTHING_YET).success).toBe(true);
  });
});
