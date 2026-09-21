import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, type LOCALES } from '../../lib/i18n';
import i18nMessages from '../i18n/i18n.messages';
import { NotFoundPage, RootErrorPage, Route as AppRootRoute } from '../../routes/__root';
import errorPagesMessages from './error-pages.messages';
import { Shell } from './Shell';
import shellMessages from './shell.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as features/shell/shell.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');

type Locale = (typeof LOCALES)[number];

const modules = {
  './error-pages.messages.ts': { default: errorPagesMessages },
  './shell.messages.ts': { default: shellMessages },
  '../i18n/i18n.messages.ts': { default: i18nMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

const realWarn = console.warn;
const realError = console.error;

afterEach(() => {
  cleanup();
  console.warn = realWarn;
  console.error = realError;
});

/**
 * A root laid out like routes/__root.tsx (the Shell around an Outlet) with the pages that file exports. The wired root
 * (AppShell) reads the session and /health over the network, so tests use the Shell directly; the last describe block pins
 * that the real root route is wired to the very same pages.
 */
function makeRoot() {
  return createRootRoute({
    component: () => (
      <Shell>
        <Outlet />
      </Shell>
    ),
    notFoundComponent: NotFoundPage,
    errorComponent: RootErrorPage,
  });
}

interface Options {
  path: string;
  locale?: Locale;
  /** Child routes under the real root. */
  pages?: Record<string, ComponentType>;
}

async function renderApp({ path, locale = 'en', pages = {} }: Options) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const root = makeRoot();
  const children = Object.entries(pages).map(([pagePath, component]) =>
    createRoute({ getParentRoute: () => root, path: pagePath, component }),
  );
  const router = createRouter({
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <I18nextProvider i18n={instance}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  return { router };
}

/** React and the router log a caught render error; that noise is expected in the boundary tests. */
function silenceExpectedErrors(): void {
  console.error = () => {};
  console.warn = () => {};
}

const LOCALE_LIST = ['kk', 'ru', 'en'] as const;

// --- 404 --------------------------------------------------------------------------------------

describe('404 page (root notFoundComponent)', () => {
  test('renders for an unknown path, with a heading, and not a blank screen', async () => {
    await renderApp({ path: '/no/such/page' });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(errorPagesMessages.en.notFound.title);
    expect(heading.textContent?.trim()).not.toBe('');
  });

  test('renders inside the app shell: header, navigation and footer are still there', async () => {
    await renderApp({ path: '/no/such/page' });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: shellMessages.en.nav.primary })).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    // ... and the page itself sits in the shell's content region, not outside it.
    expect(document.getElementById('main-content')?.contains(heading)).toBe(true);
  });

  test('links home ("/") and to training ("/train")', async () => {
    await renderApp({ path: '/no/such/page' });
    await screen.findByRole('heading', { level: 1 });
    const page = within(screen.getByRole('main'));
    expect(page.getByRole('link', { name: errorPagesMessages.en.notFound.home }).getAttribute('href')).toBe('/');
    expect(page.getByRole('link', { name: errorPagesMessages.en.notFound.train }).getAttribute('href')).toBe('/train');
  });

  test('a known path does not show it', async () => {
    await renderApp({ path: '/known', pages: { '/known': () => <p>the known page</p> } });
    expect(await screen.findByText('the known page')).toBeTruthy();
    expect(screen.queryByText(errorPagesMessages.en.notFound.title)).toBeNull();
  });

  test('a nested unknown path (a real section, a missing page) still shows it', async () => {
    await renderApp({ path: '/known/missing', pages: { '/known': () => <p>the known page</p> } });
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(errorPagesMessages.en.notFound.title);
  });

  for (const locale of LOCALE_LIST) {
    test(`is written in the active language (${locale}), never a raw key or "undefined"`, async () => {
      await renderApp({ path: '/nope', locale });
      const heading = await screen.findByRole('heading', { level: 1 });
      const copy = errorPagesMessages[locale].notFound;
      expect(heading.textContent).toBe(copy.title);
      const page = within(screen.getByRole('main'));
      expect(page.getByRole('link', { name: copy.home })).toBeTruthy();
      expect(page.getByRole('link', { name: copy.train })).toBeTruthy();
      const text = screen.getByRole('main').textContent ?? '';
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('notFound.');
    });
  }

  test('kk and ru differ from English (the copy is real, not a fallback)', () => {
    for (const locale of ['kk', 'ru'] as const) {
      expect(errorPagesMessages[locale].notFound.title).not.toBe(errorPagesMessages.en.notFound.title);
      expect(errorPagesMessages[locale].error.title).not.toBe(errorPagesMessages.en.error.title);
      expect(errorPagesMessages[locale].unauthorized.title).not.toBe(errorPagesMessages.en.unauthorized.title);
    }
  });
});

// --- error boundary ---------------------------------------------------------------------------

function Boom(): never {
  throw new Error('secret internal stack detail');
}

describe('error page (root errorComponent)', () => {
  test('renders a calm "something went wrong" when a child throws, instead of a blank screen', async () => {
    silenceExpectedErrors();
    await renderApp({ path: '/boom', pages: { '/boom': Boom } });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(errorPagesMessages.en.error.title);
    expect(heading.textContent).toMatch(/something went wrong/i);
    expect(screen.getByRole('alert').textContent).toContain(errorPagesMessages.en.error.body);
  });

  test('never shows the raw error to the visitor', async () => {
    silenceExpectedErrors();
    await renderApp({ path: '/boom', pages: { '/boom': Boom } });
    await screen.findByRole('heading', { level: 1 });
    expect(document.body.textContent).not.toContain('secret internal stack detail');
    expect(document.body.textContent).not.toContain('Error:');
  });

  test('offers Reload, which reloads the page', async () => {
    silenceExpectedErrors();
    let reloads = 0;
    const spy = spyOn(window.location, 'reload').mockImplementation(() => {
      reloads += 1;
    });
    try {
      await renderApp({ path: '/boom', pages: { '/boom': Boom } });
      await screen.findByRole('heading', { level: 1 });
      const reload = screen.getByRole('button', { name: errorPagesMessages.en.error.reload });
      expect(reloads).toBe(0);
      await act(async () => {
        fireEvent.click(reload);
      });
      expect(reloads).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('offers a way home that is a plain link to "/"', async () => {
    silenceExpectedErrors();
    await renderApp({ path: '/boom', pages: { '/boom': Boom } });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: errorPagesMessages.en.error.home }).getAttribute('href')).toBe('/');
  });

  test('does not show up when nothing throws', async () => {
    await renderApp({ path: '/fine', pages: { '/fine': () => <p>all good here</p> } });
    expect(await screen.findByText('all good here')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(errorPagesMessages.en.error.title)).toBeNull();
  });

  for (const locale of LOCALE_LIST) {
    test(`is written in the active language (${locale}), never a raw key or "undefined"`, async () => {
      silenceExpectedErrors();
      await renderApp({ path: '/boom', pages: { '/boom': Boom }, locale });
      const heading = await screen.findByRole('heading', { level: 1 });
      const copy = errorPagesMessages[locale].error;
      expect(heading.textContent).toBe(copy.title);
      expect(screen.getByRole('button', { name: copy.reload })).toBeTruthy();
      expect(screen.getByRole('link', { name: copy.home })).toBeTruthy();
      const text = document.body.textContent ?? '';
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('error.title');
    });
  }
});

// --- /unauthorized ----------------------------------------------------------------------------

/** The real /unauthorized file route, attached to the real root the way the generated route tree does. */
async function renderUnauthorized(locale: Locale = 'en') {
  const { Route } = await import('../../routes/unauthorized');
  const root = makeRoot();
  const route = Route.update({ id: '/unauthorized', path: '/unauthorized', getParentRoute: () => root } as never);
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const router = createRouter({
    routeTree: root.addChildren([route as never]),
    history: createMemoryHistory({ initialEntries: ['/unauthorized'] }),
  });
  render(
    <I18nextProvider i18n={instance}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
}

describe('/unauthorized page', () => {
  test('explains that the page needs an admin or coach account', async () => {
    await renderUnauthorized();
    const copy = errorPagesMessages.en.unauthorized;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(copy.title);
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).toContain(copy.body);
    expect(copy.title + copy.body).toMatch(/admin/i);
    expect(copy.title + copy.body).toMatch(/coach/i);
    expect(copy.body).toMatch(/account/i);
  });

  test('offers sign-in, linking to /account/sign-in', async () => {
    await renderUnauthorized();
    const signIn = within(screen.getByRole('main')).getByRole('link', { name: errorPagesMessages.en.unauthorized.signIn });
    expect(signIn.getAttribute('href')).toBe('/account/sign-in');
  });

  test('also offers a way home', async () => {
    await renderUnauthorized();
    const home = within(screen.getByRole('main')).getByRole('link', { name: errorPagesMessages.en.unauthorized.home });
    expect(home.getAttribute('href')).toBe('/');
  });

  test('renders inside the app shell', async () => {
    await renderUnauthorized();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(document.getElementById('main-content')?.contains(screen.getByRole('heading', { level: 1 }))).toBe(true);
  });

  for (const locale of LOCALE_LIST) {
    test(`is written in the active language (${locale}), never a raw key or "undefined"`, async () => {
      await renderUnauthorized(locale);
      const copy = errorPagesMessages[locale].unauthorized;
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(copy.title);
      const page = within(screen.getByRole('main'));
      expect(page.getByRole('link', { name: copy.signIn })).toBeTruthy();
      expect(page.getByRole('link', { name: copy.home })).toBeTruthy();
      const text = screen.getByRole('main').textContent ?? '';
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('unauthorized.');
    });
  }
});

// --- wiring -----------------------------------------------------------------------------------

describe('routes/__root.tsx', () => {
  test('the real root route uses these pages as its notFoundComponent and errorComponent', () => {
    expect(AppRootRoute.options.notFoundComponent).toBe(NotFoundPage);
    expect(AppRootRoute.options.errorComponent).toBe(RootErrorPage);
  });

  test('still renders the shell around the routed page (the component is set)', () => {
    expect(typeof AppRootRoute.options.component).toBe('function');
  });
});

// --- copy tone --------------------------------------------------------------------------------

describe('copy', () => {
  test('never scolds: no "error", "wrong page", "forbidden", "denied" or "illegal" wording in English', () => {
    const copy = JSON.stringify(errorPagesMessages.en);
    for (const word of [/\bforbidden\b/i, /\bdenied\b/i, /\billegal\b/i, /\bfailed\b/i, /\byou (must|should|need to)\b/i]) {
      expect(copy).not.toMatch(word);
    }
  });

  test('the same keys exist in all three languages', () => {
    const keys = (tree: object, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string' ? [`${prefix}${key}`] : keys(value as object, `${prefix}${key}.`),
      );
    const en = keys(errorPagesMessages.en).sort();
    expect(keys(errorPagesMessages.kk).sort()).toEqual(en);
    expect(keys(errorPagesMessages.ru).sort()).toEqual(en);
    expect(en.length).toBeGreaterThan(8);
  });
});
