import { describe, expect, test } from 'bun:test';
import { PoseFeatures } from '@api-types/video';
import {
  extractFeatures,
  type Landmark,
  MIN_LANDMARK_VISIBILITY,
  MIN_USABLE_FRAME_SHARE,
  MIN_USABLE_FRAMES,
  type PoseFrame,
} from './features';

// --- synthetic landmark sequences ---------------------------------------------------------------------------------------
// A frame is { timeMs, landmarks[33] } in MediaPipe order, coordinates normalised to the image (y grows downwards).
// The person stands facing image-right: nose a little to the right of the shoulder line, ankles at y 0.9.
// Left side of the body is drawn at larger x than the right side; nothing here depends on that.

const NOSE = 0;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_HIP = 23;
const R_HIP = 24;
const L_KNEE = 25;
const R_KNEE = 26;
const L_ANKLE = 27;
const R_ANKLE = 28;
const LANDMARK_COUNT = 33;

type Edits = Partial<Record<number, readonly [number, number]>>;
type Visibility = number | ((index: number) => number);

const BASE: Record<number, readonly [number, number]> = {
  [NOSE]: [0.56, 0.12],
  [L_SHOULDER]: [0.55, 0.25],
  [R_SHOULDER]: [0.45, 0.25],
  [L_HIP]: [0.53, 0.5],
  [R_HIP]: [0.47, 0.5],
  [L_KNEE]: [0.53, 0.7],
  [R_KNEE]: [0.47, 0.7],
  [L_ANKLE]: [0.53, 0.9],
  [R_ANKLE]: [0.47, 0.9],
};

function pose(edits: Edits = {}, visibility: Visibility = 0.99): Landmark[] {
  const landmarks: Landmark[] = [];
  for (let index = 0; index < LANDMARK_COUNT; index++) {
    const [x, y] = edits[index] ?? BASE[index] ?? [0.5, 0.5];
    landmarks.push({ x, y, z: 0, visibility: typeof visibility === 'function' ? visibility(index) : visibility });
  }
  return landmarks;
}

function sequence(
  seconds: number,
  fps: number,
  build: (timeSec: number, index: number) => { edits?: Edits; visibility?: Visibility },
): PoseFrame[] {
  const count = Math.round(seconds * fps);
  const frames: PoseFrame[] = [];
  for (let index = 0; index < count; index++) {
    const timeMs = (index * 1000) / fps;
    const { edits, visibility } = build(timeMs / 1000, index);
    frames.push({ timeMs, landmarks: pose(edits, visibility) });
  }
  return frames;
}

/** Ankle heights: each foot bobs at `hz`; the feet are in antiphase (a dribbling / stepping pattern). */
function steppingAnkles(hz: number, amplitude = 0.05, noise?: () => number): (t: number) => Edits {
  return (t) => {
    const wobble = () => (noise ? noise() : 0);
    return {
      [L_ANKLE]: [0.53, 0.9 + amplitude * Math.sin(2 * Math.PI * hz * t) + wobble()],
      [R_ANKLE]: [0.47, 0.9 - amplitude * Math.sin(2 * Math.PI * hz * t) + wobble()],
    };
  };
}

/** Deterministic pseudo-noise in [-scale, scale]. */
function seededNoise(scale: number, seed = 12345): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296 - 0.5) * 2 * scale;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Knee at (0.5, 0.7), hip straight above it, ankle placed so that the knee flexes by `flexionDeg` (0 = straight leg). */
function kneeEdits(flexionDeg: number, aspectRatio = 1): Edits {
  const interior = ((180 - flexionDeg) * Math.PI) / 180;
  const shank = 0.2;
  // Work in a square space, then squeeze x by the aspect ratio (a landscape image stores x / aspect).
  const ankle: [number, number] = [0.5 + (shank * Math.sin(interior)) / aspectRatio, 0.7 - shank * Math.cos(interior)];
  const knee: [number, number] = [0.5, 0.7];
  const hip: [number, number] = [0.5, 0.5];
  return { [L_HIP]: hip, [L_KNEE]: knee, [L_ANKLE]: ankle, [R_HIP]: hip, [R_KNEE]: knee, [R_ANKLE]: ankle };
}

/** Torso of length 0.25 leaning `leanDeg` towards image-right, with the nose on the given side of the shoulders. */
function torsoEdits(leanDeg: number, noseDx: number): Edits {
  const length = 0.25;
  const hipMid: [number, number] = [0.5, 0.5];
  const shoulderMid: [number, number] = [
    0.5 + length * Math.sin((leanDeg * Math.PI) / 180),
    0.5 - length * Math.cos((leanDeg * Math.PI) / 180),
  ];
  return {
    [L_HIP]: [hipMid[0] + 0.03, hipMid[1]],
    [R_HIP]: [hipMid[0] - 0.03, hipMid[1]],
    [L_SHOULDER]: [shoulderMid[0] + 0.05, shoulderMid[1]],
    [R_SHOULDER]: [shoulderMid[0] - 0.05, shoulderMid[1]],
    [NOSE]: [shoulderMid[0] + noseDx, shoulderMid[1] - 0.12],
  };
}

const STILL = () => ({});

// --- cadence -----------------------------------------------------------------------------------------------------------

describe('cadencePerMin', () => {
  test.each([
    { hz: 0.75, fps: 30, seconds: 15, expected: 90 },
    { hz: 1, fps: 30, seconds: 12, expected: 120 },
    { hz: 1, fps: 25, seconds: 12, expected: 120 },
    { hz: 1.5, fps: 30, seconds: 15, expected: 180 },
  ])('recovers $expected touches/min (feet at $hz Hz, $fps fps) within 10%', ({ hz, fps, seconds, expected }) => {
    const features = extractFeatures(sequence(seconds, fps, (t) => ({ edits: steppingAnkles(hz)(t) })));
    expect(features?.cadencePerMin).toBeDefined();
    expect(Math.abs((features?.cadencePerMin ?? 0) - expected) / expected).toBeLessThanOrEqual(0.1);
  });

  test('still recovers the cadence through landmark jitter', () => {
    const noise = seededNoise(0.004);
    const features = extractFeatures(
      sequence(12, 30, (t) => ({ edits: steppingAnkles(1, 0.05, noise)(t) })),
    );
    expect(Math.abs((features?.cadencePerMin ?? 0) - 120) / 120).toBeLessThanOrEqual(0.1);
  });

  test('does not count a small ripple riding on a big step as extra touches (relative prominence)', () => {
    // Ripples of 0.012 amplitude are above the absolute floor but far below a quarter of the 0.12 step range.
    const features = extractFeatures(
      sequence(12, 30, (t) => {
        const ripple = 0.012 * Math.sin(2 * Math.PI * 5 * t);
        const feet = steppingAnkles(1)(t);
        return {
          edits: {
            [L_ANKLE]: [0.53, (feet[L_ANKLE]?.[1] ?? 0.9) + ripple],
            [R_ANKLE]: [0.47, (feet[R_ANKLE]?.[1] ?? 0.9) + ripple],
          },
        };
      }),
    );
    expect(Math.abs((features?.cadencePerMin ?? 0) - 120) / 120).toBeLessThanOrEqual(0.1);
  });

  test('uses the frame timestamps, not the frame count (a clip at half speed is half the cadence)', () => {
    const fast = sequence(12, 30, (t) => ({ edits: steppingAnkles(1)(t) }));
    const slowed = fast.map((frame) => ({ ...frame, timeMs: frame.timeMs * 2 }));
    const cadence = extractFeatures(slowed)?.cadencePerMin ?? 0;
    expect(Math.abs(cadence - 60) / 60).toBeLessThanOrEqual(0.1);
  });

  test('is 0 (not omitted) when the feet are visible but do not move, jitter included', () => {
    const noise = seededNoise(0.002);
    const features = extractFeatures(
      sequence(12, 30, () => ({
        edits: { [L_ANKLE]: [0.53, 0.9 + noise()], [R_ANKLE]: [0.47, 0.9 + noise()] },
      })),
    );
    expect(features?.cadencePerMin).toBe(0);
  });
});

// --- left / right balance ----------------------------------------------------------------------------------------------

describe('leftRightBalance', () => {
  test('is near 1.0 for a sequence where only the left foot works', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({ edits: { [L_ANKLE]: [0.53, 0.9 + 0.05 * Math.sin(2 * Math.PI * 2 * t)] } })),
    );
    expect(features?.leftRightBalance).toBeGreaterThanOrEqual(0.95);
    expect(features?.leftRightBalance).toBeLessThanOrEqual(1);
    // the same left foot alone still yields the touch rate: 2 Hz = 120 per minute
    expect(Math.abs((features?.cadencePerMin ?? 0) - 120) / 120).toBeLessThanOrEqual(0.1);
  });

  test('is near 0 for a sequence where only the right foot works (0 = all right, per the contract)', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({ edits: { [R_ANKLE]: [0.47, 0.9 + 0.05 * Math.sin(2 * Math.PI * 2 * t)] } })),
    );
    expect(features?.leftRightBalance).toBeLessThanOrEqual(0.05);
    expect(features?.leftRightBalance).toBeGreaterThanOrEqual(0);
  });

  test('is about 0.5 when both feet share the work equally', () => {
    const features = extractFeatures(sequence(12, 30, (t) => ({ edits: steppingAnkles(1)(t) })));
    expect(features?.leftRightBalance).toBeGreaterThan(0.4);
    expect(features?.leftRightBalance).toBeLessThan(0.6);
  });

  test('reflects an uneven split: left twice as busy as right is about 2/3', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({
        edits: {
          [L_ANKLE]: [0.53, 0.9 + 0.05 * Math.sin(2 * Math.PI * 2 * t)],
          [R_ANKLE]: [0.47, 0.9 + 0.05 * Math.sin(2 * Math.PI * 1 * t)],
        },
      })),
    );
    expect(features?.leftRightBalance).toBeGreaterThan(0.6);
    expect(features?.leftRightBalance).toBeLessThan(0.73);
  });

  test('is omitted (nothing to balance) when no foot touches down', () => {
    const features = extractFeatures(sequence(12, 30, STILL));
    expect(features).not.toBeNull();
    expect('leftRightBalance' in (features ?? {})).toBe(false);
  });
});

// --- knee flexion ------------------------------------------------------------------------------------------------------

describe('kneeAngleStats', () => {
  test('a straight leg is 0 degrees, a knee bent to a 120 degree joint is 60 degrees of flexion', () => {
    const straight = extractFeatures(sequence(12, 30, () => ({ edits: kneeEdits(0) })));
    expect(straight?.kneeAngleStats?.mean).toBeCloseTo(0, 3);
    expect(straight?.kneeAngleStats?.max).toBeCloseTo(0, 3);

    const bent = extractFeatures(sequence(12, 30, () => ({ edits: kneeEdits(60) })));
    expect(bent?.kneeAngleStats?.mean).toBeCloseTo(60, 3);
    expect(bent?.kneeAngleStats?.min).toBeCloseTo(60, 3);
    expect(bent?.kneeAngleStats?.max).toBeCloseTo(60, 3);
    expect(bent?.kneeAngleStats?.stdDev).toBeCloseTo(0, 3);
  });

  test('summarises a moving knee: alternating 0 and 60 degrees gives mean 30, min 0, max 60, stdDev 30', () => {
    const features = extractFeatures(sequence(12, 30, (_t, index) => ({ edits: kneeEdits(index % 2 === 0 ? 0 : 60) })));
    const stats = features?.kneeAngleStats;
    expect(stats?.mean).toBeCloseTo(30, 3);
    expect(stats?.min).toBeCloseTo(0, 3);
    expect(stats?.max).toBeCloseTo(60, 3);
    expect(stats?.stdDev).toBeCloseTo(30, 3);
  });

  test('pools both knees: left straight, right bent by 90 degrees gives mean 45', () => {
    const left = kneeEdits(0);
    const right = kneeEdits(90);
    const features = extractFeatures(
      sequence(12, 30, () => ({
        edits: {
          [L_HIP]: left[L_HIP],
          [L_KNEE]: left[L_KNEE],
          [L_ANKLE]: left[L_ANKLE],
          [R_HIP]: right[R_HIP],
          [R_KNEE]: right[R_KNEE],
          [R_ANKLE]: right[R_ANKLE],
        },
      })),
    );
    expect(features?.kneeAngleStats?.mean).toBeCloseTo(45, 3);
    expect(features?.kneeAngleStats?.min).toBeCloseTo(0, 3);
    expect(features?.kneeAngleStats?.max).toBeCloseTo(90, 3);
  });

  test('uses the image aspect ratio: a 16:9 frame still measures 60 degrees, and not without the option', () => {
    const frames = sequence(12, 30, () => ({ edits: kneeEdits(60, 16 / 9) }));
    expect(extractFeatures(frames, { aspectRatio: 16 / 9 })?.kneeAngleStats?.mean).toBeCloseTo(60, 3);
    expect(Math.abs((extractFeatures(frames)?.kneeAngleStats?.mean ?? 60) - 60)).toBeGreaterThan(5);
  });

  test('a leg that is hidden while the other is visible still gives stats from the visible one', () => {
    const bent = kneeEdits(60);
    const features = extractFeatures(
      sequence(12, 30, () => ({
        edits: bent,
        visibility: (index) => (index === R_ANKLE ? 0.1 : 0.99),
      })),
    );
    expect(features?.kneeAngleStats?.mean).toBeCloseTo(60, 3);
  });
});

// --- trunk lean --------------------------------------------------------------------------------------------------------

describe('trunkLeanStats', () => {
  test('an upright torso is 0 degrees', () => {
    const features = extractFeatures(sequence(12, 30, () => ({ edits: torsoEdits(0, 0.06) })));
    expect(features?.trunkLeanStats?.mean).toBeCloseTo(0, 3);
  });

  test('leaning towards the side the nose points to is positive (forwards)', () => {
    const features = extractFeatures(sequence(12, 30, () => ({ edits: torsoEdits(20, 0.06) })));
    expect(features?.trunkLeanStats?.mean).toBeCloseTo(20, 3);
  });

  test('leaning away from the side the nose points to is negative (backwards)', () => {
    const features = extractFeatures(sequence(12, 30, () => ({ edits: torsoEdits(-15, 0.06) })));
    expect(features?.trunkLeanStats?.mean).toBeCloseTo(-15, 3);
  });

  test('the same body facing image-left flips the sign: shoulders towards +x are now backwards', () => {
    const features = extractFeatures(sequence(12, 30, () => ({ edits: torsoEdits(20, -0.06) })));
    expect(features?.trunkLeanStats?.mean).toBeCloseTo(-20, 3);
  });

  test('summarises a moving torso: alternating 10 and 30 degrees gives mean 20, min 10, max 30, stdDev 10', () => {
    const features = extractFeatures(
      sequence(12, 30, (_t, index) => ({ edits: torsoEdits(index % 2 === 0 ? 10 : 30, 0.06) })),
    );
    const stats = features?.trunkLeanStats;
    expect(stats?.mean).toBeCloseTo(20, 3);
    expect(stats?.min).toBeCloseTo(10, 3);
    expect(stats?.max).toBeCloseTo(30, 3);
    expect(stats?.stdDev).toBeCloseTo(10, 3);
  });

  test('is omitted, not guessed, when the facing direction cannot be told (nose over the shoulder line)', () => {
    const features = extractFeatures(sequence(12, 30, () => ({ edits: torsoEdits(20, 0) })));
    expect(features).not.toBeNull();
    expect('trunkLeanStats' in (features ?? {})).toBe(false);
  });

  test('a lean beyond 90 degrees counts as 90, per frame: folded and upright frames average to 45', () => {
    const folded: Edits = {
      [L_SHOULDER]: [0.6, 0.55],
      [R_SHOULDER]: [0.6, 0.55],
      [L_HIP]: [0.5, 0.5],
      [R_HIP]: [0.5, 0.5],
      [NOSE]: [0.7, 0.6],
    };
    const stats = extractFeatures(
      sequence(12, 30, (_t, index) => ({ edits: index % 2 === 0 ? folded : torsoEdits(0, 0.06) })),
    )?.trunkLeanStats;
    expect(stats?.max).toBeCloseTo(90, 6);
    expect(stats?.mean).toBeCloseTo(45, 1);
  });

  test('stays inside the contract range for a torso folded past horizontal', () => {
    const folded: Edits = {
      [L_SHOULDER]: [0.6, 0.55],
      [R_SHOULDER]: [0.6, 0.55],
      [L_HIP]: [0.5, 0.5],
      [R_HIP]: [0.5, 0.5],
      [NOSE]: [0.7, 0.6],
    };
    const stats = extractFeatures(sequence(12, 30, () => ({ edits: folded })))?.trunkLeanStats;
    expect(stats).toBeDefined();
    expect(stats?.max).toBeLessThanOrEqual(90);
    expect(stats?.min).toBeGreaterThanOrEqual(-90);
  });
});

// --- visibility and frame count ------------------------------------------------------------------------------------------

describe('meanVisibility and framesAnalysed', () => {
  test('meanVisibility is the mean over every landmark of every analysed frame', () => {
    const frames = [
      ...sequence(5, 30, () => ({ visibility: 0.8 })),
      ...sequence(5, 30, () => ({ visibility: 0.4 })).map((frame) => ({ ...frame, timeMs: frame.timeMs + 5000 })),
    ];
    const features = extractFeatures(frames);
    expect(features?.meanVisibility).toBeCloseTo(0.6, 6);
    expect(features?.framesAnalysed).toBe(300);
  });

  test('a frame without a detected person is not analysed', () => {
    const frames = sequence(12, 30, STILL);
    const withGaps: PoseFrame[] = frames.map((frame, index) => (index % 4 === 0 ? { ...frame, landmarks: [] } : frame));
    expect(extractFeatures(withGaps)?.framesAnalysed).toBe(360 - 90);
  });

  test('is null when nothing was analysed (a PoseFeatures needs framesAnalysed >= 1)', () => {
    expect(extractFeatures([])).toBeNull();
    expect(extractFeatures([{ timeMs: 0, landmarks: [] }])).toBeNull();
  });

  test('a landmark without a visibility counts as not visible', () => {
    const noVisibility: PoseFrame[] = sequence(12, 30, STILL).map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map(({ x, y }) => ({ x, y })),
    }));
    const features = extractFeatures(noVisibility);
    expect(features?.meanVisibility).toBe(0);
    expect('kneeAngleStats' in (features ?? {})).toBe(false);
  });
});

// --- low visibility omits metrics ----------------------------------------------------------------------------------------

describe('low visibility omits metrics', () => {
  test('nothing is guessed when every landmark is poorly visible', () => {
    const features = extractFeatures(sequence(12, 30, (t) => ({ edits: steppingAnkles(1)(t), visibility: 0.2 })));
    expect(features).not.toBeNull();
    expect(features?.meanVisibility).toBeCloseTo(0.2, 6);
    expect(features?.framesAnalysed).toBe(360);
    for (const key of ['cadencePerMin', 'leftRightBalance', 'kneeAngleStats', 'trunkLeanStats'] as const) {
      expect(key in (features ?? {})).toBe(false);
    }
  });

  test('the same clip with good visibility does report every metric', () => {
    const features = extractFeatures(
      sequence(12, 30, (t, index) => ({ edits: { ...steppingAnkles(1)(t), ...torsoEdits(10, 0.06), [L_KNEE]: [0.53, 0.7], [R_KNEE]: [0.47, 0.7] }, visibility: 0.9 + (index % 2) * 0.05 })),
    );
    expect(features?.cadencePerMin).toBeDefined();
    expect(features?.leftRightBalance).toBeDefined();
    expect(features?.kneeAngleStats).toBeDefined();
    expect(features?.trunkLeanStats).toBeDefined();
  });

  test('poorly visible ankles drop cadence, balance and knee flexion but keep the trunk lean', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({
        edits: { ...steppingAnkles(1)(t), ...torsoEdits(10, 0.06) },
        visibility: (index) => (index === L_ANKLE || index === R_ANKLE ? 0.1 : 0.99),
      })),
    );
    expect('cadencePerMin' in (features ?? {})).toBe(false);
    expect('leftRightBalance' in (features ?? {})).toBe(false);
    expect('kneeAngleStats' in (features ?? {})).toBe(false);
    expect(features?.trunkLeanStats?.mean).toBeCloseTo(10, 3);
  });

  test('one poorly visible ankle is enough to drop cadence and balance (half the feet is not the cadence)', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({
        edits: steppingAnkles(1)(t),
        visibility: (index) => (index === R_ANKLE ? 0.1 : 0.99),
      })),
    );
    expect('cadencePerMin' in (features ?? {})).toBe(false);
    expect('leftRightBalance' in (features ?? {})).toBe(false);
  });

  test('poorly visible shoulders drop the trunk lean but keep the cadence', () => {
    const features = extractFeatures(
      sequence(12, 30, (t) => ({
        edits: { ...steppingAnkles(1)(t), ...torsoEdits(10, 0.06) },
        visibility: (index) => (index === L_SHOULDER || index === R_SHOULDER ? 0.1 : 0.99),
      })),
    );
    expect('trunkLeanStats' in (features ?? {})).toBe(false);
    expect(features?.cadencePerMin).toBeDefined();
  });

  test('a landmark exactly at the visibility threshold is usable, just below it is not', () => {
    const at = extractFeatures(sequence(12, 30, () => ({ edits: kneeEdits(60), visibility: MIN_LANDMARK_VISIBILITY })));
    expect(at?.kneeAngleStats?.mean).toBeCloseTo(60, 3);
    const below = extractFeatures(
      sequence(12, 30, () => ({ edits: kneeEdits(60), visibility: MIN_LANDMARK_VISIBILITY - 0.01 })),
    );
    expect('kneeAngleStats' in (below ?? {})).toBe(false);
  });

  test('a landmark with a non-finite coordinate is treated as not visible', () => {
    const features = extractFeatures(
      sequence(12, 30, () => ({ edits: { ...kneeEdits(60), [L_ANKLE]: [Number.NaN, 0.9], [R_ANKLE]: [0.5, Number.NaN] } })),
    );
    expect('kneeAngleStats' in (features ?? {})).toBe(false);
    expect('cadencePerMin' in (features ?? {})).toBe(false);
  });

  test('metrics need a usable share of the analysed frames: 40% is too few, 90% is enough', () => {
    expect(MIN_USABLE_FRAME_SHARE).toBeGreaterThan(0.4);
    expect(MIN_USABLE_FRAME_SHARE).toBeLessThanOrEqual(0.9);
    const clip = (visibleFrames: number) =>
      extractFeatures(
        sequence(10, 10, (_t, index) => ({
          edits: kneeEdits(60),
          visibility: (landmark) => (landmark === L_ANKLE || landmark === R_ANKLE) && index >= visibleFrames ? 0.1 : 0.99,
        })),
      );
    const tooFew = clip(40);
    expect('kneeAngleStats' in (tooFew ?? {})).toBe(false);
    expect('cadencePerMin' in (tooFew ?? {})).toBe(false);
    const enough = clip(90);
    expect(enough?.kneeAngleStats?.mean).toBeCloseTo(60, 3);
    expect(enough?.cadencePerMin).toBeDefined();
  });

  test('a clip with fewer than MIN_USABLE_FRAMES usable frames reports no metrics, with exactly enough it does', () => {
    const shortClip = (frames: number) => extractFeatures(sequence(frames, 1, () => ({ edits: { ...kneeEdits(60), ...torsoEdits(10, 0.06), [L_KNEE]: [0.5, 0.7], [R_KNEE]: [0.5, 0.7] } })));
    const tooShort = shortClip(MIN_USABLE_FRAMES - 1);
    expect(tooShort?.framesAnalysed).toBe(MIN_USABLE_FRAMES - 1);
    expect(tooShort?.meanVisibility).toBeGreaterThan(0.9);
    expect('kneeAngleStats' in (tooShort ?? {})).toBe(false);
    expect('trunkLeanStats' in (tooShort ?? {})).toBe(false);
    expect('cadencePerMin' in (tooShort ?? {})).toBe(false);
    const enough = shortClip(MIN_USABLE_FRAMES);
    expect(enough?.kneeAngleStats).toBeDefined();
    expect(enough?.trunkLeanStats).toBeDefined();
    expect(enough?.cadencePerMin).toBeDefined();
  });
});

// --- contract and purity ------------------------------------------------------------------------------------------------

describe('output contract', () => {
  test('a full result parses as the PoseFeatures request schema', () => {
    const features = extractFeatures(
      sequence(12, 30, (t, index) => ({
        edits: { ...steppingAnkles(1)(t), ...torsoEdits(index % 2 === 0 ? 10 : 30, 0.06), ...kneeEdits(index % 2 === 0 ? 0 : 60) },
      })),
    );
    expect(PoseFeatures.safeParse(features).success).toBe(true);
  });

  test('a low-visibility result parses too, with only the two mandatory fields', () => {
    const features = extractFeatures(sequence(12, 30, STILL).map((frame) => ({ ...frame, landmarks: pose({}, 0.1) })));
    const parsed = PoseFeatures.safeParse(features);
    expect(parsed.success).toBe(true);
    expect(Object.keys(features ?? {}).sort()).toEqual(['framesAnalysed', 'meanVisibility']);
  });

  test('visibility above 1 counts as 1 and below 0 as 0 when averaging, so meanVisibility stays within 0..1', () => {
    const high = extractFeatures(sequence(12, 30, (_t, index) => ({ visibility: index % 2 === 0 ? 3 : 0.5 })));
    expect(high?.meanVisibility).toBeCloseTo(0.75, 6);
    const low = extractFeatures(sequence(12, 30, (_t, index) => ({ visibility: index % 2 === 0 ? -2 : 0.6 })));
    expect(low?.meanVisibility).toBeCloseTo(0.3, 6);
    expect(PoseFeatures.safeParse(high).success).toBe(true);
    expect(PoseFeatures.safeParse(low).success).toBe(true);
  });

  test('is pure: frozen input is neither mutated nor reordered, and the same input gives the same output', () => {
    const frames = deepFreeze(sequence(12, 30, (t) => ({ edits: { ...steppingAnkles(1)(t), ...torsoEdits(10, 0.06) } })));
    const first = extractFeatures(frames);
    const second = extractFeatures(frames);
    expect(second).toEqual(first);
    expect(frames).toHaveLength(360);
  });
});
