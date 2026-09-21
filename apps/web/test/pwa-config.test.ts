import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as viteConfig from '../vite.config';

// fc-mol-eay.1: PWA manifest, icons and service worker configuration.
//
// Two layers, neither needs a browser:
//   1. the config read as data: `pwaOptions` (the object vite.config.ts hands to VitePWA);
//   2. the real build output: one `vite build` into a temp dir (removed in afterAll), then
//      manifest.webmanifest, sw.js and index.html are read from it as files.
//
// Reading of "lang-neutral": the manifest has NO `lang` key (the app is kk/ru/en and the
// name is bilingual, so no single language is declared for the whole app).
// Reading of "NO runtime caching": no `workbox.runtimeCaching` entries at all, so /api
// responses, video and *.task model files are never cached by a runtime route.

const config = viteConfig.default;
const pwaOptions = viteConfig.pwaOptions;

const webDir = join(import.meta.dir, '..');
const publicDir = join(webDir, 'public');

type Icon = { src: string; sizes: string; type?: string; purpose?: string };
type Manifest = {
  name?: string;
  short_name?: string;
  theme_color?: string;
  background_color?: string;
  display?: string;
  start_url?: string;
  icons?: Icon[];
  [key: string]: unknown;
};
type Workbox = {
  globPatterns?: string[];
  globIgnores?: string[];
  navigateFallback?: string | null;
  navigateFallbackDenylist?: RegExp[];
  runtimeCaching?: unknown[];
  [key: string]: unknown;
};

const manifest = (pwaOptions?.manifest ?? {}) as Manifest;
const workbox = (pwaOptions?.workbox ?? {}) as Workbox;

const matchesAny = (patterns: string[] | undefined, file: string) =>
  (patterns ?? []).some((p) => new Bun.Glob(p).match(file));

/** Would workbox put this dist-relative file into the precache manifest? */
const isPrecached = (file: string) =>
  matchesAny(workbox.globPatterns, file) && !matchesAny(workbox.globIgnores, file);

const blocksNavigation = (path: string) => (workbox.navigateFallbackDenylist ?? []).some((re) => re.test(path));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('vite config registers the PWA plugin', () => {
  test('vite-plugin-pwa is among the plugins', () => {
    const flat = (config.plugins ?? []).flat(Infinity) as { name?: string }[];
    expect(flat.some((p) => p?.name === 'vite-plugin-pwa')).toBe(true);
  });

  test("registerType is 'prompt' (the user, not the SW, decides when a new version activates)", () => {
    expect(pwaOptions?.registerType).toBe('prompt');
  });
});

describe('web app manifest (config)', () => {
  test('carries the required identity fields', () => {
    expect(manifest.name).toBe('FIRST COACH — БІРІНШІ БАПКЕР');
    expect(manifest.short_name).toBe('First Coach');
    expect(manifest.theme_color).toBe('#101815');
    expect(manifest.background_color).toBe('#f4f3ee');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/train');
  });

  test('is language-neutral: no lang key', () => {
    expect('lang' in manifest).toBe(false);
  });

  test('lists 192 and 512 icons for purpose any and a 512 maskable icon', () => {
    const icons = manifest.icons ?? [];
    const any = (size: string) =>
      icons.find((i) => i.sizes === size && i.type === 'image/png' && (i.purpose ?? 'any') === 'any');
    expect(any('192x192')).toBeDefined();
    expect(any('512x512')).toBeDefined();
    const maskable = icons.find((i) => i.purpose === 'maskable');
    expect(maskable?.sizes).toBe('512x512');
    expect(maskable?.type).toBe('image/png');
  });

  test('every PNG icon exists in apps/web/public at exactly its declared size', () => {
    const png = (manifest.icons ?? []).filter((i) => i.type === 'image/png');
    expect(png.length).toBeGreaterThanOrEqual(3);
    for (const icon of png) {
      const file = join(publicDir, icon.src.replace(/^\//, ''));
      expect(existsSync(file)).toBe(true);
      const { width, height } = pngSize(file);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  test('the favicon is in public and is the brand mark the icons come from', () => {
    expect(existsSync(join(publicDir, 'favicon.svg'))).toBe(true);
    expect(existsSync(join(publicDir, 'favicon.ico'))).toBe(true);
  });
});

describe('workbox precache (config)', () => {
  test('precaches the app shell: html, js, css, and the self-hosted woff2 fonts', () => {
    expect(isPrecached('index.html')).toBe(true);
    expect(isPrecached('assets/index-CDfUGuN2.js')).toBe(true);
    expect(isPrecached('assets/index-B9ezx8qW.css')).toBe(true);
    expect(isPrecached('assets/inter-cyrillic-wght-normal-DqGufNeO.woff2')).toBe(true);
    expect(isPrecached('assets/inter-cyrillic-ext-wght-normal-BOeWTOD4.woff2')).toBe(true);
  });

  test('precaches the manifest icons and the favicon', () => {
    expect(isPrecached('favicon.svg')).toBe(true);
    expect(isPrecached('pwa-192x192.png')).toBe(true);
  });

  test.each(['clip.mp4', 'assets/clip.webm', 'assets/pose_landmarker.task', 'models/face.task'])(
    'never precaches %s',
    (file) => {
      expect(isPrecached(file)).toBe(false);
    },
  );

  test("navigations fall back to index.html, except /api, /health and media which are never answered with the shell", () => {
    expect(workbox.navigateFallback).toBe('index.html');
    for (const path of ['/api/player/today', '/api', '/health', '/media/clip.mp4', '/uploads/a.jpg']) {
      expect(blocksNavigation(path)).toBe(true);
    }
    for (const path of ['/train', '/train/summary', '/progress', '/']) {
      expect(blocksNavigation(path)).toBe(false);
    }
  });

  test('has NO runtime caching at all (so no /api, video or *.task route can be cached)', () => {
    expect(workbox.runtimeCaching ?? []).toEqual([]);
    expect(pwaOptions?.strategies ?? 'generateSW').toBe('generateSW');
  });
});

describe('build output', () => {
  let outDir = '';
  let exitCode = -1;
  let stderr = '';

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'pwa-config-'));
    const proc = Bun.spawn(['bun', 'run', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    stderr = await new Response(proc.stderr).text();
    exitCode = await proc.exited;
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const read = (file: string) => readFileSync(join(outDir, file), 'utf8');

  test('vite build exits 0', () => {
    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
  });

  test('dist has manifest.webmanifest with the required fields and no lang', () => {
    const built = JSON.parse(read('manifest.webmanifest')) as Manifest;
    expect(built.name).toBe('FIRST COACH — БІРІНШІ БАПКЕР');
    expect(built.short_name).toBe('First Coach');
    expect(built.theme_color).toBe('#101815');
    expect(built.background_color).toBe('#f4f3ee');
    expect(built.display).toBe('standalone');
    expect(built.start_url).toBe('/train');
    expect('lang' in built).toBe(false);
    expect(built.icons?.some((i) => i.sizes === '192x192')).toBe(true);
    expect(built.icons?.some((i) => i.sizes === '512x512')).toBe(true);
    expect(built.icons?.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of built.icons ?? []) expect(existsSync(join(outDir, icon.src.replace(/^\//, '')))).toBe(true);
  });

  test('dist index.html links the manifest', () => {
    expect(read('index.html')).toMatch(/<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/);
  });

  test('dist has sw.js whose precache lists the shell and both Cyrillic Inter fonts', () => {
    expect(existsSync(join(outDir, 'sw.js'))).toBe(true);
    const sw = read('sw.js');
    expect(sw).toContain('index.html');
    expect(sw).toMatch(/inter-cyrillic-wght-normal-[\w-]+\.woff2/);
    expect(sw).toMatch(/inter-cyrillic-ext-wght-normal-[\w-]+\.woff2/);
    expect(sw).toMatch(/assets\/index-[\w-]+\.js/);
  });

  test('the precache manifest lists no .mp4, .webm or .task entries', () => {
    const sw = read('sw.js');
    expect(sw).not.toMatch(/\.(mp4|webm|task)["'?#]/i);
  });

  test('sw.js registers no runtime caching route: no caching strategy, only precache + the navigation fallback', () => {
    const sw = read('sw.js');
    expect(sw).not.toMatch(/CacheFirst|NetworkFirst|StaleWhileRevalidate|CacheOnly/);
    expect(sw).toMatch(/denylist/);
  });
});
