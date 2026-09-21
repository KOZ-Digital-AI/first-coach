import { describe, expect, mock, test } from 'bun:test';
import { POSE_MODEL_FILE, WASM_FILES } from '../../../../scripts/fetch-pose-model';
import type { PoseLandmarkerLike, PoseVideo, PoseVisionModule } from './pose';

// fc-mol-8nt.6: lazy pose landmarker loader. Nothing here loads the real @mediapipe/tasks-vision package, the real model or
// the network: the package is replaced by a recording fake (through the injected importer, and through mock.module for the
// one test that exercises the default dynamic import), and the <video> is a fake that fires `seeked` like a browser does.

// --- a recording fake of @mediapipe/tasks-vision ---------------------------------------------------------------------------

const LANDMARK_COUNT = 33;
const BASE_ORIGIN = 'https://coach.example';

interface FakeOptions {
  /** Delegates for which createFromOptions rejects (e.g. ['GPU'] = no WebGL). */
  failDelegates?: string[];
  /** Frame indices (0-based, in call order) for which no person is detected. */
  noPersonAt?: number[];
}

interface Creation {
  fileset: { wasmLoaderPath: string; wasmBinaryPath: string };
  options: { baseOptions: { modelAssetPath: string; delegate: string }; runningMode: string; numPoses?: number };
}

function makeVision(fake: FakeOptions = {}) {
  const calls = {
    basePaths: [] as string[],
    creations: [] as Creation[],
    detections: [] as { timestampMs: number; currentTime: number }[],
  };
  const failing = { delegates: [...(fake.failDelegates ?? [])] };
  const module: PoseVisionModule = {
    FilesetResolver: {
      // Same file naming as the real one: `${base}/vision_wasm_internal.js|.wasm` (see FilesetResolver.forVisionTasks).
      async forVisionTasks(basePath: string) {
        calls.basePaths.push(basePath);
        return { wasmLoaderPath: `${basePath}/vision_wasm_internal.js`, wasmBinaryPath: `${basePath}/vision_wasm_internal.wasm` };
      },
    },
    PoseLandmarker: {
      async createFromOptions(fileset: unknown, options: unknown) {
        const creation = { fileset, options } as Creation;
        calls.creations.push(creation);
        if (failing.delegates.includes(creation.options.baseOptions.delegate)) {
          throw new Error(`${creation.options.baseOptions.delegate} delegate unavailable`);
        }
        const landmarker: PoseLandmarkerLike = {
          detectForVideo(video, timestampMs) {
            const index = calls.detections.length;
            calls.detections.push({ timestampMs, currentTime: video.currentTime });
            if (fake.noPersonAt?.includes(index)) return { landmarks: [] };
            const pose = Array.from({ length: LANDMARK_COUNT }, (_, i) => ({ x: i / 100, y: 1 - i / 100, z: -0.1 * i, visibility: 0.9 }));
            return { landmarks: [pose] };
          },
        };
        return landmarker;
      },
    },
  };
  return { module, calls, failing };
}

// --- a fake <video> that seeks like a browser ------------------------------------------------------------------------------

type SeekEvent = 'seeked' | 'error';

interface FakeVideoOptions {
  /** Never fires `seeked` (a stalled video). */
  stalled?: boolean;
  /** Fires `error` instead of `seeked`. */
  failing?: boolean;
}

function makeVideo(duration: number, options: FakeVideoOptions = {}) {
  const listeners: Record<SeekEvent, Set<() => void>> = { seeked: new Set(), error: new Set() };
  let time = 0;
  const seeks: number[] = [];
  const video: PoseVideo = {
    duration,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      // Like a browser: writing the time you are already at seeks nowhere, so no `seeked` event follows.
      if (value === time) return;
      time = value;
      seeks.push(value);
      if (options.stalled) return;
      const type: SeekEvent = options.failing ? 'error' : 'seeked';
      queueMicrotask(() => {
        for (const listener of [...listeners[type]]) listener();
      });
    },
    addEventListener(type, listener) {
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener);
    },
  };
  return { video, seeks, listenerCount: () => listeners.seeked.size + listeners.error.size };
}

/** A detector wired to a fresh fake, already loaded. */
async function loadedDetector(fake: FakeOptions = {}, seekTimeoutMs = 200) {
  const vision = makeVision(fake);
  const detector = pose.createPoseDetector({ importVision: async () => vision.module, seekTimeoutMs });
  await detector.load();
  return { detector, vision };
}

// --- the default dynamic import: mock the package by its specifier, then import pose.ts ----------------------------------

// The factory runs when (and only when) something imports '@mediapipe/tasks-vision'. pose.ts is imported AFTER this
// registration, so a static import of the package in pose.ts would run the factory at import time and fail the first test.
const defaultVision = makeVision();
let packageEvaluations = 0;
mock.module('@mediapipe/tasks-vision', () => {
  packageEvaluations += 1;
  return defaultVision.module;
});
const pose = await import('./pose');

const sameOrigin = (url: string): boolean => new URL(url, BASE_ORIGIN).origin === BASE_ORIGIN;

// --- lazy loading ----------------------------------------------------------------------------------------------------------

describe('lazy loading', () => {
  test('importing pose.ts does not import @mediapipe/tasks-vision', () => {
    expect(packageEvaluations).toBe(0);
  });

  test('constructing a detector does not import the package either', () => {
    let imports = 0;
    pose.createPoseDetector({
      importVision: async () => {
        imports += 1;
        return makeVision().module;
      },
    });
    expect(imports).toBe(0);
  });

  test('load() is what dynamically imports the package (default importer) and creates the landmarker', async () => {
    expect(packageEvaluations).toBe(0);
    const detector = pose.createPoseDetector();
    await detector.load();
    expect(packageEvaluations).toBe(1);
    expect(defaultVision.calls.creations).toHaveLength(1);
  });

  test('the module-level load() and detectOnVideo() delegate to one shared detector', async () => {
    await pose.load();
    const { video } = makeVideo(1);
    const frames = await pose.detectOnVideo(video, 5);
    expect(frames).toHaveLength(5);
  });

  test('load() imports once and creates one landmarker, however often or concurrently it is called', async () => {
    let imports = 0;
    const vision = makeVision();
    const detector = pose.createPoseDetector({
      importVision: async () => {
        imports += 1;
        return vision.module;
      },
    });
    await Promise.all([detector.load(), detector.load()]);
    await detector.load();
    expect(imports).toBe(1);
    expect(vision.calls.creations).toHaveLength(1);
  });

  test('creates a VIDEO-mode landmarker for one person, trying the GPU delegate first', async () => {
    const { vision } = await loadedDetector();
    expect(vision.calls.creations).toHaveLength(1);
    const { options } = vision.calls.creations[0]!;
    expect(options.runningMode).toBe('VIDEO');
    expect(options.numPoses).toBe(1);
    expect(options.baseOptions.delegate).toBe('GPU');
  });

  test('falls back to the CPU delegate when the GPU delegate cannot be created', async () => {
    const { detector, vision } = await loadedDetector({ failDelegates: ['GPU'] });
    expect(vision.calls.creations.map((c) => c.options.baseOptions.delegate)).toEqual(['GPU', 'CPU']);
    expect(vision.calls.creations[1]!.options.runningMode).toBe('VIDEO');
    // ...and the CPU landmarker is the one that detects.
    const { video } = makeVideo(1);
    expect(await detector.detectOnVideo(video, 5)).toHaveLength(5);
  });

  test('load() rejects with a PoseError when even the CPU delegate fails, and can be retried', async () => {
    const vision = makeVision({ failDelegates: ['GPU', 'CPU'] });
    const detector = pose.createPoseDetector({ importVision: async () => vision.module });
    const failure = await detector.load().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(pose.PoseError);
    expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('load_failed');
    vision.failing.delegates.length = 0;
    await detector.load();
    const { video } = makeVideo(1);
    expect(await detector.detectOnVideo(video, 5)).toHaveLength(5);
  });

  test('load() rejects with a PoseError when the package itself cannot be imported', async () => {
    const detector = pose.createPoseDetector({
      importVision: async () => {
        throw new Error('chunk failed to load');
      },
    });
    const failure = await detector.load().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(pose.PoseError);
    expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('load_failed');
  });
});

// --- self-hosted, same-origin assets ---------------------------------------------------------------------------------------

describe('asset URLs', () => {
  test('the model and the WASM come from the self-hosted /mediapipe path, named as scripts/fetch-pose-model.ts writes them', async () => {
    const { vision } = await loadedDetector();
    expect(vision.calls.basePaths).toEqual(['/mediapipe']);
    const { fileset, options } = vision.calls.creations[0]!;
    expect(options.baseOptions.modelAssetPath).toBe(`/mediapipe/${POSE_MODEL_FILE}`);
    for (const path of [fileset.wasmLoaderPath, fileset.wasmBinaryPath]) {
      expect(path.startsWith('/mediapipe/')).toBe(true);
      expect(WASM_FILES).toContain(path.slice('/mediapipe/'.length));
    }
    expect(pose.POSE_MODEL_URL).toBe(`/mediapipe/${POSE_MODEL_FILE}`);
  });

  test('every URL handed to MediaPipe is same-origin, on both the GPU and the CPU attempt', async () => {
    const { vision } = await loadedDetector({ failDelegates: ['GPU'] });
    const urls = [
      ...vision.calls.basePaths,
      ...vision.calls.creations.flatMap((c) => [c.options.baseOptions.modelAssetPath, c.fileset.wasmLoaderPath, c.fileset.wasmBinaryPath]),
    ];
    expect(urls.length).toBeGreaterThanOrEqual(7);
    for (const url of urls) {
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i); // no scheme: never an http(s)://, data: or blob: URL
      expect(url.startsWith('//')).toBe(false); // never protocol-relative (a third-party host)
      expect(sameOrigin(url)).toBe(true);
      expect(url).not.toMatch(/googleapis|jsdelivr|unpkg|cdn/i);
    }
  });
});

// --- sampling timestamps -----------------------------------------------------------------------------------------------------

describe('sampleTimestampsMs', () => {
  test('a 20 s clip at 5 fps is sampled every 200 ms: 100 timestamps, 0 .. 19800', () => {
    const times = pose.sampleTimestampsMs(20, 5);
    expect(times).toHaveLength(100);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(200);
    expect(times[99]).toBe(19800);
    times.forEach((t, i) => expect(t).toBe(i * 200));
  });

  test('a 20 s clip at 10 fps is sampled every 100 ms: 200 timestamps', () => {
    const times = pose.sampleTimestampsMs(20, 10);
    expect(times).toHaveLength(200);
    expect(times[199]).toBe(19900);
  });

  test('timestamps are strictly increasing and stay before the end of the clip, also for a fractional duration or fps', () => {
    for (const [duration, fps] of [
      [10.5, 5],
      [12.34, 7],
      [30, 8],
      [1.1, 10],
    ] as const) {
      const times = pose.sampleTimestampsMs(duration, fps);
      expect(times.length).toBeGreaterThan(0);
      times.forEach((t, i) => {
        if (i > 0) expect(t).toBeGreaterThan(times[i - 1]!);
        expect(t).toBeLessThan(duration * 1000);
      });
      // No sample is skipped: the next one would fall at or after the end.
      expect(times.length * (1000 / fps)).toBeGreaterThanOrEqual(duration * 1000 - 1e-6);
    }
    expect(pose.sampleTimestampsMs(10.5, 5)).toHaveLength(53);
    expect(pose.sampleTimestampsMs(1.1, 10)).toHaveLength(11); // 1.1 * 10 = 11.000000000000002 must not add a 12th sample
    // Float noise in the duration itself: 0.1 * 3 = 0.30000000000000004 s (x 10 fps = 3.0000000000000004) is a 0.3 s clip.
    expect(pose.sampleTimestampsMs(0.1 * 3, 10)).toHaveLength(3);
    expect(pose.sampleTimestampsMs(0.2 * 3, 5)).toHaveLength(3);
  });

  test('fps is clamped to 5..10, and a missing or non-finite fps means 5', () => {
    expect(pose.sampleTimestampsMs(20, 1)).toHaveLength(100);
    expect(pose.sampleTimestampsMs(20, 60)).toHaveLength(200);
    expect(pose.sampleTimestampsMs(20, Number.NaN)).toHaveLength(100);
    expect(pose.sampleTimestampsMs(20)).toHaveLength(100);
  });

  test('a clip with no length has no samples', () => {
    expect(pose.sampleTimestampsMs(0, 5)).toEqual([]);
    expect(pose.sampleTimestampsMs(-3, 5)).toEqual([]);
    expect(pose.sampleTimestampsMs(Number.NaN, 5)).toEqual([]);
  });
});

// --- detectOnVideo -----------------------------------------------------------------------------------------------------------

describe('detectOnVideo', () => {
  test('samples a 20 s clip at 5 fps: seeks to each sample, detects there with that timestamp, returns one frame each', async () => {
    const { detector, vision } = await loadedDetector();
    const { video, seeks } = makeVideo(20);
    const frames = await detector.detectOnVideo(video, 5);

    expect(frames).toHaveLength(100);
    expect(frames.map((f) => f.timeMs)).toEqual(pose.sampleTimestampsMs(20, 5));
    // MediaPipe VIDEO mode needs strictly increasing timestamps; they are the sample times, and the frame is the one seeked to.
    expect(vision.calls.detections.map((d) => d.timestampMs)).toEqual(frames.map((f) => f.timeMs));
    for (const d of vision.calls.detections) expect(d.currentTime).toBeCloseTo(d.timestampMs / 1000, 6);
    // Sampled from the recorded clip by seeking (not played in real time): 99 seeks (t=0 is where it already is).
    expect(seeks).toHaveLength(99);
  });

  test('frames carry the 33 normalised landmarks of the detected pose, with visibility', async () => {
    const { detector } = await loadedDetector();
    const frames = await detector.detectOnVideo(makeVideo(2).video, 5);
    for (const frame of frames) {
      expect(frame.landmarks).toHaveLength(33);
      expect(frame.landmarks[5]).toEqual({ x: 0.05, y: 0.95, z: -0.5, visibility: 0.9 });
    }
  });

  test('a frame where nobody is detected is kept, with no landmarks', async () => {
    const { detector } = await loadedDetector({ noPersonAt: [1, 3] });
    const frames = await detector.detectOnVideo(makeVideo(1).video, 5);
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.landmarks.length)).toEqual([33, 0, 33, 0, 33]);
    expect(frames.map((f) => f.timeMs)).toEqual([0, 200, 400, 600, 800]);
  });

  test('a rate above 10 fps or below 5 fps is clamped', async () => {
    const { detector } = await loadedDetector();
    expect(await detector.detectOnVideo(makeVideo(2).video, 60)).toHaveLength(20);
    expect(await detector.detectOnVideo(makeVideo(2).video, 1)).toHaveLength(10);
  });

  test('reports progress after every frame as a fraction that rises to exactly 1', async () => {
    const { detector, vision } = await loadedDetector();
    const events: string[] = [];
    const fractions: number[] = [];
    // Progress is reported AFTER a frame is detected: at the n-th report, n detections have happened.
    await detector.detectOnVideo(makeVideo(20).video, 5, (fraction) => {
      fractions.push(fraction);
      events.push(`${vision.calls.detections.length}`);
    });
    expect(fractions).toHaveLength(100);
    fractions.forEach((f, i) => {
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
      if (i > 0) expect(f).toBeGreaterThan(fractions[i - 1]!);
      expect(events[i]).toBe(`${i + 1}`);
    });
    expect(fractions[99]).toBe(1);
    expect(fractions[49]).toBeCloseTo(0.5, 9);
  });

  test('works without a progress callback and leaves no seek listeners behind', async () => {
    const { detector } = await loadedDetector();
    const { video, listenerCount } = makeVideo(1);
    await detector.detectOnVideo(video);
    expect(listenerCount()).toBe(0);
  });

  test('rejects with not_loaded before load() has been called, and creates nothing', async () => {
    const vision = makeVision();
    const detector = pose.createPoseDetector({ importVision: async () => vision.module });
    const failure = await detector.detectOnVideo(makeVideo(1).video, 5).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(pose.PoseError);
    expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('not_loaded');
    expect(vision.calls.creations).toHaveLength(0);
  });

  test('rejects with invalid_duration for a clip whose duration is not a positive finite number', async () => {
    const { detector, vision } = await loadedDetector();
    for (const duration of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      const failure = await detector.detectOnVideo(makeVideo(duration).video, 5).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(pose.PoseError);
      expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('invalid_duration');
    }
    expect(vision.calls.detections).toHaveLength(0);
  });

  test('a stalled seek rejects with seek_timeout instead of hanging, and removes its listeners', async () => {
    const { detector } = await loadedDetector({}, 20);
    const { video, listenerCount } = makeVideo(20, { stalled: true });
    const failure = await detector.detectOnVideo(video, 5).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(pose.PoseError);
    expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('seek_timeout');
    expect(listenerCount()).toBe(0);
  });

  test('a video error during a seek rejects with seek_failed', async () => {
    const { detector } = await loadedDetector();
    const { video, listenerCount } = makeVideo(20, { failing: true });
    const failure = await detector.detectOnVideo(video, 5).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(pose.PoseError);
    expect((failure as InstanceType<typeof pose.PoseError>).code).toBe('seek_failed');
    expect(listenerCount()).toBe(0);
  });
});
