import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import { Route } from '../../routes/legal/terms';
import trustBadgeMessages from '../commons/trust-badge.messages';
import messages from './terms.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as lib/i18n.test.ts).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

// Kazakh copy is flagged for a native-speaker review (bead fc-cjh). These tests pin the structure and the facts the
// acceptance criteria name, not the exact wording, so a reviewer can polish the Kazakh without touching them.

// --- the criteria, written out ------------------------------------------------------------------
// The section keys are spelled out here on purpose: a test that read them from the page would pass for any page.
const SECTION_IDS = [
  'free',
  'licences',
  'reuse',
  'contributing',
  'communityDraft',
  'ownRisk',
  'children',
  'takedown',
] as const;
type SectionId = (typeof SECTION_IDS)[number];

const REQUIRED_POINTS: Record<string, readonly string[]> = {
  licences: ['software', 'knowledge'],
  reuse: ['attribution', 'shareAlike'],
  contributing: ['authorship', 'licence', 'rights', 'noCommercial'],
};

// Lower-case substrings that each section must contain in each language (stems, so a declension does not matter).
const STEMS: Record<Locale, Partial<Record<SectionId, string[]>>> = {
  en: {
    free: ['free'],
    reuse: ['attribution', 'share-alike'],
    contributing: ['authorship', 'rights'],
    communityDraft: ['community draft', 'academy'],
    ownRisk: ['own risk', 'warm up', 'road'],
    children: ['guardian'],
    takedown: ['takedown'],
  },
  ru: {
    free: ['бесплатн'],
    reuse: ['attribution', 'share-alike'],
    contributing: ['авторств', 'прав'],
    communityDraft: ['community draft', 'черновик сообщества', 'академи'],
    ownRisk: ['на свой риск', 'разомн', 'дорог'],
    children: ['родител'],
    takedown: ['удален'],
  },
  kk: {
    free: ['тегін'],
    reuse: ['attribution', 'share-alike'],
    contributing: ['авторлық', 'құқық'],
    communityDraft: ['community draft', 'қауымдастық жобасы', 'академия'],
    ownRisk: ['жауапкершілі', 'жылын', 'жол'],
    children: ['ата-ана'],
    takedown: ['алып тастау'],
  },
};

const DRAFT_LABEL: Record<Locale, string> = {
  en: 'Community Draft',
  ru: 'Черновик сообщества',
  kk: 'Қауымдастық жобасы',
};

const CC_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const EXPORT_PATH = '/api/commons/export.json';
const KAZAKH_LETTERS = /[әғқңөұүһі]/i;
const KAZAKH_ONLY_LETTERS = /[әғқңөұүһ]/i; // Cyrillic letters Russian does not use
const CYRILLIC = /\p{Script=Cyrillic}/u;

// The attribution line is the one in CONTENT-LICENSE.md, verbatim (re-users copy it).
const CONTENT_LICENSE = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'CONTENT-LICENSE.md'), 'utf8');
const ATTRIBUTION_LINE = /^Source: Open Sport Commons by FIRST COACH \(KOZ AI\) and contributors.*$/m.exec(CONTENT_LICENSE)?.[0];

// --- helpers ------------------------------------------------------------------------------------

const modules = {
  './terms.messages.ts': { default: messages },
  './trust-badge.messages.ts': { default: trustBadgeMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

const TermsPage = Route.options.component as () => ReactNode;

/** An isolated i18n instance per render: no global state, no <html lang> writes, no storage. */
function renderTerms(locale: Locale) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const view = render(
    <I18nextProvider i18n={instance}>
      <TermsPage />
    </I18nextProvider>,
  );
  const section = (id: SectionId): HTMLElement => {
    const found = view.container.querySelector<HTMLElement>(`section#${id}`);
    if (found === null) throw new Error(`no <section id="${id}"> rendered`);
    return found;
  };
  return { ...view, instance, section, text: (view.container.textContent ?? '').replace(/\s+/g, ' ') };
}

const tokens = (element: Element): string[] => Array.from(element.classList);
const lower = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();

type Tree = { [key: string]: string | Tree };
function leaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`),
  );
}
function at(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
}

let previousContact: string | undefined;
beforeEach(() => {
  previousContact = process.env.VITE_CONTACT_EMAIL;
  delete process.env.VITE_CONTACT_EMAIL;
});
afterEach(() => {
  cleanup();
  if (previousContact === undefined) delete process.env.VITE_CONTACT_EMAIL;
  else process.env.VITE_CONTACT_EMAIL = previousContact;
});

// --- messages: every section key in all three locales -------------------------------------------

describe('terms messages', () => {
  test.each([...LOCALES])('%s has a title and a lead for every section key', (locale) => {
    for (const id of SECTION_IDS) {
      for (const field of ['title', 'lead']) {
        const value = at(messages[locale] as Tree, `sections.${id}.${field}`);
        expect(typeof value, `${locale} sections.${id}.${field}`).toBe('string');
        expect((value as string).trim().length, `${locale} sections.${id}.${field} is empty`).toBeGreaterThan(0);
      }
    }
  });

  test.each([...LOCALES])('%s has the named points of the licence, reuse and contribution sections', (locale) => {
    for (const [id, points] of Object.entries(REQUIRED_POINTS)) {
      for (const point of points) {
        const value = at(messages[locale] as Tree, `sections.${id}.points.${point}`);
        expect(typeof value, `${locale} sections.${id}.points.${point}`).toBe('string');
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('kk, ru and en carry exactly the same keys', () => {
    const shape = (locale: Locale) => leaves(messages[locale] as Tree).map(([key]) => key).sort();
    expect(shape('kk')).toEqual(shape('en'));
    expect(shape('ru')).toEqual(shape('en'));
  });

  test('no message is blank or a leftover placeholder', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(messages[locale] as Tree)) {
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(value, `${locale} ${key}`).not.toMatch(/todo|tbd|lorem|undefined/i);
      }
    }
  });

  test('every Kazakh message is written in Kazakh, every Russian one in Russian and every English one in Latin', () => {
    for (const [key, value] of leaves(messages.kk as Tree)) {
      if (/^[\s\dA-Za-z.,:;()«»"'\-—/]*$/.test(value)) continue; // pure Latin/number strings such as licence names
      expect(value, `kk ${key} has no Kazakh-specific letter (a copy of the Russian?)`).toMatch(KAZAKH_LETTERS);
    }
    for (const [key, value] of leaves(messages.ru as Tree)) {
      expect(value, `ru ${key} contains a Kazakh-only letter`).not.toMatch(KAZAKH_ONLY_LETTERS);
    }
    for (const [key, value] of leaves(messages.en as Tree)) {
      expect(value, `en ${key} contains Cyrillic`).not.toMatch(CYRILLIC);
    }
  });

  test('the Kazakh and Russian section titles differ from the English ones', () => {
    for (const id of SECTION_IDS) {
      const title = (locale: Locale) => at(messages[locale] as Tree, `sections.${id}.title`);
      expect(title('kk')).not.toBe(title('en'));
      expect(title('ru')).not.toBe(title('en'));
      expect(title('kk')).not.toBe(title('ru'));
    }
  });
});

// --- the rendered page ----------------------------------------------------------------------------

describe.each([...LOCALES])('terms page in %s', (locale) => {
  test('one h1 and one h2 per section, in the locale', () => {
    const { container, section } = renderTerms(locale);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')?.textContent?.trim()).toBe((messages[locale] as Tree).title as string);
    expect(container.querySelectorAll('h2')).toHaveLength(SECTION_IDS.length);
    for (const id of SECTION_IDS) {
      const heading = section(id).querySelector('h2');
      expect(heading?.textContent?.trim()).toBe(at(messages[locale] as Tree, `sections.${id}.title`) as string);
      expect(section(id).getAttribute('aria-labelledby')).toBe(heading?.id ?? null);
      expect(heading?.id).toBeTruthy();
    }
  });

  test('every section states what the criteria name for it', () => {
    const { section } = renderTerms(locale);
    for (const [id, stems] of Object.entries(STEMS[locale]) as Array<[SectionId, string[]]>) {
      for (const stem of stems) {
        expect(lower(section(id)), `${locale} ${id} should mention "${stem}"`).toContain(stem);
      }
    }
  });

  test('the licences section names MIT for the software and CC BY-SA 4.0 for the knowledge', () => {
    const { section } = renderTerms(locale);
    const licences = section('licences');
    const items = Array.from(licences.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(items.some((item) => item.includes('MIT'))).toBe(true);
    expect(items.some((item) => item.includes('CC BY-SA 4.0'))).toBe(true);
    expect(items.find((item) => item.includes('MIT'))).not.toContain('CC BY-SA');
    const link = licences.querySelector<HTMLAnchorElement>(`a[href="${CC_URL}"]`);
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel') ?? '').toMatch(/noopener/);
  });

  test('the reuse section explains attribution and share-alike and shows the exact attribution line', () => {
    const { section } = renderTerms(locale);
    const reuse = section('reuse');
    expect(reuse.textContent).toContain('CC BY-SA 4.0');
    expect(ATTRIBUTION_LINE).toBeDefined();
    const line = Array.from(reuse.querySelectorAll('code')).find((code) => code.textContent === ATTRIBUTION_LINE);
    expect(line, 'attribution line from CONTENT-LICENSE.md, verbatim, in a <code>').toBeDefined();
    expect(line?.closest('[lang]')?.getAttribute('lang')).toBe('en');
    const download = reuse.querySelector<HTMLAnchorElement>(`a[href="${EXPORT_PATH}"]`);
    expect(download).not.toBeNull();
  });

  test('the contributor section keeps authorship, licences under CC BY-SA 4.0 and bars FIFA, UEFA and commercial material', () => {
    const { section } = renderTerms(locale);
    const contributing = section('contributing');
    const items = Array.from(contributing.querySelectorAll('li'));
    expect(items).toHaveLength(REQUIRED_POINTS.contributing!.length);
    const text = contributing.textContent ?? '';
    expect(text).toContain('CC BY-SA 4.0');
    expect(text).toContain('FIFA');
    expect(text).toContain('UEFA');
    const bar = items.find((li) => (li.textContent ?? '').includes('FIFA'));
    expect(bar?.textContent).toContain('UEFA');
    // The bar is a point of its own, not folded into the licence point.
    expect(items.find((li) => (li.textContent ?? '').includes('CC BY-SA 4.0'))?.textContent).not.toContain('FIFA');
  });

  test('the community-draft section shows the label with the same text the trust badge uses', () => {
    const { section } = renderTerms(locale);
    const draft = section('communityDraft');
    const badge = draft.querySelector('[data-status="COMMUNITY"]');
    expect(badge?.textContent).toBe(DRAFT_LABEL[locale]);
  });

  test('the own-risk statement is a warning that carries an icon, not colour alone', () => {
    const { section } = renderTerms(locale);
    const warning = section('ownRisk').querySelector('[data-tone="warn"]');
    expect(warning).not.toBeNull();
    expect(warning?.querySelector('svg')).not.toBeNull();
    expect(lower(warning!)).toContain(STEMS[locale].ownRisk![0]!);
    // The safety notes are a real list after it.
    expect(section('ownRisk').querySelectorAll('li').length).toBeGreaterThanOrEqual(3);
  });

  test('the guardian advice is a visible notice, not a footnote', () => {
    const { section } = renderTerms(locale);
    const notice = section('children').querySelector('[data-tone="info"]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('svg')).not.toBeNull();
    expect(lower(notice!)).toContain(STEMS[locale].children![0]!);
  });

  test('a contents list links every section and each link lands on a section', () => {
    const { container, section } = renderTerms(locale);
    const nav = container.querySelector('nav');
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute('aria-label')).toBeTruthy();
    const links = Array.from(nav!.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(SECTION_IDS.map((id) => `#${id}`));
    links.forEach((link, index) => {
      const id = SECTION_IDS[index]!;
      expect(link.textContent?.trim()).toBe(at(messages[locale] as Tree, `sections.${id}.title`) as string);
      expect(section(id)).toBeDefined();
      expect(tokens(link)).toContain('min-h-tap');
    });
  });

  test('links are at least 44px tall and open external sites safely', () => {
    const { container } = renderTerms(locale);
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(SECTION_IDS.length);
    for (const link of links) expect(tokens(link), link.outerHTML).toContain('min-h-tap');
    for (const link of links.filter((a) => (a.getAttribute('href') ?? '').startsWith('http'))) {
      expect(link.getAttribute('rel') ?? '').toMatch(/noopener/);
    }
  });

  test('never renders an unresolved key, "undefined" or an object', () => {
    const { text } = renderTerms(locale);
    for (const bad of ['undefined', '[object', 'sections.', 'terms:', 'null', '{{']) {
      expect(text).not.toContain(bad);
    }
  });

  test('has no inline colours: tokens and classes only', () => {
    const { container } = renderTerms(locale);
    for (const element of Array.from(container.querySelectorAll('*'))) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/#|rgb|hsl/);
    }
  });
});

// --- takedown contact -------------------------------------------------------------------------------

describe('takedown contact', () => {
  test.each([...LOCALES])('%s: says how to reach the operator when VITE_CONTACT_EMAIL is set', (locale) => {
    process.env.VITE_CONTACT_EMAIL = 'takedown@example.org';
    const { section } = renderTerms(locale);
    const link = section('takedown').querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(link?.getAttribute('href')).toBe('mailto:takedown@example.org');
    expect(link?.textContent).toBe('takedown@example.org');
    expect(tokens(link!)).toContain('min-h-tap');
  });

  test.each([...LOCALES])('%s: says honestly that no address is published when it is not set', (locale) => {
    const { section } = renderTerms(locale);
    expect(section('takedown').querySelector('a[href^="mailto:"]')).toBeNull();
    expect(section('takedown').textContent).toContain((messages[locale] as Tree).noContact as string);
    expect(((messages[locale] as Tree).noContact as string).length).toBeGreaterThan(10);
  });

  test.each(['', '   ', 'not-an-address', 'a b@example.org', '@example.org'])(
    'ignores %p instead of building a broken mailto link',
    (value) => {
      process.env.VITE_CONTACT_EMAIL = value;
      const { section } = renderTerms('en');
      expect(section('takedown').querySelector('a[href^="mailto:"]')).toBeNull();
      expect(section('takedown').textContent).toContain((messages.en as Tree).noContact as string);
    },
  );

  test('trims the configured address', () => {
    process.env.VITE_CONTACT_EMAIL = '  takedown@example.org  ';
    const { section } = renderTerms('en');
    expect(section('takedown').querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe('mailto:takedown@example.org');
  });
});

// --- language switch ---------------------------------------------------------------------------------

describe('language switch', () => {
  test('the page follows the language without remounting', async () => {
    const { container, instance } = renderTerms('en');
    const h1 = container.querySelector('h1')!;
    expect(h1.textContent).toBe((messages.en as Tree).title as string);
    await act(async () => {
      await instance.changeLanguage('ru');
    });
    expect(h1.textContent).toBe((messages.ru as Tree).title as string);
    await act(async () => {
      await instance.changeLanguage('kk');
    });
    expect(h1.textContent).toBe((messages.kk as Tree).title as string);
    expect(h1.isConnected).toBe(true);
  });
});
