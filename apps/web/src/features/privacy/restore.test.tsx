import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { PlayerProfile, Roadmap } from '@api-types/domain';
import { RecoverResponse } from '@api-types/privacy';
import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { PlayerSessionError } from '../../lib/auth';
import { createI18n, LOCALES, type MessageModules } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import type { KeyValueStore } from '../../offline/types';
import messages from './restore.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as privacy.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { Route, RecoverDepsContext } = await import('../../routes/recover');

/*
 * The restore screen (/recover), written from the acceptance criteria of fc-mol-bjm.9:
 *  - accepts the recovery code with forgiving input (spaces, dashes, lower case);
 *  - ensures an anonymous session, calls POST /api/player/recover and lands on /train;
 *  - if this device already has training data (409) it asks before replacing (`replace: true`);
 *  - a wrong code and a rate limit show clear messages;
 *  - loading, empty, error, disabled and success states; mutation buttons disabled while a request is in flight;
 *  - every string in kk, ru and en (restore.messages.ts).
 * Also from the brief: after success the in-memory query cache, the persisted cache (fc:<id>:query-cache), the downloaded
 * session and the remembered last player (fc:last-player) all stop describing the previous state of this device; the code is
 * never logged, stored or put in the URL.
 *
 * Real code goes through the real typed client (lib/api.ts) and React Query; the stand-ins are the network
 * (globalThis.fetch) and the route's own seam (RecoverDepsContext: the session, the IndexedDB store, the device storage).
 * The route is mounted in a real (memory-history) router. Fixtures are parsed with the shared contract schema, so they cannot
 * drift from the API. Kazakh and Russian copy needs a native review; those assertions read the bundle.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

const CODE = 'K7QM-3XWP-9RTD-H2VB';
const CODE_CHARS = CODE.replaceAll('-', '');
const CURRENT = 'anon-current';
const PREVIOUS = 'anon-previous';

const PROFILE: PlayerProfile = {
  age: 9,
  level: 'basic',
  goal: 'control',
  equipment: 'ball',
  space: 'yard',
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: 'en',
};
const ROADMAP: Roadmap = {
  currentLevelLabel: 'Basic',
  tracks: [
    { skill: 'ball-mastery', level: 2, source: 'test' },
    { skill: 'dribbling', level: 3, source: 'self' },
    { skill: 'weak-foot', level: 1, source: 'self' },
  ],
  goal: 'control',
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'ball-mastery', level: 2, targetLevel: 3, reason: 'goal' },
    { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
  ],
};
const RECOVERED = RecoverResponse.parse({ profile: PROFILE, roadmap: ROADMAP });

// --- the network ----------------------------------------------------------------------------------------------------

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

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
type Respond = (body: Record<string, unknown>) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let order: string[] = [];
let respond: Respond = () => json(RECOVERED);

beforeEach(() => {
  calls = [];
  order = [];
  respond = () => json(RECOVERED);
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/player/recover' && method === 'POST') {
      order.push('post');
      return respond(body ?? {});
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});
/*
 * Cross-file hygiene (the same fix as contribute/form.test.tsx, fc-mol-70i.8). bun runs every test file of the web package in
 * ONE process with ONE happy-dom window. happy-dom records every element query it has answered (each `querySelectorAll` behind a
 * Testing Library query) in bookkeeping lists on the document and on <html> (`affectsCache`, `affectsComputedStyleCache`) and in
 * the window's selector cache, and never trims them. This file asks thousands of questions, and the whole-package run then made
 * another file's failing `expect(element)` (bun pretty-prints the element together with that bookkeeping) slow enough to hit its
 * 5 s timeout (offline-reload.test.tsx, "a session that arrives later ..."). After every test the DOM is empty, so the lists are
 * emptied the way happy-dom itself empties them when a node changes: every recorded result is invalidated first, then the list
 * is cleared. Written against happy-dom 20.x symbols by description; if they are not there it does nothing.
 * Nothing else is left global: fetch is restored below, the stores and the session are injected, the i18n instances and routers
 * are per test, the console spy is restored in its own finally, and no timer, location or `fc:*` browser key is touched.
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

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

const posts = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/player/recover');

// --- the device: session, IndexedDB store, localStorage ------------------------------------------------------------

type Session = { user: { id: string; isAnonymous?: boolean | null } };

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { entries(): [string, string][] } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    entries: () => [...map.entries()],
  };
}

const SESSION_KEY = `fc:${CURRENT}:session`;
const OUTBOX_KEY = `fc:${CURRENT}:outbox`;
const QUERY_CACHE_KEY = `fc:${CURRENT}:query-cache`;
const LAST_PLAYER_KEY = 'fc:last-player';

// --- rendering ------------------------------------------------------------------------------------------------------

const modules: MessageModules = {
  './restore.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

interface Options {
  locale?: Locale;
  session?: () => Promise<Session>;
  /** Held: the persisted cache deletion does not finish until it is resolved. */
  holdDelete?: Promise<void>;
}

/** The route in a real router at /recover, with stand-ins for the routes it leads to. */
async function renderRecover(options: Options = {}) {
  const instance = createI18n({ modules, languages: [options.locale ?? 'en'], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  // What the previous state of this device left in the caches (the criteria: none of it may outlive a restore).
  queryClient.setQueryData(['today'], { stale: 'session of the replaced progress' });
  queryClient.setQueryData(['me'], { stale: 'plan of the replaced progress' });

  const store = memoryStore({
    [LAST_PLAYER_KEY]: PREVIOUS,
    [SESSION_KEY]: '{"downloaded":"session of the replaced progress"}',
    [OUTBOX_KEY]: '[{"unsent":"event"}]',
  });
  const deleted: string[] = [];
  const persistStore = {
    del: mock(async (key: string) => {
      await options.holdDelete;
      deleted.push(key);
    }),
  };
  const ensureSession = mock(async (): Promise<Session> => {
    order.push('session');
    return options.session === undefined ? { user: { id: CURRENT, isAnonymous: true } } : options.session();
  });

  const rootRoute = createRootRoute();
  const recoverRoute = Route.update({ id: '/recover', path: '/recover', getParentRoute: () => rootRoute } as never);
  const stand = (path: string, label: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{label}</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([recoverRoute as never, stand('/train', 'TRAIN STAND-IN') as never, stand('/', 'HOME STAND-IN') as never]),
    history: createMemoryHistory({ initialEntries: ['/recover'] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RecoverDepsContext.Provider value={{ ensureSession, persistStore, deviceStore: store }}>
          <RouterProvider router={router} />
        </RecoverDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  return { ...view, router, queryClient, store, deleted, ensureSession, user: userEvent.setup() };
}
type View = Awaited<ReturnType<typeof renderRecover>>;

const codeInput = () => screen.getByRole('textbox', { name: /recovery code/i }) as HTMLInputElement;
const submitButton = () => screen.getByRole('button', { name: /^restore my progress/i }) as HTMLButtonElement;
const pathname = (view: View) => view.router.state.location.pathname;

async function enter(view: View, text: string): Promise<void> {
  await view.user.click(codeInput());
  await view.user.type(codeInput(), text);
}
async function submit(view: View, text = CODE): Promise<void> {
  await enter(view, text);
  await view.user.click(submitButton());
}

/** The caches still describe the previous state of this device (nothing was dropped). */
function expectCachesKept(view: View): void {
  expect(view.queryClient.getQueryData(['today'])).toBeDefined();
  expect(view.queryClient.getQueryData(['me'])).toBeDefined();
  expect(view.deleted).toEqual([]);
  expect(view.store.getItem(SESSION_KEY)).not.toBeNull();
  expect(view.store.getItem(LAST_PLAYER_KEY)).toBe(PREVIOUS);
}

const describedBy = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

// --- the screen -----------------------------------------------------------------------------------------------------

describe('the screen at rest', () => {
  test('has one h1, a labelled code field that explains the format, and a disabled button while the field is empty', async () => {
    const view = await renderRecover();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Get your progress back']);
    const input = codeInput();
    expect(input.type).toBe('text');
    expect(describedBy(input)).toMatch(/16 letters and numbers/);
    expect(submitButton().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/don.t have a code\?/i)).toBeTruthy();
    // A visitor who only opens the page gets no request and no session.
    expect(calls).toEqual([]);
    expect(view.ensureSession).not.toHaveBeenCalled();
  });

  test('the field is paste-friendly and keeps the browser from helping: no autocomplete, no autocorrect, no spellcheck', async () => {
    await renderRecover();
    const input = codeInput();
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.readOnly).toBe(false);
  });

  test('counts the characters typed, ignoring spaces and dashes', async () => {
    const view = await renderRecover();
    await enter(view, 'k7qm-3x');
    expect(screen.getByText('6 of 16 characters')).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
  });
});

// --- input normalisation --------------------------------------------------------------------------------------------

describe('forgiving input', () => {
  test.each([
    ['lower case', 'k7qm3xwp9rtdh2vb'],
    ['upper case, no separators', 'K7QM3XWP9RTDH2VB'],
    ['spaces between the groups', 'K7QM 3XWP 9RTD H2VB'],
    ['dashes between the groups', 'k7qm-3xwp-9rtd-h2vb'],
    ['mixed separators and outer spaces', ' k7qm - 3xwp  9rtd-h2vb '],
  ])('%s is sent in the canonical form, and nothing else is in the body', async (_name, typed) => {
    const view = await renderRecover();
    await submit(view, typed);
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(posts().map((call) => call.body)).toEqual([{ code: CODE }]);
  });

  test('a pasted code is normalised the same way', async () => {
    const view = await renderRecover();
    await view.user.click(codeInput());
    await view.user.paste('  k7qm 3xwp\n9rtd-h2vb ');
    await view.user.click(submitButton());
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(posts().map((call) => call.body)).toEqual([{ code: CODE }]);
  });

  test.each([
    ['one character short', 'K7QM-3XWP-9RTD-H2V'],
    ['one character too many', 'K7QM-3XWP-9RTD-H2VBX'],
    ['a stray symbol', 'K7QM-3XWP-9RTD-H2V!'],
  ])('%s is refused in words at once: no request, focus back on the field', async (_name, typed) => {
    const view = await renderRecover();
    await submit(view, typed);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/16 letters and numbers/);
    expect(codeInput().getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(codeInput())).toMatch(/16 letters and numbers/);
    expect(document.activeElement).toBe(codeInput());
    expect(calls).toEqual([]);
    expect(pathname(view)).toBe('/recover');
  });

  test('the error goes away as soon as the code is edited', async () => {
    const view = await renderRecover();
    await submit(view, 'K7QM-3XWP');
    await screen.findByRole('alert');
    await view.user.type(codeInput(), '9');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(codeInput().getAttribute('aria-invalid')).toBeNull();
  });
});

// --- restoring ------------------------------------------------------------------------------------------------------

describe('restoring the progress', () => {
  test('ensures the session first, sends ONE POST /api/player/recover and lands on /train', async () => {
    const view = await renderRecover();
    await submit(view);
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(screen.getByText('TRAIN STAND-IN')).toBeTruthy();
    expect(order).toEqual(['session', 'post']);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/player/recover']);
    expect(view.ensureSession).toHaveBeenCalledTimes(1);
    // The form is REPLACED (not pushed), so Back does not return to a screen that held a code.
    expect(view.router.history.length).toBe(1);
  });

  test('drops the in-memory caches, the persisted cache and the downloaded session of the player, and points fc:last-player at the session', async () => {
    const view = await renderRecover();
    await submit(view);
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(view.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(view.deleted).toEqual([QUERY_CACHE_KEY]);
    expect(view.store.getItem(SESSION_KEY)).toBeNull();
    expect(view.store.getItem(LAST_PLAYER_KEY)).toBe(CURRENT);
  });

  test('keeps the outbox when nothing was replaced (there was no data on this device to replace)', async () => {
    const view = await renderRecover();
    await submit(view);
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(view.store.getItem(OUTBOX_KEY)).not.toBeNull();
  });

  test('says so while the caches are being dropped, and leaves only when they are', async () => {
    const hold = deferred<void>();
    const view = await renderRecover({ holdDelete: hold.promise });
    await submit(view);
    const success = await screen.findByText(/your progress is back/i);
    expect(success.closest('[role="status"]')).not.toBeNull();
    expect(pathname(view)).toBe('/recover');
    expect((screen.getByRole('button', { name: /^restor/i }) as HTMLButtonElement).disabled).toBe(true);
    hold.resolve();
    await waitFor(() => expect(pathname(view)).toBe('/train'));
  });

  test('a session that is an account (not anonymous) is not sent at all: it is told so in words', async () => {
    const view = await renderRecover({ session: async () => ({ user: { id: 'coach-1', isAnonymous: false } }) });
    await submit(view);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/signed in with an account/i);
    expect(calls).toEqual([]);
    expectCachesKept(view);
  });

  test('a session that cannot be made is a plain "no connection" message and no request', async () => {
    const view = await renderRecover({
      session: async () => {
        throw new PlayerSessionError('could not sign in', { kind: 'offline' });
      },
    });
    await submit(view);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no connection/i);
    expect(calls).toEqual([]);
    expect(pathname(view)).toBe('/recover');
    expect(submitButton().disabled).toBe(false);
  });
});

// --- the replace confirmation ---------------------------------------------------------------------------------------

describe('a device that already has progress (409)', () => {
  const onConflict: Respond = (body) => (body.replace === true ? json(RECOVERED) : problem(409));

  test('asks before replacing: says what happens, offers replace and keep, and drops nothing yet', async () => {
    respond = onConflict;
    const view = await renderRecover();
    await submit(view);
    const heading = await screen.findByRole('heading', { name: /already has progress/i });
    expect(heading).toBeTruthy();
    expect(screen.getByText(/replaced with the progress from your code/i)).toBeTruthy();
    expect(screen.getByText(/cannot be brought back/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: "Replace this device's progress with the recovered one" })).toBeTruthy();
    expect(screen.getByRole('button', { name: "Keep this device's progress" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^restore my progress/i })).toBeNull();
    expect(pathname(view)).toBe('/recover');
    expect(posts().map((call) => call.body)).toEqual([{ code: CODE }]); // the first request never carries replace
    expectCachesKept(view);
  });

  test('Keep goes back to the form with the code still typed, sends nothing and drops nothing', async () => {
    respond = onConflict;
    const view = await renderRecover();
    await submit(view, 'k7qm 3xwp 9rtd h2vb');
    await screen.findByRole('heading', { name: /already has progress/i });
    await view.user.click(screen.getByRole('button', { name: "Keep this device's progress" }));
    expect(codeInput().value).toBe('k7qm 3xwp 9rtd h2vb');
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByRole('heading', { name: /already has progress/i })).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(pathname(view)).toBe('/recover');
    expectCachesKept(view);
  });

  test('Replace sends the same code with replace: true, disables both buttons while it runs, then lands on /train and drops the caches and the outbox', async () => {
    const answer = deferred<Response>();
    respond = (body) => (body.replace === true ? answer.promise : problem(409));
    const view = await renderRecover();
    await submit(view);
    await screen.findByRole('heading', { name: /already has progress/i });
    const replace = screen.getByRole('button', { name: /^replace this device's progress|^replacing/i }) as HTMLButtonElement;
    await view.user.click(replace);

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.body).toEqual({ code: CODE, replace: true });
    const inFlight = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(inFlight.length).toBeGreaterThanOrEqual(2);
    expect(inFlight.every((button) => button.disabled)).toBe(true);
    expect(screen.getByRole('button', { name: /^replacing/i }).getAttribute('aria-busy')).toBe('true');
    expectCachesKept(view);

    answer.resolve(json(RECOVERED));
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(view.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(view.deleted).toEqual([QUERY_CACHE_KEY]);
    expect(view.store.getItem(SESSION_KEY)).toBeNull();
    expect(view.store.getItem(OUTBOX_KEY)).toBeNull();
    expect(view.store.getItem(LAST_PLAYER_KEY)).toBe(CURRENT);
  });

  test('a failed replace stays on the question, says why, and can be tried again', async () => {
    let replaceAttempts = 0;
    respond = (body) => {
      if (body.replace !== true) return problem(409);
      replaceAttempts += 1;
      return replaceAttempts === 1 ? problem(500) : json(RECOVERED);
    };
    const view = await renderRecover();
    await submit(view);
    await screen.findByRole('heading', { name: /already has progress/i });
    await view.user.click(screen.getByRole('button', { name: /^replace this device's progress/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/something went wrong on our side/i);
    expect(screen.getByRole('heading', { name: /already has progress/i })).toBeTruthy();
    expect((screen.getByRole('button', { name: /^replace this device's progress/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: "Keep this device's progress" }) as HTMLButtonElement).disabled).toBe(false);
    expectCachesKept(view);

    await view.user.click(screen.getByRole('button', { name: /^replace this device's progress/i }));
    await waitFor(() => expect(pathname(view)).toBe('/train'));
  });
});

// --- error mapping --------------------------------------------------------------------------------------------------

describe('errors', () => {
  async function failWith(response: Respond, text = CODE) {
    respond = response;
    const view = await renderRecover();
    await submit(view, text);
    const alert = await screen.findByRole('alert');
    return { view, alert };
  }

  function expectRecoverable(view: View): void {
    expect(pathname(view)).toBe('/recover');
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByRole('heading', { name: /already has progress/i })).toBeNull();
    expectCachesKept(view);
  }

  test('a wrong code (422) says one clear thing, keeps what was typed, and never repeats what the server said', async () => {
    const { view, alert } = await failWith(() => problem(422, { detail: 'no such code exists in the database', errors: [{ pointer: '/code', detail: 'unknown code' }] }), 'k7qm 3xwp 9rtd h2vb');
    expect(alert.textContent).toMatch(/this code did not work/i);
    expect(alert.textContent).not.toMatch(/exist|database|unknown|expired|replaced|format/i);
    expect(codeInput().getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(codeInput())).toMatch(/this code did not work/i);
    expect(codeInput().value).toBe('k7qm 3xwp 9rtd h2vb');
    expect(document.activeElement).toBe(codeInput());
    expectRecoverable(view);
  });

  test('a wrong code and a bad request (400) read the same', async () => {
    const wrong = await failWith(() => problem(422));
    const wrongText = wrong.alert.textContent;
    cleanup();
    const bad = await failWith(() => problem(400));
    expect(bad.alert.textContent).toBe(wrongText);
  });

  test('the rate limit (429) says to wait 15 minutes and is not called a wrong code', async () => {
    const { view, alert } = await failWith(() => problem(429));
    expect(alert.textContent).toMatch(/too many tries/i);
    expect(alert.textContent).toMatch(/15 minutes/);
    expect(alert.textContent).not.toMatch(/did not work/i);
    expect(document.activeElement).toBe(alert);
    expectRecoverable(view);
  });

  test('an account session refused by the server (403) says restoring works only on a device without an account', async () => {
    const { view, alert } = await failWith(() => problem(403));
    expect(alert.textContent).toMatch(/signed in with an account/i);
    expectRecoverable(view);
  });

  test('a server failure (5xx) uses the generic message and can be tried again', async () => {
    const { view, alert } = await failWith(() => problem(500));
    expect(alert.textContent).toMatch(/something went wrong on our side/i);
    expectRecoverable(view);
  });

  test('a network failure uses the generic offline message', async () => {
    const { view, alert } = await failWith(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(alert.textContent).toMatch(/no connection/i);
    expectRecoverable(view);
  });

  test('an answer that is not a restore is reported as an error, never as success', async () => {
    const { view, alert } = await failWith(() => json({ hello: 'world' }));
    expect(alert.textContent).toMatch(/unexpected answer/i);
    expectRecoverable(view);
  });

  test('the same screen tries again after a failure and then succeeds', async () => {
    let attempts = 0;
    const { view } = await failWith(() => (++attempts === 1 ? problem(422) : json(RECOVERED)));
    await view.user.click(submitButton());
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(posts()).toHaveLength(2);
  });

  test('every failure names the problem in words with an icon, never by colour alone', async () => {
    const { alert } = await failWith(() => problem(429));
    expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect((alert.textContent ?? '').trim().length).toBeGreaterThan(10);
  });
});

// --- in flight ------------------------------------------------------------------------------------------------------

describe('while the request is in flight', () => {
  test('the button and the field are disabled and busy, and a second submit sends nothing', async () => {
    const answer = deferred<Response>();
    respond = () => answer.promise;
    const view = await renderRecover();
    await submit(view);
    await waitFor(() => expect(posts()).toHaveLength(1));

    const button = screen.getByRole('button', { name: /^restoring/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(codeInput().disabled).toBe(true);

    const form = codeInput().closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await Promise.resolve();
    expect(posts()).toHaveLength(1);
    expect(view.ensureSession).toHaveBeenCalledTimes(1);

    answer.resolve(json(RECOVERED));
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(posts()).toHaveLength(1);
  });

  test('a double submit in the same tick, before anything re-renders, is still one request', async () => {
    const view = await renderRecover();
    await enter(view, CODE);
    const form = codeInput().closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(pathname(view)).toBe('/train'));
    expect(posts()).toHaveLength(1);
  });
});

// --- the code is a secret -------------------------------------------------------------------------------------------

describe('the code stays in memory', () => {
  const holdsCode = (text: string): boolean => text.includes(CODE) || text.includes(CODE_CHARS) || text.toLowerCase().includes(CODE_CHARS.toLowerCase());

  function everythingKept(view: View): string {
    const cache = dehydrate(view.queryClient, { shouldDehydrateQuery: () => true, shouldDehydrateMutation: () => true });
    const browser = [localStorage, sessionStorage].flatMap((storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`));
    return JSON.stringify({ cache, browser, device: view.store.entries(), deleted: view.deleted, href: view.router.state.location.href });
  }

  test('a failed attempt, the replace question and a success never log, store or route the code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method).mockImplementation(() => {}));
    try {
      respond = (body) => (body.replace === true ? json(RECOVERED) : problem(409));
      const view = await renderRecover();
      await submit(view, 'k7qm 3xwp 9rtd h2vb');
      await screen.findByRole('heading', { name: /already has progress/i });
      expect(holdsCode(everythingKept(view))).toBe(false);

      await view.user.click(screen.getByRole('button', { name: "Keep this device's progress" }));
      respond = () => problem(422);
      await view.user.click(submitButton());
      await screen.findByRole('alert');
      expect(holdsCode(everythingKept(view))).toBe(false);

      respond = (body) => (body.replace === true ? json(RECOVERED) : problem(409));
      await view.user.click(submitButton());
      await view.user.click(await screen.findByRole('button', { name: /^replace this device's progress/i }));
      await waitFor(() => expect(pathname(view)).toBe('/train'));
      expect(holdsCode(everythingKept(view))).toBe(false);
    } finally {
      for (const spy of spies) {
        expect(spy.mock.calls.map((args) => args.map(String).join(' ')).some(holdsCode)).toBe(false);
        spy.mockRestore();
      }
    }
  });

  test('the field is emptied by leaving the screen: a new visit starts with nothing typed', async () => {
    const view = await renderRecover();
    await enter(view, CODE);
    view.unmount();
    cleanup();
    const again = await renderRecover();
    expect(codeInput().value).toBe('');
    expect(again.store.getItem(LAST_PLAYER_KEY)).toBe(PREVIOUS);
  });
});

// --- kk, ru, en -----------------------------------------------------------------------------------------------------

describe('languages', () => {
  test.each([...LOCALES])('%s: title, label, hint, button and the empty state come from the bundle', async (locale) => {
    await renderRecover({ locale });
    const m = messages[locale];
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(m.title);
    expect(screen.getByRole('textbox', { name: m.label })).toBeTruthy();
    expect(describedBy(screen.getByRole('textbox', { name: m.label }))).toContain(m.hint);
    expect((screen.getByRole('button', { name: m.submit }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.noCode)).toBeTruthy();
  });

  test.each([...LOCALES])('%s: the wrong-code, rate-limit and replace texts come from the bundle', async (locale) => {
    const m = messages[locale];
    respond = () => problem(422);
    const view = await renderRecover({ locale });
    const input = screen.getByRole('textbox', { name: m.label });
    await view.user.click(input);
    await view.user.type(input, CODE);
    await view.user.click(screen.getByRole('button', { name: m.submit }));
    expect((await screen.findByRole('alert')).textContent).toContain(m.wrong);

    respond = () => problem(429);
    await view.user.click(screen.getByRole('button', { name: m.submit }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(m.rateLimited));

    respond = () => problem(409);
    await view.user.click(screen.getByRole('button', { name: m.submit }));
    expect((await screen.findByRole('heading', { name: m.confirmTitle })).textContent).toBe(m.confirmTitle);
    expect(screen.getByText(m.confirmBody)).toBeTruthy();
    expect(screen.getByRole('button', { name: m.replace })).toBeTruthy();
    expect(screen.getByRole('button', { name: m.keep })).toBeTruthy();
  });

  test('kk and ru are written (not the English text) and every restore key exists in all three', () => {
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      expect(typeof messages.kk[key]).toBe('string');
      expect(typeof messages.ru[key]).toBe('string');
      expect(messages.kk[key]).not.toBe(messages.en[key]);
      expect(messages.ru[key]).not.toBe(messages.en[key]);
    }
  });
});
