// Keyframe sampler: picks 3..6 well-visible, evenly spread moments of a clip and turns each into a small, anonymised
// JPEG that satisfies the merged contract (apps/api/src/shared/video.ts, fc-mol-0g0).
//
// PRIVACY (risk:privacy): the raw video NEVER leaves the device. The only thing that leaves is what this module returns:
// downscaled JPEG keyframes (<= 512 px on the longest side, <= 200 KB decoded, bare base64 starting "/9j/"), cropped to the
// body, with the face region blurred BEFORE the JPEG is exported. Re-encoding through a canvas copies pixels only, so
// EXIF/GPS/any container metadata of the source is stripped by construction. No Blob/URL/File of the video is created here.
//
// Readings of the criteria (the simplest that fits):
//  - "frames" is the pose extractor's per-frame output. That module is not merged yet, so the minimal structural shape this
//    sampler needs is declared here (PoseFrame: time + normalised MediaPipe landmarks); the real type is assignable to it.
//  - "evenly spread": the analysed frames are cut into n equal consecutive slices (by index: the extractor samples at a
//    steady rate) and one frame is taken per slice. "Well-visible": within a slice the frame with the highest mean landmark
//    visibility wins (a missing visibility counts as 0); ties go to the frame nearest the slice centre, then the earliest.
//  - Fewer analysed frames than n is an error (never fewer keyframes than asked, never a repeated frame).
//  - "body bounding box": landmarks with visibility >= MIN_LANDMARK_VISIBILITY (all landmarks when none qualifies), plus a
//    margin, clamped to the video frame.
//  - "blurs the face region": MediaPipe pose landmarks 0..10 (nose, eyes, ears, mouth) give the face box, padded; the region
//    is read back from the canvas, shrunk to a handful of pixels and painted back smoothed. Canvas `filter: blur()` is not
//    used: it is missing in Safari, and iOS is a target. A frame with no pose landmarks cannot be anonymised, so it is
//    rejected ('no_pose') rather than exported with an unknown face position.
//  - Size loop: re-encode at stepping-down JPEG quality until the decoded size is within KEYFRAME_MAX_BYTES; if even the
//    lowest quality is over, reject ('too_large') instead of returning a frame the server would refuse.
//
// The canvas factory and the seek are injected seams (default: the DOM), so tests need no real media.
import { KEYFRAME_MAX_BYTES, KEYFRAME_MAX_COUNT, KEYFRAME_MAX_SIDE_PX, KEYFRAME_MIME_TYPE, KEYFRAME_MIN_COUNT, Keyframe, base64DecodedBytes } from '@api-types/video';

// --- types ---------------------------------------------------------------------------------------------------------------

/** One pose landmark, x/y normalised to the video frame (0..1); visibility 0..1 when the model reports one. */
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly visibility?: number;
}

/** One analysed frame of the clip: where it is in the video and its pose landmarks (MediaPipe order: 0..10 face). */
export interface PoseFrame {
  readonly timeSec: number;
  readonly landmarks: readonly Landmark[];
}

/** The slice of HTMLVideoElement the sampler needs. */
export interface KeyframeVideo {
  readonly videoWidth: number;
  readonly videoHeight: number;
  currentTime: number;
  addEventListener(type: 'seeked' | 'error', listener: () => void): void;
  removeEventListener(type: 'seeked' | 'error', listener: () => void): void;
}

/** The slice of CanvasRenderingContext2D the sampler needs. */
export interface Canvas2D {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality?: 'low' | 'medium' | 'high';
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

/** The slice of HTMLCanvasElement the sampler needs. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): Canvas2D | null;
  toDataURL(type?: string, quality?: number): string;
}

export interface KeyframeDeps {
  createCanvas(width: number, height: number): CanvasLike;
  seek(video: KeyframeVideo, timeSec: number): Promise<void>;
}

export type KeyframeErrorCode =
  | 'invalid_count'
  | 'not_enough_frames'
  | 'video_not_ready'
  | 'no_pose'
  | 'no_canvas'
  | 'seek_failed'
  | 'bad_encoding'
  | 'too_large';

export class KeyframeError extends Error {
  constructor(
    readonly code: KeyframeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KeyframeError';
  }
}

// --- tuning --------------------------------------------------------------------------------------------------------------

/** MediaPipe pose landmarks 0..10: nose, eyes, ears, mouth. */
const FACE_LANDMARK_COUNT = 11;
/** A landmark counts as "seen" for the body box from this visibility. */
const MIN_LANDMARK_VISIBILITY = 0.5;
/** Margin around the body box, as a share of the box size on each axis. */
const CROP_MARGIN = 0.15;
/** Face box padding, as a share of the face box's longest side (in pixels) (the landmarks span eyes to mouth, not the whole head). */
const FACE_PAD = 0.75;
/** Never pad from a face box smaller than this share of the video's short side, e.g. one lone landmark. */
const FACE_MIN_SIZE = 0.03;
/** The face region is shrunk to about this many pixels across before being painted back: enough to destroy identity. */
const BLUR_SAMPLES = 12;
/** JPEG qualities tried in order until the frame fits KEYFRAME_MAX_BYTES. */
const JPEG_QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25] as const;
const JPEG_DATA_URL_PREFIX = `data:${KEYFRAME_MIME_TYPE};base64,`;
const JPEG_BASE64_MARKER = '/9j/';

// --- selection -----------------------------------------------------------------------------------------------------------

function assertCount(n: number): void {
  if (!Number.isInteger(n) || n < KEYFRAME_MIN_COUNT || n > KEYFRAME_MAX_COUNT) {
    throw new KeyframeError('invalid_count', `Expected an integer keyframe count ${KEYFRAME_MIN_COUNT}..${KEYFRAME_MAX_COUNT}, got ${n}`);
  }
}

/** Mean landmark visibility of a frame; a missing (or non-finite) visibility counts as 0, no landmarks as 0. */
function frameVisibility(frame: PoseFrame): number {
  if (frame.landmarks.length === 0) return 0;
  let sum = 0;
  for (const landmark of frame.landmarks) {
    const visibility = landmark.visibility;
    if (visibility !== undefined && Number.isFinite(visibility)) sum += visibility;
  }
  return sum / frame.landmarks.length;
}

/** Indices (ascending, distinct) of the n frames to export: the best-visible frame of each of n equal slices of the clip. */
export function selectKeyframeIndices(frames: readonly PoseFrame[], n: number): number[] {
  assertCount(n);
  const total = frames.length;
  if (total < n) throw new KeyframeError('not_enough_frames', `Need at least ${n} analysed frames, got ${total}`);
  const scores = frames.map(frameVisibility);
  const picked: number[] = [];
  for (let slice = 0; slice < n; slice += 1) {
    const start = Math.floor((slice * total) / n);
    const end = Math.floor(((slice + 1) * total) / n); // exclusive
    const centre = (start + end - 1) / 2;
    let best = start;
    for (let i = start + 1; i < end; i += 1) {
      const score = scores[i] as number;
      const bestScore = scores[best] as number;
      if (score > bestScore || (score === bestScore && Math.abs(i - centre) < Math.abs(best - centre))) best = i;
    }
    picked.push(best);
  }
  return picked;
}

// --- geometry ------------------------------------------------------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const finite = (landmark: Landmark): boolean => Number.isFinite(landmark.x) && Number.isFinite(landmark.y);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function boundsOf(landmarks: readonly Landmark[]): Box {
  return {
    x0: Math.min(...landmarks.map((l) => l.x)),
    y0: Math.min(...landmarks.map((l) => l.y)),
    x1: Math.max(...landmarks.map((l) => l.x)),
    y1: Math.max(...landmarks.map((l) => l.y)),
  };
}

/** The crop in video pixels: the visible-body box plus a margin, clamped to the frame. */
function cropRect(landmarks: readonly Landmark[], videoWidth: number, videoHeight: number) {
  const usable = landmarks.filter(finite);
  const seen = usable.filter((l) => (l.visibility ?? 0) >= MIN_LANDMARK_VISIBILITY);
  const box = boundsOf(seen.length > 0 ? seen : usable);
  const marginX = (box.x1 - box.x0) * CROP_MARGIN;
  const marginY = (box.y1 - box.y0) * CROP_MARGIN;
  const x0 = clamp01(box.x0 - marginX);
  const y0 = clamp01(box.y0 - marginY);
  const x1 = clamp01(box.x1 + marginX);
  const y1 = clamp01(box.y1 + marginY);
  const sx = Math.min(x0 * videoWidth, videoWidth - 1);
  const sy = Math.min(y0 * videoHeight, videoHeight - 1);
  return {
    sx,
    sy,
    sw: Math.min(Math.max(1, (x1 - x0) * videoWidth), videoWidth - sx),
    sh: Math.min(Math.max(1, (y1 - y0) * videoHeight), videoHeight - sy),
  };
}

/** Scale to fit within the contract's longest side, never upscaling; both sides at least 1 px. */
function fitWithin(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, KEYFRAME_MAX_SIDE_PX / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// --- canvas work ---------------------------------------------------------------------------------------------------------

/** Read the face region back, shrink it to a few pixels and paint it back smoothed. Nothing is exported yet. */
function blurFace(canvas: CanvasLike, ctx: Canvas2D, face: Box, crop: ReturnType<typeof cropRect>, videoWidth: number, videoHeight: number, createCanvas: KeyframeDeps['createCanvas']): void {
  // Work in video pixels so the padding is the same on both axes whatever the video's aspect ratio.
  const faceX0 = face.x0 * videoWidth;
  const faceY0 = face.y0 * videoHeight;
  const faceX1 = face.x1 * videoWidth;
  const faceY1 = face.y1 * videoHeight;
  const size = Math.max(faceX1 - faceX0, faceY1 - faceY0, FACE_MIN_SIZE * Math.min(videoWidth, videoHeight));
  const pad = size * FACE_PAD;
  const kx = canvas.width / crop.sw;
  const ky = canvas.height / crop.sh;
  const x0 = Math.max(0, Math.floor((faceX0 - pad - crop.sx) * kx));
  const y0 = Math.max(0, Math.floor((faceY0 - pad - crop.sy) * ky));
  const x1 = Math.min(canvas.width, Math.ceil((faceX1 + pad - crop.sx) * kx));
  const y1 = Math.min(canvas.height, Math.ceil((faceY1 + pad - crop.sy) * ky));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return; // the face lies outside the crop: none of its pixels are in this frame

  const small = createCanvas(Math.max(1, Math.round(width / BLUR_SAMPLES)), Math.max(1, Math.round(height / BLUR_SAMPLES)));
  const smallCtx = small.getContext('2d');
  if (!smallCtx) throw new KeyframeError('no_canvas', 'Canvas 2D context unavailable');
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(canvas, x0, y0, width, height, 0, 0, small.width, small.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, small.width, small.height, x0, y0, width, height);
}

/** Export as JPEG, stepping the quality down until the decoded size fits the contract cap. */
function encodeJpeg(canvas: CanvasLike): Keyframe {
  for (const quality of JPEG_QUALITIES) {
    const url = canvas.toDataURL(KEYFRAME_MIME_TYPE, quality);
    if (!url.startsWith(JPEG_DATA_URL_PREFIX)) throw new KeyframeError('bad_encoding', 'The canvas did not export a JPEG');
    const data = url.slice(JPEG_DATA_URL_PREFIX.length);
    if (!data.startsWith(JPEG_BASE64_MARKER)) throw new KeyframeError('bad_encoding', 'The export is not JPEG data');
    if (base64DecodedBytes(data) > KEYFRAME_MAX_BYTES) continue;
    // Final gate: exactly what the server's schema will accept (strict keys, bare base64, size and pixel bounds).
    const parsed = Keyframe.safeParse({ mimeType: KEYFRAME_MIME_TYPE, data, width: canvas.width, height: canvas.height });
    if (!parsed.success) throw new KeyframeError('bad_encoding', 'The keyframe does not satisfy the contract');
    return parsed.data;
  }
  throw new KeyframeError('too_large', `No JPEG quality fits ${KEYFRAME_MAX_BYTES} bytes`);
}

// --- default seams -------------------------------------------------------------------------------------------------------

/** Default canvas seam: an off-screen DOM canvas. */
export function createDomCanvas(width: number, height: number): CanvasLike {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Default seek seam: set currentTime and wait for `seeked` (a no-op seek fires no event, so it resolves at once). */
export function seekVideo(video: KeyframeVideo, timeSec: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (Math.abs(video.currentTime - timeSec) < 1e-3) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new KeyframeError('seek_failed', `The video failed to seek to ${timeSec}s`));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = timeSec;
  });
}

// --- public entry point --------------------------------------------------------------------------------------------------

async function captureKeyframe(video: KeyframeVideo, frame: PoseFrame, deps: KeyframeDeps): Promise<Keyframe> {
  const faceLandmarks = frame.landmarks.slice(0, FACE_LANDMARK_COUNT).filter(finite);
  if (faceLandmarks.length === 0) throw new KeyframeError('no_pose', 'The frame has no face landmarks, so it cannot be anonymised');
  const face = boundsOf(faceLandmarks);

  await deps.seek(video, frame.timeSec);
  const crop = cropRect(frame.landmarks, video.videoWidth, video.videoHeight);
  const { width, height } = fitWithin(crop.sw, crop.sh);
  const canvas = deps.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new KeyframeError('no_canvas', 'Canvas 2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  blurFace(canvas, ctx, face, crop, video.videoWidth, video.videoHeight, deps.createCanvas);
  return encodeJpeg(canvas);
}

/**
 * n (3..6) anonymised JPEG keyframes of the clip in `video`, in time order, chosen from the pose `frames`.
 * Frames are captured one after another (a single <video> element can only be at one time).
 */
export async function sampleKeyframes(video: KeyframeVideo, frames: readonly PoseFrame[], n: number, deps: Partial<KeyframeDeps> = {}): Promise<Keyframe[]> {
  assertCount(n);
  if (!(video.videoWidth > 0 && video.videoHeight > 0)) throw new KeyframeError('video_not_ready', 'The video has no decoded size yet');
  const resolved: KeyframeDeps = { createCanvas: deps.createCanvas ?? createDomCanvas, seek: deps.seek ?? seekVideo };
  const keyframes: Keyframe[] = [];
  for (const index of selectKeyframeIndices(frames, n)) {
    keyframes.push(await captureKeyframe(video, frames[index] as PoseFrame, resolved));
  }
  return keyframes;
}
