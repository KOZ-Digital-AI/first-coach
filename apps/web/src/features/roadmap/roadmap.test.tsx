import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StartResponse } from '@api-types/onboarding';
import type { Locale } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { PlayerSessionError } from '../../lib/auth';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { RoadmapDepsContext, Route } from '../../routes/train/roadmap';
import messages from './roadmap.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web, but the bead's verify command
// runs from the repo root, where there is no DOM. Register happy-dom here BEFORE Testing Library is imported (same order
// rule as test/setup.ts and the wizard test); the `document` guard keeps it a no-op under the preload.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

/*
 * Written from the bead's acceptance criteria (fc-mol-9l4.15), not from the implementation:
 *  - /train/roadmap shows MY ROADMAP from GET /api/player/me: the current level label, a level per track, the goal,
 *    "N weeks · N sessions/week · N min/session", the 2-3 focus skills as roadmap items with current -> target level and the
 *    localized reason, and one primary button "Open today's training" that goes to /train;
 *  - a player who is not onboarded (404) is redirected to /train/onboarding;
 *  - no wording promises a professional career;
 *  - loading, empty, error, disabled and success states; the one control that sends a request (Try again) is disabled while
 *    its request is in flight; all strings come from roadmap.messages.ts in kk, ru and en;
 *  - real data only: the screen is fed by the typed client through React Query under the persisted key ['me'].
 * The server is a fake `fetch` handed to the real `createApi`, so headers, problem parsing and schema parsing are the real
 * thing. Only the network (and the anonymous sign-in, a separate module) is faked. Kazakh copy still needs a native review,
 * so kk is matched by stems and digits, not by whole sentences.
 */

// --- fixtures (test data only: nothing here ships) --------------------------------------------------------------------

const ME: StartResponse = {
  profile: {
    age: 10,
    level: 'basic',
    goal: 'dribbling',
    equipment: 'ball',
    space: 'yard',
    partner: false,
    daysPerWeek: 3,
    minutesPerSession: 20,
    locale: 'en',
  },
  roadmap: {
    currentLevelLabel: 'Basic',
    tracks: [
      { skill: 'ball-mastery', level: 2, source: 'test' },
      { skill: 'dribbling', level: 3, source: 'self' },
      { skill: 'weak-foot', level: 1, source: 'test' },
    ],
    goal: 'dribbling',
    weeks: 4,
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'dribbling', level: 3, targetLevel: 4, reason: 'goal' },
      { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
      { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'weakest' },
    ],
  },
};

const withRoadmap = (patch: Partial<StartResponse['roadmap']>): StartResponse => ({ ...ME, roadmap: { ...ME.roadmap, ...patch } });

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const problem = (status: number, title: string) => json({ type: 'about:blank', title, status }, status, 'application/problem+json');
const notOnboarded = () => problem(404, 'Not Found');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Tree = { [key: string]: string | Tree };
const bundle = (locale: Locale): Tree => messages[locale] as Tree;

/** The string at a dotted path of a locale's bundle, with {{name}} placeholders filled. */
function text(locale: Locale, path: string, vars: Record<string, string | number> = {}): string {
  const value = path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], bundle(locale));
  if (typeof value !== 'string') throw new Error(`roadmap.messages has no string at "${locale}:${path}"`);
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}

const PLAN_LINE: Record<'en' | 'ru', (sessions: number) => string> = {
  en: (sessions) => `4 weeks · ${sessions} sessions/week · 20 min/session`,
  ru: (sessions) => `4 недели · ${sessions} ${sessions >= 5 ? 'занятий' : 'занятия'} в неделю · 20 мин на занятие`,
};

// Things a screen for children must never say, in any language: a professional career.
const CAREER_CLAIM = /professional|career|профессионал|карьер|кәсіпқой|кәсіби|мансап/i;

// --- harness ----------------------------------------------------------------------------------------------------------

type Reply = Response | Promise<Response>;
type Call = { method: string; url: string; language: string | null };

type Setup = {
  locale?: Locale;
  /** The answer to GET /api/player/me (default: the fixture). May differ per call. */
  me?: (attempt: number) => Reply;
  /** What already sits in the React Query cache under ['me'] (a restored, persisted answer). */
  seed?: unknown;
  ensureSession?: () => Promise<unknown>;
};

const MODULES = {
  './roadmap.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};

function mountRoadmap(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const calls: Call[] = [];
  const order: string[] = [];
  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: input, language: new Headers(init?.headers).get('accept-language') });
    order.push(`${method} ${input}`);
    if (method === 'GET' && input === '/api/player/me') return (setup.me ?? (() => json(ME)))(calls.length);
    return new Response('unexpected request', { status: 418 });
  };
  const api = createApi({ fetch: fetchImpl, language: () => i18n.language, online: () => true });

  const ensureSession = mock(
    setup.ensureSession ??
      (async () => {
        order.push('ensureSession');
        return { user: { id: 'player-1' } };
      }),
  );
  const navigate = mock((to: string, options?: { replace?: boolean }) => void order.push(`navigate ${to}${options?.replace ? ' (replace)' : ''}`));

  // Retries are ON in the test client (two, a millisecond apart), so a screen that leaves the automatic retry on is caught.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1, gcTime: Infinity } } });
  if (setup.seed !== undefined) queryClient.setQueryData(['me'], setup.seed);

  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the /train/roadmap route has no component');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RoadmapDepsContext.Provider value={{ api, ensureSession, navigate }}>
          <Page />
        </RoadmapDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { i18n, calls, order, ensureSession, navigate, queryClient, unmount: view.unmount, meCalls: () => calls.filter((call) => call.url === '/api/player/me') };
}

afterEach(() => {
  cleanup();
});

const primaryLink = (locale: Locale = 'en') => screen.getByRole<HTMLAnchorElement>('link', { name: text(locale, 'start') });
const focusItems = (locale: Locale = 'en') => within(screen.getByRole('list', { name: text(locale, 'focus.listLabel') })).getAllByRole('listitem');
const skillItems = (locale: Locale = 'en') => within(screen.getByRole('list', { name: text(locale, 'skills.listLabel') })).getAllByRole('listitem');
const heading = (name: string | RegExp, level: number) => screen.getByRole('heading', { name, level });

// --- the route ---------------------------------------------------------------------------------------------------------

describe('route', () => {
  test('/train/roadmap is a file route with a component', () => {
    expect(typeof Route.options.component).toBe('function');
  });
});

// --- data: the typed client, React Query, the persisted key -------------------------------------------------------------

describe('data', () => {
  test('asks GET /api/player/me exactly once, after making sure there is a session, in the active language', async () => {
    const page = mountRoadmap({ locale: 'ru' });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(page.meCalls()).toHaveLength(1));
    expect(page.order.slice(0, 2)).toEqual(['ensureSession', 'GET /api/player/me']);
    expect(page.calls).toHaveLength(1);
    expect(page.meCalls()[0]?.language).toBe('ru');
  });

  test('keeps the answer in the query cache under the persisted key ["me"]', async () => {
    const page = mountRoadmap();
    await screen.findByRole('link', { name: text('en', 'start') });
    expect(page.queryClient.getQueryData(['me'])).toEqual(ME);
  });

  test('shows the saved ["me"] answer at once while the refresh is still on its way', async () => {
    const pending = deferred<Response>();
    mountRoadmap({ seed: ME, me: () => pending.promise });
    expect(await screen.findByText('Basic')).toBeTruthy();
    expect(primaryLink()).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    pending.resolve(json(ME));
  });
});

// --- success ---------------------------------------------------------------------------------------------------------

describe('success (en)', () => {
  test('MY ROADMAP is the page heading, with the current level label and the goal', async () => {
    mountRoadmap();
    expect(await screen.findByRole('heading', { level: 1, name: 'My roadmap' })).toBeTruthy();
    expect(screen.getByText(text('en', 'levelNow'))).toBeTruthy();
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(screen.getByText(text('en', 'goalLabel'))).toBeTruthy();
    expect(screen.getByText(text('en', 'goals.dribbling'))).toBeTruthy();
  });

  test('says "N weeks · N sessions/week · N min/session" with the plan\'s own numbers', async () => {
    mountRoadmap();
    expect(await screen.findByText('4 weeks · 3 sessions/week · 20 min/session')).toBeTruthy();
  });

  test('another plan shows its own numbers, not the fixture\'s', async () => {
    mountRoadmap({ me: () => json(withRoadmap({ sessionsPerWeek: 5, minutesPerSession: 45 })) });
    expect(await screen.findByText('4 weeks · 5 sessions/week · 45 min/session')).toBeTruthy();
  });

  test('a level for every track: name, "Level n / 5", a progress bar and where the level came from', async () => {
    mountRoadmap();
    await screen.findByRole('link', { name: text('en', 'start') });
    const items = skillItems();
    expect(items).toHaveLength(3);
    const [ballMastery, dribbling, weakFoot] = items as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(ballMastery).getByText(text('en', 'tracks.ball-mastery'))).toBeTruthy();
    expect(within(ballMastery).getByText('Level 2 / 5')).toBeTruthy();
    expect(within(ballMastery).getByText(text('en', 'skills.source.test'))).toBeTruthy();

    expect(within(dribbling).getByText('Level 3 / 5')).toBeTruthy();
    expect(within(dribbling).getByText(text('en', 'skills.source.self'))).toBeTruthy();

    expect(within(weakFoot).getByText('Level 1 / 5')).toBeTruthy();

    const bar = within(dribbling).getByRole('progressbar', { name: text('en', 'tracks.dribbling') });
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemin')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
    expect(bar.getAttribute('aria-valuetext')).toBe('Level 3 / 5');
  });

  test('the focus skills are roadmap items in the order the plan gives them, each with current -> target level and its reason', async () => {
    mountRoadmap();
    await screen.findByRole('link', { name: text('en', 'start') });
    const items = focusItems();
    expect(items).toHaveLength(3);
    const [first, second, third] = items as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(first).getByRole('heading', { level: 3, name: text('en', 'tracks.dribbling') })).toBeTruthy();
    expect(within(first).getByText('Level 3 → 4')).toBeTruthy();
    expect(within(first).getByText('From level 3 to level 4')).toBeTruthy();
    expect(within(first).getByText(text('en', 'focus.reason.goal'))).toBeTruthy();

    expect(within(second).getByRole('heading', { level: 3, name: text('en', 'tracks.weak-foot') })).toBeTruthy();
    expect(within(second).getByText('Level 1 → 2')).toBeTruthy();
    expect(within(second).getByText(text('en', 'focus.reason.weakest'))).toBeTruthy();

    expect(within(third).getByText('Level 2 → 3')).toBeTruthy();
  });

  test('two focus skills are enough: the list is exactly what the plan holds', async () => {
    mountRoadmap({ me: () => json(withRoadmap({ focus: ME.roadmap.focus.slice(0, 2) })) });
    await screen.findByRole('link', { name: text('en', 'start') });
    expect(focusItems()).toHaveLength(2);
  });

  test('a skill already at the top level is not shown as "5 → 5"', async () => {
    mountRoadmap({
      me: () =>
        json(
          withRoadmap({
            focus: [
              { skill: 'dribbling', level: 5, targetLevel: 5, reason: 'goal' },
              { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
            ],
          }),
        ),
    });
    await screen.findByRole('link', { name: text('en', 'start') });
    const [top] = focusItems() as [HTMLElement];
    expect(within(top).getByText(text('en', 'focus.hold', { level: 5 }))).toBeTruthy();
    expect(within(top).queryByText(/5 → 5/)).toBeNull();
  });

  test('a track, level label or reason this build has no words for is shown as the server sent it, never blank', async () => {
    mountRoadmap({
      me: () =>
        json(
          withRoadmap({
            currentLevelLabel: 'Elite',
            tracks: [
              { skill: 'sprint-speed', level: 4, source: 'test' },
              { skill: 'ball-mastery', level: 2, source: 'self' },
            ],
            focus: [
              { skill: 'sprint-speed', level: 4, targetLevel: 5, reason: 'Because your legs are quick.' },
              { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'weakest' },
            ],
          }),
        ),
    });
    expect(await screen.findByText('Elite')).toBeTruthy();
    const [first] = focusItems() as [HTMLElement];
    expect(within(first).getByRole('heading', { level: 3, name: 'Sprint speed' })).toBeTruthy();
    expect(within(first).getByText('Because your legs are quick.')).toBeTruthy();
    expect(screen.getByText(text('en', 'focus.reason.weakest'))).toBeTruthy();
  });

  test('every level label the planner can produce has its own words', async () => {
    for (const label of ['Foundation', 'Basic', 'Intermediate', 'Advanced'] as const) {
      const page = mountRoadmap({ me: () => json(withRoadmap({ currentLevelLabel: label })) });
      expect(await screen.findByText(text('en', `levels.${label}`))).toBeTruthy();
      page.unmount();
    }
  });

  test('there is no per-track empty state when tracks exist, and no alert or status on a healthy page', async () => {
    mountRoadmap();
    await screen.findByRole('link', { name: text('en', 'start') });
    expect(screen.queryByText(text('en', 'skills.empty.title'))).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(text('en', 'loading'))).toBeNull();
  });
});

// --- the one primary action ---------------------------------------------------------------------------------------------

describe('Open today\'s training', () => {
  test('is the only primary control: a link to /train at least 44px tall', async () => {
    mountRoadmap();
    await screen.findByRole('link', { name: "Open today's training" });
    const link = primaryLink();
    expect(link.getAttribute('href')).toBe('/train');
    expect(link.className).toContain('min-h-tap');
    expect(screen.queryAllByRole('link', { name: "Open today's training" })).toHaveLength(1);
  });

  test('a plain click goes to /train inside the app and is not a page load', async () => {
    const page = mountRoadmap();
    await screen.findByRole('link', { name: "Open today's training" });
    let prevented: boolean | undefined;
    const record = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault(); // the test never really navigates
    };
    document.addEventListener('click', record, { once: true });
    fireEvent.click(primaryLink());
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(page.navigate.mock.calls[0]?.[0]).toBe('/train');
    expect(prevented).toBe(true);
  });

  test('a ctrl-click is left to the browser (a new tab), so the app does not also navigate', async () => {
    const page = mountRoadmap();
    await screen.findByRole('link', { name: "Open today's training" });
    let prevented: boolean | undefined;
    const record = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', record, { once: true });
    fireEvent.click(primaryLink(), { ctrlKey: true });
    expect(page.navigate).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });
});

// --- not onboarded -----------------------------------------------------------------------------------------------------

describe('a player who is not onboarded', () => {
  test('a 404 sends them to /train/onboarding (replacing this page in the history), once', async () => {
    const page = mountRoadmap({ me: notOnboarded });
    await waitFor(() => expect(page.navigate).toHaveBeenCalledTimes(1));
    expect(page.navigate.mock.calls[0]).toEqual(['/train/onboarding', { replace: true }]);
    // No automatic retry of a "no" answer, and no second redirect once things settle.
    await new Promise((done) => setTimeout(done, 30));
    expect(page.meCalls()).toHaveLength(1);
    expect(page.navigate).toHaveBeenCalledTimes(1);
  });

  test('meanwhile no roadmap, no error and no primary action is shown, only a calm status with a link to the setup', async () => {
    mountRoadmap({ me: notOnboarded });
    const link = await screen.findByRole<HTMLAnchorElement>('link', { name: text('en', 'notOnboarded.action') });
    expect(link.getAttribute('href')).toBe('/train/onboarding');
    expect(screen.getByText(text('en', 'notOnboarded.title'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('link', { name: "Open today's training" })).toBeNull();
    expect(screen.queryByRole('list', { name: text('en', 'focus.listLabel') })).toBeNull();
  });

  test('only a 404 means "not onboarded": a server error does not redirect', async () => {
    const page = mountRoadmap({ me: () => problem(500, 'Boom') });
    await screen.findByRole('alert');
    expect(page.navigate).not.toHaveBeenCalled();
  });
});

// --- loading -------------------------------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy status with words while the answer is on its way, and nothing to press yet', async () => {
    const pending = deferred<Response>();
    mountRoadmap({ me: () => pending.promise });
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(status).getByText(text('en', 'loading'))).toBeTruthy();
    expect(heading('My roadmap', 1)).toBeTruthy();
    expect(screen.queryByRole('link', { name: "Open today's training" })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    pending.resolve(json(ME));
    await screen.findByRole('link', { name: "Open today's training" });
    expect(screen.queryByText(text('en', 'loading'))).toBeNull();
  });
});

// --- error ---------------------------------------------------------------------------------------------------------------

describe('error', () => {
  test('a server error is an alert that names the problem and the recovery, with Try again; nothing is retried by itself', async () => {
    const page = mountRoadmap({ me: () => problem(500, 'Boom') });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(text('en', 'error.title'))).toBeTruthy();
    expect(within(alert).getByText(problemMessages.en.server)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: text('en', 'retry') })).toBeTruthy();
    expect(screen.queryByRole('link', { name: "Open today's training" })).toBeNull();
    await new Promise((done) => setTimeout(done, 30));
    expect(page.meCalls()).toHaveLength(1);
  });

  test('Try again asks once more and is disabled (and busy) while that request is in flight', async () => {
    const second = deferred<Response>();
    const page = mountRoadmap({ me: (n) => (n === 1 ? problem(500, 'Boom') : second.promise) });
    const retry = await screen.findByRole<HTMLButtonElement>('button', { name: text('en', 'retry') });
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(page.meCalls()).toHaveLength(2));
    const busy = screen.getByRole<HTMLButtonElement>('button', { name: text('en', 'retry') });
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(page.meCalls()).toHaveLength(2);
    second.resolve(json(ME));
    await screen.findByRole('link', { name: "Open today's training" });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an answer that is not a roadmap is an error, not a half-empty page', async () => {
    mountRoadmap({ me: () => json({ hello: 'world' }) });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(problemMessages.en.schema)).toBeTruthy();
    expect(screen.queryByRole('link', { name: "Open today's training" })).toBeNull();
  });

  test('a failed sign-in is an error too, and no request is sent without a session', async () => {
    const page = mountRoadmap({
      ensureSession: async () => {
        throw new PlayerSessionError('offline', { kind: 'offline' });
      },
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(problemMessages.en.offline)).toBeTruthy();
    expect(page.meCalls()).toHaveLength(0);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  test('when a saved roadmap is there and the refresh fails, the roadmap stays and a notice says it is the saved one', async () => {
    const second = deferred<Response>();
    const page = mountRoadmap({ seed: ME, me: (n) => (n === 1 ? problem(500, 'Boom') : second.promise) });
    expect(await screen.findByText(text('en', 'stale.title'))).toBeTruthy();
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(primaryLink()).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    const retry = screen.getByRole<HTMLButtonElement>('button', { name: text('en', 'retry') });
    fireEvent.click(retry);
    await waitFor(() => expect(page.meCalls()).toHaveLength(2));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text('en', 'retry') }).disabled).toBe(true);
    second.resolve(json(ME));
    // A boolean, not the element: a failed toBeNull() pretty-prints the whole DOM node (seconds), which starves waitFor's polling.
    await waitFor(() => expect(screen.queryByText(text('en', 'stale.title')) === null).toBe(true));
    expect(primaryLink()).toBeTruthy();
  });
});

// --- empty -----------------------------------------------------------------------------------------------------------------

describe('empty', () => {
  test('a saved plan with no focus skills says so and offers the setup again; the rest of the page stays', async () => {
    const pending = deferred<Response>();
    mountRoadmap({ seed: withRoadmap({ focus: [] }), me: () => pending.promise });
    expect(await screen.findByText(text('en', 'focus.empty.title'))).toBeTruthy();
    const action = screen.getByRole<HTMLAnchorElement>('link', { name: text('en', 'focus.empty.action') });
    expect(action.getAttribute('href')).toBe('/train/onboarding');
    expect(screen.queryByRole('list', { name: text('en', 'focus.listLabel') })).toBeNull();
    expect(screen.getByText('4 weeks · 3 sessions/week · 20 min/session')).toBeTruthy();
    pending.resolve(json(ME));
  });

  test('a plan with no track levels says so in words; the focus skills are still shown', async () => {
    mountRoadmap({ me: () => json(withRoadmap({ tracks: [] })) });
    expect(await screen.findByText(text('en', 'skills.empty.title'))).toBeTruthy();
    expect(screen.getByText(text('en', 'skills.empty.hint'))).toBeTruthy();
    expect(screen.queryByRole('list', { name: text('en', 'skills.listLabel') })).toBeNull();
    expect(focusItems()).toHaveLength(3);
  });
});

// --- languages -----------------------------------------------------------------------------------------------------------

describe('Russian', () => {
  test('the page, the plan line with agreeing plural forms, the reasons and the action are in Russian', async () => {
    mountRoadmap({ locale: 'ru' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Мой план' })).toBeTruthy();
    expect(screen.getByText(PLAN_LINE.ru(3))).toBeTruthy();
    expect(screen.getByText('Базовый')).toBeTruthy();
    expect(screen.getByText(text('ru', 'goals.dribbling'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Открыть тренировку на сегодня' }).getAttribute('href')).toBe('/train');
    const [first] = focusItems('ru') as [HTMLElement];
    expect(within(first).getByText('Уровень 3 → 4')).toBeTruthy();
    expect(within(first).getByText(text('ru', 'focus.reason.goal'))).toBeTruthy();
    expect(screen.queryByText(/Level|weeks/)).toBeNull();
  });

  test('five sessions a week agree in Russian ("5 занятий"), three do not need the same form', async () => {
    mountRoadmap({ locale: 'ru', me: () => json(withRoadmap({ sessionsPerWeek: 5 })) });
    expect(await screen.findByText(PLAN_LINE.ru(5))).toBeTruthy();
  });
});

describe('Kazakh', () => {
  test('the page, the plan line and the action are in Kazakh (matched by stems: the copy awaits a native review)', async () => {
    mountRoadmap({ locale: 'kk' });
    expect(await screen.findByRole('heading', { level: 1, name: /жоспар/i })).toBeTruthy();
    const plan = screen.getByText((content) => content.includes(' · ') && /апта/.test(content));
    expect(plan.textContent).toMatch(/4\D+3\D+20/);
    expect(screen.getByRole('link', { name: /жаттығу/i }).getAttribute('href')).toBe('/train');
    expect(screen.queryByText(/Level|weeks|недел/)).toBeNull();
    const [first] = focusItems('kk') as [HTMLElement];
    expect(first.textContent).toMatch(/3\D+4/);
  });
});

describe('switching the interface language', () => {
  test('re-words the page in place without asking the server again', async () => {
    const page = mountRoadmap();
    await screen.findByRole('heading', { level: 1, name: 'My roadmap' });
    await act(async () => {
      await page.i18n.changeLanguage('ru');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Мой план' })).toBeTruthy();
    expect(screen.getByText(PLAN_LINE.ru(3))).toBeTruthy();
    expect(page.meCalls()).toHaveLength(1);
  });
});

// --- the messages file -----------------------------------------------------------------------------------------------------

function leaves(tree: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof tree === 'string') out.set(prefix, tree);
  else if (typeof tree === 'object' && tree !== null) {
    for (const [key, value] of Object.entries(tree)) leaves(value, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

describe('roadmap.messages.ts', () => {
  const byLocale = new Map(LOCALES.map((locale) => [locale, leaves(messages[locale])] as const));

  test('has the same keys in kk, ru and en, none of them blank', () => {
    const plain = (locale: Locale) => [...byLocale.get(locale)!.keys()].filter((key) => !PLURAL.test(key)).sort();
    expect(plain('kk')).toEqual(plain('en'));
    expect(plain('ru')).toEqual(plain('en'));
    for (const locale of LOCALES) {
      for (const [key, value] of byLocale.get(locale)!) expect(value.trim(), `${locale}:${key}`).not.toBe('');
    }
  });

  test('has every plural form its language needs (ru: one/few/many/other)', () => {
    for (const locale of LOCALES) {
      const keys = byLocale.get(locale)!;
      const bases = new Set([...keys.keys()].flatMap((key) => PLURAL.exec(key)?.[1] ?? []));
      expect(bases.size, `${locale} has plural keys`).toBeGreaterThan(0);
      for (const base of bases) {
        for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
          expect(keys.has(`${base}_${category}`), `${locale}:${base}_${category}`).toBe(true);
        }
      }
    }
  });

  test('never promises a professional career, in any language', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of byLocale.get(locale)!) expect(value, `${locale}:${key}`).not.toMatch(CAREER_CLAIM);
    }
  });

  test('a rendered page never promises one either (en, ru, kk)', async () => {
    for (const locale of LOCALES) {
      const page = mountRoadmap({ locale });
      await screen.findByRole('link', { name: text(locale, 'start') });
      expect(document.body.textContent ?? '').not.toMatch(CAREER_CLAIM);
      page.unmount();
    }
  });

  test('has words for every goal and every skill-graph track the planner names', () => {
    for (const locale of LOCALES) {
      for (const goal of ['control', 'dribbling', 'passing', 'weakfoot', 'coordination']) {
        expect(byLocale.get(locale)!.has(`goals.${goal}`), `${locale}:goals.${goal}`).toBe(true);
      }
      for (const track of ['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination']) {
        expect(byLocale.get(locale)!.has(`tracks.${track}`), `${locale}:tracks.${track}`).toBe(true);
      }
    }
  });
});
