import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Locale } from '@api-types/primitives';
import { TodaySession } from '@api-types/session';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { collectSlot } from '../../lib/slots';
import { DrillPlayerDepsContext, Route } from '../../routes/train/drill.$itemId';
import trustBadgeMessages from '../commons/trust-badge.messages';
import drillPlayerMessages from '../train/drill-player.messages';
import * as drillExtraModule from './drill-extra';
import DrillExtra, { ExplainControl } from './drill-extra';
import explainMessages from './explain.messages';

// Same happy-dom guard as features/ai/ai-plan.test.tsx: the bead verifies from apps/web (the preload registers the DOM there),
// but a run from the repo root has none, so register it BEFORE Testing Library is imported.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare with === and assert on the boolean instead.

/*
 * fc-mol-zo6.10, written from the bead's acceptance criteria (not from the implementation): the `drill` slot component
 * (features/ai/drill-extra.tsx) adds "Explain more simply" to the drill player; the answer appears in a SEPARATE panel labelled
 * "AI-generated — the coach's original text is above" and never replaces the canonical instructions or the safety note;
 * unavailable / offline shows a calm message; loading, empty, error, disabled and success states; the button is disabled while a
 * request is in flight; strings in kk, ru and en.
 *
 * What is real: the component, the typed client (`createApi`, with the real Zod-parsing of the shared contract), the React Query
 * cache, the i18n bundle and, in the last describe, the real drill player route with the component in its `drill` slot. What is
 * replaced: `fetch` (the fake server below). Fixtures are test data only and are parsed with the shared contract schema.
 *
 * Readings the tests pin (the simplest reading each time):
 *  - the request is POST /api/player/drills/<the item's drillVersionId>/explain {locale: <UI language>, audience: 'child'}
 *    ("more simply" is the child audience of the contract);
 *  - a 503 whose problem type is 'ai_unavailable' is the calm "unavailable" note (not an error, no alert); any other failure is an
 *    error with a retry; a 404 (unknown / unpublished version) is a calm note with nothing to retry;
 *  - GET /health `aiAvailable: false` shows the calm note and no button; an unreadable /health keeps the control;
 *  - offline: the calm offline note and a disabled button, no request at all; a shown explanation stays visible;
 *  - the explanation belongs to one drill version and one language: a swap (new drillVersionId) or a language change clears it.
 */

const NAME = 'Explain more simply';
const LABEL = "AI-generated — the coach's original text is above";
const EXPLAIN_TEXT = 'Put five cones in a line.\nPush the ball around each cone with small touches.';

// --- fixtures (test data only: nothing here ships) ---------------------------------------------------------------------

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

const SLALOM = {
  itemId: 'item-2',
  drillVersionId: 'slalom-v3',
  minutes: 8,
  done: false,
  reason: 'focus',
  status: 'REVIEWED',
  attribution,
  content: {
    title: { en: 'Cone slalom', ru: 'Слалом', kk: 'Слалом' },
    goal: { en: 'Keep the ball close through every cone.', ru: 'Веди мяч близко ко всем конусам.', kk: 'Допты әр конустан өткізе жақын ұста.' },
    instructions: {
      en: '1. Set five cones in a line.\n2. Dribble through them with small touches.',
      ru: '1. Поставь пять конусов в линию.\n2. Проведи мяч мелкими касаниями.',
      kk: '1. Бес конусты бір сызыққа қой.\n2. Допты ұсақ жанасумен өткіз.',
    },
    dose: { reps: 20 },
    conditions: { equipment: 'cones', spaces: ['yard'] },
    safety: [{ en: 'Check the ground for holes and stones.' }, { en: 'Stop straight away if something hurts.' }],
  },
};

const OTHER = {
  itemId: 'item-3',
  drillVersionId: 'first-touch-v1',
  minutes: 7,
  done: false,
  reason: 'focus',
  status: 'COMMUNITY',
  attribution,
  content: {
    title: { en: 'First touch', ru: 'Первое касание', kk: 'Бірінші жанасу' },
    goal: { en: 'Control the ball with one touch.', ru: 'Останови мяч одним касанием.', kk: 'Допты бір жанасумен тоқтат.' },
    instructions: { en: 'Pass to the wall and stop the ball.', ru: 'Пас в стену и останови мяч.', kk: 'Қабырғаға пас беріп, допты тоқтат.' },
    dose: { reps: 10 },
    conditions: { equipment: 'ball', spaces: ['yard'] },
  },
};

const session = (items: unknown[] = [SLALOM, OTHER]): TodaySession =>
  TodaySession.parse({
    id: 'session-1',
    date: '2026-09-21',
    planner: 'rules',
    totalMinutes: 15,
    graphVersion: '0.1.0',
    items,
    roadmapSummary: {
      currentLevelLabel: 'Basic',
      sessionsPerWeek: 3,
      minutesPerSession: 20,
      focus: [
        { skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' },
        { skill: 'weak-foot', level: 1, targetLevel: 2, reason: 'weakest' },
      ],
    },
  });

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number, patch: Record<string, unknown> = {}) =>
  json({ type: 'about:blank', title: 'Problem', status, errors: [], ...patch }, status, 'application/problem+json');
const unavailable = () => problem(503, { type: 'ai_unavailable', title: 'Service Unavailable', detail: 'PROVIDER-SECRET-DETAIL' });
const health = (patch: Record<string, unknown> = {}) => json({ ok: true, version: '0.1.0', database: 'ok', aiAvailable: true, ...patch });
const explained = (text = EXPLAIN_TEXT, versionId = 'slalom-v3') => json({ text, aiGenerated: true, basedOnVersionId: versionId });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// --- rig -----------------------------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let onLine = true;

/*
 * Cross-file hygiene. bun runs every test file of the web package in ONE process with ONE happy-dom window, so whatever this file
 * leaves on the window/document is still there for the files that run after it. happy-dom records every element query it has
 * answered (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the document and on <html>
 * (`affectsCache`, `affectsComputedStyleCache`) and in the window's selector cache, and never trims them; a heavy file leaves a pile
 * that slows (and can time out) LATER files in the whole-package run. After every test the DOM is empty, so the lists are emptied the
 * way happy-dom itself empties them when a node changes: every recorded result is invalidated first, then the list is cleared. Same
 * pattern as features/contribute/form.test.tsx and features/ai/ai-plan.test.tsx. Written against happy-dom 20.x symbols by
 * description; if they are not there it does nothing.
 */
function resetHappyDomCaches(): void {
  const targets: object[] = [document, document.documentElement, document.body, window];
  for (const target of targets) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if ((symbol.description === 'affectsCache' || symbol.description === 'affectsComputedStyleCache') && Array.isArray(value)) {
        for (const entry of value) if (typeof entry === 'object' && entry !== null) (entry as { result: unknown }).result = null;
        value.length = 0;
      } else if (symbol.description === 'querySelectorCache' && value instanceof Map) {
        value.clear();
      }
    }
  }
}

beforeEach(() => {
  onLine = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
});

afterEach(() => {
  cleanup();
  // Every global this file patches: the online flag and fetch (the drill-route describe stubs it).
  delete (navigator as { onLine?: boolean }).onLine;
  globalThis.fetch = realFetch;
  resetHappyDomCaches();
});

const goOffline = () =>
  act(() => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });
const goOnline = () =>
  act(() => {
    onLine = true;
    window.dispatchEvent(new Event('online'));
  });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

const MODULES = {
  './explain.messages.ts': { default: explainMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
  '../train/drill-player.messages.ts': { default: drillPlayerMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const EXPLAIN_PATH = (versionId: string) => `/api/player/drills/${versionId}/explain`;

interface Setup {
  locale?: Locale;
  itemId?: string;
  /** The ['today'] cache. `null` = nothing cached. Default: a session with the slalom (item-2) and a second drill. */
  cached?: TodaySession | null;
  health?: () => Response | Promise<Response>;
  explain?: (call: Call) => Response | Promise<Response>;
}

/** The fake server, as a fetch: what both the injected client and (in the drill-route describe) the global fetch answer with. */
function fakeServer(setup: Setup, calls: Call[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    if (!onLine) throw new TypeError('Failed to fetch');
    if (input.startsWith('/health')) return (setup.health ?? (() => health()))();
    if (input.startsWith('/api/player/drills/') && input.endsWith('/explain')) return (setup.explain ?? (() => explained()))(call);
    throw new Error(`unexpected request ${input}`);
  };
}

function providers(setup: Setup, children: ReactNode) {
  const locale = setup.locale ?? 'en';
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (setup.cached !== null) queryClient.setQueryData(['today'], setup.cached ?? session());
  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  return {
    queryClient,
    i18n,
    tree: (
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </QueryClientProvider>
    ),
  };
}

function mount(setup: Setup = {}) {
  const calls: Call[] = [];
  const api = createApi({ fetch: fakeServer(setup, calls), language: () => setup.locale ?? 'en', online: () => onLine });
  const { queryClient, i18n, tree } = providers(setup, <ExplainControl itemId={setup.itemId ?? 'item-2'} api={api} />);
  const view = render(tree);
  const explains = () => calls.filter((call) => call.url.endsWith('/explain'));
  return { user: userEvent.setup(), view, calls, explains, queryClient, i18n };
}

const control = (name = NAME) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;
const panel = (name = LABEL) => screen.queryByRole('region', { name });
const asText = (element: Element | null) => (element === null ? null : element.textContent);

// --- the slot module --------------------------------------------------------------------------------------------------------

describe('the slot module', () => {
  test('default-exports ONE component that takes no props, so the drill player can mount it in its `drill` slot', () => {
    const [component] = collectSlot({ drill: { '../features/ai/drill-extra.tsx': drillExtraModule } }, 'drill');
    expect(component === (DrillExtra as unknown)).toBe(true);
    expect(collectSlot({ drill: { '../features/ai/drill-extra.tsx': drillExtraModule } }, 'drill')).toHaveLength(1);
    expect(DrillExtra.length).toBe(0);
  });
});

// --- idle, empty -----------------------------------------------------------------------------------------------------------

describe('idle: the control', () => {
  test('offers "Explain more simply" (enabled) under a heading of the same name, and asks for nothing yet', async () => {
    const { explains } = mount();
    expect(screen.getByRole('heading', { level: 2, name: NAME })).toBeTruthy();
    const button = control();
    expect(button === null).toBe(false);
    expect(button?.disabled).toBe(false);
    expect(panel() === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(explains()).toEqual([]);
  });

  test('says that the coach\'s text stays as it is', () => {
    mount();
    expect(screen.getByText(/coach's text above stays exactly as it is/)).toBeTruthy();
  });

  test('empty: nothing is rendered when there is no session in the [today] cache, or no such drill in it', () => {
    const none = mount({ cached: null });
    expect(none.view.container.textContent).toBe('');
    cleanup();
    const unknown = mount({ itemId: 'no-such-item' });
    expect(unknown.view.container.textContent).toBe('');
    expect(unknown.calls).toEqual([]);
  });
});

// --- success ---------------------------------------------------------------------------------------------------------------

describe('a successful explanation', () => {
  test('one POST to the drill version\'s explain endpoint with the UI locale, audience "child" and an abort signal that has not fired', async () => {
    const { user, explains } = mount({ locale: 'ru' });
    await user.click(control('Объяснить проще') as HTMLButtonElement);
    await waitFor(() => expect(explains().length).toBe(1));
    const [call] = explains();
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(EXPLAIN_PATH('slalom-v3'));
    expect(call?.body).toEqual({ locale: 'ru', audience: 'child' });
    expect(call?.signal === undefined || call?.signal === null).toBe(false);
    expect(call?.signal?.aborted).toBe(false);
  });

  test('the version id of the item that was asked for is in the path (a second drill uses its own)', async () => {
    const { user, explains } = mount({ itemId: 'item-3', explain: () => explained('Stop the ball.', 'first-touch-v1') });
    await user.click(control() as HTMLButtonElement);
    await screen.findByText('Stop the ball.');
    expect(explains().map((call) => call.url)).toEqual([EXPLAIN_PATH('first-touch-v1')]);
  });

  test('the answer appears in a separate region named "AI-generated — the coach\'s original text is above", as text', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });
    const region = panel() as HTMLElement;
    expect(region.textContent).toContain(LABEL);
    expect(region.textContent).toContain('Put five cones in a line.');
    expect(region.textContent).toContain('Push the ball around each cone with small touches.');
    // A written label AND an icon: never colour alone.
    expect(region.querySelector('svg') === null).toBe(false);
    // The label is a heading of the region, so it is also findable in the outline of the page.
    expect(within(region).getByRole('heading', { name: LABEL }) === null).toBe(false);
  });

  test('the explanation is kept exactly as sent, line breaks included (plain text, never reformatted)', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);
    const region = await screen.findByRole('region', { name: LABEL });
    const body = Array.from(region.querySelectorAll('p')).find((element) => element.textContent === EXPLAIN_TEXT);
    expect(body === undefined).toBe(false);
    expect(body?.textContent).toBe(EXPLAIN_TEXT);
    // happy-dom loads no CSS, so the only thing checkable is the mechanism that keeps the line breaks visible.
    expect((body as Element).className).toMatch(/whitespace-pre/);
  });

  test('the explanation is a text node: markup, markdown and links in it are shown literally, never interpreted', async () => {
    const hostile = '<b>Bold</b> <img src="x" onerror="alert(1)"> **stars** [link](https://example.com) <script>alert(2)</script>';
    const { user } = mount({ explain: () => explained(hostile) });
    await user.click(control() as HTMLButtonElement);
    const region = await screen.findByRole('region', { name: LABEL });
    expect(region.textContent).toContain(hostile);
    expect(region.querySelector('b, strong, em, img, a, script, iframe, style, ul, ol, li, code') === null).toBe(true);
  });

  test('keyboard focus moves to the result, because the button that started the request is gone', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);
    const region = await screen.findByRole('region', { name: LABEL });
    const heading = within(region).getByRole('heading', { name: LABEL });
    await waitFor(() => expect(document.activeElement === heading).toBe(true));
    expect(control() === null).toBe(true);
  });

  test('the drill stays as it was: the [today] session in the cache is untouched by an explanation', async () => {
    const before = session();
    const { user, queryClient } = mount({ cached: before });
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });
    expect(queryClient.getQueryData(['today']) === before).toBe(true);
    expect(JSON.stringify(queryClient.getQueryData(['today']))).toBe(JSON.stringify(session()));
  });
});

// --- loading, disabled -----------------------------------------------------------------------------------------------------

describe('in flight', () => {
  test('the button is disabled and busy, progress is announced in words, a second click sends nothing, and it ends with the answer', async () => {
    const gate = deferred<Response>();
    const { user, explains } = mount({ explain: () => gate.promise });
    const button = control() as HTMLButtonElement;
    await user.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.getAttribute('aria-busy')).toBe('true');
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('AI is rewriting this drill in simpler words');
    expect(panel() === null).toBe(true);

    await user.click(button);
    fireEvent.click(button);
    expect(explains()).toHaveLength(1);

    await act(async () => gate.resolve(explained()));
    await screen.findByRole('region', { name: LABEL });
    expect(screen.queryByText(/AI is rewriting this drill/) === null).toBe(true);
    expect(explains()).toHaveLength(1);
  });

  test('leaving the drill (unmounting) aborts the request', async () => {
    const gate = deferred<Response>();
    const { user, view, explains } = mount({ explain: () => gate.promise });
    await user.click(control() as HTMLButtonElement);
    await waitFor(() => expect(explains()).toHaveLength(1));
    const signal = explains()[0]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});

// --- unavailable, gone -----------------------------------------------------------------------------------------------------

describe('unavailable', () => {
  test('a 503 "ai_unavailable" is a calm note (a status, not an alert), the server\'s text is not shown, and asking again is possible', async () => {
    let answer: () => Response = unavailable;
    const { user, explains } = mount({ explain: () => answer() });
    await user.click(control() as HTMLButtonElement);

    await screen.findByText('AI explanations are not available right now.');
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getByText(/coach's text above is all you need/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('PROVIDER-SECRET-DETAIL');
    expect(panel() === null).toBe(true);

    // Calm, and not a dead end: the button is back (enabled) and a second try can succeed.
    answer = () => explained();
    const again = control('Try again') as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await user.click(again);
    await screen.findByRole('region', { name: LABEL });
    expect(explains()).toHaveLength(2);
    expect(screen.queryByText('AI explanations are not available right now.') === null).toBe(true);
  });

  test('a 503 that is NOT the AI\'s (no such problem type) is an error with a retry, not the calm note', async () => {
    const { user } = mount({ explain: () => problem(503) });
    await user.click(control() as HTMLButtonElement);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Try again' }) === null).toBe(false);
    expect(screen.queryByText('AI explanations are not available right now.') === null).toBe(true);
  });

  test('/health says there is no AI: the calm note, no button, and no explain request', async () => {
    const { calls, explains } = mount({ health: () => health({ aiAvailable: false }) });
    await screen.findByText('AI explanations are not switched on here.');
    expect(control() === null).toBe(true);
    expect(screen.getByText(/coach's text above is all you need/)).toBeTruthy();
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(calls.some((call) => call.url.startsWith('/health'))).toBe(true);
    expect(explains()).toEqual([]);
  });

  test('a /health that cannot be read (or an old one with no such field) keeps the control', async () => {
    for (const reply of [() => problem(500), () => json({ ok: true, version: '0.1.0', database: 'ok' })]) {
      const { calls } = mount({ health: reply });
      await waitFor(() => expect(calls.some((call) => call.url.startsWith('/health'))).toBe(true));
      await act(async () => {});
      expect(control() === null).toBe(false);
      expect(screen.queryByText('AI explanations are not switched on here.') === null).toBe(true);
      cleanup();
    }
  });

  test('a 404 (the drill version is unknown or unpublished) is a calm note with nothing to retry', async () => {
    const { user, explains } = mount({ explain: () => problem(404, { title: 'Not Found' }) });
    await user.click(control() as HTMLButtonElement);
    await screen.findByText("We can't explain this version of the drill.");
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(control() === null).toBe(true);
    expect(explains()).toHaveLength(1);
  });
});

// --- error -----------------------------------------------------------------------------------------------------------------

describe('error', () => {
  test('a failed request shows an error with a retry (localised, not the server\'s text); retrying resends and succeeds', async () => {
    let answer: () => Response = () => problem(500, { detail: 'SERVER-INTERNALS' });
    const { user, explains } = mount({ explain: () => answer() });
    await user.click(control() as HTMLButtonElement);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not get an explanation');
    expect(document.body.textContent).not.toContain('SERVER-INTERNALS');
    expect(panel() === null).toBe(true);

    answer = () => explained();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('region', { name: LABEL });
    expect(screen.queryByRole('alert') === null).toBe(true);
    expect(explains()).toHaveLength(2);
  });

  test('an answer that breaks the contract (aiGenerated is not true) is an error, never shown as an explanation', async () => {
    const { user } = mount({ explain: () => json({ text: 'Sneaky.', aiGenerated: false, basedOnVersionId: 'slalom-v3' }) });
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('Sneaky.');
    expect(panel() === null).toBe(true);
  });

  test('while the retry is in flight the error is replaced by progress and a disabled, busy button that a second click cannot re-send', async () => {
    const gate = deferred<Response>();
    let step = 0;
    const { user, explains } = mount({ explain: () => (step++ === 0 ? problem(500) : gate.promise) });
    await user.click(control() as HTMLButtonElement);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByRole('alert') === null).toBe(true));
    const busy = control() as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('AI is rewriting this drill in simpler words');
    await user.click(busy);
    fireEvent.click(busy);
    expect(explains()).toHaveLength(2);
    await act(async () => gate.resolve(explained()));
    await screen.findByRole('region', { name: LABEL });
  });
});

// --- offline ---------------------------------------------------------------------------------------------------------------

describe('offline', () => {
  test('a calm offline note and a disabled button (with its reason), no request at all; back online it works', async () => {
    onLine = false;
    const { user, calls, explains } = mount();
    const note = screen.getByText(/You are offline/);
    expect(note.closest('[role="status"]') === null).toBe(false);
    expect(screen.queryByRole('alert') === null).toBe(true);
    const button = control() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy === null).toBe(false);
    expect(document.getElementById(describedBy as string)?.textContent).toContain('You are offline');
    expect(calls).toEqual([]);

    await goOnline();
    await waitFor(() => expect((control() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/You are offline/) === null).toBe(true);
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });
    expect(explains()).toHaveLength(1);
  });

  test('going offline hides no explanation that is already on screen (it is content, not a control)', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });
    await goOffline();
    expect(panel() === null).toBe(false);
    expect(screen.getByText(/Put five cones in a line\./)).toBeTruthy();
  });

  test('a request that fails because the connection dropped in flight is the calm offline error with a retry', async () => {
    const gate = deferred<Response>();
    const { user } = mount({ explain: () => gate.promise });
    await user.click(control() as HTMLButtonElement);
    await goOffline();
    await act(async () => gate.reject(new TypeError('Failed to fetch')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/offline|connection/i);
    expect(alert.textContent).not.toContain('undefined');
  });
});

// --- a swap, a language change --------------------------------------------------------------------------------------------

describe('the explanation belongs to one drill version and one language', () => {
  test('after a swap (the item now holds another drillVersionId) the old explanation is gone and the next request names the new version', async () => {
    const { user, queryClient, explains } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });

    act(() => {
      queryClient.setQueryData(['today'], session([{ ...SLALOM, drillVersionId: 'slow-slalom-v1' }, OTHER]));
    });
    await waitFor(() => expect(panel() === null).toBe(true));
    expect(screen.queryByText(/Put five cones in a line\./) === null).toBe(true);
    expect((control() as HTMLButtonElement).disabled).toBe(false);

    await user.click(control() as HTMLButtonElement);
    await waitFor(() => expect(explains()).toHaveLength(2));
    expect(explains()[1]?.url).toBe(EXPLAIN_PATH('slow-slalom-v1'));
  });

  test('a reply to a request for the OLD version, arriving after a swap, is not shown', async () => {
    const gate = deferred<Response>();
    const { user, queryClient } = mount({ explain: () => gate.promise });
    await user.click(control() as HTMLButtonElement);
    act(() => {
      queryClient.setQueryData(['today'], session([{ ...SLALOM, drillVersionId: 'slow-slalom-v1' }, OTHER]));
    });
    await act(async () => gate.resolve(explained('Old text.')));
    expect(screen.queryByText('Old text.') === null).toBe(true);
    expect(panel() === null).toBe(true);
  });

  test('changing the language clears the explanation (it was written in the old language) and the next request uses the new one', async () => {
    const { user, i18n, explains } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByRole('region', { name: LABEL });

    await act(async () => {
      await i18n.changeLanguage('ru');
    });
    await waitFor(() => expect(control('Объяснить проще') === null).toBe(false));
    expect(screen.queryByText(/Put five cones in a line\./) === null).toBe(true);
    await user.click(control('Объяснить проще') as HTMLButtonElement);
    await waitFor(() => expect(explains()).toHaveLength(2));
    expect(explains()[1]?.body).toEqual({ locale: 'ru', audience: 'child' });
  });
});

// --- kk, ru, en ------------------------------------------------------------------------------------------------------------

const flatten = (value: unknown, prefix = ''): string[] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
    : [prefix];

describe('kk, ru and en', () => {
  const COPY = {
    kk: { action: 'Қарапайым түсіндіру', label: 'ЖИ жасаған — жаттықтырушының түпнұсқа мәтіні жоғарыда' },
    ru: { action: 'Объяснить проще', label: 'Создано ИИ — оригинальный текст тренера выше' },
    en: { action: NAME, label: LABEL },
  } as const;

  for (const locale of ['kk', 'ru', 'en'] as const) {
    test(`${locale}: the control, the request's locale, the panel label and every state read in the language, with no raw key or placeholder`, async () => {
      const { user, explains } = mount({ locale });
      const { action, label } = COPY[locale];
      expect(screen.getByRole('heading', { level: 2, name: action })).toBeTruthy();
      await user.click(control(action) as HTMLButtonElement);
      await screen.findByRole('region', { name: label });
      expect(explains()[0]?.body).toEqual({ locale, audience: 'child' });
      expect(document.body.textContent).not.toMatch(/undefined|NaN|\{\{|explain:/);
    });
  }

  test('the bundle has the same keys in kk, ru and en, and each string is non-empty and free of {{placeholders}} it does not fill', () => {
    const kinds = ['kk', 'ru', 'en'] as const;
    const keys = kinds.map((locale) => flatten(explainMessages[locale]).sort());
    expect(keys[0]).toEqual(keys[2]);
    expect(keys[1]).toEqual(keys[2]);
    expect(keys[2]?.length).toBeGreaterThan(8);
    for (const locale of kinds) {
      const walk = (value: unknown): void => {
        if (typeof value === 'string') {
          expect(value.trim()).not.toBe('');
          expect(value).not.toMatch(/\{\{/);
        } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
      };
      walk(explainMessages[locale]);
    }
  });

  test('the Kazakh and Russian panel labels are the ones pinned here, and unavailable/offline notes exist in Cyrillic', () => {
    expect(JSON.stringify(explainMessages.kk)).toContain(COPY.kk.label);
    expect(JSON.stringify(explainMessages.ru)).toContain(COPY.ru.label);
    expect(JSON.stringify(explainMessages.en)).toContain(COPY.en.label);
  });
});

// --- inside the real drill player ------------------------------------------------------------------------------------------

describe('in the real drill player (the `drill` slot)', () => {
  async function mountDrill(setup: Setup = {}) {
    const calls: Call[] = [];
    // The slot component takes no props, so it reads the app-wide client, whose fetch is the global one (looked up per call).
    globalThis.fetch = mock(fakeServer(setup, calls)) as unknown as typeof fetch;
    const drillApi = createApi({ fetch: async () => new Response('not found', { status: 404 }), online: () => onLine });
    const ensureSession = mock(async () => ({ user: { id: 'player-1' } }));
    const { queryClient, tree } = providers(setup, <DrillPageHost />);

    function DrillPageHost() {
      return (
        <DrillPlayerDepsContext.Provider
          value={{
            api: drillApi,
            ensureSession,
            navigate: () => {},
            timeZone: () => 'Asia/Almaty',
            isOnline: () => onLine,
            slots: [DrillExtra as ComponentType],
          }}
        >
          <RouterProvider router={router} />
        </DrillPlayerDepsContext.Provider>
      );
    }
    const rootRoute = createRootRoute();
    const drillRoute = Route.update({ id: '/train/drill/$itemId', path: '/train/drill/$itemId', getParentRoute: () => rootRoute } as never);
    const router = createRouter({
      routeTree: rootRoute.addChildren([drillRoute as never]),
      history: createMemoryHistory({ initialEntries: [`/train/drill/${encodeURIComponent(setup.itemId ?? 'item-2')}`] }),
    });
    await router.load();
    const view = render(tree);
    return { ...view, user: userEvent.setup(), calls, queryClient, explains: () => calls.filter((call) => call.url.endsWith('/explain')) };
  }

  test('the component finds its drill from the route (no props) and asks for THAT version', async () => {
    const page = await mountDrill({ locale: 'en' });
    const button = await screen.findByRole('button', { name: NAME });
    await page.user.click(button);
    await screen.findByRole('region', { name: LABEL });
    expect(page.explains().map((call) => call.url)).toEqual([EXPLAIN_PATH('slalom-v3')]);
  });

  test('it renders inside data-slot="drill", after the canonical content', async () => {
    const page = await mountDrill();
    const button = await screen.findByRole('button', { name: NAME });
    const slot = page.container.querySelector('[data-slot="drill"]') as HTMLElement;
    expect(slot === null).toBe(false);
    expect(slot.contains(button)).toBe(true);
    const how = await screen.findByRole('heading', { name: 'How to do it' });
    expect(how.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the answer never replaces the canonical instructions or the safety note: they are the same nodes with the same text, before the panel', async () => {
    const page = await mountDrill();
    const how = (await screen.findByRole('heading', { name: 'How to do it' })).parentElement as HTMLElement;
    const safety = (await screen.findByRole('region', { name: 'Safety' })) as HTMLElement;
    const howHtml = how.innerHTML;
    const safetyHtml = safety.innerHTML;
    expect(how.textContent).toContain('Set five cones in a line.');
    expect(safety.textContent).toContain('Check the ground for holes and stones.');

    await page.user.click(await screen.findByRole('button', { name: NAME }));
    const region = await screen.findByRole('region', { name: LABEL });

    // The canonical blocks are still in the page, untouched, and the explanation is in none of them.
    expect(how.isConnected && safety.isConnected).toBe(true);
    expect(how.innerHTML).toBe(howHtml);
    expect(safety.innerHTML).toBe(safetyHtml);
    expect(how.contains(region) || safety.contains(region)).toBe(false);
    expect(how.textContent).not.toContain('Put five cones in a line.');
    expect(safety.textContent).not.toContain('Put five cones in a line.');
    expect(region.textContent).toContain('Put five cones in a line.');
    expect(within(region).queryByText('Check the ground for holes and stones.') === null).toBe(true);
    // The panel comes AFTER the canonical text ("the coach's original text is above").
    expect(how.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(safety.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('when the AI is unavailable the canonical instructions and safety note are all still there, with the calm note', async () => {
    const page = await mountDrill({ explain: () => unavailable() });
    const how = (await screen.findByRole('heading', { name: 'How to do it' })).parentElement as HTMLElement;
    const safetyHtml = (await screen.findByRole('region', { name: 'Safety' })).innerHTML;
    await page.user.click(await screen.findByRole('button', { name: NAME }));
    await screen.findByText('AI explanations are not available right now.');
    expect(how.textContent).toContain('Dribble through them with small touches.');
    expect((screen.getByRole('region', { name: 'Safety' }) as HTMLElement).innerHTML).toBe(safetyHtml);
  });

  test('offline in the drill player: the drill is there, the note is calm and the button is disabled', async () => {
    onLine = false;
    await mountDrill();
    await screen.findByRole('heading', { name: 'How to do it' });
    expect(screen.getAllByText(/You are offline/).length).toBeGreaterThan(0);
    expect((control() as HTMLButtonElement).disabled).toBe(true);
  });
});
