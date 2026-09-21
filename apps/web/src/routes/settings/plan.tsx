import type { PlayerProfile } from '@api-types/domain';
import { ENDPOINTS, type PatchProfileRequest, PatchProfileResponse, ResetPlanResponse } from '@api-types/journey';
import { ENDPOINTS as ONBOARDING, OnboardingOptions, StartResponse } from '@api-types/onboarding';
import type { Locale } from '@api-types/primitives';
import * as Dialog from '@radix-ui/react-dialog';
import { keepPreviousData, type QueryClient, type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ArrowLeft, Check, CircleAlert, RotateCcw } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /settings/plan: PLAN SETTINGS. An Operate-mode screen, one calm column at 360px. The player changes goal, equipment, space,
 * partner, days per week and minutes per session, saves with PATCH /api/player/profile and sees the rebuilt roadmap focus,
 * or redoes the baseline (after an explicit confirmation) with POST /api/player/plan/reset. Every string lives in
 * features/settings/plan.messages.ts (namespace `plan`).
 *
 * Only `Route` is exported: the route splitter leaves every other export in the entry chunk (see routes/train/onboarding.tsx).
 *
 * Readings of the criteria where they are open:
 * - Data. Two reads: the current profile from GET /api/player/me (key ['me'], the roadmap screen's own query, parsed with the
 *   same StartResponse) and the option lists from GET /api/onboarding/football (the wizard's and the retest screen's key
 *   ['onboarding-options', sport, locale]). Nothing is hard-coded: a list the API narrows is narrowed on screen.
 * - Save sends ONLY the changed fields. The screen keeps just the edits, as a map field -> new value; choosing the value the
 *   profile already has removes that edit, so "changed and changed back" sends nothing. Save is disabled without edits (and
 *   says why). After a save the profile in the ['me'] cache is replaced by the response's, which makes the edits a no-op.
 *   `locale`, `age` and `level` are not editable here (the criteria list six fields; age and level belong to the baseline).
 * - "Shows the rebuilt roadmap focus": the focus of the PATCH RESPONSE's roadmap (skill, level step, reason), never the
 *   pre-edit plan. A null roadmap (the API's answer when no roadmap exists) is confirmed with "your choices are saved".
 *   Editing again hides the block, so it never describes an unsaved choice.
 * - After a success ['me'], ['today'] and ['journey'] are invalidated: the new plan and the day's session changed on the server.
 * - Redo baseline. The button only opens a modal dialog (Radix Dialog, role="dialog"); the reset is sent by "Yes, redo
 *   baseline". The safe button ("Keep my plan") comes first, so it has the initial focus; the destructive button has a word
 *   and an icon and is never colour alone. While the request runs both buttons are disabled and Escape / an outside click do
 *   not close the dialog. A failure stays in the dialog with a message and the same button to try again.
 * - "Navigates to the baseline step": the wizard (/train/onboarding, another bead) has no step in its URL. It restores its
 *   answers from sessionStorage (`fc:onboarding-draft`, format v1: profile, conditions, baseline, step 0..2), so before
 *   navigating this screen writes that draft with the KEPT profile (the reset response's) at step 2, the baseline. A wizard
 *   that does not accept the draft starts at its first step, which is still the setup: nothing breaks.
 *   CONTRACT GAP: that draft format is owned by routes/train/onboarding.tsx and only mirrored here.
 * - Both mutations send X-Timezone (the API decides "today's unfinished session" by the player's local date, as for
 *   GET /api/player/today).
 * - States. loading = a named busy status; empty = the API's 404/401 for the plan (no plan yet, e.g. after a reset: leads to
 *   the setup); error = ErrorState (generic localised words, never the server's text) whose Try again is natively disabled and
 *   busy while its refetch runs; disabled = every choice and both mutation buttons while a request is in flight (a ref also
 *   refuses a second submit in the same tick); success = the rebuilt focus.
 * - Server errors. A 422 whose pointers name one of the six fields shows that text (the server's own words) on the field, in
 *   words with an icon; anything else is a generic localised message above Save. Editing clears the error.
 * - Sport. `football`, as the wizard (the profile has no sport).
 * - Nothing here compares the player with anyone and nothing promises a professional career (PRODUCT.md).
 */

const SPORT = 'football';
const ME_KEY = ['me'] as const;
const TODAY_KEY = ['today'] as const;
const JOURNEY_KEY = ['journey'] as const;
const ME_PATH = '/api/player/me';

const ONBOARDING_PATH = '/train/onboarding';
/** The wizard's own sessionStorage draft (routes/train/onboarding.tsx): mirrored, see the note above. */
const ONBOARDING_DRAFT_KEY = 'fc:onboarding-draft';
/** The wizard's last question step: the baseline. */
const BASELINE_STEP = 2;

const KNOWN_TRACKS: readonly string[] = ['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination'];
const KNOWN_REASONS: readonly string[] = ['goal', 'weakest'];

type Editable = Pick<PlayerProfile, 'goal' | 'equipment' | 'space' | 'partner' | 'daysPerWeek' | 'minutesPerSession'>;
type EditableKey = keyof Editable;
type Edits = Partial<Editable>;

/** The field names as they appear in a problem-details pointer (`/goal` -> `goal`). */
const FIELD_KEYS: readonly EditableKey[] = ['goal', 'equipment', 'space', 'partner', 'daysPerWeek', 'minutesPerSession'];

// --- data ---------------------------------------------------------------------------------------

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The player's zone, so the API drops the right day's unfinished session. */
function zoneHeaders(): HeadersInit | undefined {
  const zone = browserTimeZone();
  return zone === undefined ? undefined : { 'X-Timezone': zone };
}

// The same request and cache key as the onboarding wizard and the retest screen.
const fetchOptions = (locale: Locale, signal: AbortSignal): Promise<OnboardingOptions> =>
  api.get(`${ONBOARDING.getOptions.path.replace(':sport', encodeURIComponent(SPORT))}?${new URLSearchParams({ locale })}`, {
    schema: OnboardingOptions,
    signal,
  });

/** 404 (no plan: never onboarded, or reset) and 401 (no session yet): either way there is no plan to edit, which is not a failure. */
const hasNoPlan = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'unauthorized');

/**
 * The failure to show. React Query clears `error` the moment a retry starts when there is no data yet; keep the last failure on
 * screen meanwhile so Try again stays put, disabled and busy, instead of flashing to skeletons.
 */
function useFailure(query: UseQueryResult<unknown>): unknown {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  if (query.data !== undefined) return null;
  return query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? last.current : null);
}

/** The plan, the player's today and the journey all moved on the server. */
function invalidatePlanQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ME_KEY });
  void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
  void queryClient.invalidateQueries({ queryKey: JOURNEY_KEY });
}

/** Leaves the wizard's draft on its baseline step, filled with the kept profile. Unavailable storage: the wizard just starts over. */
function seedBaselineDraft(profile: PlayerProfile): void {
  try {
    sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        v: 1,
        step: BASELINE_STEP,
        profile: { age: String(profile.age), level: profile.level, goal: profile.goal },
        conditions: {
          equipment: profile.equipment,
          space: profile.space,
          partner: profile.partner,
          daysPerWeek: profile.daysPerWeek,
          minutesPerSession: profile.minutesPerSession,
        },
        baseline: [],
      }),
    );
  } catch {
    // no storage: nothing to seed
  }
}

/** `sprint-speed` -> `Sprint speed`. */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

// --- shared styling -----------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';

/*
 * DESIGN.md "Options and Selection": paper card, 12px radius; selected = Field Green border + Morning Mint fill + a check icon
 * (the second signal) + the native checked state. Each card is a real radio inside its label: one Tab stop per question,
 * arrow keys move, Space picks. The input is visually hidden; the focus ring is drawn on the card (Visible Focus Rule).
 * min-h-14 keeps every card above the 44px floor. A disabled card is dimmed with a not-allowed cursor.
 */
const CARD =
  'flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-control border p-4 text-base text-ink ' +
  'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ' +
  'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60';

// --- pieces -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('plan');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
    </div>
  );
}

type Choice = string | number | boolean;

type OptionGroupProps<T extends Choice> = {
  legend: string;
  name: string;
  options: readonly T[];
  selected: T;
  labelOf: (option: T) => string;
  onSelect: (option: T) => void;
  disabled: boolean;
  /** The server's words about this field, if it refused it. */
  error?: string;
  /** `wide`: one column on a phone, two from 600px (long labels). `compact`: short labels in a wrapping row. */
  layout: 'wide' | 'compact';
};

function OptionGroup<T extends Choice>({ legend, name, options, selected, labelOf, onSelect, disabled, error, layout }: OptionGroupProps<T>) {
  const errorId = `${name}-error`;
  return (
    <fieldset disabled={disabled} aria-describedby={error === undefined ? undefined : errorId} className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-3 p-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">{legend}</legend>
      <div className={layout === 'wide' ? 'grid grid-cols-1 gap-2 min-[600px]:grid-cols-2' : 'flex flex-wrap gap-2'}>
        {options.map((option) => {
          const isSelected = selected === option;
          return (
            <label
              key={String(option)}
              className={clsx(
                CARD,
                layout === 'compact' && 'min-w-14 flex-1 justify-center',
                isSelected ? 'border-accent bg-accent-2 font-bold' : 'border-line bg-paper',
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(option)}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onSelect(option)}
                className="sr-only"
              />
              <span className="min-w-0 wrap-anywhere">{labelOf(option)}</span>
              {isSelected ? <Check aria-hidden="true" data-slot="selected-mark" className="size-5 shrink-0" /> : null}
            </label>
          );
        })}
      </div>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="mt-3 flex items-start gap-2 font-bold text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{error}</span>
        </p>
      )}
    </fieldset>
  );
}

function Success({ response, locale }: { response: PatchProfileResponse; locale: Locale }) {
  const { t } = useTranslation('plan');
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The button that had the focus is disabled again (nothing left to save): move it to what is new.
  useEffect(() => headingRef.current?.focus(), []);
  const focus = response.roadmap?.focus ?? [];

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <Card elevated className="grid gap-4">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={H2}>
          {t('success.title')}
        </h2>
        {response.roadmap === null ? (
          <p className="m-0 text-base text-ink">{t('success.saved')}</p>
        ) : (
          <>
            <p className="m-0 text-base text-muted">{t('success.lead')}</p>
            <ul aria-label={t('success.listLabel')} className="m-0 grid list-none gap-3 p-0">
              {focus.map((item) => (
                <li key={item.skill} className="grid gap-1 rounded-control border border-line bg-paper p-4 wrap-anywhere">
                  <span className="text-xl leading-tight font-bold tracking-tight text-ink">
                    {KNOWN_TRACKS.includes(item.skill) ? t(`success.tracks.${item.skill}`) : humanise(item.skill)}
                  </span>
                  <span className="text-base font-bold text-ink">
                    {item.level === item.targetLevel
                      ? t('success.hold', { level: formatNumber(item.level, locale) })
                      : t('success.change', { from: formatNumber(item.level, locale), to: formatNumber(item.targetLevel, locale) })}
                  </span>
                  <span className="text-base text-muted">{KNOWN_REASONS.includes(item.reason) ? t(`success.reason.${item.reason}`) : item.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link to="/train" className={LINK_PRIMARY}>
            {t('success.start')}
          </Link>
        </div>
      </Card>
    </section>
  );
}

type PlanFormProps = { profile: PlayerProfile; options: OnboardingOptions; locale: Locale };

function PlanForm({ profile, options, locale }: PlanFormProps) {
  const { t } = useTranslation('plan');
  const queryClient = useQueryClient();
  const id = useId();
  const [edits, setEdits] = useState<Edits>({});
  const [saved, setSaved] = useState<PatchProfileResponse | null>(null);
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const save = useMutation({
    mutationFn: (patch: PatchProfileRequest): Promise<PatchProfileResponse> =>
      api.patch(ENDPOINTS.patchProfile.path, { body: patch, schema: PatchProfileResponse, headers: zoneHeaders() }),
    onSuccess: (response) => {
      // The profile on screen is now the saved one, so the edits are no longer a difference.
      if (response.roadmap !== null) {
        queryClient.setQueryData(ME_KEY, { profile: response.profile, roadmap: response.roadmap } satisfies StartResponse);
      }
      invalidatePlanQueries(queryClient);
      setEdits({});
      setSaved(response);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const pending = save.isPending;
  const patch: Edits = edits;
  const changed = Object.keys(patch).length > 0;
  const failure = save.isError ? describeProblem(save.error, (key) => t(key)) : null;

  // A natively disabled control drops keyboard focus: after a failed save, put it on the message.
  useEffect(() => {
    if (save.isError) alertRef.current?.focus();
  }, [save.isError]);

  /** Choosing what the profile already has removes the edit; anything else records it. Any edit clears the last result. */
  function choose<K extends EditableKey>(key: K, value: Editable[K]): void {
    setEdits((current) => {
      const next: Edits = { ...current };
      if (value === profile[key]) delete next[key];
      else (next as Record<EditableKey, Choice>)[key] = value;
      return next;
    });
    save.reset();
    setSaved(null);
  }

  const value = <K extends EditableKey>(key: K): Editable[K] => (edits[key] ?? profile[key]) as Editable[K];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlight.current || !changed) return;
    inFlight.current = true;
    save.mutate(patch);
  }

  // A missing message renders '' (lib/i18n.ts); a payload value the messages do not know yet then shows as itself.
  const labelled = (key: string, option: Choice): string => t(key) || String(option);
  const fieldError = (key: EditableKey): string | undefined => failure?.fieldErrors[key]?.join(' ');
  const hintId = `${id}-unchanged`;

  return (
    <>
      <form noValidate onSubmit={submit} className="mt-8 flex min-w-0 flex-col gap-8">
        <OptionGroup
          legend={t('goal.legend')}
          name={`${id}-goal`}
          options={options.goals}
          selected={value('goal')}
          labelOf={(option) => labelled(`goals.${option}`, option)}
          onSelect={(goal) => choose('goal', goal)}
          disabled={pending}
          error={fieldError('goal')}
          layout="wide"
        />
        <OptionGroup
          legend={t('equipment.legend')}
          name={`${id}-equipment`}
          options={options.equipment}
          selected={value('equipment')}
          labelOf={(option) => labelled(`equipment.options.${option}`, option)}
          onSelect={(equipment) => choose('equipment', equipment)}
          disabled={pending}
          error={fieldError('equipment')}
          layout="wide"
        />
        <OptionGroup
          legend={t('space.legend')}
          name={`${id}-space`}
          options={options.spaces}
          selected={value('space')}
          labelOf={(option) => labelled(`space.options.${option}`, option)}
          onSelect={(space) => choose('space', space)}
          disabled={pending}
          error={fieldError('space')}
          layout="wide"
        />
        <OptionGroup
          legend={t('partner.legend')}
          name={`${id}-partner`}
          options={options.partner}
          selected={value('partner')}
          labelOf={(option) => labelled(`partner.options.${option}`, option)}
          onSelect={(partner) => choose('partner', partner)}
          disabled={pending}
          error={fieldError('partner')}
          layout="compact"
        />
        <OptionGroup
          legend={t('daysPerWeek.legend')}
          name={`${id}-days`}
          options={options.daysPerWeek}
          selected={value('daysPerWeek')}
          labelOf={(option) => formatNumber(option, locale)}
          onSelect={(daysPerWeek) => choose('daysPerWeek', daysPerWeek)}
          disabled={pending}
          error={fieldError('daysPerWeek')}
          layout="compact"
        />
        <OptionGroup
          legend={t('minutesPerSession.legend')}
          name={`${id}-minutes`}
          options={options.minutesPerSession}
          selected={value('minutesPerSession')}
          labelOf={(option) => t('minutesPerSession.value', { value: formatNumber(option, locale) })}
          onSelect={(minutesPerSession) => choose('minutesPerSession', minutesPerSession)}
          disabled={pending}
          error={fieldError('minutesPerSession')}
          layout="compact"
        />

        <div className="flex flex-col gap-3">
          {failure === null ? null : (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
              <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                <p className="m-0 font-bold">{t('saveError.title')}</p>
                <p className="m-0 text-muted">{failure.formMessage}</p>
                <p className="m-0">{t('saveError.hint')}</p>
              </div>
            </div>
          )}
          {changed || pending ? null : (
            <p id={hintId} className="m-0 text-base text-muted">
              {t('save.unchanged')}
            </p>
          )}
          <Button
            type="submit"
            loading={pending}
            disabled={!changed}
            aria-describedby={changed || pending ? undefined : hintId}
            className="w-full sm:w-auto sm:self-start"
          >
            {t('save.submit')}
          </Button>
        </div>
      </form>

      {saved === null ? null : <Success response={saved} locale={locale} />}

      <RedoBaseline profileBusy={pending} />
    </>
  );
}

function RedoBaseline({ profileBusy }: { profileBusy: boolean }) {
  const { t } = useTranslation('plan');
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const reset = useMutation({
    mutationFn: (): Promise<ResetPlanResponse> => api.post(ENDPOINTS.resetPlan.path, { schema: ResetPlanResponse, headers: zoneHeaders() }),
    onSuccess: (response) => {
      invalidatePlanQueries(queryClient);
      seedBaselineDraft(response.profile);
      setOpen(false);
      void router.navigate({ to: ONBOARDING_PATH });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const pending = reset.isPending;
  const failure = reset.isError ? describeProblem(reset.error, (key) => t(key)) : null;

  // The confirm button was disabled while the request ran, which drops its focus: after a failure put it back.
  useEffect(() => {
    if (reset.isError) confirmRef.current?.focus();
  }, [reset.isError]);

  function confirm(): void {
    if (inFlight.current) return;
    inFlight.current = true;
    reset.mutate();
  }

  return (
    <section aria-labelledby="plan-redo" className="mt-12">
      <Card className="grid gap-4">
        <h2 id="plan-redo" className={H2}>
          {t('reset.title')}
        </h2>
        <p className="m-0 text-base text-muted">{t('reset.hint')}</p>
        <Button
          variant="secondary"
          disabled={profileBusy}
          className="w-full sm:w-auto sm:self-start"
          onClick={() => {
            reset.reset();
            setOpen(true);
          }}
        >
          <RotateCcw aria-hidden="true" className="size-5 shrink-0" />
          {t('reset.open')}
        </Button>
      </Card>

      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          // The request cannot be taken back: the dialog stays until it has answered.
          if (!next && pending) return;
          setOpen(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            className={clsx(
              'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-md -translate-x-1/2 -translate-y-1/2',
              'gap-4 overflow-y-auto rounded-card border border-line bg-paper p-5.5 text-ink shadow-soft',
            )}
          >
            <Dialog.Title className="m-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">
              {t('reset.dialog.title')}
            </Dialog.Title>
            <Dialog.Description className="m-0 text-base wrap-break-word text-ink">{t('reset.dialog.body')}</Dialog.Description>
            {failure === null ? null : (
              <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                  <p className="m-0 font-bold">{t('reset.error.title')}</p>
                  <p className="m-0 text-muted">{failure.formMessage}</p>
                  <p className="m-0">{t('reset.error.hint')}</p>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
                {t('reset.dialog.cancel')}
              </Button>
              <Button ref={confirmRef} variant="danger" loading={pending} onClick={confirm}>
                {pending ? null : <RotateCcw aria-hidden="true" className="size-5 shrink-0" />}
                {t('reset.dialog.confirm')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

// --- the page -----------------------------------------------------------------------------------

function PlanPage() {
  const { t, i18n } = useTranslation('plan');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => api.get(ME_PATH, { schema: StartResponse, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  // Switching language refetches (the lists come back per language); keep the old screen up meanwhile so an unsaved choice is
  // not lost to a skeleton flash.
  const options = useQuery({
    queryKey: ['onboarding-options', SPORT, locale],
    queryFn: ({ signal }) => fetchOptions(locale, signal),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const meFailure = useFailure(me);
  const optionsFailure = useFailure(options);
  const noPlan = hasNoPlan(meFailure);
  const failure = optionsFailure ?? (noPlan ? null : meFailure);

  let body: ReactNode;
  if (noPlan) {
    body = (
      <EmptyState
        className="mt-8"
        title={t('empty.title')}
        hint={t('empty.hint')}
        action={
          <Link to="/train/onboarding" className={LINK_PRIMARY}>
            {t('empty.action')}
          </Link>
        }
      />
    );
  } else if (failure !== null) {
    body = (
      <ErrorState
        className="mt-8"
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={me.isFetching || options.isFetching}
        onRetry={() => {
          if (optionsFailure !== null) void options.refetch();
          if (meFailure !== null) void me.refetch();
        }}
      />
    );
  } else if (me.data === undefined || options.data === undefined) {
    body = <Loading />;
  } else {
    body = <PlanForm profile={me.data.profile} options={options.data} locale={locale} />;
  }

  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <div className="max-w-160">
        <Link to="/train/roadmap" className="-ml-2 inline-flex min-h-tap min-w-tap items-center gap-2 rounded-control px-2 font-bold text-ink">
          <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
          {t('back')}
        </Link>
        <p className="m-0 mt-4 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
        <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
        {body}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/settings/plan')({ component: PlanPage });
