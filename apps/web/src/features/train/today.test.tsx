import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Locale } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import type { ComponentType } from 'react';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route, TodayDepsContext } from '../../routes/train/index';
import trustBadgeMessages from '../commons/trust-badge.messages';
import { createEventsClient } from './events-client';
import todayMessages from './today.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web, but the bead's verify
// command runs from the repo root, where there is no DOM. Register happy-dom here BEFORE Testing Library is imported
// (same order rule as test/setup.ts and the wizard test); the `document` guard keeps it a no-op under the preload.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Written from the bead's acceptance criteria (fc-mol-urn.8), not from the implementation:
 *  - /train shows today's session from GET /api/player/today (1 call): headline with the total minutes, an "n/m completed"
 *    pill, the ordered drill list (index, title, minutes, TrustBadge, done state with a check mark and a word), a roadmap
 *    focus panel and every component of the `today` slot;
 *  - tapping a drill opens the drill player; when every drill is done "Finish session" sends session_finished and goes
 *    to the summary; a player who is not onboarded is sent to /train/onboarding;
 *  - loading, empty, error, disabled and success states; mutation buttons are disabled while a request is in flight;
 *  - the query key is ['today'] (the persisted-cache allow-list and the events client both use it) and X-Timezone is sent.
 * The server is a fake `fetch` handed to the real `createApi` and to the real events client, so requests, headers, problem
 * parsing and schema parsing are the real thing. Only the network (and the anonymous sign-in) is faked.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME_ZONE = 'Asia/Almaty';

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

type ItemFields = { itemId: string; minutes: number; done: boolean; status?: string; reason?: string; title?: Record<string, string> };

function item({ itemId, minutes, done, status = 'COMMUNITY', reason, title }: ItemFields) {
  return {
    itemId,
    drillVersionId: `${itemId}-v1`,
    minutes,
    done,
    ...(reason === undefined ? {} : { reason }),
    content: {
      ...(title === undefined ? {} : { title }),
      goal: { kk: `Мақсат ${itemId}`, ru: `Цель ${itemId}`, en: `Goal of ${itemId}` },
      instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
      dose: { reps: 20 },
      conditions: { equipment: 'ball', spaces: ['yard'] },
    },
    status,
    attribution,
  };
}

const ITEM_1 = item({ itemId: 'item-1', minutes: 5, done: true, reason: 'warmup', title: { kk: 'Доп соққысы', ru: 'Касания мяча', en: 'Ball taps' } });
const ITEM_2 = item({ itemId: 'item-2', minutes: 8, done: false, status: 'REVIEWED', reason: 'focus', title: { kk: 'Слалом', ru: 'Слалом', en: 'Cone slalom' } });
const ITEM_3 = item({ itemId: 'item-3', minutes: 7, done: false, reason: 'fill', title: { kk: 'Қабылдау', ru: 'Приём мяча', en: 'First touch' } });

const ROADMAP = {
  currentLevelLabel: 'Basic',
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
    { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
  ],
};

function session(patch: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    date: '2026-09-21',
    planner: 'rules',
    totalMinutes: 20,
    graphVersion: '0.1.0',
    items: [ITEM_1, ITEM_2, ITEM_3],
    roadmapSummary: ROADMAP,
    ...patch,
  };
}

const allDone = () => session({ items: [ITEM_1, { ...ITEM_2, done: true }, { ...ITEM_3, done: true }] });

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const problem = (status: number) => json({ type: 'about:blank', title: 'Problem', status, errors: [] }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; url: string; body: unknown; headers: Headers };
type Reply = Response | Promise<Response>;
type Server = {
  calls: Call[];
  today?: () => Reply;
  events?: (body: unknown) => Reply;
};

const EVENTS_RESPONSE = { session: allDone(), progress: { sessionsCompleted: 1, minutesTrained: 20, streakDays: 1 }, nextSessionDate: '2026-09-22' };

// --- harness ---------------------------------------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const MODULES = {
  './today.messages.ts': { default: todayMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

type Setup = {
  server?: Partial<Server>;
  locale?: Locale;
  slots?: readonly ComponentType[];
  /** Put this session into the cache under ['today'] before the screen mounts (what the persisted cache restores). */
  cached?: unknown;
};

function mountToday(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const server: Server = { calls: [], ...setup.server };
  const order: string[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, url: input, body, headers: new Headers(init?.headers) });
    if (method === 'GET' && input.startsWith('/api/player/today')) {
      order.push('GET today');
      return (server.today ?? (() => json(session())))();
    }
    if (method === 'POST' && input === '/api/player/session-events') {
      order.push('POST session-events');
      return (server.events ?? (() => json(EVENTS_RESPONSE)))(body);
    }
    return new Response('not found', { status: 404 });
  };

  const ensureSession = mock(async () => {
    order.push('ensurePlayerSession');
    return { user: { id: 'player-1' } };
  });
  const navigate = mock((to: string, _options?: { replace?: boolean }) => void order.push(`navigate ${to}`));

  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const api = createApi({ fetch: fetchImpl, language: () => locale, online: () => true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (setup.cached !== undefined) queryClient.setQueryData(['today'], setup.cached);
  const events = createEventsClient({ api, queryClient });

  // The page is the route's own component. Its collaborators arrive through the route module's context seam (the page
  // itself is not exported: a non-Route export would pull zod and the API client into the entry bundle).
  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the /train route has no component');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <TodayDepsContext.Provider value={{ api, ensureSession, navigate, timeZone: () => TIME_ZONE, events, slots: setup.slots ?? [] }}>
          <Page />
        </TodayDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    server,
    order,
    ensureSession,
    navigate,
    queryClient,
    unmount: view.unmount,
    todayCalls: () => server.calls.filter((call) => call.method === 'GET'),
    eventCalls: () => server.calls.filter((call) => call.method === 'POST'),
  };
}

afterEach(() => {
  cleanup();
});

// --- helpers ---------------------------------------------------------------------------------------------------------

const finishButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Finish session' });
const drillList = async (locale: Locale = 'en') => screen.findByRole('list', { name: todayMessages[locale].list });
const rows = async (locale: Locale = 'en') => within(await drillList(locale)).getAllByRole('listitem');

// --- the session ------------------------------------------------------------------------------------------------------

describe('the request', () => {
  test('opens today with exactly one GET, the UI locale and the X-Timezone header, after the session is ensured', async () => {
    const page = mountToday({ locale: 'ru' });
    await drillList('ru');
    expect(page.todayCalls()).toHaveLength(1);
    const [call] = page.todayCalls();
    expect(call!.url).toBe('/api/player/today?locale=ru');
    expect(call!.headers.get('x-timezone')).toBe(TIME_ZONE);
    expect(page.order.slice(0, 2)).toEqual(['ensurePlayerSession', 'GET today']);
  });

  test("keeps the session in the React Query cache under ['today'], the key the events client and the persisted cache use", async () => {
    const page = mountToday();
    await drillList();
    const cached = page.queryClient.getQueryData<{ id: string; items: unknown[] }>(['today']);
    expect(cached?.id).toBe('session-1');
    expect(cached?.items).toHaveLength(3);
  });

  test('a player who is not onboarded (404) is sent to /train/onboarding, once, and sees no drill list', async () => {
    const page = mountToday({ server: { today: () => problem(404) } });
    await waitFor(() => expect(page.navigate).toHaveBeenCalled());
    expect(page.navigate.mock.calls).toHaveLength(1);
    expect(page.navigate.mock.calls[0]![0]).toBe('/train/onboarding');
    expect(screen.queryByRole('list', { name: "Today's drills" })).toBeNull();
    expect(page.todayCalls()).toHaveLength(1);
  });

  test('other failures do not redirect', async () => {
    const page = mountToday({ server: { today: () => problem(500) } });
    await screen.findByRole('alert');
    expect(page.navigate).not.toHaveBeenCalled();
  });
});

describe('the headline and progress', () => {
  test('the headline carries the total minutes and the pill says how many drills are completed', async () => {
    mountToday();
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('20 min');
    expect(screen.getByText('1/3 completed')).toBeTruthy();
  });

  test('the total minutes are the session total, not the sum of the drills', async () => {
    mountToday({ server: { today: () => json(session({ totalMinutes: 22 })) } });
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('22 min');
  });
});

describe('the drill list', () => {
  test('lists every drill in order, each with its index or check, title, minutes, trust badge and a written state', async () => {
    mountToday();
    const [first, second, third] = await rows();
    expect(within(first!).getByText('Ball taps')).toBeTruthy();
    expect(within(second!).getByText('Cone slalom')).toBeTruthy();
    expect(within(third!).getByText('First touch')).toBeTruthy();

    expect(within(first!).getByText('5 min')).toBeTruthy();
    expect(within(second!).getByText('8 min')).toBeTruthy();
    expect(within(third!).getByText('7 min')).toBeTruthy();

    expect(within(first!).getByText('Community')).toBeTruthy();
    expect(within(second!).getByText('Reviewed')).toBeTruthy();
    expect(within(third!).getByText('Community')).toBeTruthy();

    // The index number of a drill still to do; the done drill shows a check mark instead.
    expect(within(second!).getByText('2')).toBeTruthy();
    expect(within(third!).getByText('3')).toBeTruthy();
  });

  test('done is a word and a check mark, never colour alone; the drills still to do say so in words', async () => {
    mountToday();
    const [first, second, third] = await rows();
    // The check mark sits with the word, so the two read as one signal (the row has other icons: badge, chevron).
    expect(within(first!).getByText('Done').querySelector('svg')).not.toBeNull();
    expect(within(second!).queryByText('Done')).toBeNull();
    expect(within(second!).getByText('To do')).toBeTruthy();
    expect(within(third!).queryByText('Done')).toBeNull();
    expect(within(third!).getByText('To do')).toBeTruthy();
  });

  test("the planner's reason keys are shown in the player's language", async () => {
    mountToday();
    const [first, second, third] = await rows();
    expect(within(first!).getByText('Warm-up')).toBeTruthy();
    expect(within(second!).getByText('Focus')).toBeTruthy();
    expect(within(third!).getByText('Extra practice')).toBeTruthy();
  });

  test('titles come in the UI language, falling back through ru and en, and to the goal when a drill has no title', async () => {
    const untitled = item({ itemId: 'item-9', minutes: 4, done: false });
    const onlyEnglish = item({ itemId: 'item-8', minutes: 4, done: false, title: { en: 'Only English' } });
    mountToday({ locale: 'ru', server: { today: () => json(session({ items: [ITEM_1, onlyEnglish, untitled] })) } });
    const [first, second, third] = await rows('ru');
    expect(within(first!).getByText('Касания мяча')).toBeTruthy();
    expect(within(second!).getByText('Only English')).toBeTruthy();
    expect(within(third!).getByText('Цель item-9')).toBeTruthy();
  });

  test('tapping a drill opens the drill player for that item', async () => {
    const page = mountToday();
    const [, second] = await rows();
    const link = within(second!).getByRole('link');
    expect(link.getAttribute('href')).toBe('/train/drill/item-2');
    await page.user.click(link);
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(page.navigate.mock.calls[0]![0]).toBe('/train/drill/item-2');
  });
});

describe('finishing the session', () => {
  test('Finish session is disabled while a drill is still to do, and says why', async () => {
    const page = mountToday();
    await drillList();
    expect(finishButton().disabled).toBe(true);
    expect(screen.getByText('Finish is available when every drill is done.')).toBeTruthy();
    await page.user.click(finishButton());
    expect(page.eventCalls()).toHaveLength(0);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  test('when every drill is done it is enabled; it sends one session_finished event and then goes to the summary', async () => {
    const page = mountToday({ server: { today: () => json(allDone()) } });
    await drillList();
    expect(finishButton().disabled).toBe(false);
    expect(screen.queryByText('Finish is available when every drill is done.')).toBeNull();
    await page.user.click(finishButton());
    await waitFor(() => expect(page.navigate).toHaveBeenCalled());

    expect(page.eventCalls()).toHaveLength(1);
    const body = page.eventCalls()[0]!.body as { events: Record<string, unknown>[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: 'session_finished', sessionId: 'session-1' });
    expect(body.events[0]!.clientUuid).toMatch(UUID);
    expect(page.navigate.mock.calls[0]![0]).toBe('/train/summary');
    expect(page.order.slice(-2)).toEqual(['POST session-events', 'navigate /train/summary']);
  });

  test('while the request is in flight the button is disabled and busy, and a second tap sends nothing', async () => {
    const pending = deferred<Response>();
    const page = mountToday({ server: { today: () => json(allDone()), events: () => pending.promise } });
    await drillList();
    await page.user.click(finishButton());
    await waitFor(() => expect(finishButton().disabled).toBe(true));
    expect(finishButton().getAttribute('aria-busy')).toBe('true');
    await page.user.click(finishButton());
    expect(page.eventCalls()).toHaveLength(1);
    expect(page.navigate).not.toHaveBeenCalled();

    await act(async () => pending.resolve(json(EVENTS_RESPONSE)));
    await waitFor(() => expect(page.navigate).toHaveBeenCalledTimes(1));
  });

  test('two taps in the same tick (before the screen re-renders) still send one event', async () => {
    const pending = deferred<Response>();
    const page = mountToday({ server: { today: () => json(allDone()), events: () => pending.promise } });
    await drillList();
    const button = finishButton();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(page.eventCalls()).toHaveLength(1);
    await act(async () => pending.resolve(json(EVENTS_RESPONSE)));
    await waitFor(() => expect(page.navigate).toHaveBeenCalledTimes(1));
  });

  test('a failure is worded in the player\'s language, stays on the screen, and Try again resends the SAME event', async () => {
    let attempts = 0;
    const page = mountToday({ server: { today: () => json(allDone()), events: () => (++attempts === 1 ? problem(500) : json(EVENTS_RESPONSE)) } });
    await drillList();
    await page.user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not save the session')).toBeTruthy();
    expect(page.navigate).not.toHaveBeenCalled();

    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(page.navigate).toHaveBeenCalledTimes(1));
    const [first, second] = page.eventCalls().map((call) => (call.body as { events: { clientUuid: string }[] }).events[0]!.clientUuid);
    expect(page.eventCalls()).toHaveLength(2);
    expect(second).toBe(first!);
  });

  test("the server's answer replaces the cached session (the events client owns that write)", async () => {
    const page = mountToday({ server: { today: () => json(allDone()) } });
    await drillList();
    await page.user.click(finishButton());
    await waitFor(() => expect(page.navigate).toHaveBeenCalled());
    expect(page.queryClient.getQueryData(['today'])).toMatchObject({ id: 'session-1' });
  });
});

describe('states', () => {
  test('loading: a status with the text and no list yet', async () => {
    mountToday({ server: { today: () => new Promise<Response>(() => {}) } });
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(status).getByText("Loading today's session…")).toBeTruthy();
    expect(screen.queryByRole('list', { name: "Today's drills" })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish session' })).toBeNull();
  });

  test('error: says what failed, offers Try again, and Try again asks again and recovers', async () => {
    let attempts = 0;
    const page = mountToday({ server: { today: () => (++attempts === 1 ? problem(500) : json(session())) } });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Could not load today's session")).toBeTruthy();
    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await drillList();
    expect(page.todayCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('empty: no drills gives a calm message and a retry, and no Finish button', async () => {
    const page = mountToday({ server: { today: () => json(session({ items: [], totalMinutes: 0 })) } });
    expect(await screen.findByText('No drills today yet')).toBeTruthy();
    expect(screen.queryByRole('list', { name: "Today's drills" })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish session' })).toBeNull();
    await page.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(page.todayCalls()).toHaveLength(2));
  });

  test('a refresh that fails keeps showing the cached session with a notice (offline opens the last known session)', async () => {
    const page = mountToday({ cached: session(), server: { today: () => problem(503) } });
    await drillList();
    await waitFor(() => expect(page.todayCalls()).toHaveLength(1));
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('Could not refresh. Showing the last saved session.')).toBeTruthy();
    expect((await rows()).length).toBe(3);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  test('a cached session shows at once, without waiting for the network', async () => {
    mountToday({ cached: session(), server: { today: () => new Promise<Response>(() => {}) } });
    expect((await rows()).length).toBe(3);
  });
});

describe('the roadmap focus panel', () => {
  test('shows the level label, each focus skill with its level and target, why, and the weekly rhythm', async () => {
    mountToday();
    const panel = await screen.findByRole('region', { name: 'Your focus' });
    expect(within(panel).getByText('Basic')).toBeTruthy();
    expect(within(panel).getByText('Dribbling')).toBeTruthy();
    expect(within(panel).getByText('Weak foot')).toBeTruthy();
    expect(within(panel).getByText('Level 2 to 3')).toBeTruthy();
    expect(within(panel).getByText('Level 1 to 2')).toBeTruthy();
    expect(within(panel).getByText('Your chosen goal')).toBeTruthy();
    expect(within(panel).getByText('Room to grow')).toBeTruthy();
    expect(within(panel).getByText('Sessions per week').parentElement!.textContent).toContain('3');
    expect(within(panel).getByText('Minutes per session').parentElement!.textContent).toContain('20');
  });

  test('the level label is worded in the player\'s language when it is one the planner names', async () => {
    mountToday({ locale: 'ru' });
    const panel = await screen.findByRole('region', { name: todayMessages.ru.focus.title });
    expect(within(panel).getByText(todayMessages.ru.focus.levels.Basic)).toBeTruthy();
  });
});

describe('the today slot', () => {
  const One = () => <p>slot one</p>;
  const Two = () => <p>slot two</p>;

  test('renders every component of the slot, in order, inside the today region', async () => {
    mountToday({ slots: [One, Two] });
    await drillList();
    const region = document.querySelector('[data-slot="today"]');
    expect(region).not.toBeNull();
    const texts = within(region as HTMLElement)
      .getAllByText(/^slot /)
      .map((node) => node.textContent);
    expect(texts).toEqual(['slot one', 'slot two']);
  });

  test('adds no region when nothing fills the slot', async () => {
    mountToday({ slots: [] });
    await drillList();
    expect(document.querySelector('[data-slot="today"]')).toBeNull();
  });
});

describe('languages', () => {
  test.each(['kk', 'ru'] as const)('%s: the headline, the finish button and the drill title are in the language', async (locale) => {
    mountToday({ locale, server: { today: () => json(allDone()) } });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(todayMessages[locale].title.replace('{{minutes}}', '20'));
    expect(screen.getByRole('button', { name: todayMessages[locale].finish })).toBeTruthy();
    expect(screen.getByRole('list', { name: todayMessages[locale].list })).toBeTruthy();
    const titles = { kk: 'Доп соққысы', ru: 'Касания мяча' };
    expect(screen.getByText(titles[locale])).toBeTruthy();
  });
});
