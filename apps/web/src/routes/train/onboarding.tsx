import { PlayerProfile } from '@api-types/domain';
import { ENDPOINTS, OnboardingOptions, type StartRequest, StartResponse } from '@api-types/onboarding';
import { ExperienceLevel, Goal } from '@api-types/primitives';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { BaselineStep, type BaselineDraftResult, type BaselineFinalResult } from '../../features/onboarding/BaselineStep';
import { ConditionsStep, type ConditionsValue } from '../../features/onboarding/ConditionsStep';
import { type ProfileDraft, ProfileStep } from '../../features/onboarding/ProfileStep';
import { type Api, api as appApi } from '../../lib/api';
import { ensurePlayerSession, PlayerSessionError } from '../../lib/auth';
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { ApiProblem, describeProblem, type ProblemView } from '../../lib/problem';

/**
 * /train/onboarding: the wizard shell around ProfileStep, ConditionsStep and BaselineStep (fc-mol-9l4.11).
 *
 * The shell fetches, owns the answers and talks to the API; the three steps stay presentational.
 *
 *  1. GET /api/onboarding/football?locale=<ui locale> ONCE per locale (react-query, never stale, no automatic retry).
 *     Changing the interface language asks again, because the skill-test protocols come back in that language only; the
 *     questions already on screen stay while it loads.
 *  2. The answers (profile / conditions / baseline draft and the current step) live in component state. They are mirrored
 *     into sessionStorage under DRAFT_KEY, parsed with Zod on the way back in, and the stored draft is thrown away when it
 *     does not parse (or storage is unavailable: then the wizard just works without a draft).
 *  3. Steps are picked by index. The LAST step (baseline) submits: ensurePlayerSession(), then POST /api/player/start, then
 *     the draft is cleared and the player goes to /train/roadmap. The start response (`{ profile, roadmap }`, the same shape
 *     GET /api/player/me answers) is written into the ['me'] query cache first, so the roadmap screen shows it without asking
 *     the API again while that entry is fresh (fc-mol-9l4.16: the journey's call budget is sign-in, options, start).
 *  4. A 422/400 whose problem-details pointers name request fields jumps to the EARLIEST step that owns one of them and
 *     lists the rejected answers there (each step keeps its own copy of what is still wrong until that answer changes).
 *     Anything else (network, 5xx, a body that is not a StartResponse, a failed sign-in) stays on the last step as an
 *     ErrorState with Try again.
 *
 * Readings of the criteria where they are open:
 *  - "4-segment progress line / Step n / 4": the fourth segment is the roadmap the player lands on, which is its own route
 *    (/train/roadmap), so the wizard has THREE question steps (1-3 of 4). It fills to "Step 4 / 4" when the plan was made.
 *  - While a request is in flight the step sits inside a disabled <fieldset>, which disables every button and input the
 *    (presentational, unmodifiable) steps render; a ref also refuses a second submit in the same tick.
 *  - "Empty": the options arrived but a list the wizard needs to ask a question is empty (no skill tests is NOT empty: the
 *    baseline step handles that and the contract lets the baseline be empty).
 *  - Each baseline entry gets a clientUuid that is reused when the SAME entry is submitted again (Try again), and replaced
 *    when its value changed, so a retry cannot be mistaken for new results and edited results are never mistaken for old.
 *  - `skipped` is only sent when true (the contract makes it optional); `attempts` is not collected (see BaselineStep).
 *  - Only `Route` and the small WizardDepsContext seam are exported (see there for why the wizard itself is not).
 *  - Navigation is `router.history.push`: the roadmap route does not exist yet, so a typed `navigate({ to })` cannot name it.
 */

const SPORT = 'football';
const DRAFT_KEY = 'fc:onboarding-draft';
const ROADMAP_PATH = '/train/roadmap';
/** The roadmap screen's query key (its GET /api/player/me answer, persisted): the start response is written under it. */
const ME_QUERY_KEY = ['me'] as const;

/** Question steps: profile (0), conditions (1), baseline (2). */
const LAST_STEP = 2;
/** The progress line has one segment more: the roadmap itself, on its own route. */
const TOTAL_SEGMENTS = LAST_STEP + 2;

// --- what owns which field ------------------------------------------------------------------------------------------------

const STEP_OF_FIELD: ReadonlyMap<string, number> = new Map([
  ['age', 0],
  ['level', 0],
  ['goal', 0],
  ['equipment', 1],
  ['space', 1],
  ['partner', 1],
  ['daysPerWeek', 1],
  ['minutesPerSession', 1],
  ['baseline', 2],
]);

/** `profile.age` and `baseline.0.value` -> the field a person recognises (`age`, `baseline`). */
function fieldOf(path: string): string {
  const [head = '', next = ''] = path.split('.');
  return head === 'profile' ? next : head;
}

/** The step that owns a request path, or null when no step does (an unknown or root-level pointer). */
const stepOfPath = (path: string): number | null => STEP_OF_FIELD.get(fieldOf(path)) ?? null;

// --- the draft --------------------------------------------------------------------------------------------------------------

type Draft = {
  step: number;
  profile: ProfileDraft;
  conditions: ConditionsValue;
  baseline: BaselineDraftResult[];
};

const EMPTY_DRAFT: Draft = { step: 0, profile: { age: '', level: null, goal: null }, conditions: {}, baseline: [] };

const StoredDraft = z.object({
  v: z.literal(1),
  step: z.int().min(0).max(LAST_STEP),
  profile: z.object({ age: z.string(), level: ExperienceLevel.nullable(), goal: Goal.nullable() }),
  conditions: PlayerProfile.pick({ equipment: true, space: true, partner: true, daysPerWeek: true, minutesPerSession: true }).partial(),
  baseline: z.array(z.object({ testSlug: z.string(), value: z.number().nullable(), errors: z.number().optional(), skipped: z.boolean() })),
});

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): DraftStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // blocked storage can throw on access
  }
}

/** The stored draft, or null. A draft that does not parse is removed, so it cannot keep failing. */
function readDraft(storage: DraftStorage | null): Draft | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(DRAFT_KEY);
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = StoredDraft.safeParse(json);
    if (parsed.success) {
      const { step, profile, conditions, baseline } = parsed.data;
      return { step, profile, conditions, baseline };
    }
    storage.removeItem(DRAFT_KEY);
  } catch {
    // unavailable storage: no draft
  }
  return null;
}

function writeDraft(storage: DraftStorage | null, draft: Draft): void {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify({ v: 1, ...draft }));
  } catch {
    // unavailable or full storage: the answers still live in component state
  }
}

function clearDraft(storage: DraftStorage | null): void {
  try {
    storage?.removeItem(DRAFT_KEY);
  } catch {
    // nothing to clear
  }
}

/** The profile the answers add up to (whole-number age only), validated by the contract itself. */
function profileOf(draft: Draft, locale: string) {
  const age = draft.profile.age.trim();
  return PlayerProfile.safeParse({
    age: /^\d+$/.test(age) ? Number(age) : undefined,
    level: draft.profile.level ?? undefined,
    goal: draft.profile.goal ?? undefined,
    ...draft.conditions,
    locale,
  });
}

/** The first step whose answers are missing or invalid; the last step when the profile is complete. */
function firstIncompleteStep(draft: Draft, locale: string): number {
  const result = profileOf(draft, locale);
  if (result.success) return LAST_STEP;
  const steps = result.error.issues.flatMap((issue) => {
    const step = STEP_OF_FIELD.get(String(issue.path[0]));
    return step === undefined ? [] : [step];
  });
  return steps.length > 0 ? Math.min(...steps) : 0;
}

// --- dependencies -----------------------------------------------------------------------------------------------------------

export type WizardDeps = {
  api: Pick<Api, 'get' | 'post'>;
  /** Resolves once the player has a (possibly anonymous) session. */
  ensureSession: () => Promise<unknown>;
  /** null: no draft is kept. */
  storage: DraftStorage | null;
  newId: () => string;
};

type OnboardingWizardProps = {
  /** Go to a path (the route wires this to the router). */
  navigate: (to: string) => void;
  /** Read once, when the wizard mounts. Everything defaults to the app's own client, session and sessionStorage. */
  deps?: Partial<WizardDeps>;
};

/**
 * The seam for tests: the page's collaborators (and `navigate`) can be supplied through this context. Nothing in the app
 * provides it, so the defaults apply. It is the ONLY export besides `Route` and it imports nothing: the route splitter
 * leaves every non-Route export in the entry chunk, and exporting the wizard itself would pull zod, the auth client and
 * the API client into the entry bundle (measured: +157 kB) instead of the lazy /train/onboarding chunk.
 */
export const WizardDepsContext = createContext<Partial<WizardDeps> & { navigate?: (to: string) => void }>({});

const resolveDeps = (overrides: Partial<WizardDeps> = {}): WizardDeps => ({
  api: appApi,
  ensureSession: ensurePlayerSession,
  storage: browserStorage(),
  newId: () => crypto.randomUUID(),
  ...overrides,
});

// --- the wizard ---------------------------------------------------------------------------------------------------------------

type Issue = { path: string; detail: string; step: number };
type Status = 'idle' | 'submitting' | 'done';

/** What a failed session or request is, as the client's own error type (so its localised sentence can be chosen). */
function asProblem(error: unknown): unknown {
  if (error instanceof PlayerSessionError) return new ApiProblem({ kind: error.kind === 'offline' ? 'offline' : 'unknown', cause: error });
  return error;
}

const isEmpty = (options: OnboardingOptions): boolean =>
  [options.levels, options.goals, options.equipment, options.spaces, options.partner, options.daysPerWeek, options.minutesPerSession].some(
    (list) => list.length === 0,
  );

function OnboardingWizard({ navigate, deps: overrides }: OnboardingWizardProps) {
  const { t, i18n } = useTranslation('wizard');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const [deps] = useState(() => resolveDeps(overrides));
  const queryClient = useQueryClient();
  const noteId = useId();

  const options = useQuery({
    queryKey: ['onboarding-options', SPORT, locale],
    queryFn: ({ signal }) =>
      deps.api.get(`${ENDPOINTS.getOptions.path.replace(':sport', encodeURIComponent(SPORT))}?${new URLSearchParams({ locale })}`, {
        schema: OnboardingOptions,
        signal,
      }),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  const [draft, setDraft] = useState<Draft>(() => readDraft(deps.storage) ?? EMPTY_DRAFT);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [failure, setFailure] = useState<ProblemView | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const inFlight = useRef(false);
  const lastResults = useRef<BaselineFinalResult[]>([]);
  const clientIds = useRef(new Map<string, string>());

  useEffect(() => writeDraft(deps.storage, draft), [deps.storage, draft]);

  // A draft can claim a step its answers do not reach: show the first step that still needs answers.
  const step = Math.min(draft.step, firstIncompleteStep(draft, locale));
  const busy = status !== 'idle';
  const shown = status === 'done' ? TOTAL_SEGMENTS : step + 1;

  // Move focus to the new step's heading (announces it, and lands a keyboard user at the top), but not on first paint.
  const stepBox = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepBox.current?.querySelector('h2');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [step]);

  const failureBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure !== null) failureBox.current?.focus();
  }, [failure]);

  /** Change the answers on `onStep`: whatever the server said about that step's answers no longer applies. */
  function change(patch: Partial<Omit<Draft, 'step'>>, onStep: number) {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues((current) => current.filter((issue) => issue.step !== onStep));
    setFailure(null);
  }

  function go(next: number) {
    setDraft((current) => ({ ...current, step: next }));
    setFailure(null);
  }

  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));

  function reject(error: unknown) {
    const view = describeProblem(asProblem(error), translate);
    const owned = Object.entries(view.fieldErrors).flatMap(([path, details]) => {
      const owner = stepOfPath(path);
      return owner === null ? [] : details.map((detail): Issue => ({ path, detail, step: owner }));
    });
    if (owned.length === 0) {
      setFailure(view);
      return;
    }
    setFailure(null);
    setIssues(owned);
    go(Math.min(...owned.map((issue) => issue.step)));
  }

  function idFor(result: BaselineFinalResult): string {
    const key = JSON.stringify([result.testSlug, result.value, result.errors ?? null, result.skipped]);
    const known = clientIds.current.get(key);
    if (known !== undefined) return known;
    const created = deps.newId();
    clientIds.current.set(key, created);
    return created;
  }

  async function submit(results: BaselineFinalResult[]) {
    if (inFlight.current) return;
    const profile = profileOf(draft, locale);
    if (!profile.success) {
      go(firstIncompleteStep(draft, locale));
      return;
    }
    inFlight.current = true;
    lastResults.current = results;
    setStatus('submitting');
    const request: StartRequest = {
      profile: profile.data,
      baseline: results.map((result) => ({
        testSlug: result.testSlug,
        value: result.value,
        ...(result.errors === undefined ? {} : { errors: result.errors }),
        ...(result.skipped ? { skipped: true } : {}),
        clientUuid: idFor(result),
      })),
    };
    try {
      await deps.ensureSession();
      const started = await deps.api.post(ENDPOINTS.start.path, { body: request, schema: StartResponse });
      queryClient.setQueryData(ME_QUERY_KEY, started);
      clearDraft(deps.storage);
      setFailure(null);
      setStatus('done');
      navigate(ROADMAP_PATH);
    } catch (error) {
      setStatus('idle');
      reject(error);
    } finally {
      inFlight.current = false;
    }
  }

  // --- render ----------------------------------------------------------------------------------------------------------

  const data = options.data;
  let body: ReactNode;
  if (data === undefined) {
    body = options.isError ? (
      <ErrorState
        title={t('loadError.title')}
        message={describeProblem(options.error, translate).formMessage}
        retryLabel={t('retry')}
        onRetry={() => void options.refetch()}
        retrying={options.isFetching}
      />
    ) : (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <p className="text-base text-muted">{t('loading')}</p>
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </div>
    );
  } else if (isEmpty(data)) {
    body = (
      <EmptyState
        title={t('empty.title')}
        hint={t('empty.hint')}
        action={
          <Button variant="secondary" loading={options.isFetching} onClick={() => void options.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else {
    const equipment = draft.conditions.equipment;
    const here = issues.filter((issue) => issue.step === step);
    const label = t('step', { n: formatNumber(shown, locale), total: formatNumber(TOTAL_SEGMENTS, locale) });
    body = (
      <div className="flex flex-col gap-6" aria-busy={busy}>
        <div className="flex flex-col gap-3">
          <div
            role="progressbar"
            aria-label={t('progressLabel')}
            aria-valuemin={1}
            aria-valuemax={TOTAL_SEGMENTS}
            aria-valuenow={shown}
            aria-valuetext={label}
            className="flex gap-1.5"
          >
            {Array.from({ length: TOTAL_SEGMENTS }, (_, index) => (
              <span
                key={index}
                data-segment=""
                data-filled={index < shown}
                className={clsx('h-2.5 flex-1 rounded-pill', index < shown ? 'bg-accent' : 'bg-line')}
              />
            ))}
          </div>
          <p aria-live="polite" className="text-[13px] font-bold text-ink">
            {label}
          </p>
        </div>

        {here.length > 0 ? (
          <Notice tone="warn" aria-labelledby={noteId}>
            <p id={noteId} className="font-bold">
              {t('issues.title')}
            </p>
            <p>{t('issues.lead')}</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {here.map((issue, index) => (
                <li key={index}>{`${t(`fields.${fieldOf(issue.path)}`) || issue.path}: ${issue.detail}`}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <div ref={stepBox}>
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            {step === 0 ? (
              <ProfileStep
                options={data}
                value={draft.profile}
                onChange={(profile) => change({ profile }, 0)}
                onContinue={() => go(1)}
              />
            ) : step === 1 ? (
              <ConditionsStep
                options={data}
                value={draft.conditions}
                onChange={(conditions) => change({ conditions }, 1)}
                onContinue={() => go(2)}
                onBack={() => go(0)}
              />
            ) : equipment === undefined ? null : (
              <BaselineStep
                tests={data.tests}
                equipment={equipment}
                results={draft.baseline}
                onChange={(baseline) => change({ baseline }, 2)}
                onContinue={(results) => void submit(results)}
                onBack={() => go(1)}
              />
            )}
          </fieldset>
        </div>

        {failure !== null ? (
          <ErrorState
            ref={failureBox}
            tabIndex={-1}
            title={t('submitError.title')}
            message={failure.formMessage}
            retryLabel={t('retry')}
            retrying={status === 'submitting'}
            onRetry={() => void submit(lastResults.current)}
          />
        ) : status === 'submitting' ? (
          <p role="status" className="text-base font-bold text-ink">
            {t('submitting')}
          </p>
        ) : null}
        {status === 'done' ? (
          <p role="status" className="text-base font-bold text-ink">
            {t('success')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-[min(840px,100%-24px)] flex-col gap-6 py-8 sm:w-[min(840px,100%-40px)] sm:py-12">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-bold tracking-[0.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1 className="text-[length:clamp(32px,5vw,60px)] leading-none font-bold tracking-[-0.05em] wrap-break-word text-ink">{t('title')}</h1>
      </header>
      <div className="rounded-card border border-line bg-paper p-5 shadow-soft sm:p-7">{body}</div>
    </main>
  );
}

function OnboardingRoute() {
  const router = useRouter({ warn: false });
  const { navigate, ...injected } = useContext(WizardDepsContext);
  return <OnboardingWizard navigate={navigate ?? ((to) => router?.history.push(to))} deps={injected} />;
}

export const Route = createFileRoute('/train/onboarding')({ component: OnboardingRoute });
