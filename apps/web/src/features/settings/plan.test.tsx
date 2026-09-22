import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION, type PlayerProfile, type Roadmap } from '@api-types/domain';
import { PatchProfileRequest, PatchProfileResponse, ResetPlanResponse } from '@api-types/journey';
import { OnboardingOptions, StartResponse } from '@api-types/onboarding';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, SPACES } from '@api-types/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import messages from './plan.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. Register happy-dom here BEFORE
// Testing Library is imported, exactly as retest.test.tsx does (a no-op under the preload).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
// The route pulls in Radix Dialog, which decides at import time whether a DOM exists (its layout effects are no-ops without
// one). Import it only now, after happy-dom is registered, so the file also passes when bun runs from the repository root.
const { Route } = await import('../../routes/settings/plan');

/*
 * The plan settings screen (/settings/plan), written from the bead's acceptance criteria (fc-mol-0bt.10):
 *  - the player changes goal, equipment, space, partner, days per week and minutes per session (option lists from
 *    GET /api/onboarding/:sport), saves with PATCH /api/player/profile and sees the rebuilt roadmap focus;
 *  - the save sends ONLY the changed fields;
 *  - "Redo baseline" asks for confirmation first, then calls POST /api/player/plan/reset and goes to the baseline step;
 *  - a server field error is shown on its field;
 *  - loading, empty, error, disabled and success states; mutation buttons are disabled while a request is in flight;
 *  - every string in kk, ru and en; ['me'], ['today'] and ['journey'] are invalidated after a success.
 * Real data goes through the real typed client (lib/api.ts) and React Query; the only stand-in is the network
 * (globalThis.fetch). The route is mounted in a real (memory-history) router. Fixtures are parsed with the shared contract
 * schemas, so they cannot drift from the API. Kazakh copy needs a native review; the Kazakh assertions pin one string only.
 */

type Locale = (typeof LOCALES)[number];

// --- fixtures (test data only: nothing here ships) ------------------------------------------------------------------

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

/** The plan the API rebuilds after the edit: another focus, so the screen must show the RESPONSE and not the old roadmap. */
const REBUILT: Roadmap = {
  ...ROADMAP,
  goal: 'dribbling',
  focus: [
    { skill: 'dribbling', level: 3, targetLevel: 4, reason: 'goal' },
    { skill: 'passing-first-touch', level: 2, targetLevel: 2, reason: 'weakest' },
  ],
};

const ME = StartResponse.parse({ profile: PROFILE, roadmap: ROADMAP });

const OPTIONS = OnboardingOptions.parse({
  levels: [...EXPERIENCE_LEVELS],
  goals: [...GOALS],
  equipment: [...EQUIPMENT],
  spaces: [...SPACES],
  partner: [false, true],
  daysPerWeek: [...DAYS_PER_WEEK],
  minutesPerSession: [...MINUTES_PER_SESSION],
  tests: [
    {
      slug: 'juggling-max-touches',
      skill: 'ball-mastery',
      metric: 'juggling max touches',
      unit: 'touches',
      direction: 'higher',
      equipment: 'ball',
      protocol: { en: '1. Juggle with your stronger foot.' },
    },
  ],
});

const saved = (profile: Partial<PlayerProfile>, roadmap: Roadmap | null = REBUILT) =>
  PatchProfileResponse.parse({ profile: { ...PROFILE, ...profile }, roadmap });

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

type Call = { method: string; path: string; search: string; headers: Headers; body: unknown };
type Server = {
  me?: () => Response | Promise<Response>;
  options?: () => Response | Promise<Response>;
  patch?: (body: unknown) => Response | Promise<Response>;
  reset?: () => Response | Promise<Response>;
};

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubNetwork(server: Server = {}): void {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, headers: new Headers(init?.headers), body });
    if (url.pathname === '/api/onboarding/football') return (server.options ?? (() => json(OPTIONS)))();
    if (url.pathname === '/api/player/me') return (server.me ?? (() => json(ME)))();
    if (url.pathname === '/api/player/profile' && method === 'PATCH') return (server.patch ?? (() => json(saved({}))))(body);
    if (url.pathname === '/api/player/plan/reset' && method === 'POST') {
      return (server.reset ?? (() => json(ResetPlanResponse.parse({ profile: PROFILE, roadmap: null }))))();
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const patches = () => calls.filter((call) => call.method === 'PATCH');
const resets = () => calls.filter((call) => call.path === '/api/player/plan/reset');
const meGets = () => calls.filter((call) => call.path === '/api/player/me' && call.method === 'GET');

const DRAFT_KEY = 'fc:onboarding-draft';

beforeEach(() => {
  stubNetwork();
  try {
    sessionStorage.clear();
  } catch {
    // no storage: the draft assertions would fail loudly
  }
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// --- rendering ----------------------------------------------------------------------------------

const modules = {
  './plan.messages.ts': { default: messages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};
const noStorage = { getItem: () => null, setItem: () => {} };

/** The route in a real router at /settings/plan, with stand-ins for the routes it links or navigates to. */
async function renderPlan(locale: Locale = 'en') {
  const instance = createI18n({ modules, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const rootRoute = createRootRoute();
  const planRoute = Route.update({ id: '/settings/plan', path: '/settings/plan', getParentRoute: () => rootRoute } as never);
  const stand = (path: string, label: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{label}</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      planRoute as never,
      stand('/train/onboarding', 'ONBOARDING STAND-IN') as never,
      stand('/train/roadmap', 'ROADMAP STAND-IN') as never,
      stand('/train', 'TRAIN STAND-IN') as never,
    ]),
    history: createMemoryHistory({ initialEntries: ['/settings/plan'] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user: userEvent.setup() };
}

/** Renders and waits for the form (the title is there from the first frame, so wait for the Save button). */
async function renderForm(locale: Locale = 'en') {
  const view = await renderPlan(locale);
  await screen.findByRole('button', { name: locale === 'en' ? 'Save changes' : messages[locale].save.submit });
  return view;
}

const group = (name: string): HTMLElement => screen.getByRole('group', { name });
const radio = (groupName: string, optionName: string): HTMLInputElement =>
  within(group(groupName)).getByRole('radio', { name: optionName }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;

const GOAL = 'Main goal';
const EQUIPMENT_GROUP = 'What do you have?';
const SPACE = 'Where will you train?';
const PARTNER = 'Is there someone to train with?';
const DAYS = 'Days per week';
const MINUTES = 'Minutes per session';

// --- the screen before any edit -------------------------------------------------------------------

describe('the screen before any edit', () => {
  test('reads the plan once (GET /api/player/me) and the option lists once (GET /api/onboarding/football) in the active language', async () => {
    await renderForm('ru');
    expect(calls.map((call) => call.path).sort()).toEqual(['/api/onboarding/football', '/api/player/me']);
    expect(calls.find((call) => call.path === '/api/onboarding/football')!.search).toContain('locale=ru');
  });

  test('offers exactly the lists the API sent, for every one of the six settings', async () => {
    await renderForm();
    expect(within(group(GOAL)).getAllByRole('radio')).toHaveLength(GOALS.length);
    expect(within(group(EQUIPMENT_GROUP)).getAllByRole('radio')).toHaveLength(EQUIPMENT.length);
    expect(within(group(SPACE)).getAllByRole('radio')).toHaveLength(SPACES.length);
    expect(within(group(PARTNER)).getAllByRole('radio')).toHaveLength(2);
    expect(within(group(DAYS)).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(
      DAYS_PER_WEEK.map(String),
    );
    expect(within(group(MINUTES)).getAllByRole('radio')).toHaveLength(MINUTES_PER_SESSION.length);
  });

  test('a list the API narrows is narrowed on screen too (nothing is hard-coded)', async () => {
    stubNetwork({ options: () => json({ ...OPTIONS, daysPerWeek: [3, 4], goals: ['control', 'passing'] }) });
    await renderForm();
    expect(within(group(DAYS)).getAllByRole('radio')).toHaveLength(2);
    expect(within(group(GOAL)).getAllByRole('radio')).toHaveLength(2);
  });

  test("the player's current answers are the selected ones", async () => {
    await renderForm();
    expect(radio(GOAL, 'Control the ball with confidence').checked).toBe(true);
    expect(radio(EQUIPMENT_GROUP, 'Ball only').checked).toBe(true);
    expect(radio(SPACE, 'Yard').checked).toBe(true);
    expect(radio(PARTNER, 'No').checked).toBe(true);
    expect(radio(DAYS, '3').checked).toBe(true);
    expect(radio(MINUTES, '20 min').checked).toBe(true);
  });

  test('the selected option carries a check mark, not only a colour', async () => {
    await renderForm();
    const chosen = radio(SPACE, 'Yard').closest('label')!;
    expect(chosen.querySelector('[data-slot="selected-mark"]')).not.toBeNull();
    expect(radio(SPACE, 'Field').closest('label')!.querySelector('[data-slot="selected-mark"]')).toBeNull();
  });

  test('Save is disabled while nothing has changed and says why', async () => {
    await renderForm();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute('aria-describedby')).toBeTruthy();
    const hint = document.getElementById(saveButton().getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/change something to save/i);
  });

  test('the title is the only h1 and Redo baseline is a separate section further down', async () => {
    await renderForm();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Plan settings']);
    expect(screen.getByRole('heading', { level: 2, name: 'Redo baseline' })).toBeTruthy();
  });
});

// --- saving only what changed ---------------------------------------------------------------------------

describe('saving', () => {
  test('sends only the changed fields with PATCH /api/player/profile', async () => {
    const { user } = await renderForm();
    await user.click(radio(MINUTES, '30 min'));
    await user.click(radio(PARTNER, 'Yes'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.path).toBe('/api/player/profile');
    expect(patches()[0]!.body).toEqual({ minutesPerSession: 30, partner: true });
  });

  test('a single changed field is a single-key body, and it is a valid PatchProfileRequest', async () => {
    const { user } = await renderForm();
    await user.click(radio(GOAL, 'Improve dribbling'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(patches()[0]!.body).toEqual({ goal: 'dribbling' });
    expect(PatchProfileRequest.safeParse(patches()[0]!.body).success).toBe(true);
  });

  test('every editable field can be sent: goal, equipment, space, partner, days and minutes', async () => {
    const { user } = await renderForm();
    await user.click(radio(GOAL, 'Coordination'));
    await user.click(radio(EQUIPMENT_GROUP, 'Ball + wall'));
    await user.click(radio(SPACE, 'Gym'));
    await user.click(radio(PARTNER, 'Yes'));
    await user.click(radio(DAYS, '5'));
    await user.click(radio(MINUTES, '45 min'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(patches()[0]!.body).toEqual({
      goal: 'coordination',
      equipment: 'ball_wall',
      space: 'gym',
      partner: true,
      daysPerWeek: 5,
      minutesPerSession: 45,
    });
  });

  test('a choice changed and changed back is not sent, and Save is disabled again', async () => {
    const { user } = await renderForm();
    await user.click(radio(MINUTES, '30 min'));
    expect(saveButton().disabled).toBe(false);
    await user.click(radio(MINUTES, '20 min'));
    expect(saveButton().disabled).toBe(true);
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(patches()[0]!.body).toEqual({ daysPerWeek: 4 });
  });

  test("the request carries the player's time zone, so the API drops the right day's session", async () => {
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(patches()[0]!.headers.get('x-timezone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test('the rebuilt roadmap focus from the RESPONSE is shown, with each skill and its level step', async () => {
    const { user } = await renderForm();
    await user.click(radio(GOAL, 'Improve dribbling'));
    await user.click(saveButton());
    const heading = await screen.findByRole('heading', { name: 'Plan updated' });
    const list = within(heading.closest('section')!).getByRole('list', { name: 'Focus skills' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Dribbling');
    expect(items[0]!.textContent).toContain('Level 3 → 4');
    expect(items[1]!.textContent).toContain('Passing and first touch');
    expect(items[1]!.textContent).toContain('Level 2: keep it steady');
    // the OLD plan's focus is not what is shown
    expect(within(list).queryByText(/ball mastery/i)).toBeNull();
  });

  test('after a save the form shows the saved answers and Save is disabled until the next edit', async () => {
    // A real server answers the re-read of the plan with what was just saved: the stub does the same.
    let current: unknown = ME;
    stubNetwork({
      me: () => json(current),
      patch: () => {
        current = StartResponse.parse({ profile: { ...PROFILE, minutesPerSession: 30 }, roadmap: REBUILT });
        return json(saved({ minutesPerSession: 30 }));
      },
    });
    const { user } = await renderForm();
    await user.click(radio(MINUTES, '30 min'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(radio(MINUTES, '30 min').checked).toBe(true);
    // the next edit is measured against what was just saved
    await user.click(radio(MINUTES, '20 min'));
    await user.click(saveButton());
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body).toEqual({ minutesPerSession: 20 });
  });

  test('the saved answers stay on screen while the plan is being read again (no flash back to the old ones)', async () => {
    const gate = deferred<Response>();
    let reread = false;
    stubNetwork({
      me: () => (reread ? gate.promise : json(ME)),
      patch: () => {
        reread = true;
        return json(saved({ minutesPerSession: 30 }));
      },
    });
    const { user } = await renderForm();
    await user.click(radio(MINUTES, '30 min'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    await waitFor(() => expect(meGets().length).toBeGreaterThanOrEqual(2));
    // the re-read has not answered yet: the form already shows what was saved and has nothing left to save
    expect(radio(MINUTES, '30 min').checked).toBe(true);
    expect(radio(MINUTES, '20 min').checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    gate.resolve(json(StartResponse.parse({ profile: { ...PROFILE, minutesPerSession: 30 }, roadmap: REBUILT })));
  });

  test('focus moves to the success heading, because the button that had it is disabled again', async () => {
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    const heading = await screen.findByRole('heading', { name: 'Plan updated' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test('editing again hides the success block, so it never describes an unsaved choice', async () => {
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    await user.click(radio(DAYS, '5'));
    expect(screen.queryByRole('heading', { name: 'Plan updated' })).toBeNull();
  });

  test('when the API answers with no roadmap the choices are still confirmed, without a focus list', async () => {
    stubNetwork({ patch: () => json(saved({ daysPerWeek: 4 }, null)) });
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    const heading = await screen.findByRole('heading', { name: 'Plan updated' });
    expect(within(heading.closest('section')!).queryByRole('list')).toBeNull();
    expect(within(heading.closest('section')!).getByText(/your choices are saved/i)).toBeTruthy();
  });

  test("invalidates the player's plan, today's session and journey after a success", async () => {
    const { user, queryClient } = await renderForm();
    queryClient.setQueryData(['today'], { placeholder: true });
    queryClient.setQueryData(['journey', 'en'], { placeholder: true });
    expect(queryClient.getQueryState(['today'])!.isInvalidated).toBe(false);
    expect(meGets()).toHaveLength(1);

    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });

    expect(queryClient.getQueryState(['today'])!.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['journey', 'en'])!.isInvalidated).toBe(true);
    // ['me'] has an observer here, so invalidating it means it is fetched again
    await waitFor(() => expect(meGets().length).toBeGreaterThanOrEqual(2));
  });

  test('does not invalidate anything when the save fails', async () => {
    stubNetwork({ patch: () => problem(500) });
    const { user, queryClient } = await renderForm();
    queryClient.setQueryData(['today'], { placeholder: true });
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await screen.findByRole('alert');
    expect(queryClient.getQueryState(['today'])!.isInvalidated).toBe(false);
    expect(meGets()).toHaveLength(1);
  });
});

// --- disabled while a request is in flight ----------------------------------------------------------------

describe('while the save is in flight', () => {
  test('Save is busy and disabled, every choice is disabled, Redo baseline is disabled, and a second click sends nothing', async () => {
    const gate = deferred<Response>();
    stubNetwork({ patch: () => gate.promise });
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(radio(DAYS, '5').disabled).toBe(true);
    expect(radio(GOAL, 'Coordination').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Redo baseline' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(saveButton());
    expect(patches()).toHaveLength(1);

    gate.resolve(json(saved({ daysPerWeek: 4 })));
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(radio(DAYS, '5').disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Redo baseline' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// --- server errors ---------------------------------------------------------------------------------------

describe('a rejected save', () => {
  test('a server field error is shown on its field, in words with an icon, and linked to the group', async () => {
    stubNetwork({
      patch: () =>
        problem(422, {
          detail: 'The request is invalid.',
          errors: [{ pointer: '/equipment', detail: 'This equipment does not fit the chosen space.' }],
        }),
    });
    const { user } = await renderForm();
    await user.click(radio(EQUIPMENT_GROUP, 'Full field'));
    await user.click(saveButton());

    const fieldGroup = group(EQUIPMENT_GROUP);
    const message = await within(fieldGroup).findByText('This equipment does not fit the chosen space.');
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(message.closest('[role="alert"]')!.querySelector('svg')).not.toBeNull();
    const describedBy = fieldGroup.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toContain(message.closest('[role="alert"]')!.id);
    // the other groups carry no error
    expect(within(group(GOAL)).queryByRole('alert')).toBeNull();
    expect(within(group(SPACE)).queryByRole('alert')).toBeNull();
  });

  test('the error is on the field it names, not on another', async () => {
    stubNetwork({
      patch: () => problem(422, { errors: [{ pointer: '/minutesPerSession', detail: 'Pick one of the offered lengths.' }] }),
    });
    const { user } = await renderForm();
    await user.click(radio(MINUTES, '45 min'));
    await user.click(saveButton());
    await within(group(MINUTES)).findByText('Pick one of the offered lengths.');
    expect(within(group(DAYS)).queryByText('Pick one of the offered lengths.')).toBeNull();
  });

  test('after a failure the choices are kept, Save works again, and a retry sends the same changes', async () => {
    let fail = true;
    stubNetwork({
      patch: () => (fail ? problem(422, { errors: [{ pointer: '/goal', detail: 'Not possible.' }] }) : json(saved({ goal: 'passing' }))),
    });
    const { user } = await renderForm();
    await user.click(radio(GOAL, 'Passing and first touch'));
    await user.click(saveButton());
    await within(group(GOAL)).findByText('Not possible.');
    expect(radio(GOAL, 'Passing and first touch').checked).toBe(true);
    expect(saveButton().disabled).toBe(false);

    fail = false;
    await user.click(saveButton());
    await screen.findByRole('heading', { name: 'Plan updated' });
    expect(patches()).toHaveLength(2);
    expect(patches()[1]!.body).toEqual({ goal: 'passing' });
  });

  test('changing a choice clears the error that was about it', async () => {
    stubNetwork({ patch: () => problem(422, { errors: [{ pointer: '/goal', detail: 'Not possible.' }] }) });
    const { user } = await renderForm();
    await user.click(radio(GOAL, 'Passing and first touch'));
    await user.click(saveButton());
    await within(group(GOAL)).findByText('Not possible.');
    await user.click(radio(GOAL, 'Coordination'));
    expect(screen.queryByText('Not possible.')).toBeNull();
  });

  test('a failure that names no field (500) is a generic localised message with a title, never the server text', async () => {
    stubNetwork({ patch: () => problem(500, { detail: 'SQLITE_BUSY: database is locked' }) });
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not save your plan');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(document.body.textContent).not.toContain('SQLITE_BUSY');
    expect(saveButton().disabled).toBe(false);
  });

  test('a network failure is the localised offline message', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost/');
      if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
      if (url.pathname === '/api/onboarding/football') return json(OPTIONS);
      return json(ME);
    }) as unknown as typeof fetch;
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not save your plan');
    expect(radio(DAYS, '4').checked).toBe(true);
  });
});

// --- redo baseline ---------------------------------------------------------------------------------------

describe('Redo baseline', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Redo baseline' }));
    return screen.findByRole('dialog', { name: 'Redo your baseline?' });
  };

  test('asks for confirmation first: opening the dialog sends nothing', async () => {
    const { user } = await renderForm();
    const dialog = await open(user);
    expect(resets()).toHaveLength(0);
    expect(dialog.textContent).toMatch(/clears your current plan/i);
    expect(dialog.textContent).toMatch(/results and history stay/i);
  });

  test('the safe choice comes first and is the one that has focus', async () => {
    const { user } = await renderForm();
    const dialog = await open(user);
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Keep my plan', 'Yes, redo baseline']);
    await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
  });

  test('the destructive button has a word and an icon, so it is not signalled by colour alone', async () => {
    const { user } = await renderForm();
    const dialog = await open(user);
    const confirm = within(dialog).getByRole('button', { name: 'Yes, redo baseline' });
    expect(confirm.querySelector('svg')).not.toBeNull();
    expect(confirm.getAttribute('data-variant')).toBe('danger');
  });

  test('Keep my plan closes the dialog and nothing is sent; so does Escape', async () => {
    const { user } = await renderForm();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Keep my plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resets()).toHaveLength(0);

    await open(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resets()).toHaveLength(0);
  });

  test('confirming calls POST /api/player/plan/reset once, then goes to the baseline step', async () => {
    const { user, router } = await renderForm();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, redo baseline' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/onboarding'));
    expect(resets()).toHaveLength(1);
    expect(resets()[0]!.method).toBe('POST');
    expect(await screen.findByText('ONBOARDING STAND-IN')).toBeTruthy();
  });

  test("lands on the wizard's baseline step with the kept profile filled in", async () => {
    stubNetwork({ reset: () => json(ResetPlanResponse.parse({ profile: { ...PROFILE, minutesPerSession: 30 }, roadmap: null })) });
    const { user, router } = await renderForm();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, redo baseline' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/onboarding'));
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null')).toEqual({
      v: 1,
      step: 2,
      profile: { age: '9', level: 'basic', goal: 'control' },
      conditions: { equipment: 'ball', space: 'yard', partner: false, daysPerWeek: 3, minutesPerSession: 30 },
      baseline: [],
    });
  });

  test('the request carries the time zone, and the plan, today and journey are invalidated', async () => {
    const { user, queryClient, router } = await renderForm();
    queryClient.setQueryData(['today'], { placeholder: true });
    queryClient.setQueryData(['journey', 'en'], { placeholder: true });
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, redo baseline' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/onboarding'));
    expect(resets()[0]!.headers.get('x-timezone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(queryClient.getQueryState(['today'])!.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['journey', 'en'])!.isInvalidated).toBe(true);
    // ['me'] had an observer (this screen), so invalidating it means it is fetched again (a real server now answers 404)
    await waitFor(() => expect(meGets().length).toBeGreaterThanOrEqual(2));
  });

  test('while the reset is in flight both dialog buttons are disabled, Escape does not close it, and nothing is sent twice', async () => {
    const gate = deferred<Response>();
    stubNetwork({ reset: () => gate.promise });
    const { user, router } = await renderForm();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, redo baseline' }));

    const confirm = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, redo baseline' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm().disabled).toBe(true));
    expect(confirm().getAttribute('aria-busy')).toBe('true');
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep my plan' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirm());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(resets()).toHaveLength(1);

    gate.resolve(json(ResetPlanResponse.parse({ profile: PROFILE, roadmap: null })));
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/onboarding'));
  });

  test('a failed reset keeps the dialog open with a message, does not navigate, and can be tried again', async () => {
    let fail = true;
    stubNetwork({ reset: () => (fail ? problem(500) : json(ResetPlanResponse.parse({ profile: PROFILE, roadmap: null }))) });
    const { user, router, queryClient } = await renderForm();
    queryClient.setQueryData(['today'], { placeholder: true });
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, redo baseline' }));

    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain('We could not reset your plan');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(router.state.location.pathname).toBe('/settings/plan');
    expect(queryClient.getQueryState(['today'])!.isInvalidated).toBe(false);
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, redo baseline' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    fail = false;
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/onboarding'));
    expect(resets()).toHaveLength(2);
  });

  test('the button is disabled while a save is in flight', async () => {
    const gate = deferred<Response>();
    stubNetwork({ patch: () => gate.promise });
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Redo baseline' }) as HTMLButtonElement).disabled).toBe(true));
    gate.resolve(json(saved({ daysPerWeek: 4 })));
    await screen.findByRole('heading', { name: 'Plan updated' });
  });
});

// --- loading, empty, error ---------------------------------------------------------------------------------

describe('loading, empty and error states', () => {
  test('loading: a named busy status stands in for the form until both answers are in', async () => {
    const gate = deferred<Response>();
    stubNetwork({ me: () => gate.promise });
    await renderPlan();
    const status = await screen.findByRole('status', { name: 'Loading your plan settings' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Plan settings' })).toBeTruthy();
    gate.resolve(json(ME));
    await screen.findByRole('button', { name: 'Save changes' });
    expect(screen.queryByRole('status', { name: 'Loading your plan settings' })).toBeNull();
  });

  test('empty: no plan yet (404 from /me) leads to setting one up, and shows no form', async () => {
    stubNetwork({ me: () => problem(404) });
    await renderPlan();
    expect(await screen.findByText('No plan yet')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Set up my plan' });
    expect(link.getAttribute('href')).toBe('/train/onboarding');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo baseline' })).toBeNull();
  });

  test('empty: a 401 mid-visit is the same as no plan yet, not an error (a first visit is gated at routes/settings/route.tsx)', async () => {
    stubNetwork({ me: () => problem(401) });
    await renderPlan();
    expect(await screen.findByText('No plan yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('error: the option lists failing is an alert with a localised message and Try again, which recovers', async () => {
    let fail = true;
    stubNetwork({ options: () => (fail ? problem(500) : json(OPTIONS)) });
    const { user } = await renderPlan();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not load your plan settings');
    expect(alert.textContent).toContain(problemMessages.en.server);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Save changes' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('error: the plan failing (500) is the same alert, and Try again asks for it again', async () => {
    let fail = true;
    stubNetwork({ me: () => (fail ? problem(500) : json(ME)) });
    const { user } = await renderPlan();
    const alert = await screen.findByRole('alert');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Save changes' });
    expect(meGets()).toHaveLength(2);
  });

  test('error: Try again is disabled and busy while its request runs', async () => {
    let fail = true;
    const gate = deferred<Response>();
    stubNetwork({ me: () => (fail ? problem(500) : gate.promise) });
    const { user } = await renderPlan();
    const alert = await screen.findByRole('alert');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true));
    gate.resolve(json(ME));
    await screen.findByRole('button', { name: 'Save changes' });
  });
});

// --- language ----------------------------------------------------------------------------------------------

/** `a.b.c` for every leaf of a message tree. */
function leaves(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leaves(value as Record<string, unknown>, `${prefix}${key}.`),
  );
}

describe('kk, ru and en', () => {
  test('the messages file has the same keys in the three languages, none empty', () => {
    const en = leaves(messages.en).sort();
    expect(en.length).toBeGreaterThan(30);
    expect(leaves(messages.ru).sort()).toEqual(en);
    expect(leaves(messages.kk).sort()).toEqual(en);
    const empty = (tree: Record<string, unknown>): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string' ? (value.trim() === '' ? [key] : []) : empty(value as Record<string, unknown>),
      );
    for (const locale of LOCALES) expect(empty(messages[locale])).toEqual([]);
  });

  test('every option value the API can send has a label in every language', () => {
    for (const locale of LOCALES) {
      const words = messages[locale] as unknown as Record<string, Record<string, unknown>>;
      const label = (section: string, key: string) => ((words[section]?.options ?? words[section]) as Record<string, string>)[key];
      for (const goal of GOALS) expect(label('goals', goal)).toBeTruthy();
      for (const value of EQUIPMENT) expect(label('equipment', value)).toBeTruthy();
      for (const value of SPACES) expect(label('space', value)).toBeTruthy();
    }
  });

  test('Russian: the title, the groups and the actions are Russian', async () => {
    const { user } = await renderForm('ru');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(messages.ru.title);
    expect(screen.getByRole('group', { name: messages.ru.goal.legend })).toBeTruthy();
    await user.click(within(screen.getByRole('group', { name: messages.ru.minutesPerSession.legend })).getAllByRole('radio')[3]!);
    expect((screen.getByRole('button', { name: messages.ru.save.submit }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: messages.ru.reset.open })).toBeTruthy();
    expect(document.documentElement.textContent).not.toContain('Save changes');
  });

  test('Kazakh: the title is Kazakh, and the reset dialog is too', async () => {
    const { user } = await renderForm('kk');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(messages.kk.title);
    await user.click(screen.getByRole('button', { name: messages.kk.reset.open }));
    expect(await screen.findByRole('dialog', { name: messages.kk.reset.dialog.title })).toBeTruthy();
  });

  test('numbers are formatted for the language (Kazakh and Russian days and minutes are digits with their unit)', async () => {
    await renderForm('ru');
    const minutes = within(screen.getByRole('group', { name: messages.ru.minutesPerSession.legend })).getAllByRole('radio');
    expect(minutes.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(
      MINUTES_PER_SESSION.map((value) => messages.ru.minutesPerSession.value.replace('{{value}}', String(value))),
    );
  });
});

// --- the page frame -----------------------------------------------------------------------------------------

describe('the page frame', () => {
  test('a Back link returns to the roadmap, and it is a real link', async () => {
    const { user, router } = await renderForm();
    const back = screen.getByRole('link', { name: 'My roadmap' });
    expect(back.getAttribute('href')).toBe('/train/roadmap');
    await user.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe('/train/roadmap'));
  });

  test('the success block links to today’s training', async () => {
    const { user } = await renderForm();
    await user.click(radio(DAYS, '4'));
    await user.click(saveButton());
    const heading = await screen.findByRole('heading', { name: 'Plan updated' });
    expect(within(heading.closest('section')!).getByRole('link', { name: "Open today's training" }).getAttribute('href')).toBe('/train');
  });
});
