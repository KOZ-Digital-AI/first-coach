import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Locale } from '@api-types/primitives';
import { TodaySession } from '@api-types/session';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { PlayerSessionError } from '../../lib/auth';
import { createI18n } from '../../lib/i18n';
import { persistAppQueryClient, type PersistStore } from '../../lib/query-persist';
import problemMessages from '../../lib/problem.messages';
import { writeOfflineSession } from '../../offline/types';
import { DrillPlayerDepsContext, Route as DrillRoute } from '../../routes/train/drill.$itemId';
import { Route as TodayRoute, TodayDepsContext } from '../../routes/train/index';
import trustBadgeMessages from '../commons/trust-badge.messages';
import drillMessages from './drill-player.messages';
import { createEventsClient } from './events-client';
import todayMessages from './today.messages';

if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');

/*
 * fc-mol-eay.12: an OFFLINE cold reload of /train and /train/drill/<itemId>. The device holds the player's data (the persisted
 * query cache, and the session the player downloaded), but the page starts with no network and no session answer: the auth
 * session cannot be read, so `ensurePlayerSession` rejects, and the API call for today's session fails with the offline
 * problem. Both routes must then show what the device holds, with the existing "Could not refresh" notice on /train, and keep
 * the error state only when the device holds nothing.
 *
 * The network is faked as "always offline" (the real `createApi` with a fetch that rejects and `online: () => false`, the
 * problem kind a real offline reload gets) and the session as "cannot be read" (a PlayerSessionError of kind 'offline'). The
 * device is the real (happy-dom) localStorage, with the player's downloaded session and the last-player id written the way the
 * app writes them; the persisted cache is the real persister over an in-memory store whose restore lands AFTER the failed
 * request (IndexedDB is asynchronous).
 *
 * Readings of the criteria where they were open:
 *  - "the device holds a session" means: the ['today'] query cache (persisted cache restored), or else the session the last
 *    player downloaded (localStorage fc:<id>:session). The downloaded session is used whatever its date: like the persisted cache
 *    it is "the last saved session", and the notice says so.
 *  - a 404 "not onboarded" is an answer, not a failure: it still sends the player to /train/onboarding, device data or not.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------------

const TIME_ZONE = 'Asia/Almaty';

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
    title: { en: 'Cone slalom' },
    goal: { en: 'Keep the ball close through every cone.' },
    instructions: { en: '1. Set five cones in a line.\n2. Dribble through them with small touches.' },
    dose: { reps: 20, sets: 3, durationSec: 60 },
    mistakes: [{ en: 'Looking only at the ball.' }, { en: 'Kicking the ball too far ahead.' }],
    progressions: [{ en: 'Use only your weaker foot.' }],
    regressions: [{ en: 'Use three cones, not five.' }],
    conditions: { equipment: 'cones', spaces: ['yard', 'field'], partner: false, ageMin: 8, ageMax: 12 },
    safety: [{ en: 'Check the ground for holes and stones.' }, { en: 'Stop straight away if something hurts.' }],
  },
};

const ROADMAP = {
  currentLevelLabel: 'Basic',
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
    { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
  ],
};

/** A session as the app holds it (the client parses every answer, so defaults such as `media: []` are filled in). */
const session = (id = 'session-1', date = '2026-09-21') =>
  TodaySession.parse({
  id,
  date,
  planner: 'rules',
  totalMinutes: 20,
  graphVersion: '0.1.0',
  items: [plain('item-1', 5, true, 'Ball taps'), SLALOM, plain('item-3', 7, false, 'First touch')],
  roadmapSummary: ROADMAP,
  });

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number) => json({ type: 'about:blank', title: 'Problem', status, errors: [] }, status, 'application/problem+json');

// --- the device ---------------------------------------------------------------------------------------------------------------

const DEVICE_KEYS = ['fc:last-player', 'fc:p1:session', 'fc:p2:session'];
const wipeDevice = () => DEVICE_KEYS.forEach((key) => localStorage.removeItem(key));

/** The last player and the session they downloaded, as the app leaves them on the device. */
function downloaded(playerId: string, s: unknown = session(), lastPlayer: string | undefined = playerId) {
  if (lastPlayer !== undefined) localStorage.setItem('fc:last-player', lastPlayer);
  const written = writeOfflineSession(localStorage, playerId, {
    playerId,
    session: s as never,
    downloadedAt: '2026-09-21T10:00:00.000Z',
    locale: 'en',
  });
  if (!written) throw new Error('the test device could not store the session');
}

/** An IndexedDB stand-in whose reads land after `delayMs` (the restore is asynchronous). */
function slowStore(initial: Record<string, unknown>, delayMs = 30): PersistStore {
  const data = new Map(Object.entries(initial));
  const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
  return {
    get: <T,>(key: string) => later(data.get(key) as T | undefined),
    set: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
  };
}

/** What the persister saved on the last online visit: the ['today'] query in the persisted-client shape. */
function persistedCache(s: unknown) {
  const now = Date.now();
  return {
    timestamp: now,
    buster: 'build-1',
    clientState: {
      mutations: [],
      queries: [
        {
          queryKey: ['today'],
          queryHash: '["today"]',
          state: {
            data: s,
            dataUpdateCount: 1,
            dataUpdatedAt: now,
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: 'success',
            fetchStatus: 'idle',
          },
        },
      ],
    },
  };
}

// --- harness ------------------------------------------------------------------------------------------------------------------

type Offline = { restore?: unknown; todayStatus?: number };

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};

function environment(locale: Locale, modules: Record<string, { default: unknown }>, offline: Offline) {
  const calls: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    if (offline.todayStatus !== undefined) return problem(offline.todayStatus);
    throw new TypeError('Failed to fetch');
  };
  const ensureSession = mock(async () => {
    throw new PlayerSessionError('ensurePlayerSession: could not read the current session', { kind: 'offline', cause: new TypeError('Failed to fetch') });
  });
  const navigate = mock((_to: string, _options?: { replace?: boolean }) => {});
  const i18n = createI18n({ modules: modules as never, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const api = createApi({ fetch: fetchImpl, language: () => locale, online: () => false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 14 * 24 * 60 * 60 * 1000 } } });
  const events = createEventsClient({ api, queryClient });
  if (offline.restore !== undefined) {
    // the way bootstrap.ts wires the remembered player: the persister restores the cache, asynchronously
    persistAppQueryClient({ queryClient, playerId: 'p1', buildVersion: 'build-1', store: slowStore({ 'fc:p1:query-cache': offline.restore }) });
  }
  return { calls, ensureSession, navigate, i18n, api, queryClient, events };
}

const TODAY_MODULES = {
  './today.messages.ts': { default: todayMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

const DRILL_MODULES = {
  './drill-player.messages.ts': { default: drillMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

function mountToday(offline: Offline = {}) {
  const env = environment('en', TODAY_MODULES, offline);
  const Page = TodayRoute.options.component;
  if (Page === undefined) throw new Error('the /train route has no component');
  render(
    <QueryClientProvider client={env.queryClient}>
      <I18nextProvider i18n={env.i18n}>
        <TodayDepsContext.Provider
          value={{ api: env.api, ensureSession: env.ensureSession, navigate: env.navigate, timeZone: () => TIME_ZONE, events: env.events, slots: [] }}
        >
          <Page />
        </TodayDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return env;
}

async function mountDrill(itemId: string, offline: Offline = {}) {
  const env = environment('en', DRILL_MODULES, offline);
  const rootRoute = createRootRoute();
  const drillRoute = DrillRoute.update({ id: '/train/drill/$itemId', path: '/train/drill/$itemId', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([drillRoute as never]),
    history: createMemoryHistory({ initialEntries: [`/train/drill/${encodeURIComponent(itemId)}`] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={env.queryClient}>
      <I18nextProvider i18n={env.i18n}>
        <DrillPlayerDepsContext.Provider
          value={{
            api: env.api,
            ensureSession: env.ensureSession,
            navigate: env.navigate,
            timeZone: () => TIME_ZONE,
            events: env.events,
            isOnline: () => false,
            slots: [],
          }}
        >
          <RouterProvider router={router} />
        </DrillPlayerDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return env;
}

afterEach(() => {
  cleanup();
  wipeDevice();
});

const STALE = 'Could not refresh. Showing the last saved session.';
const LOAD_ERROR = "Could not load today's session";
const DRILL_LOAD_ERROR = 'Could not load this drill';

const drillList = () => screen.findByRole('list', { name: todayMessages.en.list });

/** Waits for the failed request to have settled, so an error state would have had time to show. */
const settled = async (env: { calls: string[] }) => {
  await waitFor(() => expect(env.calls.length).toBeGreaterThan(0));
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
};

// --- /train ---------------------------------------------------------------------------------------------------------------------

describe('/train, cold reload offline', () => {
  test('the downloaded session of the last player is shown (every drill title) with the "could not refresh" notice, and not the error state', async () => {
    downloaded('p1');
    const env = mountToday();
    const list = await drillList();
    for (const title of ['Ball taps', 'Cone slalom', 'First touch']) expect(within(list).getByText(title)).toBeTruthy();
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    // the only alert is the warn notice itself (Notice tone="warn" is role=alert); the error state's retry is not there
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([STALE]);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(env.navigate).not.toHaveBeenCalled();
  });

  test("the downloaded session is put into the ['today'] cache (the drill player and the finish button work from it)", async () => {
    downloaded('p1');
    const env = mountToday();
    await drillList();
    expect(env.queryClient.getQueryData<{ id: string }>(['today'])?.id).toBe('session-1');
  });

  test('the progress made offline (done flags of the stored session) is what is shown', async () => {
    downloaded('p1', TodaySession.parse({ ...session(), items: [plain('item-1', 5, true, 'Ball taps'), { ...SLALOM, done: true }, plain('item-3', 7, true, 'First touch')] }));
    mountToday();
    await drillList();
    expect(screen.getByText('3/3 completed')).toBeTruthy();
  });

  test('the persisted query cache, restored AFTER the failed request, replaces the error state with the session', async () => {
    const env = mountToday({ restore: persistedCache(session()) });
    const list = await drillList();
    expect(within(list).getByText('Cone slalom')).toBeTruthy();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(env.queryClient.getQueryData<{ id: string }>(['today'])?.id).toBe('session-1');
  });

  test('a failed session read (ensurePlayerSession rejects) is not what decides: the cached session is shown', async () => {
    downloaded('p1');
    const env = mountToday();
    await drillList();
    expect(env.ensureSession).toHaveBeenCalled();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
  });

  test('nothing on the device: the existing error state stays (with its retry)', async () => {
    const env = mountToday();
    await screen.findByText(LOAD_ERROR);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: todayMessages.en.list })).toBeNull();
    expect(env.queryClient.getQueryData(['today'])).toBeUndefined();
  });

  test('a session downloaded by ANOTHER player than the last one is never shown', async () => {
    downloaded('p2', session('other-session'), 'p1');
    mountToday();
    await screen.findByText(LOAD_ERROR);
    expect(screen.queryByRole('list', { name: todayMessages.en.list })).toBeNull();
  });

  test('a downloaded session with no last player on the device is not shown (there is no way to know whose it is)', async () => {
    downloaded('p1', session(), undefined);
    mountToday();
    await screen.findByText(LOAD_ERROR);
  });

  test('a corrupt downloaded session is ignored: the error state shows', async () => {
    localStorage.setItem('fc:last-player', 'p1');
    localStorage.setItem('fc:p1:session', '{"broken":');
    mountToday();
    await screen.findByText(LOAD_ERROR);
  });

  test('a server answer "not onboarded" (404) still redirects to /train/onboarding and shows no drill list', async () => {
    downloaded('p1');
    const env = mountToday({ todayStatus: 404 });
    await waitFor(() => expect(env.navigate).toHaveBeenCalled());
    expect(env.navigate.mock.calls[0]![0]).toBe('/train/onboarding');
    await settled(env);
    expect(screen.queryByRole('list', { name: todayMessages.en.list })).toBeNull();
  });

  test('a server failure (500, online) with a downloaded session shows the session and the notice too', async () => {
    downloaded('p1');
    mountToday({ todayStatus: 500 });
    await drillList();
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  test('a session that arrives later from the server replaces the device copy and the notice goes', async () => {
    downloaded('p1');
    const env = mountToday();
    await drillList();
    expect(screen.getByText(STALE)).toBeTruthy();
    env.queryClient.setQueryData(['today'], session('fresh-session'));
    await waitFor(() => expect(screen.queryByText(STALE)).toBeNull());
  });
});

// --- /train/drill/<itemId> --------------------------------------------------------------------------------------------------------

describe('/train/drill/<itemId>, cold reload offline', () => {
  const expectEveryDrillText = () => {
    expect(screen.getAllByText('Cone slalom').length).toBeGreaterThan(0); // title
    expect(screen.getByText('Keep the ball close through every cone.')).toBeTruthy(); // goal
    expect(screen.getByText('Set five cones in a line.')).toBeTruthy(); // steps
    expect(screen.getByText('Dribble through them with small touches.')).toBeTruthy();
    expect(screen.getByText('Looking only at the ball.')).toBeTruthy(); // mistakes
    expect(screen.getByText('Kicking the ball too far ahead.')).toBeTruthy();
    expect(screen.getByText('Use only your weaker foot.')).toBeTruthy(); // progression
    expect(screen.getByText('Use three cones, not five.')).toBeTruthy(); // regression
    expect(screen.getByText('Cones')).toBeTruthy(); // conditions: equipment, space, age
    expect(screen.getByText('Yard, Field')).toBeTruthy();
    expect(screen.getByText('Ages 8 to 12')).toBeTruthy();
    expect(screen.getByText('Check the ground for holes and stones.')).toBeTruthy(); // safety
    expect(screen.getByText('Stop straight away if something hurts.')).toBeTruthy();
  };

  test('the downloaded session of the last player renders ALL the drill text, with no load error', async () => {
    downloaded('p1');
    await mountDrill('item-2');
    await screen.findByText('Keep the ball close through every cone.');
    expectEveryDrillText();
    expect(screen.queryByText(DRILL_LOAD_ERROR)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test("the downloaded session is put into the ['today'] cache (Done and the other drills work from it)", async () => {
    downloaded('p1');
    const env = await mountDrill('item-2');
    await screen.findByText('Keep the ball close through every cone.');
    expect(env.queryClient.getQueryData<{ id: string }>(['today'])?.id).toBe('session-1');
  });

  test('the persisted query cache, restored AFTER the failed request, renders all the drill text', async () => {
    await mountDrill('item-2', { restore: persistedCache(session()) });
    await screen.findByText('Keep the ball close through every cone.');
    expectEveryDrillText();
    expect(screen.queryByText(DRILL_LOAD_ERROR)).toBeNull();
  });

  test('nothing on the device: the existing error state stays', async () => {
    const env = await mountDrill('item-2');
    await screen.findByText(DRILL_LOAD_ERROR);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    await settled(env);
    expect(screen.queryByText('Keep the ball close through every cone.')).toBeNull();
  });

  test('a drill that is not in the downloaded session shows "not found", not the load error', async () => {
    downloaded('p1');
    await mountDrill('item-99');
    await screen.findByText(drillMessages.en.notFound.title);
    expect(screen.queryByText(DRILL_LOAD_ERROR)).toBeNull();
  });

  test('a session downloaded by ANOTHER player is never used', async () => {
    downloaded('p2', session('other-session'), 'p1');
    await mountDrill('item-2');
    await screen.findByText(DRILL_LOAD_ERROR);
  });

  test('a server answer "not onboarded" (404) still redirects', async () => {
    downloaded('p1');
    const env = await mountDrill('item-2', { todayStatus: 404 });
    await waitFor(() => expect(env.navigate).toHaveBeenCalled());
    expect(env.navigate.mock.calls[0]![0]).toBe('/train/onboarding');
    expect(screen.queryByText('Keep the ball close through every cone.')).toBeNull();
  });
});
