import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { AI_UNAVAILABLE } from '@api-types/ai';
import { StartResponse } from '@api-types/onboarding';
import type { PlayerProfile, Roadmap } from '@api-types/domain';
import { Consents, DEFAULT_CONSENTS } from '@api-types/privacy';
import { CONSENT_REQUIRED_TITLE, Keyframe, Rubric, VideoAnalysis } from '@api-types/video';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import type { PoseFrame } from '../../video/features';
import messages from './capture.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as capture.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the route only now, after happy-dom is registered.
const { Route, VideoDepsContext } = await import('../../routes/video');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`: a FAILING assertion pretty-prints the happy-dom element (a huge
// circular graph) and can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * fc-mol-8nt.13 (bug, ui): when the analysis endpoint answers 503 (type `ai_unavailable`: no OPENAI_API_KEY, or the provider is
 * down) or 403 'Video coach disabled', the capture screen must say, calmly and specifically, that the video analysis is
 * unavailable right now: ONE sentence that the rest of the app works and training is not affected, plus a link back to training.
 * Never the generic failure copy ('We could not get your feedback' / 'Something went wrong ...'), never a red alert. 'Disabled'
 * has no retry; a 503 may offer Try again (it resends the same request). 502, 413 and 422 keep their existing messages.
 *
 * The problems below are the exact bodies apps/api/src/http/routes/player-video.routes.ts answers (read from the route, not
 * guessed): 503 { type: 'ai_unavailable', title: 'Service Unavailable' }, 403 { title: 'Video coach disabled' } (the consent
 * 403 has the title 'consent required'), 502 'Bad Gateway', 413 'Payload Too Large', 422 'Unprocessable Entity'. They go through
 * the real typed client (the route's default `analyse`), so what the screen reads is what the wire carries.
 * Readings: a 503 is unavailable whatever its `type` (a proxy's 503 says the same thing to a player); 504 and 5xx other than
 * 503 keep the generic copy; any 403 whose title is not 'consent required' is 'disabled' (that is how the screen already told
 * the two apart).
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------------

const RUBRIC = Rubric.parse({
  skill: 'dribbling',
  version: 2,
  criteria: [{ key: 'touch-rhythm', label: 'Touch rhythm', description: 'Small, steady touches.', lookFor: ['Touches are evenly spaced.'] }],
  recordingTips: ['Put the phone on the ground, leaning on a bottle.'],
  minVisibility: 0.6,
});

const AT = '2026-09-22T10:00:00.000Z';
const GRANTED = Consents.parse({ ...DEFAULT_CONSENTS, videoAnalysis: { granted: true, at: AT, guardianConfirmed: true } });
const REVOKED = Consents.parse({ ...DEFAULT_CONSENTS });

const profile: PlayerProfile = {
  age: 9,
  level: 'basic',
  goal: 'control',
  equipment: 'ball',
  space: 'yard',
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: 'en',
};
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
const ME = StartResponse.parse({ profile, roadmap: ROADMAP });

function person(index: number) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const phase = index * 0.9;
  const leftLift = Math.max(0, Math.sin(phase)) * 0.06;
  const rightLift = Math.max(0, -Math.sin(phase)) * 0.06;
  landmarks[0] = { x: 0.53, y: 0.15, z: 0, visibility: 0.9 };
  landmarks[11] = { x: 0.45, y: 0.3, z: 0, visibility: 0.9 };
  landmarks[12] = { x: 0.55, y: 0.3, z: 0, visibility: 0.9 };
  landmarks[23] = { x: 0.46, y: 0.55, z: 0, visibility: 0.9 };
  landmarks[24] = { x: 0.54, y: 0.55, z: 0, visibility: 0.9 };
  landmarks[25] = { x: 0.4, y: 0.72, z: 0, visibility: 0.9 };
  landmarks[26] = { x: 0.6, y: 0.72, z: 0, visibility: 0.9 };
  landmarks[27] = { x: 0.44, y: 0.9 - leftLift, z: 0, visibility: 0.9 };
  landmarks[28] = { x: 0.56, y: 0.9 - rightLift, z: 0, visibility: 0.9 };
  return landmarks;
}
const FRAMES: PoseFrame[] = Array.from({ length: 60 }, (_, index) => ({ timeMs: (index * 1000) / 6, landmarks: person(index) }));

const KEYFRAMES = Array.from({ length: 5 }, (_, index) =>
  Keyframe.parse({ mimeType: 'image/jpeg', data: `/9j/${`AAA${'ABCDE'[index]}`.repeat(30)}`, width: 288, height: 512 }),
);

const ANALYSIS = VideoAnalysis.parse({
  id: 'analysis-1',
  skillSlug: 'dribbling',
  createdAt: AT,
  beta: true,
  confidence: 'medium',
  scores: [{ key: 'touch-rhythm', label: 'Touch rhythm', score: 4, note: 'The touches got uneven near the end.' }],
  focusNext: 'Keep the touches evenly spaced.',
  recommended: [{ drillVersionId: 'first-touch-box-v1', slug: 'first-touch-box', title: 'First Touch Box', reason: 'Trains even touches.' }],
  repeatAfterSessions: 3,
  limitations: ['One clip from one angle cannot show everything.'],
});

// --- the network: a small fake of the server, answering the analysis with what a test says --------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problemBody = (status: number, title: string, detail: string, type = 'about:blank', errors: unknown[] = []) =>
  json({ type, title, status, detail, errors }, status, 'application/problem+json');

/** The answers of player-video.routes.ts, byte for byte where it matters (type and title). */
const SERVER_PROBLEMS = {
  noKey503: () => problemBody(503, 'Service Unavailable', 'The AI video coach is not available.', AI_UNAVAILABLE),
  bare503: () => problemBody(503, 'Service Unavailable', 'Try later.'),
  disabled403: () => problemBody(403, 'Video coach disabled', 'The video coach is switched off.'),
  consent403: () => problemBody(403, CONSENT_REQUIRED_TITLE, 'The video analysis consent is not granted.'),
  bad502: () => problemBody(502, 'Bad Gateway', 'The video coach could not analyse the clip. Try again.'),
  large413: () => problemBody(413, 'Payload Too Large', 'A picture is too large.'),
  invalid422: () => problemBody(422, 'Unprocessable Entity', 'The request is invalid.', 'about:blank', [{ pointer: '/keyframes', detail: 'Send 3 to 6 pictures.' }]),
  timeout504: () => problemBody(504, 'Gateway Timeout', 'The video coach took too long. Try again.'),
};

const realFetch = globalThis.fetch;
let posts = 0;
let consentsHeld: Consents = GRANTED;
let analysisAnswers: Array<() => Response> = [];

function stubNetwork(): void {
  posts = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/player/consents') return json(consentsHeld);
    if (url.pathname === '/api/player/me') return json(ME);
    if (/^\/api\/video\/rubrics\/dribbling$/.test(url.pathname)) return json(RUBRIC);
    if (url.pathname === '/api/player/video-analyses' && method === 'POST') {
      posts += 1;
      const answer = analysisAnswers[Math.min(posts, analysisAnswers.length) - 1];
      return answer === undefined ? json(ANALYSIS) : answer();
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

// --- the on-device seams (fakes): no MediaPipe, camera or canvas exists under bun ------------------------------------------

type FakeBlob = File & { fakeDurationSec: number };
const clipOf = (seconds: number): FakeBlob =>
  Object.assign(new File(['not really a video'], 'clip.mp4', { type: 'video/mp4' }), { fakeDurationSec: seconds });

function makeWorld() {
  const navigate = mock((_target: unknown) => {});
  const deps = {
    pose: {
      load: mock(async () => {}),
      detectOnVideo: mock(async (_video: unknown, _fps?: number, onProgress?: (fraction: number) => void) => {
        onProgress?.(1);
        return FRAMES;
      }),
    },
    loadClip: mock(async (blob: Blob) => ({
      video: { duration: (blob as FakeBlob).fakeDurationSec, currentTime: 0, videoWidth: 720, videoHeight: 1280, addEventListener() {}, removeEventListener() {} },
      durationSec: (blob as FakeBlob).fakeDurationSec,
      release: mock(() => {}),
    })),
    sampleKeyframes: mock(async (_video: unknown, _frames: unknown, n: number) => KEYFRAMES.slice(0, n)),
    navigate,
    camera: null,
    online: () => true,
    canDetectPose: () => true,
    clock: { now: () => 0, pollMs: 4 },
    seekTimeoutMs: 40,
    analyseTimeoutMs: 5000,
  };
  return { deps, navigate };
}
type World = ReturnType<typeof makeWorld>;

// --- cross-file hygiene (apps/web tests share ONE happy-dom window; see features/contribute/form.test.tsx) -----------------

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

beforeEach(() => {
  consentsHeld = GRANTED;
  analysisAnswers = [];
  stubNetwork();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  // React Query listens to window 'online'/'offline' and window focus: leave both as a fresh window has them.
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  resetHappyDomCaches();
});

// --- rendering ----------------------------------------------------------------------------------------------------------

const modules = { './capture.messages.ts': { default: messages }, '../../lib/problem.messages.ts': { default: problemMessages } };
const noStorage = { getItem: () => null, setItem: () => {} };
const VideoPage = Route.options.component as () => ReactNode;

function renderVideo(world: World, locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <VideoDepsContext.Provider value={world.deps as never}>
          <VideoPage />
        </VideoDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { user, world };
}
type View = ReturnType<typeof renderVideo>;

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const pageText = (): string => text(document.body);
const hasRole = (role: string, name: string | RegExp): boolean => screen.queryByRole(role as never, { name }) !== null;

/** Picks the skill, chooses a 14 s clip, and taps Send (the consent is granted, the clip is valid). */
async function sendClip(view: View, locale: Locale = 'en') {
  const m = messages[locale];
  await view.user.click(await screen.findByRole('button', { name: m.skills.dribbling.option }));
  await screen.findByText(RUBRIC.recordingTips[0] as string);
  await view.user.upload(screen.getByLabelText(m.capture.choose) as HTMLInputElement, clipOf(14));
  await screen.findByRole('heading', { name: m.review.title });
  await view.user.click(screen.getByRole('button', { name: m.review.send }));
}

const UNAVAILABLE_EN = 'Video analysis is unavailable right now';
const SENTENCE_EN = 'The rest of the app works and your training is not affected.';
const GENERIC = ['We could not get your feedback', 'Something went wrong'];

/** What every 'unavailable' view must be: calm words, the one sentence, a way back, and none of the generic failure copy. */
function expectCalmUnavailable(): void {
  expect(pageText()).toContain(UNAVAILABLE_EN);
  expect(pageText()).toContain(SENTENCE_EN);
  for (const generic of GENERIC) expect(pageText()).not.toContain(generic);
  expect(pageText()).not.toContain('The AI video coach is not available.'); // the server's own text is never shown
  expect(pageText()).not.toContain('The video coach is switched off.');
  expect(screen.queryByRole('alert') === null).toBe(true); // a red alert would be scary
  const back = screen.getAllByRole('link', { name: 'Back to training' }) as HTMLAnchorElement[];
  expect(back).toHaveLength(1);
  expect(back[0]?.getAttribute('href')).toBe('/train');
}

// --- 503 ai_unavailable ---------------------------------------------------------------------------------------------------

describe('503 ai_unavailable (no key, AI off, provider down)', () => {
  test('says the analysis is unavailable, calmly, with the one sentence and the way back; not the generic failure', async () => {
    analysisAnswers = [SERVER_PROBLEMS.noKey503];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    expect(await screen.findByText(UNAVAILABLE_EN)).toBeTruthy();
    expectCalmUnavailable();
    expect(view.world.navigate).not.toHaveBeenCalled();
  });

  test('offers Try again, which resends the SAME request (same client uuid) and goes on to the result when the server is back', async () => {
    const requests: unknown[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes('/api/player/video-analyses')) requests.push(init?.body);
      return inner(input, init);
    }) as unknown as typeof fetch;
    analysisAnswers = [SERVER_PROBLEMS.noKey503, () => json(ANALYSIS)];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    await screen.findByText(UNAVAILABLE_EN);
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(view.world.navigate).toHaveBeenCalled());
    expect(posts).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0] as never);
  });

  test('keeps the pictures and the way to delete them and start again, so a player can leave without sending anything', async () => {
    analysisAnswers = [SERVER_PROBLEMS.noKey503];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    await screen.findByText(UNAVAILABLE_EN);
    expect(hasRole('button', 'Delete and start again')).toBe(true);
    expect(screen.getAllByRole('img')).toHaveLength(5);
  });

  test('a 503 without the ai_unavailable type is the same calm message (the status is what the player needs to hear)', async () => {
    analysisAnswers = [SERVER_PROBLEMS.bare503];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    await screen.findByText(UNAVAILABLE_EN);
    expectCalmUnavailable();
    expect(hasRole('button', 'Try again')).toBe(true);
  });

  test('a 504 (the analysis took too long) is NOT this message: it keeps the generic failure', async () => {
    analysisAnswers = [SERVER_PROBLEMS.timeout504];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    expect(text(await screen.findByRole('alert'))).toContain('We could not get your feedback');
    expect(pageText()).not.toContain(UNAVAILABLE_EN);
  });
});

// --- 403 Video coach disabled -----------------------------------------------------------------------------------------------

describe('403 Video coach disabled', () => {
  test('says the same calm message, with no retry loop: no Try again and no Send, one request only', async () => {
    analysisAnswers = [SERVER_PROBLEMS.disabled403];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    expect(await screen.findByText(UNAVAILABLE_EN)).toBeTruthy();
    expectCalmUnavailable();
    expect(hasRole('button', 'Try again')).toBe(false);
    expect(hasRole('button', 'Send for analysis')).toBe(false);
    expect(posts).toBe(1);
  });

  test('drops the pictures (nothing is left to send) and does not navigate', async () => {
    analysisAnswers = [SERVER_PROBLEMS.disabled403];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    await screen.findByText(UNAVAILABLE_EN);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(view.world.navigate).not.toHaveBeenCalled();
  });

  test('a 403 "consent required" is still the consent gate, never this message', async () => {
    analysisAnswers = [
      () => {
        consentsHeld = REVOKED; // the server says it, and the consents read after it agree
        return SERVER_PROBLEMS.consent403();
      },
    ];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    expect(await screen.findByRole('heading', { name: messages.en.gate.title })).toBeTruthy();
    expect(pageText()).not.toContain(UNAVAILABLE_EN);
  });
});

// --- 502, 413, 422 keep their existing messages -------------------------------------------------------------------------------

describe('502, 413 and 422 keep their existing messages', () => {
  test('502: the generic failure with the server-side words and Try again, not the unavailable message', async () => {
    analysisAnswers = [SERVER_PROBLEMS.bad502];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not get your feedback');
    expect(text(alert)).toContain(problemMessages.en.server);
    expect(pageText()).not.toContain(UNAVAILABLE_EN);
    expect(hasRole('button', 'Try again')).toBe(true);
  });

  test('413: the "too large" words under the same title, not the unavailable message', async () => {
    analysisAnswers = [SERVER_PROBLEMS.large413];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not get your feedback');
    expect(text(alert)).toContain(problemMessages.en.tooLarge);
    expect(pageText()).not.toContain(UNAVAILABLE_EN);
  });

  test('422: the field-check words under the same title, not the unavailable message', async () => {
    analysisAnswers = [SERVER_PROBLEMS.invalid422];
    const view = renderVideo(makeWorld());
    await sendClip(view);
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('We could not get your feedback');
    expect(text(alert)).toContain(problemMessages.en.validation);
    expect(pageText()).not.toContain(UNAVAILABLE_EN);
  });
});

// --- kk / ru ------------------------------------------------------------------------------------------------------------------

describe('kk and ru', () => {
  for (const locale of ['kk', 'ru'] as const) {
    for (const [name, answer] of [
      ['503', SERVER_PROBLEMS.noKey503],
      ['403 disabled', SERVER_PROBLEMS.disabled403],
    ] as const) {
      test(`${locale} ${name}: the title and the one sentence are Cyrillic words of their own, with the way back and no leaks`, async () => {
        analysisAnswers = [answer];
        const view = renderVideo(makeWorld(), locale);
        await sendClip(view, locale);
        const m = messages[locale];
        expect(await screen.findByText(m.analysisDown.title)).toBeTruthy();
        expect(pageText()).toContain(m.analysisDown.hint);
        expect(/[Ѐ-ӿ]/.test(m.analysisDown.title)).toBe(true);
        expect(m.analysisDown.title).not.toBe(messages.en.analysisDown.title);
        expect(m.analysisDown.hint.split(/[.!?]/).filter((part) => part.trim() !== '')).toHaveLength(1); // ONE sentence
        expect(screen.queryByRole('alert') === null).toBe(true);
        expect((screen.getByRole('link', { name: m.optional.back }) as HTMLAnchorElement).getAttribute('href')).toBe('/train');
        for (const leak of ['undefined', 'NaN', '{{', '[object', 'analysisDown']) expect(pageText()).not.toContain(leak);
      });
    }
  }

  test('the en copy is the exact wording the bead asks for', () => {
    expect(messages.en.analysisDown.title).toBe(UNAVAILABLE_EN);
    expect(messages.en.analysisDown.hint).toBe(SENTENCE_EN);
  });
});
