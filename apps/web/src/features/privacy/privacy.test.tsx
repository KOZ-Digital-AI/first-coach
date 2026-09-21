import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { StartResponse } from '@api-types/onboarding';
import type { PlayerProfile } from '@api-types/domain';
import { Consents, DEFAULT_CONSENTS, UpdateConsentsRequest } from '@api-types/privacy';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { buildResources, createI18n, LOCALES, type MessageModules } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import messages from './privacy-settings.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as plan.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { Route, PrivacyDepsContext } = await import('../../routes/settings/privacy');

/*
 * The privacy settings screen (/settings/privacy), written from the bead's acceptance criteria (fc-mol-bjm.6):
 *  - explains in plain language what is stored (no name, no email, age in years, training results) and what is never done
 *    (no public profiles, no messaging, no ads, no global rankings);
 *  - two consent toggles, both off by default: video analysis (discloses that a few still frames go to an AI provider; under 13
 *    a guardian must confirm) and model improvement, saved with PUT /api/player/consents with an optimistic update and rollback;
 *  - renders every panel of the privacy-panel slot (features/privacy/panels/*.panel.tsx);
 *  - loading, empty, error, disabled and success states; controls disabled while a request is in flight; kk, ru and en.
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch). The route is mounted in a real (memory-history) router. Fixtures are parsed with the shared contract
 * schemas, so they cannot drift from the API. Kazakh copy needs a native review; the Kazakh assertions read the bundle.
 * The slot's panels are injected through the route's PrivacyDepsContext seam (import.meta.glob does not exist under bun).
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const profileOfAge = (age: number): PlayerProfile => ({
  age,
  level: 'basic',
  goal: 'control',
  equipment: 'ball',
  space: 'yard',
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: 'en',
});
const meOfAge = (age: number) => StartResponse.parse({ profile: profileOfAge(age), roadmap: null });

const AT = '2026-09-21T10:00:00.000Z';
const granted = (kind: 'videoAnalysis' | 'modelImprovement', extra: Record<string, unknown> = {}) =>
  Consents.parse({ ...DEFAULT_CONSENTS, [kind]: { granted: true, at: AT, ...extra } });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number, extra: Record<string, unknown> = {}) =>
  json({ type: 'about:blank', title: 'Problem', status, ...extra }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; path: string; headers: Headers; body: unknown };
type Server = {
  me?: () => Response | Promise<Response>;
  consents?: () => Response | Promise<Response>;
  put?: (body: unknown) => Response | Promise<Response>;
  /** What the server holds before the screen reads it. */
  initial?: Consents;
};

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubNetwork(server: Server = {}): void {
  calls = [];
  let held: Consents = server.initial ?? DEFAULT_CONSENTS;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, headers: new Headers(init?.headers), body });
    if (url.pathname === '/api/player/me') return (server.me ?? (() => json(meOfAge(9))))();
    if (url.pathname === '/api/player/consents' && method === 'GET') return (server.consents ?? (() => json(held)))();
    if (url.pathname === '/api/player/consents' && method === 'PUT') {
      if (server.put !== undefined) return server.put(body);
      // The default server: what the real one does for a valid body (a row per key present).
      const update = UpdateConsentsRequest.parse(body);
      held = Consents.parse({
        videoAnalysis:
          update.videoAnalysis === undefined
            ? held.videoAnalysis
            : { granted: update.videoAnalysis, at: AT, guardianConfirmed: update.videoAnalysis && update.guardianConfirmed === true },
        modelImprovement: update.modelImprovement === undefined ? held.modelImprovement : { granted: update.modelImprovement, at: AT },
      });
      return json(held);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const puts = () => calls.filter((call) => call.method === 'PUT');
const consentGets = () => calls.filter((call) => call.path === '/api/player/consents' && call.method === 'GET');

beforeEach(() => stubNetwork());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './privacy-settings.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

const PanelA = () => <p>PANEL A</p>;
const PanelB = () => <p>PANEL B</p>;

/** The route in a real router at /settings/privacy, with stand-ins for the routes it links to. */
async function renderPrivacy(locale: Locale = 'en', slots?: readonly ComponentType<object>[]) {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const rootRoute = createRootRoute();
  const privacyRoute = Route.update({ id: '/settings/privacy', path: '/settings/privacy', getParentRoute: () => rootRoute } as never);
  const stand = (path: string, label: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{label}</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      privacyRoute as never,
      stand('/train/onboarding', 'ONBOARDING STAND-IN') as never,
      stand('/train/roadmap', 'ROADMAP STAND-IN') as never,
    ]),
    history: createMemoryHistory({ initialEntries: ['/settings/privacy'] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <PrivacyDepsContext.Provider value={slots === undefined ? {} : { slots }}>
          <RouterProvider router={router} />
        </PrivacyDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user: userEvent.setup() };
}

/** Renders and waits for the two consent switches to be on screen. */
async function renderReady(age = 9, locale: Locale = 'en', slots?: readonly ComponentType<object>[]) {
  stubNetwork({ me: () => json(meOfAge(age)) });
  const view = await renderPrivacy(locale, slots);
  await screen.findByRole('switch', { name: locale === 'en' ? /^Video analysis/ : new RegExp(`^${messages[locale].consents.video.label}`) });
  return view;
}

const videoSwitch = () => screen.getByRole('switch', { name: /^Video analysis/ }) as HTMLInputElement;
const modelSwitch = () => screen.getByRole('switch', { name: /^Model improvement/ }) as HTMLInputElement;
const guardianBox = () => screen.queryByRole('checkbox', { name: /parent or guardian/i }) as HTMLInputElement | null;
const describedBy = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

// --- what is stored and what is never done --------------------------------------------------------

describe('the plain-language explanation', () => {
  test('says what is stored (age in years, training results) and what is not (name, email)', async () => {
    await renderReady();
    expect(screen.getByRole('heading', { level: 2, name: 'What we keep' })).toBeTruthy();
    expect(screen.getByText(/^Your age in years/)).toBeTruthy();
    expect(screen.getByText(/^Your training results/)).toBeTruthy();
    expect(screen.getByText(/^No name/)).toBeTruthy();
    expect(screen.getByText(/^No email/)).toBeTruthy();
  });

  test('says what is never done: no public profiles, no messaging, no ads, no global rankings', async () => {
    await renderReady();
    expect(screen.getByRole('heading', { level: 2, name: 'What we never do' })).toBeTruthy();
    for (const never of [/^No public profiles/, /^No messaging/, /^No ads/, /^No global rankings/]) {
      expect(screen.getByText(never)).toBeTruthy();
    }
  });

  test('the title is the only h1', async () => {
    await renderReady();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Your privacy']);
  });

  test('is shown even while the consents cannot be read', async () => {
    stubNetwork({ consents: () => problem(500) });
    await renderPrivacy();
    await screen.findByRole('alert');
    expect(screen.getByRole('heading', { level: 2, name: 'What we never do' })).toBeTruthy();
  });
});

// --- defaults --------------------------------------------------------------------------------------

describe('the two consent toggles', () => {
  test('reads the age (GET /api/player/me) and the consents (GET /api/player/consents) once each, and writes nothing', async () => {
    await renderReady();
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(['GET /api/player/consents', 'GET /api/player/me']);
    expect(puts()).toEqual([]);
  });

  test('both are off by default, and say so in words', async () => {
    await renderReady();
    expect(videoSwitch().checked).toBe(false);
    expect(modelSwitch().checked).toBe(false);
    expect(within(videoSwitch().closest('label')!).getByText('Off')).toBeTruthy();
    expect(within(modelSwitch().closest('label')!).getByText('Off')).toBeTruthy();
  });

  test('a consent the player already gave is on, and says On', async () => {
    stubNetwork({ initial: granted('modelImprovement'), me: () => json(meOfAge(15)) });
    await renderPrivacy();
    await screen.findByRole('switch', { name: /^Video analysis/ });
    expect(modelSwitch().checked).toBe(true);
    expect(within(modelSwitch().closest('label')!).getByText('On')).toBeTruthy();
    expect(videoSwitch().checked).toBe(false);
  });

  test('video analysis discloses that a few still frames are sent to an AI provider', async () => {
    await renderReady(15);
    const words = describedBy(videoSwitch());
    expect(words).toMatch(/a few still frames/i);
    expect(words).toMatch(/AI provider/);
  });

  test('model improvement has its own description, which does not mention frames', async () => {
    await renderReady(15);
    const words = describedBy(modelSwitch());
    expect(words.length).toBeGreaterThan(10);
    expect(words).not.toMatch(/frames/i);
  });

  test('each switch is a real labelled control on a 44px row', async () => {
    await renderReady(15);
    for (const toggle of [videoSwitch(), modelSwitch()]) {
      expect(toggle.tagName).toBe('INPUT');
      expect(toggle.closest('label')!.className).toContain('min-h-tap');
    }
  });
});

// --- optimistic update, success, rollback -----------------------------------------------------------

describe('saving a consent', () => {
  test('turning model improvement on sends PUT /api/player/consents with only that key, and says it is saved', async () => {
    const { user } = await renderReady(15);
    await user.click(modelSwitch());
    await screen.findByText('Saved. Model improvement is on.');
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.path).toBe('/api/player/consents');
    expect(puts()[0]!.body).toEqual({ modelImprovement: true });
    expect(modelSwitch().checked).toBe(true);
    expect(videoSwitch().checked).toBe(false);
  });

  test('turning it off again sends false and says it is off', async () => {
    stubNetwork({ initial: granted('modelImprovement'), me: () => json(meOfAge(15)) });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Model improvement/ });
    await user.click(modelSwitch());
    await screen.findByText('Saved. Model improvement is off.');
    expect(puts()[0]!.body).toEqual({ modelImprovement: false });
    expect(modelSwitch().checked).toBe(false);
  });

  test('the switch flips at once (optimistic), before the server answers, and every control is disabled while the request is in flight', async () => {
    const gate = deferred<Response>();
    stubNetwork({ me: () => json(meOfAge(9)), put: () => gate.promise });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Model improvement/ });

    void user.click(modelSwitch());
    await waitFor(() => expect(puts()).toHaveLength(1));
    // The answer has not arrived: the choice is already shown, and nothing else can be changed meanwhile.
    expect(modelSwitch().checked).toBe(true);
    expect(modelSwitch().disabled).toBe(true);
    expect(videoSwitch().disabled).toBe(true);
    expect(guardianBox()!.disabled).toBe(true);
    expect(screen.queryByText(/^Saved\./)).toBeNull();

    gate.resolve(json(granted('modelImprovement')));
    await screen.findByText('Saved. Model improvement is on.');
    expect(modelSwitch().disabled).toBe(false);
    expect(videoSwitch().disabled).toBe(false);
  });

  test('the answer of the server, not the optimistic guess, is what stays on screen', async () => {
    // The server answers that the choice is still off (e.g. another device changed it back): the screen follows the server.
    stubNetwork({ me: () => json(meOfAge(15)), put: () => json(DEFAULT_CONSENTS) });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Model improvement/ });
    await user.click(modelSwitch());
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(modelSwitch().disabled).toBe(false));
    expect(modelSwitch().checked).toBe(false);
  });

  test('a failed save rolls the switch back to how it was and says so in words', async () => {
    const gate = deferred<Response>();
    stubNetwork({ me: () => json(meOfAge(15)), put: () => gate.promise });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Model improvement/ });

    void user.click(modelSwitch());
    await waitFor(() => expect(modelSwitch().checked).toBe(true));
    gate.resolve(problem(500));

    const alert = await screen.findByText(/was not saved/i);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(modelSwitch().checked).toBe(false);
    expect(within(modelSwitch().closest('label')!).getByText('Off')).toBeTruthy();
    expect(modelSwitch().disabled).toBe(false);
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });

  test('a network failure rolls back too, and a later success clears the failure message', async () => {
    let fail = true;
    stubNetwork({
      me: () => json(meOfAge(15)),
      put: () => {
        if (fail) throw new TypeError('Failed to fetch');
        return json(granted('modelImprovement'));
      },
    });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Model improvement/ });
    await user.click(modelSwitch());
    await screen.findByText(/was not saved/i);
    expect(modelSwitch().checked).toBe(false);

    fail = false;
    await user.click(modelSwitch());
    await screen.findByText('Saved. Model improvement is on.');
    expect(screen.queryByText(/was not saved/i)).toBeNull();
  });

  test('a rolled-back video switch also forgets the guardian ticket it was sent with', async () => {
    stubNetwork({ me: () => json(meOfAge(9)), put: () => problem(500) });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Video analysis/ });
    await user.click(guardianBox()!);
    await user.click(videoSwitch());
    await screen.findByText(/was not saved/i);
    expect(videoSwitch().checked).toBe(false);
  });
});

// --- the under-13 guardian rule ---------------------------------------------------------------------

describe('under 13: a guardian must confirm before video analysis is turned on', () => {
  test('a player of 9 is asked for the guardian checkbox, unticked, with the reason in words', async () => {
    await renderReady(9);
    const box = guardianBox();
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    expect(screen.getByText(/under 13/i)).toBeTruthy();
  });

  test('the checkbox is shown at 12 and not at 13', async () => {
    await renderReady(12);
    expect(guardianBox()).not.toBeNull();
    cleanup();
    await renderReady(13);
    expect(guardianBox()).toBeNull();
  });

  test('turning video analysis on without the guardian tick sends nothing, keeps the switch off and asks for the tick', async () => {
    const { user } = await renderReady(9);
    await user.click(videoSwitch());
    const ask = await screen.findByText('Ask a parent or guardian to tick the box first.');
    expect(ask.closest('[role="alert"]')).not.toBeNull();
    expect(puts()).toEqual([]);
    expect(videoSwitch().checked).toBe(false);
    expect(guardianBox()!.getAttribute('aria-invalid')).toBe('true');
  });

  test('with the guardian tick, video analysis is sent with guardianConfirmed: true in the same request', async () => {
    const { user } = await renderReady(9);
    await user.click(guardianBox()!);
    await user.click(videoSwitch());
    await screen.findByText('Saved. Video analysis is on.');
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ videoAnalysis: true, guardianConfirmed: true });
    expect(videoSwitch().checked).toBe(true);
    expect(screen.queryByText('Ask a parent or guardian to tick the box first.')).toBeNull();
  });

  test('ticking the box on its own sends nothing', async () => {
    const { user } = await renderReady(9);
    await user.click(guardianBox()!);
    expect(guardianBox()!.checked).toBe(true);
    expect(puts()).toEqual([]);
  });

  test('turning model improvement on never needs a guardian, at any age', async () => {
    const { user } = await renderReady(9);
    await user.click(modelSwitch());
    await screen.findByText('Saved. Model improvement is on.');
    expect(puts()[0]!.body).toEqual({ modelImprovement: true });
  });

  test('a player of 13 or more turns video analysis on with no guardian key at all', async () => {
    const { user } = await renderReady(13);
    await user.click(videoSwitch());
    await screen.findByText('Saved. Video analysis is on.');
    expect(puts()[0]!.body).toEqual({ videoAnalysis: true });
  });

  test('turning video analysis off is always allowed under 13, with no guardian tick', async () => {
    stubNetwork({ initial: granted('videoAnalysis', { guardianConfirmed: true }), me: () => json(meOfAge(9)) });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Video analysis/ });
    expect(videoSwitch().checked).toBe(true);
    await user.click(videoSwitch());
    await screen.findByText('Saved. Video analysis is off.');
    expect(puts()[0]!.body).toEqual({ videoAnalysis: false });
    expect(videoSwitch().checked).toBe(false);
  });

  test('the server refusing the guardian rule (422 at /guardianConfirmed) rolls back and shows the guardian checkbox, even if the age said 14', async () => {
    stubNetwork({
      me: () => json(meOfAge(14)),
      put: () =>
        problem(422, { title: 'Unprocessable Entity', errors: [{ pointer: '/guardianConfirmed', detail: 'A guardian must confirm.' }] }),
    });
    const { user } = await renderPrivacy();
    await screen.findByRole('switch', { name: /^Video analysis/ });
    expect(guardianBox()).toBeNull();

    await user.click(videoSwitch());
    await screen.findByText('Ask a parent or guardian to tick the box first.');
    expect(videoSwitch().checked).toBe(false);
    expect(guardianBox()).not.toBeNull();
    expect(guardianBox()!.getAttribute('aria-invalid')).toBe('true');
  });
});

// --- the privacy-panel slot -------------------------------------------------------------------------

describe('the privacy-panel slot', () => {
  test('renders every panel it is given, in order, after the consents', async () => {
    await renderReady(15, 'en', [PanelA, PanelB]);
    const a = screen.getByText('PANEL A');
    const b = screen.getByText('PANEL B');
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(videoSwitch().compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('an empty slot renders nothing extra and does not break the screen', async () => {
    await renderReady(15, 'en', []);
    expect(screen.queryByText('PANEL A')).toBeNull();
    expect(videoSwitch()).toBeTruthy();
  });

  test('the panels are there in the empty and the error states too (they need no consents)', async () => {
    stubNetwork({ me: () => problem(404) });
    await renderPrivacy('en', [PanelA]);
    await screen.findByText('Finish setting up first');
    expect(screen.getByText('PANEL A')).toBeTruthy();
    cleanup();

    stubNetwork({ consents: () => problem(500) });
    await renderPrivacy('en', [PanelB]);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('PANEL B')).toBeTruthy();
  });
});

// --- states ----------------------------------------------------------------------------------------

describe('states', () => {
  test('loading: a named busy status, and no switch yet', async () => {
    const gate = deferred<Response>();
    stubNetwork({ consents: () => gate.promise });
    await renderPrivacy();
    const loading = await screen.findByRole('status', { name: 'Loading your privacy choices' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('switch')).toBeNull();
    gate.resolve(json(DEFAULT_CONSENTS));
    await screen.findByRole('switch', { name: /^Video analysis/ });
    expect(screen.queryByRole('status', { name: 'Loading your privacy choices' })).toBeNull();
  });

  test('empty: a player with no plan yet (no age) is led to the setup instead of being shown switches', async () => {
    stubNetwork({ me: () => problem(404) });
    await renderPrivacy();
    await screen.findByText('Finish setting up first');
    expect(screen.queryByRole('switch')).toBeNull();
    const link = screen.getByRole('link', { name: 'Set up my plan' });
    expect(link.getAttribute('href')).toBe('/train/onboarding');
  });

  test('error: the consents failing to load shows an alert with Try again, which reads them again and recovers', async () => {
    let failing = true;
    stubNetwork({ me: () => json(meOfAge(15)), consents: () => (failing ? problem(500) : json(DEFAULT_CONSENTS)) });
    const { user } = await renderPrivacy();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(retry.closest('[role="alert"]')!.textContent).toContain('We could not load your choices');
    expect(screen.queryByRole('switch')).toBeNull();

    failing = false;
    await user.click(retry);
    await screen.findByRole('switch', { name: /^Video analysis/ });
    expect(consentGets().length).toBeGreaterThanOrEqual(2);
  });

  test('error: the age failing to load (not a 404) is an error too, not silently a switch that could break the guardian rule', async () => {
    stubNetwork({ me: () => problem(500) });
    await renderPrivacy();
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('error: Try again is disabled while the refetch runs', async () => {
    let reads = 0;
    const gate = deferred<Response>();
    stubNetwork({
      me: () => json(meOfAge(15)),
      consents: () => {
        reads += 1;
        return reads === 1 ? problem(500) : gate.promise;
      },
    });
    const { user } = await renderPrivacy();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    void user.click(retry);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true));
    gate.resolve(json(DEFAULT_CONSENTS));
    await screen.findByRole('switch', { name: /^Video analysis/ });
  });

  test('success: the saved message is a status (announced), and comes with an icon, not colour alone', async () => {
    const { user } = await renderReady(15);
    await user.click(modelSwitch());
    const saved = await screen.findByText('Saved. Model improvement is on.');
    const status = saved.closest('[role="status"]')!;
    expect(status).not.toBeNull();
    expect(status.querySelector('svg')).not.toBeNull();
  });

  test('the Accept-Language of the calls is the active language', async () => {
    await renderReady(15, 'ru');
    expect(calls.find((call) => call.path === '/api/player/consents')!.headers.get('accept-language')).toBe('ru');
  });
});

// --- kk, ru, en ----------------------------------------------------------------------------------------

describe('every string comes from the messages file, in kk, ru and en', () => {
  test.each(LOCALES)('%s: the title, the consent labels and the never-list are that language\'s own', async (locale) => {
    await renderReady(9, locale);
    const m = messages[locale];
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(m.title);
    expect(screen.getByRole('heading', { level: 2, name: m.stored.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: m.never.title })).toBeTruthy();
    expect(videoSwitch().closest('label')!.textContent).toContain(m.consents.video.label);
    expect(modelSwitch().closest('label')!.textContent).toContain(m.consents.model.label);
    expect(describedBy(videoSwitch())).toContain(m.consents.video.hint);
    expect(guardianBox()!.closest('label')!.textContent).toContain(m.guardian.label);
    // Off is worded per language.
    expect(within(videoSwitch().closest('label')!).getByText(m.state.off)).toBeTruthy();
  });

  test.each(LOCALES)('%s: no raw key, "undefined" or empty text leaks onto the screen', async (locale) => {
    await renderReady(9, locale);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/privacy-settings[:.]/);
    expect(text).not.toMatch(/\{\{/);
  });

  test('the disclosure and the under-13 rule are worded in all three languages (not left blank)', () => {
    for (const locale of LOCALES) {
      expect(messages[locale].consents.video.hint.length).toBeGreaterThan(20);
      expect(messages[locale].guardian.required.length).toBeGreaterThan(10);
    }
  });

  test('Russian: saving says so in Russian', async () => {
    const { user } = await renderReady(15, 'ru');
    await user.click(modelSwitch());
    await screen.findByText(messages.ru.saved.on.replace('{{name}}', messages.ru.consents.model.label));
  });
});

// --- namespaces -----------------------------------------------------------------------------------------

describe('the message bundle in the app-wide i18n resources', () => {
  // Read from disk like i18n.test.ts (import.meta.glob does not exist under bun), so every real messages file is included.
  const srcDir = join(import.meta.dir, '..', '..');
  const files = [...new Bun.Glob('**/*.messages.ts').scanSync({ cwd: srcDir })].sort();

  test('the namespace is privacy-settings, and the legal policy keeps its own `privacy`', async () => {
    expect(files).toContain('features/privacy/privacy-settings.messages.ts');
    expect(files).toContain('features/legal/privacy.messages.ts');
    const real: MessageModules = {};
    for (const file of files) real[`../${file}`] = await import(join(srcDir, file));
    const resources = buildResources(real); // throws when two files share a namespace
    for (const locale of LOCALES) {
      expect(Object.keys(resources[locale] as object)).toEqual(expect.arrayContaining(['privacy-settings', 'privacy']));
    }
  });

  test('no other messages file in the app shares the base name privacy-settings', () => {
    expect(files.filter((file) => file.endsWith('/privacy-settings.messages.ts'))).toEqual(['features/privacy/privacy-settings.messages.ts']);
  });
});
