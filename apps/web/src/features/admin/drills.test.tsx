import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrillStatusRequest, UnpublishRequest } from '@api-types/admin';
import { DrillDetail, type DrillReview, DrillSummary } from '@api-types/commons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import trustMessages from '../commons/trust-badge.messages';
import messages from './drills.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. From the repo root there is no
// DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard as impact.test.tsx).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// Import the route only now, after happy-dom is registered.
const { Route } = await import('../../routes/admin/drills');

// NOTE: never `expect(element).toBeNull()` / `.toBe(element)`. When such an assertion FAILS, bun pretty-prints the happy-dom
// element (a huge circular object graph): it can take a minute. Compare to null / with === and assert on the boolean instead.

/*
 * Contract under test (fc-mol-0v3.11): /admin/drills lists the PUBLISHED drills (GET /api/commons/drills) with their trust
 * status and lets an admin
 *   - mark one as REVIEWED / EXPERT VERIFIED / ACADEMY VERIFIED with a reviewer note and an organisation label (required for
 *     ACADEMY VERIFIED, e.g. "FC Kairat Academy"): POST /api/admin/drills/:slug/status {toStatus, orgLabel?, note};
 *   - or unpublish it with a reason behind a confirm dialog: POST /api/admin/drills/:slug/unpublish {reason}.
 * The row updates from the response (DrillDetail has no status field: the status is the newest review's `to`) and shows the
 * latest reviews entry. The screen has loading, empty, error, disabled and success states, mutation buttons are disabled while
 * a request is in flight, and every string exists in kk, ru and en.
 *
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch), a small fake of the server that validates every request body with the shared contract schemas and
 * applies the moderation rules (ACADEMY_VERIFIED without orgLabel is a 422, a status the drill already has is a 422). The
 * fixtures are parsed with the shared schemas, so they cannot drift from the API.
 *
 * Readings of the criteria that the tests pin (the simplest reading each time):
 * - "mark as REVIEWED / EXPERT VERIFIED / ACADEMY VERIFIED": the three targets the criteria name, minus the drill's own current
 *   status (STATUS_TRANSITIONS forbids a no-op); COMMUNITY is never offered.
 * - The organisation label field is shown for the two verified statuses; it is required for ACADEMY VERIFIED, optional for
 *   EXPERT VERIFIED (sent only when not blank) and never sent for REVIEWED.
 * - "shows the latest reviews entry": the newest review (by `at`) of the action response, in a "Latest review" block on the row.
 * - DrillDetail has no unpublished marker (backlog fc-3vc), so after an unpublish the row leaves the list and a notice says
 *   which drill was unpublished and why; the list is refetched.
 * - "Disabled while in flight": every mutation button and field of EVERY row is disabled while any action request runs.
 * Kazakh and Russian copy needs a native review: for those locales the tests pin only that text exists, is Cyrillic and never
 * leaks 'undefined', 'NaN', a raw key or an unfilled {{placeholder}}.
 */

type Locale = (typeof LOCALES)[number];

// --- the fake server (test data only: nothing here ships) ------------------------------------------------------------

type Status = 'COMMUNITY' | 'REVIEWED' | 'EXPERT_VERIFIED' | 'ACADEMY_VERIFIED';

type Row = {
  slug: string;
  title: { kk: string; ru: string; en: string };
  status: Status;
  orgLabel?: string;
  source?: string;
};

const GHOST: Row = {
  slug: 'ghost-ball',
  title: { kk: 'Елес доп', ru: 'Воображаемый мяч', en: 'Ghost Ball' },
  status: 'COMMUNITY',
  source: 'FIRST COACH Community Draft',
};
const WALL: Row = {
  slug: 'wall-passes',
  title: { kk: 'Қабырғаға пас', ru: 'Пасы в стену', en: 'Wall Passes' },
  status: 'REVIEWED',
};
const TOUCH: Row = {
  slug: 'first-touch-box',
  title: { kk: 'Бірінші жанасу', ru: 'Первое касание', en: 'First Touch Box' },
  status: 'ACADEMY_VERIFIED',
  orgLabel: 'FC Kairat Academy',
};

const summaryOf = (row: Row) =>
  DrillSummary.parse({
    slug: row.slug,
    title: row.title,
    track: 'ball-mastery',
    level: 'beginner',
    minutes: 10,
    equipment: 'nothing',
    space: 'home_3x3',
    status: row.status,
    versionId: `${row.slug}-v1`,
    ...(row.orgLabel === undefined ? {} : { orgLabel: row.orgLabel }),
    ...(row.source === undefined ? {} : { source: row.source }),
  });

const EMPTY_FACETS = { skills: [], statuses: [], equipment: [], levels: [] };

function detailOf(row: Row, reviews: DrillReview[]): DrillDetail {
  return DrillDetail.parse({
    slug: row.slug,
    versionId: `${row.slug}-v1`,
    content: {
      title: row.title,
      goal: { en: 'Get used to soft touches.' },
      instructions: { en: '1. Stand tall.' },
      dose: { reps: 10 },
      conditions: { equipment: 'nothing', spaces: ['home_3x3'], partner: false, ageMin: 5, ageMax: 99 },
    },
    attribution: { author: 'Test Author', source: 'Test Source', license: 'CC-BY-SA-4.0', createdAt: '2026-05-12T10:00:00.000Z', semver: '1.0.0' },
    history: [{ versionId: `${row.slug}-v1`, semver: '1.0.0', createdAt: '2026-05-12T10:00:00.000Z' }],
    reviews,
  });
}

const ADMIN = 'Admin Aigerim';
const NOW = '2026-09-22T09:30:00.000Z';

const OLD_REVIEW: DrillReview = {
  reviewer: 'Volunteer Coach',
  orgLabel: '',
  from: 'COMMUNITY',
  to: 'REVIEWED',
  note: 'Tried with an under-8 group.',
  at: '2026-02-01T12:00:00.000Z',
};

// --- the network ---------------------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status: number, errors: Array<{ pointer: string; detail: string }> = []) =>
  json({ type: 'about:blank', title: 'Problem', status, detail: 'Server text that must not be shown', errors }, status, 'application/problem+json');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Call = { method: string; path: string; search: string; body: unknown };
type Answer = () => Response | Promise<Response>;
type Overrides = { list?: Answer; status?: Answer; unpublish?: Answer };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
/** The fake server's rows and, per slug, its reviews (newest first, as the API sends them). */
let rows: Row[] = [];
let reviews: Record<string, DrillReview[]> = {};
let clock = 0;

const listCalls = () => calls.filter((call) => call.path === '/api/commons/drills');
const statusCalls = () => calls.filter((call) => call.path.endsWith('/status'));
const unpublishCalls = () => calls.filter((call) => call.path.endsWith('/unpublish'));
const actionCalls = () => [...statusCalls(), ...unpublishCalls()];

/** The moderation rules of fc-mol-0v3.5, applied to a request body that already parsed with the contract's schema. */
function applyStatus(row: Row, request: DrillStatusRequest): Response {
  if (request.toStatus === row.status)
    return problem(422, [{ pointer: '/toStatus', detail: 'same status' }]);
  if (request.toStatus === 'ACADEMY_VERIFIED' && (request.orgLabel ?? '').trim() === '')
    return problem(422, [{ pointer: '/orgLabel', detail: 'org label required' }]);
  const review: DrillReview = {
    reviewer: ADMIN,
    orgLabel: (request.orgLabel ?? '').trim(),
    from: row.status,
    to: request.toStatus,
    note: request.note.trim(),
    at: new Date(Date.parse(NOW) + clock++ * 1000).toISOString(),
  };
  reviews[row.slug] = [review, ...(reviews[row.slug] ?? [])];
  row.status = request.toStatus;
  if (review.orgLabel === '') delete row.orgLabel;
  else row.orgLabel = review.orgLabel;
  return json(detailOf(row, reviews[row.slug] ?? []));
}

function stubNetwork(overrides: Overrides = {}): void {
  calls = [];
  clock = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });

    if (url.pathname === '/api/commons/drills' && method === 'GET') {
      if (overrides.list !== undefined) return overrides.list();
      return json({ items: rows.map(summaryOf), nextCursor: null, total: rows.length, facets: EMPTY_FACETS });
    }
    const action = /^\/api\/admin\/drills\/([^/]+)\/(status|unpublish)$/.exec(url.pathname);
    if (action !== null && method === 'POST') {
      const [, slug, kind] = action;
      const override = kind === 'status' ? overrides.status : overrides.unpublish;
      if (override !== undefined) return override();
      const row = rows.find((candidate) => candidate.slug === slug);
      if (row === undefined) return problem(404);
      if (kind === 'status') {
        const parsed = DrillStatusRequest.safeParse(body);
        return parsed.success ? applyStatus(row, parsed.data) : problem(422, [{ pointer: '/note', detail: 'invalid body' }]);
      }
      const parsed = UnpublishRequest.safeParse(body);
      if (!parsed.success) return problem(422, [{ pointer: '/reason', detail: 'invalid body' }]);
      const review: DrillReview = { reviewer: ADMIN, orgLabel: '', from: row.status, to: row.status, note: parsed.data.reason.trim(), at: NOW };
      reviews[row.slug] = [review, ...(reviews[row.slug] ?? [])];
      const detail = detailOf(row, reviews[row.slug] ?? []);
      rows = rows.filter((candidate) => candidate !== row);
      return json(detail);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  rows = [structuredClone(GHOST), structuredClone(WALL), structuredClone(TOUCH)];
  reviews = { [WALL.slug]: [OLD_REVIEW] };
  stubNetwork();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------------------------------

const modules = {
  './drills.messages.ts': { default: messages },
  '../commons/trust-badge.messages.ts': { default: trustMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };
const DrillsPage = Route.options.component as () => ReactNode;

function renderDrills(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <DrillsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, user, instance, queryClient };
}

/** Renders and waits for the first drill of the list, so every later assertion sees the loaded screen. */
async function renderLoaded(locale: Locale = 'en') {
  const view = renderDrills(locale);
  await screen.findByRole('heading', { name: GHOST.title[locale] });
  return view;
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const rowOf = (title: string): HTMLElement => {
  const found = screen.getByRole('heading', { name: title }).closest('li');
  if (found === null) throw new Error(`no row for "${title}"`);
  return found;
};
const buttonIn = (root: HTMLElement, name: string | RegExp) => within(root).getByRole('button', { name }) as HTMLButtonElement;

type User = ReturnType<typeof userEvent.setup>;

async function openStatus(user: User, title: string): Promise<HTMLElement> {
  await user.click(buttonIn(rowOf(title), 'Change status'));
  return within(rowOf(title)).getByRole('form', { name: `Change status: ${title}` });
}

const pick = (user: User, form: HTMLElement, status: string) => user.click(within(form).getByRole('radio', { name: status }));
const noteField = (form: HTMLElement) => within(form).getByLabelText('Reviewer note') as HTMLTextAreaElement;
const orgField = (form: HTMLElement) => within(form).getByLabelText('Organisation') as HTMLInputElement;
const save = (user: User, form: HTMLElement) => user.click(buttonIn(form, /^(Save status|Saving…)$/));

async function openUnpublish(user: User, title: string): Promise<HTMLElement> {
  await user.click(buttonIn(rowOf(title), 'Unpublish'));
  return screen.findByRole('dialog', { name: new RegExp(`^Unpublish .*${title}`) });
}

const LEAKS = ['undefined', 'NaN', 'null', '{{', '[object'];

// --- the request and the list -------------------------------------------------------------------------------------------

describe('the list', () => {
  test('loads with one GET /api/commons/drills in the active language and lists every published drill', async () => {
    await renderLoaded();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.method).toBe('GET');
    expect(new URLSearchParams(listCalls()[0]?.search).get('locale')).toBe('en');
    expect(calls).toHaveLength(1);
    for (const row of [GHOST, WALL, TOUCH]) expect(screen.getByRole('heading', { name: row.title.en })).toBeTruthy();
  });

  test('every row states its trust status in words and an icon, and names the organisation of a verified one', async () => {
    await renderLoaded();
    expect(text(rowOf('Ghost Ball'))).toContain('Community Draft');
    expect(text(rowOf('Wall Passes'))).toContain('Reviewed');
    expect(text(rowOf('First Touch Box'))).toContain('Verified by FC Kairat Academy');
    for (const title of ['Ghost Ball', 'Wall Passes', 'First Touch Box']) {
      const badge = rowOf(title).querySelector('[data-status]');
      expect(badge?.querySelector('svg') === null).toBe(false);
    }
  });

  test('a drill title links to its public page', async () => {
    await renderLoaded();
    const link = within(rowOf('Ghost Ball')).getByRole('link', { name: 'Ghost Ball' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/commons/ghost-ball');
  });

  test('shows a busy, named status until the list arrives', async () => {
    const gate = deferred<Response>();
    stubNetwork({ list: () => gate.promise });
    renderDrills();
    const busy = await screen.findByRole('status', { name: messages.en.loading });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Ghost Ball' }) === null).toBe(true);
    gate.resolve(json({ items: rows.map(summaryOf), nextCursor: null, facets: EMPTY_FACETS }));
    expect(await screen.findByRole('heading', { name: 'Ghost Ball' })).toBeTruthy();
  });

  test('an empty commons shows an honest empty state, with no drill and no action buttons', async () => {
    rows = [];
    renderDrills();
    expect(await screen.findByText('No published drills yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change status' }) === null).toBe(true);
    expect(screen.queryByRole('button', { name: 'Unpublish' }) === null).toBe(true);
  });

  test('a failed load shows generic words (never the server text) and Try again, disabled and busy while it runs', async () => {
    let fail = true;
    const gate = deferred<Response>();
    stubNetwork({ list: () => (fail ? problem(500) : gate.promise) });
    const { user } = renderDrills();
    expect(await screen.findByText(messages.en.error.title)).toBeTruthy();
    expect(document.body.textContent).toContain(problemMessages.en.server);
    expect(document.body.textContent).not.toContain('Server text that must not be shown');

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    const retry = () => screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(retry().disabled).toBe(true));
    expect(retry().getAttribute('aria-busy')).toBe('true');
    gate.resolve(json({ items: rows.map(summaryOf), nextCursor: null, facets: EMPTY_FACETS }));
    expect(await screen.findByRole('heading', { name: 'Ghost Ball' })).toBeTruthy();
  });

  test('"Show more drills" asks for the next page with its cursor and adds the rows; it goes away on the last page', async () => {
    const first = json({ items: [summaryOf(GHOST), summaryOf(WALL)], nextCursor: 'page-2', total: 3, facets: EMPTY_FACETS });
    const second = json({ items: [summaryOf(TOUCH)], nextCursor: null, total: 3, facets: EMPTY_FACETS });
    let served = 0;
    stubNetwork({ list: () => (served++ === 0 ? first.clone() : second.clone()) });
    const { user } = renderDrills();
    await screen.findByRole('heading', { name: 'Ghost Ball' });
    expect(screen.queryByRole('heading', { name: 'First Touch Box' }) === null).toBe(true);
    await user.click(screen.getByRole('button', { name: messages.en.more }));
    expect(await screen.findByRole('heading', { name: 'First Touch Box' })).toBeTruthy();
    expect(new URLSearchParams(listCalls()[1]?.search).get('cursor')).toBe('page-2');
    expect(screen.queryByRole('button', { name: messages.en.more }) === null).toBe(true);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
  });
});

// --- the status panel ---------------------------------------------------------------------------------------------------

describe('changing the status: what is offered', () => {
  const offered = (form: HTMLElement) => within(form).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent?.trim());

  test('a Community drill can become Reviewed, Expert verified or Academy verified', async () => {
    const { user } = await renderLoaded();
    expect(offered(await openStatus(user, 'Ghost Ball'))).toEqual(['Reviewed', 'Expert verified', 'Academy verified']);
  });

  test('the drill\'s own status is never offered, and neither is Community', async () => {
    const { user } = await renderLoaded();
    expect(offered(await openStatus(user, 'Wall Passes'))).toEqual(['Expert verified', 'Academy verified']);
    expect(offered(await openStatus(user, 'First Touch Box'))).toEqual(['Reviewed', 'Expert verified']);
  });

  test('opening the panel sends nothing, puts focus inside it, and Cancel closes it without sending', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    expect(calls).toHaveLength(1);
    expect(form.contains(document.activeElement)).toBe(true);
    await user.click(buttonIn(form, 'Cancel'));
    await waitFor(() => expect(within(rowOf('Ghost Ball')).queryByRole('form') === null).toBe(true));
    expect(actionCalls()).toHaveLength(0);
  });

  test('the organisation field appears for the two verified statuses only', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    expect(within(form).queryByLabelText('Organisation') === null).toBe(true);
    await pick(user, form, 'Expert verified');
    expect(orgField(form)).toBeTruthy();
    await pick(user, form, 'Reviewed');
    expect(within(form).queryByLabelText('Organisation') === null).toBe(true);
    await pick(user, form, 'Academy verified');
    expect(orgField(form)).toBeTruthy();
  });

  test('the fields are labelled and the form has a submit and a cancel button of at least a real <button>', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Academy verified');
    expect(noteField(form).tagName).toBe('TEXTAREA');
    expect(orgField(form).tagName).toBe('INPUT');
    expect(within(form).getByRole('group', { name: 'New status' })).toBeTruthy();
    expect(buttonIn(form, 'Save status').getAttribute('type')).toBe('submit');
  });
});

describe('changing the status: what must be filled in', () => {
  test('a status must be chosen: nothing is sent and the missing choice is named', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await user.type(noteField(form), 'Looks good.');
    await save(user, form);
    expect((await within(form).findByRole('alert')).textContent).toContain(messages.en.status.errors.choose);
    expect(actionCalls()).toHaveLength(0);
  });

  test('the note is required, and a note of only spaces does not count: nothing is sent', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Reviewed');
    await user.type(noteField(form), '   ');
    await save(user, form);
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(messages.en.status.errors.note);
    expect(noteField(form).getAttribute('aria-invalid')).toBe('true');
    expect(noteField(form).getAttribute('aria-describedby')).toContain(alert.id);
    expect(actionCalls()).toHaveLength(0);
  });

  test('ACADEMY VERIFIED needs an organisation label: blank or spaces sends nothing and says so on the field', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Academy verified');
    await user.type(noteField(form), 'Checked by the academy staff.');
    await save(user, form);
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(messages.en.status.errors.org);
    expect(orgField(form).getAttribute('aria-invalid')).toBe('true');
    expect(orgField(form).getAttribute('aria-describedby')).toContain(alert.id);
    expect(actionCalls()).toHaveLength(0);

    await user.type(orgField(form), '   ');
    await save(user, form);
    expect(actionCalls()).toHaveLength(0);
  });

  test('with the label the request is sent exactly as the contract wants: POST {toStatus, orgLabel, note}', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Academy verified');
    await user.type(noteField(form), 'Checked by the academy staff.');
    await user.type(orgField(form), '  FC Kairat Academy ');
    await save(user, form);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    const call = statusCalls()[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/admin/drills/ghost-ball/status');
    expect(call.body).toEqual({ toStatus: 'ACADEMY_VERIFIED', orgLabel: 'FC Kairat Academy', note: 'Checked by the academy staff.' });
    expect(DrillStatusRequest.safeParse(call.body).success).toBe(true);
  });

  test('EXPERT VERIFIED takes the label optionally: a blank one is left out, a filled one is sent trimmed', async () => {
    const { user } = await renderLoaded();
    let form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Expert verified');
    await user.type(noteField(form), 'A licensed coach checked it.');
    await save(user, form);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(statusCalls()[0]?.body).toEqual({ toStatus: 'EXPERT_VERIFIED', note: 'A licensed coach checked it.' });

    await waitFor(() => expect(within(rowOf('Ghost Ball')).queryByRole('form') === null).toBe(true));
    form = await openStatus(user, 'Wall Passes');
    await pick(user, form, 'Expert verified');
    await user.type(noteField(form), 'Second check.');
    await user.type(orgField(form), ' Federation ');
    await save(user, form);
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    expect(statusCalls()[1]?.body).toEqual({ toStatus: 'EXPERT_VERIFIED', orgLabel: 'Federation', note: 'Second check.' });
  });

  test('REVIEWED never sends a label, even one typed before the choice was changed', async () => {
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Academy verified');
    await user.type(orgField(form), 'FC Kairat Academy');
    await pick(user, form, 'Reviewed');
    await user.type(noteField(form), 'Tried it with a group.');
    await save(user, form);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(statusCalls()[0]?.body).toEqual({ toStatus: 'REVIEWED', note: 'Tried it with a group.' });
  });
});

describe('changing the status: what the row does with the answer', () => {
  async function markAcademy(user: User, title = 'Ghost Ball') {
    const form = await openStatus(user, title);
    await pick(user, form, 'Academy verified');
    await user.type(noteField(form), 'Checked by the academy staff.');
    await user.type(orgField(form), 'FC Kairat Academy');
    await save(user, form);
  }

  test('the row shows the new status from the response and the panel closes', async () => {
    const { user } = await renderLoaded();
    await markAcademy(user);
    await waitFor(() => expect(text(rowOf('Ghost Ball'))).toContain('Verified by FC Kairat Academy'));
    expect(within(rowOf('Ghost Ball')).queryByRole('form') === null).toBe(true);
    expect(text(rowOf('Ghost Ball'))).not.toContain('Community Draft');
    // The other rows are untouched.
    expect(text(rowOf('Wall Passes'))).toContain('Reviewed');
    expect(text(rowOf('First Touch Box'))).toContain('Verified by FC Kairat Academy');
  });

  test('the row shows the latest reviews entry: who, when, the change, the organisation and the note', async () => {
    const { user } = await renderLoaded();
    await markAcademy(user);
    const latest = await within(rowOf('Ghost Ball')).findByRole('region', { name: messages.en.row.latest });
    expect(text(latest)).toContain(ADMIN);
    expect(text(latest)).toContain('September 22, 2026');
    expect(text(latest)).toContain('Changed from Community to Academy verified');
    expect(text(latest)).toContain('FC Kairat Academy');
    expect(text(latest)).toContain('Checked by the academy staff.');
    // A row nobody acted on shows no invented review.
    expect(within(rowOf('Wall Passes')).queryByRole('region', { name: messages.en.row.latest }) === null).toBe(true);
  });

  test('"latest" is the newest review by date, whatever order the reviews come in', async () => {
    const older: DrillReview = { ...OLD_REVIEW, note: 'The older note.', at: '2026-01-01T00:00:00.000Z' };
    const newer: DrillReview = { ...OLD_REVIEW, note: 'The newer note.', from: 'REVIEWED', to: 'EXPERT_VERIFIED', at: '2026-09-01T00:00:00.000Z' };
    stubNetwork({ status: () => json(detailOf(GHOST, [older, newer])) });
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Expert verified');
    await user.type(noteField(form), 'A note.');
    await save(user, form);
    const latest = await within(rowOf('Ghost Ball')).findByRole('region', { name: messages.en.row.latest });
    expect(text(latest)).toContain('The newer note.');
    expect(text(latest)).not.toContain('The older note.');
    expect(text(rowOf('Ghost Ball'))).toContain('Expert verified');
  });

  test('a success is announced, and focus goes back to the row\'s Change status button', async () => {
    const { user } = await renderLoaded();
    await markAcademy(user);
    await waitFor(() => expect(text(rowOf('Ghost Ball'))).toContain(messages.en.row.saved));
    await waitFor(() => expect(document.activeElement).toBe(buttonIn(rowOf('Ghost Ball'), 'Change status')));
  });

  test('the list is asked for again, and every cached commons page is marked stale', async () => {
    const { user, queryClient } = await renderLoaded();
    queryClient.setQueryData(['commons', 'detail', 'ghost-ball', 'en'], { placeholder: true });
    await markAcademy(user);
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    expect(queryClient.getQueryState(['commons', 'detail', 'ghost-ball', 'en'])?.isInvalidated).toBe(true);
    // The server's own list agrees with the response, so the row still reads the same after the refetch.
    await waitFor(() => expect(text(rowOf('Ghost Ball'))).toContain('Verified by FC Kairat Academy'));
  });
});

describe('changing the status: in flight and failure', () => {
  test('while the request runs every mutation button and field, on every row, is disabled and nothing is sent twice', async () => {
    const gate = deferred<Response>();
    stubNetwork({ status: () => gate.promise });
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Reviewed');
    await user.type(noteField(form), 'Tried it with a group.');
    await save(user, form);

    const submit = () => buttonIn(within(rowOf('Ghost Ball')).getByRole('form'), /^(Save status|Saving…)$/);
    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(submit().getAttribute('aria-busy')).toBe('true');
    expect(buttonIn(form, 'Cancel').disabled).toBe(true);
    expect(noteField(form).disabled).toBe(true);
    for (const radio of within(form).getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true);
    for (const title of ['Ghost Ball', 'Wall Passes', 'First Touch Box']) {
      expect(buttonIn(rowOf(title), 'Change status').disabled).toBe(true);
      expect(buttonIn(rowOf(title), 'Unpublish').disabled).toBe(true);
    }
    await user.click(submit());
    await user.keyboard('{Enter}');
    expect(statusCalls()).toHaveLength(1);

    gate.resolve(json(detailOf(GHOST, [{ ...OLD_REVIEW, reviewer: ADMIN, note: 'Tried it with a group.', at: NOW }])));
    await waitFor(() => expect(buttonIn(rowOf('Wall Passes'), 'Change status').disabled).toBe(false));
    expect(buttonIn(rowOf('Wall Passes'), 'Unpublish').disabled).toBe(false);
  });

  test('a server refusal of the label shows on the label field in the screen\'s own words, and the typed values stay', async () => {
    stubNetwork({ status: () => problem(422, [{ pointer: '/orgLabel', detail: 'org label required (server text)' }]) });
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Academy verified');
    await user.type(noteField(form), 'Checked by the academy staff.');
    await user.type(orgField(form), 'FC Kairat Academy');
    await save(user, form);
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(messages.en.status.errors.org);
    expect(alert.textContent).not.toContain('server text');
    expect(orgField(form).getAttribute('aria-invalid')).toBe('true');
    expect(noteField(form).value).toBe('Checked by the academy staff.');
    expect(orgField(form).value).toBe('FC Kairat Academy');
    expect(buttonIn(form, 'Save status').disabled).toBe(false);
  });

  test('any other failure shows the generic localised message (never the server text), keeps the panel and can be retried', async () => {
    let fail = true;
    stubNetwork({ status: () => (fail ? problem(500) : json(detailOf(GHOST, [{ ...OLD_REVIEW, reviewer: ADMIN, note: 'Tried it with a group.', at: NOW }]))) });
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Reviewed');
    await user.type(noteField(form), 'Tried it with a group.');
    await save(user, form);
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(alert.textContent).not.toContain('Server text that must not be shown');
    expect(noteField(form).value).toBe('Tried it with a group.');
    expect(text(rowOf('Ghost Ball'))).toContain('Community Draft');

    fail = false;
    await save(user, form);
    await waitFor(() => expect(within(rowOf('Ghost Ball')).queryByRole('form') === null).toBe(true));
    expect(statusCalls()).toHaveLength(2);
    expect(text(rowOf('Ghost Ball'))).toContain('Reviewed');
  });

  test('a drill that is no longer published (404) is said so and the list is asked for again', async () => {
    stubNetwork({ status: () => problem(404) });
    const { user } = await renderLoaded();
    const form = await openStatus(user, 'Ghost Ball');
    await pick(user, form, 'Reviewed');
    await user.type(noteField(form), 'Tried it with a group.');
    await save(user, form);
    expect((await within(form).findByRole('alert')).textContent).toContain(problemMessages.en.notFound);
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
  });
});

// --- unpublish ----------------------------------------------------------------------------------------------------------

describe('unpublish: the confirm dialog', () => {
  test('the button only opens a dialog: nothing is sent, the drill and the consequence are named, and focus is inside', async () => {
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    expect(actionCalls()).toHaveLength(0);
    expect(text(dialog)).toContain('Ghost Ball');
    expect(text(dialog)).toContain(messages.en.unpublish.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('"Keep it published" closes it and sends nothing; so does Escape', async () => {
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it published' }));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(actionCalls()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Ghost Ball' })).toBeTruthy();

    await openUnpublish(user, 'Ghost Ball');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(actionCalls()).toHaveLength(0);
  });

  test('the confirm button has a word and an icon, so it is never colour alone', async () => {
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    const confirm = within(dialog).getByRole('button', { name: 'Unpublish drill' });
    expect(confirm.querySelector('svg') === null).toBe(false);
    expect(confirm.getAttribute('data-variant')).toBe('danger');
  });

  test('a reason is required: blank or spaces sends nothing and says so on the field', async () => {
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    await user.click(within(dialog).getByRole('button', { name: 'Unpublish drill' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(messages.en.unpublish.errors.reason);
    const reason = within(dialog).getByLabelText('Reason') as HTMLTextAreaElement;
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-describedby')).toContain(alert.id);

    await user.type(reason, '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Unpublish drill' }));
    expect(actionCalls()).toHaveLength(0);
  });
});

describe('unpublish: confirming', () => {
  async function confirmUnpublish(user: User, title = 'Ghost Ball', reason = 'Rights complaint from the photographer.') {
    const dialog = await openUnpublish(user, title);
    await user.type(within(dialog).getByLabelText('Reason'), reason);
    await user.click(within(dialog).getByRole('button', { name: 'Unpublish drill' }));
  }

  test('confirming sends exactly POST {reason}, closes the dialog and takes the row off the list', async () => {
    const { user } = await renderLoaded();
    await confirmUnpublish(user);
    await waitFor(() => expect(unpublishCalls()).toHaveLength(1));
    const call = unpublishCalls()[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/admin/drills/ghost-ball/unpublish');
    expect(call.body).toEqual({ reason: 'Rights complaint from the photographer.' });
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ghost Ball' }) === null).toBe(true));
    expect(screen.getByRole('heading', { name: 'Wall Passes' })).toBeTruthy();
  });

  test('a notice says which drill was unpublished and why, since the row is gone', async () => {
    const { user } = await renderLoaded();
    await confirmUnpublish(user);
    const notice = await screen.findByText(/was unpublished/);
    const block = notice.closest('[role="status"]') as HTMLElement;
    expect(text(block)).toContain('Ghost Ball');
    expect(text(block)).toContain('Rights complaint from the photographer.');
  });

  test('the list is asked for again (the server no longer lists the drill) and every cached commons page is marked stale', async () => {
    const { user, queryClient } = await renderLoaded();
    queryClient.setQueryData(['commons', 'detail', 'ghost-ball', 'en'], { placeholder: true });
    await confirmUnpublish(user);
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    expect(queryClient.getQueryState(['commons', 'detail', 'ghost-ball', 'en'])?.isInvalidated).toBe(true);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ghost Ball' }) === null).toBe(true));
    expect(screen.getByRole('heading', { name: 'Wall Passes' })).toBeTruthy();
  });

  test('in flight both buttons and the reason are disabled, Escape does not close the dialog, and nothing is sent twice', async () => {
    const gate = deferred<Response>();
    stubNetwork({ unpublish: () => gate.promise });
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    await user.type(within(dialog).getByLabelText('Reason'), 'Rights complaint.');
    await user.click(within(dialog).getByRole('button', { name: 'Unpublish drill' }));

    const confirm = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpublish drill' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm().disabled).toBe(true));
    expect(confirm().getAttribute('aria-busy')).toBe('true');
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep it published' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByRole('dialog')).getByLabelText('Reason') as HTMLTextAreaElement).disabled).toBe(true);
    await user.click(confirm());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog') === null).toBe(false);
    expect(unpublishCalls()).toHaveLength(1);

    gate.resolve(json(detailOf(GHOST, [{ ...OLD_REVIEW, reviewer: ADMIN, note: 'Rights complaint.', at: NOW }])));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
  });

  test('a failure keeps the dialog open with the generic message and the reason, and it can be tried again', async () => {
    let fail = true;
    stubNetwork({ unpublish: () => (fail ? problem(500) : json(detailOf(GHOST, [{ ...OLD_REVIEW, reviewer: ADMIN, note: 'Rights complaint.', at: NOW }]))) });
    const { user } = await renderLoaded();
    const dialog = await openUnpublish(user, 'Ghost Ball');
    await user.type(within(dialog).getByLabelText('Reason'), 'Rights complaint.');
    await user.click(within(dialog).getByRole('button', { name: 'Unpublish drill' }));

    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(alert.textContent).not.toContain('Server text that must not be shown');
    expect((within(screen.getByRole('dialog')).getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('Rights complaint.');
    expect(screen.queryByRole('heading', { name: 'Ghost Ball' }) === null).toBe(true);

    fail = false;
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpublish drill' }));
    await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
    expect(unpublishCalls()).toHaveLength(2);
  });
});

// --- kk, ru, en -------------------------------------------------------------------------------------------------------

describe.each(['kk', 'ru'] as const)('in %s', (locale) => {
  const CYRILLIC = /[Ѐ-ӿ]/;

  test('the screen, the status panel and its errors are in that language, with no leaked keys', async () => {
    const { user } = await renderLoaded(locale);
    const main = screen.getByRole('main');
    expect(text(main)).toContain(messages[locale].title);
    expect(text(main)).toContain(messages[locale].row.changeStatus);
    expect(text(main)).toContain(trustMessages[locale].reviewed);

    const change = within(rowOf(WALL.title[locale])).getByRole('button', { name: messages[locale].row.changeStatus });
    await user.click(change);
    const form = within(rowOf(WALL.title[locale])).getByRole('form');
    await user.click(within(form).getByRole('button', { name: messages[locale].status.save }));
    const alert = await within(form).findByRole('alert');
    expect(text(alert)).toContain(messages[locale].status.errors.choose);
    for (const leak of LEAKS) expect(text(rowOf(WALL.title[locale]))).not.toContain(leak);
    expect(CYRILLIC.test(text(form))).toBe(true);
    expect(actionCalls()).toHaveLength(0);
  });

  test('the unpublish dialog is in that language and asks for the reason before it sends anything', async () => {
    const { user } = await renderLoaded(locale);
    await user.click(within(rowOf(GHOST.title[locale])).getByRole('button', { name: messages[locale].row.unpublish }));
    const dialog = await screen.findByRole('dialog');
    expect(text(dialog)).toContain(messages[locale].unpublish.body);
    expect(text(dialog)).toContain(GHOST.title[locale]);
    await user.click(within(dialog).getByRole('button', { name: messages[locale].unpublish.confirm }));
    expect(text(await within(dialog).findByRole('alert'))).toContain(messages[locale].unpublish.errors.reason);
    for (const leak of LEAKS) expect(text(dialog)).not.toContain(leak);
    expect(CYRILLIC.test(text(dialog))).toBe(true);
    expect(actionCalls()).toHaveLength(0);
  });
});
