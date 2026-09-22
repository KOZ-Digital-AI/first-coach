import { afterEach, describe, expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import { Shell, type NavTier } from './Shell';
import shellMessages from './shell.messages';

// Same DOM guard as features/shell/shell.test.tsx: the web preload only applies when bun runs from apps/web.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`: a failing assertion pretty-prints the whole happy-dom graph
// (a minute). Compare with === and assert on the boolean.

/*
 * fc-mol-bjm.12: the app shell links to Privacy settings (/settings/privacy) and to "Video Coach · Beta" (/video).
 *  - Privacy settings: reachable for every visitor kind that has a player (anonymous guests included), so the shell shows it
 *    with no session or role check; a real, keyboard-reachable link with aria-current on its own page; kk/ru/en label.
 *  - Video Coach · Beta: an optional entry that never blocks training; kk/ru/en label from the shell messages; keyboard
 *    reachable, aria-current on its own page.
 * The strings of the Privacy settings link live in features/shell/nav-links.messages.ts (namespace `nav-links`), not in
 * shell.messages.ts, so this bead does not edit the shell bundle. The bundle is loaded with a tolerant dynamic import so the
 * tests fail on behaviour (the link is missing), not on a missing module, before the implementation exists.
 * Kazakh and Russian copy still needs a native review: for those locales the tests pin that the text exists, is Cyrillic and
 * differs from English and from the privacy-policy link, never that it has one exact wording.
 */

type Locale = (typeof LOCALES)[number];
const LOCALE_LIST = ['kk', 'ru', 'en'] as const satisfies readonly Locale[];

const navLinks = (await import('./nav-links.messages').catch(() => ({ default: undefined }))).default;

// --- happy-dom hygiene (all apps/web test files share one window; see features/contribute/form.test.tsx) ----------------

/**
 * happy-dom keeps unbounded internal query caches per document/window; a Testing Library file with many queries leaves
 * thousands of entries behind and slows every later test file. Invalidate each recorded result, then empty the lists, the way
 * happy-dom does when a node changes. Written against happy-dom 20.x symbols by description; if they are absent it does nothing.
 */
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

// Globals this file touches: none besides the DOM (the i18n instance is built per render and passed to a provider; nothing
// is written to localStorage, fetch or timers). The router's memory history is dropped with the render.
afterEach(() => {
  cleanup();
  resetHappyDomCaches();
});

// --- helpers ----------------------------------------------------------------------------------

const modules = {
  './shell.messages.ts': { default: shellMessages },
  ...(navLinks === undefined ? {} : { './nav-links.messages.ts': { default: navLinks } }),
};
const noStorage = { getItem: () => null, setItem: () => {} };

const PATHS = ['/', '/train', '/commons', '/contribute', '/progress', '/video', '/settings/privacy', '/legal/privacy', '/legal/terms', '/recover'];

interface Options {
  path?: string;
  locale?: Locale;
  // Default 'visitor' matches Shell's own fail-closed default (auth-gate-spec.md §3.1).
  tier?: NavTier;
  isAdmin?: boolean;
  slots?: { header?: readonly ComponentType[]; root?: readonly ComponentType[] };
}

/** A real router (memory history) with the Shell as the root layout: the same wiring routes/__root.tsx does. */
async function renderShell({ path = '/', locale = 'en', tier, isAdmin, slots }: Options = {}) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const rootRoute = createRootRoute({
    component: () => (
      <Shell tier={tier} isAdmin={isAdmin} slots={slots}>
        <Outlet />
      </Shell>
    ),
  });
  const children = PATHS.map((routePath) =>
    createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => <p>page {routePath}</p> }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <I18nextProvider i18n={instance}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await screen.findByRole('banner');
  return { router };
}

const footer = () => within(screen.getByRole('contentinfo'));
const primaryNav = (locale: Locale = 'en') => within(screen.getByRole('navigation', { name: shellMessages[locale].nav.primary }));
const tabBar = (locale: Locale = 'en') => within(screen.getByRole('navigation', { name: shellMessages[locale].nav.tabs }));

const privacyLabel = (locale: Locale): string => navLinks?.[locale].privacySettings ?? '';
const hrefOf = (link: HTMLElement) => link.getAttribute('href');
const current = (link: HTMLElement) => link.getAttribute('aria-current');

/** True when the element can take focus from the keyboard: a real anchor with an href, no tabindex=-1, nothing hiding it. */
function keyboardReachable(link: HTMLElement): boolean {
  if (link.tagName !== 'A' || link.getAttribute('href') === null) return false;
  const tabindex = link.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  for (let node: HTMLElement | null = link; node !== null; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden') || node.hasAttribute('inert')) return false;
  }
  link.focus();
  return document.activeElement === link;
}

const isCyrillic = (text: string) => /[А-Яа-яЁёІіҢңҒғҮүҰұҚқӨөҺһӘә]/.test(text);

// --- Privacy settings -------------------------------------------------------------------------

describe('Privacy settings entry: the strings', () => {
  test('a kk, ru and en label exist, are not raw keys and never leak undefined or a placeholder', () => {
    expect(navLinks).toBeDefined();
    for (const locale of LOCALE_LIST) {
      const label = privacyLabel(locale);
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toMatch(/undefined|NaN|\{\{|privacySettings/);
    }
  });

  test('the English label is "Privacy settings"; kk and ru are Cyrillic and differ from English and from the policy link', () => {
    expect(privacyLabel('en')).toBe('Privacy settings');
    for (const locale of ['kk', 'ru'] as const) {
      const label = privacyLabel(locale);
      expect(isCyrillic(label)).toBe(true);
      expect(label).not.toBe(privacyLabel('en'));
      // The settings link must not read exactly like the privacy-policy link beside it.
      expect(label).not.toBe(shellMessages[locale].footer.privacy);
    }
    expect(privacyLabel('en')).not.toBe(shellMessages.en.footer.privacy);
  });
});

describe('Privacy settings entry: in the shell', () => {
  for (const locale of LOCALE_LIST) {
    test(`the footer links to /settings/privacy in ${locale}`, async () => {
      await renderShell({ locale });
      const link = footer().getByRole('link', { name: privacyLabel(locale) });
      expect(hrefOf(link)).toBe('/settings/privacy');
    });
  }

  test('sits beside the privacy policy and terms links without replacing them', async () => {
    await renderShell();
    const settings = footer().getByRole('link', { name: 'Privacy settings' });
    const policy = footer().getByRole('link', { name: 'Privacy' });
    const terms = footer().getByRole('link', { name: 'Terms' });
    expect(hrefOf(policy)).toBe('/legal/privacy');
    expect(hrefOf(terms)).toBe('/legal/terms');
    expect(hrefOf(settings)).toBe('/settings/privacy');
    // One landmark holds them all: the labelled "More links" navigation.
    const landmark = screen.getByRole('navigation', { name: shellMessages.en.footer.links });
    for (const link of [settings, policy, terms]) expect(landmark.contains(link)).toBe(true);
  });

  test('is shown to every visitor kind and on every page: no session, role, tier or route decides it', async () => {
    for (const tier of ['visitor', 'player', 'account'] as const) {
      for (const isAdmin of [undefined, false, true]) {
        for (const path of ['/', '/train', '/commons', '/legal/terms', '/settings/privacy', '/video']) {
          await renderShell({ tier, isAdmin, path });
          const link = footer().getByRole('link', { name: 'Privacy settings' });
          expect(hrefOf(link)).toBe('/settings/privacy');
          cleanup();
        }
      }
    }
  });

  test('follows the active language (no English label left behind in ru)', async () => {
    await renderShell({ locale: 'ru' });
    expect(footer().queryByRole('link', { name: 'Privacy settings' }) === null).toBe(true);
    expect(hrefOf(footer().getByRole('link', { name: privacyLabel('ru') }))).toBe('/settings/privacy');
  });

  test('is a real link that a keyboard reaches, in every language', async () => {
    for (const locale of LOCALE_LIST) {
      await renderShell({ locale });
      const link = footer().getByRole('link', { name: privacyLabel(locale) });
      expect(keyboardReachable(link)).toBe(true);
      cleanup();
    }
  });

  test('is one of the links in the tab order after the skip link, in document order with the other footer links', async () => {
    await renderShell();
    const links = [...document.querySelectorAll('a[href]')] as HTMLElement[];
    const settings = footer().getByRole('link', { name: 'Privacy settings' });
    expect(links.indexOf(settings)).toBeGreaterThan(0);
    expect(links[0]?.getAttribute('href')).toBe('#main-content');
  });

  test('is at least 44px tall (min-h-tap) and keeps the visible focus ring', async () => {
    await renderShell();
    const link = footer().getByRole('link', { name: 'Privacy settings' });
    expect(link.className).toContain('min-h-tap');
    expect(link.className).not.toMatch(/outline-none|focus:outline-0|focus-visible:outline-none/);
  });

  test('marks itself with aria-current="page" on /settings/privacy, and only there', async () => {
    await renderShell({ path: '/settings/privacy' });
    expect(current(footer().getByRole('link', { name: 'Privacy settings' }))).toBe('page');
    // The privacy-policy and terms links are different pages and are not marked.
    expect(current(footer().getByRole('link', { name: 'Privacy' }))).toBeNull();
    expect(current(footer().getByRole('link', { name: 'Terms' }))).toBeNull();
    cleanup();
    for (const path of ['/', '/legal/privacy', '/train']) {
      await renderShell({ path });
      expect(current(footer().getByRole('link', { name: 'Privacy settings' }))).toBeNull();
      cleanup();
    }
  });

  test('the policy link is the current one on /legal/privacy, not the settings link', async () => {
    await renderShell({ path: '/legal/privacy' });
    expect(current(footer().getByRole('link', { name: 'Privacy' }))).toBe('page');
    expect(current(footer().getByRole('link', { name: 'Privacy settings' }))).toBeNull();
  });

  test('activating it navigates to the privacy settings page and then marks it current', async () => {
    await renderShell({ path: '/train' });
    fireEvent.click(footer().getByRole('link', { name: 'Privacy settings' }));
    await screen.findByText('page /settings/privacy');
    expect(current(footer().getByRole('link', { name: 'Privacy settings' }))).toBe('page');
  });

  test('is not a primary navigation item: it is in neither navigation and Train is still the first destination', async () => {
    // account tier: Train is only the first destination for a tier that shows it (auth-gate-spec.md §3.2).
    await renderShell({ tier: 'account' });
    expect(primaryNav().queryByRole('link', { name: 'Privacy settings' }) === null).toBe(true);
    expect(tabBar().queryByRole('link', { name: 'Privacy settings' }) === null).toBe(true);
    expect(hrefOf(primaryNav().getAllByRole('link')[0]!)).toBe('/train');
  });
});

// --- Video Coach · Beta -----------------------------------------------------------------------

// auth-gate-spec.md §3.2: an anonymous player does not get a Contribute tab, but keeps Video Coach · Beta (a session,
// any session, is enough to see the video entry — only a visitor with none does not).
const HAS_VIDEO_TIERS = ['player', 'account'] as const;

describe('Video Coach · Beta entry (tier-aware: present for player and account, absent for visitor)', () => {
  for (const locale of LOCALE_LIST) {
    test(`is in the primary navigation and the tab bar for player and account, labelled in ${locale}, pointing at /video`, async () => {
      for (const tier of HAS_VIDEO_TIERS) {
        await renderShell({ locale, tier });
        const label = shellMessages[locale].nav.video;
        expect(label).toMatch(/·\s*(Beta|Бета)$/);
        expect(hrefOf(primaryNav(locale).getByRole('link', { name: label }))).toBe('/video');
        expect(hrefOf(tabBar(locale).getByRole('link', { name: label }))).toBe('/video');
        cleanup();
      }
    });

    test(`is absent for a visitor in ${locale} (no session, no Video)`, async () => {
      await renderShell({ locale, tier: 'visitor' });
      const label = shellMessages[locale].nav.video;
      expect(primaryNav(locale).queryByRole('link', { name: label })).toBeNull();
      expect(tabBar(locale).queryByRole('link', { name: label })).toBeNull();
    });
  }

  test('reads "Video Coach · Beta" in English', async () => {
    await renderShell({ tier: 'account' });
    expect(hrefOf(primaryNav().getByRole('link', { name: 'Video Coach · Beta' }))).toBe('/video');
  });

  test('is a real link that a keyboard reaches, in both navigations, for player and account', async () => {
    for (const tier of HAS_VIDEO_TIERS) {
      await renderShell({ tier });
      expect(keyboardReachable(primaryNav().getByRole('link', { name: 'Video Coach · Beta' }))).toBe(true);
      expect(keyboardReachable(tabBar().getByRole('link', { name: 'Video Coach · Beta' }))).toBe(true);
      cleanup();
    }
  });

  test('carries aria-current="page" on /video for player and account, and not on the other pages', async () => {
    for (const tier of HAS_VIDEO_TIERS) {
      await renderShell({ path: '/video', tier });
      expect(current(primaryNav().getByRole('link', { name: 'Video Coach · Beta' }))).toBe('page');
      expect(current(tabBar().getByRole('link', { name: 'Video Coach · Beta' }))).toBe('page');
      cleanup();
      await renderShell({ path: '/train', tier });
      expect(current(primaryNav().getByRole('link', { name: 'Video Coach · Beta' }))).toBeNull();
      expect(current(tabBar().getByRole('link', { name: 'Video Coach · Beta' }))).toBeNull();
      cleanup();
    }
  });

  test('never comes before or in place of training: Train is first and the video entry last in both navigations, for player and account', async () => {
    for (const tier of HAS_VIDEO_TIERS) {
      await renderShell({ tier });
      for (const nav of [primaryNav(), tabBar()]) {
        const links = nav.getAllByRole('link');
        expect(hrefOf(links[0]!)).toBe('/train');
        expect(hrefOf(links.at(-1)!)).toBe('/video');
      }
      cleanup();
    }
  });

  test('never blocks training: from the video page the Train link is enabled and still navigates to /train', async () => {
    await renderShell({ path: '/video', tier: 'account' });
    const train = primaryNav().getByRole('link', { name: 'Train' });
    expect(train.getAttribute('aria-disabled')).toBeNull();
    expect(current(train)).toBeNull();
    await act(async () => {
      fireEvent.click(train);
    });
    await screen.findByText('page /train');
    expect(current(primaryNav().getByRole('link', { name: 'Train' }))).toBe('page');
  });
});
