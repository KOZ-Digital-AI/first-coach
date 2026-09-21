import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { StartResponse } from '@api-types/onboarding';
import type { PlayerProfile, Roadmap } from '@api-types/domain';
import { Consents, DEFAULT_CONSENTS } from '@api-types/privacy';
import {
  CreateVideoAnalysisRequest,
  type CreateVideoAnalysisResponse,
  Keyframe,
  Rubric,
  VideoAnalysis,
} from '@api-types/video';
import { dehydrate, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { ApiProblem } from '../../lib/problem';
import { PERSISTED_QUERY_PREFIXES, persistAppQueryClient, type PersistStore } from '../../lib/query-persist';
import { extractFeatures, type PoseFrame } from '../../video/features';
import { PoseError } from '../../video/pose';
import messages from './capture.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as drills.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the route only now, after happy-dom is registered.
const { Route, VideoDepsContext } = await import('../../routes/video');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * The Video Coach capture screen (/video), written from the acceptance criteria of fc-mol-8nt.9 (risk:privacy, ui):
 *  - the player picks a skill ("Analyse my dribbling") and reads the recording tips of the rubric (GET /api/video/rubrics/:skill);
 *  - WITHOUT videoAnalysis consent the consent step comes first (plain disclosure that still pictures go to an AI provider; under
 *    13 a guardian must have confirmed) and it links to the privacy settings: the screen never proceeds until the server says
 *    the consent (and, under 13, the guardian) is there;
 *  - the player records with the device camera (MediaRecorder, 10-30 s, a countdown first) or chooses an existing clip; a clip
 *    shorter than 10 s or longer than 30 s is rejected with guidance;
 *  - everything happens on the device with a progress bar and a cancel button; the clip is NEVER uploaded, is released from memory
 *    afterwards and nothing (clip, frames, results) is persisted: only keyframes + pose features are sent;
 *  - the setting that switches the feature off, a device that cannot run pose detection, and being offline are said in words;
 *    the feature is optional and never blocks training; loading, empty, error, disabled and success states; mutation buttons
 *    are disabled while the request is in flight; every string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query; the stand-ins are the network (globalThis.fetch: a
 * small fake of the server), and the four on-device seams the route lets a test replace through VideoDepsContext (no real
 * MediaPipe, camera or canvas exists under bun): pose, loadClip, sampleKeyframes, camera. The analysis call is one small
 * injectable function (`analyse`), because its endpoint (fc-mol-8nt.5) is built concurrently; one test leaves it out and checks
 * the default request against the shared contract. Fixtures are parsed with the shared contract schemas.
 *
 * Readings of the criteria that these tests pin (the simplest reading each time, see the route's header for the rest):
 *  - the pick list is the five skills that have a rubric in the seed (there is no endpoint that lists rubrics);
 *  - the analysis is sent only after the player has SEEN what leaves the device (a review step with the keyframes) and taps Send;
 *  - "10-30 s" is checked on the clip itself (its measured duration, both limits inclusive); a recording stops itself before
 *    the upper limit and cannot be stopped before the lower one, so a MediaRecorder's timing error never breaks a limit;
 *  - a clip in which the player is not seen well enough (mean visibility below the rubric's minVisibility) is answered on the
 *    device with the 'rerecord' hint and NOTHING is sent;
 *  - the setting `videoCoachEnabled` has no public endpoint: it shows as a 403 from the analysis that is not 'consent required'.
 * Kazakh and Russian copy needs a native review: for those locales the tests pin only that text exists, is Cyrillic and never
 * leaks 'undefined', 'NaN', a raw key or an unfilled {{placeholder}}.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------------

const RUBRIC = Rubric.parse({
  skill: 'dribbling',
  version: 2,
  criteria: [
    {
      key: 'body-position',
      label: 'Body position',
      description: 'You stay relaxed over the ball.',
      lookFor: ['Knees slightly bent.'],
    },
    { key: 'touch-rhythm', label: 'Touch rhythm', description: 'Small, steady touches.', lookFor: ['Touches are evenly spaced.'] },
  ],
  recordingTips: ['Put the phone on the ground, leaning on a bottle.', 'Keep your whole body in the picture.'],
  minVisibility: 0.6,
});

const AT = '2026-09-22T10:00:00.000Z';
const consentsWith = (extra: Record<string, unknown> = {}) =>
  Consents.parse({ ...DEFAULT_CONSENTS, videoAnalysis: { granted: true, at: AT, ...extra } });
/** Consent given by a guardian: the gate is open whatever the age. */
const GRANTED_WITH_GUARDIAN = consentsWith({ guardianConfirmed: true });
/** Consent without a guardian: fine from 13, not below. */
const GRANTED_ALONE = consentsWith();

const profileOfAge = (age: number): PlayerProfile => ({
  age,
  level: 'basic',
  goal: 'control',
  equipment: 'ball',
  space: 'yard',
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: 'en',
});
const ROADMAP: Roadmap = {
  currentLevelLabel: 'Basic',
  tracks: [
    { skill: 'ball-mastery', level: 2, source: 'test' },
    { skill: 'dribbling', level: 3, source: 'self' },
    { skill: 'weak-foot', level: 1, source: 'self' },
  ],
  goal: 'control',
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'goal' },
    { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
  ],
};
const meOfAge = (age: number) => StartResponse.parse({ profile: profileOfAge(age), roadmap: ROADMAP });

/** A person doing a dribbling drill: 33 landmarks (MediaPipe order), knees bent, ankles taking turns to lift. */
function person(index: number, visibility: number) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  const phase = index * 0.9;
  const leftLift = Math.max(0, Math.sin(phase)) * 0.06;
  const rightLift = Math.max(0, -Math.sin(phase)) * 0.06;
  landmarks[0] = { x: 0.53, y: 0.15, z: 0, visibility };
  landmarks[11] = { x: 0.45, y: 0.3, z: 0, visibility };
  landmarks[12] = { x: 0.55, y: 0.3, z: 0, visibility };
  landmarks[23] = { x: 0.46, y: 0.55, z: 0, visibility };
  landmarks[24] = { x: 0.54, y: 0.55, z: 0, visibility };
  landmarks[25] = { x: 0.4, y: 0.72, z: 0, visibility };
  landmarks[26] = { x: 0.6, y: 0.72, z: 0, visibility };
  landmarks[27] = { x: 0.44, y: 0.9 - leftLift, z: 0, visibility };
  landmarks[28] = { x: 0.56, y: 0.9 - rightLift, z: 0, visibility };
  return landmarks;
}

/** 60 frames at 6 fps (a 10 s clip); two of them have nobody in them (landmarks: []), as the real detector reports it. */
const framesOf = (visibility: number): PoseFrame[] =>
  Array.from({ length: 60 }, (_, index) => ({
    timeMs: (index * 1000) / 6,
    landmarks: index === 5 || index === 6 ? [] : person(index, visibility),
  }));
const FRAMES = framesOf(0.9);
const NOBODY: PoseFrame[] = FRAMES.map((frame) => ({ timeMs: frame.timeMs, landmarks: [] }));
const VIDEO_SIZE = { videoWidth: 720, videoHeight: 1280 } as const;

/** Five valid keyframes (bare base64, JPEG marker, padded), each distinct so a test can tell them apart. */
const KEYFRAMES = Array.from({ length: 5 }, (_, index) =>
  Keyframe.parse({ mimeType: 'image/jpeg', data: `/9j/${`AAA${'ABCDE'[index]}`.repeat(30)}`, width: 288, height: 512 }),
);

const ANALYSIS = VideoAnalysis.parse({
  id: 'analysis-1',
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
const problem = (status: number, title = 'Problem') =>
  json({ type: 'about:blank', title, status, detail: 'Server text that must not be shown', errors: [] }, status, 'application/problem+json');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Call = { method: string; path: string; search: string; headers: Headers; body: unknown };
type Answer = () => Response | Promise<Response>;
type Server = { consents?: Answer; me?: Answer; rubric?: Answer; analysis?: Answer };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let consentsHeld: Consents = GRANTED_WITH_GUARDIAN;

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    });
    if (url.pathname === '/api/player/consents') return (server.consents ?? (() => json(consentsHeld)))();
    if (url.pathname === '/api/player/me') return (server.me ?? (() => json(meOfAge(9))))();
    const rubric = /^\/api\/video\/rubrics\/([^/]+)$/.exec(url.pathname);
    if (rubric !== null && method === 'GET') {
      if (server.rubric !== undefined) return server.rubric();
      return rubric[1] === 'dribbling' ? json(RUBRIC) : problem(404);
    }
    if (url.pathname === '/api/player/video-analyses' && method === 'POST') return (server.analysis ?? (() => json(ANALYSIS)))();
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const callsTo = (path: string, method = 'GET') => calls.filter((call) => call.path === path && call.method === method);
const rubricCalls = () => calls.filter((call) => call.path.startsWith('/api/video/rubrics/'));

// --- the on-device seams (fakes) -------------------------------------------------------------------------------------------

/** A stand-in for a video file: the fake `loadClip` reads the duration off it (nothing under bun can decode a video). */
type FakeBlob = File & { fakeDurationSec: number };
function clipOf(seconds: number, type = 'video/mp4'): FakeBlob {
  return Object.assign(new File(['not really a video'], 'clip.mp4', { type }), { fakeDurationSec: seconds });
}

type FakeClip = { video: object; durationSec: number; release: ReturnType<typeof mock> };
type FakeSession = { stream: null; start: ReturnType<typeof mock>; stop: ReturnType<typeof mock>; release: ReturnType<typeof mock> };

/** The clock the recording reads, driven by the test: `t` only moves when the test says so. */
let t = 0;
const clock = { now: () => t, pollMs: 4 };
const advance = (ms: number) => {
  t += ms;
};

function makeWorld(over: Record<string, unknown> = {}) {
  const clips: FakeClip[] = [];
  const sessions: FakeSession[] = [];
  const detectGate = { current: undefined as Promise<void> | undefined };
  const pose = {
    load: mock(async () => {}),
    detectOnVideo: mock(async (_video: unknown, _fps?: number, onProgress?: (fraction: number) => void) => {
      onProgress?.(0.5);
      if (detectGate.current !== undefined) await detectGate.current;
      onProgress?.(1);
      return FRAMES;
    }),
  };
  const sampleKeyframes = mock(async (_video: unknown, _frames: unknown, n: number, _deps?: unknown) => KEYFRAMES.slice(0, n));
  const analyse = mock(async (_request: CreateVideoAnalysisRequest, _signal: AbortSignal): Promise<CreateVideoAnalysisResponse> => ANALYSIS);
  const loadClip = mock(async (blob: Blob) => {
    const clip: FakeClip = {
      video: { duration: (blob as FakeBlob).fakeDurationSec, currentTime: 0, ...VIDEO_SIZE, addEventListener() {}, removeEventListener() {} },
      durationSec: (blob as FakeBlob).fakeDurationSec,
      release: mock(() => {}),
    };
    clips.push(clip);
    return clip;
  });
  const camera = {
    open: mock(async () => {
      const session: FakeSession = {
        stream: null,
        start: mock(() => {}),
        stop: mock(async () => clipOf(12, 'video/webm')),
        release: mock(() => {}),
      };
      sessions.push(session);
      return session;
    }),
  };
  const deps = {
    pose,
    loadClip,
    sampleKeyframes,
    analyse,
    camera,
    online: () => true,
    canDetectPose: () => true,
    clock,
    seekTimeoutMs: 40,
    analyseTimeoutMs: 5000,
    ...over,
  };
  // The effective fakes: a test may replace one through `over`, and its assertions must read the one that ran.
  return {
    deps,
    pose,
    camera,
    clips,
    sessions,
    detectGate,
    sampleKeyframes: deps.sampleKeyframes as typeof sampleKeyframes,
    analyse: deps.analyse as typeof analyse,
    loadClip: deps.loadClip as typeof loadClip,
  };
}
type World = ReturnType<typeof makeWorld>;

beforeEach(() => {
  t = 0;
  consentsHeld = GRANTED_WITH_GUARDIAN;
  stubNetwork();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  // React Query listens to window 'offline' (the offline tests fire it) and would keep every later query paused.
  onlineManager.setOnline(true);
});

// --- rendering ----------------------------------------------------------------------------------------------------------

const modules = { './capture.messages.ts': { default: messages }, '../../lib/problem.messages.ts': { default: problemMessages } };
const noStorage = { getItem: () => null, setItem: () => {} };
const VideoPage = Route.options.component as () => ReactNode;

function renderVideo(world: World = makeWorld(), locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <VideoDepsContext.Provider value={world.deps as never}>
          <VideoPage />
        </VideoDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, user, instance, queryClient, world };
}
type View = ReturnType<typeof renderVideo>;

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const pageText = (): string => text(document.body);
const LEAKS = ['undefined', 'NaN', 'null', '{{', '[object'];
const hasRole = (role: string, name: string | RegExp): boolean => screen.queryByRole(role as never, { name }) !== null;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const findButton = (name: string | RegExp) => screen.findByRole('button', { name }) as Promise<HTMLButtonElement>;
const fileInput = () => screen.getByLabelText('Choose a video from this device') as HTMLInputElement;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

async function pickSkill(view: View, label = 'Analyse my dribbling') {
  await view.user.click(await findButton(label));
}

/** Picks the skill and waits for the capture step (consent already granted, rubric loaded). */
async function toCapture(view: View) {
  await pickSkill(view);
  await heading('Record or choose a clip');
  await screen.findByText(RUBRIC.recordingTips[0] as string);
}

/** The whole happy path up to the review step, with a chosen clip of `seconds`. */
async function toReview(view: View, seconds = 14) {
  await toCapture(view);
  await view.user.upload(fileInput(), clipOf(seconds));
  await heading('Ready to send?');
}

// --- the skill pick -----------------------------------------------------------------------------------------------------

describe('the skill pick', () => {
  test('opens with the beta title, one choice per skill, and asks the server for nothing yet', async () => {
    renderVideo();
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(pageText()).toContain('Video Coach · Beta');
    for (const label of [
      'Analyse my dribbling',
      'Analyse my ball mastery',
      'Analyse my passing and first touch',
      'Analyse my weaker foot',
      'Analyse my juggling',
    ]) {
      expect(hasRole('button', label)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test('every skill button is a 44px tap target', async () => {
    renderVideo();
    const options = await screen.findAllByRole('button', { name: /^Analyse my / });
    expect(options.length).toBe(5);
    for (const option of options) expect(option.className).toContain('min-h-tap');
  });

  test('is optional: the page always offers the way back to training', async () => {
    renderVideo();
    const link = (await screen.findByRole('link', { name: 'Back to training' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/train');
  });

  test('picking a skill shows it with a way to change it, and Change skill goes back to the list', async () => {
    const view = renderVideo();
    await toCapture(view);
    expect(pageText()).toContain('Dribbling');
    expect(hasRole('button', 'Analyse my ball mastery')).toBe(false);
    await view.user.click(button('Change skill'));
    expect(await findButton('Analyse my ball mastery')).toBeTruthy();
  });
});

// --- the recording tips (rubric) -------------------------------------------------------------------------------------------

describe('the rubric', () => {
  test('one GET for the picked skill in the active language; its recording tips and criteria are on screen', async () => {
    const view = renderVideo();
    await toCapture(view);
    expect(rubricCalls()).toHaveLength(1);
    expect(rubricCalls()[0]?.path).toBe('/api/video/rubrics/dribbling');
    expect(new URLSearchParams(rubricCalls()[0]?.search).get('locale')).toBe('en');
    for (const tip of RUBRIC.recordingTips) expect(pageText()).toContain(tip);
    for (const criterion of RUBRIC.criteria) expect(pageText()).toContain(criterion.label);
    expect(pageText()).toContain('10 to 30 seconds');
  });

  test('shows a busy, named status while the tips load', async () => {
    const gate = deferred<Response>();
    stubNetwork({ rubric: () => gate.promise });
    const view = renderVideo();
    await pickSkill(view);
    const busy = await screen.findByRole('status', { name: 'Loading the tips' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    gate.resolve(json(RUBRIC));
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
  });

  test('a skill without a rubric (404) is an honest empty state, not a failure', async () => {
    const view = renderVideo();
    await pickSkill(view, 'Analyse my ball mastery');
    expect(await screen.findByText('No tips for this skill yet')).toBeTruthy();
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(hasRole('button', 'Change skill')).toBe(true);
  });

  test('a failed request is an error with a Try again that asks again, in generic words', async () => {
    let fail = true;
    stubNetwork({ rubric: () => (fail ? problem(500) : json(RUBRIC)) });
    const view = renderVideo();
    await pickSkill(view);
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('Could not load the tips');
    expect(pageText()).not.toContain('Server text that must not be shown');
    fail = false;
    await view.user.click(button('Try again'));
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
    expect(rubricCalls()).toHaveLength(2);
  });
});

// --- the consent gate (risk:privacy) -----------------------------------------------------------------------------------------

describe('the consent gate', () => {
  test('without videoAnalysis consent it comes first: plain disclosure, a link to the privacy settings, and no way forward', async () => {
    consentsHeld = DEFAULT_CONSENTS;
    const world = makeWorld();
    const view = renderVideo(world);
    await pickSkill(view);
    await heading('Before you start');
    const gate = pageText();
    expect(gate).toMatch(/never uploaded/i);
    expect(gate).toMatch(/AI provider/);
    expect(gate).toMatch(/blurred/i);
    expect(gate).toContain('Video analysis is off');
    const link = screen.getByRole('link', { name: 'Open privacy settings' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/privacy');
    // never proceeds: no camera, no file input, no model, no rubric request
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(screen.queryByLabelText('Choose a video from this device') === null).toBe(true);
    expect(rubricCalls()).toHaveLength(0);
    expect(world.pose.load).not.toHaveBeenCalled();
    expect(world.camera.open).not.toHaveBeenCalled();
  });

  test('a player who has revoked the consent (granted: false) is stopped the same way', async () => {
    consentsHeld = Consents.parse({ ...DEFAULT_CONSENTS, videoAnalysis: { granted: false, at: AT } });
    const view = renderVideo();
    await pickSkill(view);
    await heading('Before you start');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
  });

  test('shows a busy, named status while the consents load, and a Try again error when they cannot', async () => {
    const gate = deferred<Response>();
    stubNetwork({ consents: () => gate.promise });
    const view = renderVideo();
    await pickSkill(view);
    const busy = await screen.findByRole('status', { name: 'Checking your privacy choices' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    gate.resolve(problem(500));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('Could not check your privacy choices');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    stubNetwork({});
    await view.user.click(button('Try again'));
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
  });

  test('under 13 with consent but no guardian confirmation: a guardian must say yes first, and nothing proceeds', async () => {
    consentsHeld = GRANTED_ALONE;
    stubNetwork({ me: () => json(meOfAge(9)) });
    const view = renderVideo();
    await pickSkill(view);
    await heading('Before you start');
    expect(await screen.findByText('A parent or guardian must say yes')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Open privacy settings' }) as HTMLAnchorElement).getAttribute('href')).toBe('/settings/privacy');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(rubricCalls()).toHaveLength(0);
  });

  test('under 13 WITH the guardian confirmation goes on', async () => {
    consentsHeld = GRANTED_WITH_GUARDIAN;
    stubNetwork({ me: () => json(meOfAge(9)) });
    const view = renderVideo();
    await toCapture(view);
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('13 or older with consent goes on without a guardian', async () => {
    consentsHeld = GRANTED_ALONE;
    stubNetwork({ me: () => json(meOfAge(13)) });
    const view = renderVideo();
    await toCapture(view);
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('12 is under 13: the guardian rule applies', async () => {
    consentsHeld = GRANTED_ALONE;
    stubNetwork({ me: () => json(meOfAge(12)) });
    const view = renderVideo();
    await pickSkill(view);
    expect(await screen.findByText('A parent or guardian must say yes')).toBeTruthy();
  });

  test('a player whose age is unknown (no plan yet, 404) is not let through: set up the plan first', async () => {
    consentsHeld = GRANTED_ALONE;
    stubNetwork({ me: () => problem(404, 'not onboarded') });
    const view = renderVideo();
    await pickSkill(view);
    expect(await screen.findByText('Set up your plan first')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Set up my plan' }) as HTMLAnchorElement).getAttribute('href')).toBe('/train/onboarding');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
  });

  test('an age that could not be read (500) is an error, never a guess', async () => {
    consentsHeld = GRANTED_ALONE;
    stubNetwork({ me: () => problem(500) });
    const view = renderVideo();
    await pickSkill(view);
    expect(text(await screen.findByRole('alert'))).toContain('Could not check your privacy choices');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
  });

  test('"I turned it on: check again" asks the server again and opens the way once the consent is there', async () => {
    consentsHeld = DEFAULT_CONSENTS;
    const view = renderVideo();
    await pickSkill(view);
    await heading('Before you start');
    expect(callsTo('/api/player/consents')).toHaveLength(1);
    consentsHeld = GRANTED_WITH_GUARDIAN;
    await view.user.click(button('I turned it on: check again'));
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
    expect(callsTo('/api/player/consents')).toHaveLength(2);
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('the check-again button is disabled and busy while its request is out', async () => {
    consentsHeld = DEFAULT_CONSENTS;
    const second = deferred<Response>();
    let asked = 0;
    stubNetwork({ consents: () => (++asked === 1 ? json(DEFAULT_CONSENTS) : second.promise) });
    const view = renderVideo();
    await pickSkill(view);
    await heading('Before you start');
    await view.user.click(button('I turned it on: check again'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'I turned it on: check again' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'I turned it on: check again' }).getAttribute('aria-busy')).toBe('true');
    second.resolve(json(GRANTED_WITH_GUARDIAN));
    expect(await screen.findByText(RUBRIC.recordingTips[0] as string)).toBeTruthy();
  });

  test('the server refusing the analysis with "consent required" sends the player back to the gate (nothing is retried)', async () => {
    const world = makeWorld({
      analyse: mock(async () => {
        throw new ApiProblem({
          kind: 'forbidden',
          status: 403,
          problem: { type: 'about:blank', title: 'consent required', status: 403, errors: [] },
        });
      }),
    });
    const view = renderVideo(world);
    await toReview(view);
    consentsHeld = DEFAULT_CONSENTS; // the player revoked it meanwhile (another tab)
    await view.user.click(button('Send for analysis'));
    await heading('Before you start');
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(world.analyse).toHaveBeenCalledTimes(1);
  });
});

// --- choosing a clip: the duration limits ------------------------------------------------------------------------------------

describe('choosing a clip', () => {
  test('the file input is labelled, takes video only and is reachable by keyboard', async () => {
    const view = renderVideo();
    await toCapture(view);
    const input = fileInput();
    expect(input.getAttribute('accept')).toBe('video/*');
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('tabindex')).not.toBe('-1');
    expect(input.getAttribute('aria-hidden')).not.toBe('true');
  });

  test.each([
    [7.4, 'too short', /7\.4/],
    [9.9, 'too short', /9\.9/],
    [45, 'too long', /45/],
    [30.1, 'too long', /30\.1/],
  ])('a %p s clip is rejected as %s, with guidance, before any model runs or anything is sent', async (seconds, verdict, shown) => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(seconds));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toMatch(shown);
    expect(text(alert)).toContain(verdict);
    expect(text(alert)).toContain('10 to 30 seconds');
    expect(world.pose.detectOnVideo).not.toHaveBeenCalled();
    expect(world.analyse).not.toHaveBeenCalled();
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0);
    // the rejected clip is released at once, and the player can choose another
    await waitFor(() => expect(world.clips[0]?.release).toHaveBeenCalled());
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test.each([10, 30])('a clip of exactly %p s is accepted (both limits are inclusive)', async (seconds) => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view, seconds);
    expect(world.pose.detectOnVideo).toHaveBeenCalledTimes(1);
  });

  test('a video that cannot be opened is said in words and can be replaced', async () => {
    const world = makeWorld({
      loadClip: mock(async () => {
        throw new Error('decode failed');
      }),
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(12));
    expect(text(await screen.findByRole('alert'))).toContain('This video cannot be opened.');
    expect(world.pose.detectOnVideo).not.toHaveBeenCalled();
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('the model is not loaded until the player actually gives a clip (lazy)', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    expect(world.pose.load).not.toHaveBeenCalled();
    await view.user.upload(fileInput(), clipOf(12));
    await heading('Ready to send?');
    expect(world.pose.load).toHaveBeenCalledTimes(1);
  });
});

// --- recording with the camera -------------------------------------------------------------------------------------------------

describe('recording with the camera', () => {
  test('a countdown comes first; the recorder starts only when it ends; Stop waits for the lower limit and the recording stops itself before the upper one', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    // countdown: the camera is open, the recorder is not running
    const countdown = await screen.findByRole('status', { name: 'Get ready' });
    expect(text(countdown)).toContain('3');
    expect(world.camera.open).toHaveBeenCalledTimes(1);
    expect(world.sessions[0]?.start).not.toHaveBeenCalled();
    expect(hasRole('button', 'Cancel')).toBe(true);
    act(() => advance(3000));
    const stop = await findButton('Stop recording');
    expect(world.sessions[0]?.start).toHaveBeenCalledTimes(1);
    // too early to stop: disabled, and the player is told how long to go on
    expect(stop.disabled).toBe(true);
    act(() => advance(5000));
    await waitFor(() => expect(pageText()).toMatch(/Keep going/));
    expect((screen.getByRole('button', { name: 'Stop recording' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => advance(6000)); // 11 s of recording
    await waitFor(() => expect((screen.getByRole('button', { name: 'Stop recording' }) as HTMLButtonElement).disabled).toBe(false));
    await view.user.click(button('Stop recording'));
    await heading('Ready to send?');
    expect(world.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(world.pose.detectOnVideo).toHaveBeenCalledTimes(1);
  });

  test('left running, a recording stops by itself before 30 s and goes on to the analysis', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    act(() => advance(3000));
    await findButton('Stop recording');
    act(() => advance(29000));
    await heading('Ready to send?');
    expect(world.sessions[0]?.stop).toHaveBeenCalledTimes(1);
  });

  test('the recording shows how long it has run, in words and as a progress bar with its number', async () => {
    const view = renderVideo();
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    act(() => advance(3000));
    await findButton('Stop recording');
    act(() => advance(7000));
    await waitFor(() => expect(pageText()).toContain('Recording: 7 s'));
    const bar = screen.getByRole('progressbar');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    expect(bar.getAttribute('aria-valuemax')).toBeTruthy();
  });

  test('Cancel during the countdown or the recording releases the camera, keeps nothing and returns to the choice', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    await view.user.click(button('Cancel'));
    expect(await findButton('Record with the camera')).toBeTruthy();
    expect(world.sessions[0]?.release).toHaveBeenCalled();
    expect(world.sessions[0]?.stop).not.toHaveBeenCalled();
    expect(world.pose.detectOnVideo).not.toHaveBeenCalled();

    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    act(() => advance(3000));
    await findButton('Stop recording');
    await view.user.click(button('Cancel'));
    expect(await findButton('Record with the camera')).toBeTruthy();
    expect(world.sessions[1]?.release).toHaveBeenCalled();
    expect(world.sessions[1]?.stop).not.toHaveBeenCalled();
    expect(world.pose.detectOnVideo).not.toHaveBeenCalled();
  });

  test('two taps on Record in the same tick open the camera once', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    const record = button('Record with the camera');
    act(() => {
      record.click();
      record.click();
    });
    await screen.findByRole('status', { name: 'Get ready' });
    expect(world.camera.open).toHaveBeenCalledTimes(1);
    expect(view).toBeTruthy();
  });

  test('a blocked camera says so in words, offers the file choice instead and lets the player try again', async () => {
    const world = makeWorld();
    let blocked = true;
    world.camera.open.mockImplementation(async () => {
      if (blocked) throw new DOMException('Permission denied', 'NotAllowedError');
      return {
        stream: null,
        start: mock(() => {}),
        stop: mock(async () => clipOf(12, 'video/webm')),
        release: mock(() => {}),
      } as never;
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('The camera is blocked');
    expect(screen.getByLabelText('Choose a video from this device')).toBeTruthy();
    blocked = false;
    await view.user.click(button('Record with the camera'));
    expect(await screen.findByRole('status', { name: 'Get ready' })).toBeTruthy();
  });

  test('no camera on the device (or no MediaRecorder): the Record button is not offered, the file choice is', async () => {
    const view = renderVideo(makeWorld({ camera: null }));
    await toCapture(view);
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(pageText()).toContain('This browser cannot record here. Choose a video you already have.');
    expect(screen.getByLabelText('Choose a video from this device')).toBeTruthy();
  });

  test('a camera that exists but fails (not blocked) is said as unavailable', async () => {
    const world = makeWorld();
    world.camera.open.mockImplementation(async () => {
      throw new DOMException('in use', 'NotReadableError');
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    expect(text(await screen.findByRole('alert'))).toContain('The camera is not available');
  });

  test('leaving the screen mid-recording releases the camera', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.click(button('Record with the camera'));
    await screen.findByRole('status', { name: 'Get ready' });
    view.unmount();
    expect(world.sessions[0]?.release).toHaveBeenCalled();
  });
});

// --- on-device processing ------------------------------------------------------------------------------------------------------

describe('processing on the device', () => {
  test('shows a named progress bar with its number and a Cancel button while the movement is read', async () => {
    const world = makeWorld();
    const gate = deferred();
    world.detectGate.current = gate.promise;
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    const bar = await screen.findByRole('progressbar', { name: 'Reading your movement' });
    const now = Number(bar.getAttribute('aria-valuenow'));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(100);
    expect(pageText()).toContain(`${now}%`);
    expect(pageText()).toContain('Your video stays on this phone.');
    expect(hasRole('button', 'Cancel')).toBe(true);
    // the pose detector samples the recorded clip at 5-10 fps
    const fps = world.pose.detectOnVideo.mock.calls[0]?.[1] as number;
    expect(fps).toBeGreaterThanOrEqual(5);
    expect(fps).toBeLessThanOrEqual(10);
    gate.resolve();
    await heading('Ready to send?');
  });

  test('Cancel stops the work, releases the clip and returns to the choice: no pictures are cut, nothing is sent, no error is shown', async () => {
    const world = makeWorld();
    const gate = deferred();
    world.detectGate.current = gate.promise;
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    await screen.findByRole('progressbar');
    await view.user.click(button('Cancel'));
    await heading('Record or choose a clip');
    expect(world.clips[0]?.release).toHaveBeenCalled();
    gate.resolve(); // the detector wakes up after the cancel: its late answer changes nothing
    await new Promise((done) => setTimeout(done, 30));
    expect(hasRole('heading', 'Ready to send?')).toBe(false);
    expect(world.sampleKeyframes).not.toHaveBeenCalled();
    expect(world.analyse).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('a seek that never answers cannot hang the screen: it fails in words after the guard time, and the clip is released', async () => {
    const world = makeWorld({
      // The real sampler awaits its `seek` seam for every keyframe; a stalled decoder never answers.
      sampleKeyframes: mock(async (video: unknown, _frames: unknown, _n: number, seams?: { seek?: (v: unknown, s: number) => Promise<void> }) => {
        await seams?.seek?.(video, 1);
        return KEYFRAMES;
      }),
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    expect(text(await screen.findByRole('alert'))).toContain('We could not read this clip');
    expect(world.clips[0]?.release).toHaveBeenCalled();
    expect(world.analyse).not.toHaveBeenCalled();
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test('a detector that throws is the same calm failure', async () => {
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => {
      throw new PoseError('seek_failed', 'boom');
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    expect(text(await screen.findByRole('alert'))).toContain('We could not read this clip');
    expect(pageText()).not.toContain('boom');
    expect(world.clips[0]?.release).toHaveBeenCalled();
  });

  test('the pose frames are adapted for the sampler: only frames with a person, time in seconds, and an honest count of pictures', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view);
    const [, frames, n] = world.sampleKeyframes.mock.calls[0] as [unknown, { timeSec: number; landmarks: unknown[] }[], number];
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(6);
    expect(frames.every((frame) => frame.landmarks.length === 33)).toBe(true);
    expect(frames.map((frame) => frame.timeSec)).toEqual(FRAMES.filter((frame) => frame.landmarks.length > 0).map((frame) => frame.timeMs / 1000));
    // the seek the sampler is given is the screen's guarded one
    expect(typeof (world.sampleKeyframes.mock.calls[0]?.[3] as { seek?: unknown } | undefined)?.seek).toBe('function');
  });

  test('a device that cannot run pose detection says so before it offers to record, and training stays one tap away', async () => {
    const world = makeWorld({ canDetectPose: () => false });
    const view = renderVideo(world);
    await pickSkill(view);
    expect(await screen.findByText('This device cannot run the analysis')).toBeTruthy();
    expect(hasRole('button', 'Record with the camera')).toBe(false);
    expect(screen.queryByLabelText('Choose a video from this device') === null).toBe(true);
    expect((screen.getByRole('link', { name: 'Back to training' }) as HTMLAnchorElement).getAttribute('href')).toBe('/train');
    expect(world.pose.load).not.toHaveBeenCalled();
  });

  test('a model that fails to load (online) is the same unsupported message, and the clip is released', async () => {
    const world = makeWorld();
    world.pose.load.mockImplementation(async () => {
      throw new PoseError('load_failed', 'wasm blocked');
    });
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    expect(await screen.findByText('This device cannot run the analysis')).toBeTruthy();
    expect(world.clips[0]?.release).toHaveBeenCalled();
    expect(world.analyse).not.toHaveBeenCalled();
  });
});

// --- the answer on the device: not enough of the player was seen ---------------------------------------------------------------------

describe('a clip the coach could not see', () => {
  test('below the rubric minimum visibility: the rerecord hint is shown on the device and NOTHING is sent', async () => {
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => framesOf(0.3));
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    expect(await screen.findByText('We could not see you well enough')).toBeTruthy();
    expect(pageText()).toContain('Nothing was sent.');
    expect(world.analyse).not.toHaveBeenCalled();
    expect(world.sampleKeyframes).not.toHaveBeenCalled();
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0);
    expect(world.clips[0]?.release).toHaveBeenCalled();
    await view.user.click(button('Film again'));
    expect(await findButton('Record with the camera')).toBeTruthy();
  });

  test('a clip with nobody in it is the same hint, not a crash', async () => {
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => NOBODY);
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    expect(await screen.findByText('We could not see you well enough')).toBeTruthy();
    expect(world.analyse).not.toHaveBeenCalled();
  });

  test('visibility exactly at the minimum is accepted (only below it is a rerecord)', async () => {
    // 0.5 is exact in floating point, so the mean of many landmarks is exactly the rubric minimum (0.6 would not be).
    stubNetwork({ rubric: () => json({ ...RUBRIC, minVisibility: 0.5 }) });
    const world = makeWorld();
    world.pose.detectOnVideo.mockImplementation(async () => framesOf(0.5));
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    await heading('Ready to send?');
  });
});

// --- the review and the payload (risk:privacy) ----------------------------------------------------------------------------------------

const containsBinary = (value: unknown): boolean => {
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) return value.some(containsBinary);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(containsBinary);
  return false;
};

describe('what is sent', () => {
  test('nothing is sent before the player has seen the pictures and tapped Send; the clip is already released by then', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view);
    expect(world.analyse).not.toHaveBeenCalled();
    expect(callsTo('/api/player/video-analyses', 'POST')).toHaveLength(0);
    expect(world.clips[0]?.release).toHaveBeenCalled();
    expect(pageText()).toMatch(/Only these pictures/);
    const pictures = screen.getAllByRole('img', { name: /^Picture \d of \d/ }) as HTMLImageElement[];
    expect(pictures).toHaveLength(KEYFRAMES.length);
    pictures.forEach((picture, index) => {
      expect(picture.getAttribute('src')).toBe(`data:image/jpeg;base64,${KEYFRAMES[index]?.data}`);
    });
    expect(hasRole('button', 'Send for analysis')).toBe(true);
    expect(hasRole('button', 'Delete and start again')).toBe(true);
  });

  test('the request is exactly the contract: skill, rubric version, duration, features and keyframes, a client uuid, and no video', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view, 14.3);
    await view.user.click(button('Send for analysis'));
    await heading('Your feedback');
    expect(world.analyse).toHaveBeenCalledTimes(1);
    const [request, signal] = world.analyse.mock.calls[0] as [CreateVideoAnalysisRequest, AbortSignal];
    // strict schema: an unknown key (a `video`) would fail
    expect(CreateVideoAnalysisRequest.safeParse(request).success).toBe(true);
    expect(Object.keys(request).sort()).toEqual(['clientUuid', 'durationSec', 'features', 'keyframes', 'rubricVersion', 'skillSlug']);
    expect(request.skillSlug).toBe('dribbling');
    expect(request.rubricVersion).toBe(RUBRIC.version);
    expect(request.durationSec).toBeCloseTo(14.3, 1);
    expect(request.keyframes).toEqual(KEYFRAMES.slice(0, request.keyframes.length));
    expect(request.keyframes.length).toBeGreaterThanOrEqual(3);
    expect(request.keyframes.length).toBeLessThanOrEqual(6);
    const expectedFeatures = extractFeatures(FRAMES, { aspectRatio: VIDEO_SIZE.videoWidth / VIDEO_SIZE.videoHeight });
    expect(expectedFeatures === null).toBe(false);
    expect(request.features).toEqual(expectedFeatures as NonNullable<typeof expectedFeatures>);
    expect(request.features.framesAnalysed).toBe(58);
    // no video, no blob, no object URL in what leaves the device
    expect(containsBinary(request)).toBe(false);
    expect(JSON.stringify(request)).not.toMatch(/blob:|not really a video|video\//);
    expect(signal.aborted).toBe(false);
  });

  test('without an injected `analyse` the default call is one JSON POST to /api/player/video-analyses that carries no file', async () => {
    const world = makeWorld();
    const { analyse: _unused, ...withoutAnalyse } = world.deps;
    const view = renderVideo({ ...world, deps: withoutAnalyse } as World);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading('Your feedback');
    const posts = callsTo('/api/player/video-analyses', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers.get('content-type')).toBe('application/json');
    expect(posts[0]?.headers.get('accept-language')).toBe('en');
    expect(CreateVideoAnalysisRequest.safeParse(posts[0]?.body).success).toBe(true);
    // every request body of the whole flow is a JSON string (or none): never a Blob, File or FormData
    for (const call of calls) expect(call.body === undefined || typeof call.body === 'object').toBe(true);
    for (const call of calls) expect(call.body instanceof Blob || call.body instanceof FormData).toBe(false);
  });

  test('Delete and start again drops the pictures without sending anything', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Delete and start again'));
    await heading('Record or choose a clip');
    expect(world.analyse).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('img').length).toBe(0);
  });

  test('while the request is out the Send button is disabled and busy, a second tap sends nothing, and Cancel sending is available', async () => {
    const gate = deferred<CreateVideoAnalysisResponse>();
    const world = makeWorld({ analyse: mock(async () => gate.promise) });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    const busy = await screen.findByRole('status', { name: 'Sending and waiting for feedback' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    const send = screen.getByRole('button', { name: 'Send for analysis' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Delete and start again' }) as HTMLButtonElement).disabled).toBe(true);
    await view.user.click(send);
    expect(world.analyse).toHaveBeenCalledTimes(1);
    expect(hasRole('button', 'Cancel sending')).toBe(true);
    gate.resolve(ANALYSIS);
    await heading('Your feedback');
  });

  test('two taps in the same tick (before the screen can disable the button) still send once', async () => {
    const gate = deferred<CreateVideoAnalysisResponse>();
    const world = makeWorld({ analyse: mock(async () => gate.promise) });
    const view = renderVideo(world);
    await toReview(view);
    const send = button('Send for analysis');
    act(() => {
      send.click();
      send.click();
    });
    await screen.findByRole('status', { name: 'Sending and waiting for feedback' });
    expect(world.analyse).toHaveBeenCalledTimes(1);
    gate.resolve(ANALYSIS);
    await heading('Your feedback');
  });

  test('Cancel sending aborts the request and goes back to the review with Send available again, without an error', async () => {
    const world = makeWorld({
      analyse: mock(
        (_request: unknown, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await view.user.click(await findButton('Cancel sending'));
    await heading('Ready to send?');
    expect((world.analyse.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect((screen.getByRole('button', { name: 'Send for analysis' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a failed send is an error in generic words; Try again resends the SAME request (same client uuid) and succeeds', async () => {
    let fail = true;
    const world = makeWorld({
      analyse: mock(async () => {
        if (fail) throw new ApiProblem({ kind: 'network' });
        return ANALYSIS;
      }),
    });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not get your feedback');
    fail = false;
    await view.user.click(button('Try again'));
    await heading('Your feedback');
    expect(world.analyse).toHaveBeenCalledTimes(2);
    expect(world.analyse.mock.calls[1]?.[0]).toEqual(world.analyse.mock.calls[0]?.[0] as never);
  });

  test('the analysis is given up on after the contract timeout: the request is aborted with a TimeoutError and the failure is shown', async () => {
    const world = makeWorld({
      analyseTimeoutMs: 30,
      analyse: mock(
        (_request: unknown, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      ),
    });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    expect(text(await screen.findByRole('alert'))).toContain('We could not get your feedback');
    const signal = world.analyse.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect((signal.reason as { name?: string }).name).toBe('TimeoutError');
  });

  test('a 403 that is not "consent required" is the feature being switched off: said in words, nothing to retry', async () => {
    const world = makeWorld({
      analyse: mock(async () => {
        throw new ApiProblem({ kind: 'forbidden', status: 403, problem: { type: 'about:blank', title: 'video coach disabled', status: 403, errors: [] } });
      }),
    });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    expect(await screen.findByText('Video Coach is switched off')).toBeTruthy();
    expect(hasRole('button', 'Try again')).toBe(false);
    expect((screen.getByRole('link', { name: 'Back to training' }) as HTMLAnchorElement).getAttribute('href')).toBe('/train');
  });
});

// --- the result ----------------------------------------------------------------------------------------------------------------------

describe('the result', () => {
  async function toResult(view: View) {
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading('Your feedback');
  }

  test('shows each score out of 10 with its note, the focus, the recommended drills and when to film again, and no overall number', async () => {
    const view = renderVideo();
    await toResult(view);
    const shown = pageText();
    expect(shown).toContain('Beta');
    expect(shown).toContain('How sure we are: Medium');
    for (const score of ANALYSIS.scores) {
      expect(shown).toContain(score.label);
      expect(shown).toContain(score.note);
    }
    expect(shown.match(/\d+ \/ 10/g)).toEqual(['7 / 10', '4 / 10']);
    expect(shown).not.toMatch(/\/ ?100|out of 100/);
    expect(await heading('Focus next')).toBeTruthy();
    expect(shown).toContain(ANALYSIS.focusNext);
    expect(await heading('Drills to try')).toBeTruthy();
    const drill = screen.getByRole('link', { name: 'First Touch Box' }) as HTMLAnchorElement;
    expect(drill.getAttribute('href')).toBe('/commons/first-touch-box');
    expect(shown).toContain('Trains even touches.');
    expect(shown).toContain('Film again after 3 training sessions to see how you changed.');
    expect(shown).toContain('One clip from one angle cannot show everything.');
    // the score is a number AND a bar, never colour alone
    expect(screen.getAllByRole('meter').length).toBe(2);
  });

  test('Analyse another clip returns to the capture step of the same skill', async () => {
    const view = renderVideo();
    await toResult(view);
    await view.user.click(button('Analyse another clip'));
    await heading('Record or choose a clip');
    expect(hasRole('button', 'Record with the camera')).toBe(true);
  });

  test.each([
    ['low_visibility', 'We could not see you well enough'],
    ['too_dark', 'The clip was too dark'],
    ['too_short', 'The clip was too short to judge'],
  ] as const)('a rerecord answer (%s) shows its hint and no scores', async (reason, title) => {
    const world = makeWorld({ analyse: mock(async () => ({ rerecord: true, reason })) });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryAllByRole('meter').length).toBe(0);
    expect(pageText()).not.toMatch(/\d+ \/ 10/);
    await view.user.click(button('Film again'));
    expect(await findButton('Record with the camera')).toBeTruthy();
  });

  test('the clip is released once the result is in, and released only through release()', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toResult(view);
    expect(world.clips).toHaveLength(1);
    expect(world.clips[0]?.release).toHaveBeenCalled();
  });
});

// --- nothing is persisted ---------------------------------------------------------------------------------------------------------------

const KEYFRAME_MARKER = '/9j/';

function everyStoredString(): string[] {
  const out: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index) as string;
      out.push(key, storage.getItem(key) ?? '');
    }
  }
  return out;
}

describe('nothing is persisted', () => {
  test('after a whole run no storage, query cache or mutation cache holds a picture, the clip or the result', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading('Your feedback');
    for (const stored of everyStoredString()) expect(stored).not.toContain(KEYFRAME_MARKER);
    const cache = JSON.stringify(dehydrate(view.queryClient, { shouldDehydrateQuery: () => true }));
    expect(cache).not.toContain(KEYFRAME_MARKER);
    expect(cache).not.toContain(ANALYSIS.focusNext);
    const mutations = JSON.stringify(view.queryClient.getMutationCache().getAll().map((mutation) => mutation.state.variables ?? null));
    expect(mutations).not.toContain(KEYFRAME_MARKER);
  });

  test('no query of this screen is on the persisted allow-list, and a persisted client would hold none of the run', async () => {
    const world = makeWorld();
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await heading('Your feedback');
    const isPersisted = (key: readonly unknown[]) => PERSISTED_QUERY_PREFIXES.some((prefix) => prefix.every((part, i) => key[i] === part));
    for (const query of view.queryClient.getQueryCache().getAll()) {
      if (query.queryKey[0] === 'video') expect(isPersisted(query.queryKey)).toBe(false);
    }
    const written: string[] = [];
    const store: PersistStore = {
      get: async () => undefined,
      set: async (_key, value) => void written.push(JSON.stringify(value)),
      del: async () => {},
    };
    const [unsubscribe, restored] = persistAppQueryClient({ queryClient: view.queryClient, playerId: 'player-1', store });
    await restored;
    // touch the cache so a save is scheduled, then wait past the persister's throttle
    view.queryClient.setQueryData(['me'], meOfAge(9));
    await new Promise((done) => setTimeout(done, 1200));
    unsubscribe();
    const everything = written.join('\n');
    expect(everything).toContain('"age":9'); // the persister did run, so the absence below means something
    expect(everything).not.toContain(KEYFRAME_MARKER);
    expect(everything).not.toContain(ANALYSIS.focusNext);
    expect(everything).not.toContain('recordingTips');
  });

  test('leaving the screen while sending aborts the request and releases the clip and the camera', async () => {
    const world = makeWorld({
      analyse: mock(
        (_request: unknown, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    });
    const view = renderVideo(world);
    await toReview(view);
    await view.user.click(button('Send for analysis'));
    await screen.findByRole('status', { name: 'Sending and waiting for feedback' });
    view.unmount();
    expect((world.analyse.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    expect(world.clips.every((clip) => clip.release.mock.calls.length > 0)).toBe(true);
  });

  test('leaving the screen while the movement is read releases the clip', async () => {
    const world = makeWorld();
    world.detectGate.current = new Promise(() => {});
    const view = renderVideo(world);
    await toCapture(view);
    await view.user.upload(fileInput(), clipOf(14));
    await screen.findByRole('progressbar');
    view.unmount();
    expect(world.clips[0]?.release).toHaveBeenCalled();
  });
});

// --- offline ---------------------------------------------------------------------------------------------------------------------------------

describe('offline', () => {
  test('is an unavailable message instead of the skill pick, with training one tap away, and it recovers when the network is back', async () => {
    let online = false;
    const view = renderVideo(makeWorld({ online: () => online }));
    expect(await screen.findByText('Video Coach is unavailable offline')).toBeTruthy();
    expect(hasRole('button', 'Analyse my dribbling')).toBe(false);
    expect((screen.getByRole('link', { name: 'Back to training' }) as HTMLAnchorElement).getAttribute('href')).toBe('/train');
    expect(calls).toHaveLength(0);
    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await findButton('Analyse my dribbling')).toBeTruthy();
    expect(view).toBeTruthy();
  });

  test('going offline before a skill is chosen and coming back does not lose the screen', async () => {
    let online = true;
    renderVideo(makeWorld({ online: () => online }));
    await findButton('Analyse my dribbling');
    online = false;
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText('Video Coach is unavailable offline')).toBeTruthy();
  });
});

// --- languages ------------------------------------------------------------------------------------------------------------------------------

describe.each(['kk', 'ru'] as const)('%s', (locale) => {
  const CYRILLIC = /[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/;
  const clean = () => {
    const shown = pageText();
    for (const leak of LEAKS) expect(shown).not.toContain(leak);
    expect(shown).toMatch(CYRILLIC);
  };

  test('the skill pick and the consent gate have words and leak nothing', async () => {
    consentsHeld = DEFAULT_CONSENTS;
    const view = renderVideo(makeWorld(), locale);
    await view.user.click(await screen.findByRole('button', { name: messages[locale].skills.dribbling.option }));
    await screen.findByRole('heading', { name: messages[locale].gate.title });
    clean();
    expect((await screen.findByRole('link', { name: messages[locale].gate.open })).getAttribute('href')).toBe('/settings/privacy');
  });

  test('capture and result in this language', async () => {
    const world = makeWorld();
    const view = renderVideo(world, locale);
    await view.user.click(await screen.findByRole('button', { name: messages[locale].skills.dribbling.option }));
    await screen.findByText(RUBRIC.recordingTips[0] as string);
    expect(new URLSearchParams(rubricCalls()[0]?.search).get('locale')).toBe(locale);
    clean();
    await view.user.upload(screen.getByLabelText(messages[locale].capture.choose) as HTMLInputElement, clipOf(14));
    await screen.findByRole('heading', { name: messages[locale].review.title });
    clean();
    await view.user.click(screen.getByRole('button', { name: messages[locale].review.send }));
    await screen.findByRole('heading', { name: messages[locale].result.title });
    clean();
    expect(within(document.body).getAllByRole('meter').length).toBe(2);
  });

  test('the clip length message names the seconds in this language and gives guidance', async () => {
    const world = makeWorld();
    const view = renderVideo(world, locale);
    await view.user.click(await screen.findByRole('button', { name: messages[locale].skills.dribbling.option }));
    await screen.findByText(RUBRIC.recordingTips[0] as string);
    await view.user.upload(screen.getByLabelText(messages[locale].capture.choose) as HTMLInputElement, clipOf(7.5));
    const alert = await screen.findByRole('alert');
    expect(text(alert).length).toBeGreaterThan(10);
    expect(text(alert)).toMatch(CYRILLIC);
    for (const leak of LEAKS) expect(text(alert)).not.toContain(leak);
    expect(text(alert)).toMatch(/7[.,]5/);
  });
});
