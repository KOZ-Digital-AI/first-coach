import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrillListResponse } from '@api-types/commons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route } from '../../routes/admin/settings';
import messages from './settings.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as journey.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute and even report the test as passed. Compare to null / with
// === and assert on the boolean instead, so a failure is instant and honest.
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * Contract under test (fc-mol-87t): /admin/settings lets an admin set every configurable value: the minimum trust status
 * per age band (under 10, 10-13, 14+), the upload size cap in MB, the AI planner and video coach switches and the retest
 * intervals in days. It loads with GET and saves with PUT /api/admin/settings, shows server field errors on their fields,
 * and warns when raising a minimum status would leave fewer than 20 eligible drills. Model ids and secrets are env-only and
 * shown read-only as configured / not configured. It has loading, empty, error, disabled and success states, its buttons are
 * disabled while a request is in flight, and every string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch), served by a small stateful fake of the settings API so a save can be read back.
 *
 * Kazakh copy is flagged for a native-speaker review: for kk and ru these tests pin only that text exists, is Cyrillic and
 * never leaks 'undefined', a raw key or an unfilled {{placeholder}}.
 *
 * Readings of the criteria that the tests pin (chosen as the simplest):
 * - PUT sends a patch of ONLY the values the admin changed (the API takes any subset and merges bands).
 * - "Eligible drills" for the warning = published drills whose trust status is at or above the chosen minimum, read from the
 *   public list's facets; the warning appears only for a band whose minimum is RAISED above its saved value, and it warns,
 *   it does not block the save.
 * - Roll back on failure: nothing is written into the screen's saved state until the server confirms it, a failed save keeps
 *   what the admin typed (nothing is lost), and "Discard changes" returns to the last confirmed values.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures -----------------------------------------------------------------------------------

const STATUSES = ['COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED'] as const;
type Status = (typeof STATUSES)[number];

interface SettingsBody {
  minStatusByAgeBand: { u10: Status; u14: Status; adult: Status };
  uploadMaxMb: number;
  aiPlannerEnabled: boolean;
  videoCoachEnabled: boolean;
  retestIntervalsDays: number[];
}

const SAVED: SettingsBody = {
  minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'COMMUNITY' },
  uploadMaxMb: 50,
  aiPlannerEnabled: true,
  videoCoachEnabled: false,
  retestIntervalsDays: [7, 14, 30],
};

type Pool = Record<Status, number>;
/** At REVIEWED or higher: 12 + 5 + 2 = 19 (one short of 20). At EXPERT_VERIFIED or higher: 7. At ACADEMY_VERIFIED: 2. */
const POOL: Pool = { COMMUNITY: 30, REVIEWED: 12, EXPERT_VERIFIED: 5, ACADEMY_VERIFIED: 2 };
/** At REVIEWED or higher: 15 + 4 + 1 = exactly 20, which is not "fewer than 20". */
const POOL_EDGE: Pool = { COMMUNITY: 30, REVIEWED: 15, EXPERT_VERIFIED: 4, ACADEMY_VERIFIED: 1 };

const poolBody = (counts: Pool) =>
  DrillListResponse.parse({
    items: [],
    nextCursor: null,
    total: STATUSES.reduce((sum, status) => sum + counts[status], 0),
    facets: { skills: [], statuses: STATUSES.map((value) => ({ value, count: counts[value] })), equipment: [], levels: [] },
  });

// --- the network --------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}, type = 'application/json') =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': type } });

const problem = (status: number, title: string, errors: Array<{ pointer: string; detail: string }> = []) =>
  json({ type: 'about:blank', title, status, detail: `${title} (server text)`, errors }, { status }, 'application/problem+json');

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: Array<{ url: URL; init: RequestInit | undefined }> = [];

/** Every request the screen makes lands in `calls` and is answered by `handler`. */
function stubNetwork(handler: Handler): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

interface ServerOptions {
  settings?: unknown;
  pool?: Pool;
  /** Omit for a /health answer that says nothing about the AI key. */
  aiAvailable?: boolean;
}

/** A stateful fake of the settings API: GET answers what is stored, PUT merges the patch (bands one by one) and answers the whole. */
function createServer(options: ServerOptions = {}) {
  const state = { settings: structuredClone(options.settings ?? SAVED) as Record<string, unknown>, pool: options.pool ?? POOL };
  const handler: Handler = (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/admin/settings' && method === 'GET') return json(state.settings);
    if (url.pathname === '/api/admin/settings' && method === 'PUT') {
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        state.settings[key] =
          key === 'minStatusByAgeBand' ? { ...(state.settings.minStatusByAgeBand as object), ...(value as object) } : value;
      }
      return json(state.settings);
    }
    if (url.pathname === '/api/commons/drills') return json(poolBody(state.pool));
    if (url.pathname === '/health') {
      return json({ ok: true, version: 'test', database: 'ok', ...(options.aiAvailable === undefined ? {} : { aiAvailable: options.aiAvailable }) });
    }
    return problem(404, 'Not Found');
  };
  return { state, handler };
}

const isPut = (url: URL, init: RequestInit | undefined) => url.pathname === '/api/admin/settings' && init?.method === 'PUT';
const putCalls = () => calls.filter((call) => isPut(call.url, call.init));
const putBody = (index = 0): unknown => JSON.parse(String(putCalls()[index]?.init?.body));

beforeEach(() => stubNetwork(createServer().handler));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './settings.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const SettingsPage = Route.options.component as () => ReactNode;

function renderSettings(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <SettingsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, instance, queryClient };
}

const POOL_HINT = /^Drills at this status or higher: \d+$/;

/** Renders and waits for the form AND the drill counts (one hint per band), so a later "no warning" is a real absence. */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderSettings(locale);
  await screen.findByRole('button', { name: locale === 'en' ? 'Save settings' : /.+/ });
  if (locale === 'en') await screen.findAllByText(POOL_HINT);
  return view;
}

const user = () => userEvent.setup();
const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ');

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const uploadInput = () => screen.getByLabelText('Upload size limit (MB)') as HTMLInputElement;
const retestInput = () => screen.getByLabelText('Retest reminders (days)') as HTMLInputElement;
const aiSwitch = () => screen.getByRole('switch', { name: 'AI planner' }) as HTMLInputElement;
const videoSwitch = () => screen.getByRole('switch', { name: 'Video coach' }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /^(Save settings|Saving…)$/ }) as HTMLButtonElement;
const discardButton = () => screen.getByRole('button', { name: 'Discard changes' }) as HTMLButtonElement;
const controls = () => [select('Under 10'), select('Ages 10 to 13'), select('Age 14 and older'), uploadInput(), aiSwitch(), videoSwitch(), retestInput()];

async function typeInto(input: HTMLInputElement, value: string) {
  const u = user();
  await u.clear(input);
  if (value !== '') await u.type(input, value);
}

/** The error a control points at through aria-describedby (a role="alert" element), or null. */
function errorOf(control: HTMLElement): HTMLElement | null {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element?.getAttribute('role') === 'alert') return element;
  }
  return null;
}

const SAVED_MESSAGE = 'Settings saved. They apply right away.';
const savedNotice = () => screen.queryByText(SAVED_MESSAGE)?.closest('[role="status"]') ?? null;
const failedNotice = () => screen.queryByText('Nothing was saved')?.closest('[role="alert"]') ?? null;

// --- the requests -------------------------------------------------------------------------------

describe('the requests', () => {
  test('loads with one GET /api/admin/settings, and reads the drill counts and the AI key state without any filter', async () => {
    await renderLoaded();
    const settingsCalls = calls.filter((call) => call.url.pathname === '/api/admin/settings');
    expect(settingsCalls).toHaveLength(1);
    expect(settingsCalls[0]?.init?.method).toBe('GET');

    const pool = calls.filter((call) => call.url.pathname === '/api/commons/drills');
    expect(pool).toHaveLength(1);
    // Unfiltered and one row: only the facets are read. A status/skill filter would change the counts.
    expect(pool[0]?.url.searchParams.get('limit')).toBe('1');
    for (const filter of ['status', 'skill', 'level', 'equipment', 'q']) expect(pool[0]?.url.searchParams.has(filter)).toBe(false);

    expect(calls.filter((call) => call.url.pathname === '/health')).toHaveLength(1);
    expect(putCalls()).toHaveLength(0);
  });
});

// --- loading ------------------------------------------------------------------------------------

describe('loading', () => {
  test('a busy, named status is shown until the settings arrive, and no control or value is invented meanwhile', async () => {
    const server = createServer();
    let release: (response: Response) => void = () => {};
    stubNetwork((url, init) =>
      url.pathname === '/api/admin/settings' && (init?.method ?? 'GET') === 'GET' ? new Promise<Response>((resolve) => (release = resolve)) : server.handler(url, init),
    );
    renderSettings();

    const status = await screen.findByRole('status', { name: 'Loading settings' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' }) === null).toBe(true);
    expect(screen.queryByLabelText('Upload size limit (MB)') === null).toBe(true);

    release(json(SAVED));
    await screen.findByRole('button', { name: 'Save settings' });
    expect(screen.queryByRole('status', { name: 'Loading settings' }) === null).toBe(true);
  });
});

// --- success: what is shown ---------------------------------------------------------------------

describe('success: the saved values', () => {
  test('every configurable value is shown with a labelled control holding what the server sent', async () => {
    const server = createServer({
      settings: { ...SAVED, minStatusByAgeBand: { u10: 'REVIEWED', u14: 'EXPERT_VERIFIED', adult: 'ACADEMY_VERIFIED' } },
    });
    stubNetwork(server.handler);
    await renderLoaded();

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(select('Under 10').value).toBe('REVIEWED');
    expect(select('Ages 10 to 13').value).toBe('EXPERT_VERIFIED');
    expect(select('Age 14 and older').value).toBe('ACADEMY_VERIFIED');
    expect(uploadInput().value).toBe('50');
    expect(aiSwitch().checked).toBe(true);
    expect(videoSwitch().checked).toBe(false);
    expect(retestInput().value).toBe('7, 14, 30');
  });

  test('each age band offers all four trust statuses, by name', async () => {
    await renderLoaded();
    for (const label of ['Under 10', 'Ages 10 to 13', 'Age 14 and older']) {
      const options = Array.from(select(label).options).map((option) => [option.value, option.textContent]);
      expect(options).toEqual([
        ['COMMUNITY', 'Community'],
        ['REVIEWED', 'Reviewed'],
        ['EXPERT_VERIFIED', 'Expert verified'],
        ['ACADEMY_VERIFIED', 'Academy verified'],
      ]);
    }
  });

  test('a switch says On or Off in words, and the word follows the switch (never colour alone)', async () => {
    await renderLoaded();
    const ai = aiSwitch();
    const video = videoSwitch();
    expect(text(ai.closest('div')!)).toContain('On');
    expect(text(video.closest('div')!)).toContain('Off');

    await user().click(video);
    expect(video.checked).toBe(true);
    expect(text(video.closest('div')!)).toContain('On');
    expect(text(video.closest('div')!)).not.toContain('Off');
  });

  test('every control has an accessible name and a 44px tap height, and a button is a real button', async () => {
    await renderLoaded();
    for (const control of controls()) {
      expect(control.className + (control.closest('label')?.className ?? '') + (control.parentElement?.className ?? '')).toContain('min-h-tap');
    }
    for (const button of [saveButton(), discardButton()]) expect(button.className).toContain('min-h-tap');
    // getByLabelText / getByRole with a name above already proved each has one; the fields also keep their hints attached.
    expect(uploadInput().getAttribute('aria-describedby')).toBeTruthy();
    expect(retestInput().getAttribute('aria-describedby')).toBeTruthy();
  });

  test('the drill count for each band follows its selected status', async () => {
    await renderLoaded();
    // COMMUNITY: 30 + 12 + 5 + 2 = 49 in each band to start with.
    expect(screen.getAllByText('Drills at this status or higher: 49')).toHaveLength(3);
    await user().selectOptions(select('Ages 10 to 13'), 'EXPERT_VERIFIED');
    expect(screen.getAllByText('Drills at this status or higher: 49')).toHaveLength(2);
    expect(screen.getAllByText('Drills at this status or higher: 7')).toHaveLength(1);
  });
});

// --- the save round trip ------------------------------------------------------------------------

describe('saving', () => {
  test('nothing to save yet: Save and Discard are disabled and say why', async () => {
    await renderLoaded();
    expect(saveButton().disabled).toBe(true);
    expect(discardButton().disabled).toBe(true);
    expect(screen.getByText('No changes yet.')).toBeTruthy();
  });

  test('round trip: edit, PUT only what changed, show the server answer, and a fresh load reads it back', async () => {
    const server = createServer();
    stubNetwork(server.handler);
    await renderLoaded();
    const u = user();

    await typeInto(uploadInput(), '80');
    await u.click(videoSwitch());
    await typeInto(retestInput(), '7, 21');
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();
    await u.click(saveButton());

    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putCalls()).toHaveLength(1);
    expect(putCalls()[0]?.init?.method).toBe('PUT');
    expect(new Headers(putCalls()[0]?.init?.headers).get('content-type')).toContain('application/json');
    expect(putBody()).toEqual({ uploadMaxMb: 80, videoCoachEnabled: true, retestIntervalsDays: [7, 21] });

    // Now clean again: what is on screen is what the server confirmed.
    expect(uploadInput().value).toBe('80');
    expect(videoSwitch().checked).toBe(true);
    expect(retestInput().value).toBe('7, 21');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('No changes yet.')).toBeTruthy();
    expect(failedNotice() === null).toBe(true);

    cleanup();
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    expect(uploadInput().value).toBe('80');
    expect(videoSwitch().checked).toBe(true);
    expect(aiSwitch().checked).toBe(true);
    expect(retestInput().value).toBe('7, 21');
    expect(server.state.settings.uploadMaxMb).toBe(80);
  });

  test('changing one age band sends only that band', async () => {
    await renderLoaded();
    await user().selectOptions(select('Ages 10 to 13'), 'REVIEWED');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ minStatusByAgeBand: { u14: 'REVIEWED' } });
    expect(select('Ages 10 to 13').value).toBe('REVIEWED');
    expect(select('Under 10').value).toBe('COMMUNITY');
  });

  test('changing a value and changing it back is not a change', async () => {
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    expect(saveButton().disabled).toBe(false);
    await typeInto(uploadInput(), '50');
    expect(saveButton().disabled).toBe(true);
    await user().click(aiSwitch());
    await user().click(aiSwitch());
    expect(saveButton().disabled).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  test('retest days may be separated by commas, spaces or both', async () => {
    await renderLoaded();
    await typeInto(retestInput(), '3,  10 21');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ retestIntervalsDays: [3, 10, 21] });
  });

  test('the success message goes away as soon as the admin edits again', async () => {
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    await typeInto(uploadInput(), '81');
    expect(savedNotice() === null).toBe(true);
  });

  test('after a save the focus lands on the result message, not on a disabled button', async () => {
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(savedNotice()!.contains(document.activeElement)).toBe(true);
  });

  test('discard puts the last saved values back', async () => {
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(videoSwitch());
    await user().selectOptions(select('Under 10'), 'REVIEWED');
    await user().click(discardButton());
    expect(uploadInput().value).toBe('50');
    expect(videoSwitch().checked).toBe(false);
    expect(select('Under 10').value).toBe('COMMUNITY');
    expect(saveButton().disabled).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });
});

// --- disabled while in flight -------------------------------------------------------------------

describe('disabled while a request is in flight', () => {
  test('Save is busy and every control is disabled until the answer arrives, and a second click sends nothing', async () => {
    const server = createServer();
    let release: (response: Response) => void = () => {};
    stubNetwork((url, init) => (isPut(url, init) ? new Promise<Response>((resolve) => (release = resolve)) : server.handler(url, init)));
    await renderLoaded();
    const u = user();

    await typeInto(uploadInput(), '80');
    await u.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(saveButton().textContent).toContain('Saving…');
    expect(discardButton().disabled).toBe(true);
    for (const control of controls()) expect(control.disabled).toBe(true);

    await u.click(saveButton());
    expect(putCalls()).toHaveLength(1);
    expect(savedNotice() === null).toBe(true);

    release(json({ ...SAVED, uploadMaxMb: 80 }));
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    for (const control of controls()) expect(control.disabled).toBe(false);
    expect(saveButton().getAttribute('aria-busy') === null).toBe(true);
    expect(putCalls()).toHaveLength(1);
  });
});

// --- server field errors ------------------------------------------------------------------------

describe('a 422 from the server', () => {
  const rejectPut = (errors: Array<{ pointer: string; detail: string }>) => {
    const server = createServer();
    stubNetwork((url, init) => (isPut(url, init) ? problem(422, 'Unprocessable Entity', errors) : server.handler(url, init)));
    return server;
  };

  test('is shown on the field each pointer names, in our words, with an icon and role="alert"', async () => {
    rejectPut([
      { pointer: '/minStatusByAgeBand/u10', detail: 'Invalid option: expected one of "COMMUNITY"' },
      { pointer: '/uploadMaxMb', detail: 'Too small: expected number to be >0' },
      { pointer: '/retestIntervalsDays/1', detail: 'Too small: expected number to be >0' },
    ]);
    await renderLoaded();
    const u = user();
    await u.selectOptions(select('Under 10'), 'REVIEWED');
    await typeInto(uploadInput(), '500');
    await typeInto(retestInput(), '7, 14');
    await u.click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));

    const bandError = errorOf(select('Under 10'));
    expect(bandError === null).toBe(false);
    expect(text(bandError!)).toContain('Choose one of the four trust statuses.');
    expect(select('Under 10').getAttribute('aria-invalid')).toBe('true');
    expect(bandError!.querySelector('svg') === null).toBe(false);

    expect(text(errorOf(uploadInput())!)).toContain('Enter a whole number of megabytes, 1 or more.');
    expect(uploadInput().getAttribute('aria-invalid')).toBe('true');
    expect(text(errorOf(retestInput())!)).toContain('Enter whole days, 1 or more, separated by commas.');

    // Fields the server did not name stay clean, and the server's own English text is never shown.
    expect(errorOf(select('Ages 10 to 13')) === null).toBe(true);
    expect(select('Ages 10 to 13').getAttribute('aria-invalid') === null).toBe(true);
    expect(errorOf(aiSwitch()) === null).toBe(true);
    expect(document.body.textContent).not.toContain('Too small');
    expect(document.body.textContent).not.toContain('Invalid option');
    expect(document.body.textContent).not.toContain('server text');
  });

  test('a switch can carry a field error too', async () => {
    rejectPut([{ pointer: '/aiPlannerEnabled', detail: 'Invalid input: expected boolean' }]);
    await renderLoaded();
    await user().click(aiSwitch());
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));
    expect(text(errorOf(aiSwitch())!)).toContain('This setting could not be saved.');
    expect(aiSwitch().getAttribute('aria-invalid')).toBe('true');
    expect(errorOf(videoSwitch()) === null).toBe(true);
  });

  test('the form says nothing was saved, points to the fields, keeps the typed values and never shows success', async () => {
    rejectPut([{ pointer: '/uploadMaxMb', detail: 'Too small' }]);
    await renderLoaded();
    await typeInto(uploadInput(), '500');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));

    expect(text(failedNotice()!)).toContain('Check the highlighted fields.');
    expect(savedNotice() === null).toBe(true);
    expect(uploadInput().value).toBe('500'); // what the admin typed is not thrown away
    expect(saveButton().disabled).toBe(false); // and can be corrected and sent again
    expect(saveButton().getAttribute('aria-busy') === null).toBe(true);
    for (const control of controls()) expect(control.disabled).toBe(false);
    expect(putCalls()).toHaveLength(1);
  });

  test('focus moves to the first control with an error, in page order', async () => {
    rejectPut([
      { pointer: '/uploadMaxMb', detail: 'x' },
      { pointer: '/minStatusByAgeBand/adult', detail: 'x' },
    ]);
    await renderLoaded();
    await user().selectOptions(select('Age 14 and older'), 'REVIEWED');
    await typeInto(uploadInput(), '500');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));
    expect(document.activeElement === select('Age 14 and older')).toBe(true);
  });

  test('editing a field clears its own error and keeps the others', async () => {
    rejectPut([
      { pointer: '/uploadMaxMb', detail: 'x' },
      { pointer: '/retestIntervalsDays/0', detail: 'x' },
    ]);
    await renderLoaded();
    await typeInto(uploadInput(), '500');
    await typeInto(retestInput(), '7');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));
    expect(errorOf(uploadInput()) === null).toBe(false);
    expect(errorOf(retestInput()) === null).toBe(false);

    await typeInto(uploadInput(), '501');
    expect(errorOf(uploadInput()) === null).toBe(true);
    expect(uploadInput().getAttribute('aria-invalid') === null).toBe(true);
    expect(errorOf(retestInput()) === null).toBe(false);
  });

  test('an error at a path the screen has no field for is a form-level message, not a pointer at nothing', async () => {
    rejectPut([{ pointer: '/theme', detail: 'Unrecognized key: "theme"' }]);
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));
    expect(text(failedNotice()!)).not.toContain('Check the highlighted fields.');
    expect(text(failedNotice()!)).toContain('Something went wrong. Try again.');
    for (const control of controls()) expect(control.getAttribute('aria-invalid') === null).toBe(true);
    expect(document.body.textContent).not.toContain('Unrecognized key');
  });
});

// --- failures that are not about a field: roll back ----------------------------------------------

describe('a save that fails outright', () => {
  test('a 500 says nothing was saved in plain words, shows no success and leaves the fields editable', async () => {
    const server = createServer();
    stubNetwork((url, init) => (isPut(url, init) ? problem(500, 'Internal Server Error') : server.handler(url, init)));
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));

    expect(text(failedNotice()!)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(document.body.textContent).not.toContain('server text');
    expect(savedNotice() === null).toBe(true);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute('aria-busy') === null).toBe(true);
    for (const control of controls()) expect(control.disabled).toBe(false);
    for (const control of controls()) expect(errorOf(control) === null).toBe(true);
    // Nothing reached the store.
    expect(server.state.settings.uploadMaxMb).toBe(50);
  });

  test('a dropped connection is the same: nothing saved, a calm offline message', async () => {
    const server = createServer();
    stubNetwork((url, init) => {
      if (isPut(url, init)) throw new TypeError('Failed to fetch');
      return server.handler(url, init);
    });
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));
    expect(text(failedNotice()!)).toContain('No connection. Check your internet and try again.');
    expect(savedNotice() === null).toBe(true);
  });

  test('roll back: the saved state is untouched, Discard returns to it, and the failure message goes away', async () => {
    const server = createServer();
    stubNetwork((url, init) => (isPut(url, init) ? problem(500, 'Internal Server Error') : server.handler(url, init)));
    await renderLoaded();
    const u = user();
    await typeInto(uploadInput(), '80');
    await u.click(videoSwitch());
    await u.selectOptions(select('Under 10'), 'REVIEWED');
    await u.click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));

    // What was typed is kept (nothing is silently lost) and still counts as unsaved.
    expect(uploadInput().value).toBe('80');
    expect(saveButton().disabled).toBe(false);

    await u.click(discardButton());
    expect(uploadInput().value).toBe('50');
    expect(videoSwitch().checked).toBe(false);
    expect(select('Under 10').value).toBe('COMMUNITY');
    expect(saveButton().disabled).toBe(true);
    expect(failedNotice() === null).toBe(true);
  });

  test('after a failure the same save can be tried again and then succeeds', async () => {
    const server = createServer();
    let failNext = true;
    stubNetwork((url, init) => {
      if (isPut(url, init) && failNext) {
        failNext = false;
        return problem(500, 'Internal Server Error');
      }
      return server.handler(url, init);
    });
    await renderLoaded();
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(failedNotice() === null).toBe(false));

    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(failedNotice() === null).toBe(true);
    expect(putCalls()).toHaveLength(2);
    expect(putBody(1)).toEqual({ uploadMaxMb: 80 });
    expect(server.state.settings.uploadMaxMb).toBe(80);
  });
});

// --- values that cannot be sent -----------------------------------------------------------------

describe('values the screen refuses to send', () => {
  test.each([
    ['abc', 'text'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['12.5', 'a fraction'],
    ['', 'nothing'],
  ])('an upload limit of %j (%s) is a field error and sends nothing', async (value) => {
    await renderLoaded();
    await typeInto(uploadInput(), value);
    await user().click(saveButton());
    await waitFor(() => expect(errorOf(uploadInput()) === null).toBe(false));
    expect(text(errorOf(uploadInput())!)).toContain('Enter a whole number of megabytes, 1 or more.');
    expect(putCalls()).toHaveLength(0);
    expect(savedNotice() === null).toBe(true);
  });

  test.each([
    ['7, x', 'a word'],
    ['7, 0', 'zero'],
    ['7, -3', 'a negative'],
    ['7, 1.5', 'a fraction'],
    ['', 'nothing at all'],
    [' , ', 'only separators'],
  ])('retest days %j (%s) is a field error and sends nothing', async (value) => {
    await renderLoaded();
    await typeInto(retestInput(), value);
    await user().click(saveButton());
    await waitFor(() => expect(errorOf(retestInput()) === null).toBe(false));
    expect(text(errorOf(retestInput())!)).toContain('Enter whole days, 1 or more, separated by commas.');
    expect(putCalls()).toHaveLength(0);
  });

  test('the field error is worded as an alert with an icon, and the rest of the form still saves once fixed', async () => {
    await renderLoaded();
    await typeInto(uploadInput(), 'abc');
    await user().click(saveButton());
    await waitFor(() => expect(errorOf(uploadInput()) === null).toBe(false));
    expect(errorOf(uploadInput())!.querySelector('svg') === null).toBe(false);
    expect(document.activeElement === uploadInput()).toBe(true);

    await typeInto(uploadInput(), '64');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ uploadMaxMb: 64 });
  });
});

// --- the low drill pool warning -----------------------------------------------------------------

const lowPoolNotice = (band: string) => screen.queryByText(`${band}: too few drills`)?.closest('[role="alert"]') ?? null;

describe('the low drill pool warning', () => {
  test('raising a minimum that would leave fewer than 20 drills warns, naming the band, the status and the count', async () => {
    await renderLoaded();
    await user().selectOptions(select('Under 10'), 'REVIEWED');

    const notice = lowPoolNotice('Under 10');
    expect(notice === null).toBe(false);
    expect(text(notice!)).toMatch(/“Reviewed”/);
    expect(text(notice!)).toMatch(/fewer than 20 drills/);
    expect(text(notice!)).toMatch(/\b19\b/); // 12 + 5 + 2
    expect(notice!.querySelector('svg') === null).toBe(false); // an icon as well as the words
    // Only the raised band is named.
    expect(lowPoolNotice('Ages 10 to 13') === null).toBe(true);
    expect(lowPoolNotice('Age 14 and older') === null).toBe(true);
  });

  test('exactly 20 eligible drills is enough: no warning', async () => {
    stubNetwork(createServer({ pool: POOL_EDGE }).handler);
    await renderLoaded();
    await user().selectOptions(select('Under 10'), 'REVIEWED');
    expect(screen.getAllByText('Drills at this status or higher: 20')).toHaveLength(1);
    expect(lowPoolNotice('Under 10') === null).toBe(true);
  });

  test('the warning follows the selection: higher still warns for the new count, back down clears it', async () => {
    await renderLoaded();
    const u = user();
    await u.selectOptions(select('Ages 10 to 13'), 'REVIEWED');
    expect(text(lowPoolNotice('Ages 10 to 13')!)).toMatch(/\b19\b/);
    await u.selectOptions(select('Ages 10 to 13'), 'ACADEMY_VERIFIED');
    expect(text(lowPoolNotice('Ages 10 to 13')!)).toMatch(/“Academy verified”/);
    expect(text(lowPoolNotice('Ages 10 to 13')!)).toMatch(/\b2\b/);
    await u.selectOptions(select('Ages 10 to 13'), 'COMMUNITY');
    expect(lowPoolNotice('Ages 10 to 13') === null).toBe(true);
  });

  test('each raised band is warned about on its own', async () => {
    await renderLoaded();
    const u = user();
    await u.selectOptions(select('Under 10'), 'EXPERT_VERIFIED');
    await u.selectOptions(select('Age 14 and older'), 'REVIEWED');
    expect(text(lowPoolNotice('Under 10')!)).toMatch(/\b7\b/);
    expect(text(lowPoolNotice('Age 14 and older')!)).toMatch(/\b19\b/);
    expect(lowPoolNotice('Ages 10 to 13') === null).toBe(true);
  });

  test('a band that is not being raised gives no warning, even if its saved minimum already leaves few drills', async () => {
    stubNetwork(createServer({ settings: { ...SAVED, minStatusByAgeBand: { u10: 'EXPERT_VERIFIED', u14: 'EXPERT_VERIFIED', adult: 'COMMUNITY' } } }).handler);
    await renderLoaded();
    expect(lowPoolNotice('Under 10') === null).toBe(true);
    // Lowering it (or leaving it) is not "raising".
    await user().selectOptions(select('Under 10'), 'REVIEWED');
    expect(lowPoolNotice('Under 10') === null).toBe(true);
    await user().selectOptions(select('Ages 10 to 13'), 'EXPERT_VERIFIED');
    expect(lowPoolNotice('Ages 10 to 13') === null).toBe(true);
  });

  test('it warns and does not block: the raised minimum can still be saved', async () => {
    await renderLoaded();
    await user().selectOptions(select('Under 10'), 'REVIEWED');
    expect(lowPoolNotice('Under 10') === null).toBe(false);
    expect(saveButton().disabled).toBe(false);
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ minStatusByAgeBand: { u10: 'REVIEWED' } });
    // Saved, so the minimum is no longer "raised": the warning is gone with it.
    expect(lowPoolNotice('Under 10') === null).toBe(true);
  });

  test('when the drills cannot be counted there is no warning, a note says so, and saving still works', async () => {
    const server = createServer();
    stubNetwork((url, init) => (url.pathname === '/api/commons/drills' ? problem(500, 'Internal Server Error') : server.handler(url, init)));
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await screen.findByText('Could not count the drills, so low-drill warnings are off for now.');

    await user().selectOptions(select('Under 10'), 'ACADEMY_VERIFIED');
    expect(lowPoolNotice('Under 10') === null).toBe(true);
    expect(screen.queryByText(POOL_HINT) === null).toBe(true);
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ minStatusByAgeBand: { u10: 'ACADEMY_VERIFIED' } });
  });
});

// --- read-only: what the server environment holds ------------------------------------------------

describe('the server environment (read-only)', () => {
  const panel = () => screen.getByRole('region', { name: 'Set on the server' });

  test('says configured when the server reports an AI key, and offers nothing to change', async () => {
    stubNetwork(createServer({ aiAvailable: true }).handler);
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await waitFor(() => expect(within(panel()).getByText('Configured')).toBeTruthy());
    expect(within(panel()).getByText('AI provider key')).toBeTruthy();
    expect(within(panel()).queryByText('Not configured') === null).toBe(true);
    expect(within(panel()).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(panel()).queryAllByRole('switch')).toHaveLength(0);
    expect(within(panel()).queryAllByRole('button')).toHaveLength(0);
    expect(within(panel()).queryAllByRole('combobox')).toHaveLength(0);
  });

  test('says not configured when the server reports no AI key (a word and an icon, not a colour)', async () => {
    stubNetwork(createServer({ aiAvailable: false }).handler);
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await waitFor(() => expect(within(panel()).getByText('Not configured')).toBeTruthy());
    expect(within(panel()).queryByText('Configured') === null).toBe(true);
    expect(within(panel()).getByText('Not configured').querySelector('svg') === null).toBe(false);
  });

  test('says it could not check, instead of guessing, when the answer is missing or the call fails', async () => {
    stubNetwork(createServer().handler); // /health without an aiAvailable key
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await waitFor(() => expect(within(panel()).getByText('Could not check')).toBeTruthy());
    expect(within(panel()).queryByText('Configured') === null).toBe(true);
    expect(within(panel()).queryByText('Not configured') === null).toBe(true);
    cleanup();

    const server = createServer({ aiAvailable: true });
    stubNetwork((url, init) => (url.pathname === '/health' ? problem(503, 'Service Unavailable') : server.handler(url, init)));
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await waitFor(() => expect(within(panel()).getByText('Could not check')).toBeTruthy());
    expect(within(panel()).queryByText('Configured') === null).toBe(true);
  });

  test('explains that model ids and secrets are set in the server environment and are not shown', async () => {
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    expect(within(panel()).getByText(/model ids and secrets/i)).toBeTruthy();
  });

  test('the health call failing never blocks the settings form', async () => {
    const server = createServer();
    stubNetwork((url, init) => (url.pathname === '/health' ? problem(503, 'Service Unavailable') : server.handler(url, init)));
    renderSettings();
    await screen.findByRole('button', { name: 'Save settings' });
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
  });
});

// --- error (the settings themselves could not load) ---------------------------------------------

describe('error: the settings could not be loaded', () => {
  const failGet = (response: () => Response, server = createServer()) => {
    let failing = true;
    stubNetwork((url, init) =>
      url.pathname === '/api/admin/settings' && (init?.method ?? 'GET') === 'GET' && failing ? response() : server.handler(url, init),
    );
    return () => {
      failing = false;
    };
  };

  test('a 500 shows a calm alert with Try again, and no form', async () => {
    failGet(() => problem(500, 'Internal Server Error'));
    renderSettings();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('Could not load the settings');
    expect(text(alert)).toContain('Something went wrong on our side. Try again in a moment.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' }) === null).toBe(true);
    expect(screen.queryByLabelText('Upload size limit (MB)') === null).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('server text');
  });

  test('a 403 (the server refuses this person) says so, in our words', async () => {
    failGet(() => problem(403, 'Forbidden'));
    renderSettings();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain("You don't have access to this.");
    expect(screen.queryByRole('button', { name: 'Save settings' }) === null).toBe(true);
  });

  test('a body that is not the settings (e.g. an HTML page from a proxy) is an error, never an empty form', async () => {
    failGet(() => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    renderSettings();
    const alert = await screen.findByRole('alert');
    expect(text(alert)).toContain('The server sent an unexpected answer. Try again.');
    expect(screen.queryByRole('button', { name: 'Save settings' }) === null).toBe(true);
  });

  test('a value of the wrong type is an error too: no control is filled from a guess', async () => {
    failGet(() => json({ ...SAVED, uploadMaxMb: 'lots' }));
    renderSettings();
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Upload size limit (MB)') === null).toBe(true);
  });

  test('Try again is disabled and busy while the retry is in flight, then the form appears', async () => {
    const server = createServer();
    let release: (response: Response) => void = () => {};
    let failing = true;
    stubNetwork((url, init) => {
      if (url.pathname === '/api/admin/settings' && (init?.method ?? 'GET') === 'GET') {
        if (failing) return problem(500, 'Internal Server Error');
        return new Promise<Response>((resolve) => (release = resolve));
      }
      return server.handler(url, init);
    });
    renderSettings();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    failing = false;
    await user().click(retry);

    await waitFor(() => expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe('true');

    release(json(SAVED));
    await screen.findByRole('button', { name: 'Save settings' });
    expect(screen.queryByRole('button', { name: 'Try again' }) === null).toBe(true);
  });
});

// --- empty --------------------------------------------------------------------------------------

describe('empty: the server lists no setting this screen knows', () => {
  test('an empty settings object is an empty state, not a form of blank controls', async () => {
    stubNetwork(createServer({ settings: {} }).handler);
    renderSettings();
    await screen.findByText('No settings to change yet');
    expect(screen.getByText('The server did not list any settings. Check back after the next update.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' }) === null).toBe(true);
    expect(screen.queryByLabelText('Upload size limit (MB)') === null).toBe(true);
    expect(screen.queryByRole('alert') === null).toBe(true);
  });

  test('a setting the server does not send has no control, and the ones it sends still work', async () => {
    const { uploadMaxMb: _dropped, ...withoutUpload } = SAVED;
    stubNetwork(createServer({ settings: withoutUpload }).handler);
    await renderLoaded();
    expect(screen.queryByLabelText('Upload size limit (MB)') === null).toBe(true);
    await user().click(videoSwitch());
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ videoCoachEnabled: true });
  });

  test('extra keys the screen does not know are ignored, never shown and never sent back', async () => {
    stubNetwork(createServer({ settings: { ...SAVED, theme: 'dark', secretToken: 'hunter2' } }).handler);
    await renderLoaded();
    expect(document.body.textContent).not.toContain('hunter2');
    await typeInto(uploadInput(), '80');
    await user().click(saveButton());
    await waitFor(() => expect(savedNotice() === null).toBe(false));
    expect(putBody()).toEqual({ uploadMaxMb: 80 });
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('kk, ru and en', () => {
  const CYRILLIC = /[Ѐ-ӿ]/;

  test.each(['kk', 'ru'] as const)('%s: the whole screen is written in that language, with no gaps', async (locale) => {
    renderSettings(locale);
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));

    const main = document.body;
    expect(text(main)).not.toContain('undefined');
    expect(text(main)).not.toContain('{{');
    expect(text(main)).not.toMatch(/\b(?:title|lead|hint|label)\b\.?\w*/); // no raw key such as "uploads.title"
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toMatch(CYRILLIC);
    expect(h1.textContent).not.toBe('Settings');
    // Every control's name and every button is in the language too.
    for (const control of screen.getAllByRole('switch')) expect(control.getAttribute('aria-labelledby')).toBeTruthy();
    for (const button of screen.getAllByRole('button')) expect(button.textContent).toMatch(CYRILLIC);
    for (const label of Array.from(document.querySelectorAll('label'))) expect(label.textContent).toMatch(CYRILLIC);
  });

  test.each(['kk', 'ru'] as const)('%s: the low drill pool warning names the band, the status and the count, with nothing left unfilled', async (locale) => {
    renderSettings(locale);
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));
    await waitFor(() => expect(document.body.textContent).toMatch(/49/));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    await user().selectOptions(selects[0]!, 'REVIEWED');
    const notice = await screen.findByRole('alert');
    expect(text(notice)).toMatch(CYRILLIC);
    expect(text(notice)).toMatch(/\b19\b/);
    expect(text(notice)).toMatch(/\b20\b/);
    expect(text(notice)).not.toContain('{{');
    expect(text(notice)).not.toContain('undefined');
  });

  test.each(['kk', 'ru'] as const)('%s: the saved message and a failure message are localised', async (locale) => {
    const server = createServer();
    let failNext = true;
    stubNetwork((url, init) => {
      if (isPut(url, init) && failNext) {
        failNext = false;
        return problem(500, 'Internal Server Error');
      }
      return server.handler(url, init);
    });
    renderSettings(locale);
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));
    const upload = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    await typeInto(upload, '80');
    const save = screen.getAllByRole('button').find((button) => !button.hasAttribute('disabled'))!;
    await user().click(save);
    const failure = await screen.findByRole('alert');
    expect(text(failure)).toMatch(CYRILLIC);
    expect(text(failure)).not.toContain('undefined');

    await user().click(screen.getAllByRole('button').find((button) => !button.hasAttribute('disabled'))!);
    const done = await screen.findByRole('status');
    expect(text(done)).toMatch(CYRILLIC);
    expect(text(done)).not.toContain('undefined');
  });

  test('the same three languages are shipped for every key (kk, ru, en)', () => {
    const keysOf = (tree: unknown, prefix = ''): string[] =>
      typeof tree === 'object' && tree !== null
        ? Object.entries(tree).flatMap(([key, value]) => keysOf(value, `${prefix}${key}.`))
        : [prefix];
    const en = keysOf(messages.en).sort();
    expect(en.length).toBeGreaterThan(30);
    expect(keysOf(messages.kk).sort()).toEqual(en);
    expect(keysOf(messages.ru).sort()).toEqual(en);
  });
});
