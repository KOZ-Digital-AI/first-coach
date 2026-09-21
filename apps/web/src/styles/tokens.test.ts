import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Design-token contract for apps/web/src/styles/app.css. DESIGN.md (repo root)
// is the source of truth; the stylesheet must record exactly what it records.
// Pure text tests: no DOM, no build. Runs from apps/web and from the repo root.

const cssPath = join(import.meta.dir, 'app.css');
const designPath = join(import.meta.dir, '..', '..', '..', '..', 'DESIGN.md');

const rawCss = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
const design = readFileSync(designPath, 'utf8');
// Positive assertions run against comment-free CSS so a comment can never
// satisfy them; the absence checks scan the raw text, comments included.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Whitespace-tolerant value normaliser: `-0.065em` and `-.065em` compare equal. */
function norm(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(^|[^\d])0\.(\d)/g, '$1.$2')
    .trim()
    .toLowerCase();
}

function unquote(value: string): string {
  const v = value.trim();
  return /^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v;
}

/** `--name: value;` declarations of one block, keyed by name, values normalised. */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = norm(m[2]);
  return out;
}

/** Body of the first `<header> { ... }` block (no nested braces expected). */
function blockBody(source: string, header: RegExp): string {
  const m = source.match(new RegExp(`${header.source}\\s*\\{([^}]*)\\}`));
  return m ? m[m.length - 1] : '';
}

/** A plain declaration (`prop: value;`) inside one block. */
function property(block: string, prop: string): string | undefined {
  const m = block.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`));
  return m ? norm(m[1]) : undefined;
}

// --- DESIGN.md frontmatter ---------------------------------------------------

const frontmatter = design.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';

/** Map of a top-level frontmatter section, e.g. `colors:` -> { bg: '#f4f3ee', ... }. */
function frontmatterMap(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = line.trim() === `${section}:`;
      continue;
    }
    const m = inside ? line.match(/^ {2}([\w-]+):\s*(.+?)\s*$/) : null;
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

const designColors = frontmatterMap('colors');
const designRounded = frontmatterMap('rounded');

/** Fields of one nested frontmatter entry, e.g. typography.display. */
function nestedEntry(section: string, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  let inEntry = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inSection = line.trim() === `${section}:`;
      inEntry = false;
      continue;
    }
    if (!inSection) continue;
    const entry = line.match(/^ {2}([\w-]+):\s*$/);
    if (entry) {
      inEntry = entry[1] === name;
      continue;
    }
    const field = inEntry ? line.match(/^ {4}([\w-]+):\s*(.+?)\s*$/) : null;
    if (field) out[field[1]] = unquote(field[2]);
  }
  return out;
}

const designDisplay = nestedEntry('typography', 'display');
const designButton = nestedEntry('components', 'button-primary');

// --- app.css blocks ----------------------------------------------------------

const root = declarations(blockBody(css, /:root/));
const themeInline = declarations(blockBody(css, /@theme\s+inline/));
const themeStatic = declarations(blockBody(css, /@theme\s+static/));

const NINE = {
  bg: '#f4f3ee',
  paper: '#fffefa',
  ink: '#101815',
  muted: '#68716c',
  line: '#d8ddd8',
  accent: '#2e7d53',
  'accent-2': '#dff1e6',
  warning: '#a16a18',
  danger: '#b8473d',
} as const;

const DESIGN_STACK_TAIL =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

describe('app.css exists and DESIGN.md is readable', () => {
  test('app.css is present next to this test', () => {
    expect(existsSync(cssPath)).toBe(true);
    expect(rawCss.length).toBeGreaterThan(0);
  });

  test('DESIGN.md frontmatter records the colours, radii and display type parsed below', () => {
    expect(Object.keys(designColors).length).toBeGreaterThanOrEqual(11);
    expect(Object.keys(designRounded).sort()).toEqual(['card', 'control', 'pill']);
    expect(designDisplay.fontSize).toBeDefined();
    expect(designButton.height).toBeDefined();
  });
});

describe('colour tokens on :root', () => {
  for (const [name, hex] of Object.entries(NINE)) {
    test(`--${name} is ${hex}`, () => {
      expect(root[`--${name}`]).toBe(hex);
    });
  }

  test('--danger-tint is #f7e4e2 and --white is #ffffff, as DESIGN.md records them', () => {
    expect(root['--danger-tint']).toBe('#f7e4e2');
    expect(root['--white']).toBe('#ffffff');
  });

  test('every :root colour has the same name and value in DESIGN.md, and vice versa', () => {
    const cssColors = Object.fromEntries(
      Object.entries(root)
        .filter(([, value]) => /^#[0-9a-f]{6}$/.test(value))
        .map(([name, value]) => [name.slice(2), value]),
    );
    const designNormalised = Object.fromEntries(
      Object.entries(designColors).map(([name, value]) => [name, value.toLowerCase()]),
    );
    expect(cssColors).toEqual(designNormalised);
  });
});

describe('Tailwind theme mapping', () => {
  test('@theme inline maps each colour token to a utility colour', () => {
    for (const name of Object.keys(designColors)) {
      expect(themeInline[`--color-${name}`]).toBe(`var(--${name})`);
    }
    expect(themeInline['--color-paper']).toBe('var(--paper)');
    expect(themeInline['--color-accent-2']).toBe('var(--accent-2)');
  });

  test('@theme static keeps card, control and pill radii as recorded in DESIGN.md', () => {
    expect(themeStatic['--radius-card']).toBe('18px');
    expect(themeStatic['--radius-control']).toBe('12px');
    expect(themeStatic['--radius-pill']).toBe('999px');
    expect(themeStatic['--radius-card']).toBe(norm(designRounded.card));
    expect(themeStatic['--radius-control']).toBe(norm(designRounded.control));
    expect(themeStatic['--radius-pill']).toBe(norm(designRounded.pill));
  });

  test('@theme static records the soft large shadow exactly as DESIGN.md does', () => {
    const recorded = design.match(/Lifted Panel\*\*\s*\(`box-shadow:\s*([^`]+)`\)/)?.[1];
    expect(recorded).toBeDefined();
    expect(themeStatic['--shadow-soft']).toBe('0 18px 60px rgba(19, 34, 27, .08)');
    expect(themeStatic['--shadow-soft']).toBe(norm(recorded ?? ''));
  });

  test('@theme static records the display headline scale as DESIGN.md does', () => {
    expect(themeStatic['--text-display']).toBe('clamp(48px, 7vw, 96px)');
    expect(themeStatic['--text-display']).toBe(norm(designDisplay.fontSize));
    expect(themeStatic['--text-display--line-height']).toBe('.94');
    expect(design).toMatch(/Display\*\* \(700, clamp\(48px, 7vw, 96px\), line-height \.94, tracking -\.065em\)/);
    expect(themeStatic['--text-display--letter-spacing']).toBe('-.065em');
    expect(themeStatic['--text-display--letter-spacing']).toBe(norm(designDisplay.letterSpacing));
    expect(themeStatic['--text-display--font-weight']).toBe('700');
    expect(themeStatic['--text-display--font-weight']).toBe(norm(designDisplay.fontWeight));
  });

  test('@theme static records the 44px tap target DESIGN.md records for controls', () => {
    expect(themeStatic['--spacing-tap']).toBe('44px');
    expect(themeStatic['--spacing-tap']).toBe(norm(designButton.height));
  });
});

describe('fonts', () => {
  test('imports Tailwind 4 and the self-hosted Inter variable font', () => {
    expect(css).toMatch(/@import\s+["']tailwindcss["']\s*;/);
    expect(css).toMatch(/@import\s+["']@fontsource-variable\/inter["']\s*;/);
  });

  test('--font-sans puts "Inter Variable" first, then Inter, then the DESIGN.md fallback tail', () => {
    const stack = themeStatic['--font-sans'];
    expect(stack).toBeDefined();
    // norm() lower-cases, so the family names are compared in lower case.
    expect(stack.startsWith('"inter variable", ')).toBe(true);
    expect(stack).toContain(', inter, ');
    expect(stack.endsWith(norm(DESIGN_STACK_TAIL))).toBe(true);
  });

  test("--font-sans's fallback tail is the tail of the Inter stack DESIGN.md records", () => {
    const recorded = norm(designDisplay.fontFamily);
    expect(recorded.startsWith('inter, ')).toBe(true);
    expect(recorded.slice('inter, '.length)).toBe(norm(DESIGN_STACK_TAIL));
    expect(themeStatic['--font-sans'].endsWith(recorded.slice('inter, '.length))).toBe(true);
  });

  test('the fontsource package registers "Inter Variable" with both Cyrillic subsets, self-hosted', () => {
    const fontCss = Bun.resolveSync('@fontsource-variable/inter/index.css', import.meta.dir);
    const source = readFileSync(fontCss, 'utf8');
    expect(source).toContain("font-family: 'Inter Variable'");
    expect(source).toContain('inter-cyrillic-wght-normal.woff2');
    expect(source).toContain('inter-cyrillic-ext-wght-normal.woff2');
    expect(source).not.toMatch(/https?:\/\//);
    for (const subset of ['inter-cyrillic-wght-normal', 'inter-cyrillic-ext-wght-normal']) {
      expect(existsSync(join(dirname(fontCss), 'files', `${subset}.woff2`))).toBe(true);
    }
    // The family name --font-sans leads with is the one fontsource registers.
    expect(themeStatic['--font-sans'].startsWith('"inter variable", ')).toBe(true);
  });
});

describe('base layer', () => {
  test('body paints the bg colour, the ink text colour and the sans font', () => {
    const body = blockBody(css, /(?:^|[\s}])body/);
    expect(property(body, 'background')).toBe('var(--bg)');
    expect(property(body, 'color')).toBe('var(--ink)');
    expect(property(body, 'font-family')).toBe('var(--font-sans)');
  });

  test(':focus-visible draws a 3px accent outline with a 2px offset', () => {
    const focus = blockBody(css, /:focus-visible/);
    expect(property(focus, 'outline')).toBe('3px solid var(--accent)');
    expect(property(focus, 'outline-offset')).toBe('2px');
  });
});

describe('no external requests', () => {
  test('app.css never names the Google Fonts hosts', () => {
    expect(rawCss).not.toContain('fonts.googleapis.com');
    expect(rawCss).not.toContain('fonts.gstatic.com');
  });

  test('app.css has no remote @import, no absolute URL and no protocol-relative url()', () => {
    expect(rawCss.length).toBeGreaterThan(0); // an absent file must not pass by being empty
    expect(rawCss).not.toMatch(/@import\s+url\(/i);
    expect(rawCss).not.toContain('http://');
    expect(rawCss).not.toContain('https://');
    expect(rawCss).not.toMatch(/url\(\s*["']?\/\//i);
  });
});
