import { describe, expect, test } from 'bun:test';
import { KEYFRAME_MAX_BYTES, KEYFRAME_MAX_COUNT, KEYFRAME_MAX_SIDE_PX, KEYFRAME_MIN_COUNT, Keyframe, base64DecodedBytes } from '@api-types/video';
import { KeyframeError, sampleKeyframes, seekVideo, selectKeyframeIndices } from './keyframes';
import type { Canvas2D, CanvasLike, KeyframeVideo, Landmark, PoseFrame } from './keyframes';

// PRIVACY (risk:privacy): the raw video never leaves the device. The sampler turns it into 3..6 small JPEG keyframes that
// satisfy the merged contract (apps/api/src/shared/video.ts). Nothing here touches real media: the canvas, the <video> and
// the seek are injected seams (a recording canvas stub, a fake video). Re-encoding through a canvas strips EXIF/GPS by
// construction (no metadata is ever copied), so what is asserted is that the bytes returned are exactly canvas.toDataURL's
// JPEG output, bare base64, inside the contract limits.

const FACE_COUNT = 11; // MediaPipe pose landmarks 0..10 are nose, eyes, ears and mouth.
const LANDMARK_COUNT = 33;

/**
 * A 33-landmark pose whose landmarks all share one visibility. Normalised coordinates: the face sits on top
 * (x 0.47..0.53, y 0.20..0.24), the body spans x 0.40..0.59, y 0.30..0.87.
 */
function poseFrame(timeSec: number, visibility: number, patch: Record<number, Landmark> = {}): PoseFrame {
  const landmarks: Landmark[] = [];
  for (let i = 0; i < LANDMARK_COUNT; i += 1) {
    if (i < FACE_COUNT) landmarks.push({ x: 0.47 + 0.006 * i, y: 0.2 + 0.004 * i, visibility });
    else landmarks.push({ x: 0.4 + ((i - FACE_COUNT) * 0.2) / 21, y: 0.3 + ((i - FACE_COUNT) * 0.6) / 21, visibility });
  }
  for (const [index, landmark] of Object.entries(patch)) landmarks[Number(index)] = landmark;
  return { timeSec, landmarks };
}

const series = (visibilities: number[]): PoseFrame[] => visibilities.map((v, i) => poseFrame(i * 0.1, v));

// --- selectKeyframeIndices ----------------------------------------------------------------------------------------------

describe('selectKeyframeIndices', () => {
  test('picks the best-visible frame of each equal slice of the clip', () => {
    // 12 frames, 3 slices of 4: [0..3] best at 1, [4..7] best at 6, [8..11] best at 11.
    const frames = series([0.2, 0.9, 0.3, 0.1, 0.5, 0.4, 0.95, 0.2, 0.3, 0.3, 0.6, 0.7]);
    expect(selectKeyframeIndices(frames, 3)).toEqual([1, 6, 11]);
  });

  test('stays evenly spread even when every good frame is in the first half', () => {
    const frames = series([0.9, 0.95, 0.9, 0.99, 0.9, 0.9, 0.2, 0.1, 0.3, 0.1, 0.2, 0.15]);
    const picked = selectKeyframeIndices(frames, 3);
    expect(picked).toHaveLength(3);
    // one pick per third of the clip: [0..3], [4..7], [8..11]
    expect(picked[0]).toBeLessThan(4);
    expect(picked[1]).toBeGreaterThanOrEqual(4);
    expect(picked[1]).toBeLessThan(8);
    expect(picked[2]).toBeGreaterThanOrEqual(8);
  });

  test('takes the best frame of a slice wherever it sits: first, middle or last', () => {
    // 9 frames, 3 slices of 3: best at 1 (middle), 5 (last), 6 (first).
    const frames = series([0.1, 0.9, 0.2, 0.3, 0.4, 0.8, 0.95, 0.5, 0.6]);
    expect(selectKeyframeIndices(frames, 3)).toEqual([1, 5, 6]);
  });

  test('breaks visibility ties toward the middle of the slice, then the earliest frame', () => {
    const frames = series(Array.from({ length: 12 }, () => 0.8));
    // slices [0..3] [4..7] [8..11] have centres 1.5, 5.5, 9.5; the earlier of the two middle frames wins
    expect(selectKeyframeIndices(frames, 3)).toEqual([1, 5, 9]);
  });

  test('scores a frame by the mean visibility of its landmarks, a missing visibility counting as 0', () => {
    // slice 0 = [scattered, steady]. scattered: 20 landmarks at 0.6 and 13 without a visibility, mean 0.364 but median 0.6.
    const noVisibility = Object.fromEntries(Array.from({ length: LANDMARK_COUNT - 20 }, (_, i) => [20 + i, { x: 0.5, y: 0.5 }])) as Record<number, Landmark>;
    const scattered = poseFrame(0, 0.6, noVisibility);
    const steady = poseFrame(0.1, 0.4); // mean 0.4
    const rest = series([0.1, 0.1, 0.1, 0.1]);
    expect(selectKeyframeIndices([scattered, steady, ...rest], 3)).toEqual([1, 2, 4]);
  });

  test('returns strictly ascending, distinct indices, and every frame when frames == n', () => {
    expect(selectKeyframeIndices(series([0.5, 0.6, 0.7, 0.8, 0.9, 1]), 6)).toEqual([0, 1, 2, 3, 4, 5]);
    const many = series(Array.from({ length: 101 }, (_, i) => ((i * 37) % 100) / 100));
    for (let n = KEYFRAME_MIN_COUNT; n <= KEYFRAME_MAX_COUNT; n += 1) {
      const picked = selectKeyframeIndices(many, n);
      expect(picked).toHaveLength(n);
      for (let i = 1; i < picked.length; i += 1) expect(picked[i]).toBeGreaterThan(picked[i - 1] as number);
      expect(picked[0]).toBeGreaterThanOrEqual(0);
      expect(picked[n - 1]).toBeLessThan(101);
    }
  });

  test('rejects an n outside the contract range 3..6 or not an integer', () => {
    const frames = series(Array.from({ length: 20 }, () => 0.9));
    for (const n of [2, 7, 0, -1, 3.5, Number.NaN]) {
      expect(() => selectKeyframeIndices(frames, n)).toThrow(KeyframeError);
    }
    for (const n of [3, 4, 5, 6]) expect(() => selectKeyframeIndices(frames, n)).not.toThrow();
  });

  test('rejects a clip with fewer analysed frames than keyframes wanted', () => {
    expect(() => selectKeyframeIndices(series([0.9, 0.9, 0.9, 0.9]), 5)).toThrow(KeyframeError);
    try {
      selectKeyframeIndices(series([0.9, 0.9]), 3);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KeyframeError);
      expect((err as KeyframeError).code).toBe('not_enough_frames');
    }
  });
});

// --- harness: fake video + recording canvas -----------------------------------------------------------------------------

class FakeVideo implements KeyframeVideo {
  currentTime = 0;
  listeners = 0;
  private readonly target = new EventTarget();
  constructor(
    readonly videoWidth: number,
    readonly videoHeight: number,
  ) {}
  addEventListener(type: 'seeked' | 'error', listener: () => void): void {
    this.listeners += 1;
    this.target.addEventListener(type, listener);
  }
  removeEventListener(type: 'seeked' | 'error', listener: () => void): void {
    this.listeners -= 1;
    this.target.removeEventListener(type, listener);
  }
  emit(type: 'seeked' | 'error'): void {
    this.target.dispatchEvent(new Event(type));
  }
}

type Op =
  | { kind: 'seek'; timeSec: number }
  | { kind: 'draw'; canvas: number; image: unknown; args: number[] }
  | { kind: 'encode'; canvas: number; type: string | undefined; quality: number | undefined };

/** Bare base64 of `bytes` decoded bytes that starts with the JPEG marker "/9j/" (bytes >= 6). */
function jpegBase64(bytes: number): string {
  const groups = Math.ceil(bytes / 3);
  const padding = groups * 3 - bytes;
  const last = padding === 0 ? 'AAAA' : padding === 1 ? 'AAA=' : 'AA==';
  return '/9j/' + 'A'.repeat(4 * (groups - 2)) + last;
}
const jpegDataUrl = (bytes: number): string => `data:image/jpeg;base64,${jpegBase64(bytes)}`;

type Encoder = (quality: number | undefined) => string;

class StubCanvas implements CanvasLike {
  constructor(
    readonly id: number,
    public width: number,
    public height: number,
    private readonly log: Op[],
    private readonly encode: Encoder,
    private readonly hasContext: boolean,
  ) {}
  getContext(_type: '2d'): Canvas2D | null {
    if (!this.hasContext) return null;
    return {
      imageSmoothingEnabled: true,
      drawImage: (image: unknown, ...args: number[]) => {
        this.log.push({ kind: 'draw', canvas: this.id, image, args });
      },
    };
  }
  toDataURL(type?: string, quality?: number): string {
    this.log.push({ kind: 'encode', canvas: this.id, type, quality });
    return this.encode(quality);
  }
}

function harness(encode: Encoder = () => jpegDataUrl(30_000), hasContext = true) {
  const log: Op[] = [];
  const canvases: StubCanvas[] = [];
  const createCanvas = (width: number, height: number): CanvasLike => {
    const canvas = new StubCanvas(canvases.length, width, height, log, encode, hasContext);
    canvases.push(canvas);
    return canvas;
  };
  const seek = async (_video: KeyframeVideo, timeSec: number): Promise<void> => {
    log.push({ kind: 'seek', timeSec });
  };
  return { log, canvases, deps: { createCanvas, seek } };
}

const drawOps = (log: Op[]) => log.filter((op): op is Extract<Op, { kind: 'draw' }> => op.kind === 'draw');
const encodeOps = (log: Op[]) => log.filter((op): op is Extract<Op, { kind: 'encode' }> => op.kind === 'encode');

/** A 12-frame clip, 0.5 s apart, every frame well visible. */
const clip = (patch: Record<number, Landmark> = {}): PoseFrame[] => Array.from({ length: 12 }, (_, i) => poseFrame(i * 0.5, 0.9, patch));

test('the harness builds base64 of exactly the byte size asked for', () => {
  for (const bytes of [6, 7, 8, 30_000, KEYFRAME_MAX_BYTES, KEYFRAME_MAX_BYTES + 1]) {
    expect(base64DecodedBytes(jpegBase64(bytes))).toBe(bytes);
  }
});

// --- sampleKeyframes: output contract -----------------------------------------------------------------------------------

describe('sampleKeyframes output', () => {
  test('returns n keyframes, each valid under the merged contract schema, bare base64 from canvas.toDataURL', async () => {
    for (const n of [3, 4, 5, 6]) {
      const h = harness(() => jpegDataUrl(30_000));
      const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), n, h.deps);
      expect(result).toHaveLength(n);
      for (const frame of result) {
        expect(Keyframe.safeParse(frame).success).toBe(true);
        expect(Object.keys(frame).sort()).toEqual(['data', 'height', 'mimeType', 'width']);
        expect(frame.mimeType).toBe('image/jpeg');
        expect(frame.data.startsWith('/9j/')).toBe(true);
        expect(frame.data.startsWith('data:')).toBe(false);
        expect(frame.data).toBe(jpegBase64(30_000));
      }
    }
  });

  test('reports the width and height of the canvas the JPEG was exported from', async () => {
    const h = harness();
    const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps);
    const mains = encodeOps(h.log).map((op) => h.canvases[op.canvas] as StubCanvas);
    expect(mains).toHaveLength(3);
    result.forEach((frame, i) => {
      expect(frame.width).toBe((mains[i] as StubCanvas).width);
      expect(frame.height).toBe((mains[i] as StubCanvas).height);
    });
  });

  test('rejects n outside 3..6 before touching the video or the canvas', async () => {
    for (const n of [2, 7]) {
      const h = harness();
      await expect(sampleKeyframes(new FakeVideo(1280, 720), clip(), n, h.deps)).rejects.toBeInstanceOf(KeyframeError);
      expect(h.log).toEqual([]);
      expect(h.canvases).toHaveLength(0);
    }
  });

  test('rejects a video whose metadata is not loaded (0x0)', async () => {
    const h = harness();
    await expect(sampleKeyframes(new FakeVideo(0, 0), clip(), 3, h.deps)).rejects.toMatchObject({ code: 'video_not_ready' });
    expect(h.log).toEqual([]);
  });

  test('rejects when the canvas has no 2d context', async () => {
    const h = harness(undefined, false);
    await expect(sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps)).rejects.toMatchObject({ code: 'no_canvas' });
    expect(encodeOps(h.log)).toHaveLength(0);
  });

  test('rejects a selected frame without pose landmarks: its face cannot be located, so it is never exported', async () => {
    const frames = clip();
    frames[1] = { timeSec: 0.5, landmarks: [] };
    frames[0] = { timeSec: 0, landmarks: [] };
    frames[2] = { timeSec: 1, landmarks: [] };
    frames[3] = { timeSec: 1.5, landmarks: [] }; // the whole first slice has no pose
    const h = harness();
    await expect(sampleKeyframes(new FakeVideo(1280, 720), frames, 3, h.deps)).rejects.toMatchObject({ code: 'no_pose' });
    expect(encodeOps(h.log)).toHaveLength(0);
  });
});

// --- sampleKeyframes: which moments, and seeking ------------------------------------------------------------------------

describe('sampleKeyframes moments', () => {
  test('seeks to the selected frames in time order, drawing each right after its seek', async () => {
    const frames = clip();
    const wanted = selectKeyframeIndices(frames, 4).map((i) => (frames[i] as PoseFrame).timeSec);
    const video = new FakeVideo(1280, 720);
    const h = harness();
    await sampleKeyframes(video, frames, 4, h.deps);
    const seeks = h.log.flatMap((op, index) => (op.kind === 'seek' ? [{ index, timeSec: op.timeSec }] : []));
    const draws = drawOps(h.log).filter((op) => op.image === video);
    expect(seeks.map((s) => s.timeSec)).toEqual(wanted);
    expect(draws).toHaveLength(4);
    const drawIndexes = h.log.flatMap((op, index) => (op.kind === 'draw' && op.image === video ? [index] : []));
    drawIndexes.forEach((drawIndex, i) => {
      expect(seeks[i]?.index).toBeLessThan(drawIndex);
      if (i + 1 < seeks.length) expect(drawIndex).toBeLessThan((seeks[i + 1] as { index: number }).index);
    });
  });
});

// --- sampleKeyframes: crop, margin, downscale ---------------------------------------------------------------------------

/** Source rect (in video pixels) and destination size of the video draw of the first exported keyframe. */
function videoDraw(h: ReturnType<typeof harness>, video: FakeVideo) {
  const op = drawOps(h.log).find((d) => d.image === video);
  if (!op) throw new Error('no drawImage(video, ...) recorded');
  const [sx, sy, sw, sh, dx, dy, dw, dh] = op.args as [number, number, number, number, number, number, number, number];
  return { canvas: op.canvas, sx, sy, sw, sh, dx, dy, dw, dh };
}

describe('sampleKeyframes crop and downscale', () => {
  test('crops to the visible body bounding box plus a margin, ignoring low-visibility landmarks', async () => {
    const video = new FakeVideo(1280, 720);
    const h = harness();
    // landmark 32 is a guess far in the corner with visibility 0.1: it must not stretch the crop
    await sampleKeyframes(video, clip({ 32: { x: 0.02, y: 0.98, visibility: 0.1 } }), 3, h.deps);
    const d = videoDraw(h, video);
    // visible body: x 0.40..0.59 (of 1280), y 0.20..0.87 (of 720)
    const box = { x0: 0.4 * 1280, x1: 0.59 * 1280, y0: 0.2 * 720, y1: 0.871 * 720 };
    const slackLeft = box.x0 - d.sx;
    const slackRight = d.sx + d.sw - box.x1;
    const slackTop = box.y0 - d.sy;
    const slackBottom = d.sy + d.sh - box.y1;
    for (const slack of [slackLeft, slackRight, slackTop, slackBottom]) expect(slack).toBeGreaterThan(0); // a margin exists
    expect(slackLeft).toBeLessThan((box.x1 - box.x0) * 0.5); // ...and it is a margin, not the whole frame
    expect(slackRight).toBeLessThan((box.x1 - box.x0) * 0.5);
    expect(slackTop).toBeLessThan((box.y1 - box.y0) * 0.5);
    expect(slackBottom).toBeLessThan((box.y1 - box.y0) * 0.5);
    expect(d.sx).toBeGreaterThan(0.3 * 1280); // the low-visibility corner guess (x 0.02) was ignored
  });

  test('clamps the crop to the video frame when the body touches the edge', async () => {
    const video = new FakeVideo(1280, 720);
    const h = harness();
    await sampleKeyframes(video, clip({ 20: { x: 0, y: 0.5, visibility: 0.9 }, 21: { x: 1, y: 0.95, visibility: 0.9 } }), 3, h.deps);
    const d = videoDraw(h, video);
    expect(d.sx).toBe(0);
    expect(d.sx + d.sw).toBe(1280);
    expect(d.sy).toBeGreaterThanOrEqual(0);
    expect(d.sy + d.sh).toBeLessThanOrEqual(720);
  });

  test('downscales so the longest side is exactly 512 px, keeping the aspect ratio', async () => {
    const video = new FakeVideo(3840, 2160);
    const h = harness();
    await sampleKeyframes(video, clip(), 3, h.deps);
    const d = videoDraw(h, video);
    const canvas = h.canvases[d.canvas] as StubCanvas;
    expect(Math.max(canvas.width, canvas.height)).toBe(KEYFRAME_MAX_SIDE_PX);
    expect(Math.abs(canvas.width / canvas.height - d.sw / d.sh)).toBeLessThan(0.02);
    expect([d.dx, d.dy, d.dw, d.dh]).toEqual([0, 0, canvas.width, canvas.height]);
  });

  test('keeps every keyframe within 512 px whatever the video size and orientation', async () => {
    for (const [w, h2] of [
      [1280, 720],
      [720, 1280],
      [3840, 2160],
      [1920, 1920],
    ] as const) {
      const h = harness();
      const result = await sampleKeyframes(new FakeVideo(w, h2), clip(), 5, h.deps);
      for (const frame of result) {
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.height).toBeGreaterThan(0);
        expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(KEYFRAME_MAX_SIDE_PX);
      }
    }
  });

  test('never upscales a small crop', async () => {
    const video = new FakeVideo(320, 240);
    const h = harness();
    await sampleKeyframes(video, clip(), 3, h.deps);
    const d = videoDraw(h, video);
    expect(d.sh).toBeLessThan(KEYFRAME_MAX_SIDE_PX);
    const canvas = h.canvases[d.canvas] as StubCanvas;
    expect(canvas.width).toBe(Math.round(d.sw));
    expect(canvas.height).toBe(Math.round(d.sh));
  });
});

// --- sampleKeyframes: face blur -----------------------------------------------------------------------------------------

/** Face landmarks (indices 0..10) moved to `cx, cy` (normalised), visible. */
const faceAt = (cx: number, cy: number): Record<number, Landmark> =>
  (Object.fromEntries(Array.from({ length: FACE_COUNT }, (_, i) => [i, { x: cx + 0.006 * (i - 5), y: cy + 0.004 * (i - 5), visibility: 0.9 }])) as Record<number, Landmark>);

describe('sampleKeyframes face blur', () => {
  for (const [name, patch, vw, vh] of [
    ['default layout', {}, 1280, 720],
    ['face lower and to the right', faceAt(0.55, 0.45), 1280, 720],
    ['portrait video', {}, 720, 1280],
  ] as const) {
    test(`blurs a region covering the face landmarks, after the frame is drawn and before any export (${name})`, async () => {
      const video = new FakeVideo(vw, vh);
      const h = harness();
      const frames = clip(patch);
      await sampleKeyframes(video, frames, 3, h.deps);

      const d = videoDraw(h, video);
      const k = d.dw / d.sw;
      const face = (frames[0] as PoseFrame).landmarks.slice(0, FACE_COUNT).map((l) => ({ x: (l.x * vw - d.sx) * k, y: (l.y * vh - d.sy) * k }));
      const box = {
        x0: Math.min(...face.map((p) => p.x)),
        x1: Math.max(...face.map((p) => p.x)),
        y0: Math.min(...face.map((p) => p.y)),
        y1: Math.max(...face.map((p) => p.y)),
      };

      const videoDrawIndex = h.log.findIndex((op) => op.kind === 'draw' && op.image === video);
      const firstEncodeIndex = h.log.findIndex((op) => op.kind === 'encode');
      const main = h.canvases[d.canvas] as StubCanvas;

      // 1. the face region is read back from the frame and shrunk onto a much smaller canvas (destroys detail)...
      const shrink = h.log.findIndex((op) => op.kind === 'draw' && op.image === main && op.canvas !== main.id);
      expect(shrink).toBeGreaterThan(videoDrawIndex);
      const shrinkOp = h.log[shrink] as Extract<Op, { kind: 'draw' }>;
      const [rx, ry, rw, rh] = shrinkOp.args as [number, number, number, number];
      expect(rx).toBeLessThanOrEqual(box.x0);
      expect(ry).toBeLessThanOrEqual(box.y0);
      expect(rx + rw).toBeGreaterThanOrEqual(box.x1);
      expect(ry + rh).toBeGreaterThanOrEqual(box.y1);
      const small = h.canvases[shrinkOp.canvas] as StubCanvas;
      expect(small.width).toBeLessThan(rw / 2);
      expect(small.height).toBeLessThan(rh / 2);
      expect(small.width).toBeGreaterThanOrEqual(1);
      expect(small.height).toBeGreaterThanOrEqual(1);

      // 2. ...and painted back over the same region of the frame, before the JPEG is ever exported
      const back = h.log.findIndex((op, i) => i > shrink && op.kind === 'draw' && op.canvas === main.id && op.image === small);
      expect(back).toBeGreaterThan(shrink);
      expect(back).toBeLessThan(firstEncodeIndex);
      const [bx, by, bw, bh] = (h.log[back] as Extract<Op, { kind: 'draw' }>).args.slice(4) as [number, number, number, number];
      expect(bx).toBeLessThanOrEqual(box.x0);
      expect(by).toBeLessThanOrEqual(box.y0);
      expect(bx + bw).toBeGreaterThanOrEqual(box.x1);
      expect(by + bh).toBeGreaterThanOrEqual(box.y1);

      // 3. only the face is blurred, not the whole keyframe (the body pose must stay readable for the vision model)
      expect(bw * bh).toBeLessThan(main.width * main.height * 0.3);
    });
  }

  test('blurs every keyframe, each before its own export', async () => {
    const video = new FakeVideo(1280, 720);
    const h = harness();
    await sampleKeyframes(video, clip(), 4, h.deps);
    const encodes = encodeOps(h.log);
    expect(encodes).toHaveLength(4);
    for (const enc of encodes) {
      const encodeIndex = h.log.indexOf(enc);
      // a draw onto this keyframe's canvas whose source is another canvas (not the video) happened before its export
      const blurBack = h.log.findIndex((op, i) => i < encodeIndex && op.kind === 'draw' && op.canvas === enc.canvas && op.image instanceof StubCanvas);
      expect(blurBack).toBeGreaterThanOrEqual(0);
    }
  });
});

// --- sampleKeyframes: JPEG size / quality loop --------------------------------------------------------------------------

describe('sampleKeyframes size and quality loop', () => {
  test('exports image/jpeg, starting at a high quality and stepping down gradually until the frame fits the byte cap', async () => {
    // 300 KB at quality >= 0.5, 150 KB below: only a lower quality fits under the 200 KB cap
    const h = harness((q) => jpegDataUrl((q ?? 1) >= 0.5 ? 300 * 1024 : 150 * 1024));
    const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps);
    for (const frame of result) expect(base64DecodedBytes(frame.data)).toBe(150 * 1024);

    for (const canvasId of new Set(encodeOps(h.log).map((e) => e.canvas))) {
      const tries = encodeOps(h.log).filter((e) => e.canvas === canvasId);
      expect(tries.every((e) => e.type === 'image/jpeg')).toBe(true);
      const qualities = tries.map((e) => e.quality as number);
      expect(qualities.length).toBeGreaterThanOrEqual(2);
      expect(qualities[0]).toBeGreaterThanOrEqual(0.7);
      qualities.forEach((q, i) => {
        expect(q).toBeGreaterThan(0);
        expect(q).toBeLessThanOrEqual(1);
        if (i > 0) {
          expect(q).toBeLessThan(qualities[i - 1] as number);
          expect((qualities[i - 1] as number) - q).toBeLessThanOrEqual(0.2 + 1e-9);
        }
      });
      // the loop stops at the first quality that fits: every earlier try was over the cap, the last one is under
      expect(qualities.slice(0, -1).every((q) => q >= 0.5)).toBe(true);
      expect(qualities[qualities.length - 1]).toBeLessThan(0.5);
    }
  });

  test('accepts a frame of exactly the byte cap on the first try', async () => {
    const h = harness(() => jpegDataUrl(KEYFRAME_MAX_BYTES));
    const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps);
    expect(encodeOps(h.log)).toHaveLength(3);
    for (const frame of result) expect(base64DecodedBytes(frame.data)).toBe(KEYFRAME_MAX_BYTES);
  });

  test('retries a frame one byte over the cap at a lower quality', async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return jpegDataUrl(calls % 2 === 1 ? KEYFRAME_MAX_BYTES + 1 : KEYFRAME_MAX_BYTES);
    });
    const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps);
    expect(encodeOps(h.log)).toHaveLength(6); // two tries per keyframe
    for (const frame of result) expect(base64DecodedBytes(frame.data)).toBeLessThanOrEqual(KEYFRAME_MAX_BYTES);
  });

  test('gives up with too_large, after a finite number of tries, when no quality fits the cap', async () => {
    const h = harness(() => jpegDataUrl(KEYFRAME_MAX_BYTES + 3));
    await expect(sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps)).rejects.toMatchObject({ code: 'too_large' });
    const tries = encodeOps(h.log).length;
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(20);
  });

  test('never returns an oversized keyframe: the contract byte cap holds for every returned frame', async () => {
    const h = harness((q) => jpegDataUrl(Math.floor((q ?? 1) * 260 * 1024)));
    const result = await sampleKeyframes(new FakeVideo(1280, 720), clip(), 6, h.deps);
    for (const frame of result) expect(base64DecodedBytes(frame.data)).toBeLessThanOrEqual(KEYFRAME_MAX_BYTES);
  });

  test('rejects an export that is not a JPEG (a browser falling back to PNG, or an empty canvas)', async () => {
    for (const bad of ['data:image/png;base64,iVBORw0KGgo=', 'data:,', 'data:image/jpeg;base64,iVBORw0KGgoAAAAN']) {
      const h = harness(() => bad);
      await expect(sampleKeyframes(new FakeVideo(1280, 720), clip(), 3, h.deps)).rejects.toMatchObject({ code: 'bad_encoding' });
    }
  });
});

// --- seekVideo (default seek seam) --------------------------------------------------------------------------------------

describe('seekVideo', () => {
  test('sets currentTime and resolves only once the video reports seeked, then removes its listeners', async () => {
    const video = new FakeVideo(1280, 720);
    let done = false;
    const promise = seekVideo(video, 2.5).then(() => {
      done = true;
    });
    expect(video.currentTime).toBe(2.5);
    await Promise.resolve();
    expect(done).toBe(false);
    video.emit('seeked');
    await promise;
    expect(done).toBe(true);
    expect(video.listeners).toBe(0);
  });

  test('rejects with seek_failed when the video reports an error', async () => {
    const video = new FakeVideo(1280, 720);
    const promise = seekVideo(video, 1);
    video.emit('error');
    await expect(promise).rejects.toMatchObject({ code: 'seek_failed' });
    expect(video.listeners).toBe(0);
  });

  test('resolves immediately when the video is already at that time (no seeked event would fire)', async () => {
    const video = new FakeVideo(1280, 720);
    video.currentTime = 3;
    await seekVideo(video, 3);
    expect(video.listeners).toBe(0);
  });
});
