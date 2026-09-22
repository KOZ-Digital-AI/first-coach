import { afterEach, describe, expect, test } from 'bun:test';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LANGUAGE_NAMES, LOCALES } from '../../lib/i18n';
import LanguageSwitch from './header-extra';
import switchMessages from './i18n.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is
// no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as shell.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');

/*
 * fc-zfg.9: the component test for features/i18n/header-extra.tsx (a dedicated file, alongside lib/i18n.test.ts's
 * broader "language switch" describe block, which pins the same contract from the i18n-system side).
 *
 * Design decision under test (two user screenshots, desktop widths >=900px): the header row must never wrap. The
 * language switch used to show each button's full native name (Қазақша / Русский / English), which was too wide for
 * the row to share with the full primary navigation at once, so ru/kk forced the header-extra slot onto a second row.
 * DESIGN.md Navigation says the switch must stay reachable and never drop an option, so it shrinks instead: each
 * button now shows a compact 3-letter label (Қаз / Рус / Eng, i18n.messages.ts's `short`), while the full native name
 * moves to the button's accessible name (aria-label) and its title, so nothing is actually lost - only the glyph
 * count on screen. State (which language is current) is unaffected: aria-pressed still marks exactly one button, and
 * clicking a button still switches i18n's active language.
 */

// Web test hygiene: happy-dom's internal query caches (affectsCache / affectsComputedStyleCache / querySelectorCache)
// are shared by every *.test.tsx in this happy-dom window and can slow down or time out a later file if left to grow.
// Copied from the working pattern in features/contribute/form.test.tsx's last afterEach, written against happy-dom
// 20.x symbols by description (does nothing if they are not there).
function resetHappyDomCaches(): void {
  const targets: object[] = [document, document.documentElement, document.body, window];
  for (const target of targets) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if ((symbol.description === 'affectsCache' || symbol.description === 'affectsComputedStyleCache') && Array.isArray(value)) {
        for (const item of value) if (typeof item === 'object' && item !== null) (item as { result: unknown }).result = null;
        value.length = 0;
      } else if (symbol.description === 'querySelectorCache' && value instanceof Map) {
        value.clear();
      }
    }
  }
}

afterEach(() => {
  cleanup();
  resetHappyDomCaches();
});

// --- helpers ----------------------------------------------------------------------------------

const modules = { './i18n.messages.ts': { default: switchMessages } };

function renderSwitch(language: string) {
  const instance = createI18n({ modules, languages: [language], storage: { getItem: () => null, setItem: () => {} } });
  render(
    <I18nextProvider i18n={instance}>
      <LanguageSwitch />
    </I18nextProvider>,
  );
  return instance;
}

const buttons = () => screen.getAllByRole('button');

// --- short visible labels -----------------------------------------------------------------------

describe('visible labels', () => {
  test('each button shows the compact 3-letter label (Қаз, Рус, Eng), not the full native name', () => {
    renderSwitch('en');
    expect(buttons().map((button) => button.textContent)).toEqual(LOCALES.map((locale) => switchMessages.en.short[locale]));
    for (const button of buttons()) {
      for (const fullName of Object.values(LANGUAGE_NAMES)) expect(button.textContent).not.toBe(fullName);
    }
  });

  test('the short label is the same regardless of which language is currently active', () => {
    renderSwitch('ru');
    expect(buttons().map((button) => button.textContent)).toEqual(['Қаз', 'Рус', 'Eng']);
  });
});

// --- accessible name / title -------------------------------------------------------------------

describe('accessible name (fc-zfg.9: nothing is lost, only the visible glyph count)', () => {
  test('each button keeps the full native name as its aria-label and its title', () => {
    renderSwitch('en');
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(LOCALES.map((locale) => LANGUAGE_NAMES[locale]));
    expect(buttons().map((button) => button.getAttribute('title'))).toEqual(LOCALES.map((locale) => LANGUAGE_NAMES[locale]));
  });

  test('a lookup by the full native name still resolves a button (aria-label wins the accessible-name computation)', () => {
    renderSwitch('en');
    for (const locale of LOCALES) expect(screen.getByRole('button', { name: LANGUAGE_NAMES[locale] })).toBeTruthy();
  });
});

// --- current language: shown and switchable ------------------------------------------------------

describe('the language control shows the current language and switches it', () => {
  test.each([...LOCALES])('with %s current, aria-pressed is true on that button only', (current) => {
    renderSwitch(current);
    const pressed = buttons().map((button) => button.getAttribute('aria-pressed'));
    expect(pressed).toEqual(LOCALES.map((locale) => (locale === current ? 'true' : 'false')));
  });

  test('clicking a button switches the active language and moves aria-pressed', () => {
    const instance = renderSwitch('en');
    const ruButton = screen.getByRole('button', { name: LANGUAGE_NAMES.ru });
    fireEvent.click(ruButton);
    expect(instance.language).toBe('ru');
    expect(ruButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: LANGUAGE_NAMES.en }).getAttribute('aria-pressed')).toBe('false');
  });
});

// --- tap targets ---------------------------------------------------------------------------------

describe('tap targets (DESIGN.md: at least 44px, even with the tighter padding)', () => {
  test('every button keeps the 44px minimum width and height utilities', () => {
    renderSwitch('kk');
    for (const button of buttons()) {
      expect(button.className).toContain('min-h-tap');
      expect(button.className).toContain('min-w-tap');
    }
  });
});
