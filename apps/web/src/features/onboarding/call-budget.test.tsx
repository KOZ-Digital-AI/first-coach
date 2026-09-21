import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION, type SkillTest } from '@api-types/domain';
import type { OnboardingOptions } from '@api-types/onboarding';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, SPACES } from '@api-types/primitives';
import { type ReactNode, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createPlayerAuth, createPlayerAuthClient, type PlayerAuthClient } from '../../lib/auth';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route as LandingRoute } from '../../routes/index';
import { Route as TodayRoute, TodayDepsContext } from '../../routes/train/index';
import { Route as WizardRoute, WizardDepsContext } from '../../routes/train/onboarding';
import { Route as RoadmapRoute, RoadmapDepsContext } from '../../routes/train/roadmap';
import landingMessages from '../landing/landing.messages';
import roadmapMessages from '../roadmap/roadmap.messages';
import trustBadgeMessages from '../commons/trust-badge.messages';
import todayMessages from '../train/today.messages';
import baselineMessages from './baseline-step.messages';
import conditionsMessages from './conditions-step.messages';
import profileMessages from './profile-step.messages';
import wizardMessages from './wizard.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web; from the repo root there is no DOM.
// Register happy-dom BEFORE Testing Library is imported (same order rule and guard as the other UI tests).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Written from the acceptance criteria of fc-mol-9l4.16 (found by the gate script of fc-mol-8he):
 *  - from pressing START TRAINING on a fresh browser (no session cookie) to MY ROADMAP the web app makes exactly
 *    POST /api/auth/sign-in/anonymous, GET /api/onboarding/football, POST /api/player/start (Better Auth get-session reads
 *    are excluded, as the gate counts them): no GET /api/player/today probe and no GET /api/player/me;
 *  - a returning session (an existing cookie) still probes GET /api/player/today, and a 404 still sends it to onboarding;
 *  - reloading /train/roadmap still fetches GET /api/player/me; the roadmap reads what the wizard wrote only while that
 *    ['me'] cache entry is fresh (30 s).
 * Everything is real (the pages, the typed client, the real Better Auth client, createPlayerAuth, React Query) except the
 * network: one stubbed `fetch` answers every /api route and records the call list. The pages are wired the way the app wires
 * them, through their context seams, with the SAME auth object per page load; nothing else is injected.
 *
 * Landing -> /train is a plain anchor (a hard navigation): the harness models it by starting a new page load (new query
 * cache, new auth memo). /train -> /train/onboarding -> /train/roadmap are in-app navigations inside one page load.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const skillTest = (fields: Pick<SkillTest, 'slug' | 'skill' | 'metric' | 'unit' | 'direction' | 'equipment'>): SkillTest => ({
  ...fields,
  protocol: { kk: '1. Жылын.', ru: '1. Разомнись.', en: '1. Warm up.\n2. Measure your result.' },
});

const sprint = skillTest({ slug: 'sprint-20m', skill: 'speed', metric: 'sprint over 20 m', unit: 'seconds', direction: 'lower', equipment: 'nothing' });
const plank = skillTest({ slug: 'plank-hold', skill: 'core', metric: 'plank hold', unit: 'seconds', direction: 'higher', equipment: 'nothing' });

const OPTIONS: OnboardingOptions = {
  levels: [...EXPERIENCE_LEVELS],
  goals: [...GOALS],
  equipment: [...EQUIPMENT],
  spaces: [...SPACES],
  partner: [false, true],
  daysPerWeek: [...DAYS_PER_WEEK],
  minutesPerSession: [...MINUTES_PER_SESSION],
  tests: [sprint, plank],
};

const START_RESPONSE = {
  profile: { age: 12, level: 'beginner', goal: 'control', equipment: 'ball', space: 'yard', partner: false, daysPerWeek: 3, minutesPerSession: 20, locale: 'en' },
  roadmap: {
    currentLevelLabel: 'Basic',
    tracks: [
      { skill: 'ball-mastery', level: 2, source: 'test' },
      { skill: 'weak-foot', level: 1, source: 'self' },
    ],
    goal: 'control',
    weeks: 4,
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
      { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'goal' },
    ],
  },
};

const attribution = { author: 'FIRST COACH Genesis', source: 'FIRST COACH Genesis', license: 'CC-BY-SA-4.0', createdAt: '2026-09-01T10:00:00Z', semver: '1.0.0' };
const TODAY = {
  id: 'session-1',
  date: '2026-09-21',
  planner: 'rules',
  totalMinutes: 20,
  graphVersion: '0.1.0',
  items: [
    {
      itemId: 'item-1',
      drillVersionId: 'item-1-v1',
      minutes: 8,
      done: false,
      content: {
        title: { kk: 'Слалом', ru: 'Слалом', en: 'Cone slalom' },
        goal: { kk: 'Мақсат', ru: 'Цель', en: 'Goal of item-1' },
        instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
        dose: { reps: 20 },
        conditions: { equipment: 'ball', spaces: ['yard'] },
      },
      status: 'COMMUNITY',
      attribution,
    },
  ],
  roadmapSummary: {
    currentLevelLabel: 'Basic',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [
      { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
      { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'goal' },
    ],
  },
};

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const notFound = () => json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404, 'application/problem+json');

// --- the stubbed network ----------------------------------------------------------------------------------------------

/** The server's memory: the cookie a browser holds, and whether the player has been onboarded. */
type Backend = { cookie: boolean; onboarded: boolean };

/** Every request the browser made, as "METHOD /path" (query left out), in order. */
type Network = { calls: string[]; backend: Backend; fetch: (input: unknown, init?: RequestInit) => Promise<Response> };

function network(backend: Backend): Network {
  const calls: string[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as { url?: string }).url ?? String(input));
    const url = new URL(href, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /api/auth/get-session') return json(backend.cookie ? { session: { id: 's-1' }, user: { id: 'player-1', isAnonymous: true } } : null);
    if (route === 'POST /api/auth/sign-in/anonymous') {
      backend.cookie = true;
      return json({ token: 't-1', user: { id: 'player-1', isAnonymous: true } });
    }
    if (route === 'GET /api/onboarding/football') return json(OPTIONS);
    if (route === 'POST /api/player/start') {
      backend.onboarded = true;
      return json(START_RESPONSE);
    }
    if (route === 'GET /api/player/today') return backend.onboarded ? json(TODAY) : notFound();
    if (route === 'GET /api/player/me') return backend.onboarded ? json(START_RESPONSE) : notFound();
    return notFound(); // e.g. the landing page's stats strip: it fails quietly and is not part of the budget
  };
  return { calls, backend, fetch: fetchImpl };
}

/** What the gate counts: every /api call except Better Auth's get-session reads. */
const budget = (net: Network): string[] => net.calls.filter((call) => call !== 'GET /api/auth/get-session');

// --- harness ------------------------------------------------------------------------------------------------------------

const MODULES = {
  './landing.messages.ts': { default: landingMessages },
  './wizard.messages.ts': { default: wizardMessages },
  './profile-step.messages.ts': { default: profileMessages },
  './conditions-step.messages.ts': { default: conditionsMessages },
  './baseline-step.messages.ts': { default: baselineMessages },
  './today.messages.ts': { default: todayMessages },
  './roadmap.messages.ts': { default: roadmapMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};
const newI18n = () => createI18n({ modules: MODULES, languages: ['en'], storage: memoryStorage(), root: { lang: '' }, dev: false });

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

/** One page load: a new query cache and a new auth memo, over the given network. The pages switch on in-app navigation. */
function loadApp(net: Network, start: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = newI18n();
  const auth = createPlayerAuth({ client: createPlayerAuthClient({ fetch: net.fetch as typeof fetch }), locks: null, online: () => true });
  const api = createApi({ fetch: net.fetch as never, language: () => 'en', online: () => true });
  const visited: string[] = [];
  let go: (to: string) => void = () => {};

  const Today = TodayRoute.options.component as () => ReactNode;
  const Wizard = WizardRoute.options.component as () => ReactNode;
  const Roadmap = RoadmapRoute.options.component as () => ReactNode;

  function Shell() {
    const [path, setPath] = useState(start);
    go = (to) => {
      visited.push(to);
      setPath(to);
    };
    const navigate = (to: string) => go(to);
    return (
      <TodayDepsContext.Provider value={{ api, ensureSession: auth.ensurePlayerSessionOutcome, navigate, timeZone: () => 'Asia/Almaty', slots: [] }}>
        <WizardDepsContext.Provider value={{ api, ensureSession: auth.ensurePlayerSession, navigate }}>
          <RoadmapDepsContext.Provider value={{ api, ensureSession: auth.ensurePlayerSession, navigate }}>
            {path === '/train' ? <Today /> : path === '/train/onboarding' ? <Wizard /> : path === '/train/roadmap' ? <Roadmap /> : <p>{path}</p>}
          </RoadmapDepsContext.Provider>
        </WizardDepsContext.Provider>
      </TodayDepsContext.Provider>
    );
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Shell />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { queryClient, visited, unmount: view.unmount, navigate: (to: string) => go(to), user: userEvent.setup() };
}

type App = ReturnType<typeof loadApp>;

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const stepText = (n: number) => `Step ${n} / 4`;

async function answerWizard({ user }: App) {
  await user.type(await screen.findByLabelText('Age'), '12');
  await user.click(screen.getByRole('radio', { name: 'Beginner' }));
  await user.click(screen.getByRole('radio', { name: 'Control the ball with confidence' }));
  await user.click(button('Continue'));
  await screen.findByText(stepText(2));
  await user.click(screen.getByRole('radio', { name: 'Ball only' }));
  await user.click(screen.getByRole('radio', { name: 'Yard' }));
  await user.click(screen.getByRole('radio', { name: 'No' }));
  await user.click(screen.getByRole('radio', { name: '3' }));
  await user.click(screen.getByRole('radio', { name: '20 min' }));
  await user.click(button('Continue'));
  await screen.findByText(stepText(3));
  await user.type(within(screen.getByRole('region', { name: sprint.metric })).getByLabelText(/^Your result/), '4.2');
  await user.click(within(screen.getByRole('region', { name: plank.metric })).getByRole('button', { name: /^Skip/ }));
  await user.click(button('Continue'));
}

const roadmapHeading = () => screen.findByRole('heading', { name: 'My roadmap' });
/** Lets a late request (a refetch after the screen rendered) show up in the call list. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

/** START TRAINING on the landing page, then the page load it causes (a hard navigation), then the whole wizard. */
async function freshVisitorToRoadmap(net: Network): Promise<App> {
  globalThis.fetch = net.fetch as typeof fetch;
  const user = userEvent.setup();
  const Landing = LandingRoute.options.component as () => ReactNode;
  const landing = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={newI18n()}>
        <Landing />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  const start = await screen.findByRole('link', { name: 'Start training' });
  expect(start.getAttribute('href')).toBe('/train');
  await user.click(start);
  landing.unmount();
  net.calls.length = 0; // the count starts at the press

  const app = loadApp(net, '/train');
  await answerWizard(app);
  await roadmapHeading();
  await settle();
  return app;
}

// --- the budget -----------------------------------------------------------------------------------------------------------

describe('a fresh visitor, from START TRAINING to MY ROADMAP', () => {
  test('makes exactly: anonymous sign-in, options, start (no /today probe, no /me)', async () => {
    const net = network({ cookie: false, onboarded: false });
    await freshVisitorToRoadmap(net);
    expect(budget(net)).toEqual(['POST /api/auth/sign-in/anonymous', 'GET /api/onboarding/football', 'POST /api/player/start']);
  });

  test('the wizard leaves the roadmap in the ["me"] cache, which is what the roadmap screen shows', async () => {
    const net = network({ cookie: false, onboarded: false });
    const app = await freshVisitorToRoadmap(net);
    const cached: unknown = app.queryClient.getQueryData(['me']);
    expect(cached).toEqual(START_RESPONSE);
    expect(app.visited.at(-1)).toBe('/train/roadmap');
    expect(screen.getByText('4 weeks · 3 sessions/week · 20 min/session')).toBeTruthy();
  });

  test('going to /train afterwards in the same page load DOES probe /today (only a just-created session skips it)', async () => {
    const net = network({ cookie: false, onboarded: false });
    const app = await freshVisitorToRoadmap(net);
    app.navigate('/train');
    await screen.findByText('Cone slalom');
    expect(budget(net).slice(3)).toEqual(['GET /api/player/today']);
  });
});

describe('a returning session (an existing cookie)', () => {
  test('/train still probes GET /api/player/today, makes no sign-in, and a 404 sends it to onboarding', async () => {
    const net = network({ cookie: true, onboarded: false });
    const app = loadApp(net, '/train');
    await screen.findByText(stepText(1));
    expect(budget(net)).toEqual(['GET /api/player/today', 'GET /api/onboarding/football']);
    expect(app.visited).toEqual(['/train/onboarding']);
  });

  test('an onboarded returning player sees today, from one GET /api/player/today', async () => {
    const net = network({ cookie: true, onboarded: true });
    loadApp(net, '/train');
    await screen.findByText('Cone slalom');
    expect(budget(net)).toEqual(['GET /api/player/today']);
  });
});

describe('the roadmap screen and the ["me"] cache', () => {
  test('reloading /train/roadmap (a new page load, an empty cache) fetches GET /api/player/me', async () => {
    const net = network({ cookie: true, onboarded: true });
    loadApp(net, '/train/roadmap');
    await roadmapHeading();
    expect(budget(net)).toEqual(['GET /api/player/me']);
  });

  test('an entry written moments ago is shown without a request', async () => {
    const net = network({ cookie: true, onboarded: true });
    globalThis.fetch = net.fetch as typeof fetch;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['me'], START_RESPONSE);
    const api = createApi({ fetch: net.fetch as never, language: () => 'en', online: () => true });
    const Roadmap = RoadmapRoute.options.component as () => ReactNode;
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={newI18n()}>
          <RoadmapDepsContext.Provider value={{ api, ensureSession: async () => ({ user: { id: 'player-1' } }), navigate: () => {} }}>
            <Roadmap />
          </RoadmapDepsContext.Provider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await roadmapHeading();
    await settle();
    expect(net.calls).toEqual([]);
  });

  test('an entry older than 30 s is shown and refreshed with GET /api/player/me', async () => {
    const net = network({ cookie: true, onboarded: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['me'], START_RESPONSE, { updatedAt: Date.now() - 31_000 });
    const api = createApi({ fetch: net.fetch as never, language: () => 'en', online: () => true });
    const Roadmap = RoadmapRoute.options.component as () => ReactNode;
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={newI18n()}>
          <RoadmapDepsContext.Provider value={{ api, ensureSession: async () => ({ user: { id: 'player-1' } }), navigate: () => {} }}>
            <Roadmap />
          </RoadmapDepsContext.Provider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await roadmapHeading();
    await waitFor(() => expect(net.calls).toEqual(['GET /api/player/me']));
  });
});

// --- the "created" signal of the auth module ------------------------------------------------------------------------------

type Reply = { data?: unknown; error?: unknown };
const player = (id: string) => ({ user: { id, isAnonymous: true } });

function fakeClient(script: { existing?: boolean; signInFails?: boolean } = {}) {
  const calls = { getSession: 0, anonymous: 0 };
  const created = player('anon-1');
  const existing = player('cookie-1');
  let signedIn = false;
  const client: PlayerAuthClient = {
    getSession: async (): Promise<Reply> => {
      calls.getSession += 1;
      return { data: script.existing === true || (signedIn && script.signInFails === true) ? existing : null, error: null };
    },
    signIn: {
      anonymous: async (): Promise<Reply> => {
        calls.anonymous += 1;
        signedIn = true;
        return script.signInFails === true ? { data: null, error: new Error('already anonymous') } : { data: created, error: null };
      },
    },
  };
  return { client, calls, created, existing };
}

describe('ensurePlayerSessionOutcome (additive to ensurePlayerSession)', () => {
  test('says created when THIS attempt signed in anonymously, and resolves the same session ensurePlayerSession does', async () => {
    const { client, calls, created } = fakeClient();
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    const outcome = await auth.ensurePlayerSessionOutcome();
    expect(outcome.created).toBe(true);
    expect(outcome.session).toBe(created);
    expect(await auth.ensurePlayerSession()).toBe(created);
    expect(calls).toEqual({ getSession: 1, anonymous: 1 });
  });

  test('says not created for a session that already existed (no sign-in)', async () => {
    const { client, calls, existing } = fakeClient({ existing: true });
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    const outcome = await auth.ensurePlayerSessionOutcome();
    expect(outcome).toEqual({ session: existing, created: false });
    expect(calls.anonymous).toBe(0);
  });

  test('says not created for any later call: a session made earlier is no longer "just created"', async () => {
    const { client, created } = fakeClient();
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    expect((await auth.ensurePlayerSessionOutcome()).created).toBe(true);
    expect(await auth.ensurePlayerSessionOutcome()).toEqual({ session: created, created: false });
  });

  test('a session created through plain ensurePlayerSession is not "just created" for a later outcome call either', async () => {
    const { client, created } = fakeClient();
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    await auth.ensurePlayerSession();
    expect(await auth.ensurePlayerSessionOutcome()).toEqual({ session: created, created: false });
  });

  test('a session found again after a failed sign-in (another tab won) was not created here', async () => {
    const { client, existing } = fakeClient({ signInFails: true });
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    expect(await auth.ensurePlayerSessionOutcome()).toEqual({ session: existing, created: false });
  });

  test('after resetPlayerSession the next call is a new attempt and can create again', async () => {
    const { client } = fakeClient();
    const auth = createPlayerAuth({ client, locks: null, online: () => true });
    expect((await auth.ensurePlayerSessionOutcome()).created).toBe(true);
    auth.resetPlayerSession();
    expect((await auth.ensurePlayerSessionOutcome()).created).toBe(true);
  });
});
