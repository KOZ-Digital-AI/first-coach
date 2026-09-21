// Pose feature extraction: pure functions from a sequence of pose-landmark frames to the PoseFeatures the
// video coach sends to the server (contract: apps/api/src/shared/video.ts). No model, no network, no DOM.
//
// Input: frames in chronological order; each frame carries the landmarks of the detected person in the MediaPipe
// Pose order (33 landmarks: 0 nose, 11/12 shoulders, 23/24 hips, 25/26 knees, 27/28 ankles; odd = left, even =
// right), x/y normalised to the image (y grows downwards) and a 0..1 visibility. A frame in which no person was
// detected has an empty `landmarks` array.
//
// Readings chosen where the acceptance criteria leave room (see the bead report):
//  - "omitted (not guessed) when visibility is too low": a landmark is usable when it is finite and its visibility
//    is >= MIN_LANDMARK_VISIBILITY (a missing visibility counts as 0). A metric is computed only from the frames
//    where every landmark it needs is usable, and only when those frames are at least MIN_USABLE_FRAMES and at
//    least MIN_USABLE_FRAME_SHARE of the analysed frames; otherwise its key is absent from the result.
//  - framesAnalysed counts frames that have landmarks; meanVisibility is the mean (clamped to 0..1) over every
//    landmark of those frames. With nothing analysed there is no valid PoseFeatures (framesAnalysed >= 1): null.
//  - cadencePerMin: touches (ground contacts) per minute of both feet together. A touch is a prominent local
//    maximum of an ankle's y (the foot at its lowest). Needs both ankles usable; feet that never rise give 0.
//    Touches are counted over the time spanned by the usable frames, so a touch cut by the clip edge can be missed
//    (at most about one per foot).
//  - leftRightBalance: left touches / all touches, per the contract (0 all right, 1 all left), so a sequence where
//    only the left foot works gives 1.0. Omitted when there are no touches at all (nothing to balance).
//  - kneeAngleStats: knee flexion 180 - (hip-knee-ankle angle), degrees, pooled over both legs; each leg is a sample
//    whenever its hip, knee and ankle are usable. Angles are measured in 2D; pass `aspectRatio` (width / height)
//    for non-square frames or they are distorted.
//  - trunkLeanStats: angle of the hip-midpoint -> shoulder-midpoint line from vertical, positive towards the side
//    the nose points to (forwards). The facing side is the clip's mean nose offset from the shoulder midpoint;
//    when the nose sits over the shoulder line (front or back view) the direction is unknown and the metric is
//    omitted. The lean is clamped to -90..90 as the contract requires.
import type { PoseFeatures } from '@api-types/video';

export interface Landmark {
  /** Normalised image x, 0..1 (left to right). */
  x: number;
  /** Normalised image y, 0..1 (top to bottom). */
  y: number;
  z?: number;
  /** 0..1: how sure the detector is that the landmark is visible; absent counts as 0. */
  visibility?: number;
}

export interface PoseFrame {
  /** Timestamp of the frame in milliseconds; frames must be in chronological order. */
  timeMs: number;
  /** MediaPipe Pose landmarks of the detected person; empty when nobody was detected. */
  landmarks: readonly Landmark[];
}

export interface ExtractOptions {
  /** Image width / height. Default 1. Angles are only right when x is scaled by it. */
  aspectRatio?: number;
}

/** A landmark is usable from this visibility on. */
export const MIN_LANDMARK_VISIBILITY = 0.5;
/** A metric needs at least this many usable frames ... */
export const MIN_USABLE_FRAMES = 8;
/** ... and at least this share of the analysed frames. */
export const MIN_USABLE_FRAME_SHARE = 0.7;

/** Smallest ankle rise (normalised image height) that counts as a touch. */
const MIN_STEP_AMPLITUDE = 0.01;
/** A touch must also rise at least this share of the busiest foot's full range (ignores toe wiggles). */
const RELATIVE_STEP_PROMINENCE = 0.25;
/** Smallest mean nose offset from the shoulder midpoint, in torso lengths, that tells which way the body faces. */
const MIN_FACING_OFFSET = 0.05;
/** Zero-length limbs are degenerate, not angles. */
const EPSILON = 1e-9;

const NOSE = 0;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_HIP = 23;
const R_HIP = 24;
const L_KNEE = 25;
const R_KNEE = 26;
const L_ANKLE = 27;
const R_ANKLE = 28;

interface Point {
  x: number;
  y: number;
}

function usablePoint(landmarks: readonly Landmark[], index: number, aspectRatio: number): Point | null {
  const landmark = landmarks[index];
  if (!landmark) return null;
  const { x, y, visibility } = landmark;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (typeof visibility !== 'number' || !(visibility >= MIN_LANDMARK_VISIBILITY)) return null;
  return { x: x * aspectRatio, y };
}

function enoughFrames(usable: number, analysed: number): boolean {
  return usable >= MIN_USABLE_FRAMES && usable >= MIN_USABLE_FRAME_SHARE * analysed;
}

function summarise(values: readonly number[], lowest: number, highest: number) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // Rounding must not push the mean outside [min, max] (the contract requires min <= mean <= max).
  const mean = Math.min(max, Math.max(min, sum / values.length));
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  const clamp = (value: number) => Math.min(highest, Math.max(lowest, value));
  return { mean: clamp(mean), min: clamp(min), max: clamp(max), stdDev: Math.sqrt(squares / values.length) };
}

const toDegrees = (radians: number) => (radians * 180) / Math.PI;

// --- knee flexion -------------------------------------------------------------------------------------------------------

function kneeFlexion(hip: Point, knee: Point, ankle: Point): number | null {
  const thigh = { x: hip.x - knee.x, y: hip.y - knee.y };
  const shank = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const lengths = Math.hypot(thigh.x, thigh.y) * Math.hypot(shank.x, shank.y);
  if (Math.hypot(thigh.x, thigh.y) < EPSILON || Math.hypot(shank.x, shank.y) < EPSILON) return null;
  const cosine = (thigh.x * shank.x + thigh.y * shank.y) / lengths;
  const joint = toDegrees(Math.acos(Math.min(1, Math.max(-1, cosine))));
  return 180 - joint;
}

function kneeAngleStats(frames: readonly PoseFrame[], aspectRatio: number, analysed: number) {
  const samples: number[] = [];
  let usableFrames = 0;
  for (const { landmarks } of frames) {
    let usable = false;
    for (const [hipIndex, kneeIndex, ankleIndex] of [
      [L_HIP, L_KNEE, L_ANKLE],
      [R_HIP, R_KNEE, R_ANKLE],
    ] as const) {
      const hip = usablePoint(landmarks, hipIndex, aspectRatio);
      const knee = usablePoint(landmarks, kneeIndex, aspectRatio);
      const ankle = usablePoint(landmarks, ankleIndex, aspectRatio);
      if (!hip || !knee || !ankle) continue;
      const flexion = kneeFlexion(hip, knee, ankle);
      if (flexion === null) continue;
      samples.push(flexion);
      usable = true;
    }
    if (usable) usableFrames++;
  }
  if (!enoughFrames(usableFrames, analysed)) return undefined;
  return summarise(samples, 0, 180);
}

// --- trunk lean ---------------------------------------------------------------------------------------------------------

function trunkLeanStats(frames: readonly PoseFrame[], aspectRatio: number, analysed: number) {
  const torsos: Array<{ dx: number; dy: number; noseOffset: number }> = [];
  for (const { landmarks } of frames) {
    const nose = usablePoint(landmarks, NOSE, aspectRatio);
    const leftShoulder = usablePoint(landmarks, L_SHOULDER, aspectRatio);
    const rightShoulder = usablePoint(landmarks, R_SHOULDER, aspectRatio);
    const leftHip = usablePoint(landmarks, L_HIP, aspectRatio);
    const rightHip = usablePoint(landmarks, R_HIP, aspectRatio);
    if (!nose || !leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;
    const shoulderMid = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
    const hipMid = { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 };
    const dx = shoulderMid.x - hipMid.x;
    const dy = shoulderMid.y - hipMid.y;
    const length = Math.hypot(dx, dy);
    if (length < EPSILON) continue;
    torsos.push({ dx, dy, noseOffset: (nose.x - shoulderMid.x) / length });
  }
  if (!enoughFrames(torsos.length, analysed)) return undefined;

  let offsetSum = 0;
  for (const torso of torsos) offsetSum += torso.noseOffset;
  const meanOffset = offsetSum / torsos.length;
  if (Math.abs(meanOffset) < MIN_FACING_OFFSET) return undefined;
  const facing = Math.sign(meanOffset);

  const leans = torsos.map(({ dx, dy }) => Math.min(90, Math.max(-90, toDegrees(Math.atan2(dx * facing, -dy)))));
  return summarise(leans, -90, 90);
}

// --- touches: cadence and balance --------------------------------------------------------------------------------------

/** Number of local maxima of `values` that stand out by at least `minProminence` from the surrounding troughs. */
function countProminentPeaks(values: readonly number[], minProminence: number): number {
  let peaks = 0;
  for (let i = 1; i < values.length - 1; i++) {
    const value = values[i] as number;
    if (!(value > (values[i - 1] as number) && value >= (values[i + 1] as number))) continue;
    // Ties break towards the earlier peak (the left walk stops at an equal value, the right walk passes it), so two
    // equal crests split by a dip are one touch, not two.
    let leftMin = value;
    for (let j = i - 1; j >= 0 && (values[j] as number) < value; j--) leftMin = Math.min(leftMin, values[j] as number);
    let rightMin = value;
    for (let j = i + 1; j < values.length && (values[j] as number) <= value; j++) {
      rightMin = Math.min(rightMin, values[j] as number);
    }
    if (value - Math.max(leftMin, rightMin) >= minProminence) peaks++;
  }
  return peaks;
}

function range(values: readonly number[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

function touches(frames: readonly PoseFrame[], analysed: number) {
  const times: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (const { timeMs, landmarks } of frames) {
    const leftAnkle = usablePoint(landmarks, L_ANKLE, 1);
    const rightAnkle = usablePoint(landmarks, R_ANKLE, 1);
    if (!leftAnkle || !rightAnkle) continue;
    times.push(timeMs);
    left.push(leftAnkle.y);
    right.push(rightAnkle.y);
  }
  if (!enoughFrames(times.length, analysed)) return undefined;
  const durationMs = (times[times.length - 1] as number) - (times[0] as number);
  if (!(durationMs > 0)) return undefined;

  const prominence = Math.max(MIN_STEP_AMPLITUDE, RELATIVE_STEP_PROMINENCE * Math.max(range(left), range(right)));
  const leftTouches = countProminentPeaks(left, prominence);
  const rightTouches = countProminentPeaks(right, prominence);
  const total = leftTouches + rightTouches;
  return {
    cadencePerMin: total / (durationMs / 60_000),
    leftRightBalance: total > 0 ? leftTouches / total : undefined,
  };
}

// --- entry point --------------------------------------------------------------------------------------------------------

/**
 * Features of one clip, or null when no frame had a detected person (framesAnalysed must be >= 1).
 * Metrics that cannot be trusted at the observed visibility are absent, never estimated.
 */
export function extractFeatures(frames: readonly PoseFrame[], options: ExtractOptions = {}): PoseFeatures | null {
  const aspectRatio =
    options.aspectRatio !== undefined && Number.isFinite(options.aspectRatio) && options.aspectRatio > 0
      ? options.aspectRatio
      : 1;
  const analysedFrames = frames.filter((frame) => frame.landmarks.length > 0);
  const analysed = analysedFrames.length;
  if (analysed === 0) return null;

  let visibilitySum = 0;
  let landmarkCount = 0;
  for (const { landmarks } of analysedFrames) {
    for (const { visibility } of landmarks) {
      visibilitySum += typeof visibility === 'number' && Number.isFinite(visibility) ? Math.min(1, Math.max(0, visibility)) : 0;
      landmarkCount++;
    }
  }

  const features: PoseFeatures = { meanVisibility: visibilitySum / landmarkCount, framesAnalysed: analysed };

  const foot = touches(analysedFrames, analysed);
  if (foot) {
    features.cadencePerMin = foot.cadencePerMin;
    if (foot.leftRightBalance !== undefined) features.leftRightBalance = foot.leftRightBalance;
  }
  const knee = kneeAngleStats(analysedFrames, aspectRatio, analysed);
  if (knee) features.kneeAngleStats = knee;
  const trunk = trunkLeanStats(analysedFrames, aspectRatio, analysed);
  if (trunk) features.trunkLeanStats = trunk;
  return features;
}
