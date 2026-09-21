import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Rubric, VideoAnalysisList, type RerecordReason } from '@api-types/video';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/video/result.$id';
import messages from './result.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as the other web tests do (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare with === and assert on the boolean instead.

/*
 * The video analysis result screen (/video/result/:id), written from the bead's acceptance criteria (fc-mol-8nt.10):
 *  - "Your analysis" with a Beta tag, the limitation line "Pose only — the ball is not tracked yet", the confidence, each rubric
 *    criterion with its 1-10 score as a number AND a bar AND a note, the "Focus next" sentence, "Recommended next" drills linking to
 *    their commons pages with an "add to today's session" hint, and "Repeat assessment after 3 sessions";
 *  - there is NO overall score anywhere;
 *  - the re-record variant shows tips (from the rubric) instead of scores;
 *  - the earlier analyses of the SAME skill are listed, for self-comparison only;
 *  - loading, empty, error, disabled and success states; the retry button is disabled while a request is in flight;
 *  - every string in kk, ru and en.
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network (globalThis.fetch).
 * The route is mounted in a real (memory-history) router, so the :id param and the search are read by the router itself.
 * Fixtures are parsed with the shared contract schemas, so they cannot drift from the API. Kazakh copy still needs a native
 * review; the Kazakh assertions pin one load-bearing string only.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const LIMITATION_EN = 'Pose only — the ball is not tracked yet';
const SERVER_LIMIT = 'This is a beta coach: it looks at a few still frames and some numbers, not at the whole movement.';

/** Noon UTC, so the calendar day is the same in (nearly) every time zone. */
const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

const drill = (slug: string, title: string, reason: string) => ({ drillVersionId: `dv-${slug}`, slug, title, reason });

type Score = { key: string; label: string; score: number; note: string };
const dribbleScores = (a: number, b: number, c: number): Score[] => [
  { key: 'close-control', label: 'Close control', score: a, note: 'The ball stays near your feet.' },
  { key: 'head-up', label: 'Head up', score: b, note: 'You look down at the ball a lot.' },
  { key: 'change-of-pace', label: 'Change of pace', score: c, note: 'Nice quick bursts.' },
];

function analysis(id: string, skillSlug: string, day: number, scores: Score[], extra: Record<string, unknown> = {}) {
  return {
    id,
    skillSlug,
    createdAt: at(day),
    beta: true,
    confidence: 'medium',
    scores,
    focusNext: 'Keep your head up for two touches in a row.',
    recommended: [
      drill('cone-weave', 'Cone weave', 'Trains close control at a slow pace.'),
      drill('head-up-touches', 'Head-up touches', 'Practise looking up between touches.'),
    ],
    repeatAfterSessions: 3,
    limitations: [SERVER_LIMIT],
    ...extra,
  };
}

const CURRENT_ID = 'an-current';
/** Newest first, like the API: a NEWER dribbling one, the current one, an OLDER dribbling one, and a passing one. */
const HISTORY = VideoAnalysisList.parse([
  analysis('an-newer', 'dribbling', 20, dribbleScores(9, 8, 9)),
  analysis(CURRENT_ID, 'dribbling', 10, dribbleScores(7, 4, 9)),
  analysis('an-older', 'dribbling', 5, dribbleScores(5, 3, 6)),
  analysis('an-passing', 'passing-first-touch', 3, [{ key: 'weight-of-pass', label: 'Weight of pass', score: 2, note: 'Passes are soft.' }]),
]);

const RUBRIC = Rubric.parse({
  skill: 'dribbling',
  version: 1,
  criteria: [{ key: 'close-control', label: 'Close control', description: 'Ball near the feet.', lookFor: ['Small touches'] }],
  recordingTips: ['Film from the side, hips to head in view.', 'Use good light and a plain background.'],
  minVisibility: 0.5,
});

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
type Server = {
  list?: () => Response | Promise<Response>;
  rubric?: () => Response | Promise<Response>;
};

const realFetch = globalThis.fetch;
let calls: Call[] = [];
const clients: QueryClient[] = [];

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, headers: new Headers(init?.headers) });
    if (url.pathname === '/api/player/video-analyses') return (server.list ?? (() => json(HISTORY)))();
    if (url.pathname.startsWith('/api/video/rubrics/')) return (server.rubric ?? (() => json(RUBRIC)))();
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const listGets = () => calls.filter((call) => call.path === '/api/player/video-analyses');
const rubricGets = () => calls.filter((call) => call.path.startsWith('/api/video/rubrics/'));

/**
 * The happy-dom window is shared by every test file of the web package. A heavy Testing Library file leaves thousands of entries in
 * its internal query caches, which slows LATER files down (see features/contribute/form.test.tsx): empty them, the way happy-dom
 * itself empties them when a node changes (every recorded result is invalidated first, then the list is cleared).
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

beforeEach(() => stubNetwork());
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './result.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The route in a real router at /video/result/<id><search>, so the param and the search are read by the router itself. */
async function renderResult(id: string = CURRENT_ID, options: { locale?: Locale; search?: string } = {}) {
  const instance = createI18n({ modules, languages: [options.locale ?? 'en'], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  clients.push(queryClient);
  const rootRoute = createRootRoute();
  const resultRoute = Route.update({ id: '/video/result/$id', path: '/video/result/$id', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([resultRoute as never]),
    history: createMemoryHistory({ initialEntries: [`/video/result/${encodeURIComponent(id)}${options.search ?? ''}`] }),
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

/** Renders and waits for the analysis (the h1 is there from the first frame, so wait for the scores). */
async function renderAnalysis(id: string = CURRENT_ID, locale: Locale = 'en') {
  const view = await renderResult(id, { locale });
  await screen.findAllByRole('meter');
  return view;
}

const rerecordSearch = (reason: string, skill?: string) => `?rerecord=${reason}${skill === undefined ? '' : `&skill=${skill}`}`;

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const link = (name: RegExp | string) => screen.getByRole('link', { name }) as HTMLAnchorElement;
const hrefOf = (element: HTMLAnchorElement): string => element.getAttribute('href') ?? '';
const meters = () => screen.queryAllByRole('meter');
const section = (name: RegExp | string) => screen.getByRole('region', { name });

// --- the requests -------------------------------------------------------------------------------

describe('the requests', () => {
  test('one GET of the history, and nothing else: there is no single-item endpoint and no rubric call for a finished analysis', async () => {
    await renderAnalysis();
    expect(listGets()).toHaveLength(1);
    expect(listGets()[0]!.method).toBe('GET');
    expect(calls.map((call) => call.path)).toEqual(['/api/player/video-analyses']);
  });
});

// --- the finished analysis ----------------------------------------------------------------------

describe('a finished analysis', () => {
  test('is titled "Your analysis" with a Beta tag', async () => {
    await renderAnalysis();
    expect(screen.getByRole('heading', { level: 1, name: /your analysis/i })).toBeTruthy();
    expect(screen.getByText('Beta').getAttribute('data-tone')).toBe('warning');
  });

  test('says in words that only the pose is looked at and the ball is not tracked yet', async () => {
    await renderAnalysis();
    expect(screen.getByText(LIMITATION_EN)).toBeTruthy();
    expect(messages.en.limitation).toBe(LIMITATION_EN);
  });

  test('names the confidence in words', async () => {
    await renderAnalysis();
    expect(text(screen.getByText(/confidence/i).closest('p')!)).toContain('Medium');
  });

  test('a low confidence is named as calmly as a high one, and the API limitations are listed too', async () => {
    const low = VideoAnalysisList.parse([analysis(CURRENT_ID, 'dribbling', 10, dribbleScores(7, 4, 9), { confidence: 'low', limitations: [SERVER_LIMIT, 'The coach was not sure about some of what it saw.'] })]);
    stubNetwork({ list: () => json(low) });
    await renderAnalysis();
    expect(text(screen.getByText(/confidence/i).closest('p')!)).toContain('Low');
    expect(screen.getByText(SERVER_LIMIT)).toBeTruthy();
    expect(screen.getByText('The coach was not sure about some of what it saw.')).toBeTruthy();
  });

  test('each rubric criterion has its label, the 1-10 score as a number, a bar and the note', async () => {
    await renderAnalysis();
    const bars = meters();
    expect(bars).toHaveLength(3);
    for (const [label, score, note] of [
      ['Close control', 7, 'The ball stays near your feet.'],
      ['Head up', 4, 'You look down at the ball a lot.'],
      ['Change of pace', 9, 'Nice quick bursts.'],
    ] as const) {
      const bar = screen.getByRole('meter', { name: label });
      expect(bar.getAttribute('aria-valuenow')).toBe(String(score));
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('10');
      const card = bar.parentElement!;
      expect(text(card)).toContain(label);
      expect(text(card)).toContain(`${score} / 10`);
      expect(text(card)).toContain(note);
    }
  });

  test('the bar is filled in proportion to the score (never colour alone: the number is beside it)', async () => {
    await renderAnalysis();
    const fill = (label: string) => (screen.getByRole('meter', { name: label }).firstElementChild as HTMLElement).style.width;
    expect(fill('Close control')).toBe('70%');
    expect(fill('Head up')).toBe('40%');
    expect(fill('Change of pace')).toBe('90%');
  });

  test('shows the Focus next sentence', async () => {
    await renderAnalysis();
    const focus = screen.getByRole('heading', { level: 2, name: 'Focus next' });
    expect(text(focus.parentElement!)).toContain('Keep your head up for two touches in a row.');
  });

  test('says when to repeat the assessment', async () => {
    await renderAnalysis();
    expect(screen.getByText('Repeat assessment after 3 sessions')).toBeTruthy();
  });
});

describe('there is NO overall score', () => {
  test('one bar per criterion and no other bar, meter or progress indicator', async () => {
    await renderAnalysis();
    expect(meters()).toHaveLength(HISTORY[1]!.scores.length);
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

  test('no total, overall, average or out-of-100 wording or number is rendered', async () => {
    await renderAnalysis();
    const body = text(document.body);
    expect(body).not.toMatch(/overall|total|average|mean score|out of 100|\/ ?100|%/i);
    // The only "x / 10" texts are the criteria's own scores (plus the earlier analyses' own), never a computed one.
    const shown = new Set(Array.from(body.matchAll(/(\d+(?:[.,]\d+)?) \/ 10/g), (match) => match[1]));
    const own = new Set(HISTORY.filter((row) => row.skillSlug === 'dribbling').flatMap((row) => row.scores.map((score) => String(score.score))));
    for (const value of shown) expect(own.has(value!)).toBe(true);
    // The mean of the current scores (6.67) is not shown in any rounding.
    expect(body).not.toMatch(/6[.,]7|6[.,]67/);
  });

  test('the message bundle has no wording of an overall score in any language', () => {
    const all = JSON.stringify(messages);
    expect(all).not.toMatch(/overall|total score|average|out of 100|\/ ?100|общий балл|итоговый|средний балл|жалпы балл|қорытынды балл/i);
  });
});

// --- the recommended drills ---------------------------------------------------------------------

describe('recommended next', () => {
  test('lists each drill as a link to its commons page, with the reason', async () => {
    await renderAnalysis();
    const drills = section('Recommended next');
    const cone = within(drills).getByRole('link', { name: 'Cone weave' });
    expect(hrefOf(cone as HTMLAnchorElement)).toBe('/commons/cone-weave');
    expect(text(cone.closest('li')!)).toContain('Trains close control at a slow pace.');
    expect(hrefOf(within(drills).getByRole('link', { name: 'Head-up touches' }) as HTMLAnchorElement)).toBe('/commons/head-up-touches');
    expect(within(drills).getAllByRole('link')).toHaveLength(2);
  });

  test('hints that a drill can be added to today\'s session', async () => {
    await renderAnalysis();
    expect(text(section('Recommended next'))).toMatch(/today's session/i);
  });

  test('a slug with special characters is encoded in the link', async () => {
    const data = [analysis(CURRENT_ID, 'dribbling', 10, dribbleScores(7, 4, 9), { recommended: [drill('a.b_c-1', 'Odd slug', 'Because.')] })];
    stubNetwork({ list: () => json(VideoAnalysisList.parse(data)) });
    await renderAnalysis();
    expect(hrefOf(link('Odd slug'))).toBe('/commons/a.b_c-1');
  });

  test('without recommended drills the section is left out (no empty heading)', async () => {
    stubNetwork({ list: () => json(VideoAnalysisList.parse([analysis(CURRENT_ID, 'dribbling', 10, dribbleScores(7, 4, 9), { recommended: [] })])) });
    await renderAnalysis();
    expect(screen.queryByRole('heading', { name: 'Recommended next' }) === null).toBe(true);
    expect(screen.queryByText(/today's session/i) === null).toBe(true);
  });
});

// --- the history --------------------------------------------------------------------------------

describe('earlier analyses of the same skill', () => {
  test('lists only OLDER analyses of the same skill: not a newer one, not another skill, not this one', async () => {
    await renderAnalysis();
    const earlier = section(/earlier analyses/i);
    const links = within(earlier).getAllByRole('link');
    expect(links.map((anchor) => hrefOf(anchor as HTMLAnchorElement))).toEqual(['/video/result/an-older']);
    expect(text(earlier)).toContain('Close control');
    expect(text(earlier)).toContain('5 / 10');
    expect(text(earlier)).not.toContain('Weight of pass');
    expect(text(earlier)).not.toContain('9 / 10'); // the newer one
  });

  test('each earlier analysis carries its date', async () => {
    await renderAnalysis();
    const stamp = within(section(/earlier analyses/i)).getByRole('link').querySelector('time');
    expect(stamp === null).toBe(false);
    expect(stamp!.getAttribute('datetime')).toBe(at(5));
  });

  test('says the list is for comparing with yourself only, and holds no ranking or other player', async () => {
    await renderAnalysis();
    const earlier = section(/earlier analyses/i);
    expect(text(earlier)).toMatch(/only for comparing with yourself/i);
    expect(text(earlier)).not.toMatch(/rank|best|worst|leaderboard|other players|everyone/i);
  });

  test('a first analysis of a skill says so, gently', async () => {
    await renderAnalysis('an-passing');
    expect(text(section(/earlier analyses/i))).toContain(messages.en.history.none);
    expect(within(section(/earlier analyses/i)).queryAllByRole('link')).toHaveLength(0);
  });

  test('an earlier analysis opens its own result page', async () => {
    await renderAnalysis('an-older');
    expect(screen.getByRole('heading', { level: 1, name: /your analysis/i })).toBeTruthy();
    expect(within(screen.getByRole('meter', { name: 'Close control' }).parentElement!).getByText('5 / 10')).toBeTruthy();
    // It is the oldest dribbling one: nothing earlier.
    expect(text(section(/earlier analyses/i))).toContain(messages.en.history.none);
  });
});

// --- the re-record variant ----------------------------------------------------------------------

describe('the re-record variant', () => {
  test('shows why and the recording tips of the skill INSTEAD of scores, with a way to film again', async () => {
    await renderResult('rerecord', { search: rerecordSearch('low_visibility', 'dribbling') });
    expect(await screen.findByText('Film from the side, hips to head in view.')).toBeTruthy();
    expect(screen.getByText('Use good light and a plain background.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: messages.en.rerecord.low_visibility.title })).toBeTruthy();
    expect(screen.getByText(messages.en.rerecord.low_visibility.hint)).toBeTruthy();
    expect(hrefOf(link(messages.en.rerecord.action))).toBe('/video');
  });

  test('has no scores, no bars, no confidence, no focus, no drills and no history', async () => {
    await renderResult('rerecord', { search: rerecordSearch('too_dark', 'dribbling') });
    await screen.findByText('Film from the side, hips to head in view.');
    expect(meters()).toHaveLength(0);
    const body = text(document.body);
    expect(body).not.toMatch(/ \/ 10|confidence|focus next|recommended next|earlier analyses/i);
    expect(listGets()).toHaveLength(0);
  });

  test('asks the rubric of that skill in the active language, and nothing else', async () => {
    await renderResult('rerecord', { locale: 'ru', search: rerecordSearch('too_short', 'dribbling') });
    await screen.findByText('Film from the side, hips to head in view.');
    expect(rubricGets()).toHaveLength(1);
    expect(rubricGets()[0]!.path).toBe('/api/video/rubrics/dribbling');
    expect(rubricGets()[0]!.search).toContain('locale=ru');
    expect(calls).toHaveLength(1);
  });

  for (const reason of ['low_visibility', 'too_dark', 'too_short'] as const satisfies readonly RerecordReason[]) {
    test(`the reason ${reason} has its own words`, async () => {
      await renderResult('rerecord', { search: rerecordSearch(reason, 'dribbling') });
      expect(screen.getByRole('heading', { level: 1, name: messages.en.rerecord[reason].title })).toBeTruthy();
      expect(screen.getByText(messages.en.rerecord[reason].hint)).toBeTruthy();
      await screen.findByText('Use good light and a plain background.');
    });
  }

  test('without a skill there is nothing to look up: the reason and the way to film again still show', async () => {
    await renderResult('rerecord', { search: rerecordSearch('low_visibility') });
    expect(screen.getByRole('heading', { level: 1, name: messages.en.rerecord.low_visibility.title })).toBeTruthy();
    expect(hrefOf(link(messages.en.rerecord.action))).toBe('/video');
    expect(calls).toHaveLength(0);
  });

  test('while the tips load they are a named busy status; the reason is already there', async () => {
    const release = deferred<Response>();
    stubNetwork({ rubric: () => release.promise });
    await renderResult('rerecord', { search: rerecordSearch('low_visibility', 'dribbling') });
    const status = await screen.findByRole('status', { name: messages.en.tips.loading });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(messages.en.rerecord.low_visibility.hint)).toBeTruthy();
    release.resolve(json(RUBRIC));
    await screen.findByText('Use good light and a plain background.');
    expect(screen.queryByRole('status', { name: messages.en.tips.loading }) === null).toBe(true);
  });

  test('tips that cannot be loaded do not hide the reason; Try again is disabled and busy while it retries', async () => {
    let attempt = 0;
    const release = deferred<Response>();
    stubNetwork({ rubric: () => (++attempt === 1 ? problem(500) : release.promise) });
    const { user } = await renderResult('rerecord', { search: rerecordSearch('low_visibility', 'dribbling') });
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(messages.en.tips.error.title);
    expect(screen.getByText(messages.en.rerecord.low_visibility.hint)).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: messages.en.tips.error.retry }));
    await waitFor(() => expect((within(screen.getByRole('alert')).getByRole('button') as HTMLButtonElement).disabled).toBe(true));
    expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-busy')).toBe('true');
    release.resolve(json(RUBRIC));
    await screen.findByText('Use good light and a plain background.');
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a skill the rubric does not know (404) leaves the reason and the way to film again, without an error', async () => {
    stubNetwork({ rubric: () => problem(404) });
    await renderResult('rerecord', { search: rerecordSearch('too_dark', 'no-such-skill') });
    await waitFor(() => expect(rubricGets()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('status', { name: messages.en.tips.loading }) === null).toBe(true));
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(hrefOf(link(messages.en.rerecord.action))).toBe('/video');
  });

  test('a reason the contract does not know is ignored: the id is looked up in the history as usual', async () => {
    await renderResult(CURRENT_ID, { search: rerecordSearch('bogus', 'dribbling') });
    await screen.findAllByRole('meter');
    expect(listGets()).toHaveLength(1);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the history arrives; no scores and no invented numbers meanwhile', async () => {
    const release = deferred<Response>();
    stubNetwork({ list: () => release.promise });
    await renderResult();
    const status = await screen.findByRole('status', { name: messages.en.loading });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(meters()).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: /your analysis/i })).toBeTruthy();
    release.resolve(json(HISTORY));
    await screen.findAllByRole('meter');
    expect(screen.queryByRole('status', { name: messages.en.loading }) === null).toBe(true);
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty', () => {
  test('an id that is not in the history is "not found", calmly, with a way to analyse a clip', async () => {
    await renderResult('an-unknown');
    expect(await screen.findByText(messages.en.empty.unknown.title)).toBeTruthy();
    expect(hrefOf(link(messages.en.empty.unknown.action))).toBe('/video');
    expect(meters()).toHaveLength(0);
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a player with no analyses yet is invited to make the first one', async () => {
    stubNetwork({ list: () => json([]) });
    await renderResult();
    expect(await screen.findByText(messages.en.empty.none.title)).toBeTruthy();
    expect(hrefOf(link(messages.en.empty.none.action))).toBe('/video');
  });

  test('the API saying there is no profile yet (404) is empty too, not an error', async () => {
    stubNetwork({ list: () => problem(404) });
    await renderResult();
    expect(await screen.findByText(messages.en.empty.none.title)).toBeTruthy();
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('the scores of another analysis are never shown for an unknown id', async () => {
    await renderResult('an-unknown');
    await screen.findByText(messages.en.empty.unknown.title);
    expect(text(document.body)).not.toContain('Close control');
  });
});

// --- error --------------------------------------------------------------------------------------

describe('error', () => {
  test('a failed request shows a localised error with Try again; the button is disabled and busy while it retries', async () => {
    let attempt = 0;
    const release = deferred<Response>();
    stubNetwork({ list: () => (++attempt === 1 ? problem(500) : release.promise) });
    const { user } = await renderResult();

    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(messages.en.error.title);
    expect(text(alert)).toContain(problemMessages.en.server);
    expect(meters()).toHaveLength(0);
    await user.click(within(alert).getByRole('button', { name: messages.en.error.retry }));
    await waitFor(() => expect((within(screen.getByRole('alert')).getByRole('button') as HTMLButtonElement).disabled).toBe(true));
    expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-busy')).toBe('true');
    expect(listGets()).toHaveLength(2);

    release.resolve(json(HISTORY));
    await screen.findAllByRole('meter');
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a network failure says so in the offline words', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await renderResult();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain(problemMessages.en.offline);
  });

  test('an answer that does not fit the contract is an error, never half a screen', async () => {
    stubNetwork({ list: () => json([{ id: CURRENT_ID, skillSlug: 'dribbling' }]) });
    await renderResult();
    await screen.findByRole('alert');
    expect(meters()).toHaveLength(0);
  });
});

// --- disabled -----------------------------------------------------------------------------------

describe('disabled', () => {
  test('a 403 says Video Coach is turned off, with a way back and no retry', async () => {
    stubNetwork({ list: () => problem(403) });
    await renderResult();
    expect(await screen.findByText(messages.en.disabled.title)).toBeTruthy();
    expect(screen.queryByRole('button') === null).toBe(true);
    expect(hrefOf(link(messages.en.disabled.action))).toBe('/train');
    expect(meters()).toHaveLength(0);
  });
});

// --- the page -----------------------------------------------------------------------------------

describe('the page', () => {
  test('links back to the Video Coach and holds exactly one h1', async () => {
    await renderAnalysis();
    expect(hrefOf(link(messages.en.back))).toBe('/video');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  test('every link and button is at least a 44px control', async () => {
    await renderAnalysis();
    for (const control of [...screen.getAllByRole('link'), ...screen.queryAllByRole('button')]) {
      expect(control.className).toContain('min-h-tap');
    }
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('the three languages', () => {
  const flat = (tree: unknown, prefix = ''): Array<[string, string]> =>
    Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
      typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : flat(value, `${prefix}${key}.`),
    );

  test('the message bundle has the same keys in kk, ru and en, and no value is blank', () => {
    const keys = (locale: Locale) => flat(messages[locale]).map(([key]) => key).sort();
    expect(keys('kk')).toEqual(keys('en'));
    expect(keys('ru')).toEqual(keys('en'));
    for (const locale of LOCALES) for (const [, value] of flat(messages[locale])) expect(value.trim()).not.toBe('');
  });

  test('Russian and Kazakh are written in Cyrillic, with the same placeholders as English', () => {
    const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
    const english = new Map(flat(messages.en));
    for (const locale of ['kk', 'ru'] as const) {
      for (const [key, value] of flat(messages[locale])) {
        expect(value).toMatch(/[Ѐ-ӿ]/);
        expect(placeholders(value)).toBe(placeholders(english.get(key)!));
      }
    }
  });

  test('the limitation line is in every language and the English one is the required sentence', () => {
    expect(messages.en.limitation).toBe('Pose only — the ball is not tracked yet');
    expect(messages.ru.limitation).not.toBe(messages.en.limitation);
    expect(messages.kk.limitation).not.toBe(messages.en.limitation);
  });

  test('Russian: the title, the limitation line, the criterion score and the drills heading', async () => {
    await renderAnalysis(CURRENT_ID, 'ru');
    expect(screen.getByRole('heading', { level: 1, name: messages.ru.title })).toBeTruthy();
    expect(screen.getByText(messages.ru.limitation)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: messages.ru.focus })).toBeTruthy();
    expect(screen.getByRole('region', { name: messages.ru.drills.title })).toBeTruthy();
    expect(text(screen.getByRole('meter', { name: 'Close control' }).parentElement!)).toContain('7 / 10');
    expect(text(document.body)).not.toMatch(/undefined|\[object|\{\{/);
  });

  test('Kazakh: the title, the limitation line and the repeat line (native review of the copy still pending)', async () => {
    await renderAnalysis(CURRENT_ID, 'kk');
    expect(screen.getByRole('heading', { level: 1, name: messages.kk.title })).toBeTruthy();
    expect(screen.getByText(messages.kk.limitation)).toBeTruthy();
    expect(screen.getByText(messages.kk.repeat.replace('{{sessions}}', '3'))).toBeTruthy();
  });

  test('the re-record variant and the empty state speak Russian too', async () => {
    await renderResult('rerecord', { locale: 'ru', search: rerecordSearch('too_dark', 'dribbling') });
    expect(screen.getByRole('heading', { level: 1, name: messages.ru.rerecord.too_dark.title })).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.ru.rerecord.action })).toBeTruthy();
    cleanup();
    await renderResult('an-unknown', { locale: 'ru' });
    expect(await screen.findByText(messages.ru.empty.unknown.title)).toBeTruthy();
  });
});
