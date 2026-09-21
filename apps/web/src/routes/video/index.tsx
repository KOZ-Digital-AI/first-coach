import { StartResponse } from '@api-types/onboarding';
import { Consents, ENDPOINTS as PRIVACY } from '@api-types/privacy';
import {
  CONSENT_REQUIRED_TITLE,
  CreateVideoAnalysisRequest,
  type CreateVideoAnalysisResponse,
  DURATION_SEC_MAX,
  DURATION_SEC_MIN,
  ENDPOINTS as VIDEO,
  KEYFRAME_MAX_COUNT,
  KEYFRAME_MIN_COUNT,
  type Rubric,
  type RerecordReason,
  VIDEO_ANALYSIS_TIMEOUT_MS,
} from '@api-types/video';
import { type QueryClient, type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Camera, Check, CircleAlert, FileVideo, ShieldCheck, Square, X } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';
import { extractFeatures, type PoseFrame } from '../../video/features';
import { type KeyframeVideo, sampleKeyframes as sampleDomKeyframes, seekVideo } from '../../video/keyframes';
import { detectOnVideo, load as loadPoseModel, PoseError, type PoseVideo } from '../../video/pose';

/**
 * /video: the Beta AI Video Coach capture screen. An Operate-mode screen, one calm column at 360px. Optional by design: it is one
 * page with one way out (Back to training) that never blocks or gates training. Words: features/video/capture.messages.ts.
 *
 * CHILD PRIVACY (risk:privacy). The video never leaves the device. This file has no upload of a clip, no persistence and no
 * logging of one:
 *  - the clip (a File or a recorded Blob) lives only in `analyseClip`'s closure and behind `LoadedClip`; `release()` is called on
 *    EVERY path out (rejected, cancelled, failed, done, unmounted) and, on the happy path, as soon as the pictures are cut,
 *    i.e. before the player is even asked to send;
 *  - what is sent is `CreateVideoAnalysisRequest`: 3..6 small keyframes (blurred face, see video/keyframes.ts) + pose features
 *    (video/features.ts), parsed with the shared strict schema first, so a stray `video` key can never be posted;
 *  - the request holds the keyframes in component state only while the player looks at them (review) and is dropped at the result,
 *    at Delete and at unmount. React Query is used for the rubric, the consents and the age ONLY; the analysis goes through an
 *    ordinary async function (not useMutation, which would keep the variables, i.e. the pictures, in the mutation cache) and its
 *    answer stays in state. No query key of this screen is on lib/query-persist's allow-list ('video' is not on it), nothing is
 *    written to localStorage/sessionStorage/IndexedDB, and the camera asks for NO audio.
 *
 * Only `Route` and the small VideoDepsContext seam are exported (the route splitter leaves other exports in the entry chunk; see
 * routes/train/index.tsx for the same seam). The seam replaces the parts a test cannot run under happy-dom: the pose model, the
 * camera, the video decoder, the canvas sampler and the analysis call (POST /api/player/video-analyses, fc-mol-8nt.5, built
 * concurrently: the default is one api.post against the shared contract).
 *
 * Flow: skill pick -> consent gate -> tips (rubric) + record/choose -> on-device reading with a progress bar and Cancel ->
 * review (the pictures that will be sent) -> send -> the RESULT SCREEN /video/result/:id (routes/video/result.$id.tsx).
 * Readings of the criteria where they are open, and gaps found:
 *  - THE HAND-OVER (fc-mol-8nt.12). The answer is not rendered here: `handOver` drops everything this screen holds (the clip, the
 *    camera, the pictures: the phase becomes a bare 'leaving' status) and THEN navigates. A finished analysis invalidates
 *    ['video','analyses'] (the history the result screen reads it from) and goes to /video/result/<analysis.id>. A rerecord answer
 *    (the server's, or the device's own "not seen well enough") has no stored analysis, hence no id: it goes to
 *    /video/result/rerecord?rerecord=<reason>&skill=<the picked skill>, the search contract of the result screen. The analysis is
 *    never put into the query cache from here. The navigation is a seam (`navigate`, default: the router) like the others.
 *  - THE PICK LIST. There is no endpoint that lists rubrics, so the five skills the seed has a rubric for are listed here, worded
 *    in the messages file. The rubric request is the truth: a skill without one (404) is an empty state.
 *  - THE CONSENT GATE comes after the pick and before the rubric, camera and model (nothing is requested or loaded before it opens).
 *    It opens only when GET /api/player/consents says videoAnalysis is granted AND (guardianConfirmed OR age >= 13). The age comes
 *    from GET /api/player/me (the privacy screen's own query, only asked when it is needed); an age that cannot be read is an error
 *    and "no plan yet" (404/401) sends the player to the setup: never a guess. Granting is done in /settings/privacy (linked).
 *    Call budget: rubric + analysis is 2 calls as the contract says; the gate adds the consents call (and /me when needed).
 *  - THE SETTING videoCoachEnabled has no public endpoint (contract gap): it shows as a 403 of the analysis whose title is not
 *    'consent required' (that title sends the player back to the gate). So a disabled feature is only learned at Send.
 *  - UNAVAILABLE (fc-mol-8nt.13). That 403 and the 503 (`ai_unavailable`: no key / AI off) both show the calm block 'Video analysis is
 *    unavailable right now' (one sentence: the rest of the app works, training is not affected; a link back to training inside it).
 *    A 503 keeps the review (the pictures) and offers Try again; the 403 has no retry. Never the generic failure copy or a red alert.
 *    502 / 504 / 413 / 422 keep the generic 'We could not get your feedback'.
 *  - DURATION. "10-30 s, both inclusive" is checked on the clip itself (its decoded duration, rounded to 0.1 s), for a chosen file
 *    and a recording alike. A recording cannot be stopped before 11 s and stops itself at 29 s, so MediaRecorder's timing error
 *    never lands outside the limits. The elapsed time is read from an injectable clock (default performance.now()).
 *  - NOT SEEN WELL. Mean visibility below the rubric's minVisibility (or nobody detected, or fewer than 3 frames with a person) is
 *    answered ON THE DEVICE with the 'rerecord' hint and nothing is sent. The server's own rerecord answer is shown the same way.
 *  - SAMPLING. 6 frames per second (inside the 5-10 the pose module accepts; cheap Android phones); 5 keyframes (3..6).
 *    keyframes.ts' seek has no timeout, so the screen hands it a guarded one (10 s, and it refuses to start after Cancel).
 *  - CANCEL. Reading cannot be interrupted inside pose.ts, so Cancel flags the run: the next progress callback throws, and every
 *    later step of the run is skipped. Cancel while sending aborts the request and returns to the review.
 *  - SEND. The analysis is aborted after VIDEO_ANALYSIS_TIMEOUT_MS (the contract's 60 s) as a network failure. A failed send keeps
 *    the SAME request, so Try again resends the same clientUuid (the server is idempotent by it).
 *  - CONSENT AT SEND TIME. The server's 403 is not the only enforcement: right before `analyse` the consents (and, when no guardian
 *    has confirmed, the age) are read FRESH (readGateNow), so a stale cache never authorises a send. Revoked / guardian missing:
 *    nothing is sent, the pictures are dropped and the gate is shown; a read that fails: nothing is sent and the error shows (Try
 *    again reads again). Coming back to a tab where the consent was revoked refetches the consents on focus, and a gate that is no
 *    longer open closes the review (and aborts a request that is out) by itself; Send is disabled meanwhile.
 */

// --- constants ------------------------------------------------------------------------------------------------------------

/** The five skills that have a rubric in the seed (config/commons/<sport>/rubrics.json). */
const SKILLS = ['dribbling', 'ball-mastery', 'passing-first-touch', 'weak-foot', 'juggling-coordination'] as const;
type SkillSlug = (typeof SKILLS)[number];

/** Frames per second of the on-device reading (pose.ts accepts 5..10). */
const SAMPLE_FPS = 6;
/** Pictures cut from the clip (the contract wants 3..6). */
const KEYFRAME_COUNT = 5;
const COUNTDOWN_SEC = 3;
/** A recording can be stopped from here and stops itself at RECORD_MAX_SEC: one second inside each limit. */
const RECORD_MIN_SEC = DURATION_SEC_MIN + 1;
const RECORD_MAX_SEC = DURATION_SEC_MAX - 1;
const DEFAULT_SEEK_TIMEOUT_MS = 10_000;
/** Below this age the guardian rule applies (the contract's isConsentUpdateAllowed pins the same number on the server). */
const GUARDIAN_BELOW_AGE = 13;

const CONSENTS_KEY = ['consents'] as const;
/** The privacy and plan screens' own key; only the age is read from it. */
const ME_KEY = ['me'] as const;
const ME_PATH = '/api/player/me';
/** The history the result screen finds an analysis in (routes/video/result.$id.tsx owns the key); invalidated when one is added. */
const ANALYSES_KEY = ['video', 'analyses'] as const;
/** NOT on lib/query-persist's allow-list, on purpose: nothing of this screen is ever saved to the device. */
const rubricKey = (skill: string, locale: string) => ['video', 'rubric', skill, locale] as const;

// --- the seam -------------------------------------------------------------------------------------------------------------

/** The clip, decoded on the device. Never uploaded. `release()` frees it and must be safe to call more than once. */
export interface LoadedClip {
  video: PoseVideo & KeyframeVideo;
  /** Seconds; finite. */
  durationSec: number;
  release(): void;
}

/** A camera stream with a recorder on it. Records no audio. */
export interface CameraSession {
  /** The live picture for the preview; null when there is none to show. */
  stream: MediaStream | null;
  start(): void;
  /** Stops the recorder, stops the camera and resolves the recorded clip. */
  stop(): Promise<Blob>;
  /** Stops the camera and drops anything recorded, without a result. Safe to call more than once. */
  release(): void;
}

/** `open` rejects like getUserMedia does (NotAllowedError = blocked, anything else = not available). */
export interface Camera {
  open(): Promise<CameraSession>;
}

/** Where the result screen is: /video/result/$id, and for a rerecord answer its search (see routes/video/result.$id.tsx). */
export interface ResultTarget {
  /** The analysis id, or the literal 'rerecord' (a rerecord answer is not stored, so it has no id). */
  id: string;
  search?: { rerecord: RerecordReason; skill?: string };
}

export interface VideoDeps {
  pose?: { load(): Promise<void>; detectOnVideo(video: PoseVideo, fps?: number, onProgress?: (fraction: number) => void): Promise<PoseFrame[]> };
  loadClip?: (blob: Blob) => Promise<LoadedClip>;
  sampleKeyframes?: typeof sampleDomKeyframes;
  /** null = this device has no camera or no MediaRecorder. Absent = detect it. */
  camera?: Camera | null;
  /** Goes to the result screen. Default: the router's navigate (a router that cannot be reached is a failed navigation). */
  navigate?: (target: ResultTarget) => void | Promise<unknown>;
  /** POST /api/player/video-analyses. */
  analyse?: (request: CreateVideoAnalysisRequest, signal: AbortSignal) => Promise<CreateVideoAnalysisResponse>;
  online?: () => boolean;
  /** Whether this device can run the pose model at all (WebAssembly and a video element). */
  canDetectPose?: () => boolean;
  /** Time source for the countdown and the recording, polled every `pollMs`. */
  clock?: { now(): number; pollMs: number };
  seekTimeoutMs?: number;
  analyseTimeoutMs?: number;
}

/** Test seam and default: nothing in the app provides it, so the browser implementations below apply. */
export const VideoDepsContext = createContext<VideoDeps>({});

type ResolvedDeps = Required<Omit<VideoDeps, 'camera' | 'navigate'>> & { camera: Camera | null };

// --- the browser implementations ------------------------------------------------------------------------------------------

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

const browserCanDetectPose = (): boolean =>
  typeof WebAssembly === 'object' && typeof document !== 'undefined' && typeof document.createElement('video').canPlayType === 'function';

const browserClock = { now: () => performance.now(), pollMs: 200 };

function waitFor(target: EventTarget, events: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (settle: () => void) => {
      clearTimeout(timer);
      for (const name of [...events, 'error']) target.removeEventListener(name, onEvent);
      settle();
    };
    const onEvent = (event: Event) => done(event.type === 'error' ? () => reject(new Error('media error')) : resolve);
    const timer = setTimeout(() => done(() => reject(new Error('media timeout'))), timeoutMs);
    for (const name of [...events, 'error']) target.addEventListener(name, onEvent);
  });
}

/**
 * Opens the clip in an off-screen <video> from an object URL that is revoked on release: the bytes stay on the device. A
 * MediaRecorder file reports an infinite duration until the end has been seen, so it is seeked to the end and back to get one.
 * (Not testable under happy-dom, which cannot decode media: covered by the browser QA of this bead.)
 */
async function loadDomClip(blob: Blob): Promise<LoadedClip> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const release = (): void => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    const metadata = waitFor(video, ['loadedmetadata'], 15_000);
    video.src = url;
    await metadata;
    if (!Number.isFinite(video.duration)) {
      const seenEnd = waitFor(video, ['timeupdate', 'durationchange'], 10_000);
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await seenEnd;
      if (video.currentTime !== 0) {
        const back = waitFor(video, ['seeked'], 10_000);
        video.currentTime = 0;
        await back;
      }
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('no usable duration');
    return { video, durationSec: video.duration, release };
  } catch (error) {
    release();
    throw error;
  }
}

const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'] as const;

async function openBrowserCamera(): Promise<CameraSession> {
  // No audio, ever: the coach looks at movement only.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const stopTracks = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };
  try {
    const mimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType === undefined ? {} : { mimeType }), videoBitsPerSecond: 2_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    return {
      stream,
      start: () => recorder.start(1000),
      stop: () =>
        new Promise<Blob>((resolve, reject) => {
          if (recorder.state === 'inactive') {
            stopTracks();
            reject(new Error('recorder is not running'));
            return;
          }
          recorder.onstop = () => {
            stopTracks();
            const clip = new Blob(chunks, { type: recorder.mimeType });
            chunks.length = 0;
            resolve(clip);
          };
          recorder.onerror = () => {
            stopTracks();
            chunks.length = 0;
            reject(new Error('recorder failed'));
          };
          recorder.stop();
        }),
      release: () => {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Already stopping: the camera is stopped below either way.
          }
        }
        chunks.length = 0;
        stopTracks();
      },
    };
  } catch (error) {
    stopTracks();
    throw error;
  }
}

function browserCamera(): Camera | null {
  const supported =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  return supported ? { open: openBrowserCamera } : null;
}

const defaultAnalyse: ResolvedDeps['analyse'] = (request, signal) =>
  api.post(VIDEO.createAnalysis.path, { body: request, schema: VIDEO.createAnalysis.response, signal });

function resolveDeps(given: VideoDeps): ResolvedDeps {
  // `navigate` is not resolved here: its default needs the router, which only a component can reach.
  return {
    pose: given.pose ?? { load: loadPoseModel, detectOnVideo },
    loadClip: given.loadClip ?? loadDomClip,
    sampleKeyframes: given.sampleKeyframes ?? sampleDomKeyframes,
    camera: given.camera === undefined ? browserCamera() : given.camera,
    analyse: given.analyse ?? defaultAnalyse,
    online: given.online ?? browserOnline,
    canDetectPose: given.canDetectPose ?? browserCanDetectPose,
    clock: given.clock ?? browserClock,
    seekTimeoutMs: given.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS,
    analyseTimeoutMs: given.analyseTimeoutMs ?? VIDEO_ANALYSIS_TIMEOUT_MS,
  };
}

// --- state ----------------------------------------------------------------------------------------------------------------

/** Why the capture step shows a problem above its buttons. */
type Notice =
  | { kind: 'clip-short'; seconds: number }
  | { kind: 'clip-long'; seconds: number }
  | { kind: 'unreadable' }
  | { kind: 'read-failed' }
  | { kind: 'camera-denied' }
  | { kind: 'camera-unavailable' };

/** What the player is about to send. Held in state only while they look at it. */
type Pending = { request: CreateVideoAnalysisRequest };

type Phase =
  | { kind: 'capture'; notice?: Notice }
  | { kind: 'opening' }
  | { kind: 'countdown' }
  | { kind: 'recording' }
  | { kind: 'checking' }
  | { kind: 'processing'; progress: number }
  | { kind: 'unsupported' }
  | { kind: 'review'; pending: Pending }
  | { kind: 'sending'; pending: Pending }
  | { kind: 'send-failed'; pending: Pending; error: unknown }
  | { kind: 'leaving' }
  | { kind: 'disabled' };

/** A flag shared by one run of the on-device pipeline, so a Cancel can stop every later step of it. */
type Run = { cancelled: boolean };

class Cancelled extends Error {
  override name = 'Cancelled';
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function withTimeout<T>(work: Promise<T>, ms: number, run: Run): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (run.cancelled) {
      reject(new Cancelled('cancelled'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('the video did not answer in time')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** getUserMedia says a blocked camera with NotAllowedError (a policy block is a SecurityError). */
const isCameraBlocked = (error: unknown): boolean => {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError';
};

// --- hooks ----------------------------------------------------------------------------------------------------------------

function useOnline(read: () => boolean): boolean {
  const [online, setOnline] = useState(read);
  useEffect(() => {
    const update = () => setOnline(read());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [read]);
  return online;
}

/**
 * The failure to show. React Query clears `error` the moment a retry starts when there is no data yet; keep the last failure on
 * screen meanwhile so Try again stays put, disabled and busy, instead of flashing to skeletons.
 */
function useFailure(query: UseQueryResult<unknown>): unknown {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  if (query.data !== undefined) return null;
  return query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? last.current : null);
}

const hasNoPlan = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'unauthorized');

/**
 * The analysis endpoint says the AI side is not there: 503 (no OPENAI_API_KEY / AI off answer it with the problem type `ai_unavailable`;
 * player-video.routes.ts). Simplest reading: ANY 503 is this, whatever its `type`, because to a player a proxy's 503 means the
 * same thing. A 502 or 504 (the provider failed or was slow on THIS clip) is a failure of this send and keeps the generic copy.
 */
const isAnalysisUnavailable = (error: unknown): boolean => isApiProblem(error) && error.status === 503;

// --- shared styling -------------------------------------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK_BASE} border-line bg-paper text-ink`;

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const H3 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';
const BODY = 'm-0 text-base leading-[1.45] wrap-break-word text-ink';
const ACTIONS = 'flex flex-col gap-3 sm:flex-row';

// --- small pieces ---------------------------------------------------------------------------------------------------------

/** Words + icon, like Field's own error: a problem is never colour alone. */
function Problem({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 wrap-anywhere">
        <p className="m-0 font-bold">{title}</p>
        {hint === undefined ? null : <p className="m-0 mt-1 text-muted">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * "Video analysis is unavailable right now": the calm answer to a 503 (no key, AI off, provider down) and to the 403 'Video coach
 * disabled'. It is NOT an error state: no red, no alert icon, no role="alert" (a status, read out politely), and it never shows
 * the server's own words. ONE sentence says the rest of the app works and training is not affected, and the way back to training
 * sits in the block itself. `onRetry` is given only where trying again can help (a 503); 'disabled' has nothing to retry.
 */
function AnalysisDown({ onRetry }: { onRetry?: () => void }) {
  const { t } = useTranslation(['capture']);
  return (
    <EmptyState
      role="status"
      title={t('analysisDown.title')}
      hint={t('analysisDown.hint')}
      action={
        <div className={ACTIONS}>
          {onRetry === undefined ? null : (
            <Button className="w-full sm:w-auto" onClick={onRetry}>
              {t('review.error.retry')}
            </Button>
          )}
          <a href="/train" className={`${onRetry === undefined ? LINK_PRIMARY : LINK_SECONDARY} w-full sm:w-auto`}>
            {t('optional.back')}
          </a>
        </div>
      }
    />
  );
}

function Busy({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid gap-3">
      <p className={BODY}>{label}</p>
      {children ?? <Skeleton className="h-24 rounded-card" />}
    </div>
  );
}

/** A bar with its meaning in words and numbers beside it (the caller prints them): colour is never the only signal. */
function Bar({ label, value, max, role = 'progressbar', min = 0 }: { label: string; value: number; max: number; role?: 'progressbar' | 'meter'; min?: number }) {
  const share = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return (
    <div role={role} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} className="h-2.5 overflow-hidden rounded-pill bg-line">
      <div className="h-full rounded-pill bg-accent" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function PointList({ items, icon }: { items: readonly string[]; icon: 'check' | 'x' }) {
  const Icon = icon === 'check' ? Check : X;
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {items.map((text) => (
        <li key={text} className="flex items-start gap-3 text-base leading-[1.45] text-ink">
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{text}</span>
        </li>
      ))}
    </ul>
  );
}

// --- the consent gate -----------------------------------------------------------------------------------------------------

type GateState = 'loading' | 'error' | 'off' | 'guardian' | 'noPlan' | 'open';

const consentsQuery = () => ({
  queryKey: CONSENTS_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.get(PRIVACY.getConsents.path, { schema: Consents, signal }),
  retry: false,
});
const meQuery = () => ({
  queryKey: ME_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.get(ME_PATH, { schema: StartResponse, signal }),
  retry: false,
});

type GateInput = { consentsFailure: unknown; consents: Consents | undefined; meFailure: unknown; me: StartResponse | undefined };

/**
 * The ONE rule of the gate, used by the hook that shows it and by the fresh read made right before a send: the consents and,
 * only when a guardian has not confirmed, the age. Never a guess: what could not be read is 'error' / 'noPlan', not "open".
 */
function decideGate({ consentsFailure, consents, meFailure, me }: GateInput): GateState {
  if (consentsFailure !== null) return 'error';
  if (consents === undefined) return 'loading';
  const video = consents.videoAnalysis;
  if (!video.granted) return 'off';
  if (video.guardianConfirmed === true) return 'open';
  if (meFailure !== null) return hasNoPlan(meFailure) ? 'noPlan' : 'error';
  if (me === undefined) return 'loading';
  return me.profile.age < GUARDIAN_BELOW_AGE ? 'guardian' : 'open';
}

/** Where the player stands, from the (cached, refetched on focus) queries. */
function useGate(enabled: boolean): { state: GateState; consents: UseQueryResult<Consents>; me: UseQueryResult<StartResponse>; failure: unknown } {
  const consents = useQuery({ ...consentsQuery(), enabled });
  const video = consents.data?.videoAnalysis;
  const needsAge = video?.granted === true && video.guardianConfirmed !== true;
  const me = useQuery({ ...meQuery(), enabled: enabled && needsAge });
  const consentsFailure = useFailure(consents);
  const meFailure = useFailure(me);
  const state = decideGate({ consentsFailure, consents: consents.data, meFailure, me: me.data });
  return { state, consents, me, failure: consentsFailure ?? meFailure };
}

/**
 * The gate read FRESH from the server, made right before anything is sent: a cached "granted" (a tab that was left open, a
 * consent revoked elsewhere) must never authorise a send. It also refreshes the shared cache, so the screen shows what it found.
 * A read that fails is state 'error' with its failure, never "open".
 */
async function readGateNow(queryClient: QueryClient): Promise<{ state: GateState; failure: unknown }> {
  let consents: Consents;
  try {
    consents = await queryClient.fetchQuery({ ...consentsQuery(), staleTime: 0 });
  } catch (failure) {
    return { state: 'error', failure };
  }
  const video = consents.videoAnalysis;
  if (!video.granted || video.guardianConfirmed === true) {
    return { state: decideGate({ consentsFailure: null, consents, meFailure: null, me: undefined }), failure: null };
  }
  try {
    const me = await queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
    return { state: decideGate({ consentsFailure: null, consents, meFailure: null, me }), failure: null };
  } catch (failure) {
    return { state: decideGate({ consentsFailure: null, consents, meFailure: failure, me: undefined }), failure };
  }
}

function ConsentGate({ gate }: { gate: ReturnType<typeof useGate> }) {
  const { t } = useTranslation(['capture', 'problem']);
  const { state } = gate;
  const busy = gate.consents.isFetching || gate.me.isFetching;
  let body: ReactNode;
  if (state === 'loading') {
    body = <Busy label={t('gate.loading')} />;
  } else if (state === 'error') {
    body = (
      <ErrorState
        title={t('gate.error.title')}
        message={describeProblem(gate.failure, (key) => t(key)).formMessage}
        retryLabel={t('gate.error.retry')}
        retrying={busy}
        onRetry={() => void (gate.consents.isError ? gate.consents.refetch() : gate.me.refetch())}
      />
    );
  } else if (state === 'noPlan') {
    body = (
      <EmptyState
        title={t('gate.noPlan.title')}
        hint={t('gate.noPlan.hint')}
        action={
          <a href="/train/onboarding" className={LINK_PRIMARY}>
            {t('gate.noPlan.action')}
          </a>
        }
      />
    );
  } else {
    body = (
      <>
        <div className="grid gap-3">
          <h3 className={H3}>{t('gate.deviceTitle')}</h3>
          <PointList icon="check" items={[t('gate.device.video'), t('gate.device.reading')]} />
          <h3 className={H3}>{t('gate.sentTitle')}</h3>
          <PointList icon="check" items={[t('gate.sent.pictures'), t('gate.sent.numbers'), t('gate.sent.provider')]} />
          <p className={BODY}>{t('gate.beta')}</p>
        </div>
        <div className="grid gap-2 rounded-control border border-line bg-paper p-4">
          <p className="m-0 flex items-start gap-2 text-xl leading-tight font-bold tracking-tight text-ink">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 wrap-anywhere">{state === 'guardian' ? t('gate.guardian.title') : t('gate.off.title')}</span>
          </p>
          <p className="m-0 text-base text-muted">{state === 'guardian' ? t('gate.guardian.hint') : t('gate.off.hint')}</p>
          <div className={`${ACTIONS} mt-2`}>
            <a href="/settings/privacy" className={LINK_PRIMARY}>
              {t('gate.open')}
            </a>
            <Button variant="secondary" loading={busy} onClick={() => void gate.consents.refetch()}>
              {t('gate.recheck')}
            </Button>
          </div>
        </div>
      </>
    );
  }
  return (
    <section aria-labelledby="gate-title" className="grid gap-4">
      <h2 id="gate-title" data-step-heading tabIndex={-1} className={H2}>
        {t('gate.title')}
      </h2>
      {body}
    </section>
  );
}

// --- the capture step -----------------------------------------------------------------------------------------------------

function NoticeView({ notice, locale }: { notice: Notice; locale: 'kk' | 'ru' | 'en' }) {
  const { t } = useTranslation('capture');
  switch (notice.kind) {
    case 'clip-short':
      return <Problem title={t('clip.short', { seconds: formatNumber(notice.seconds, locale) })} hint={t('clip.hint')} />;
    case 'clip-long':
      return <Problem title={t('clip.long', { seconds: formatNumber(notice.seconds, locale) })} hint={t('clip.hint')} />;
    case 'unreadable':
      return <Problem title={t('clip.unreadable')} hint={t('clip.unreadableHint')} />;
    case 'read-failed':
      return <Problem title={t('failed.title')} hint={t('failed.hint')} />;
    case 'camera-denied':
      return <Problem title={t('capture.camera.denied.title')} hint={t('capture.camera.denied.hint')} />;
    case 'camera-unavailable':
      return <Problem title={t('capture.camera.unavailable.title')} hint={t('capture.camera.unavailable.hint')} />;
  }
}

type CaptureProps = {
  rubric: UseQueryResult<Rubric>;
  canRecord: boolean;
  notice: Notice | undefined;
  locale: 'kk' | 'ru' | 'en';
  onRecord: () => void;
  onFile: (file: File) => void;
};

function CaptureStep({ rubric, canRecord, notice, locale, onRecord, onFile }: CaptureProps) {
  const { t } = useTranslation(['capture', 'problem']);
  const failure = useFailure(rubric);
  let body: ReactNode;
  if (rubric.data !== undefined) {
    const data = rubric.data;
    body = (
      <>
        <div className="grid gap-3">
          <h3 className={H3}>{t('capture.tipsTitle')}</h3>
          <PointList icon="check" items={data.recordingTips} />
          <h3 className={H3}>{t('capture.criteriaTitle')}</h3>
          <ul className="m-0 grid list-none gap-2 p-0">
            {data.criteria.map((criterion) => (
              <li key={criterion.key} className={BODY}>
                <span className="font-bold">{criterion.label}</span>
                {criterion.description === '' ? null : <span className="text-muted">{`: ${criterion.description}`}</span>}
              </li>
            ))}
          </ul>
          <p className={BODY}>{t('capture.limits')}</p>
        </div>
        {notice === undefined ? null : <NoticeView notice={notice} locale={locale} />}
        {canRecord ? null : <p className={`${BODY} text-muted`}>{t('capture.noCamera')}</p>}
        <div className={ACTIONS}>
          {canRecord ? (
            <Button className="w-full sm:w-auto" onClick={onRecord}>
              <Camera aria-hidden="true" className="size-5 shrink-0" />
              {t('capture.record')}
            </Button>
          ) : null}
          <label
            className={`${LINK_SECONDARY} w-full cursor-pointer gap-2 sm:w-auto has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent`}
          >
            <FileVideo aria-hidden="true" className="size-5 shrink-0" />
            {t('capture.choose')}
            <input
              type="file"
              accept="video/*"
              className="sr-only"
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                input.value = ''; // the input must not keep the clip either
                if (file !== undefined) onFile(file);
              }}
            />
          </label>
        </div>
      </>
    );
  } else if (failure !== null) {
    body =
      isApiProblem(failure) && failure.kind === 'not_found' ? (
        <EmptyState title={t('capture.empty.title')} hint={t('capture.empty.hint')} />
      ) : (
        <ErrorState
          title={t('capture.error.title')}
          message={describeProblem(failure, (key) => t(key)).formMessage}
          retryLabel={t('capture.error.retry')}
          retrying={rubric.isFetching}
          onRetry={() => void rubric.refetch()}
        />
      );
  } else {
    body = <Busy label={t('capture.loading')} />;
  }
  return (
    <section aria-labelledby="capture-title" className="grid gap-4">
      <h2 id="capture-title" data-step-heading tabIndex={-1} className={H2}>
        {t('capture.title')}
      </h2>
      {body}
    </section>
  );
}

// --- recording ------------------------------------------------------------------------------------------------------------

function Preview({ stream }: { stream: MediaStream | null }) {
  const { t } = useTranslation('capture');
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current !== null && stream !== null) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      autoPlay
      aria-label={t('recording.preview')}
      className="aspect-[3/4] max-h-[60vh] w-full rounded-card bg-ink object-cover"
    />
  );
}

type RecorderProps = {
  phase: 'countdown' | 'recording';
  countdownLeft: number;
  elapsed: number;
  stream: MediaStream | null;
  locale: 'kk' | 'ru' | 'en';
  onStop: () => void;
  onCancel: () => void;
};

function RecorderView({ phase, countdownLeft, elapsed, stream, locale, onStop, onCancel }: RecorderProps) {
  const { t } = useTranslation('capture');
  const seconds = Math.floor(elapsed);
  const canStop = elapsed >= RECORD_MIN_SEC;
  return (
    <section aria-label={t('capture.title')} className="grid gap-4">
      <Preview stream={stream} />
      {phase === 'countdown' ? (
        <div role="status" aria-label={t('recording.countdown')} className="grid gap-1">
          <p className={BODY}>{t('recording.countdown')}</p>
          <p className="m-0 text-[64px] leading-none font-extrabold tracking-[-.08em] text-ink">{formatNumber(countdownLeft, locale)}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          <p role="status" className={`${H3}`}>
            {t('recording.elapsed', { seconds: formatNumber(seconds, locale) })}
          </p>
          <Bar label={t('recording.progress')} value={Math.min(seconds, RECORD_MAX_SEC)} max={RECORD_MAX_SEC} />
          {canStop ? null : (
            <p className={`${BODY} text-muted`}>{t('recording.keepGoing', { seconds: formatNumber(Math.max(1, Math.ceil(RECORD_MIN_SEC - elapsed)), locale) })}</p>
          )}
        </div>
      )}
      <div className={ACTIONS}>
        {phase === 'recording' ? (
          <Button className="w-full sm:w-auto" disabled={!canStop} onClick={onStop}>
            <Square aria-hidden="true" className="size-5 shrink-0" />
            {t('recording.stop')}
          </Button>
        ) : null}
        <Button variant="secondary" className="w-full sm:w-auto" onClick={onCancel}>
          {t('recording.cancel')}
        </Button>
      </div>
    </section>
  );
}

// --- review -------------------------------------------------------------------------------------------------------

type ReviewProps = {
  phase: Extract<Phase, { kind: 'review' | 'sending' | 'send-failed' }>;
  /** False while the consent (or, under 13, the guardian) is not confirmed: Send is disabled and the screen is on its way to the gate. */
  canSend: boolean;
  onSend: () => void;
  onCancelSending: () => void;
  onDiscard: () => void;
};

function ReviewStep({ phase, canSend, onSend, onCancelSending, onDiscard }: ReviewProps) {
  const { t } = useTranslation(['capture', 'problem']);
  const { keyframes } = phase.pending.request;
  const sending = phase.kind === 'sending';
  return (
    <section aria-labelledby="review-title" className="grid gap-4">
      <h2 id="review-title" data-step-heading tabIndex={-1} className={H2}>
        {t('review.title')}
      </h2>
      <p className={BODY}>{t('review.lead')}</p>
      <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0 sm:grid-cols-5">
        {keyframes.map((frame, index) => (
          <li key={frame.data.slice(0, 64) + String(index)} className="min-w-0">
            <img
              alt={t('review.picture', { n: index + 1, total: keyframes.length })}
              src={`data:${frame.mimeType};base64,${frame.data}`}
              width={frame.width}
              height={frame.height}
              className="h-auto w-full rounded-control border border-line bg-paper"
            />
          </li>
        ))}
      </ul>
      {sending ? (
        <div role="status" aria-busy="true" aria-label={t('review.sending')}>
          <p className={BODY}>{t('review.sending')}</p>
        </div>
      ) : null}
      {phase.kind === 'send-failed' && isAnalysisUnavailable(phase.error) ? <AnalysisDown onRetry={onSend} /> : null}
      {phase.kind === 'send-failed' && !isAnalysisUnavailable(phase.error) ? (
        <ErrorState
          title={t('review.error.title')}
          message={describeProblem(phase.error, (key) => t(key)).formMessage}
          retryLabel={t('review.error.retry')}
          onRetry={onSend}
        />
      ) : null}
      <div className={ACTIONS}>
        {phase.kind === 'send-failed' ? null : (
          <Button className="w-full sm:w-auto" loading={sending} disabled={!canSend} onClick={onSend}>
            {t('review.send')}
          </Button>
        )}
        {sending ? (
          <Button variant="secondary" className="w-full sm:w-auto" onClick={onCancelSending}>
            {t('review.cancelSending')}
          </Button>
        ) : null}
        <Button variant="ghost" className="w-full sm:w-auto" disabled={sending} onClick={onDiscard}>
          {t('review.discard')}
        </Button>
      </div>
    </section>
  );
}

// --- the page -------------------------------------------------------------------------------------------------------------

function VideoPage() {
  const { t, i18n } = useTranslation(['capture', 'problem']);
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const queryClient = useQueryClient();
  const given = useContext(VideoDepsContext);
  const deps = useMemo(() => resolveDeps(given), [given]);
  const online = useOnline(deps.online);
  const canDetect = useMemo(() => deps.canDetectPose(), [deps]);
  // Without a RouterProvider (and no seam) there is nowhere to go: the navigation fails and the screen falls back to the capture step.
  const router = useRouter({ warn: false });
  const navigate: NonNullable<VideoDeps['navigate']> =
    given.navigate ??
    ((target) =>
      router === undefined
        ? Promise.reject(new Error('no router'))
        : router.navigate({ to: '/video/result/$id', params: { id: target.id }, search: target.search ?? {} }));

  const [skill, setSkill] = useState<SkillSlug | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'capture' });
  const [countdownLeft, setCountdownLeft] = useState(COUNTDOWN_SEC);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const gate = useGate(skill !== null);
  const gateOpen = gate.state === 'open';
  const rubric = useQuery({
    queryKey: rubricKey(skill ?? '', locale),
    queryFn: ({ signal }) => api.get(`${VIDEO.getRubric.path.replace(':skillSlug', encodeURIComponent(skill ?? ''))}?locale=${locale}`, { schema: VIDEO.getRubric.response, signal }),
    enabled: skill !== null && gateOpen && phase.kind === 'capture',
    retry: false,
    staleTime: 5 * 60_000,
  });

  // What the async pipeline reads: always the latest render's values, never a stale closure.
  const latest = useRef({ skill, rubric: rubric.data, deps, locale, queryClient, gateState: gate.state, navigate });
  latest.current = { skill, rubric: rubric.data, deps, locale, queryClient, gateState: gate.state, navigate };
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const mounted = useRef(true);
  const run = useRef<Run | null>(null);
  const clip = useRef<LoadedClip | null>(null);
  const session = useRef<CameraSession | null>(null);
  const opening = useRef<object | null>(null);
  const sending = useRef<AbortController | null>(null);
  const model = useRef<Promise<void> | null>(null);

  function releaseClip(): void {
    clip.current?.release();
    clip.current = null;
  }
  function releaseCamera(): void {
    session.current?.release();
    session.current = null;
    setStream(null);
  }
  /**
   * Hands the answer to the result screen. Everything this screen holds is dropped FIRST (the clip, the camera, and with the phase
   * the pictures), and only then does it navigate: nothing of the capture travels with the player. If the navigation fails the
   * player is back at the capture step (the pictures are gone; a new clip is the way on).
   */
  function handOver(target: ResultTarget): void {
    releaseClip();
    releaseCamera();
    setPhase({ kind: 'leaving' });
    let moving: void | Promise<unknown>;
    try {
      moving = latest.current.navigate(target);
    } catch (error) {
      moving = Promise.reject(error);
    }
    Promise.resolve(moving).catch(() => {
      if (mounted.current) setPhase({ kind: 'capture' });
    });
  }
  function cancelWork(): void {
    if (run.current !== null) run.current.cancelled = true;
    releaseClip();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (run.current !== null) run.current.cancelled = true;
      opening.current = null;
      clip.current?.release();
      clip.current = null;
      session.current?.release();
      session.current = null;
      sending.current?.abort();
      sending.current = null;
    };
  }, []);

  /** The model is loaded once, and only when a clip is coming; a failed load can be tried again. */
  function ensureModel(): Promise<void> {
    model.current ??= latest.current.deps.pose.load().catch((error: unknown) => {
      model.current = null;
      throw error;
    });
    return model.current;
  }

  // --- the on-device pipeline: clip -> pictures + numbers -> review ---

  async function analyseClip(blob: Blob): Promise<void> {
    const token: Run = { cancelled: false };
    run.current = token;
    const { deps: d, skill: chosen } = latest.current;
    const fail = (notice: Notice): void => {
      releaseClip();
      if (!token.cancelled && mounted.current) setPhase({ kind: 'capture', notice });
    };
    setPhase({ kind: 'checking' });

    let loaded: LoadedClip;
    try {
      loaded = await d.loadClip(blob);
    } catch {
      if (!token.cancelled && mounted.current) setPhase({ kind: 'capture', notice: { kind: 'unreadable' } });
      return;
    }
    if (token.cancelled || !mounted.current) {
      loaded.release();
      return;
    }
    clip.current = loaded;

    const seconds = round1(loaded.durationSec);
    if (seconds < DURATION_SEC_MIN) return fail({ kind: 'clip-short', seconds });
    if (seconds > DURATION_SEC_MAX) return fail({ kind: 'clip-long', seconds });

    setPhase({ kind: 'processing', progress: 0 });
    try {
      await ensureModel();
    } catch {
      releaseClip();
      if (!token.cancelled && mounted.current) setPhase(d.online() ? { kind: 'unsupported' } : { kind: 'capture' });
      return;
    }
    if (token.cancelled) return;

    let frames: PoseFrame[];
    try {
      frames = await d.pose.detectOnVideo(loaded.video, SAMPLE_FPS, (fraction) => {
        if (token.cancelled) throw new Cancelled('cancelled');
        setPhase({ kind: 'processing', progress: Math.round(Math.min(1, Math.max(0, fraction)) * 90) });
      });
    } catch (error) {
      if (token.cancelled) return;
      releaseClip();
      if (mounted.current) setPhase(error instanceof PoseError && error.code === 'load_failed' ? { kind: 'unsupported' } : { kind: 'capture', notice: { kind: 'read-failed' } });
      return;
    }
    if (token.cancelled) return;

    // Nobody (or too little of anybody) in the clip is answered here, on the device: nothing is cut and nothing is sent.
    const minVisibility = latest.current.rubric?.minVisibility ?? 0;
    const seen = frames.filter((frame) => frame.landmarks.length > 0);
    const ratio = loaded.video.videoWidth / loaded.video.videoHeight;
    const features = extractFeatures(frames, Number.isFinite(ratio) && ratio > 0 ? { aspectRatio: ratio } : {});
    if (features === null || seen.length < KEYFRAME_MIN_COUNT || features.meanVisibility < minVisibility) {
      releaseClip();
      if (mounted.current) handOver({ id: 'rerecord', search: { rerecord: 'low_visibility', ...(chosen === null ? {} : { skill: chosen }) } });
      return;
    }

    setPhase({ kind: 'processing', progress: 92 });
    let keyframes: Awaited<ReturnType<ResolvedDeps['sampleKeyframes']>>;
    try {
      keyframes = await d.sampleKeyframes(
        loaded.video,
        seen.map((frame) => ({ timeSec: frame.timeMs / 1000, landmarks: frame.landmarks })),
        Math.min(KEYFRAME_COUNT, KEYFRAME_MAX_COUNT, seen.length),
        { seek: (video, timeSec) => withTimeout(seekVideo(video, timeSec), d.seekTimeoutMs, token) },
      );
    } catch {
      if (token.cancelled) return;
      releaseClip();
      if (mounted.current) setPhase({ kind: 'capture', notice: { kind: 'read-failed' } });
      return;
    }
    if (token.cancelled) return;

    // The pictures are cut: the clip is no longer needed, so it is freed BEFORE the player is asked to send anything.
    releaseClip();
    const request = CreateVideoAnalysisRequest.safeParse({
      skillSlug: chosen,
      rubricVersion: latest.current.rubric?.version,
      durationSec: seconds,
      features,
      keyframes,
      clientUuid: crypto.randomUUID(),
    });
    if (!mounted.current) return;
    setPhase(request.success ? { kind: 'review', pending: { request: request.data } } : { kind: 'capture', notice: { kind: 'read-failed' } });
  }

  // --- recording ---

  async function startRecording(): Promise<void> {
    const camera = latest.current.deps.camera;
    // `opening` is set synchronously, so a second tap in the same tick cannot open the camera twice.
    if (camera === null || opening.current !== null || phaseRef.current.kind !== 'capture') return;
    const ticket = {};
    opening.current = ticket;
    setPhase({ kind: 'opening' });
    ensureModel().catch(() => {}); // warm the model up while the player gets ready; a failure is met again when it is needed
    let opened: CameraSession;
    try {
      opened = await camera.open();
    } catch (error) {
      if (opening.current === ticket && mounted.current) {
        opening.current = null;
        setPhase({ kind: 'capture', notice: { kind: isCameraBlocked(error) ? 'camera-denied' : 'camera-unavailable' } });
      }
      return;
    }
    if (opening.current !== ticket || !mounted.current) {
      opened.release();
      return;
    }
    opening.current = null;
    session.current = opened;
    setStream(opened.stream);
    setCountdownLeft(COUNTDOWN_SEC);
    setElapsed(0);
    setPhase({ kind: 'countdown' });
  }

  function cancelRecording(): void {
    opening.current = null;
    releaseCamera();
    setPhase({ kind: 'capture' });
  }

  async function stopRecording(): Promise<void> {
    const current = session.current;
    if (current === null || phaseRef.current.kind !== 'recording') return;
    session.current = null;
    setStream(null);
    setPhase({ kind: 'checking' });
    let blob: Blob;
    try {
      blob = await current.stop();
    } catch {
      current.release();
      if (mounted.current) setPhase({ kind: 'capture', notice: { kind: 'unreadable' } });
      return;
    }
    current.release();
    if (mounted.current) await analyseClip(blob);
  }

  // The countdown and the recording read the injected clock on a short poll; each one ends by itself.
  useEffect(() => {
    if (phase.kind !== 'countdown' && phase.kind !== 'recording') return;
    const { clock } = latest.current.deps;
    const startedAt = clock.now();
    const kind = phase.kind;
    const timer = setInterval(() => {
      const seconds = (clock.now() - startedAt) / 1000;
      if (kind === 'countdown') {
        if (seconds >= COUNTDOWN_SEC) {
          clearInterval(timer);
          session.current?.start();
          setElapsed(0);
          setPhase({ kind: 'recording' });
        } else {
          setCountdownLeft(Math.ceil(COUNTDOWN_SEC - seconds));
        }
      } else {
        setElapsed(seconds);
        if (seconds >= RECORD_MAX_SEC) {
          clearInterval(timer);
          void stopRecording();
        }
      }
    }, clock.pollMs);
    return () => clearInterval(timer);
    // The poll belongs to the phase kind; the handlers it calls read refs, so the dependency list is just that.
  }, [phase.kind]);

  // --- sending ---

  async function send(pending: Pending): Promise<void> {
    if (sending.current !== null) return; // one request at a time, even for a second tap in the same tick
    if (latest.current.gateState !== 'open') return; // the consent is not confirmed: the screen is going back to the gate
    const controller = new AbortController();
    sending.current = controller;
    const { analyseTimeoutMs, analyse } = latest.current.deps;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPhase({ kind: 'sending', pending });
    try {
      // A stale cache must not authorise a send: the consent (and, under 13, the guardian) is read again right now.
      const fresh = await readGateNow(latest.current.queryClient);
      if (sending.current !== controller) return; // cancelled, or the screen was left: that path has moved on
      if (fresh.state === 'error') {
        setPhase({ kind: 'send-failed', pending, error: fresh.failure }); // could not check: nothing is sent, Try again checks again
        return;
      }
      if (fresh.state !== 'open') {
        // Revoked (or the guardian is missing) since the review: nothing is sent, the pictures are dropped, the gate is shown.
        releaseClip();
        setPhase({ kind: 'capture' });
        return;
      }
      timer = setTimeout(() => controller.abort(new DOMException('The analysis took too long.', 'TimeoutError')), analyseTimeoutMs);
      const response = await analyse(pending.request, controller.signal);
      if (sending.current !== controller) return;
      if (response.rerecord === true) {
        handOver({ id: 'rerecord', search: { rerecord: response.reason, skill: pending.request.skillSlug } });
      } else {
        // The analysis is now in the player's history: the result screen must read it again, not a cached list without it.
        void latest.current.queryClient.invalidateQueries({ queryKey: ANALYSES_KEY });
        handOver({ id: response.id });
      }
    } catch (error) {
      if (sending.current !== controller) return;
      if (isApiProblem(error) && error.kind === 'forbidden') {
        if (error.problem?.title === CONSENT_REQUIRED_TITLE) revokeLocally(latest.current.queryClient);
        setPhase(error.problem?.title === CONSENT_REQUIRED_TITLE ? { kind: 'capture' } : { kind: 'disabled' });
      } else {
        setPhase({ kind: 'send-failed', pending, error });
      }
    } finally {
      clearTimeout(timer);
      if (sending.current === controller) sending.current = null;
    }
  }

  // The consent can be revoked in another tab: the consents refetch when this tab is focused again. From the review on (also
  // while a request is out) a gate that is no longer open takes the player back to it: the request is aborted, the pictures dropped.
  useEffect(() => {
    const closed = gate.state === 'off' || gate.state === 'guardian' || gate.state === 'noPlan';
    const kind = phaseRef.current.kind;
    if (!closed || (kind !== 'review' && kind !== 'sending' && kind !== 'send-failed')) return;
    sending.current?.abort();
    sending.current = null;
    releaseClip();
    setPhase({ kind: 'capture' });
    // releaseClip and setPhase only touch refs and state setters
  }, [gate.state, phase.kind]);

  function cancelSending(): void {
    const current = phaseRef.current;
    sending.current?.abort();
    sending.current = null;
    if (current.kind === 'sending') setPhase({ kind: 'review', pending: current.pending });
  }

  // --- moving focus to the new step's heading, so a keyboard or screen-reader user is never left on a vanished control ---

  const stepKey = `${skill ?? ''}|${phase.kind}|${gate.state}`;
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    document.querySelector<HTMLElement>('[data-step-heading]')?.focus();
  }, [stepKey]);

  // --- what to show ---

  let content: ReactNode;
  // The 'unavailable' block carries its own way back to training: the page's footer link would be a second one.
  let wayBackInside = false;
  if (skill !== null && (!canDetect || phase.kind === 'unsupported')) {
    content = <EmptyState title={t('unsupported.title')} hint={t('unsupported.hint')} />;
  } else if (!online && (skill === null || phase.kind === 'capture')) {
    content = <EmptyState title={t('unavailable.title')} hint={t('unavailable.hint')} />;
  } else if (skill === null) {
    content = (
      <section aria-labelledby="skills-title" className="grid gap-4">
        <h2 id="skills-title" className={H2}>
          {t('skills.title')}
        </h2>
        <p className={`${BODY} text-muted`}>{t('skills.hint')}</p>
        <ul className="m-0 grid list-none gap-3 p-0">
          {SKILLS.map((slug) => (
            <li key={slug}>
              <Button
                variant="secondary"
                className="w-full justify-start text-left"
                onClick={() => {
                  setSkill(slug);
                  setPhase({ kind: 'capture' });
                }}
              >
                {t(`skills.${slug}.option`)}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    );
  } else {
    switch (phase.kind) {
      case 'capture':
        content = (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className={`${BODY} font-bold`}>{t('skills.chosen', { skill: t(`skills.${skill}.name`) })}</p>
              <Button variant="ghost" onClick={() => setSkill(null)}>
                {t('skills.change')}
              </Button>
            </div>
            {gateOpen ? (
              <CaptureStep
                rubric={rubric}
                canRecord={deps.camera !== null}
                notice={phase.notice}
                locale={locale}
                onRecord={() => void startRecording()}
                onFile={(file) => void analyseClip(file)}
              />
            ) : (
              <ConsentGate gate={gate} />
            )}
          </div>
        );
        break;
      case 'opening':
        content = (
          <Busy label={t('capture.opening')}>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={cancelRecording}>
              {t('recording.cancel')}
            </Button>
          </Busy>
        );
        break;
      case 'countdown':
      case 'recording':
        content = (
          <RecorderView
            phase={phase.kind}
            countdownLeft={countdownLeft}
            elapsed={elapsed}
            stream={stream}
            locale={locale}
            onStop={() => void stopRecording()}
            onCancel={cancelRecording}
          />
        );
        break;
      case 'checking':
        content = (
          <Busy label={t('checking')}>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => {
                cancelWork();
                setPhase({ kind: 'capture' });
              }}
            >
              {t('processing.cancel')}
            </Button>
          </Busy>
        );
        break;
      case 'processing':
        content = (
          <section aria-labelledby="processing-title" className="grid gap-4">
            <h2 id="processing-title" data-step-heading tabIndex={-1} className={H2}>
              {t('processing.title')}
            </h2>
            <p className={BODY}>{t('processing.staysHere')}</p>
            <Bar label={t('processing.progress')} value={phase.progress} max={100} />
            <p className="m-0 text-xl font-bold text-ink">{`${formatNumber(phase.progress, locale)}%`}</p>
            <div className={ACTIONS}>
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={() => {
                  cancelWork();
                  setPhase({ kind: 'capture' });
                }}
              >
                {t('processing.cancel')}
              </Button>
            </div>
          </section>
        );
        break;
      case 'review':
      case 'sending':
      case 'send-failed':
        wayBackInside = phase.kind === 'send-failed' && isAnalysisUnavailable(phase.error);
        content = (
          <ReviewStep
            phase={phase}
            canSend={gateOpen}
            onSend={() => void send(phase.pending)}
            onCancelSending={cancelSending}
            onDiscard={() => setPhase({ kind: 'capture' })}
          />
        );
        break;
      case 'leaving':
        // No picture, no button: the pictures are already dropped and the result screen is on its way.
        content = <Busy label={t('review.sending')} />;
        break;
      case 'disabled':
        wayBackInside = true;
        content = <AnalysisDown />; // the 403 'Video coach disabled': nothing to retry
        break;
      case 'unsupported':
        content = null;
        break;
    }
  }

  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
      <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
      <div className="mt-8 grid gap-4">{content}</div>
      {wayBackInside ? null : (
        <div className="mt-10 grid gap-3 border-t border-line pt-6">
          <p className={`${BODY} text-muted`}>{t('optional.text')}</p>
          <div className={ACTIONS}>
            <a href="/train" className={LINK_SECONDARY}>
              {t('optional.back')}
            </a>
          </div>
        </div>
      )}
    </main>
  );
}

/** The server said the consent is gone: show the gate at once (the refetch then confirms it). */
function revokeLocally(queryClient: QueryClient): void {
  queryClient.setQueryData<Consents>(CONSENTS_KEY, (current) =>
    current === undefined ? current : { ...current, videoAnalysis: { granted: false } },
  );
  void queryClient.invalidateQueries({ queryKey: CONSENTS_KEY });
}

export const Route = createFileRoute('/video/')({ component: VideoPage });
