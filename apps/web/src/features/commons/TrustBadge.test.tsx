import { afterEach, describe, expect, test } from 'bun:test';
import { TRUST_STATUSES, type TrustStatus } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES, namespaceOf } from '../../lib/i18n';
import { GENESIS_DRAFT_SOURCE, TrustBadge } from './TrustBadge';
import messages from './trust-badge.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as lib/i18n.test.ts).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];
type Props = Parameters<typeof TrustBadge>[0];

afterEach(() => cleanup());

// --- helpers ----------------------------------------------------------------------------------

const modules = { './trust-badge.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };

/** An isolated i18n instance per render: no global state, no <html lang> writes, no storage. */
function renderBadge(locale: Locale, props: Props) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const view = render(
    <I18nextProvider i18n={instance}>
      <TrustBadge {...props} />
    </I18nextProvider>,
  );
  const badge = view.container.firstElementChild as HTMLElement;
  return { ...view, instance, badge };
}

const tokens = (element: Element): string[] => Array.from(element.classList);

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

// Natural forms for each language. Kazakh still needs the scheduled native review; these are the shipped strings.
const EXPECTED: Record<
  Locale,
  Record<TrustStatus, string> & { draft: string; org: (label: string) => string }
> = {
  en: {
    COMMUNITY: 'Community',
    REVIEWED: 'Reviewed',
    EXPERT_VERIFIED: 'Expert verified',
    ACADEMY_VERIFIED: 'Academy verified',
    draft: 'Community Draft',
    org: (label) => `Verified by ${label}`,
  },
  ru: {
    COMMUNITY: 'Сообщество',
    REVIEWED: 'Рецензировано',
    EXPERT_VERIFIED: 'Проверено экспертом',
    ACADEMY_VERIFIED: 'Проверено академией',
    draft: 'Черновик сообщества',
    org: (label) => `Проверено: ${label}`,
  },
  kk: {
    COMMUNITY: 'Қауымдастық',
    REVIEWED: 'Қаралған',
    EXPERT_VERIFIED: 'Сарапшы тексерген',
    ACADEMY_VERIFIED: 'Академия тексерген',
    draft: 'Қауымдастық жобасы',
    org: (label) => `Тексерген: ${label}`,
  },
};

const VERIFIED: TrustStatus[] = ['EXPERT_VERIFIED', 'ACADEMY_VERIFIED'];
const UNVERIFIED: TrustStatus[] = ['COMMUNITY', 'REVIEWED'];
const ORG = 'Kairat Academy';

// --- the shared contract this badge consumes ------------------------------------------------

describe('contract', () => {
  test('the four trust statuses are the ones this badge is written for', () => {
    expect([...TRUST_STATUSES]).toEqual(['COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED']);
  });

  test('the Genesis draft source is the exact string the seed drills carry', () => {
    expect(GENESIS_DRAFT_SOURCE).toBe('FIRST COACH Community Draft');
  });
});

// --- catalogue ---------------------------------------------------------------------------------

describe('trust-badge.messages.ts', () => {
  test('is registered by the file-name convention: namespace "trust-badge"', () => {
    expect(namespaceOf('./trust-badge.messages.ts')).toBe('trust-badge');
    expect(namespaceOf('../features/commons/trust-badge.messages.ts')).toBe('trust-badge');
  });

  test('default-exports kk, ru and en with the same keys', () => {
    const [kk, ru, en] = [messages.kk, messages.ru, messages.en].map((tree) => leafKeys(tree).sort());
    expect(kk?.length).toBeGreaterThanOrEqual(6);
    expect(ru).toEqual(kk!);
    expect(en).toEqual(kk!);
  });

  test('every string is non-blank in every locale', () => {
    for (const locale of LOCALES) {
      const tree = messages[locale] as Record<string, unknown>;
      for (const key of leafKeys(tree)) {
        expect(typeof tree[key]).toBe('string');
        expect((tree[key] as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('the org sentence takes the label through the {{org}} placeholder in every locale', () => {
    for (const locale of LOCALES) {
      const sentences = Object.values(messages[locale] as Record<string, string>).filter((text) => text.includes('{{org}}'));
      expect(sentences).toHaveLength(1);
    }
  });

  test('no locale reuses one translation for two different statuses', () => {
    for (const locale of LOCALES) {
      const all = [...TRUST_STATUSES.map((status) => EXPECTED[locale][status]), EXPECTED[locale].draft];
      expect(new Set(all).size).toBe(all.length);
    }
  });
});

// --- each status, each locale -------------------------------------------------------------------

describe.each([...LOCALES])('locale %s', (locale) => {
  const expected = EXPECTED[locale];

  test.each([...TRUST_STATUSES])('%s reads its own written label', (status) => {
    const { badge } = renderBadge(locale, { status });
    expect(badge.textContent).toBe(expected[status]);
    expect(screen.getByText(expected[status])).toBeTruthy();
  });

  test('COMMUNITY from the Genesis draft reads the draft label', () => {
    const { badge } = renderBadge(locale, { status: 'COMMUNITY', source: GENESIS_DRAFT_SOURCE });
    expect(badge.textContent).toBe(expected.draft);
  });

  test.each(VERIFIED)('%s with an organisation reads "Verified by <label>"', (status) => {
    const { badge } = renderBadge(locale, { status, orgLabel: ORG });
    expect(badge.textContent).toBe(expected.org(ORG));
  });

  test.each(UNVERIFIED)('%s never shows an organisation label', (status) => {
    const { badge } = renderBadge(locale, { status, orgLabel: ORG });
    expect(badge.textContent).toBe(expected[status]);
    expect(badge.textContent).not.toContain(ORG);
  });
});

// --- the COMMUNITY / Genesis-draft rule ------------------------------------------------------

describe('Community versus Community Draft', () => {
  test.each([undefined, '', 'Kairat Academy', 'FIRST COACH', 'first coach community draft', 'FIRST COACH Community Draft v2'])(
    'COMMUNITY with source %p reads plain "Community"',
    (source) => {
      const { badge } = renderBadge('en', { status: 'COMMUNITY', source });
      expect(badge.textContent).toBe('Community');
    },
  );

  test('the exact Genesis source is the only thing that makes it a draft', () => {
    const { badge } = renderBadge('en', { status: 'COMMUNITY', source: GENESIS_DRAFT_SOURCE });
    expect(badge.textContent).toBe('Community Draft');
  });

  test.each(['REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED'] as const)(
    '%s keeps its own label even when the source is the Genesis draft',
    (status) => {
      const { badge } = renderBadge('en', { status, source: GENESIS_DRAFT_SOURCE });
      expect(badge.textContent).toBe(EXPECTED.en[status]);
      expect(badge.textContent).not.toContain('Draft');
    },
  );

  test('the Genesis source does not stop a verified drill reading "Verified by <label>"', () => {
    const { badge } = renderBadge('en', { status: 'EXPERT_VERIFIED', source: GENESIS_DRAFT_SOURCE, orgLabel: ORG });
    expect(badge.textContent).toBe('Verified by Kairat Academy');
  });
});

// --- the organisation label --------------------------------------------------------------------

describe('organisation label', () => {
  test.each(['', ' ', '   ', '\t\n'])('a blank label (%p) is ignored: the status label shows', (orgLabel) => {
    const { badge } = renderBadge('en', { status: 'EXPERT_VERIFIED', orgLabel });
    expect(badge.textContent).toBe('Expert verified');
  });

  test('surrounding whitespace is trimmed', () => {
    const { badge } = renderBadge('en', { status: 'ACADEMY_VERIFIED', orgLabel: '  Kairat Academy \n' });
    expect(badge.textContent).toBe('Verified by Kairat Academy');
  });

  test('markup in the label is text, never elements', () => {
    const label = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const { badge } = renderBadge('en', { status: 'EXPERT_VERIFIED', orgLabel: label });
    expect(badge.textContent).toBe(`Verified by ${label}`);
    expect(badge.querySelector('script')).toBeNull();
    expect(badge.querySelector('img')).toBeNull();
  });

  test('right-to-left and mixed-script labels reach the DOM intact', () => {
    for (const label of ['أكاديمية الشباب', 'Қайрат Академиясы (Алматы)', 'שלום Academy']) {
      const { badge, unmount } = renderBadge('ru', { status: 'ACADEMY_VERIFIED', orgLabel: label });
      expect(badge.textContent).toBe(`Проверено: ${label}`);
      unmount();
    }
  });

  test('i18next interpolation syntax inside the label is not re-interpreted', () => {
    const { badge } = renderBadge('en', { status: 'EXPERT_VERIFIED', orgLabel: '{{org}} $t(reviewed) {{oops}}' });
    expect(badge.textContent).toBe('Verified by {{org}} $t(reviewed) {{oops}}');
  });

  test('a very long label stays whole in the DOM and is truncated by CSS, not cut by code', () => {
    const label = `Академия ${'очень-длинное-название '.repeat(14)}`.trim();
    const { badge } = renderBadge('ru', { status: 'ACADEMY_VERIFIED', orgLabel: label });
    expect(badge.textContent).toBe(`Проверено: ${label}`);
    expect(tokens(badge)).toContain('max-w-full');
    const text = screen.getByText(`Проверено: ${label}`);
    expect(tokens(text)).toContain('truncate');
    expect(tokens(text)).toContain('min-w-0');
  });
});

// --- never colour alone ------------------------------------------------------------------------

describe('not colour alone: an icon and a word', () => {
  test.each([...TRUST_STATUSES])('%s carries exactly one decorative svg icon next to its text', (status) => {
    const { badge } = renderBadge('en', { status });
    const icons = badge.querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(badge.textContent?.trim().length).toBeGreaterThan(0);
  });

  test('every status draws a different icon shape', () => {
    const shapes = TRUST_STATUSES.map((status) => {
      const { badge, unmount } = renderBadge('en', { status });
      const shape = badge.querySelector('svg')!.innerHTML;
      unmount();
      return shape;
    });
    expect(shapes.every((shape) => shape.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(TRUST_STATUSES.length);
  });

  test('every status has a different written label in every locale', () => {
    for (const locale of LOCALES) {
      const labels = TRUST_STATUSES.map((status) => {
        const { badge, unmount } = renderBadge(locale, { status });
        const text = badge.textContent;
        unmount();
        return text;
      });
      expect(new Set(labels).size).toBe(TRUST_STATUSES.length);
    }
  });

  test.each([...TRUST_STATUSES])('%s exposes its status as data-status', (status) => {
    const { badge } = renderBadge('en', { status });
    expect(badge.getAttribute('data-status')).toBe(status);
  });

  test('the accessible name is the visible text: no title, no aria-label to contradict it', () => {
    for (const status of TRUST_STATUSES) {
      const { badge, unmount } = renderBadge('en', { status, orgLabel: ORG });
      expect(badge.hasAttribute('title')).toBe(false);
      expect(badge.hasAttribute('aria-label')).toBe(false);
      expect(badge.hasAttribute('aria-labelledby')).toBe(false);
      unmount();
    }
  });

  test('is a plain inline badge: not a control, not focusable, no role', () => {
    const { badge } = renderBadge('en', { status: 'EXPERT_VERIFIED', orgLabel: ORG });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(badge.hasAttribute('tabindex')).toBe(false);
    expect(badge.hasAttribute('role')).toBe(false);
    expect(badge.querySelector('button, a, [tabindex]')).toBeNull();
  });
});

// --- design system reuse ------------------------------------------------------------------------

describe('built on the Tag primitive', () => {
  test.each([...TRUST_STATUSES])('%s is a Tag pill at the 12px bold label size', (status) => {
    const { badge } = renderBadge('en', { status });
    expect(badge.hasAttribute('data-tone')).toBe(true);
    for (const token of ['rounded-pill', 'text-xs', 'font-bold', 'inline-flex']) {
      expect(tokens(badge)).toContain(token);
    }
  });

  test.each([...TRUST_STATUSES])('%s never borrows the warning or danger tone: trust is not an alert', (status) => {
    const { badge } = renderBadge('en', { status });
    expect(['neutral', 'accent']).toContain(badge.getAttribute('data-tone') ?? '');
  });

  test('no inline colours: tokens and classes only', () => {
    const { badge } = renderBadge('en', { status: 'ACADEMY_VERIFIED', orgLabel: ORG });
    expect(badge.getAttribute('style')).toBeNull();
    for (const element of [badge, ...Array.from(badge.querySelectorAll('*'))]) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/#|rgb|hsl/);
      expect(element.getAttribute('fill') ?? '').not.toMatch(/#|rgb|hsl/);
    }
  });

  test('a caller className is added, not substituted', () => {
    const { badge } = renderBadge('en', { status: 'REVIEWED', className: 'ml-2' });
    expect(tokens(badge)).toContain('ml-2');
    expect(tokens(badge)).toContain('rounded-pill');
  });
});

// --- data from an older client cache: never over-claim trust --------------------------------------

describe('an unrecognised status', () => {
  const garbage = ['GOLD_VERIFIED', 'verified', 'expert_verified', '', 'toString', 'constructor', '__proto__', 'hasOwnProperty'];

  test.each(garbage)('%p renders the lowest-trust "Community" presentation', (raw) => {
    const { badge } = renderBadge('en', { status: raw as unknown as TrustStatus });
    expect(badge.textContent).toBe('Community');
    expect(badge.getAttribute('data-status')).toBe('COMMUNITY');
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
  });

  test.each([undefined, null, 0, {}])('%p (not even a string) renders "Community"', (raw) => {
    const { badge } = renderBadge('en', { status: raw as unknown as TrustStatus });
    expect(badge.textContent).toBe('Community');
    expect(badge.getAttribute('data-status')).toBe('COMMUNITY');
  });

  test.each([...LOCALES])('never says verified or reviewed in %s, even with an organisation label', (locale) => {
    const { badge } = renderBadge(locale, { status: 'PLATINUM' as unknown as TrustStatus, orgLabel: ORG });
    expect(badge.textContent).toBe(EXPECTED[locale].COMMUNITY);
    expect(badge.textContent).not.toContain(ORG);
    for (const status of ['REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED'] as const) {
      expect(badge.textContent).not.toBe(EXPECTED[locale][status]);
    }
  });

  test('its icon is the COMMUNITY icon, not a verified one', () => {
    const shape = (status: TrustStatus): string => {
      const { badge, unmount } = renderBadge('en', { status });
      const html = badge.querySelector('svg')!.innerHTML;
      unmount();
      return html;
    };
    expect(shape('SOMETHING_NEW' as unknown as TrustStatus)).toBe(shape('COMMUNITY'));
  });
});

// --- language switch ---------------------------------------------------------------------------------

describe('language switch', () => {
  test('the text follows the language without remounting', async () => {
    const { badge, instance } = renderBadge('en', { status: 'EXPERT_VERIFIED', orgLabel: ORG });
    expect(badge.textContent).toBe(EXPECTED.en.org(ORG));
    await act(async () => {
      await instance.changeLanguage('ru');
    });
    expect(badge.textContent).toBe(EXPECTED.ru.org(ORG));
    await act(async () => {
      await instance.changeLanguage('kk');
    });
    expect(badge.textContent).toBe(EXPECTED.kk.org(ORG));
    expect(badge.isConnected).toBe(true);
  });
});
