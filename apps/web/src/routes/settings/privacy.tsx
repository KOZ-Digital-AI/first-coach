import { StartResponse } from '@api-types/onboarding';
import { type Consents, ENDPOINTS, type UpdateConsentsRequest } from '@api-types/privacy';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ArrowLeft, Check, CircleAlert, X } from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { describeProblem, isApiProblem } from '../../lib/problem';
import { type PrivacyPanelSlotProps, useSlot } from '../../lib/slots';
// Registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../lib/i18n';

/**
 * /settings/privacy: PRIVACY SETTINGS. An Operate-mode screen, one calm column at 360px, in plain words a child can follow.
 * Every string lives in features/privacy/privacy-settings.messages.ts (namespace `privacy-settings`; `privacy` belongs to the
 * privacy-policy page in features/legal).
 *
 * Only `Route` and the small PrivacyDepsContext seam are exported (the route splitter leaves other exports in the entry chunk;
 * see routes/train/index.tsx for the same seam).
 *
 * THE PRIVACY-PANEL SLOT. Below the consents the screen renders every default-exported component of
 * features/privacy/panels/*.panel.tsx (lib/slots.ts, slot `privacy-panel`, no props). It is where the data panel (export, delete;
 * bead fc-mol-bjm.8) mounts WITHOUT editing this file. Panels come from `useSlot('privacy-panel')` and, in tests, from
 * `PrivacyDepsContext`. They need nothing from the consents, so they are shown in every state (loading included: they are the
 * player's own controls and must not wait for a request they do not use).
 *
 * Readings of the criteria where they are open:
 * - Data. Two reads: the consents from GET /api/player/consents (key ['consents']) and the player's age from GET /api/player/me
 *   (key ['me'], the plan screen's own query, parsed with the same StartResponse). The age is needed for the under-13 rule: a
 *   screen that could not tell the age must not offer video analysis, so an age that failed to load is an error, not a guess.
 * - "What is stored (no name, no email, age in years, training results)": read as "we keep: age in years, training results" and
 *   "we do not keep: name, email". "What is never done": four items, each starting with its own words ("No ads.") so the
 *   meaning is in the text and never in an icon or a colour.
 * - Toggles. Native checkboxes with role="switch" inside a label (a 44px row): the label names the switch, the hint (which for
 *   video analysis discloses that a few still frames go to an AI provider) is its aria-describedby, and the words On / Off sit
 *   beside it, so the state is never colour or position alone. Both are off until the server says otherwise.
 * - Save = PUT /api/player/consents with ONLY the key that changed ({ modelImprovement: true }). OPTIMISTIC: the ['consents']
 *   cache is patched at once, and rolled back to the snapshot when the request fails (with the words "was not saved"). The
 *   response of the server (the updated Consents) then REPLACES the cache, so the screen shows what the server holds, not our guess.
 *   The success line ("Saved. ... is on.") reads the response. Consents are an append-only history on the server: turning a
 *   consent off is a new row, so the screen never "deletes" anything.
 * - Under 13. For age < 13 a guardian checkbox is shown while video analysis is off. Turning video analysis ON without the tick
 *   sends nothing and asks for the tick (an alert, aria-invalid on the checkbox); with it the ONE request carries
 *   `guardianConfirmed: true`. Ticking alone sends nothing. Turning it OFF and the model-improvement switch never need a guardian.
 *   From 13 no guardian key is ever sent. If the server refuses with a 422 pointing at /guardianConfirmed (the age in our cache was
 *   stale) the switch is rolled back and the checkbox is shown whatever the age said.
 * - States. loading = a named busy status; empty = the plan does not exist yet (the age is unknown: 404/401 of GET /api/player/me),
 *   which leads to the setup; error = ErrorState (generic localised words) whose Try again is natively disabled and busy while
 *   its refetch runs; disabled = every switch and the guardian checkbox while a save is in flight (a ref also refuses a second
 *   change in the same tick); success = the saved line (a status, with a check icon).
 * - Focus. A natively disabled control drops keyboard focus, so when a save settles the focus goes to the failure alert (failure)
 *   or back to the switch that was used (success); a guardian request moves it to the guardian checkbox.
 * - The explanation and the slot need no request, so they are on screen while the consents load or fail.
 */

const ME_KEY = ['me'] as const;
const CONSENTS_KEY = ['consents'] as const;
const ME_PATH = '/api/player/me';
/** Below this age the guardian rule applies (the contract's isConsentUpdateAllowed pins the same number on the server). */
const GUARDIAN_BELOW_AGE = 13;

type ConsentKind = keyof Consents;

/**
 * Test seam and default: panels injected by a test replace the glob-collected ones. Nothing in the app provides it, so the
 * defaults apply. It is the ONLY export besides `Route`, and it imports nothing at runtime.
 */
export const PrivacyDepsContext = createContext<{ slots?: readonly ComponentType<PrivacyPanelSlotProps>[] }>({});

// --- data ---------------------------------------------------------------------------------------

/** 404 (no plan yet) and 401 (no session yet): either way there is no age to apply the rules to, which is not a failure. */
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

/** What the screen shows at once while the request is out: the change applied to the snapshot. */
function applyOptimistic(current: Consents, kind: ConsentKind, granted: boolean, guardianConfirmed: boolean): Consents {
  if (kind === 'videoAnalysis') return { ...current, videoAnalysis: { granted, ...(granted && guardianConfirmed ? { guardianConfirmed: true } : {}) } };
  return { ...current, modelImprovement: { granted } };
}

// --- shared styling -----------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_PRIMARY =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border border-ink bg-ink px-4.5 py-2.5 text-center font-bold wrap-anywhere text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px';

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const H3 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';

// --- pieces -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('privacy-settings');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="grid gap-4">
      <Skeleton className="h-36 rounded-card" />
      <Skeleton className="h-36 rounded-card" />
    </div>
  );
}

type PointListProps = { items: readonly string[]; icon: 'check' | 'x' };

/** A list of short statements. The words carry the meaning ("No ads."); the icon is only a second signal. */
function PointList({ items, icon }: PointListProps) {
  const Icon = icon === 'check' ? Check : X;
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {items.map((text) => (
        <li key={text} className="flex items-start gap-3 text-base leading-[1.45] text-ink">
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{text}</span>
        </li>
      ))}
    </ul>
  );
}

function Explanation() {
  const { t } = useTranslation('privacy-settings');
  const storedId = useId();
  const neverId = useId();
  return (
    <>
      <section aria-labelledby={storedId} className="mt-8">
        <Card className="grid gap-4">
          <h2 id={storedId} className={H2}>
            {t('stored.title')}
          </h2>
          <h3 className={H3}>{t('stored.keepTitle')}</h3>
          <PointList icon="check" items={[t('stored.keep.age'), t('stored.keep.results')]} />
          <h3 className={H3}>{t('stored.notKeepTitle')}</h3>
          <PointList icon="x" items={[t('stored.notKeep.name'), t('stored.notKeep.email')]} />
        </Card>
      </section>
      <section aria-labelledby={neverId} className="mt-4">
        <Card className="grid gap-4">
          <h2 id={neverId} className={H2}>
            {t('never.title')}
          </h2>
          <PointList
            icon="x"
            items={[t('never.items.profiles'), t('never.items.messaging'), t('never.items.ads'), t('never.items.rankings')]}
          />
        </Card>
      </section>
    </>
  );
}

type SwitchRowProps = {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean, input: HTMLInputElement) => void;
  stateWords: { on: string; off: string };
  children?: ReactNode;
};

/*
 * A real checkbox with role="switch" inside its label: one tap target 44px or taller, named by the label, described by the hint.
 * The track shows the state three ways: the word (On / Off), the knob's side and a check mark in the knob when on.
 * The focus ring is drawn on the row (Visible Focus Rule); a disabled row is dimmed with a not-allowed cursor.
 */
function SwitchRow({ label, hint, checked, disabled, onChange, stateWords, children }: SwitchRowProps) {
  const hintId = useId();
  return (
    <div className="grid gap-2 rounded-control border border-line bg-paper p-4">
      <label
        className={clsx(
          'flex min-h-tap min-w-0 cursor-pointer items-center justify-between gap-3 rounded-control',
          'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
          'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
        )}
      >
        <span className="min-w-0 text-xl leading-tight font-bold tracking-tight wrap-anywhere text-ink">{label}</span>
        <input
          type="checkbox"
          role="switch"
          className="sr-only"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.currentTarget.checked, event.currentTarget)}
        />
        <span aria-hidden="true" className="flex shrink-0 items-center gap-2">
          <span className="min-w-8 text-base font-bold text-ink">{checked ? stateWords.on : stateWords.off}</span>
          <span
            className={clsx(
              'flex h-8 w-14 items-center rounded-pill border-2 p-0.5',
              checked ? 'justify-end border-accent bg-accent' : 'justify-start border-muted bg-paper',
            )}
          >
            <span className={clsx('flex size-6 items-center justify-center rounded-pill', checked ? 'bg-white text-accent' : 'bg-muted')}>
              {checked ? <Check aria-hidden="true" data-slot="on-mark" className="size-4" /> : null}
            </span>
          </span>
        </span>
      </label>
      <p id={hintId} className="m-0 text-base leading-[1.45] text-muted wrap-anywhere">
        {hint}
      </p>
      {children}
    </div>
  );
}

type ConsentsSectionProps = { consents: Consents; age: number };

function ConsentsSection({ consents, age }: ConsentsSectionProps) {
  const { t } = useTranslation('privacy-settings');
  const queryClient = useQueryClient();
  const headingId = useId();
  const guardianId = useId();
  const guardianHintId = useId();
  const guardianErrorId = useId();

  const [guardianTicked, setGuardianTicked] = useState(false);
  const [askGuardian, setAskGuardian] = useState(false);
  // The server said a guardian is needed although our copy of the age did not: show the checkbox whatever the age was.
  const [serverWantsGuardian, setServerWantsGuardian] = useState(false);
  const inFlight = useRef(false);
  const restoreFocus = useRef<HTMLInputElement | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const guardianRef = useRef<HTMLInputElement>(null);

  const save = useMutation<Consents, unknown, { kind: ConsentKind; body: UpdateConsentsRequest }, { previous: Consents | undefined }>({
    mutationFn: ({ body }) => api.put(ENDPOINTS.updateConsents.path, { body, schema: ENDPOINTS.updateConsents.response }),
    onMutate: async ({ kind, body }) => {
      await queryClient.cancelQueries({ queryKey: CONSENTS_KEY });
      const previous = queryClient.getQueryData<Consents>(CONSENTS_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData<Consents>(
          CONSENTS_KEY,
          applyOptimistic(previous, kind, body[kind] === true, body.guardianConfirmed === true),
        );
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData<Consents>(CONSENTS_KEY, context.previous);
      if (describeProblem(error).fieldErrors.guardianConfirmed !== undefined) {
        setServerWantsGuardian(true);
        setAskGuardian(true);
      }
    },
    onSuccess: (response) => {
      queryClient.setQueryData<Consents>(CONSENTS_KEY, response);
      setGuardianTicked(false);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const pending = save.isPending;
  const guardianRefused = save.isError && describeProblem(save.error).fieldErrors.guardianConfirmed !== undefined;
  const failure = save.isError && !guardianRefused ? describeProblem(save.error, (key) => t(key)) : null;
  const video = consents.videoAnalysis;
  const needsGuardian = (age < GUARDIAN_BELOW_AGE || serverWantsGuardian) && !video.granted;

  // A natively disabled control drops keyboard focus: give it back to the failure message, or to the switch that was used.
  const showsFailure = failure !== null;
  useEffect(() => {
    if (pending) return;
    const target = showsFailure ? alertRef.current : restoreFocus.current;
    restoreFocus.current = null;
    target?.focus();
  }, [pending, showsFailure]);

  // Asking for the guardian's tick sends the player there.
  useEffect(() => {
    if (askGuardian) guardianRef.current?.focus();
  }, [askGuardian]);

  function change(kind: ConsentKind, next: boolean, input: HTMLInputElement): void {
    if (inFlight.current) return;
    let body: UpdateConsentsRequest = { [kind]: next };
    if (kind === 'videoAnalysis' && next && needsGuardian) {
      if (!guardianTicked) {
        setAskGuardian(true);
        return;
      }
      body = { videoAnalysis: true, guardianConfirmed: true };
    }
    inFlight.current = true;
    restoreFocus.current = input;
    setAskGuardian(false);
    save.mutate({ kind, body });
  }

  const stateWords = { on: t('state.on'), off: t('state.off') };
  // What the SERVER says the change came to (the response), not what was asked for.
  const saved = save.isSuccess ? { kind: save.variables.kind, granted: save.data[save.variables.kind].granted } : null;
  const savedName = saved === null ? '' : t(saved.kind === 'videoAnalysis' ? 'consents.video.label' : 'consents.model.label');

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <Card elevated className="grid gap-4">
        <h2 id={headingId} className={H2}>
          {t('consents.title')}
        </h2>
        <p className="m-0 text-base leading-[1.45] text-ink">{t('consents.lead')}</p>

        <SwitchRow
          label={t('consents.video.label')}
          hint={t('consents.video.hint')}
          checked={video.granted}
          disabled={pending}
          stateWords={stateWords}
          onChange={(next, input) => change('videoAnalysis', next, input)}
        >
          {needsGuardian ? (
            <div className="mt-1 grid gap-2 rounded-control border border-line bg-bg p-3.5">
              <p id={guardianHintId} className="m-0 text-base leading-[1.45] text-ink wrap-anywhere">
                {t('guardian.hint')}
              </p>
              <label
                htmlFor={guardianId}
                className={clsx(
                  'flex min-h-tap cursor-pointer items-center gap-3 rounded-control',
                  'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                  'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
                )}
              >
                <input
                  id={guardianId}
                  ref={guardianRef}
                  type="checkbox"
                  className="size-6 shrink-0 accent-ink"
                  checked={guardianTicked}
                  disabled={pending}
                  aria-invalid={askGuardian ? true : undefined}
                  aria-describedby={askGuardian ? `${guardianHintId} ${guardianErrorId}` : guardianHintId}
                  onChange={(event) => {
                    setGuardianTicked(event.currentTarget.checked);
                    if (event.currentTarget.checked) setAskGuardian(false);
                  }}
                />
                <span className="min-w-0 text-base font-bold wrap-anywhere text-ink">{t('guardian.label')}</span>
              </label>
              {askGuardian ? (
                <p id={guardianErrorId} role="alert" className="m-0 flex items-start gap-2 font-bold text-danger">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <span className="min-w-0 wrap-anywhere">{t('guardian.required')}</span>
                </p>
              ) : null}
            </div>
          ) : video.granted && video.guardianConfirmed === true && age < GUARDIAN_BELOW_AGE ? (
            <p className="m-0 flex items-start gap-2 text-base font-bold text-ink">
              <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{t('guardian.confirmed')}</span>
            </p>
          ) : null}
        </SwitchRow>

        <SwitchRow
          label={t('consents.model.label')}
          hint={t('consents.model.hint')}
          checked={consents.modelImprovement.granted}
          disabled={pending}
          stateWords={stateWords}
          onChange={(next, input) => change('modelImprovement', next, input)}
        />

        {failure !== null ? (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="grid gap-1 rounded-control border border-danger bg-danger-tint p-3.5 text-ink"
          >
            <p className="m-0 flex items-start gap-2 font-bold">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
              <span className="min-w-0 wrap-anywhere">{t('saveFailed')}</span>
            </p>
            <p className="m-0 text-base wrap-anywhere">{failure.formMessage}</p>
          </div>
        ) : saved !== null ? (
          <div role="status" className="flex items-start gap-2 text-base font-bold text-ink">
            <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 wrap-anywhere">{t(saved.granted ? 'saved.on' : 'saved.off', { name: savedName })}</span>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

// --- the page -----------------------------------------------------------------------------------

function PrivacyPage() {
  const { t } = useTranslation('privacy-settings');
  const injected = useContext(PrivacyDepsContext);
  const globSlots = useSlot('privacy-panel');
  const panels = injected.slots ?? globSlots;

  const consents = useQuery({
    queryKey: CONSENTS_KEY,
    queryFn: ({ signal }) => api.get(ENDPOINTS.getConsents.path, { schema: ENDPOINTS.getConsents.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  // The age decides whether a guardian must confirm. Same request and key as the plan screen.
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => api.get(ME_PATH, { schema: StartResponse, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const consentsFailure = useFailure(consents);
  const meFailure = useFailure(me);
  const noPlan = hasNoPlan(meFailure);
  const failure = consentsFailure ?? (noPlan ? null : meFailure);

  let body: ReactNode;
  if (noPlan) {
    body = (
      <EmptyState
        className="mt-4"
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
        className="mt-4"
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={consents.isFetching || me.isFetching}
        onRetry={() => {
          if (consentsFailure !== null) void consents.refetch();
          if (meFailure !== null) void me.refetch();
        }}
      />
    );
  } else if (consents.data === undefined || me.data === undefined) {
    body = (
      <div className="mt-4">
        <Loading />
      </div>
    );
  } else {
    body = <ConsentsSection consents={consents.data} age={me.data.profile.age} />;
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
        <Explanation />
        {body}
        {/* The privacy-panel slot: features/privacy/panels/*.panel.tsx mount here (the data panel of fc-mol-bjm.8 among them). */}
        {panels.length === 0 ? null : (
          <div data-slot="privacy-panel" className="mt-4 grid gap-4">
            {panels.map((Panel, position) => (
              <Panel key={position} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/settings/privacy')({ component: PrivacyPage });
