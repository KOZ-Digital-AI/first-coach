import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Locale } from '@api-types/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { collectSlot } from '../../lib/slots';
import aiPlanMessages from './ai-plan.messages';
import * as todayExtraModule from './today-extra';
import TodayExtra, { AiPlanControl } from './today-extra';

// Same happy-dom guard as features/offline/download.test.tsx: the bead verifies from apps/web (the preload registers the DOM
// there), but a run from the repo root has none, so register it BEFORE Testing Library is imported.
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * fc-mol-zo6.9, written from the bead's acceptance criteria (not from the implementation): the `today` slot component
 * (features/ai/today-extra.tsx) shows "Personalise with AI" with an optional short note field; while running it shows progress
 * and keeps the current session usable; on planner 'ai' the session updates with an "AI-personalised from approved drills" tag
 * and a reason under each drill; on planner 'rules' it shows the quiet note "AI is unavailable — here is your standard plan"
 * (no error toast); hidden when offline or when the setting disables it; loading, empty, error, disabled and success states;
 * the mutation button is disabled while a request is in flight; strings in kk, ru and en.
 *
 * What is real: the component, the typed client (`createApi`, with the real Zod-parsing of the shared contract), the React
 * Query cache and the i18n bundle. What is replaced: `fetch` (the fake server below). Fixtures are test data only.
 */

const TODAY_DATE = '2026-09-21';
const PLAN_PATH = '/api/player/today/ai-plan';
const REASON_3 = 'Gentle ball taps keep your ankle moving without strain.';
const REASON_4 = 'Wall passes build your first touch with little running.';
const NAME = 'Personalise with AI';
const STANDARD = 'AI is unavailable — here is your standard plan.';

// --- fixtures ----------------------------------------------------------------------------------------------------------

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

const item = (itemId: string, title: string, patch: Record<string, unknown> = {}) => ({
  itemId,
  drillVersionId: `${itemId}-v1`,
  minutes: 5,
  done: false,
  content: {
    title: { kk: `${title} (kk)`, ru: `${title} (ru)`, en: title },
    goal: { kk: 'Мақсат', ru: 'Цель', en: 'Goal' },
    instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
    dose: { reps: 20 },
    conditions: { equipment: 'ball', spaces: ['yard'] },
  },
  status: 'COMMUNITY',
  attribution,
  ...patch,
});

const session = (patch: Record<string, unknown> = {}) => ({
  id: 'session-1',
  date: TODAY_DATE,
  planner: 'rules',
  totalMinutes: 10,
  graphVersion: '0.1.0',
  items: [item('item-1', 'Ball taps', { reason: 'warmup' }), item('item-2', 'Toe touches', { reason: 'focus' })],
  roadmapSummary: {
    currentLevelLabel: 'Basic',
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: [{ skill: 'dribbling', level: 2, targetLevel: 3, reason: 'goal' }],
  },
  ...patch,
});

/** What the server answers for a successful plan: the SAME session shape, planner 'ai', a reason on every item. */
const aiSession = () =>
  session({
    planner: 'ai',
    totalMinutes: 12,
    items: [item('item-3', 'Soft ball taps', { reason: REASON_3, minutes: 6 }), item('item-4', 'Wall passes', { reason: REASON_4, minutes: 6 })],
  });

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const serverError = () => json({ type: 'about:blank', title: 'Problem', status: 500 }, 500, 'application/problem+json');
const health = (patch: Record<string, unknown> = {}) => json({ ok: true, version: '0.1.0', database: 'ok', aiAvailable: true, ...patch });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// --- rig -----------------------------------------------------------------------------------------------------------------

let onLine = true;

beforeEach(() => {
  onLine = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
});

afterEach(() => {
  cleanup();
  delete (navigator as { onLine?: boolean }).onLine;
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
  './ai-plan.messages.ts': { default: aiPlanMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

interface Setup {
  locale?: Locale;
  /** The ['today'] cache. `null` = nothing cached. Default: a deterministic (planner 'rules') session. */
  cached?: unknown;
  /** How the fake server answers /health. */
  health?: () => Response | Promise<Response>;
  /** How the fake server answers the plan request. */
  plan?: (call: Call) => Response | Promise<Response>;
  timeZone?: () => string | undefined;
}

function mount(setup: Setup = {}) {
  const locale = setup.locale ?? 'en';
  const calls: Call[] = [];
  const api = createApi({
    fetch: async (input: string, init?: RequestInit) => {
      const call: Call = {
        url: input,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
      };
      calls.push(call);
      if (input.startsWith('/health')) return (setup.health ?? (() => health()))();
      if (input.startsWith(PLAN_PATH)) return (setup.plan ?? (() => json(aiSession())))(call);
      throw new Error(`unexpected request ${input}`);
    },
    language: () => locale,
    online: () => onLine,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (setup.cached !== null) queryClient.setQueryData(['today'], setup.cached ?? session());
  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <AiPlanControl api={api} timeZone={setup.timeZone ?? (() => 'Asia/Almaty')} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  const plans = () => calls.filter((call) => call.url.startsWith(PLAN_PATH));
  return { user: userEvent.setup(), view, calls, plans, queryClient };
}

const control = (name = NAME) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;
const noteField = () => screen.queryByLabelText(/Anything the coach should know/) as HTMLTextAreaElement | null;
const cachedToday = (queryClient: QueryClient) => queryClient.getQueryData<Record<string, unknown>>(['today']);

// --- tests ---------------------------------------------------------------------------------------------------------------

describe('idle: the control', () => {
  test('offers "Personalise with AI" (enabled) and a labelled optional note field, and sends nothing yet', async () => {
    const { plans } = mount();
    const button = control();
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(noteField()).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: NAME })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(plans()).toEqual([]);
  });

  test('the note field is limited to 200 characters and says so', () => {
    mount();
    expect(noteField()?.maxLength).toBe(200);
    expect(screen.getByText(/200/)).toBeTruthy();
  });

  test('renders nothing when there is no session in the [today] cache', () => {
    mount({ cached: null });
    expect(control()).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  test('is the default export of a slot module (one component, no props)', () => {
    const [component] = collectSlot({ today: { '../features/ai/today-extra.tsx': todayExtraModule } }, 'today');
    expect(component).toBe(TodayExtra);
    expect(TodayExtra.length).toBe(0);
  });
});

describe('a successful plan (planner "ai")', () => {
  test('one POST to the ai-plan endpoint with the UI locale, the device time zone and an abort signal', async () => {
    const { user, plans } = mount({ locale: 'ru' });
    await user.click(control('Персонализировать с ИИ') as HTMLButtonElement);
    await waitFor(() => expect(plans().length).toBe(1));
    const [call] = plans();
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${PLAN_PATH}?locale=ru`);
    expect(call?.headers.get('X-Timezone')).toBe('Asia/Almaty');
    expect(call?.signal).toBeTruthy();
    expect(call?.signal?.aborted).toBe(false);
  });

  test('renders the "AI-personalised from approved drills" tag and a reason under each drill', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);

    expect(await screen.findByText('AI-personalised from approved drills')).toBeTruthy();
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBe(2);
    expect(within(rows[0] as HTMLElement).getByText('Soft ball taps')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(REASON_3)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Wall passes')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(REASON_4)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(STANDARD)).toBeNull();
  });

  test('writes the returned session into the [today] cache (replace, not merge)', async () => {
    const { user, queryClient } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByText('AI-personalised from approved drills');

    const cached = cachedToday(queryClient) as { planner: string; totalMinutes: number; items: { itemId: string; reason: string }[] };
    expect(cached.planner).toBe('ai');
    expect(cached.totalMinutes).toBe(12);
    expect(cached.items.map((entry) => entry.itemId)).toEqual(['item-3', 'item-4']);
    expect(cached.items.map((entry) => entry.reason)).toEqual([REASON_3, REASON_4]);
  });

  test('once the session is AI-planned the button is gone (the server keeps one paid plan per day)', async () => {
    const { user } = mount();
    await user.click(control() as HTMLButtonElement);
    await screen.findByText('AI-personalised from approved drills');
    expect(control()).toBeNull();
    expect(noteField()).toBeNull();
  });

  test('a session already AI-planned (cached, e.g. after a reload) shows the tag and reasons and sends nothing, even offline', async () => {
    onLine = false;
    const { plans } = mount({ cached: aiSession() });
    expect(screen.getByText('AI-personalised from approved drills')).toBeTruthy();
    expect(screen.getByText(REASON_3)).toBeTruthy();
    expect(screen.getByText(REASON_4)).toBeTruthy();
    expect(control()).toBeNull();
    expect(plans()).toEqual([]);
  });

  test('finished items of an AI session show "Done", not a raw planner key as their reason', () => {
    const cached = { ...aiSession(), items: [item('item-1', 'Ball taps', { reason: 'focus', done: true }), ...aiSession().items] };
    mount({ cached });
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows.length).toBe(3);
    expect(within(rows[0] as HTMLElement).getByText('Done')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByText('focus')).toBeNull();
  });
});

describe('the optional note', () => {
  test('is sent trimmed as {note}', async () => {
    const { user, plans } = mount();
    await user.type(noteField() as HTMLTextAreaElement, '  my ankle is tired  ');
    await user.click(control() as HTMLButtonElement);
    await waitFor(() => expect(plans().length).toBe(1));
    expect(plans()[0]?.body).toEqual({ note: 'my ankle is tired' });
  });

  test('is left out of the body when empty or blank (the contract body is strict {note?})', async () => {
    const { user, plans } = mount();
    await user.type(noteField() as HTMLTextAreaElement, '   ');
    await user.click(control() as HTMLButtonElement);
    await waitFor(() => expect(plans().length).toBe(1));
    expect(plans()[0]?.body).toEqual({});
  });
});

describe('in flight', () => {
  test('the button is disabled and busy, progress is announced in words, and a second tap sends nothing', async () => {
    const pending = deferred<Response>();
    const { user, plans, queryClient } = mount({ plan: () => pending.promise });
    await user.click(control() as HTMLButtonElement);

    const button = control() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(within(screen.getByRole('status')).getByText('The AI coach is planning your session…')).toBeTruthy();
    expect(screen.getByText("You can keep using today's session while you wait.")).toBeTruthy();
    expect(noteField()?.disabled).toBe(true);

    await user.click(button);
    expect(plans().length).toBe(1);
    // The current session stays exactly as it was until the answer arrives.
    expect((cachedToday(queryClient) as { planner: string }).planner).toBe('rules');

    await act(async () => pending.resolve(json(aiSession())));
    await screen.findByText('AI-personalised from approved drills');
  });

  test('two taps in the same tick (before the button can re-render as disabled) send one request', async () => {
    const pending = deferred<Response>();
    const { plans } = mount({ plan: () => pending.promise });
    const button = control() as HTMLButtonElement;
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(plans().length).toBe(1);
    await act(async () => pending.resolve(json(aiSession())));
  });
});

describe('the standard plan (planner "rules" with a fallback code)', () => {
  const REASONS: Record<string, string> = {
    no_key: 'The AI coach is not set up on this server.',
    disabled: 'The AI coach is switched off for now.',
    timeout: 'The AI coach took too long to answer.',
    invalid_output: 'The AI coach suggested a plan that did not pass our checks, so it was not used.',
    provider_error: 'The AI service could not be reached.',
  };

  test.each(Object.entries(REASONS))('code %s: the quiet note plus its own one-sentence reason, no error', async (code, reason) => {
    const { user, queryClient } = mount({ plan: () => json({ ...session(), fallback: { code } }) });
    await user.click(control() as HTMLButtonElement);

    const status = await screen.findByRole('status');
    expect(within(status).getByText(STANDARD)).toBeTruthy();
    expect(within(status).getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('AI-personalised from approved drills')).toBeNull();
    // The session is the unchanged deterministic one, without the fallback key.
    const cached = cachedToday(queryClient) as { planner: string; items: unknown[] };
    expect(cached.planner).toBe('rules');
    expect('fallback' in cached).toBe(false);
    expect(cached.items.length).toBe(2);
  });

  test.each(['timeout', 'invalid_output', 'provider_error'])('code %s: trying again is offered', async (code) => {
    const { user, plans } = mount({ plan: () => json({ ...session(), fallback: { code } }) });
    await user.click(control() as HTMLButtonElement);
    await screen.findByText(STANDARD);
    const again = control('Try AI again') as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await user.click(again);
    await waitFor(() => expect(plans().length).toBe(2));
  });

  test.each(['disabled', 'no_key'])('code %s: nothing to retry, so the button goes and only the note stays', async (code) => {
    const { user } = mount({ plan: () => json({ ...session(), fallback: { code } }) });
    await user.click(control() as HTMLButtonElement);
    await screen.findByText(STANDARD);
    expect(control()).toBeNull();
    expect(control('Try AI again')).toBeNull();
  });

  test('the note is text with an icon, never colour alone (it is a status region, not an alert)', async () => {
    const { user } = mount({ plan: () => json({ ...session(), fallback: { code: 'timeout' } }) });
    await user.click(control() as HTMLButtonElement);
    const status = await screen.findByRole('status');
    expect(status.getAttribute('data-tone')).toBe('info');
    expect(status.querySelector('svg')).not.toBeNull();
  });
});

describe('errors', () => {
  test('a failed request shows an error state with a retry, and the session is untouched', async () => {
    const { user, queryClient } = mount({ plan: () => serverError() });
    await user.click(control() as HTMLButtonElement);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not reach the AI coach')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect((cachedToday(queryClient) as { planner: string }).planner).toBe('rules');
  });

  test('the retry resends the request (disabled while it runs) and then succeeds', async () => {
    let attempt = 0;
    const second = deferred<Response>();
    const { user, plans } = mount({ plan: () => (++attempt === 1 ? serverError() : second.promise) });
    await user.click(control() as HTMLButtonElement);
    const retry = (await within(await screen.findByRole('alert')).findByRole('button', { name: 'Try again' })) as HTMLButtonElement;
    await user.click(retry);
    await waitFor(() => expect(plans().length).toBe(2));
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => second.resolve(json(aiSession())));
    expect(await screen.findByText('AI-personalised from approved drills')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a network failure is an error state, not a fallback note', async () => {
    const { user } = mount({
      plan: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await user.click(control() as HTMLButtonElement);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(STANDARD)).toBeNull();
  });

  test('an answer that breaks the contract (a "rules" session without a fallback code) is an error and changes nothing', async () => {
    const { user, queryClient } = mount({ plan: () => json(session()) });
    await user.click(control() as HTMLButtonElement);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(STANDARD)).toBeNull();
    expect((cachedToday(queryClient) as { id: string; planner: string }).planner).toBe('rules');
  });

  test('an unknown fallback code is an error, never worded as a known reason', async () => {
    const { user } = mount({ plan: () => json({ ...session(), fallback: { code: 'mystery' } }) });
    await user.click(control() as HTMLButtonElement);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(STANDARD)).toBeNull();
  });
});

describe('offline', () => {
  test('hidden when offline: no button, no note field, no request (not even the availability check)', async () => {
    onLine = false;
    const { calls } = mount();
    expect(control()).toBeNull();
    expect(noteField()).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  test('goes away when the connection drops and comes back with it', async () => {
    mount();
    expect(control()).not.toBeNull();
    goOffline();
    expect(control()).toBeNull();
    expect(noteField()).toBeNull();
    goOnline();
    expect(control()).not.toBeNull();
    expect(noteField()).not.toBeNull();
  });
});

describe('the setting that disables the AI', () => {
  test('the server saying aiAvailable is false (no key) hides the control', async () => {
    const { calls } = mount({ health: () => health({ aiAvailable: false }) });
    await waitFor(() => expect(control()).toBeNull());
    expect(noteField()).toBeNull();
    expect(calls.some((call) => call.url.startsWith('/health'))).toBe(true);
  });

  test('aiAvailable true, a missing field (older server) or a failed check all keep the control', async () => {
    for (const answer of [() => health({ aiAvailable: true }), () => json({ ok: true, version: '0.1.0', database: 'ok' }), () => serverError()]) {
      const { calls } = mount({ health: answer });
      await waitFor(() => expect(calls.some((call) => call.url.startsWith('/health'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(control()).not.toBeNull();
      cleanup();
    }
  });
});

describe('nothing left to personalise (empty / disabled)', () => {
  test('when every drill is done the button is disabled and the reason is written next to it', async () => {
    const cached = session({ items: [item('item-1', 'Ball taps', { done: true }), item('item-2', 'Toe touches', { done: true })] });
    const { user, plans } = mount({ cached });
    const button = control() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = screen.getByText("All of today's drills are done, so there is nothing left to personalise.");
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
    await user.click(button);
    expect(plans()).toEqual([]);
  });

  test('a session with no drills at all is the same', () => {
    mount({ cached: session({ items: [] }) });
    expect((control() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('kk, ru and en', () => {
  const WORDS: Record<Locale, { action: string; standard: string; tag: string; timeout: string }> = {
    en: {
      action: 'Personalise with AI',
      standard: STANDARD,
      tag: 'AI-personalised from approved drills',
      timeout: 'The AI coach took too long to answer.',
    },
    ru: {
      action: 'Персонализировать с ИИ',
      standard: 'ИИ недоступен — вот ваш обычный план.',
      tag: 'Персонализировано ИИ из одобренных упражнений',
      timeout: 'ИИ-тренер слишком долго отвечал.',
    },
    kk: {
      action: 'ЖИ арқылы жекелендіру',
      standard: 'ЖИ қолжетімсіз — міне, әдеттегі жоспарыңыз.',
      tag: 'ЖИ бекітілген жаттығулардан жекелендірді',
      timeout: 'ЖИ жаттықтырушы тым ұзақ жауап берді.',
    },
  };

  test.each(['kk', 'ru', 'en'] as const)('%s: the control, the fallback note with its reason and the tag are all worded, with no raw keys', async (locale) => {
    const words = WORDS[locale];
    const first = mount({ locale, plan: () => json({ ...session(), fallback: { code: 'timeout' } }) });
    await first.user.click(control(words.action) as HTMLButtonElement);
    expect(await screen.findByText(words.standard)).toBeTruthy();
    expect(screen.getByText(words.timeout)).toBeTruthy();
    cleanup();

    mount({ locale, cached: aiSession() });
    expect(screen.getByText(words.tag)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/undefined|fallback\.|reasons\./);
  });
});

describe('the slot component (app-wide typed client)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('checks /health through the app client and shows the control for a cached session', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return health();
    }) as typeof fetch;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['today'], session());
    const i18n = createI18n({ modules: MODULES, languages: ['en'], storage: noStorage, root: { lang: '' }, dev: false });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <TodayExtra />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(control()).not.toBeNull();
    await waitFor(() => expect(urls).toContain('/health'));
  });
});
