import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../vite.config';

const webDir = join(import.meta.dir, '..');

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  return value ? [value] : [];
}

const pluginNames: string[] = flatten(config.plugins).map((p) => (p as { name: string }).name);

const proxy = config.server?.proxy as Record<string, { target: string }> | undefined;

describe('vite config', () => {
  test('aliases @api-types to the api shared directory, which exists and holds primitives.ts', () => {
    const alias = config.resolve?.alias as Record<string, string>;
    const expected = join(webDir, '..', 'api', 'src', 'shared');
    expect(alias['@api-types']).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(join(expected, 'primitives.ts'))).toBe(true);
  });

  test.each(['/api', '/health'])('proxies %s to the local API on port 4111', (path) => {
    expect(proxy?.[path]?.target).toBe('http://localhost:4111');
  });

  test('enables the TanStack Router plugin, plugin-react and the Tailwind vite plugin', () => {
    expect(pluginNames).toContain('tanstack:router-generator');
    expect(pluginNames.some((n) => n.startsWith('vite:react'))).toBe(true);
    expect(pluginNames.some((n) => n.startsWith('@tailwindcss/vite'))).toBe(true);
  });

  test('runs the TanStack Router plugin before plugin-react', () => {
    const router = pluginNames.indexOf('tanstack:router-generator');
    const react = pluginNames.findIndex((n) => n.startsWith('vite:react'));
    expect(router).toBeGreaterThanOrEqual(0);
    expect(react).toBeGreaterThanOrEqual(0);
    expect(router).toBeLessThan(react);
  });
});

describe('index.html', () => {
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');

  test('declares a two-letter document language', () => {
    expect(html).toMatch(/<html[^>]*\slang="[a-z]{2}"/i);
  });

  test('declares a device-width viewport', () => {
    expect(html).toMatch(/<meta[^>]*name="viewport"[^>]*content="[^"]*width=device-width/i);
  });

  test('declares theme-color #101815', () => {
    expect(html).toMatch(/<meta[^>]*name="theme-color"[^>]*content="#101815"/i);
  });

  test('has the root mount element', () => {
    expect(html).toContain('id="root"');
  });
});
