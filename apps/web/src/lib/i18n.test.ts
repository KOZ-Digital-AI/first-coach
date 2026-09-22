import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Locale as LocaleSchema } from '@api-types/primitives';
import { createElement } from 'react';
import { getI18n, I18nextProvider, useTranslation } from 'react-i18next';
import {
  buildResources,
  createI18n,
  detectLanguage,
  formatNumber,
  i18n,
  LANGUAGE_NAMES,
  LANGUAGE_STORAGE_KEY,
  LOCALES,
  type MessageModules,
  namespaceOf,
  toLocale,
} from './i18n';
import { collectSlot } from './slots';
import * as headerExtraModule from '../features/i18n/header-extra';
import HeaderExtra from '../features/i18n/header-extra';
import switchMessages from '../features/i18n/i18n.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web.
// From the repo root there is no DOM, so register happy-dom here, BEFORE Testing Library is
// imported (same order rule as test/setup.ts). Keep the `document` guard: the preload has
// already registered it when running from apps/web.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

type Locale = (typeof LOCALES)[number];

// --- global hygiene: no test may depend on what an earlier test left behind -----------------

const INITIAL_LANGUAGE = i18n.language;

function resetGlobals(): void {
  localStorage.clear();
  document.documentElement.lang = '';
}

resetGlobals();

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage(INITIAL_LANGUAGE);
  resetGlobals();
});

// --- helpers ----------------------------------------------------------------------------------

const bundle = (kk: object, ru: object, en: object): { default: object } => ({ default: { kk, ru, en } });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

// --- locale constants -------------------------------------------------------------------------

describe('locale constants', () => {
  test('LOCALES equals the runtime Locale options of @api-types/primitives', () => {
    expect([...LOCALES]).toEqual([...LocaleSchema.options]);
  });

  test('i18n.ts imports primitives type-only, so zod stays out of the entry bundle', () => {
    const source = readFileSync(join(import.meta.dir, 'i18n.ts'), 'utf8');
    expect(source).toMatch(/^import type \{[^}]*\} from '@api-types\/primitives'/m);
    expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*['"]@api-types\/primitives['"]/m);
  });

  test('each language is named in itself, never translated', () => {
    expect(LANGUAGE_NAMES).toEqual({ kk: 'Қазақша', ru: 'Русский', en: 'English' });
  });

  test('the storage key is fc:lang', () => {
    expect(LANGUAGE_STORAGE_KEY).toBe('fc:lang');
  });
});

// --- key parity -------------------------------------------------------------------------------

const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*([^}\s,]+)[^}]*\}\}/g;

/** Leaf path -> text. Only strings are leaves: a number, null or array is not translatable text. */
function collectLeaves(tree: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof tree === 'string') {
    out.set(prefix, tree);
  } else if (typeof tree === 'object' && tree !== null && !Array.isArray(tree)) {
    for (const [key, value] of Object.entries(tree)) {
      collectLeaves(value, prefix === '' ? key : `${prefix}.${key}`, out);
    }
  }
  return out;
}

const hasText = (text: string | undefined): text is string => text !== undefined && text.trim() !== '';

const placeholdersOf = (texts: string[]): string =>
  [...new Set(texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string)))]
    .sort()
    .join(', ');

/**
 * Human-readable problems; empty when every namespace has the same keys, non-blank, in kk, ru and en.
 * Plural keys (`n_one`, `n_few`, ...) are checked per language: each locale must ship EVERY plural
 * category its own Intl.PluralRules requires (ru: one/few/many/other; en and kk: one/other).
 */
function parityProblems(modules: MessageModules): string[] {
  const problems: string[] = [];
  for (const path of Object.keys(modules).sort()) {
    const ns = namespaceOf(path);
    const where = `${ns} (${path})`;
    const source = (modules[path]?.default ?? {}) as Record<string, unknown>;
    const leaves = new Map<Locale, Map<string, string>>(LOCALES.map((locale) => [locale, collectLeaves(source[locale])]));

    const plainKeys = new Set<string>();
    const pluralBases = new Set<string>();
    for (const locale of LOCALES) {
      for (const key of leaves.get(locale)!.keys()) {
        const plural = PLURAL_SUFFIX.exec(key);
        if (plural) pluralBases.add(plural[1] as string);
        else plainKeys.add(key);
      }
    }

    const placeholderShapes = (texts: (string[] | undefined)[]): string | undefined => {
      const shapes = texts.map((list) => (list === undefined ? undefined : placeholdersOf(list)));
      const present = shapes.filter((shape): shape is string => shape !== undefined);
      if (new Set(present).size <= 1) return undefined;
      return LOCALES.map((locale, index) => `${locale}: ${shapes[index] || 'none'}`).join('; ');
    };

    for (const key of [...plainKeys].sort()) {
      const texts = LOCALES.map((locale) => leaves.get(locale)!.get(key));
      const has = LOCALES.filter((_, index) => hasText(texts[index]));
      for (const locale of LOCALES) {
        if (!hasText(leaves.get(locale)!.get(key))) {
          problems.push(`${where}: ${locale} is missing "${key}" (present in ${has.join(', ') || 'no locale'})`);
        }
      }
      const mismatch = placeholderShapes(texts.map((text) => (hasText(text) ? [text] : undefined)));
      if (mismatch) problems.push(`${where}: "${key}" has different {{placeholders}} per locale (${mismatch})`);
    }

    for (const base of [...pluralBases].sort()) {
      for (const locale of LOCALES) {
        const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        for (const category of [...required].sort((a, b) => PLURAL_ORDER.indexOf(a) - PLURAL_ORDER.indexOf(b))) {
          if (!hasText(leaves.get(locale)!.get(`${base}_${category}`))) {
            problems.push(`${where}: ${locale} is missing "${base}_${category}" (plural category "${category}" is required for ${locale})`);
          }
        }
      }
      const forms = LOCALES.map((locale) => {
        const texts = PLURAL_ORDER.map((category) => leaves.get(locale)!.get(`${base}_${category}`)).filter(hasText);
        return texts.length > 0 ? texts : undefined;
      });
      const mismatch = placeholderShapes(forms);
      if (mismatch) problems.push(`${where}: "${base}" has different {{placeholders}} per locale (${mismatch})`);
    }
  }
  return problems;
}

describe('key parity checker (synthetic maps)', () => {
  test('passes when all three locales have the same keys', () => {
    const tree = { a: 'x', b: { c: 'y' } };
    expect(parityProblems({ '../a/today.messages.ts': bundle(tree, tree, tree) })).toEqual([]);
  });

  test('names every locale and key that is missing', () => {
    const modules = {
      '../a/today.messages.ts': bundle({ a: 'x' }, { a: 'x', b: { c: 'y' } }, { a: 'x', b: { c: 'y' }, d: 'z' }),
    };
    expect(parityProblems(modules)).toEqual([
      'today (../a/today.messages.ts): kk is missing "b.c" (present in ru, en)',
      'today (../a/today.messages.ts): kk is missing "d" (present in en)',
      'today (../a/today.messages.ts): ru is missing "d" (present in en)',
    ]);
  });

  test.each([...LOCALES])('a key missing in %s alone is caught', (missing) => {
    const full = { a: 'text' };
    const source = { kk: full, ru: full, en: full, [missing]: {} };
    const problems = parityProblems({ '../a/x.messages.ts': { default: source } });
    const others = LOCALES.filter((locale) => locale !== missing);
    expect(problems).toEqual([`x (../a/x.messages.ts): ${missing} is missing "a" (present in ${others.join(', ')})`]);
  });

  test('a blank translation counts as missing', () => {
    const modules = { '../a/x.messages.ts': bundle({ a: '  ' }, { a: 'r' }, { a: 'e' }) };
    expect(parityProblems(modules)).toEqual(['x (../a/x.messages.ts): kk is missing "a" (present in ru, en)']);
  });

  test('a locale block that is absent is reported', () => {
    const modules = { '../a/x.messages.ts': { default: { kk: { a: 'k' }, en: { a: 'e' } } } };
    expect(parityProblems(modules)).toEqual(['x (../a/x.messages.ts): ru is missing "a" (present in kk, en)']);
  });

  test('a value that is not a string counts as missing', () => {
    const modules = { '../a/x.messages.ts': bundle({ a: 42 }, { a: 'r' }, { a: 'e' }) };
    expect(parityProblems(modules)).toEqual(['x (../a/x.messages.ts): kk is missing "a" (present in ru, en)']);
  });

  test('a placeholder used in some locales only is reported', () => {
    const modules = { '../a/x.messages.ts': bundle({ hi: 'Сәлем, {{name}}' }, { hi: 'Привет' }, { hi: 'Hi, {{name}}' }) };
    expect(parityProblems(modules)).toEqual([
      'x (../a/x.messages.ts): "hi" has different {{placeholders}} per locale (kk: name; ru: none; en: name)',
    ]);
  });

  test('plurals: every locale ships all the categories its own plural rules need', () => {
    const ok = bundle(
      { n_one: '{{count}} гол', n_other: '{{count}} гол' },
      { n_one: '{{count}} гол', n_few: '{{count}} гола', n_many: '{{count}} голов', n_other: '{{count}} гола' },
      { n_one: '{{count}} goal', n_other: '{{count}} goals' },
    );
    expect(parityProblems({ '../a/x.messages.ts': ok })).toEqual([]);
  });

  test('plurals: Russian shipping only _one and _other is reported, category by category', () => {
    const bad = bundle(
      { n_one: '{{count}} гол', n_other: '{{count}} гол' },
      { n_one: '{{count}} гол', n_other: '{{count}} голов' },
      { n_one: '{{count}} goal', n_other: '{{count}} goals' },
    );
    expect(parityProblems({ '../a/x.messages.ts': bad })).toEqual([
      'x (../a/x.messages.ts): ru is missing "n_few" (plural category "few" is required for ru)',
      'x (../a/x.messages.ts): ru is missing "n_many" (plural category "many" is required for ru)',
    ]);
  });

  test('plurals: English shipping only _other is reported', () => {
    const bad = bundle(
      { n_one: 'a', n_other: 'b' },
      { n_one: 'a', n_few: 'c', n_many: 'd', n_other: 'b' },
      { n_other: 'b' },
    );
    expect(parityProblems({ '../a/x.messages.ts': bad })).toEqual([
      'x (../a/x.messages.ts): en is missing "n_one" (plural category "one" is required for en)',
    ]);
  });

  test('plurals: a placeholder used by the plural forms of some locales only is reported', () => {
    const bad = bundle(
      { n_one: 'a', n_other: '{{count}} b' },
      { n_one: 'a', n_few: 'c', n_many: 'd', n_other: '{{count}} b' },
      { n_one: 'a', n_other: 'b' },
    );
    expect(parityProblems({ '../a/x.messages.ts': bad })).toEqual([
      'x (../a/x.messages.ts): "n" has different {{placeholders}} per locale (kk: count; ru: count; en: none)',
    ]);
  });
});

// Real files are read from disk (Bun.Glob), NOT via import.meta.glob (undefined under bun), so
// every messages file added by any later bead is checked without editing this test.
const srcDir = join(import.meta.dir, '..');
const realFiles = [...new Bun.Glob('**/*.messages.ts').scanSync({ cwd: srcDir })].sort();
const realModules: MessageModules = {};
for (const file of realFiles) realModules[`../${file}`] = await import(join(srcDir, file));

describe('every real *.messages.ts file under src/', () => {
  test('the scan finds the switch messages file (so the parity check is not vacuous)', () => {
    expect(realFiles).toContain('features/i18n/i18n.messages.ts');
  });

  test('every file has at least one text in each of kk, ru and en', () => {
    const counts = Object.entries(realModules).flatMap(([path, module]) =>
      LOCALES.map((locale) => ({
        path,
        locale,
        hasLeaves: collectLeaves((module.default as Record<string, unknown>)[locale]).size > 0,
      })),
    );
    expect(counts.length).toBeGreaterThanOrEqual(LOCALES.length);
    expect(counts.filter((entry) => !entry.hasLeaves)).toEqual([]);
  });

  test('lib/i18n.ts collects them with an eager glob over the same pattern', () => {
    const source = readFileSync(join(import.meta.dir, 'i18n.ts'), 'utf8');
    expect(source).toContain("import.meta.glob<Record<string, unknown>>('../**/*.messages.ts', { eager: true })");
  });

  test('have the same keys, non-blank, in kk, ru and en', () => {
    expect(parityProblems(realModules)).toEqual([]);
  });

  test('build into resources with unique namespaces', () => {
    expect(buildResources(realModules)).toMatchObject({
      kk: { i18n: { language: 'Тіл' } },
      ru: { i18n: { language: 'Язык' } },
      en: { i18n: { language: 'Language' } },
    });
  });
});

// --- resources and namespaces -----------------------------------------------------------------

describe('namespaceOf', () => {
  test('is the file base name before .messages.ts', () => {
    expect(namespaceOf('../features/today/today.messages.ts')).toBe('today');
    expect(namespaceOf('/abs/drill-detail.messages.ts')).toBe('drill-detail');
    expect(namespaceOf('plain_ns2.messages.ts')).toBe('plain_ns2');
  });

  test.each(['../a/drill.detail.messages.ts', '../a/1st.messages.ts', '../a/.messages.ts', '../a/a b.messages.ts'])(
    'rejects an invalid namespace: %s',
    (path) => {
      expect(() => namespaceOf(path)).toThrow(/valid namespace/);
    },
  );
});

describe('buildResources', () => {
  test('maps each file to its namespace under every locale', () => {
    const modules = {
      '../features/today/today.messages.ts': bundle({ a: 'k' }, { a: 'r' }, { a: 'e' }),
      '../features/drill/drill.messages.ts': bundle({ b: 'k2' }, { b: 'r2' }, { b: 'e2' }),
    };
    expect(buildResources(modules)).toEqual({
      kk: { today: { a: 'k' }, drill: { b: 'k2' } },
      ru: { today: { a: 'r' }, drill: { b: 'r2' } },
      en: { today: { a: 'e' }, drill: { b: 'e2' } },
    });
  });

  test('an empty module map gives empty resources for all three locales', () => {
    expect(buildResources({})).toEqual({ kk: {}, ru: {}, en: {} });
  });

  test('a duplicate namespace throws and names both files', () => {
    const modules = { '../a/x.messages.ts': bundle({}, {}, {}), '../b/x.messages.ts': bundle({}, {}, {}) };
    expect(() => buildResources(modules)).toThrow(/namespace "x".*"\.\.\/a\/x\.messages\.ts".*"\.\.\/b\/x\.messages\.ts"/);
  });

  test('an invalid namespace throws', () => {
    expect(() => buildResources({ '../a/drill.detail.messages.ts': bundle({}, {}, {}) })).toThrow(/valid namespace/);
  });

  test('a file without a default export throws', () => {
    expect(() => buildResources({ '../a/x.messages.ts': {} })).toThrow(/default-export/);
  });

  test('a missing locale block becomes empty, so it falls back instead of crashing', () => {
    const modules = { '../a/x.messages.ts': { default: { kk: { a: 'k' }, en: { a: 'e' } } } };
    expect(buildResources(modules)).toEqual({ kk: { x: { a: 'k' } }, ru: { x: {} }, en: { x: { a: 'e' } } });
  });
});

// --- fallback chain and missing keys ----------------------------------------------------------

const chain: MessageModules = {
  '../t/today.messages.ts': bundle(
    { all: 'kk all', blank: '', ruKk: 'kk ruKk', onlyKk: 'kk only', nested: { x: 'kk x' } },
    { all: 'ru all', blank: 'ru blank', ruEn: 'ru ruEn', ruKk: 'ru ruKk', nested: { x: 'ru x', y: 'ru y' } },
    { all: 'en all', blank: 'en blank', ruEn: 'en ruEn', onlyEn: 'en only', nested: { x: 'en x', y: 'en y' } },
  ),
};

function mk(language: string, extra: Parameters<typeof createI18n>[0] = {}) {
  return createI18n({ modules: chain, languages: [language], storage: memoryStorage(), root: { lang: '' }, ...extra });
}

describe('fallback chain', () => {
  test('kk uses kk, then ru, then en', () => {
    const t = mk('kk').getFixedT(null, 'today');
    expect(t('all')).toBe('kk all');
    expect(t('nested.y')).toBe('ru y');
    expect(t('ruEn')).toBe('ru ruEn');
    expect(t('onlyEn')).toBe('en only');
  });

  test('ru uses ru, then en', () => {
    const t = mk('ru').getFixedT(null, 'today');
    expect(t('all')).toBe('ru all');
    expect(t('onlyEn')).toBe('en only');
    expect(t('nested.x')).toBe('ru x');
  });

  test('ru does not borrow from kk: its chain is ru then en', () => {
    expect(mk('ru').getFixedT(null, 'today')('onlyKk')).toBe('');
  });

  test('en uses en, then ru, then kk', () => {
    const t = mk('en').getFixedT(null, 'today');
    expect(t('all')).toBe('en all');
    expect(t('ruKk')).toBe('ru ruKk');
    expect(t('onlyKk')).toBe('kk only');
  });

  test('a blank string falls back instead of rendering empty', () => {
    expect(mk('kk').getFixedT(null, 'today')('blank')).toBe('ru blank');
  });

  test('a regional tag resolves to its language and an unsupported one to kk', async () => {
    const inst = mk('kk');
    await inst.changeLanguage('en-US');
    expect(inst.language).toBe('en');
    await inst.changeLanguage('de');
    expect(inst.language).toBe('kk');
    expect(inst.getFixedT(null, 'today')('onlyEn')).toBe('en only');
  });
});

function Probe({ name }: { name: string }) {
  const { t } = useTranslation('today');
  return createElement('p', { 'data-testid': 'probe' }, t(name));
}

describe('a key missing everywhere', () => {
  test.each(['nope', 'nested.nope', 'nested'])('t(%s) is an empty string, never the raw key or "undefined"', (key) => {
    const text = mk('kk').getFixedT(null, 'today')(key);
    expect(text).toBe('');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('nope');
    expect(text).not.toContain('returned an object');
  });

  test('renders nothing visible in the page', () => {
    const inst = mk('kk');
    for (const name of ['nope', 'nested']) {
      const { container } = render(createElement(I18nextProvider, { i18n: inst }, createElement(Probe, { name })));
      expect(container.textContent).toBe('');
      cleanup();
    }
  });

  test('renders the fallback-language text when only another locale has the key', () => {
    const { container } = render(
      createElement(I18nextProvider, { i18n: mk('kk') }, createElement(Probe, { name: 'onlyEn' })),
    );
    expect(container.textContent).toBe('en only');
  });

  test('in dev mode it warns once per key, naming the namespace and the key', () => {
    const t = mk('kk', { dev: true }).getFixedT(null, 'today');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(t('nope')).toBe('');
      expect(t('nope')).toBe('');
      expect(t('nested.nope')).toBe('');
      expect(warn).toHaveBeenCalledTimes(2);
      const [first, second] = warn.mock.calls.map((call) => String(call[0]));
      expect(first).toContain('today');
      expect(first).toContain('nope');
      expect(second).toContain('nested.nope');
    } finally {
      warn.mockRestore();
    }
  });

  test('in dev mode a key that names a branch instead of text is warned about too', () => {
    const t = mk('kk', { dev: true }).getFixedT(null, 'today');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(t('nested')).toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('nested');
    } finally {
      warn.mockRestore();
    }
  });

  test('outside dev mode it never warns', () => {
    const t = mk('kk', { dev: false }).getFixedT(null, 'today');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(t('nope')).toBe('');
      expect(t('nested')).toBe('');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// --- detection, persistence, <html lang> ------------------------------------------------------

describe('toLocale', () => {
  test('accepts a supported language, ignoring case and region', () => {
    expect(toLocale('kk')).toBe('kk');
    expect(toLocale('ru-RU')).toBe('ru');
    expect(toLocale('EN_us')).toBe('en');
  });

  test('rejects anything else', () => {
    expect(toLocale('de')).toBeUndefined();
    expect(toLocale('')).toBeUndefined();
    expect(toLocale(null)).toBeUndefined();
    expect(toLocale(undefined)).toBeUndefined();
  });
});

describe('detectLanguage', () => {
  test('the stored choice wins over the browser', () => {
    expect(detectLanguage({ stored: 'ru', languages: ['en-US'] })).toBe('ru');
  });

  test('the first supported browser language wins and regional tags collapse', () => {
    expect(detectLanguage({ languages: ['tr-TR', 'kk-KZ', 'en'] })).toBe('kk');
    expect(detectLanguage({ languages: ['de', 'ru-RU', 'en'] })).toBe('ru');
    expect(detectLanguage({ stored: null, languages: ['en-GB'] })).toBe('en');
  });

  test('an invalid stored value is ignored', () => {
    expect(detectLanguage({ stored: 'xx', languages: ['en'] })).toBe('en');
  });

  test('nothing usable gives kk', () => {
    expect(detectLanguage({})).toBe('kk');
    expect(detectLanguage({ stored: null, languages: ['de', 'fr'] })).toBe('kk');
  });
});

describe('language persistence', () => {
  test('a later change is written under fc:lang, detection alone is not', async () => {
    const storage = memoryStorage();
    const inst = createI18n({ modules: chain, languages: ['en'], storage, root: { lang: '' } });
    expect(inst.language).toBe('en');
    expect(storage.getItem('fc:lang')).toBeNull();
    await inst.changeLanguage('ru');
    expect(storage.getItem('fc:lang')).toBe('ru');
  });

  test('the stored choice is read on the next detection and beats the browser language', async () => {
    const storage = memoryStorage();
    const first = createI18n({ modules: chain, languages: ['en'], storage, root: { lang: '' } });
    await first.changeLanguage('ru');
    const next = createI18n({ modules: chain, languages: ['en'], storage, root: { lang: '' } });
    expect(next.language).toBe('ru');
  });

  test('an invalid stored value is ignored', () => {
    const storage = memoryStorage();
    storage.setItem('fc:lang', 'klingon');
    expect(createI18n({ modules: chain, languages: ['ru'], storage, root: { lang: '' } }).language).toBe('ru');
  });

  test('works against the real localStorage', async () => {
    expect(localStorage.getItem('fc:lang')).toBeNull();
    const inst = createI18n({ modules: chain, languages: ['en'], root: { lang: '' } });
    expect(localStorage.getItem('fc:lang')).toBeNull();
    await inst.changeLanguage('kk');
    expect(localStorage.getItem('fc:lang')).toBe('kk');
    expect(createI18n({ modules: chain, languages: ['en'], root: { lang: '' } }).language).toBe('kk');
  });

  test('a storage that throws does not break detection or switching', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    const inst = createI18n({
      modules: chain,
      languages: ['ru'],
      storage: { getItem: denied, setItem: denied },
      root: { lang: '' },
    });
    expect(inst.language).toBe('ru');
    await inst.changeLanguage('en');
    expect(inst.language).toBe('en');
  });
});

describe('<html lang>', () => {
  test('is set on init and follows every change', async () => {
    const root = { lang: '' };
    const inst = createI18n({ modules: chain, languages: ['ru'], storage: memoryStorage(), root });
    expect(root.lang).toBe('ru');
    await inst.changeLanguage('en');
    expect(root.lang).toBe('en');
    await inst.changeLanguage('kk');
    expect(root.lang).toBe('kk');
  });

  test('defaults to document.documentElement', async () => {
    expect(document.documentElement.lang).toBe('');
    const inst = createI18n({ modules: chain, languages: ['ru'], storage: memoryStorage() });
    expect(document.documentElement.lang).toBe('ru');
    await inst.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

// --- number formatting ------------------------------------------------------------------------

describe('formatNumber', () => {
  // Intl separates thousands with U+00A0 or U+202F depending on the ICU build: compare on a plain space.
  const plain = (text: string) => text.replace(/[  ]/g, ' ');

  test('groups and separates decimals per locale', () => {
    expect(plain(formatNumber(1234567.5, 'kk'))).toBe('1 234 567,5');
    expect(plain(formatNumber(1234567.5, 'ru'))).toBe('1 234 567,5');
    expect(formatNumber(1234567.5, 'en')).toBe('1,234,567.5');
  });

  test('defaults to the current language of the app instance', async () => {
    await i18n.changeLanguage('en');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    await i18n.changeLanguage('ru');
    expect(plain(formatNumber(1234.5))).toBe('1 234,5');
    await i18n.changeLanguage('kk');
    expect(plain(formatNumber(1234.5))).toBe('1 234,5');
  });
});

// --- the module singleton ---------------------------------------------------------------------

describe('the module singleton', () => {
  test('is initialised and is the instance react-i18next uses without a provider', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(getI18n()).toBe(i18n);
  });

  test('createI18n touches no global state: it is a separate instance', () => {
    const inst = mk('en');
    expect(inst).not.toBe(i18n);
    expect(getI18n()).toBe(i18n);
  });
});

// --- the language switch ----------------------------------------------------------------------

const switchModules: MessageModules = { '../features/i18n/i18n.messages.ts': { default: switchMessages } };

function renderSwitch(language: string) {
  const inst = createI18n({ modules: switchModules, languages: [language] });
  render(createElement(I18nextProvider, { i18n: inst }, createElement(HeaderExtra)));
  return inst;
}

const button = (name: string) => screen.getByRole('button', { name });

describe('language switch (features/i18n/header-extra.tsx)', () => {
  test('starts from a clean slate: nothing stored, singleton back on its initial language', () => {
    expect(localStorage.getItem('fc:lang')).toBeNull();
    expect(document.documentElement.lang).toBe('');
    expect(i18n.language).toBe(INITIAL_LANGUAGE);
  });

  // fc-zfg.9: the visible label is now the compact 3-letter short form (Қаз / Рус / Eng, i18n.messages.ts's `short`),
  // not the full native name - the header row must never wrap at >=1220px, and the full names are too wide for that.
  // The full native name is still there, just moved to the accessible name/title (next test).
  test('renders three buttons with the short labels Қаз, Рус and Eng, each in its own lang', () => {
    renderSwitch('en');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((el) => el.textContent)).toEqual(['Қаз', 'Рус', 'Eng']);
    expect(buttons.map((el) => el.getAttribute('lang'))).toEqual(['kk', 'ru', 'en']);
    expect(buttons.map((el) => el.getAttribute('type'))).toEqual(['button', 'button', 'button']);
    expect(buttons.map((el) => el.textContent)).toEqual(LOCALES.map((locale) => switchMessages.en.short[locale]));
  });

  test('each button keeps the full native name as its accessible name and its title, not the short label', () => {
    renderSwitch('en');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((el) => el.getAttribute('aria-label'))).toEqual(LOCALES.map((locale) => LANGUAGE_NAMES[locale]));
    expect(buttons.map((el) => el.getAttribute('title'))).toEqual(LOCALES.map((locale) => LANGUAGE_NAMES[locale]));
    // getByRole's `name` option resolves the ARIA accessible name (aria-label wins over text content), so a lookup by
    // the FULL native name still finds the button even though its visible text is now the short label.
    for (const locale of LOCALES) expect(button(LANGUAGE_NAMES[locale])).toBeTruthy();
  });

  test.each([...LOCALES])('with %s current, aria-pressed is true on that button only', (current) => {
    renderSwitch(current);
    const pressed = screen.getAllByRole('button').map((el) => el.getAttribute('aria-pressed'));
    expect(pressed).toEqual(LOCALES.map((locale) => (locale === current ? 'true' : 'false')));
  });

  test.each([...LOCALES])('with %s current, only that button carries the check icon (state is not colour alone)', (current) => {
    renderSwitch(current);
    for (const locale of LOCALES) {
      const icons = button(LANGUAGE_NAMES[locale]).querySelectorAll('svg');
      if (locale === current) {
        expect(icons).toHaveLength(1);
        expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
        expect(icons[0]?.getAttribute('class')).toContain('lucide-check');
      } else {
        expect(icons).toHaveLength(0);
      }
    }
  });

  test('the group is labelled "Language" in English', () => {
    renderSwitch('en');
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy();
  });

  test.each([
    ['kk', 'Тіл'],
    ['ru', 'Язык'],
    ['en', 'Language'],
  ] as const)('the group has a non-empty name in %s: %s', (language, name) => {
    renderSwitch(language);
    const group = screen.getByRole('group', { name });
    expect(group.getAttribute('aria-label')).toBe(name);
    expect((group.getAttribute('aria-label') ?? '').trim()).not.toBe('');
  });

  test('every button is a 44px tap target', () => {
    renderSwitch('kk');
    for (const el of screen.getAllByRole('button')) {
      expect(el.className).toContain('min-h-tap');
      expect(el.className).toContain('min-w-tap');
    }
  });

  test('the current button uses the accent border and accent-2 fill, the others the line border', () => {
    renderSwitch('ru');
    const current = button('Русский').className;
    expect(current).toContain('border-accent');
    expect(current).toContain('bg-accent-2');
    expect(current).toContain('rounded-control');
    for (const name of ['Қазақша', 'English']) {
      const other = button(name).className;
      expect(other).toContain('border-line');
      expect(other).not.toContain('bg-accent-2');
      expect(other).toContain('rounded-control');
    }
  });

  test('the group carries its own horizontal padding (the header slot is unpadded)', () => {
    renderSwitch('kk');
    expect(screen.getByRole('group').className).toMatch(/(^|\s)px-\d/);
  });

  test('clicking Русский switches language, <html lang> and storage, and moves aria-pressed', async () => {
    const user = userEvent.setup();
    const inst = renderSwitch('en');
    await user.click(button('Русский'));
    expect(inst.language).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(localStorage.getItem('fc:lang')).toBe('ru');
    expect(button('Русский').getAttribute('aria-pressed')).toBe('true');
    expect(button('English').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Язык' })).toBeTruthy();
  });

  test('the chosen language survives a reload', async () => {
    const user = userEvent.setup();
    renderSwitch('en');
    await user.click(button('Қазақша'));
    cleanup();
    renderSwitch('en');
    expect(button('Қазақша').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: 'Тіл' })).toBeTruthy();
  });

  test('Tab reaches the buttons in order, Enter and Space activate the focused one', async () => {
    const user = userEvent.setup();
    const inst = renderSwitch('en');
    await user.tab();
    expect(document.activeElement).toBe(button('Қазақша'));
    await user.tab();
    expect(document.activeElement).toBe(button('Русский'));
    await user.tab();
    expect(document.activeElement).toBe(button('English'));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('Русский'));
    await user.keyboard('{Enter}');
    expect(inst.language).toBe('ru');

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('Қазақша'));
    await user.keyboard(' ');
    expect(inst.language).toBe('kk');
    expect(button('Қазақша').getAttribute('aria-pressed')).toBe('true');
  });
});

// --- header slot contract ---------------------------------------------------------------------

describe('header slot contract (lib/slots.ts)', () => {
  test('the real module default-exports one component', () => {
    expect(typeof headerExtraModule.default).toBe('function');
  });

  test('collectSlot picks the module default up for the header slot', () => {
    const components = collectSlot(
      { header: { '../features/i18n/header-extra.tsx': headerExtraModule } },
      'header',
    );
    expect(components).toHaveLength(1);
    expect(components[0]).toBe(HeaderExtra);
  });

  test('the collected component renders the three language buttons', () => {
    const [Extra] = collectSlot({ header: { '/x/header-extra.tsx': { default: HeaderExtra } } }, 'header');
    expect(Extra).toBeDefined();
    const inst = createI18n({ modules: switchModules, languages: ['ru'] });
    render(createElement(I18nextProvider, { i18n: inst }, createElement(Extra!)));
    // fc-zfg.9: short visible labels, see the "language switch" describe block above for the full contract.
    expect(screen.getAllByRole('button').map((el) => el.textContent)).toEqual(['Қаз', 'Рус', 'Eng']);
  });
});
