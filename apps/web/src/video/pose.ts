// Lazy pose landmarker loader for the Beta AI Video Coach.
//
// - `@mediapipe/tasks-vision` (a large package + WASM) is imported with a dynamic `import()` inside load() and nowhere else
//   (only `import type` is used at the top), so it is not in the initial bundle and nothing is fetched until the player opens
//   the video coach and load() is called.
// - The model and the WASM are self-hosted: same-origin URLs under /mediapipe, written there by scripts/fetch-pose-model.ts
//   (pose_landmarker_lite.task and vision_wasm_*_internal.{js,wasm}). No third-party origin is ever contacted.
// - detectOnVideo samples the RECORDED clip by seeking to evenly spaced times (5-10 fps) and running the landmarker on each
//   still frame; it never plays the video in real time, so a cheap Android phone can take as long as it needs.
//
// Readings of the criteria (the simplest that fits):
//  - "CPU delegate fallback": the landmarker is created with the GPU delegate first (faster where WebGL works); if that
//    creation fails, it is created again with the CPU delegate. Only when both fail does load() reject.
//  - "fps 5-10": the requested rate is clamped into 5..10; missing or non-finite means 5 (MIN_SAMPLE_FPS).
//  - Sample times: i * 1000 / fps ms for every i with that time strictly before the end of the clip (half-open), so a 20 s clip
//    at 5 fps has 100 samples, 0 .. 19800 ms. The last frame is not sampled at exactly `duration`: seeking to the very end is
//    unreliable across browsers.
//  - onProgress(fraction) is called after each sampled frame is detected; fraction is done/total, ending at exactly 1.
//  - detectOnVideo before load() rejects with 'not_loaded' rather than loading implicitly: the (large) download stays an
//    explicit step the screen controls and can show progress for.
//  - A frame in which no person is detected is kept with `landmarks: []` (the shape features.ts documents), so framesAnalysed
//    and the timeline stay honest. Only the first pose (numPoses 1) is used.
//  - Frames are returned as features.ts' PoseFrame ({ timeMs, landmarks }); keyframes.ts wants { timeSec, landmarks }, which
//    the call site adapts (timeSec = timeMs / 1000). Neither file is edited here.
//  - Seeking is guarded by a timeout (default 10 s) and by the video's `error` event, so a stalled clip rejects with
//    'seek_timeout' / 'seek_failed' instead of hanging. A seek to the time the video is already at fires no `seeked` event,
//    so it is skipped.
import type { PoseFrame } from './features';

// --- constants -------------------------------------------------------------------------------------------------------------

/** Where the model and the WASM are served from (apps/web/public/mediapipe, filled by scripts/fetch-pose-model.ts). */
export const POSE_ASSET_BASE = '/mediapipe';
/** The pose_landmarker_lite model bundle, same origin. */
export const POSE_MODEL_URL = `${POSE_ASSET_BASE}/pose_landmarker_lite.task`;
/** MediaPipe Pose returns 33 landmarks per person. */
export const POSE_LANDMARK_COUNT = 33;
export const MIN_SAMPLE_FPS = 5;
export const MAX_SAMPLE_FPS = 10;
const DEFAULT_SEEK_TIMEOUT_MS = 10_000;

// --- types -----------------------------------------------------------------------------------------------------------------

export type PoseErrorCode = 'not_loaded' | 'load_failed' | 'invalid_duration' | 'seek_timeout' | 'seek_failed';

export class PoseError extends Error {
  override name = 'PoseError';
  constructor(
    readonly code: PoseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The slice of HTMLVideoElement this module needs (the real element is assignable). */
export interface PoseVideo {
  readonly duration: number;
  currentTime: number;
  addEventListener(type: 'seeked' | 'error', listener: () => void): void;
  removeEventListener(type: 'seeked' | 'error', listener: () => void): void;
}

interface RawLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly visibility: number;
}

/** The slice of tasks-vision's PoseLandmarker used here. */
export interface PoseLandmarkerLike {
  detectForVideo(video: PoseVideo, timestampMs: number): { readonly landmarks: readonly (readonly RawLandmark[])[] };
}

export interface PoseLandmarkerCreateOptions {
  baseOptions: { modelAssetPath: string; delegate: 'GPU' | 'CPU' };
  runningMode: 'VIDEO';
  numPoses: number;
}

/** The slice of the @mediapipe/tasks-vision module used here. */
export interface PoseVisionModule {
  FilesetResolver: { forVisionTasks(basePath: string): Promise<unknown> };
  PoseLandmarker: { createFromOptions(fileset: unknown, options: PoseLandmarkerCreateOptions): Promise<PoseLandmarkerLike> };
}

export interface PoseDetectorOptions {
  /** How the package is imported; the default is the dynamic `import('@mediapipe/tasks-vision')`. A test seam. */
  importVision?: () => Promise<PoseVisionModule>;
  /** How long one seek may take before detectOnVideo rejects with 'seek_timeout'. */
  seekTimeoutMs?: number;
}

export interface PoseDetector {
  /** Imports tasks-vision and creates the landmarker (once; safe to call again and concurrently). */
  load(): Promise<void>;
  /** Samples the clip at `fps` (clamped to 5..10) by seeking; needs load() first. onProgress gets done/total after each frame. */
  detectOnVideo(videoEl: PoseVideo, fps?: number, onProgress?: (fraction: number) => void): Promise<PoseFrame[]>;
}

// --- sampling --------------------------------------------------------------------------------------------------------------

const clampFps = (fps: number | undefined): number =>
  fps === undefined || !Number.isFinite(fps) ? MIN_SAMPLE_FPS : Math.min(MAX_SAMPLE_FPS, Math.max(MIN_SAMPLE_FPS, fps));

/** The times (ms) at which a clip of `durationSec` is sampled at `fps`: i * 1000 / fps for every i before the end of the clip. */
export function sampleTimestampsMs(durationSec: number, fps?: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const rate = clampFps(fps);
  // The epsilon absorbs float noise such as 1.1 * 10 = 11.000000000000002, which would otherwise add a sample past the end.
  const count = Math.ceil(durationSec * rate - 1e-9);
  return Array.from({ length: count }, (_, i) => (i * 1000) / rate);
}

// --- seeking ---------------------------------------------------------------------------------------------------------------

function seekTo(video: PoseVideo, timeSec: number, timeoutMs: number): Promise<void> {
  if (video.currentTime === timeSec) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      settle();
    };
    const onSeeked = (): void => finish(resolve);
    const onError = (): void => finish(() => reject(new PoseError('seek_failed', `the video could not seek to ${timeSec}s`)));
    const timer = setTimeout(
      () => finish(() => reject(new PoseError('seek_timeout', `the video did not finish seeking to ${timeSec}s within ${timeoutMs} ms`))),
      timeoutMs,
    );
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = timeSec;
  });
}

// --- the detector ----------------------------------------------------------------------------------------------------------

// The only import of the package. Cast: the real classes are wider than the slice this module uses.
const importTasksVision = (): Promise<PoseVisionModule> => import('@mediapipe/tasks-vision') as unknown as Promise<PoseVisionModule>;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function createLandmarker(importVision: () => Promise<PoseVisionModule>): Promise<PoseLandmarkerLike> {
  const vision = await importVision();
  const fileset = await vision.FilesetResolver.forVisionTasks(POSE_ASSET_BASE);
  const create = (delegate: 'GPU' | 'CPU'): Promise<PoseLandmarkerLike> =>
    vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  try {
    return await create('GPU');
  } catch {
    return await create('CPU');
  }
}

export function createPoseDetector(options: PoseDetectorOptions = {}): PoseDetector {
  const importVision = options.importVision ?? importTasksVision;
  const seekTimeoutMs = options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS;
  let loading: Promise<PoseLandmarkerLike> | undefined;
  let landmarker: PoseLandmarkerLike | undefined;

  const load = async (): Promise<void> => {
    if (landmarker) return;
    loading ??= createLandmarker(importVision).then(
      (created) => {
        landmarker = created;
        return created;
      },
      (error: unknown) => {
        loading = undefined; // allow a retry (e.g. the chunk failed to download on a flaky connection)
        throw new PoseError('load_failed', `could not load the pose model: ${reason(error)}`);
      },
    );
    await loading;
  };

  const detectOnVideo: PoseDetector['detectOnVideo'] = async (video, fps, onProgress) => {
    if (!landmarker) throw new PoseError('not_loaded', 'call load() before detectOnVideo()');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new PoseError('invalid_duration', `the clip has no usable duration (${video.duration})`);
    }
    const times = sampleTimestampsMs(video.duration, fps);
    const frames: PoseFrame[] = [];
    for (const timeMs of times) {
      await seekTo(video, timeMs / 1000, seekTimeoutMs);
      const [person] = landmarker.detectForVideo(video, timeMs).landmarks;
      frames.push({
        timeMs,
        landmarks: (person ?? []).map(({ x, y, z, visibility }) => ({ x, y, z, visibility })),
      });
      onProgress?.(frames.length / times.length);
    }
    return frames;
  };

  return { load, detectOnVideo };
}

// The shared instance the app uses: `load()` when the video coach opens, then `detectOnVideo(...)`.
const shared = createPoseDetector();
export const load: PoseDetector['load'] = () => shared.load();
export const detectOnVideo: PoseDetector['detectOnVideo'] = (videoEl, fps, onProgress) => shared.detectOnVideo(videoEl, fps, onProgress);
