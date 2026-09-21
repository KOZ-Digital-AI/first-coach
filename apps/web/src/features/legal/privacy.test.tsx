import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES, namespaceOf } from '../../lib/i18n';
import { Route } from '../../routes/legal/privacy';
import messages, { PRIVACY_SECTIONS } from './privacy.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/commons/TrustBadge.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

afterEach(() => cleanup());

// --- helpers ----------------------------------------------------------------------------------

const modules = { './privacy.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };
const PrivacyPage = Route.options.component as ComponentType;

/** An isolated i18n instance per render: no global state, no <html lang> writes, no storage. */
function renderPage(locale: Locale) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  return render(
    <I18nextProvider i18n={instance}>
      <PrivacyPage />
    </I18nextProvider>,
  );
}

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

function valueAt(tree: object, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);
}

const mailtoLinks = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]'));

// The sections the bead's criteria name. The page may add more; it may not drop one of these.
const REQUIRED_SECTIONS = ['who', 'stored', 'video', 'ads', 'yourData', 'guardians', 'takedown'] as const;

// Anchor phrases per language (the criteria's claims, in the words of the shipped copy). Kazakh text still needs the
// scheduled native review (fc-cjh); if that review rewords a claim, update the anchor with it.
const CLAIMS: Record<
  Locale,
  {
    title: string;
    pending: RegExp;
    aiProvider: RegExp;
    videoStaysOnDevice: RegExp;
    stillFramesOnly: RegExp;
    noAds: RegExp;
    noThirdPartyAnalytics: RegExp;
    download: RegExp;
    remove: RegExp;
    takedown: RegExp;
  }
> = {
  en: {
    title: 'Privacy policy',
    pending: /pending legal review/i,
    aiProvider: /AI provider/,
    videoStaysOnDevice: /never leaves your phone/i,
    stillFramesOnly: /still pictures/i,
    noAds: /no ads/i,
    noThirdPartyAnalytics: /third-party analytics/i,
    download: /download/i,
    remove: /delete/i,
    takedown: /take (?:it|a drill) down/i,
  },
  ru: {
    title: 'Политика конфиденциальности',
    pending: /юридической проверки/i,
    aiProvider: /поставщику ИИ/,
    videoStaysOnDevice: /не покидает ваш телефон/i,
    stillFramesOnly: /стоп-кадры/i,
    noAds: /рекламы/i,
    noThirdPartyAnalytics: /сторонн\S* аналитик/i,
    download: /скачать/i,
    remove: /удалить/i,
    takedown: /убрать упражнение/i,
  },
  kk: {
    title: 'Құпиялылық саясаты',
    pending: /заңгерлік тексеру/i,
    aiProvider: /жасанды интеллект \(ЖИ\) провайдеріне/,
    videoStaysOnDevice: /телефоннан ешқашан шықпайды/i,
    stillFramesOnly: /кадр/i,
    noAds: /жарнама/i,
    noThirdPartyAnalytics: /аналитика/i,
    download: /жүктеп алу/i,
    remove: /жою/i,
    takedown: /алып тастау/i,
  },
};

// The contact address is read from VITE_CONTACT_EMAIL. Under bun `import.meta.env` is process.env, read at render time.
const ENV_KEY = 'VITE_CONTACT_EMAIL';
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

// --- catalogue ---------------------------------------------------------------------------------

describe('privacy.messages.ts', () => {
  test('is registered by the file-name convention: namespace "privacy"', () => {
    expect(namespaceOf('../features/legal/privacy.messages.ts')).toBe('privacy');
  });

  test('all three locales have every key of every other locale', () => {
    const [kk, ru, en] = [messages.kk, messages.ru, messages.en].map((tree) => leafKeys(tree).sort());
    expect(kk!.length).toBeGreaterThan(20);
    expect(ru).toEqual(kk!);
    expect(en).toEqual(kk!);
  });

  test('every string is non-blank in every locale', () => {
    for (const locale of LOCALES) {
      const tree = messages[locale];
      for (const key of leafKeys(tree)) {
        expect((valueAt(tree, key) as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test.each([...REQUIRED_SECTIONS])('the page lists the "%s" section', (id) => {
    expect(PRIVACY_SECTIONS.map((section) => section.id)).toContain(id);
  });

  test('every section has a title and at least one paragraph or item, in all three locales', () => {
    for (const section of PRIVACY_SECTIONS) {
      expect(section.paragraphs.length + section.items.length).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        const tree = messages[locale];
        expect(typeof valueAt(tree, `sections.${section.id}.title`)).toBe('string');
        for (const key of [...section.paragraphs, ...section.items, ...section.closing]) {
          const text = valueAt(tree, `sections.${section.id}.${key}`);
          expect(typeof text).toBe('string');
          expect((text as string).trim()).not.toBe('');
        }
      }
    }
  });

  test('page-level strings exist in all three locales', () => {
    for (const locale of LOCALES) {
      for (const key of ['eyebrow', 'title', 'lead', 'status.label', 'status.note', 'contact.guardians', 'contact.takedown']) {
        expect(typeof valueAt(messages[locale], key)).toBe('string');
      }
    }
  });
});

// --- the rendered page, each locale -----------------------------------------------------------------

describe.each([...LOCALES])('locale %s', (locale) => {
  const claims = CLAIMS[locale];
  const text = () => document.body.textContent ?? '';

  test('one h1 with the policy title, and one h2 per required section', () => {
    renderPage(locale);
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]?.textContent).toBe(claims.title);
    for (const id of REQUIRED_SECTIONS) {
      const title = valueAt(messages[locale], `sections.${id}.title`) as string;
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy();
    }
  });

  test('each section is a labelled region named by its own heading', () => {
    renderPage(locale);
    for (const id of REQUIRED_SECTIONS) {
      const title = valueAt(messages[locale], `sections.${id}.title`) as string;
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
    }
  });

  test('says who runs the service: KOZ AI', () => {
    renderPage(locale);
    const who = valueAt(messages[locale], 'sections.who.title') as string;
    expect(screen.getByRole('region', { name: who }).textContent).toContain('KOZ AI');
  });

  test('marks itself as a plain-language policy pending legal review', () => {
    renderPage(locale);
    expect(text()).toMatch(claims.pending);
    expect(screen.getByRole('note').textContent).toMatch(claims.pending);
  });

  test('says player video never leaves the device and only still frames go to an AI provider after separate consent', () => {
    renderPage(locale);
    const video = screen.getByRole('region', { name: valueAt(messages[locale], 'sections.video.title') as string });
    expect(video.textContent).toMatch(claims.videoStaysOnDevice);
    expect(video.textContent).toMatch(claims.stillFramesOnly);
    expect(video.textContent).toMatch(claims.aiProvider);
  });

  test('says nothing is used for advertising and there is no third-party analytics', () => {
    renderPage(locale);
    const ads = screen.getByRole('region', { name: valueAt(messages[locale], 'sections.ads.title') as string });
    expect(ads.textContent).toMatch(claims.noAds);
    expect(ads.textContent).toMatch(claims.noThirdPartyAnalytics);
  });

  test('says how to download or delete the data', () => {
    renderPage(locale);
    const data = screen.getByRole('region', { name: valueAt(messages[locale], 'sections.yourData.title') as string });
    expect(data.textContent).toMatch(claims.download);
    expect(data.textContent).toMatch(claims.remove);
  });

  test('has a content takedown section', () => {
    renderPage(locale);
    const takedown = screen.getByRole('region', { name: valueAt(messages[locale], 'sections.takedown.title') as string });
    expect(takedown.textContent).toMatch(claims.takedown);
  });

  test('renders no missing-key leftovers: no "undefined", no raw {{placeholders}}, no dotted key paths', () => {
    process.env[ENV_KEY] = 'privacy@example.org';
    renderPage(locale);
    expect(text()).not.toContain('undefined');
    expect(text()).not.toContain('{{');
    expect(text()).not.toMatch(/\bsections\.\w+\./);
  });
});

// --- contact placeholder (VITE_CONTACT_EMAIL) ------------------------------------------------------

describe('contact address', () => {
  test.each([...LOCALES])('%s: with the variable set, guardians and the takedown path both get a mailto link to it', (locale) => {
    process.env[ENV_KEY] = 'privacy@example.org';
    const { container } = renderPage(locale);
    const links = mailtoLinks(container);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('mailto:privacy@example.org');
      expect(link.textContent).toBe('privacy@example.org');
    }
    for (const id of ['guardians', 'takedown']) {
      const region = screen.getByRole('region', { name: valueAt(messages[locale], `sections.${id}.title`) as string });
      expect(mailtoLinks(region as HTMLElement)).toHaveLength(1);
    }
  });

  test('the link is a real 44px target', () => {
    process.env[ENV_KEY] = 'privacy@example.org';
    const { container } = renderPage('en');
    for (const link of mailtoLinks(container)) expect(Array.from(link.classList)).toContain('min-h-tap');
  });

  test('surrounding whitespace in the variable is trimmed', () => {
    process.env[ENV_KEY] = '  privacy@example.org \n';
    const { container } = renderPage('en');
    expect(mailtoLinks(container)[0]?.getAttribute('href')).toBe('mailto:privacy@example.org');
  });

  test.each([...LOCALES])('%s: with the variable unset, nothing about a contact address is shown', (locale) => {
    const { container } = renderPage(locale);
    expect(mailtoLinks(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('@');
    for (const key of ['contact.guardians', 'contact.takedown']) {
      expect(container.textContent).not.toContain(valueAt(messages[locale], key) as string);
    }
  });

  test.each(['', '   ', 'not-an-email', 'two words@example.org', 'a@b@c'])('a blank or malformed value (%p) hides it too', (value) => {
    process.env[ENV_KEY] = value;
    const { container } = renderPage('en');
    expect(mailtoLinks(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('@');
  });

  test('the rest of the policy is unchanged when the address is hidden', () => {
    const { container } = renderPage('en');
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBe(PRIVACY_SECTIONS.length);
    expect(container.textContent).toContain('KOZ AI');
  });
});
