import { describe, expect, test } from 'bun:test';
import { pwaOptions } from '../vite.config';

// fc-zfg.4: the precache must not contain the self-hosted pose model or the MediaPipe WASM runtime (~970 KB of
// vision_wasm_*.js plus the .wasm files). The /video route fetches them over the network when it is opened.
//
// Reading of "matches globIgnores": a dist-relative file is left out of the precache when ANY globIgnores pattern
// matches it (workbox semantics), evaluated here with Bun.Glob (no new dependency). The vite config is importable
// without side effects in bun (pwa-config.test.ts already does it), so the real values are exercised.

type Workbox = { globPatterns?: string[]; globIgnores?: string[]; navigateFallbackDenylist?: RegExp[] };
const workbox = (pwaOptions.workbox ?? {}) as Workbox;

const matchesAny = (patterns: string[] | undefined, file: string) =>
  (patterns ?? []).some((p) => new Bun.Glob(p).match(file));
const isIgnored = (file: string) => matchesAny(workbox.globIgnores, file);
const isPrecached = (file: string) => matchesAny(workbox.globPatterns, file) && !isIgnored(file);
const blocksNavigation = (path: string) => (workbox.navigateFallbackDenylist ?? []).some((re) => re.test(path));

describe('precache excludes the pose model and the MediaPipe runtime', () => {
  test.each([
    'mediapipe/vision_wasm_internal.js',
    'mediapipe/vision_wasm_module_internal.js',
    'mediapipe/vision_wasm_nosimd_internal.js',
    'mediapipe/vision_wasm_internal.wasm',
    'mediapipe/vision_wasm_nosimd_internal.wasm',
    'mediapipe/pose_landmarker_lite.task',
    'mediapipe/anything/nested/loader.js',
  ])('globIgnores matches %s', (file) => {
    expect(isIgnored(file)).toBe(true);
  });

  test.each(['mediapipe/vision_wasm_internal.js', 'mediapipe/vision_wasm_nosimd_internal.js'])(
    'the precache would not include %s',
    (file) => {
      expect(isPrecached(file)).toBe(false);
    },
  );

  test('globIgnores still matches video files (mp4, webm) and .task anywhere', () => {
    expect(isIgnored('clips/demo.mp4')).toBe(true);
    expect(isIgnored('demo.mp4')).toBe(true);
    expect(isIgnored('clips/demo.webm')).toBe(true);
    expect(isIgnored('models/other.task')).toBe(true);
  });

  test('normal app assets are not ignored and are precached', () => {
    for (const file of ['assets/index-abc.js', 'assets/index-abc.css', 'index.html', 'pwa-192x192.png']) {
      expect(isIgnored(file)).toBe(false);
      expect(isPrecached(file)).toBe(true);
    }
  });

  test('a look-alike outside mediapipe/ is not swept up by the mediapipe ignore', () => {
    expect(isIgnored('assets/mediapipe-chunk-abc.js')).toBe(false);
    expect(isIgnored('assets/vision_wasm_notes.js')).toBe(false);
  });

  test('the navigation fallback never serves index.html for mediapipe/ URLs', () => {
    expect(blocksNavigation('/mediapipe/vision_wasm_internal.js')).toBe(true);
    expect(blocksNavigation('/mediapipe/vision_wasm_internal.wasm')).toBe(true);
    expect(blocksNavigation('/mediapipe/pose_landmarker_lite.task')).toBe(true);
  });

  test('the navigation fallback still serves app routes, and the existing denylist entries remain', () => {
    expect(blocksNavigation('/video')).toBe(false);
    expect(blocksNavigation('/train')).toBe(false);
    expect(blocksNavigation('/mediapipe-guide')).toBe(false);
    expect(blocksNavigation('/api/players')).toBe(true);
    expect(blocksNavigation('/health')).toBe(true);
    expect(blocksNavigation('/media/x')).toBe(true);
    expect(blocksNavigation('/uploads/x')).toBe(true);
  });
});
