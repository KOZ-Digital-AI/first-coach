import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Consents, DEFAULT_CONSENTS } from '@api-types/privacy';
import {
  type CreateVideoAnalysisRequest,
  type CreateVideoAnalysisResponse,
  Keyframe,
  Rubric,
  VideoAnalysis,
  VideoAnalysisList,
} from '@api-types/video';
import { dehydrate, focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { ApiProblem } from '../../lib/problem';
import { extractFeatures, type PoseFrame } from '../../video/features';
import messages from './capture.messages';
import resultMessages from './result.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as the other web tests do (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the routes only now, after happy-dom is registered.
const { Route, VideoDepsContext } = await import('../../routes/video');
const { Route: ResultRoute } = await import('../../routes/video/result.$id');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare with === and assert on the boolean instead.

/*
 * The capture screen hands its answer over to the result screen (fc-mol-8nt.12, bug found by the 8nt.10 generator: nothing led to
 * /video/result/:id). Written from the acceptance criteria:
 *  - a successful analysis invalidates ['video','analyses'] and navigates to /video/result/<analysis.id> instead of rendering the
 *    result inline;
 *  - a rerecord answer (the server's, or the device's own "not seen well enough") navigates to
 *    /video/result/<id or 'rerecord'>?rerecord=<low_visibility|too_dark|too_short>&skill=<slug> instead of the inline rerecord view;
 *  - the consent gate, the send-time consent re-check, and the privacy behaviour (nothing persisted, the clip and the pictures
 *    released BEFORE navigating, the camera stopped) are unchanged.
 * Two levels. The seam level replaces the router's navigate with a mock (the route takes it through VideoDepsContext, like its
 * other on-device seams), which lets a test look at the state of the world AT the moment of the navigation. The router level
 * mounts the capture route AND the real result route in one memory router, without the seam, and follows the player all the way:
 * that is what proves the target really exists and reads what the capture screen hands over (the missing entry point).
 * Real data goes through the real typed client and React Query; the stand-ins are the network (globalThis.fetch) and the on-device
 * seams (pose, clip, keyframes, camera). Fixtures are parsed with the shared contract schemas.
 * Reading of the criteria: a rerecord answer has no stored analysis (hence no id): its path segment is the literal 'rerecord'.
 */

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------------

const AT = '2026-09-22T10:00:00.000Z';
const RUBRIC = Rubric.parse({
  skill: 'dribbling',
  version: 2,
  criteria: [
    { key: 'body-position', label: 'Body position', description: 'You stay relaxed over the ball.', lookFor: ['Knees slightly bent.'] },
    { key: 'touch-rhythm', label: 'Touch rhythm', description: 'Small, steady touches.', lookFor: ['Touches are evenly spaced.'] },
  ],
  recordingTips: ['Put the phone on the ground, leaning on a bottle.', 'Keep your whole body in the picture.'],
  minVisibility: 0.6,
});
const GRANTED = Consents.parse({ ...DEFAULT_CONSENTS, videoAnalysis: { granted: true, at: AT, guardianConfirmed: true } });

function person(index: number, visibility: number) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  const phase = index * 0.9;
  landmarks[0] = { x: 0.53, y: 0.15, z: 0, visibility };
  landmarks[11] = { x: 0.45, y: 0.3, z: 0, visibility };
  landmarks[12] = { x: 0.55, y: 0.3, z: 0, visibility };
  landmarks[23] = { x: 0.46, y: 0.55, z: 0, visibility };
  landmarks[24] = { x: 0.54, y: 0.55, z: 0, visibility };
  landmarks[25] = { x: 0.4, y: 0.72, z: 0, visibility };
  landmarks[26] = { x: 0.6, y: 0.72, z: 0, visibility };
  landmarks[27] = { x: 0.44, y: 0.9 - Math.max(0, Math.sin(phase)) * 0.06, z: 0, visibility };
  landmarks[28] = { x: 0.56, y: 0.9 - Math.max(0, -Math.sin(phase)) * 0.06, z: 0, visibility };
  return landmarks;
}
const framesOf = (visibility: number): PoseFrame[] =>
  Array.from({ length: 60 }, (_, index) => ({ timeMs: (index * 1000) / 6, landmarks: index === 5 || index === 6 ? [] : person(index, visibility) }));
const VIDEO_SIZE = { videoWidth: 720, videoHeight: 1280 } as const;
// Sanity: the fixture is something the real feature extractor accepts (a bad fixture would make every test below meaningless).
if (extractFeatures(framesOf(0.9), { aspectRatio: 720 / 1280 }) === null) throw new Error('fixture frames are not usable');

const KEYFRAME_MARKER = '/9j/';
const KEYFRAMES = Array.from({ length: 5 }, (_, index) =>
  Keyframe.parse({ mimeType: 'image/jpeg', data: `${KEYFRAME_MARKER}${`AAA${'ABCDE'[index]}`.repeat(30)}`, width: 288, height: 512 }),
);

const ANALYSIS = VideoAnalysis.parse({
  id: 'analysis-7',
  skillSlug: 'dribbling',
  createdAt: AT,
  beta: true,
  confidence: 'medium',
  scores: [
    { key: 'body-position', label: 'Body position', score: 7, note: 'Your knees stayed nicely bent.' },
    { key: 'touch-rhythm', label: 'Touch rhythm', score: 4, note: 'The touches got uneven near the end.' },
  ],
  focusNext: 'Keep the touches evenly spaced.',
  recommended: [{ drillVersionId: 'first-touch-box-v1', slug: 'first-touch-box', title: 'First Touch Box', reason: 'Trains even touches.' }],
  repeatAfterSessions: 3,
  limitations: ['One clip from one angle cannot show everything.'],
});

// --- the network (test data only) ---------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

type Call = { method: string; path: string; body: unknown };
type Server = { consents?: () => Response | Promise<Response>; rubric?: () => Response | Promise<Response> };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let consentsHeld: Consents = GRANTED;

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body });
    if (url.pathname === '/api/player/consents') return (server.consents ?? (() => json(consentsHeld)))();
    const rubric = /^\/api\/video\/rubrics\/([^/]+)$/.exec(url.pathname);
    if (rubric !== null && method === 'GET') return (server.rubric ?? (() => json({ ...RUBRIC, skill: rubric[1] })))();
    // The history the result screen reads: it holds the analysis the capture screen "just made".
    if (url.pathname === '/api/player/video-analyses' && method === 'GET') return json(VideoAnalysisList.parse([ANALYSIS]));
    if (url.pathname === '/api/player/video-analyses' && method === 'POST') return json(ANALYSIS);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}
const callsTo = (path: string, method = 'GET') => calls.filter((call) => call.path === path && call.method === method);

// --- the on-device seams (fakes) -------------------------------------------------------------------------------------------

type FakeBlob = File & { fakeDurationSec: number };
const clipOf = (seconds: number, type = 'video/mp4'): FakeBlob =>
  Object.assign(new File(['not really a video'], 'clip.mp4', { type }), { fakeDurationSec: seconds });

type ResultTarget = { id: string; search?: { rerecord: string; skill: string } };
/** What the world looked like at the instant the screen navigated (the privacy ordering is asserted on it). */
type Snapshot = { target: ResultTarget; clipsReleased: number; clipsTotal: number; sessionsReleased: number; sessionsTotal: number; invalidated: boolean | null };

let t = 0;
const clock = { now: () => t, pollMs: 4 };
const advance = (ms: number) => {
  t += ms;
};

const queryClients: QueryClient[] = [];
let holder: { queryClient?: QueryClient } = {};

function makeWorld(over: Record<string, unknown> = {}, navigate?: (target: ResultTarget) => unknown) {
  const clips: { release: ReturnType<typeof mock> }[] = [];
  const sessions: { release: ReturnType<typeof mock>; stop: ReturnType<typeof mock> }[] = [];
  const snapshots: Snapshot[] = [];
  const pose = {
    load: mock(async () => {}),
    detectOnVideo: mock(async (_video: unknown, _fps?: number, onProgress?: (fraction: number) => void) => {
      onProgress?.(1);
      return framesOf(0.9);
    }),
  };
  const analyse = mock(async (_request: CreateVideoAnalysisRequest, _signal: AbortSignal): Promise<CreateVideoAnalysisResponse> => ANALYSIS);
  const navigateMock = mock((target: ResultTarget) => {
    snapshots.push({
      target,
      clipsReleased: clips.filter((clip) => clip.release.mock.calls.length > 0).length,
      clipsTotal: clips.length,
      sessionsReleased: sessions.filter((session) => session.release.mock.calls.length > 0).length,
      sessionsTotal: sessions.length,
      invalidated: holder.queryClient?.getQueryState(['video', 'analyses'])?.isInvalidated ?? null,
    });
    return navigate?.(target);
  });
  const deps = {
    pose,
    loadClip: mock(async (blob: Blob) => {
      const seconds = (blob as FakeBlob).fakeDurationSec;
      const clip = {
        video: { duration: seconds, currentTime: 0, ...VIDEO_SIZE, addEventListener() {}, removeEventListener() {} },
        durationSec: seconds,
        release: mock(() => {}),
      };
      clips.push(clip);
      return clip;
    }),
    sampleKeyframes: mock(async (_video: unknown, _frames: unknown, n: number) => KEYFRAMES.slice(0, n)),
    analyse,
    camera: {
      open: mock(async () => {
        const session = { stream: null, start: mock(() => {}), stop: mock(async () => clipOf(12, 'video/webm')), release: mock(() => {}) };
        sessions.push(session);
        return session;
      }),
    },
    online: () => true,
    canDetectPose: () => true,
    clock,
    seekTimeoutMs: 40,
    analyseTimeoutMs: 5000,
    ...over,
  };
  return { deps: { ...deps, navigate: navigateMock }, pose, clips, sessions, snapshots, analyse: deps.analyse as typeof analyse, navigate: navigateMock };
}
type World = ReturnType<typeof makeWorld>;

beforeEach(() => {
  t = 0;
  consentsHeld = GRANTED;
  holder = {};
  stubNetwork();
});
// Cross-file hygiene. bun runs every web test file in ONE process with ONE happy-dom window; happy-dom never trims the lists in which
// it records every element query it has answered (see features/contribute/form.test.tsx), and a heavy Testing Library file leaves
// thousands of entries that slow the files that run after it. After every test the DOM is empty: invalidate and clear the lists.
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
afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------------------------------

const modules = {
  './capture.messages.ts': { default: messages },
  './result.messages.ts': { default: resultMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const VideoPage = Route.options.component as () => ReactNode;

function newI18n() {
  return createI18n({ modules, languages: ['en'], storage: noStorage, root: { lang: '' }, dev: false });
}
function newClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  queryClients.push(queryClient);
  holder.queryClient = queryClient;
  return queryClient;
}

/** The capture screen alone, its navigation replaced by the world's mock. */
function renderCapture(world: World = makeWorld()) {
  const queryClient = newClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={newI18n()}>
        <VideoDepsContext.Provider value={world.deps as never}>
          <VideoPage />
        </VideoDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, user: userEvent.setup(), queryClient, world };
}
type View = ReturnType<typeof renderCapture>;

/** The capture route and the REAL result route in one memory router; NO navigation seam: the screen uses the router. */
async function renderRouted(world: World = makeWorld()) {
  const { navigate: _seam, ...withoutSeam } = world.deps;
  const queryClient = newClient();
  const rootRoute = createRootRoute();
  const captureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/video', component: VideoPage });
  const resultRoute = ResultRoute.update({ id: '/video/result/$id', path: '/video/result/$id', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([captureRoute, resultRoute as never]),
    history: createMemoryHistory({ initialEntries: ['/video'] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={newI18n()}>
        <VideoDepsContext.Provider value={withoutSeam as never}>
          <RouterProvider router={router} />
        </VideoDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, user: userEvent.setup(), queryClient, world, router };
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const pageText = (): string => text(document.body);
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const findButton = (name: string | RegExp) => screen.findByRole('button', { name }) as Promise<HTMLButtonElement>;
const hasRole = (role: string, name: string | RegExp): boolean => screen.queryByRole(role as never, { name }) !== null;
const fileInput = () => screen.getByLabelText('Choose a video from this device') as HTMLInputElement;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const navigated = (world: World) => waitFor(() => expect(world.navigate).toHaveBeenCalled());
const lastTarget = (world: World): ResultTarget | undefined => world.navigate.mock.calls.at(-1)?.[0];

async function pickSkill(view: Pick<View, 'user'>, label = 'Analyse my dribbling') {
  await view.user.click(await findButton(label));
}
async function toCapture(view: Pick<View, 'user'>, label?: string) {
  await pickSkill(view, label);
  await heading('Record or choose a clip');
  await screen.findByText(RUBRIC.recordingTips[0] as string);
}
async function toReview(view: Pick<View, 'user'>, seconds = 14, label?: string) {
  await toCapture(view, label);
  await view.user.upload(fileInput(), clipOf(seconds));
  await heading('Ready to send?');
}

const everyStoredString = (): string[] => {
  const out: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index) as string;
      out.push(key, storage.getItem(key) ?? '');
    }
  }
  return out;
};
/** Nothing of the run may be in a storage, the query cache or the mutation cache: no picture, no answer with its scores. */
function expectNothingKept(queryClient: QueryClient): void {
  for (const stored of everyStoredString()) {
    expect(stored).not.toContain(KEYFRAME_MARKER);
    expect(stored).not.toContain(ANALYSIS.focusNext);
  }
  const cache = JSON.stringify(dehydrate(queryClient, { shouldDehydrateQuery: () => true }));
  expect(cache).not.toContain(KEYFRAME_MARKER);
  const mutations = JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.variables ?? null));
  expect(mutations).not.toContain(KEYFRAME_MARKER);
}

// --- a successful analysis ----------------------------------------------------------------------------------------------

describe('a successful analysis', () => {
  test('navigates to /video/result/<the analysis id>, once, and only after Send', async () => {
    const world = makeWorld({ analyse: mock(async () => ({ ...ANALYSIS, id: 'analysis-99' })) });
    const view = renderCapture(world);
    await toReview(view);
    expect(world.navigate).not.toHaveBeenCalled();
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(lastTarget(world)).toEqual({ id: 'analysis-99' });
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0); // `analyse` is the seam here: one call, the fake's
    expect(world.analyse).toHaveBeenCalledTimes(1);
  });

  test("invalidates ['video','analyses'] (the history the result screen reads) before it navigates", async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    view.queryClient.setQueryData(['video', 'analyses'], []); // an earlier visit to the result screen left it in the cache
    expect(view.queryClient.getQueryState(['video', 'analyses'])?.isInvalidated).toBe(false);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expect(view.queryClient.getQueryState(['video', 'analyses'])?.isInvalidated).toBe(true);
    expect(world.snapshots[0]?.invalidated).toBe(true); // already invalid at the instant of the navigation
  });

  test('renders nothing of the result itself: the scores, focus and drills belong to the result screen', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    const shown = pageText();
    for (const inline of [ANALYSIS.focusNext, 'Focus next', 'Drills to try', 'Analyse another clip']) expect(shown).not.toContain(inline);
    for (const score of ANALYSIS.scores) expect(shown).not.toContain(score.note);
    expect(screen.queryAllByRole('meter').length).toBe(0);
    expect(hasRole('link', 'First Touch Box')).toBe(false);
  });

  test('the rerecord search is NOT added to a finished analysis', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expect(lastTarget(world)?.search === undefined).toBe(true);
  });

  test('two taps in the same tick still navigate once', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    const send = button('Send for analysis');
    act(() => {
      send.click();
      send.click();
    });
    await navigated(world);
    expect(world.analyse).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledTimes(1);
  });

  test('a failed send navigates nowhere; Try again resends the same request and then navigates once', async () => {
    let fail = true;
    const world = makeWorld({
      analyse: mock(async () => {
        if (fail) throw new ApiProblem({ kind: 'network' });
        return ANALYSIS;
      }),
    });
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await screen.findByRole('alert');
    expect(world.navigate).not.toHaveBeenCalled();
    fail = false;
    await view.user.click(button('Try again'));
    await navigated(world);
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.analyse).toHaveBeenCalledTimes(2);
  });

  test('a send that is cancelled, or that is left by unmounting, navigates nowhere', async () => {
    const hang = () =>
      mock(
        (_request: unknown, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
    const cancelled = makeWorld({ analyse: hang() });
    const first = renderCapture(cancelled);
    await toReview(first);
    await first.user.click(button('Send for analysis'));
    await first.user.click(await findButton('Cancel sending'));
    await heading('Ready to send?');
    expect(cancelled.navigate).not.toHaveBeenCalled();
    first.unmount();

    const left = makeWorld({ analyse: hang() });
    const second = renderCapture(left);
    await toReview(second);
    await second.user.click(button('Send for analysis'));
    await screen.findByRole('status', { name: 'Sending and waiting for feedback' });
    second.unmount();
    expect(left.navigate).not.toHaveBeenCalled();
  });

  test('if the navigation itself fails the player is not left on a dead end and no picture stays on screen', async () => {
    const world = makeWorld({}, () => Promise.reject(new Error('navigation failed')));
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    await heading('Record or choose a clip');
    expect(screen.queryAllByRole('img').length).toBe(0);
  });
});

// --- a rerecord answer ------------------------------------------------------------------------------------------------------

describe('a rerecord answer', () => {
  test.each(['low_visibility', 'too_dark', 'too_short'] as const)(
    "from the server (%s): navigates to /video/result/rerecord?rerecord=<reason>&skill=<the chosen skill>, without touching the analyses history",
    async (reason) => {
      const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason })) });
      const view = renderCapture(world);
      view.queryClient.setQueryData(['video', 'analyses'], []);
      await toReview(view);
      await view.user.click(button('Send for analysis'));
      await navigated(world);
      expect(world.navigate).toHaveBeenCalledTimes(1);
      expect(lastTarget(world)).toEqual({ id: 'rerecord', search: { rerecord: reason, skill: 'dribbling' } });
      // nothing was stored by the server, so there is nothing new to read
      expect(view.queryClient.getQueryState(['video', 'analyses'])?.isInvalidated).toBe(false);
    },
  );

  test('the skill in the search is the one the player picked, not a fixed one', async () => {
    const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason: 'too_dark' })) });
    const view = renderCapture(world);
    await toReview(view, 14, 'Analyse my ball mastery');
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expect(lastTarget(world)).toEqual({ id: 'rerecord', search: { rerecord: 'too_dark', skill: 'ball-mastery' } });
    expect((world.analyse.mock.calls[0]?.[0] as CreateVideoAnalysisRequest).skillSlug).toBe('ball-mastery');
  });

  test('on the device (nobody seen well enough): navigates the same way, sends nothing, and the clip is already released', async () => {
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => framesOf(0.3));
    const view = renderCapture(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    await navigated(world);
    expect(lastTarget(world)).toEqual({ id: 'rerecord', search: { rerecord: 'low_visibility', skill: 'dribbling' } });
    expect(world.snapshots[0]?.clipsTotal).toBe(1);
    expect(world.snapshots[0]?.clipsReleased).toBe(1);
    expect(world.analyse).not.toHaveBeenCalled();
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0);
  });

  test('a clip the coach could see is NOT a rerecord: no navigation until the player has looked at the pictures and sent them', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(hasRole('button', 'Send for analysis')).toBe(true);
  });
});

// --- privacy: what must still hold when the screen hands over (risk:privacy) -------------------------------------------------

describe('privacy is unchanged by the hand-over', () => {
  test('the clip and the camera are released BEFORE the screen navigates, on the record path too', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    act(() => advance(3000));
    await findButton('Stop recording');
    act(() => advance(11000));
    await view.user.click(button('Stop recording'));
    await heading('Ready to send?');
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    const snapshot = world.snapshots[0] as Snapshot;
    expect(snapshot.sessionsTotal).toBe(1);
    expect(snapshot.sessionsReleased).toBe(1); // the camera is stopped
    expect(snapshot.clipsTotal).toBe(1);
    expect(snapshot.clipsReleased).toBe(1); // the clip (and with it its object URL) is freed
    expect(world.sessions[0]?.stop).toHaveBeenCalledTimes(1);
  });

  test('once the screen has navigated no picture is on it (nor anywhere in the page)', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    expect(screen.queryAllByRole('img').length).toBe(KEYFRAMES.length);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    await waitFor(() => expect(screen.queryAllByRole('img').length).toBe(0));
    expect(document.body.innerHTML).not.toContain('data:image');
    expect(document.body.innerHTML).not.toContain(KEYFRAME_MARKER);
    expect(hasRole('button', 'Send for analysis')).toBe(false);
  });

  test('nothing of the run (pictures, the answer with its scores) is in a storage, the query cache or the mutation cache', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expectNothingKept(view.queryClient);
    // in particular the answer is not put into the cache by the capture screen: the result screen reads it from the server
    expect(JSON.stringify(dehydrate(view.queryClient, { shouldDehydrateQuery: () => true }))).not.toContain(ANALYSIS.id);
  });

  test('a rerecord answer leaves nothing behind either', async () => {
    const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason: 'too_dark' })) });
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expectNothingKept(view.queryClient);
  });

  test('the consent is read fresh right before the send; revoked meanwhile: nothing is sent, nothing navigates, the gate is shown', async () => {
    const world = makeWorld();
    const view = renderCapture(world);
    await toReview(view);
    const readsBefore = callsTo('/api/player/consents').length;
    consentsHeld = DEFAULT_CONSENTS;
    await view.user.click(button('Send for analysis'));
    await heading('Before you start');
    expect(callsTo('/api/player/consents').length).toBeGreaterThan(readsBefore);
    expect(world.analyse).not.toHaveBeenCalled();
    expect(world.navigate).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('img').length).toBe(0);
  });

  test('a consent that is still granted at send time is read again first, then the send goes ahead and navigates', async () => {
    let readsWhenSent = -1;
    const world = makeWorld({
      analyse: mock(async () => {
        readsWhenSent = callsTo('/api/player/consents').length;
        return ANALYSIS;
      }),
    });
    const view = renderCapture(world);
    await toReview(view);
    const readsBefore = callsTo('/api/player/consents').length;
    await view.user.click(button('Send for analysis'));
    await navigated(world);
    expect(readsWhenSent).toBeGreaterThan(readsBefore);
    expect(world.navigate).toHaveBeenCalledTimes(1);
  });

  test('the server refusing with "consent required" returns to the gate and navigates nowhere', async () => {
    const world = makeWorld({
      analyse: mock(async () => {
        consentsHeld = DEFAULT_CONSENTS;
        throw new ApiProblem({
          kind: 'forbidden',
          status: 403,
          problem: { type: 'about:blank', title: 'consent required', status: 403, errors: [] },
        });
      }),
    });
    const view = renderCapture(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading('Before you start');
    expect(world.navigate).not.toHaveBeenCalled();
  });

  test('without the consent the gate comes first: nothing is loaded, recorded or navigated', async () => {
    consentsHeld = DEFAULT_CONSENTS;
    const world = makeWorld();
    const view = renderCapture(world);
    await pickSkill(view);
    await heading('Before you start');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(world.pose.load).not.toHaveBeenCalled();
    expect(world.deps.camera.open).not.toHaveBeenCalled();
    expect(world.navigate).not.toHaveBeenCalled();
  });
});

// --- through a real router: the entry point to the result screen exists ------------------------------------------------------

describe('through a real router (no seam)', () => {
  test('a successful analysis lands on /video/result/<id> and the result screen shows it; the capture screen is gone', async () => {
    const view = await renderRouted();
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading(/your analysis/i);
    expect(view.router.state.location.pathname).toBe('/video/result/analysis-7');
    expect(view.router.state.location.search).toEqual({});
    // the result screen's own content, read from the history by id
    expect(await screen.findAllByRole('meter')).toHaveLength(2);
    expect(pageText()).toContain(ANALYSIS.focusNext);
    expect(callsTo('/api/player/video-analyses', 'GET').length).toBeGreaterThanOrEqual(1);
    expect(hasRole('heading', 'Record or choose a clip')).toBe(false);
    expect(hasRole('button', 'Send for analysis')).toBe(false);
    expect(view.world.analyse).toHaveBeenCalledTimes(1);
    expectNothingKept(view.queryClient);
    expect(document.body.innerHTML).not.toContain(KEYFRAME_MARKER);
  });

  test('a rerecord answer from the server lands on the re-record variant of the result screen, with the tips of the skill', async () => {
    const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason: 'too_dark' })) });
    const view = await renderRouted(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading(new RegExp(resultMessages.en.rerecord.too_dark.title, 'i'));
    expect(view.router.state.location.pathname).toBe('/video/result/rerecord');
    expect(view.router.state.location.search).toEqual({ rerecord: 'too_dark', skill: 'dribbling' });
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
    expect(screen.queryAllByRole('meter').length).toBe(0);
    expect(hasRole('heading', 'Record or choose a clip')).toBe(false);
    expectNothingKept(view.queryClient);
  });

  test('the device\'s own "not seen well enough" lands on the same variant, having sent nothing', async () => {
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => framesOf(0.3));
    const view = await renderRouted(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    await heading(new RegExp(resultMessages.en.rerecord.low_visibility.title, 'i'));
    expect(view.router.state.location.pathname).toBe('/video/result/rerecord');
    expect(view.router.state.location.search).toEqual({ rerecord: 'low_visibility', skill: 'dribbling' });
    expect(world.analyse).not.toHaveBeenCalled();
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0);
    expect(world.clips[0]?.release).toHaveBeenCalled();
  });

  test('the chosen skill travels in the search of the re-record variant (and its tips are asked for that skill)', async () => {
    const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason: 'too_short' })) });
    const view = await renderRouted(world);
    await toReview(view, 14, 'Analyse my ball mastery');
    await view.user.click(button('Send for analysis'));
    await heading(new RegExp(resultMessages.en.rerecord.too_short.title, 'i'));
    expect(view.router.state.location.search).toEqual({ rerecord: 'too_short', skill: 'ball-mastery' });
    await waitFor(() => expect(calls.some((call) => call.path === '/api/video/rubrics/ball-mastery')).toBe(true));
  });
});
