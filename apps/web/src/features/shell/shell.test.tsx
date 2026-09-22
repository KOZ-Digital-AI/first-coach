import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import LanguageSwitch from '../i18n/header-extra';
import i18nMessages from '../i18n/i18n.messages';
import { isAdminSession, Shell, type NavTier } from './Shell';
import shellMessages from './shell.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/legal/privacy.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

// Web test hygiene (fc-zfg.9): this file renders many describe blocks with dozens of getBy*/findBy* queries, which
// leaves unbounded entries in happy-dom's internal query caches and can slow down or time out LATER test files that
// share the same happy-dom window. Copied from the working pattern in features/contribute/form.test.tsx's last
// afterEach: invalidate then empty happy-dom's affectsCache/affectsComputedStyleCache/querySelectorCache symbols,
// written against happy-dom 20.x symbols by description (does nothing if they are not there).
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

const modules = {
  './shell.messages.ts': { default: shellMessages },
  '../i18n/i18n.messages.ts': { default: i18nMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** Paths the fake app knows. Nested and dynamic ones prove that an active section stays active on its sub-pages. */
const PATHS = [
  '/',
  '/train',
  '/train/drill/$id',
  '/commons',
  '/commons/$id',
  '/contribute',
  '/progress',
  '/video',
  '/admin',
  '/recover',
  '/legal/terms',
  '/legal/privacy',
];

interface Options {
  path?: string;
  locale?: Locale;
  // Default 'visitor' matches Shell's own fail-closed default (auth-gate-spec.md §3.1): a test that does not care
  // about the nav must say so explicitly once tier-aware content is involved.
  tier?: NavTier;
  isAdmin?: boolean;
  version?: string;
  slots?: { header?: readonly ComponentType[]; root?: readonly ComponentType[] };
}

/** A real router (memory history) with the Shell as the root layout: the same wiring routes/__root.tsx does. */
async function renderShell({ path = '/', locale = 'en', tier, isAdmin, version, slots }: Options = {}) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const rootRoute = createRootRoute({
    component: () => (
      <Shell tier={tier} isAdmin={isAdmin} version={version} slots={slots}>
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
  return { instance, router };
}

const NAV_HREFS = {
  train: '/train',
  commons: '/commons',
  contribute: '/contribute',
  progress: '/progress',
  video: '/video',
} as const;
const NAV_KEYS = Object.keys(NAV_HREFS) as (keyof typeof NAV_HREFS)[];

const primaryNav = (locale: Locale = 'en') =>
  within(screen.getByRole('navigation', { name: shellMessages[locale].nav.primary }));
const tabBar = (locale: Locale = 'en') => within(screen.getByRole('navigation', { name: shellMessages[locale].nav.tabs }));

// --- brand ------------------------------------------------------------------------------------

describe('brand mark', () => {
  for (const locale of ['kk', 'ru', 'en'] as const) {
    test(`reads FIRST COACH / БІРІНШІ БАПКЕР and links home in ${locale}`, async () => {
      await renderShell({ locale, path: '/commons' });
      const brand = within(screen.getByRole('banner')).getByRole('link', { name: /FIRST COACH\s*\/\s*БІРІНШІ БАПКЕР/ });
      expect(brand.getAttribute('href')).toBe('/');
    });
  }
});

// --- navigation -------------------------------------------------------------------------------

// auth-gate-spec.md §3.2: the START_HREF a visitor's primary action carries — built the same way Shell.tsx builds it
// (signInUrl('/train')), so a change to that helper's encoding breaks this constant too, not silently drifts from it.
const START_HREF = '/account/sign-in?redirect=%2Ftrain';

describe('primary navigation', () => {
  // Replaces the old tier-agnostic "lists Train, Open Commons, Contribute, Progress and Video Coach · Beta" test: Shell
  // is tier-aware now (auth-gate-spec.md §3.2), so "what the primary nav lists" is three different, true answers.
  test('visitor: Open Commons and Start only — no Train, Progress, Contribute or Video', async () => {
    await renderShell({ tier: 'visitor' });
    const links = primaryNav().getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Open Commons', 'Start']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/commons', START_HREF]);
  });

  test('anonymous player: Train, Open Commons, Progress and Video Coach · Beta, in that order', async () => {
    await renderShell({ tier: 'player' });
    const links = primaryNav().getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Train', 'Open Commons', 'Progress', 'Video Coach · Beta']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/train', '/commons', '/progress', '/video']);
  });

  test('coach account: all five destinations, in today\'s order', async () => {
    await renderShell({ tier: 'account' });
    const links = primaryNav().getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Train',
      'Open Commons',
      'Contribute',
      'Progress',
      'Video Coach · Beta',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(NAV_KEYS.map((key) => NAV_HREFS[key]));
  });

  for (const locale of ['kk', 'ru'] as const) {
    test(`renders the account-tier items in the active language (${locale}), not English`, async () => {
      await renderShell({ locale, tier: 'account' });
      const nav = primaryNav(locale);
      for (const key of NAV_KEYS) {
        const label = shellMessages[locale].nav[key];
        expect(nav.getByRole('link', { name: label }).getAttribute('href')).toBe(NAV_HREFS[key]);
      }
      // Proof it is really the other language: these three differ from English.
      for (const key of ['train', 'contribute', 'video'] as const) {
        expect(shellMessages[locale].nav[key]).not.toBe(shellMessages.en.nav[key]);
      }
      expect(nav.queryByRole('link', { name: 'Train' })).toBeNull();
    });
  }

  test('the Beta marker is written words in every language, not only a tint', async () => {
    for (const locale of ['kk', 'ru', 'en'] as const) {
      await renderShell({ locale, tier: 'account' });
      const label = primaryNav(locale).getAllByRole('link').at(-1)?.textContent ?? '';
      expect(label).toMatch(/·\s*(Beta|Бета)$/);
      cleanup();
    }
  });

  test('re-labels when the language is switched through the header slot', async () => {
    await renderShell({ tier: 'account', slots: { header: [LanguageSwitch] } });
    expect(primaryNav().getByRole('link', { name: 'Train' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Русский' }));
    expect(await primaryNav('ru').findByRole('link', { name: shellMessages.ru.nav.train })).toBeTruthy();
    expect(primaryNav('ru').queryByRole('link', { name: 'Train' })).toBeNull();
  });

  test('the Start item links to /account/sign-in?redirect=%2Ftrain', async () => {
    await renderShell({ tier: 'visitor' });
    const start = primaryNav().getByRole('link', { name: 'Start' });
    expect(start.getAttribute('href')).toBe(START_HREF);
    // It is also an ordinary tab in the bottom tab bar (§3.2: "a tab bar that stays one shape"), with the same target.
    expect(tabBar().getByRole('link', { name: 'Start' }).getAttribute('href')).toBe(START_HREF);
  });

  test('the language switch is rendered at every tier (DESIGN.md: never hidden)', async () => {
    for (const tier of ['visitor', 'player', 'account'] as const) {
      await renderShell({ tier, slots: { header: [LanguageSwitch] } });
      expect(within(screen.getByRole('banner')).getByRole('group', { name: 'Language' })).toBeTruthy();
      cleanup();
    }
  });
});

describe('bottom tab bar', () => {
  // Replaces the old tier-agnostic "carries the same five destinations" test: the tab bar mirrors whatever the
  // primary navigation lists at that tier (auth-gate-spec.md §3.2 "the bottom tab bar carries the same destinations
  // as the primary navigation, at every tier"), not a fixed five.
  test('carries the same destinations as the primary navigation, at every tier', async () => {
    for (const tier of ['visitor', 'player', 'account'] as const) {
      await renderShell({ tier });
      const bar = tabBar();
      const nav = primaryNav();
      expect(bar.getAllByRole('link').map((link) => link.textContent)).toEqual(
        nav.getAllByRole('link').map((link) => link.textContent),
      );
      expect(bar.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
        nav.getAllByRole('link').map((link) => link.getAttribute('href')),
      );
      cleanup();
    }
  });

  test('lays out its real number of tabs (2 visitor, 4 player, 5 account), not a hard-coded five', async () => {
    const counts: Record<NavTier, number> = { visitor: 2, player: 4, account: 5 };
    for (const [tier, count] of Object.entries(counts) as [NavTier, number][]) {
      await renderShell({ tier });
      const bar = screen.getByRole('navigation', { name: shellMessages.en.nav.tabs });
      expect(within(bar).getAllByRole('link')).toHaveLength(count);
      expect(bar.querySelector('ul')?.className).toContain(`grid-cols-${count}`);
      cleanup();
    }
  });

  // fc-zfg.9: the breakpoint moved from 900px to 1220px (see Shell.tsx's comment on the nav element for the measured
  // widths behind the number - the header row's extras slot did not fit at 900px once the primary nav also showed).
  // Kept in lockstep, as the report's mutation table checks: the tab bar's own hidden-from breakpoint must always
  // equal the nav's own shown-from breakpoint, or there would be a width band with neither navigation visible.
  test('replaces the top navigation under 1220px: tab bar hidden from 1220px up, top navigation hidden below it', async () => {
    await renderShell();
    const bar = screen.getByRole('navigation', { name: shellMessages.en.nav.tabs });
    const top = screen.getByRole('navigation', { name: shellMessages.en.nav.primary });
    expect(bar.className).toContain('min-[1220px]:hidden');
    expect(top.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(top.className).toContain('min-[1220px]:flex');
    expect(bar.className).not.toContain('min-[900px]:hidden');
    expect(top.className).not.toContain('min-[900px]:flex');
  });

  test('is a distinct landmark from the top navigation and sits outside the sticky header', async () => {
    await renderShell();
    const bar = screen.getByRole('navigation', { name: shellMessages.en.nav.tabs });
    expect(within(screen.getByRole('banner')).queryByRole('navigation', { name: shellMessages.en.nav.tabs })).toBeNull();
    expect(bar.getAttribute('aria-label')).not.toBe(screen.getByRole('navigation', { name: shellMessages.en.nav.primary }).getAttribute('aria-label'));
  });
});

// --- desktop header row never wraps (fc-zfg.9) -------------------------------------------------
//
// Two user screenshots (desktop widths >=900px) showed the header-extra slot (sign-in + language switch) dropping
// onto a second row in ru/kk, and the primary nav links wrapping inside themselves in en ("Open Commons" on two
// lines, "Video Coach · Beta" on three). happy-dom does no layout, so these tests assert the provable CSS properties
// behind the fix (nowrap on the text that must not wrap internally, and the no-wrap rule on the row that holds it),
// not actual pixel positions; the single-row proof at real widths is done once in a real browser (see the report).

describe('desktop header row never wraps (fc-zfg.9)', () => {
  test('every primary navigation link carries whitespace-nowrap, so its own label can never wrap onto two lines', async () => {
    await renderShell();
    for (const link of primaryNav().getAllByRole('link')) expect(link.className).toContain('whitespace-nowrap');
  });

  test('the header row itself never wraps onto a second line from 900px up (min-[900px]:flex-nowrap)', async () => {
    await renderShell();
    const row = screen.getByRole('banner').firstElementChild as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.className).toContain('flex-nowrap');
    expect(row.className).toContain('min-[900px]:flex-nowrap');
  });

  test('the header-extra slot (sign-in + language switch) never wraps onto a second line from 900px up either', async () => {
    await renderShell({ slots: { header: [LanguageSwitch] } });
    const slot = document.querySelector('[data-slot="header"]');
    expect(slot).toBeTruthy();
    expect(slot?.className).toContain('min-[900px]:flex-nowrap');
  });

  // Source-inspection (same technique as lib/i18n.test.ts's "i18n.ts imports primitives type-only" test): the sign-in
  // link is a component of the account feature (not owned by this test file, so it is not rendered here - rendering
  // AccountControls needs a QueryClientProvider and a session it does not have in this suite), but the class list
  // that must carry whitespace-nowrap is still literal, readable source.
  test('the "Coach sign-in" link (features/account/header-extra.tsx) carries whitespace-nowrap', () => {
    const source = readFileSync(join(import.meta.dir, '../account/header-extra.tsx'), 'utf8');
    const match = source.match(/const VISITOR_LINK =\s*\n?\s*'([^']*)'/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('whitespace-nowrap');
  });
});

// --- admin ------------------------------------------------------------------------------------

describe('admin link', () => {
  test('is absent for a non-admin', async () => {
    await renderShell({ isAdmin: false });
    expect(screen.queryByRole('link', { name: /admin/i })).toBeNull();
    expect(document.querySelector('a[href="/admin"]')).toBeNull();
  });

  test('is absent when nothing is said about the role (default)', async () => {
    await renderShell();
    expect(document.querySelector('a[href="/admin"]')).toBeNull();
  });

  test('is present for an admin, in the header, pointing to /admin', async () => {
    await renderShell({ isAdmin: true });
    const link = within(screen.getByRole('banner')).getByRole('link', { name: 'Admin' });
    expect(link.getAttribute('href')).toBe('/admin');
  });

  test('is labelled in the active language', async () => {
    await renderShell({ isAdmin: true, locale: 'ru' });
    const link = within(screen.getByRole('banner')).getByRole('link', { name: shellMessages.ru.admin });
    expect(link.getAttribute('href')).toBe('/admin');
    expect(shellMessages.ru.admin).not.toBe('Admin');
  });

  test('still needs an admin account, at every tier: tier alone never shows or hides it', async () => {
    for (const tier of ['visitor', 'player', 'account'] as const) {
      await renderShell({ tier, isAdmin: false });
      expect(document.querySelector('a[href="/admin"]')).toBeNull();
      cleanup();
      await renderShell({ tier, isAdmin: true });
      expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Admin' })).toBeTruthy();
      cleanup();
    }
  });
});

describe('isAdminSession (same rule as the API guard requireAdmin)', () => {
  test('true for a non-anonymous user whose role list contains admin', () => {
    expect(isAdminSession({ user: { role: 'admin', isAnonymous: false } })).toBe(true);
    expect(isAdminSession({ user: { role: 'contributor,admin', isAnonymous: false } })).toBe(true);
  });

  test('false for contributors, unknown roles and near-misses', () => {
    expect(isAdminSession({ user: { role: 'contributor', isAnonymous: false } })).toBe(false);
    expect(isAdminSession({ user: { role: 'superadmin', isAnonymous: false } })).toBe(false);
    expect(isAdminSession({ user: { role: 'Admin', isAnonymous: false } })).toBe(false);
    expect(isAdminSession({ user: { role: '', isAnonymous: false } })).toBe(false);
  });

  test('false unless the account is explicitly non-anonymous, even when it carries the admin role string', () => {
    expect(isAdminSession({ user: { role: 'admin', isAnonymous: true } })).toBe(false);
    expect(isAdminSession({ user: { role: 'admin', isAnonymous: null } })).toBe(false);
    expect(isAdminSession({ user: { role: 'admin' } })).toBe(false);
  });

  test('false for no session and for unintelligible data', () => {
    expect(isAdminSession(null)).toBe(false);
    expect(isAdminSession(undefined)).toBe(false);
    expect(isAdminSession({})).toBe(false);
    expect(isAdminSession({ user: null })).toBe(false);
    expect(isAdminSession({ user: { isAnonymous: false } })).toBe(false);
    expect(isAdminSession('admin')).toBe(false);
  });
});

// --- slots ------------------------------------------------------------------------------------

describe('slots', () => {
  const HeaderOne = () => <p>header one</p>;
  const HeaderTwo = () => <p>header two</p>;
  const RootOne = () => <p>root one</p>;
  const RootTwo = () => <p>root two</p>;

  test('header slot components render inside the header, in the given order', async () => {
    await renderShell({ slots: { header: [HeaderOne, HeaderTwo] } });
    const header = within(screen.getByRole('banner'));
    const texts = header.getAllByText(/^header (one|two)$/).map((node) => node.textContent);
    expect(texts).toEqual(['header one', 'header two']);
    expect(within(screen.getByRole('contentinfo')).queryByText('header one')).toBeNull();
  });

  test('root slot components render outside the header and the page content, in the given order', async () => {
    await renderShell({ slots: { root: [RootOne, RootTwo] } });
    const nodes = screen.getAllByText(/^root (one|two)$/);
    expect(nodes.map((node) => node.textContent)).toEqual(['root one', 'root two']);
    for (const node of nodes) {
      expect(screen.getByRole('banner').contains(node)).toBe(false);
      expect(document.getElementById('main-content')?.contains(node)).toBe(false);
    }
  });

  test('both slots keep working together with the page content', async () => {
    await renderShell({ path: '/train', slots: { header: [HeaderOne], root: [RootOne] } });
    expect(screen.getByText('header one')).toBeTruthy();
    expect(screen.getByText('root one')).toBeTruthy();
    expect(screen.getByText('page /train')).toBeTruthy();
  });

  test('empty slots add no slot regions', async () => {
    await renderShell({ slots: { header: [], root: [] } });
    expect(document.querySelector('[data-slot="header"]')).toBeNull();
    expect(document.querySelector('[data-slot="root"]')).toBeNull();
  });

  test('slots that are not passed default to the glob-collected ones (none under bun) and do not crash', async () => {
    await renderShell();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(document.querySelector('[data-slot="header"]')).toBeNull();
  });
});

// --- active route -----------------------------------------------------------------------------

describe('active route', () => {
  const activeLabels = (nav: ReturnType<typeof primaryNav>) =>
    nav
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);

  test('marks exactly the current section in both navigations with aria-current', async () => {
    await renderShell({ path: '/commons' });
    expect(activeLabels(primaryNav())).toEqual(['Open Commons']);
    expect(activeLabels(tabBar())).toEqual(['Open Commons']);
  });

  test('a sub-page keeps its section active', async () => {
    await renderShell({ path: '/train/drill/42', tier: 'account' });
    expect(activeLabels(primaryNav())).toEqual(['Train']);
    expect(activeLabels(tabBar())).toEqual(['Train']);
  });

  test('a page outside the navigation marks nothing active', async () => {
    await renderShell({ path: '/legal/terms' });
    expect(activeLabels(primaryNav())).toEqual([]);
    expect(activeLabels(tabBar())).toEqual([]);
  });

  test('home marks nothing active', async () => {
    await renderShell({ path: '/' });
    expect(activeLabels(primaryNav())).toEqual([]);
  });

  test('is shown by a shape as well as by colour: only the active item carries an indicator element', async () => {
    await renderShell({ path: '/progress', tier: 'account' });
    for (const nav of [primaryNav(), tabBar()]) {
      const marked = nav
        .getAllByRole('link')
        .filter((link) => link.querySelector('[data-active-indicator]') !== null)
        .map((link) => link.textContent);
      expect(marked).toEqual(['Progress']);
    }
  });

  test('the indicator follows the route when it changes', async () => {
    const { router } = await renderShell({ path: '/train', tier: 'account' });
    expect(activeLabels(primaryNav())).toEqual(['Train']);
    await act(async () => {
      await router.navigate({ to: '/video' as never });
    });
    await screen.findByText('page /video');
    expect(activeLabels(primaryNav())).toEqual(['Video Coach · Beta']);
    expect(activeLabels(tabBar())).toEqual(['Video Coach · Beta']);
  });
});

// --- skip link and content --------------------------------------------------------------------

describe('skip link and content', () => {
  test('the skip link is the first link in the document and points at the content region', async () => {
    await renderShell();
    const first = document.querySelector('a');
    expect(first?.textContent).toBe('Skip to content');
    expect(first?.getAttribute('href')).toBe('#main-content');
    const target = document.getElementById('main-content');
    expect(target).not.toBeNull();
    expect(target?.getAttribute('tabindex')).toBe('-1');
  });

  test('the skip link text follows the active language', async () => {
    await renderShell({ locale: 'ru' });
    expect(document.querySelector('a')?.textContent).toBe(shellMessages.ru.skip);
    expect(shellMessages.ru.skip).not.toBe('Skip to content');
  });

  test('activating the skip link moves focus to the content region', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  test('the routed page renders inside the content region, which sits between the header and the footer', async () => {
    await renderShell({ path: '/commons' });
    const content = document.getElementById('main-content') as HTMLElement;
    expect(within(content).getByText('page /commons')).toBeTruthy();
    const header = screen.getByRole('banner');
    const footer = screen.getByRole('contentinfo');
    expect(header.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(content.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the shell adds no <main> of its own (pages own theirs, so there is never a nested one)', async () => {
    await renderShell();
    expect(document.querySelector('main')).toBeNull();
  });
});

// --- footer -----------------------------------------------------------------------------------

describe('footer', () => {
  test('carries the mission line, the licences and the credit in English', async () => {
    await renderShell();
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByText('Open human skill development infrastructure.')).toBeTruthy();
    expect(footer.getByText('Software: MIT · Knowledge: CC BY-SA 4.0')).toBeTruthy();
    expect(footer.getByText('Created by KOZ AI · Genesis release')).toBeTruthy();
  });

  test('links to Privacy, Terms and Restore my progress', async () => {
    await renderShell();
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/legal/privacy');
    expect(footer.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/legal/terms');
    expect(footer.getByRole('link', { name: 'Restore my progress' }).getAttribute('href')).toBe('/recover');
  });

  test('is translated (ru): lines and links follow the active language', async () => {
    await renderShell({ locale: 'ru' });
    const footer = within(screen.getByRole('contentinfo'));
    const m = shellMessages.ru.footer;
    expect(footer.getByText(m.tagline)).toBeTruthy();
    expect(footer.getByText(m.licences)).toBeTruthy();
    expect(footer.getByText(m.credit)).toBeTruthy();
    expect(footer.getByRole('link', { name: m.privacy }).getAttribute('href')).toBe('/legal/privacy');
    expect(footer.getByRole('link', { name: m.terms }).getAttribute('href')).toBe('/legal/terms');
    expect(footer.getByRole('link', { name: m.restore }).getAttribute('href')).toBe('/recover');
    expect(footer.queryByText('Open human skill development infrastructure.')).toBeNull();
  });

  test('shows the build version it is given', async () => {
    await renderShell({ version: '2026.09.21-abc1234' });
    expect(within(screen.getByRole('contentinfo')).getByText(/2026\.09\.21-abc1234/)).toBeTruthy();
  });

  test('says nothing about a version it does not have (never "undefined")', async () => {
    await renderShell();
    const text = screen.getByRole('contentinfo').textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/version|build/i);
  });
});

// --- design rules -----------------------------------------------------------------------------

describe('design rules', () => {
  test('has no theme switch: light theme only', async () => {
    await renderShell({ isAdmin: true });
    const controls = [...document.querySelectorAll('button, [role="switch"], [role="checkbox"], select')];
    for (const control of controls) {
      const label = `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''}`;
      expect(label).not.toMatch(/theme|dark|light|тема|тёмн|темн|түн|қараңғы/i);
    }
  });

  test('every link in the header, tab bar and footer is at least 44px tall (min-h-tap)', async () => {
    await renderShell({ isAdmin: true });
    for (const region of [
      screen.getByRole('banner'),
      screen.getByRole('navigation', { name: shellMessages.en.nav.tabs }),
      screen.getByRole('contentinfo'),
    ]) {
      const links = within(region).getAllByRole('link');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.className).toContain('min-h-tap');
    }
  });

  test('keeps the visible focus ring: no link or nav removes the outline', async () => {
    await renderShell({ isAdmin: true });
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).not.toMatch(/outline-none|focus:outline-0|focus-visible:outline-none/);
    }
  });

  test('the header is sticky with the blurred paper treatment', async () => {
    await renderShell();
    const className = screen.getByRole('banner').className;
    expect(className).toContain('sticky');
    expect(className).toContain('top-0');
    expect(className).toMatch(/backdrop-blur/);
  });
});
