import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const mainPath = join(import.meta.dir, 'main.tsx');
const source = readFileSync(mainPath, 'utf8');

const STYLESHEET_IMPORT = /^import\s+['"]\.\/styles\/app\.css['"];?$/m;

describe('app entry (main.tsx)', () => {
  test('imports the tokens stylesheet ./styles/app.css', () => {
    expect(source).toMatch(STYLESHEET_IMPORT);
  });

  test('the imported stylesheet file exists', () => {
    expect(existsSync(join(import.meta.dir, 'styles', 'app.css'))).toBe(true);
  });

  test('the stylesheet import is a bare side-effect import', () => {
    const fromForm = /^import\s+[^'"\n]+\s+from\s+['"]\.\/styles\/app\.css['"]/m;
    expect(source).not.toMatch(fromForm);
    expect(source).toMatch(STYLESHEET_IMPORT);
  });

  test('the stylesheet import appears exactly once', () => {
    expect(source.match(/styles\/app\.css/g)?.length ?? 0).toBe(1);
    expect(source.match(new RegExp(STYLESHEET_IMPORT.source, 'gm'))?.length ?? 0).toBe(1);
  });

  test('still mounts QueryClientProvider, RouterProvider and Toaster', () => {
    expect(source).toContain('<QueryClientProvider');
    expect(source).toContain('<RouterProvider');
    expect(source).toContain('<Toaster');
  });
});
