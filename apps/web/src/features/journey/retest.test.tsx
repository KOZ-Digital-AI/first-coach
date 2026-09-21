import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type SkillTest } from '@api-types/domain';
import { Journey as JourneySchema, type Journey, type JourneyTest, TestResultsRequest, TestResultsResponse } from '@api-types/journey';
import { OnboardingOptions } from '@api-types/onboarding';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, SPACES } from '@api-types/primitives';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION } from '@api-types/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/progress/retest.$testSlug';
import messages from './retest.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as journey.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * The retest screen (/progress/retest/:testSlug), written from the bead's acceptance criteria (fc-mol-0bt.9):
 *  - it shows the test protocol, the previous result and a numeric input;
 *  - after POST /api/player/test-results it shows "Your previous result: 14 · Today: 21 · +50%" (built from the RESPONSE),
 *    with a personal-best note when earned; a worse result is neutral, with encouragement to continue the plan;
 *  - loading, empty, error, disabled and success states; mutation buttons are disabled while a request is in flight;
 *  - every string in kk, ru and en.
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch). The route is mounted in a real (memory-history) router, so the :testSlug param is decoded by the router.
 * Fixtures are parsed with the shared contract schemas, so they cannot drift from the API. Kazakh copy needs a native
 * review; the Kazakh assertions pin one load-bearing string only.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JUGGLING = 'juggling-max-touches';
const SLALOM = 'slalom-30s';

function skillTest(fields: Pick<SkillTest, 'slug' | 'skill' | 'metric' | 'unit' | 'direction' | 'equipment'>, protocol: SkillTest['protocol']): SkillTest {
  return { ...fields, protocol };
}

const OPTIONS: OnboardingOptions = OnboardingOptions.parse({
  levels: [...EXPERIENCE_LEVELS],
  goals: [...GOALS],
  equipment: [...EQUIPMENT],
  spaces: [...SPACES],
  partner: [false, true],
  daysPerWeek: [...DAYS_PER_WEEK],
  minutesPerSession: [...MINUTES_PER_SESSION],
  tests: [
    skillTest(
      { slug: JUGGLING, skill: 'ball-mastery', metric: 'juggling max touches', unit: 'touches', direction: 'higher', equipment: 'ball' },
      {
        kk: '1. Допты күшті аяғыңмен ұста.\n2. Доп түскенше жанасуларды сана.',
        ru: '1. Жонглируй сильной ногой.\n2. Считай касания, пока мяч не упадёт.',
        en: '1. Juggle with your stronger foot.\n2. Count the touches until the ball drops.',
      },
    ),
    skillTest(
      { slug: SLALOM, skill: 'dribbling', metric: 'slalom in 30 seconds', unit: 'seconds', direction: 'lower', equipment: 'cones' },
      { en: '1. Set five cones in a line.\n2. Dribble through them and stop the time.' },
    ),
  ],
});

const stamp = (index: number): string => `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`;

/** The API's per-test row for a list of results, oldest first. A positive changePct is ALWAYS an improvement. */
function journeyTest(slug: string, name: string, unit: string, direction: 'higher' | 'lower', values: number[]): JourneyTest {
  const latest = values[values.length - 1]!;
  const previous = values.length > 1 ? values[values.length - 2] : undefined;
  const better = direction === 'higher' ? Math.max : Math.min;
  return {
    testSlug: slug,
    name,
    unit,
    direction,
    history: values.map((value, index) => ({ value, at: stamp(index) })),
    ...(previous === undefined ? {} : { previous, changePct: Math.round(((direction === 'higher' ? latest - previous : previous - latest) / previous) * 1000) / 10 }),
    latest,
    personalBest: better(...values),
  };
}

const journeyWith = (tests: JourneyTest[]): Journey =>
  JourneySchema.parse({
    metrics: { sessionsCompleted: 3, minutesTrained: 60, streakDays: 1, skillsImproving: 1 },
    tree: [],
    tests,
    milestones: [],
    retestsDue: tests.map((test) => test.testSlug),
  });

const juggling = (values: number[]) => journeyTest(JUGGLING, 'Juggling', 'touches', 'higher', values);
const slalom = (values: number[]) => journeyTest(SLALOM, 'Dribbling', 'seconds', 'lower', values);

/** What the player has BEFORE the retest: juggling 10 then 14 (so the previous result is 14), slalom 30 then 26. */
const BEFORE: Journey = journeyWith([juggling([10, 14]), slalom([30, 26])]);

const ROADMAP = {
  currentLevelLabel: 'Basic',
  tracks: [{ skill: 'ball-mastery', level: 2, source: 'test' }],
  goal: 'control',
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [{ skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'Your weakest skill.' }],
};

/** The POST answer: the refreshed journey (with the retested test's new results) and the roadmap. */
const answer = (...tests: JourneyTest[]) => TestResultsResponse.parse({ journey: journeyWith(tests), roadmap: ROADMAP });

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

type Call = { method: string; path: string; search: string; headers: Headers; body: unknown };
type Server = {
  options?: () => Response | Promise<Response>;
  journey?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
};

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, headers: new Headers(init?.headers), body });
    if (url.pathname === '/api/onboarding/football') return (server.options ?? (() => json(OPTIONS)))();
    if (url.pathname === '/api/player/journey') return (server.journey ?? (() => json(BEFORE)))();
    if (url.pathname === '/api/player/test-results' && method === 'POST') {
      return (server.post ?? (() => json(answer(juggling([10, 14, 21])))))(body);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const posts = () => calls.filter((call) => call.method === 'POST');
const journeyGets = () => calls.filter((call) => call.path === '/api/player/journey');

beforeEach(() => stubNetwork());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './retest.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The route in a real router at /progress/retest/<slug>, so the param is decoded by the router itself. */
async function renderRetest(slug: string = JUGGLING, locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  const rootRoute = createRootRoute();
  const retestRoute = Route.update({ id: '/progress/retest/$testSlug', path: '/progress/retest/$testSlug', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([retestRoute as never]),
    history: createMemoryHistory({ initialEntries: [`/progress/retest/${encodeURIComponent(slug)}`] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, user: userEvent.setup() };
}

/** Renders and waits for the form (the title is there from the first frame, so wait for the input). */
async function renderForm(slug: string = JUGGLING, locale: Locale = 'en') {
  const view = await renderRetest(slug, locale);
  await screen.findByRole('textbox');
  return view;
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const input = () => screen.getByRole('textbox') as HTMLInputElement;
const saveButton = (name: RegExp | string = /save result/i) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Types a result, saves it and waits for the saved-result section. */
async function retest(user: ReturnType<typeof userEvent.setup>, value: string): Promise<HTMLElement> {
  await user.type(input(), value);
  await user.click(saveButton());
  return screen.findByRole('region', { name: /your result is saved/i });
}

// --- the request --------------------------------------------------------------------------------

describe('the requests', () => {
  test('one GET for the skill-check options in the active language and one GET for the journey, and nothing else', async () => {
    await renderForm(JUGGLING, 'ru');
    expect(calls.map((call) => call.path).sort()).toEqual(['/api/onboarding/football', '/api/player/journey']);
    expect(calls.find((call) => call.path === '/api/onboarding/football')!.search).toContain('locale=ru');
    expect(calls.find((call) => call.path === '/api/player/journey')!.search).toContain('locale=ru');
  });
});

// --- the protocol, the previous result and the input ----------------------------------------------

describe('before the retest', () => {
  test('the test is named, its protocol is listed step by step, in the active language', async () => {
    await renderForm();
    expect(screen.getByRole('heading', { level: 1, name: 'Juggling' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /how to do it/i })).toBeTruthy();
    const steps = screen.getAllByRole('listitem').map(text);
    expect(steps).toEqual(['Juggle with your stronger foot.', 'Count the touches until the ball drops.']);
  });

  test('the protocol comes in Russian when the language is Russian', async () => {
    await renderForm(JUGGLING, 'ru');
    expect(screen.getAllByRole('listitem').map(text)).toEqual(['Жонглируй сильной ногой.', 'Считай касания, пока мяч не упадёт.']);
  });

  test('a protocol that exists only in English falls back to it', async () => {
    await renderForm(SLALOM, 'kk');
    expect(screen.getAllByRole('listitem').map(text)).toEqual(['Set five cones in a line.', 'Dribble through them and stop the time.']);
  });

  test('the previous result is the latest one of this test, with its unit', async () => {
    await renderForm();
    const previous = screen.getByText(/your previous result/i).closest('p')!;
    expect(text(previous)).toContain('14 touches');
    // It is this test's own row, not the other one's (26 seconds).
    expect(text(previous)).not.toContain('26');
  });

  test('says which direction is better, so a time and a count are not confused', async () => {
    await renderForm(SLALOM);
    expect(screen.getByText(/less is better/i)).toBeTruthy();
    cleanup();
    await renderForm(JUGGLING);
    expect(screen.getByText(/more is better/i)).toBeTruthy();
  });

  test('the input is labelled, names its unit, and the save button is a 44px-tall control', async () => {
    await renderForm();
    const field = screen.getByRole('textbox', { name: /your result today/i });
    expect(field).toBe(input());
    // The hint under the box names the unit, and the box points at it.
    expect(text(document.getElementById(field.getAttribute('aria-describedby')!.split(' ')[0]!)!)).toContain('touches');
    expect(saveButton().className).toContain('min-h-tap');
  });

  test('a decimal keypad is offered for a time and a plain numeric one for a count', async () => {
    await renderForm(SLALOM);
    expect(input().getAttribute('inputmode')).toBe('decimal');
    cleanup();
    await renderForm(JUGGLING);
    expect(input().getAttribute('inputmode')).toBe('numeric');
  });

  test('without an earlier result the screen says so and still offers the input', async () => {
    stubNetwork({ journey: () => json(journeyWith([slalom([30, 26])])) });
    await renderForm();
    expect(screen.queryByText(/your previous result/i)).toBeNull();
    expect(screen.getByText(/today is your starting point/i)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Juggling max touches' })).toBeTruthy();
    expect(input().disabled).toBe(false);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until both answers arrive; no form and no invented numbers meanwhile', async () => {
    const release = deferred<Response>();
    stubNetwork({ journey: () => release.promise });
    await renderRetest();

    const status = await screen.findByRole('status', { name: /loading your skill check/i });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/your previous result/i)).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: /retest/i })).toBeTruthy();

    release.resolve(json(BEFORE));
    await screen.findByRole('textbox');
    expect(screen.queryByRole('status', { name: /loading your skill check/i })).toBeNull();
  });
});

// --- the request that saves ---------------------------------------------------------------------

describe('saving a result', () => {
  test('POSTs one strict test-results request with the slug, the number and a fresh clientUuid', async () => {
    const { user } = await renderForm();
    await retest(user, '21');
    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.path).toBe('/api/player/test-results');
    expect(post.headers.get('content-type')).toContain('application/json');
    // The shared contract (a strict schema) accepts it as is: no stray keys, a lower-case uuid.
    const request = TestResultsRequest.parse(post.body);
    expect(request.results).toEqual([{ testSlug: JUGGLING, value: 21, clientUuid: expect.stringMatching(UUID) }]);
  });

  test('a decimal comma is accepted for a time', async () => {
    stubNetwork({ post: () => json(answer(slalom([30, 26, 24.5]))) });
    const { user } = await renderForm(SLALOM);
    await retest(user, '24,5');
    expect((posts()[0]!.body as { results: Array<{ value: number }> }).results[0]!.value).toBe(24.5);
  });

  test('Enter in the box saves too (it is a real form)', async () => {
    const { user } = await renderForm();
    await user.type(input(), '21{Enter}');
    await screen.findByRole('region', { name: /your result is saved/i });
    expect(posts()).toHaveLength(1);
  });

  test('a zero is a valid measurement', async () => {
    stubNetwork({ post: () => json(answer(juggling([10, 14, 0]))) });
    const { user } = await renderForm();
    await retest(user, '0');
    expect((posts()[0]!.body as { results: Array<{ value: number }> }).results[0]!.value).toBe(0);
  });

  test('the journey the progress screen holds is refreshed, so it never shows the old numbers', async () => {
    const { user } = await renderForm();
    expect(journeyGets()).toHaveLength(1);
    await retest(user, '21');
    await waitFor(() => expect(journeyGets().length).toBeGreaterThan(1));
  });
});

// --- the comparison -----------------------------------------------------------------------------

describe('the comparison after saving', () => {
  test('reads "Your previous result: 14 · Today: 21 · +50%" from the response, with a personal-best note', async () => {
    const { user } = await renderForm();
    const result = await retest(user, '21');
    const summary = text(result);
    expect(summary).toContain('Your previous result: 14 touches');
    expect(summary).toContain('Today: 21 touches');
    expect(within(result).getByText('+50%')).toBeTruthy();
    expect(within(result).getByText(/better than last time/i)).toBeTruthy();
    expect(within(result).getByText(/new personal best: 21 touches/i)).toBeTruthy();
  });

  test('the numbers are the server\'s, not what was typed (a replayed clientUuid keeps the first value)', async () => {
    stubNetwork({ post: () => json(answer(juggling([10, 14, 19]))) });
    const { user } = await renderForm();
    const result = await retest(user, '21');
    expect(text(result)).toContain('Today: 19 touches');
    expect(text(result)).not.toContain('21');
    expect(within(result).getByText('+35.7%')).toBeTruthy();
  });

  test('the change is formatted for the language (a decimal comma in Russian)', async () => {
    stubNetwork({ post: () => json(answer(juggling([10, 14, 19]))) });
    const { user } = await renderForm(JUGGLING, 'ru');
    const result = await retest(user, '19');
    expect(within(result).getByText('+35,7%')).toBeTruthy();
  });

  test('a time that fell is an improvement, shown as a positive percentage', async () => {
    stubNetwork({ post: () => json(answer(slalom([30, 26, 24]))) });
    const { user } = await renderForm(SLALOM);
    const result = await retest(user, '24');
    expect(text(result)).toContain('Your previous result: 26 seconds');
    expect(text(result)).toContain('Today: 24 seconds');
    expect(within(result).getByText('+7.7%')).toBeTruthy();
    expect(within(result).getByText(/new personal best: 24 seconds/i)).toBeTruthy();
  });

  test('the new result is better than last time but not the best ever: no personal-best claim, the best is named', async () => {
    stubNetwork({ post: () => json(answer(juggling([25, 10, 14, 21]))) });
    const { user } = await renderForm();
    const result = await retest(user, '21');
    expect(within(result).getByText(/better than last time/i)).toBeTruthy();
    expect(within(result).queryByText(/new personal best/i)).toBeNull();
    expect(text(result)).toMatch(/personal best: 25 touches/i);
  });

  test('a result equal to the old best is not a new personal best', async () => {
    stubNetwork({ post: () => json(answer(juggling([10, 14, 14]))) });
    const { user } = await renderForm();
    const result = await retest(user, '14');
    expect(within(result).getByText('0%')).toBeTruthy();
    expect(within(result).getByText(/same as last time/i)).toBeTruthy();
    expect(within(result).queryByText(/new personal best/i)).toBeNull();
  });

  test('a first result has nothing to compare with: no percentage, no previous, a kind sentence', async () => {
    stubNetwork({ journey: () => json(journeyWith([])), post: () => json(answer(juggling([21]))) });
    const { user } = await renderForm();
    const result = await retest(user, '21');
    expect(text(result)).toContain('Today: 21 touches');
    expect(text(result)).not.toMatch(/%/);
    expect(text(result)).not.toMatch(/previous result/i);
    expect(within(result).getByText(/this is your first result/i)).toBeTruthy();
    expect(within(result).queryByText(/new personal best/i)).toBeNull();
  });

  test('a worse result is calm: a real minus sign, plain words, no alarm, and encouragement to continue the plan', async () => {
    stubNetwork({ post: () => json(answer(juggling([10, 14, 9]))) });
    const { user } = await renderForm();
    const result = await retest(user, '9');
    expect(text(result)).toContain('Your previous result: 14 touches');
    expect(text(result)).toContain('Today: 9 touches');
    expect(within(result).getByText('−35.7%')).toBeTruthy();
    expect(within(result).getByText(/lower than last time/i)).toBeTruthy();
    expect(within(result).queryByText('+35.7%')).toBeNull();
    // Neutral: no scolding words, no alert role, no red anywhere in the block.
    expect(text(result)).not.toMatch(/fail|bad|worse|wrong|lose|lost|sorry/i);
    expect(within(result).queryByRole('alert')).toBeNull();
    expect(result.innerHTML).not.toMatch(/danger/);
    expect(within(result).queryByText(/new personal best/i)).toBeNull();
    // Encouragement, and a way on.
    expect(within(result).getByText(/keep following your plan/i)).toBeTruthy();
    expect(within(result).getByRole('link', { name: /continue my plan/i }).getAttribute('href')).toBe('/train');
  });

  test('a better result does not carry the "results go up and down" consolation', async () => {
    const { user } = await renderForm();
    const result = await retest(user, '21');
    expect(within(result).queryByText(/keep following your plan/i)).toBeNull();
  });

  test('focus moves to the result heading, and the form is gone', async () => {
    const { user } = await renderForm();
    const result = await retest(user, '21');
    const heading = within(result).getByRole('heading', { name: /your result is saved/i });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save result/i })).toBeNull();
  });

  test('a way back to the journey is offered', async () => {
    const { user } = await renderForm();
    const result = await retest(user, '21');
    expect(within(result).getByRole('link', { name: /back to my journey/i }).getAttribute('href')).toBe('/progress');
  });
});

// --- invalid input ------------------------------------------------------------------------------

describe('invalid input is blocked before anything is sent', () => {
  const cases: Array<{ name: string; slug: string; typed: string; message: RegExp }> = [
    { name: 'nothing typed', slug: JUGGLING, typed: '', message: /enter your result/i },
    { name: 'blanks only', slug: JUGGLING, typed: '   ', message: /enter your result/i },
    { name: 'letters', slug: JUGGLING, typed: 'abc', message: /digits only/i },
    { name: 'a unit typed after the number', slug: JUGGLING, typed: '21 touches', message: /digits only/i },
    { name: 'a negative number', slug: JUGGLING, typed: '-3', message: /cannot be negative/i },
    { name: 'a decimal for a count', slug: JUGGLING, typed: '2.5', message: /whole number/i },
    { name: 'a number too big to be real', slug: JUGGLING, typed: '9'.repeat(400), message: /too big/i },
  ];

  for (const { name, slug, typed, message } of cases) {
    test(`${name}: an error is written next to the field, the field is marked invalid, no request is sent`, async () => {
      const { user } = await renderForm(slug);
      if (typed !== '') fireEvent.change(input(), { target: { value: typed } });
      await user.click(saveButton());

      const alert = await screen.findByRole('alert');
      expect(text(alert)).toMatch(message);
      expect(input().getAttribute('aria-invalid')).toBe('true');
      expect(input().getAttribute('aria-describedby') ?? '').toContain(alert.id);
      expect(posts()).toHaveLength(0);
      // Still the form: nothing was saved, nothing is claimed.
      expect(screen.queryByRole('region', { name: /your result is saved/i })).toBeNull();
    });
  }

  test('a decimal is fine for a time, and the error goes away once the number is fixed', async () => {
    stubNetwork({ post: () => json(answer(slalom([30, 26, 24.5]))) });
    const { user } = await renderForm(SLALOM);
    await user.type(input(), 'x');
    await user.click(saveButton());
    await screen.findByRole('alert');
    await user.clear(input());
    await user.type(input(), '24.5');
    await user.click(saveButton());
    await screen.findByRole('region', { name: /your result is saved/i });
    expect(posts()).toHaveLength(1);
  });
});

// --- disabled while in flight -------------------------------------------------------------------

describe('disabled while a request is in flight', () => {
  test('the button and the box are disabled and busy until the answer arrives, and only one request is sent', async () => {
    const release = deferred<Response>();
    stubNetwork({ post: () => release.promise });
    const { user } = await renderForm();
    await user.type(input(), '21');
    await user.click(saveButton());

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(input().disabled).toBe(true);
    await user.click(saveButton());
    expect(posts()).toHaveLength(1);

    release.resolve(json(answer(juggling([10, 14, 21]))));
    await screen.findByRole('region', { name: /your result is saved/i });
    expect(posts()).toHaveLength(1);
  });

  test('two submits in the same tick still send one request', async () => {
    const release = deferred<Response>();
    stubNetwork({ post: () => release.promise });
    const { user } = await renderForm();
    await user.type(input(), '21');
    const form = input().closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts()).toHaveLength(1));
    release.resolve(json(answer(juggling([10, 14, 21]))));
    await screen.findByRole('region', { name: /your result is saved/i });
    expect(posts()).toHaveLength(1);
  });
});

// --- a failed save ------------------------------------------------------------------------------

describe('a failed save', () => {
  test('says so in plain words, keeps the number, and lets the player press Save again', async () => {
    stubNetwork({ post: () => problem(500) });
    const { user } = await renderForm();
    await user.type(input(), '21');
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not save your result');
    expect(text(alert)).toContain(problemMessages.en.server);
    expect(input().value).toBe('21');
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByRole('region', { name: /your result is saved/i })).toBeNull();
  });

  test('the retry of the SAME number reuses the clientUuid, so it cannot be stored twice', async () => {
    let attempt = 0;
    stubNetwork({ post: () => (++attempt === 1 ? problem(500) : json(answer(juggling([10, 14, 21])))) });
    const { user } = await renderForm();
    await user.type(input(), '21');
    await user.click(saveButton());
    await screen.findByRole('alert');
    await user.click(saveButton());
    await screen.findByRole('region', { name: /your result is saved/i });

    expect(posts()).toHaveLength(2);
    const [first, second] = posts().map((post) => (post.body as { results: Array<{ clientUuid: string }> }).results[0]!.clientUuid);
    expect(first).toMatch(UUID);
    expect(second).toBe(first!);
  });

  test('a CHANGED number is a new attempt with a new clientUuid', async () => {
    stubNetwork({ post: () => problem(500) });
    const { user } = await renderForm();
    await user.type(input(), '21');
    await user.click(saveButton());
    await screen.findByRole('alert');
    await user.clear(input());
    await user.type(input(), '22');
    await user.click(saveButton());
    await waitFor(() => expect(posts()).toHaveLength(2));

    const [first, second] = posts().map((post) => (post.body as { results: Array<{ clientUuid: string }> }).results[0]!.clientUuid);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first!);
  });

  test('going offline is worded as a connection problem', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.includes('test-results')) throw new TypeError('network down');
      return url.includes('onboarding') ? json(OPTIONS) : json(BEFORE);
    }) as unknown as typeof fetch;
    const { user } = await renderForm();
    await user.type(input(), '21');
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(problemMessages.en.offline);
    expect(input().value).toBe('21');
  });
});

// --- empty and error ----------------------------------------------------------------------------

describe('empty', () => {
  for (const status of [401, 404]) {
    test(`a player with no journey yet (${status}) is led to the first check, not shown an error`, async () => {
      stubNetwork({ journey: () => problem(status) });
      await renderRetest();
      await screen.findByText(/your journey starts with the first check/i);
      expect(screen.getByRole('link', { name: /start training/i }).getAttribute('href')).toBe('/train');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
    });
  }

  test('a slug that is not a skill check of this sport says so and leads back to the journey', async () => {
    await renderRetest('no-such-test');
    await screen.findByText(/we do not know this skill check/i);
    expect(screen.getAllByRole('link', { name: /back to my journey/i }).some((link) => link.getAttribute('href') === '/progress')).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('error', () => {
  test('a failed options request shows a localised error with Try again; the button is disabled and busy while it retries', async () => {
    let attempt = 0;
    const release = deferred<Response>();
    stubNetwork({ options: () => (++attempt === 1 ? problem(500) : release.promise) });
    const { user } = await renderRetest();

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load this skill check');
    expect(text(alert)).toContain(problemMessages.en.server);
    await user.click(within(alert).getByRole('button', { name: /try again/i }));
    await waitFor(() => expect((within(screen.getByRole('alert')).getByRole('button') as HTMLButtonElement).disabled).toBe(true));
    expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-busy')).toBe('true');

    release.resolve(json(OPTIONS));
    await screen.findByRole('textbox');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed journey request is an error too (not an empty screen with a missing previous result)', async () => {
    stubNetwork({ journey: () => problem(500) });
    await renderRetest();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not load this skill check');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('the three languages', () => {
  test('the message bundle has the same keys in kk, ru and en, and no value is blank', () => {
    const keysOf = (tree: unknown, prefix = ''): string[] =>
      Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`),
      );
    const valuesOf = (tree: unknown): string[] =>
      Object.values(tree as Record<string, unknown>).flatMap((value) => (typeof value === 'string' ? [value] : valuesOf(value)));
    expect(keysOf(messages.kk).sort()).toEqual(keysOf(messages.en).sort());
    expect(keysOf(messages.ru).sort()).toEqual(keysOf(messages.en).sort());
    for (const locale of LOCALES) for (const value of valuesOf(messages[locale])) expect(value.trim()).not.toBe('');
  });

  test('Russian: the label, the previous result and the saved heading', async () => {
    const { user } = await renderForm(JUGGLING, 'ru');
    expect(screen.getByRole('textbox', { name: /твой результат сегодня/i })).toBeTruthy();
    expect(text(screen.getByText(/твой прошлый результат/i).closest('p')!)).toContain('14 touches');
    await user.type(input(), '21');
    await user.click(screen.getByRole('button', { name: /сохранить результат/i }));
    const result = await screen.findByRole('region', { name: /результат сохранён/i });
    expect(text(result)).toContain('Сегодня: 21 touches');
  });

  test('Kazakh: the saved heading (native review of the copy still pending)', async () => {
    const { user } = await renderForm(JUGGLING, 'kk');
    await user.type(input(), '21');
    await user.click(screen.getByRole('button', { name: /нәтижені сақтау/i }));
    await screen.findByRole('region', { name: /нәтиже сақталды/i });
  });
});
