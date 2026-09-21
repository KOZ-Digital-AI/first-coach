import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type Locale } from '@api-types/primitives';
import { TodaySession } from '@api-types/session';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { DrillPlayerDepsContext, Route } from '../../routes/train/drill.$itemId';
import trustBadgeMessages from '../commons/trust-badge.messages';
import messages from './drill-player.messages';
import { createEventsClient } from './events-client';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web; the bead's verify command runs from
// the repo root, where there is no DOM. Register happy-dom BEFORE Testing Library is imported (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * The drill player (/train/drill/:itemId), written from the bead's acceptance criteria (fc-mol-urn.9), not from the code:
 *  - it reads the item from the cached today session (works with no network) and shows an optional video (lazy, tap to play),
 *    the goal, reps/time with a simple count-up timer, common mistakes, progression, regression, required conditions and the
 *    safety note in a highlighted notice, plus every component of the `drill` slot;
 *  - actions: Done (drill_done), Undo (drill_undone), an optional numeric result, Too hard / Too easy (swap, disabled offline
 *    with an explanation) and Next drill; mutations are optimistic with rollback on failure;
 *  - loading, empty, error, disabled and success states; mutation buttons are disabled while a request is in flight;
 *  - the timer is built on timestamps, so a sleeping tab cannot make it drift.
 * The server is a fake `fetch` handed to the real `createApi` and to the real events client: requests, headers, problem parsing
 * and schema parsing are the real thing. Only the network, the anonymous sign-in, the clock and the online flag are faked.
 * Fixtures are parsed with the shared contract schema so they cannot drift from the API. Kazakh copy needs a native review;
 * the Kazakh and Russian assertions pin a few load-bearing strings only.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME_ZONE = 'Asia/Almaty';
const T0 = Date.parse('2026-09-21T10:00:00.000Z');

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

const plain = (itemId: string, minutes: number, done: boolean, title: string) => ({
  itemId,
  drillVersionId: `${itemId}-v1`,
  minutes,
  done,
  reason: 'focus',
  status: 'COMMUNITY',
  attribution,
  content: {
    title: { en: title, ru: title, kk: title },
    goal: { en: `Goal of ${title}`, ru: `Цель ${title}`, kk: `Мақсат ${title}` },
    instructions: { en: 'Do it.', ru: 'Выполни.', kk: 'Орында.' },
    dose: { reps: 10 },
    conditions: { equipment: 'ball', spaces: ['yard'] },
  },
});

const SLALOM = {
  itemId: 'item-2',
  drillVersionId: 'slalom-v3',
  minutes: 8,
  done: false,
  reason: 'focus',
  status: 'REVIEWED',
  attribution,
  content: {
    title: { en: 'Cone slalom', ru: 'Слалом', kk: 'Слалом' },
    goal: { en: 'Keep the ball close through every cone.', ru: 'Веди мяч близко ко всем конусам.', kk: 'Допты әр конустан өткізе жақын ұста.' },
    instructions: {
      en: '1. Set five cones in a line.\n2. Dribble through them with small touches.',
      ru: '1. Поставь пять конусов в линию.\n2. Проведи мяч мелкими касаниями.',
      kk: '1. Бес конусты бір сызыққа қой.\n2. Допты ұсақ жанасумен өткіз.',
    },
    dose: { reps: 20, sets: 3, durationSec: 60 },
    mistakes: [{ en: 'Looking only at the ball.' }, { en: 'Kicking the ball too far ahead.' }],
    progressions: [{ en: 'Use only your weaker foot.' }],
    regressions: [{ en: 'Use three cones, not five.' }],
    conditions: { equipment: 'cones', spaces: ['yard', 'field'], partner: false, ageMin: 8, ageMax: 12 },
    safety: [{ en: 'Check the ground for holes and stones.' }, { en: 'Stop straight away if something hurts.' }],
    media: [{ kind: 'video', url: '/media/slalom.mp4', caption: { en: 'Slalom demo' } }],
  },
};

const ITEM_1 = plain('item-1', 5, true, 'Ball taps');
const ITEM_3 = plain('item-3', 7, false, 'First touch');

const ROADMAP = {
  currentLevelLabel: 'Basic',
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
    { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
  ],
};

function session(items: unknown[] = [ITEM_1, SLALOM, ITEM_3]): TodaySession {
  return TodaySession.parse({
    id: 'session-1',
    date: '2026-09-21',
    planner: 'rules',
    totalMinutes: 20,
    graphVersion: '0.1.0',
    items,
    roadmapSummary: ROADMAP,
  });
}

const withSlalom = (patch: Record<string, unknown>) => session([ITEM_1, { ...SLALOM, ...patch }, ITEM_3]);
const slalomDone = () => withSlalom({ done: true });

/** What the swap endpoint answers: the same item id, another drill's content. */
const EASIER_CONTENT = {
  ...SLALOM.content,
  title: { en: 'Slow slalom', ru: 'Медленный слалом', kk: 'Баяу слалом' },
  goal: { en: 'Walk the ball through the cones.', ru: 'Проведи мяч шагом.', kk: 'Допты қадаммен өткіз.' },
  dose: { reps: 8 },
  safety: [{ en: 'Wear shoes that fit.' }],
  media: [],
};
const swapped = () => withSlalom({ drillVersionId: 'slow-slalom-v1', minutes: 5, content: EASIER_CONTENT, regressionOf: 'slalom-v3' });

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

const eventsResponse = (s: TodaySession) => ({ session: s, progress: { sessionsCompleted: 1, minutesTrained: 8, streakDays: 1 }, nextSessionDate: '2026-09-22' });

// --- harness ---------------------------------------------------------------------------------------------------------

type Call = { method: string; url: string; body: any; headers: Headers };
type Reply = Response | Promise<Response>;
type Server = {
  calls: Call[];
  today?: () => Reply;
  events?: (body: any) => Reply;
  swap?: (body: any) => Reply;
};

const MODULES = {
  './drill-player.messages.ts': { default: messages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};

type Setup = {
  itemId?: string;
  locale?: Locale;
  server?: Partial<Server>;
  /** The session in the ['today'] cache before the screen opens; `null` means an empty cache (a deep link). */
  cached?: TodaySession | null;
  slots?: readonly ComponentType[];
  online?: boolean;
};

async function mountDrill(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const itemId = setup.itemId ?? 'item-2';
  const server: Server = { calls: [], ...setup.server };
  const state = { online: setup.online ?? true, now: T0 };
  const order: string[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, url: input, body, headers: new Headers(init?.headers) });
    if (method === 'GET' && input.startsWith('/api/player/today')) {
      order.push('GET today');
      return (server.today ?? (() => json(session())))();
    }
    if (method === 'POST' && input === '/api/player/session-events') return (server.events ?? (() => json(eventsResponse(slalomDone()))))(body);
    if (method === 'POST' && input.startsWith('/api/player/today/swap')) return (server.swap ?? (() => json(swapped())))(body);
    return new Response('not found', { status: 404 });
  };

  const ensureSession = mock(async () => {
    order.push('ensurePlayerSession');
    return { user: { id: 'player-1' } };
  });
  const navigate = mock((to: string, _options?: { replace?: boolean }) => void order.push(`navigate ${to}`));

  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const api = createApi({ fetch: fetchImpl, language: () => locale, online: () => state.online });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (setup.cached !== null) queryClient.setQueryData(['today'], setup.cached ?? session());
  const events = createEventsClient({ api, queryClient });

  const rootRoute = createRootRoute();
  const drillRoute = Route.update({ id: '/train/drill/$itemId', path: '/train/drill/$itemId', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([drillRoute as never]),
    history: createMemoryHistory({ initialEntries: [`/train/drill/${encodeURIComponent(itemId)}`] }),
  });
  await router.load();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <DrillPlayerDepsContext.Provider
          value={{
            api,
            ensureSession,
            navigate,
            timeZone: () => TIME_ZONE,
            events,
            now: () => state.now,
            isOnline: () => state.online,
            slots: setup.slots ?? [],
          }}
        >
          <RouterProvider router={router} />
        </DrillPlayerDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );

  return {
    ...view,
    router,
    user: userEvent.setup(),
    server,
    order,
    ensureSession,
    navigate,
    queryClient,
    /** Moves the fake clock forward WITHOUT running any timer: what a sleeping tab looks like. */
    sleep: (ms: number) => void (state.now += ms),
    /** A tab that wakes up. */
    wake: () => fireEvent(document, new Event('visibilitychange')),
    setOnline: (online: boolean) =>
      act(() => {
        state.online = online;
        window.dispatchEvent(new Event(online ? 'online' : 'offline'));
      }),
    todayCalls: () => server.calls.filter((call) => call.method === 'GET'),
    eventCalls: () => server.calls.filter((call) => call.url === '/api/player/session-events'),
    swapCalls: () => server.calls.filter((call) => call.url.startsWith('/api/player/today/swap')),
  };
}

afterEach(() => {
  cleanup();
});

const heading = (name: string, level = 2) => screen.findByRole('heading', { level, name });
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
/** The state word "Done" (not the button that is also called Done). */
const doneWord = () => screen.queryAllByText('Done').filter((node) => node.closest('button') === null);
const cachedSession = (page: { queryClient: QueryClient }) => page.queryClient.getQueryData<TodaySession>(['today'])!;
const cachedSlalom = (page: { queryClient: QueryClient }) => cachedSession(page).items.find((entry) => entry.itemId === 'item-2')!;

// --- the drill ------------------------------------------------------------------------------------------------------------

describe('the drill from the cached session (no network needed)', () => {
  test('shows the title, the goal and the position in the session without a single request', async () => {
    const page = await mountDrill();
    expect((await heading('Cone slalom', 1)).textContent).toBe('Cone slalom');
    expect(screen.getByText('Keep the ball close through every cone.')).toBeTruthy();
    expect(screen.getByText('Drill 2 of 3')).toBeTruthy();
    expect(screen.getByText('8 min')).toBeTruthy();
    expect(screen.getByText('Reviewed')).toBeTruthy();
    expect(page.server.calls).toHaveLength(0);
    expect(page.ensureSession).not.toHaveBeenCalled();
  });

  test('shows how to do it, the dose, the mistakes, the easier and harder variations and what is needed', async () => {
    await mountDrill();
    const how = (await heading('How to do it')).parentElement!;
    expect(within(how).getByText('Set five cones in a line.')).toBeTruthy();
    expect(within(how).getByText('Dribble through them with small touches.')).toBeTruthy();

    const target = (await heading('Your target')).parentElement!;
    expect(within(target).getByText('Reps').nextElementSibling!.textContent).toBe('20');
    expect(within(target).getByText('Sets').nextElementSibling!.textContent).toBe('3');
    expect(within(target).getByText('Time').nextElementSibling!.textContent).toBe('60 s');

    const mistakes = (await heading('Common mistakes')).parentElement!;
    expect(within(mistakes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Looking only at the ball.', 'Kicking the ball too far ahead.']);
    expect(within((await heading('Make it easier')).parentElement!).getByText('Use three cones, not five.')).toBeTruthy();
    expect(within((await heading('Make it harder')).parentElement!).getByText('Use only your weaker foot.')).toBeTruthy();

    const needs = (await heading('What you need')).parentElement!;
    expect(within(needs).getByText('Cones')).toBeTruthy();
    expect(within(needs).getByText(/Yard/)).toBeTruthy();
    expect(within(needs).getByText(/Field/)).toBeTruthy();
    expect(within(needs).getByText('On your own')).toBeTruthy();
    expect(within(needs).getByText('Ages 8 to 12')).toBeTruthy();
  });

  test('the safety note is a highlighted, labelled notice that comes before the instructions', async () => {
    await mountDrill();
    const notice = await screen.findByRole('region', { name: 'Safety' });
    expect(notice.getAttribute('data-tone')).toBe('warn');
    // A written heading and both notes; an icon (never colour alone) is part of the Notice primitive.
    expect(within(notice).getByText('Safety first')).toBeTruthy();
    expect(within(notice).getByText('Check the ground for holes and stones.')).toBeTruthy();
    expect(within(notice).getByText('Stop straight away if something hurts.')).toBeTruthy();
    expect(notice.querySelector('svg')).not.toBeNull();
    const how = await heading('How to do it');
    expect(notice.compareDocumentPosition(how) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a drill with no safety note, mistakes or variations shows none of those sections (nothing is invented)', async () => {
    await mountDrill({ itemId: 'item-3' });
    await heading('First touch', 1);
    expect(screen.queryByRole('region', { name: 'Safety' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Common mistakes' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Make it easier' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Make it harder' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Video' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play video' })).toBeNull();
  });

  test('every component of the drill slot renders in <div data-slot="drill">', async () => {
    const First = () => <p>first extra</p>;
    const Second = () => <p>second extra</p>;
    const { container } = await mountDrill({ slots: [First, Second] });
    await heading('Cone slalom', 1);
    const slot = container.querySelector('[data-slot="drill"]')!;
    expect(within(slot as HTMLElement).getAllByText(/extra/).map((node) => node.textContent)).toEqual(['first extra', 'second extra']);
  });

  test('no slot region is rendered when there are no slot components', async () => {
    const { container } = await mountDrill();
    await heading('Cone slalom', 1);
    expect(container.querySelector('[data-slot="drill"]')).toBeNull();
  });
});

describe('the states around the drill', () => {
  test('loading: with no cached session it asks for today (locale and X-Timezone), after the sign-in, and shows a busy status', async () => {
    const gate = deferred<Response>();
    const page = await mountDrill({ cached: null, locale: 'ru', server: { today: () => gate.promise } });
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(page.todayCalls()).toHaveLength(1));
    expect(page.todayCalls()[0]!.url).toBe('/api/player/today?locale=ru');
    expect(page.todayCalls()[0]!.headers.get('x-timezone')).toBe(TIME_ZONE);
    expect(page.order.slice(0, 2)).toEqual(['ensurePlayerSession', 'GET today']);
    gate.resolve(json(session()));
    expect((await heading('Слалом', 1)).textContent).toBe('Слалом');
  });

  test("a fetched session is kept in the ['today'] cache", async () => {
    const page = await mountDrill({ cached: null });
    await heading('Cone slalom', 1);
    expect(cachedSession(page).id).toBe('session-1');
  });

  test('error: a failed load says so in words and Try again asks again', async () => {
    let fail = true;
    const page = await mountDrill({ cached: null, server: { today: () => (fail ? problem(500) : json(session())) } });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load this drill')).toBeTruthy();
    expect(page.navigate).not.toHaveBeenCalled();
    fail = false;
    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await heading('Cone slalom', 1);
    expect(page.todayCalls()).toHaveLength(2);
  });

  test('a player who is not onboarded (404) is sent to /train/onboarding, once', async () => {
    const page = await mountDrill({ cached: null, server: { today: () => problem(404) } });
    await waitFor(() => expect(page.navigate).toHaveBeenCalled());
    expect(page.navigate.mock.calls).toHaveLength(1);
    expect(page.navigate.mock.calls[0]![0]).toBe('/train/onboarding');
    expect(screen.queryByRole('heading', { level: 1 })?.textContent ?? '').not.toContain('Cone');
  });

  test("empty: an item that is not in today's session says so and leads back to the session", async () => {
    const page = await mountDrill({ itemId: 'no-such-item' });
    expect(await screen.findByText("This drill is not in today's session")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    const back = screen.getAllByRole('link', { name: "Back to today's session" })[0]!;
    expect(back.getAttribute('href')).toBe('/train');
    await page.user.click(back);
    expect(page.navigate.mock.calls.at(-1)![0]).toBe('/train');
  });

  test('offline: a notice says the drill is from the last session and that saving needs a connection; the drill still shows', async () => {
    const page = await mountDrill({ online: false });
    await heading('Cone slalom', 1);
    expect(screen.getByText('You are offline. This drill is shown from your last session. Saving needs a connection.')).toBeTruthy();
    await page.setOnline(true);
    await waitFor(() => expect(screen.queryByText(/You are offline/)).toBeNull());
  });

  test('a link back to the session and one to the next drill', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    const back = screen.getAllByRole('link', { name: "Today's session" })[0]!;
    expect(back.getAttribute('href')).toBe('/train');
    const next = screen.getByRole('link', { name: 'Next drill' });
    expect(next.getAttribute('href')).toBe('/train/drill/item-3');
    await page.user.click(next);
    expect(page.navigate.mock.calls.at(-1)![0]).toBe('/train/drill/item-3');
  });

  test('on the last drill the next step leads back to the session', async () => {
    const page = await mountDrill({ itemId: 'item-3' });
    await heading('First touch', 1);
    expect(screen.queryByRole('link', { name: 'Next drill' })).toBeNull();
    const back = screen.getByRole('link', { name: "Back to today's session" });
    await page.user.click(back);
    expect(page.navigate.mock.calls.at(-1)![0]).toBe('/train');
  });
});

// --- the video ------------------------------------------------------------------------------------------------------------

describe('the video', () => {
  test('is lazy: nothing is loaded until the player taps Play, then it plays with its caption', async () => {
    const { container, user } = await mountDrill();
    const play = await screen.findByRole('button', { name: 'Play video' });
    expect(container.querySelector('video')).toBeNull();
    await user.click(play);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/media/slalom.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(screen.getByText('Slalom demo')).toBeTruthy();
  });

  test('offline it cannot be played: the button is disabled and says why', async () => {
    const { container } = await mountDrill({ online: false });
    const play = await screen.findByRole<HTMLButtonElement>('button', { name: 'Play video' });
    expect(play.disabled).toBe(true);
    expect(screen.getByText('Video needs an internet connection.')).toBeTruthy();
    expect(play.getAttribute('aria-describedby')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  test('a video that fails to load says so and can be tried again', async () => {
    const { container, user } = await mountDrill();
    await user.click(await screen.findByRole('button', { name: 'Play video' }));
    fireEvent.error(container.querySelector('video')!);
    expect(await screen.findByText('The video could not be loaded. Try again.')).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Play video' }));
    expect(container.querySelector('video')).not.toBeNull();
  });
});

// --- the timer ------------------------------------------------------------------------------------------------------------

describe('the count-up timer', () => {
  const timer = () => screen.getByRole('timer', { name: 'Time so far' });

  test('starts at 0:00, counts by the clock and not by ticks: a sleeping tab does not make it drift', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    expect(timer().textContent).toBe('0:00');
    await page.user.click(button('Start timer'));
    page.sleep(65_000); // no timer callback runs in between: the tab was asleep
    page.wake();
    expect(timer().textContent).toBe('1:05');
    page.sleep(600_000);
    page.wake();
    expect(timer().textContent).toBe('11:05');
  });

  test('Pause holds the time, Resume carries on from it, Reset returns to 0:00', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    await page.user.click(button('Start timer'));
    page.sleep(20_000);
    await page.user.click(button('Pause timer'));
    expect(timer().textContent).toBe('0:20');
    page.sleep(50_000);
    page.wake();
    expect(timer().textContent).toBe('0:20');
    await page.user.click(button('Resume timer'));
    page.sleep(5_000);
    page.wake();
    expect(timer().textContent).toBe('0:25');
    await page.user.click(button('Reset timer'));
    expect(timer().textContent).toBe('0:00');
    expect(screen.queryByRole('button', { name: 'Reset timer' })).toBeNull();
    expect(button('Start timer')).toBeTruthy();
  });

  test('when the drill has a target time, reaching it is said in words', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    await page.user.click(button('Start timer'));
    page.sleep(59_000);
    page.wake();
    expect(screen.queryByText('Target time reached')).toBeNull();
    page.sleep(1_000);
    page.wake();
    expect(screen.getByText('Target time reached')).toBeTruthy();
  });

  test('a drill without a target time never says the target was reached', async () => {
    const page = await mountDrill({ itemId: 'item-3' });
    await heading('First touch', 1);
    await page.user.click(button('Start timer'));
    page.sleep(3_600_000);
    page.wake();
    expect(timer().textContent).toBe('60:00');
    expect(screen.queryByText('Target time reached')).toBeNull();
  });

  test('a clock that jumps backwards never shows negative time', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    await page.user.click(button('Start timer'));
    page.sleep(-30_000);
    page.wake();
    expect(timer().textContent).toBe('0:00');
  });
});

// --- Done / Undo ------------------------------------------------------------------------------------------------------------

describe('Done and Undo', () => {
  test('Done sends exactly one drill_done event for this item, then shows Done (word and check) and an Undo button', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    expect(doneWord()).toHaveLength(0);
    await page.user.click(button('Done'));

    await screen.findByRole('button', { name: 'Undo' });
    expect(page.eventCalls()).toHaveLength(1);
    const call = page.eventCalls()[0]!;
    expect(call.body.events).toHaveLength(1);
    const [event] = call.body.events;
    expect(event.type).toBe('drill_done');
    expect(event.itemId).toBe('item-2');
    expect(event.sessionId).toBe('session-1');
    expect(event.clientUuid).toMatch(UUID);
    expect(new Date(event.at).toISOString()).toBe(event.at);
    expect(event.value).toBeUndefined();

    expect(screen.getByText('Marked as done.')).toBeTruthy();
    expect(doneWord()[0]!.querySelector('svg')).not.toBeNull();
    expect(cachedSlalom(page).done).toBe(true);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  test('is optimistic: the drill shows as done at once, while the request is still in flight, and every mutation button is disabled', async () => {
    const gate = deferred<Response>();
    const page = await mountDrill({ server: { events: () => gate.promise } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));

    await waitFor(() => expect(cachedSlalom(page).done).toBe(true)); // before any answer
    expect(page.eventCalls()).toHaveLength(1);
    expect(doneWord()[0]!.querySelector('svg')).not.toBeNull();
    for (const name of ['Undo', 'Save result', 'Too hard', 'Too easy']) {
      expect(button(name).disabled).toBe(true);
    }
    expect(button('Undo').getAttribute('aria-busy')).toBe('true');

    gate.resolve(json(eventsResponse(slalomDone())));
    await waitFor(() => expect(button('Undo').disabled).toBe(false));
    expect(page.eventCalls()).toHaveLength(1);
  });

  test("after the answer the cache holds the SERVER's session, not the guess", async () => {
    const server = withSlalom({ done: true, minutes: 9 });
    const page = await mountDrill({ server: { events: () => json(eventsResponse(server)) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));
    await screen.findByRole('button', { name: 'Undo' });
    expect(cachedSlalom(page).minutes).toBe(9);
  });

  test('Undo sends one drill_undone event and the drill goes back to not done', async () => {
    const page = await mountDrill({
      cached: slalomDone(),
      server: { events: () => json(eventsResponse(session())) },
    });
    await heading('Cone slalom', 1);
    expect(doneWord()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    await page.user.click(button('Undo'));
    await screen.findByRole('button', { name: 'Done' });
    expect(page.eventCalls()).toHaveLength(1);
    const [event] = page.eventCalls()[0]!.body.events;
    expect(event.type).toBe('drill_undone');
    expect(event.itemId).toBe('item-2');
    expect(event.sessionId).toBe('session-1');
    expect(screen.getByText('Marked as not done.')).toBeTruthy();
    expect(cachedSlalom(page).done).toBe(false);
  });

  test('a failed post rolls the drill back to not done and says what happened, with a way to try again', async () => {
    const gate = deferred<Response>();
    const page = await mountDrill({ server: { events: () => gate.promise } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));
    await waitFor(() => expect(cachedSlalom(page).done).toBe(true));

    gate.resolve(problem(500));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not save that')).toBeTruthy();
    expect(within(alert).getByText(problemMessages.en.server)).toBeTruthy();
    // Rolled back: not done in the cache, Done is offered again, no "Done" state word, every button usable again.
    expect(cachedSlalom(page).done).toBe(false);
    expect(button('Done').disabled).toBe(false);
    expect(screen.queryByText('Marked as done.')).toBeNull();
    expect(doneWord()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  test('a failed Undo rolls back to done', async () => {
    const page = await mountDrill({ cached: slalomDone(), server: { events: () => problem(500) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Undo'));
    await screen.findByRole('alert');
    expect(cachedSlalom(page).done).toBe(true);
    expect(button('Undo').disabled).toBe(false);
  });

  test('Try again resends the SAME event (same clientUuid), so a retry after a dropped answer is a replay the server ignores', async () => {
    let attempt = 0;
    const page = await mountDrill({
      server: { events: () => (++attempt === 1 ? problem(500) : json(eventsResponse(slalomDone()))) },
    });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));
    const alert = await screen.findByRole('alert');
    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Undo' });
    expect(page.eventCalls()).toHaveLength(2);
    const [first, second] = page.eventCalls().map((call) => call.body.events[0]);
    expect(second.clientUuid).toBe(first.clientUuid);
    expect(second.at).toBe(first.at);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('pressing Done again by hand after a failure also reuses the same clientUuid; a later, separate action gets a new one', async () => {
    let attempt = 0;
    const page = await mountDrill({
      server: {
        events: (body) => {
          attempt += 1;
          if (attempt === 1) return problem(500);
          return json(eventsResponse(body.events[0].type === 'drill_done' ? slalomDone() : session()));
        },
      },
    });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));
    await screen.findByRole('alert');
    await page.user.click(button('Done'));
    await page.user.click(await screen.findByRole('button', { name: 'Undo' }));
    await page.user.click(await screen.findByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Undo' });
    const uuids = page.eventCalls().map((call) => call.body.events[0].clientUuid);
    expect(uuids).toHaveLength(4);
    expect(uuids[1]).toBe(uuids[0]);
    expect(new Set(uuids).size).toBe(3);
  });

  test('an offline post fails calmly: rolled back, with the offline message', async () => {
    const page = await mountDrill({ online: false, server: { events: () => Promise.reject(new TypeError('Failed to fetch')) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Done'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(problemMessages.en.offline)).toBeTruthy();
    expect(cachedSlalom(page).done).toBe(false);
  });

  test('the Done button of a drill that is already done is not offered twice: the state shows once, in the header', async () => {
    await mountDrill({ cached: slalomDone() });
    await heading('Cone slalom', 1);
    expect(doneWord()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  test('once the drill is done, Next drill is the primary next step', async () => {
    await mountDrill({ cached: slalomDone() });
    await heading('Cone slalom', 1);
    expect(screen.getByRole('link', { name: 'Next drill' }).className).toContain('bg-ink');
  });

  test('before the drill is done, Done is the primary control and Next drill is quieter', async () => {
    await mountDrill();
    await heading('Cone slalom', 1);
    expect(button('Done').getAttribute('data-variant')).toBe('primary');
    expect(screen.getByRole('link', { name: 'Next drill' }).className).not.toContain('bg-ink');
  });
});

// --- the result -------------------------------------------------------------------------------------------------------------

describe('the optional result', () => {
  const box = () => screen.getByLabelText<HTMLInputElement>('Your result (optional)');

  test('is a labelled box that sends one result event with the number, and says it was saved', async () => {
    const page = await mountDrill({ server: { events: () => json(eventsResponse(session())) } });
    await heading('Cone slalom', 1);
    expect(screen.getByText('A number, for example how many times you did it.')).toBeTruthy();
    await page.user.type(box(), '17');
    await page.user.click(button('Save result'));
    await screen.findByText('Result saved: 17');
    expect(page.eventCalls()).toHaveLength(1);
    const [event] = page.eventCalls()[0]!.body.events;
    expect(event.type).toBe('result');
    expect(event.value).toBe(17);
    expect(event.itemId).toBe('item-2');
    expect(event.sessionId).toBe('session-1');
    expect(event.clientUuid).toMatch(UUID);
    // A result is not a Done: the drill is untouched.
    expect(cachedSlalom(page).done).toBe(false);
  });

  test('a comma counts as the decimal point', async () => {
    const page = await mountDrill({ server: { events: () => json(eventsResponse(session())) } });
    await heading('Cone slalom', 1);
    await page.user.type(box(), '12,5');
    await page.user.click(button('Save result'));
    await screen.findByText(/Result saved/);
    expect(page.eventCalls()[0]!.body.events[0].value).toBe(12.5);
  });

  test.each([
    ['', 'Type a number.'],
    ['abc', 'Use digits only, for example 12.'],
    ['-3', 'The number cannot be below zero.'],
  ])('%p is refused with a written message and nothing is sent', async (typed, message) => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    if (typed !== '') await page.user.type(box(), typed);
    await page.user.click(button('Save result'));
    const shown = await screen.findByText(message);
    expect(shown.closest('[role="alert"]')).not.toBeNull();
    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(page.eventCalls()).toHaveLength(0);
  });

  test('a failed save is rolled back (no "saved" line) and can be tried again with the same clientUuid', async () => {
    let attempt = 0;
    const page = await mountDrill({ server: { events: () => (++attempt === 1 ? problem(500) : json(eventsResponse(session()))) } });
    await heading('Cone slalom', 1);
    await page.user.type(box(), '9');
    await page.user.click(button('Save result'));
    const alert = await screen.findByRole('alert');
    expect(screen.queryByText('Result saved: 9')).toBeNull();
    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Result saved: 9');
    const [first, second] = page.eventCalls().map((call) => call.body.events[0]);
    expect(second.clientUuid).toBe(first.clientUuid);
  });
});

// --- swap ------------------------------------------------------------------------------------------------------------------

describe('Too hard / Too easy (swap)', () => {
  test('Too hard asks for an easier drill and the drill on screen is replaced by the one the server returns', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    await page.user.click(button('Too hard'));
    expect((await heading('Slow slalom', 1)).textContent).toBe('Slow slalom');
    expect(screen.queryByText('Cone slalom')).toBeNull();
    expect(screen.getByText('Walk the ball through the cones.')).toBeTruthy();
    expect(screen.getByText('5 min')).toBeTruthy();
    expect(screen.getByText('Swapped for an easier drill.')).toBeTruthy();

    expect(page.swapCalls()).toHaveLength(1);
    const call = page.swapCalls()[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/player/today/swap?locale=en');
    expect(call.headers.get('x-timezone')).toBe(TIME_ZONE);
    expect(call.body).toEqual({ itemId: 'item-2', direction: 'easier' });
    // The new drill's own sections replace the old ones; the old safety note is gone with the old drill.
    expect(screen.queryByText('Check the ground for holes and stones.')).toBeNull();
    expect(screen.getByText('Wear shoes that fit.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play video' })).toBeNull();
    // The cache holds the server's session; no session event was sent.
    expect(cachedSlalom(page).drillVersionId).toBe('slow-slalom-v1');
    expect(page.eventCalls()).toHaveLength(0);
    // Still the same place in the session.
    expect(screen.getByText('Drill 2 of 3')).toBeTruthy();
  });

  test('Too easy asks for a harder drill', async () => {
    const harder = withSlalom({ drillVersionId: 'fast-slalom-v1', content: { ...EASIER_CONTENT, title: { en: 'Fast slalom' } }, progressionOf: 'slalom-v3' });
    const page = await mountDrill({ server: { swap: () => json(harder) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Too easy'));
    await heading('Fast slalom', 1);
    expect(page.swapCalls()[0]!.body).toEqual({ itemId: 'item-2', direction: 'harder' });
    expect(screen.getByText('Swapped for a harder drill.')).toBeTruthy();
  });

  test('a swapped drill starts with a fresh timer', async () => {
    const page = await mountDrill();
    await heading('Cone slalom', 1);
    await page.user.click(button('Start timer'));
    page.sleep(30_000);
    page.wake();
    expect(screen.getByRole('timer').textContent).toBe('0:30');
    await page.user.click(button('Too hard'));
    await heading('Slow slalom', 1);
    expect(screen.getByRole('timer').textContent).toBe('0:00');
    expect(button('Start timer')).toBeTruthy();
  });

  test('while the request is in flight both swap buttons and every other mutation button are disabled, and only one request is sent', async () => {
    const gate = deferred<Response>();
    const page = await mountDrill({ server: { swap: () => gate.promise } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Too hard'));
    await waitFor(() => expect(page.swapCalls()).toHaveLength(1));
    for (const name of ['Too hard', 'Too easy', 'Done', 'Save result']) expect(button(name).disabled).toBe(true);
    expect(button('Too hard').getAttribute('aria-busy')).toBe('true');
    // The drill stays as it was until the server answers (a swap cannot be guessed).
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cone slalom');
    gate.resolve(json(swapped()));
    await heading('Slow slalom', 1);
    expect(button('Too hard').disabled).toBe(false);
    expect(page.swapCalls()).toHaveLength(1);
  });

  test('a failed swap leaves the drill as it was and says so; nothing is rolled forward', async () => {
    const page = await mountDrill({ server: { swap: () => problem(500) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Too hard'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not swap the drill')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cone slalom');
    expect(cachedSlalom(page).drillVersionId).toBe('slalom-v3');
    expect(button('Too hard').disabled).toBe(false);
  });

  test('no alternative (409) is explained in plain words for the direction that was asked', async () => {
    const page = await mountDrill({ server: { swap: () => problem(409) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Too easy'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('There is no harder drill for you right now.')).toBeTruthy();
    await page.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(page.swapCalls()).toHaveLength(2);
  });

  test('offline both swap buttons are disabled with a written explanation, and nothing is sent', async () => {
    const page = await mountDrill({ online: false });
    await heading('Cone slalom', 1);
    for (const name of ['Too hard', 'Too easy']) {
      const swapButton = button(name);
      expect(swapButton.disabled).toBe(true);
      const reason = swapButton.getAttribute('aria-describedby');
      expect(reason).not.toBeNull();
      expect(document.getElementById(reason!)!.textContent).toBe('Swapping a drill needs an internet connection.');
    }
    await page.user.click(button('Too hard'));
    expect(page.swapCalls()).toHaveLength(0);
  });

  test('coming back online enables the swap buttons again', async () => {
    const page = await mountDrill({ online: false });
    await heading('Cone slalom', 1);
    expect(button('Too hard').disabled).toBe(true);
    await page.setOnline(true);
    await waitFor(() => expect(button('Too hard').disabled).toBe(false));
    expect(screen.queryByText('Swapping a drill needs an internet connection.')).toBeNull();
    expect(button('Too easy').disabled).toBe(false);
  });

  test('a drill that is already done cannot be swapped (the server refuses it): disabled, with the reason', async () => {
    const page = await mountDrill({ cached: slalomDone() });
    await heading('Cone slalom', 1);
    for (const name of ['Too hard', 'Too easy']) {
      const swapButton = button(name);
      expect(swapButton.disabled).toBe(true);
      expect(document.getElementById(swapButton.getAttribute('aria-describedby')!)!.textContent).toBe('Undo "Done" first, then you can swap this drill.');
    }
    await page.user.click(button('Too hard'));
    expect(page.swapCalls()).toHaveLength(0);
  });
});

// --- languages ---------------------------------------------------------------------------------------------------------------

describe('languages', () => {
  test('Russian: the content is in Russian and so are the labels', async () => {
    await mountDrill({ locale: 'ru' });
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Слалом');
    expect(screen.getByText('Веди мяч близко ко всем конусам.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: messages.ru.instructions.title })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages.ru.done })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages.ru.swap.tooHard })).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.ru.next })).toBeTruthy();
    expect(messages.ru.done).not.toBe(messages.en.done);
  });

  test('Kazakh (copy needs a native review): the labels are Kazakh, and content falls back through ru and en where a text has no Kazakh', async () => {
    await mountDrill({ locale: 'kk' });
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Слалом');
    expect(screen.getByText('Допты әр конустан өткізе жақын ұста.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: messages.kk.instructions.title })).toBeTruthy();
    expect(screen.getByRole('button', { name: messages.kk.done })).toBeTruthy();
    // The mistakes have only English text: shown as the fallback, never blank.
    expect(screen.getByText('Looking only at the ball.')).toBeTruthy();
    expect(messages.kk.done).not.toBe(messages.en.done);
  });

  test('the three languages have the same keys', () => {
    const keys = (tree: unknown, prefix = ''): string[] =>
      Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    expect(keys(messages.kk).sort()).toEqual(keys(messages.en).sort());
    expect(keys(messages.ru).sort()).toEqual(keys(messages.en).sort());
  });
});

describe('the item id in the address', () => {
  test('moving to another drill shows that drill and starts from a clean screen (fresh timer, no old status)', async () => {
    const page = await mountDrill({ server: { events: () => json(eventsResponse(slalomDone())) } });
    await heading('Cone slalom', 1);
    await page.user.click(button('Start timer'));
    page.sleep(10_000);
    page.wake();
    expect(screen.getByRole('timer').textContent).toBe('0:10');
    await page.user.click(button('Done'));
    await screen.findByText('Marked as done.');

    await act(async () => {
      await page.router.navigate({ to: '/train/drill/$itemId', params: { itemId: 'item-3' } } as never);
    });
    expect((await heading('First touch', 1)).textContent).toBe('First touch');
    expect(screen.getByRole('timer').textContent).toBe('0:00');
    expect(screen.queryByText('Marked as done.')).toBeNull();
    expect(screen.getByText('Drill 3 of 3')).toBeTruthy();
  });
});
