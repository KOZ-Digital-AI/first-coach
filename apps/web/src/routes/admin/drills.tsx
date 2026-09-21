import { type DrillStatusRequest, ENDPOINTS as ADMIN, STATUS_TRANSITIONS } from '@api-types/admin';
import type { DrillDetail, DrillListResponse, DrillReview, DrillSummary } from '@api-types/commons';
import { ENDPOINTS as COMMONS } from '@api-types/commons-api';
import { type Locale, pickLocalized, type TrustStatus } from '@api-types/primitives';
import * as Dialog from '@radix-ui/react-dialog';
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Check, CircleAlert, EyeOff, ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { TrustBadge } from '../../features/commons/TrustBadge';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /admin/drills: DRILL ACTIONS. An Operate-mode screen, one calm column at 360px: the published drills of the Open Sport Commons
 * with their trust status, and the two things an admin does to a drill: give it a trust status, or take it down. It sits under
 * the admin layout (routes/admin/route.tsx), whose role guard is COSMETIC: the API's requireAdmin answers 401/403 to anyone
 * else, and the refusal shows here as an ordinary failure. Every string is in features/admin/drills.messages.ts (namespace
 * `drills`); the status words are the trust badge's own.
 *
 * Only `Route` is exported (see routes/train/onboarding.tsx for why).
 *
 * Data. One list call through the typed client: GET /api/commons/drills (the public library list, published drills only, each
 * with its status and organisation: nothing needs a detail call), an infinite query with "Show more drills". The key is
 * ['admin', 'drills', locale]: deliberately NOT under ['commons', 'list'], so an admin's working list is never persisted.
 * Two mutations, both through the typed client with the shared contract's own schemas:
 * POST /api/admin/drills/:slug/status {toStatus, orgLabel?, note} and POST /api/admin/drills/:slug/unpublish {reason}.
 *
 * Readings of the criteria where they are open (each pinned by drills.test.tsx):
 * - "mark as REVIEWED / EXPERT VERIFIED / ACADEMY VERIFIED": those three targets, minus the drill's own status (STATUS_TRANSITIONS
 *   allows no no-op change), so only legal actions are offered. COMMUNITY is not offered (the criteria do not name it); it
 *   stays reachable through the API. No status is preselected: a trust decision is made on purpose.
 * - The organisation field shows for the two verified statuses. It is required for ACADEMY VERIFIED (checked here before any
 *   request, and a server 422 on /orgLabel lands on the same field), optional for EXPERT VERIFIED (sent only when not blank) and
 *   never sent for REVIEWED. The note is always required; both are trimmed.
 * - "The row updates from the response": DrillDetail has no `status` field, so the row's status is the NEWEST review's `to`
 *   (newest by `at`, as the drill detail screen reads it) and its organisation that review's orgLabel. The response is written
 *   into the cached list, the newest review is shown on the row in a "Latest review" block, and the list (and every cached
 *   commons page) is then refetched so the server has the last word. A row nobody acted on shows no review: the list does not
 *   carry them and no detail call is made per row.
 * - Unpublish is a takedown, and this screen cannot undo it: a modal dialog (Radix, as settings/plan) states the consequence
 *   and needs a reason; "Keep it published" comes first in the buttons. DrillDetail has no unpublished marker (backlog fc-3vc),
 *   so the response cannot mark the row: it leaves the list, a notice above the list says which drill was unpublished and why
 *   (it takes focus, so a keyboard user is not dropped at the top of the page), and the list is refetched.
 * - Disabled. While ANY action request runs, every mutation button and field of every row is disabled (one shared lock, so an
 *   admin cannot start a second decision on a stale screen); a ref also refuses a second submit in the same tick. The dialog
 *   cannot be closed by Escape or an outside click meanwhile.
 * - States. loading = a named busy status; empty = an EmptyState; error = ErrorState (generic localised words, never the
 *   server's text) whose Try again is natively disabled and busy while its refetch runs; a failing next page keeps the rows and
 *   adds a warning; success = the rows. A failed action stays in its form or dialog with the generic message (a 404 says the
 *   drill is no longer published and refreshes the list).
 * - A drill title is a plain link to its public page (/commons/:slug).
 * - Nothing here ranks children or promises a professional career (PRODUCT.md).
 */

const LIST_KEY = ['admin', 'drills'] as const;
/** Every action request carries this key, so useIsMutating can lock every button while one runs. */
const ACTION_KEY = ['admin', 'drills', 'action'] as const;

/** The statuses the criteria let an admin mark a drill with. COMMUNITY is not among them. */
const TARGETS = ['REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED'] as const satisfies readonly TrustStatus[];
type Target = (typeof TARGETS)[number];

/** The words of each trust status: the trust badge's own (namespace `trust-badge`). */
const STATUS_WORDS = {
  COMMUNITY: 'community',
  REVIEWED: 'reviewed',
  EXPERT_VERIFIED: 'expertVerified',
  ACADEMY_VERIFIED: 'academyVerified',
} as const satisfies Record<TrustStatus, string>;

/** The statuses that may name the organisation behind them (the trust badge reads it for these only). */
const isVerified = (status: TrustStatus): boolean => status === 'EXPERT_VERIFIED' || status === 'ACADEMY_VERIFIED';

/** Only the targets STATUS_TRANSITIONS allows from `current`. */
const offeredFrom = (current: TrustStatus): readonly Target[] => TARGETS.filter((target) => STATUS_TRANSITIONS[current].includes(target));

const pathOf = (template: string, slug: string): string => template.replace(':slug', encodeURIComponent(slug));

/** The newest review by date; the API sends them newest first and a stable sort keeps that order for equal dates. */
function newestReview(reviews: readonly DrillReview[]): DrillReview | undefined {
  return [...reviews].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
}

const DATE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };

/** A long date in the active language, in UTC. Anything unreadable is shown as it came. */
function formatDate(iso: string, locale: Locale): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  try {
    return new Intl.DateTimeFormat(DATE_TAGS[locale], { dateStyle: 'long', timeZone: 'UTC' }).format(time);
  } catch {
    return iso.slice(0, 10);
  }
}

type ListData = InfiniteData<DrillListResponse, string | undefined>;

/** The list row as the response says it is now: the status and organisation of the newest review. */
function withReview(item: DrillSummary, review: DrillReview): DrillSummary {
  const { orgLabel: _previous, ...rest } = item;
  return review.orgLabel.trim() === '' ? { ...rest, status: review.to } : { ...rest, status: review.to, orgLabel: review.orgLabel };
}

// --- shared bits ---------------------------------------------------------------------------------------------------

/** Words + icon, like Field's own error: an error is never colour alone. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="m-0 flex items-start gap-2 font-bold text-danger">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

function FailureNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <p className="m-0 min-w-0 wrap-anywhere">{children}</p>
    </div>
  );
}

const ACTIONS = 'flex flex-col gap-3 sm:flex-row';

// --- the status form -----------------------------------------------------------------------------------------------

type FormErrors = { choose?: string; note?: string; org?: string };

function StatusForm({
  drill,
  title,
  locked,
  onCancel,
  onSaved,
  onGone,
}: {
  drill: DrillSummary;
  title: string;
  locked: boolean;
  onCancel: () => void;
  onSaved: (detail: DrillDetail) => void;
  onGone: () => void;
}) {
  const { t } = useTranslation(['drills', 'trust-badge']);
  const id = useId();
  const [target, setTarget] = useState<Target | ''>('');
  const [note, setNote] = useState('');
  const [org, setOrg] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const firstRadio = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const orgRef = useRef<HTMLInputElement>(null);

  // The panel was opened on purpose: put the reader at its first question.
  useEffect(() => firstRadio.current?.focus(), []);

  const mutation = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: (body: DrillStatusRequest) => api.post(pathOf(ADMIN.setDrillStatus.path, drill.slug), { body, schema: ADMIN.setDrillStatus.response }),
    onSuccess: onSaved,
    onError: (error) => {
      const view = describeProblem(error, (key) => t(key));
      // A 422 that points at a field of this form is shown on that field in the screen's own words, never the server's text.
      const next: FormErrors = {};
      if (view.fieldErrors.orgLabel !== undefined) next.org = t('status.errors.org');
      if (view.fieldErrors.note !== undefined) next.note = t('status.errors.note');
      if (view.fieldErrors.toStatus !== undefined) next.choose = t('status.errors.same');
      if (Object.keys(next).length > 0) setErrors(next);
      else setFailure(view.formMessage);
      // The drill is not published any more (someone else took it down): what is on screen is stale.
      if (isApiProblem(error) && error.kind === 'not_found') onGone();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const pending = mutation.isPending;
  const busy = pending || locked;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (inFlight.current || busy) return;
    const next: FormErrors = {};
    if (target === '') next.choose = t('status.errors.choose');
    if (note.trim() === '') next.note = t('status.errors.note');
    if (target === 'ACADEMY_VERIFIED' && org.trim() === '') next.org = t('status.errors.org');
    setErrors(next);
    setFailure(null);
    if (target === '' || Object.keys(next).length > 0) {
      const focusFirst = next.choose ? firstRadio : next.note ? noteRef : orgRef;
      focusFirst.current?.focus();
      return;
    }
    const label = org.trim();
    inFlight.current = true;
    mutation.mutate({ toStatus: target, note: note.trim(), ...(isVerified(target) && label !== '' ? { orgLabel: label } : {}) });
  }

  const chooseId = `${id}-choose-error`;
  const options = offeredFrom(drill.status);
  return (
    <form
      aria-label={t('status.form', { title })}
      noValidate
      onSubmit={submit}
      className="grid gap-4 rounded-control border border-line bg-bg p-4"
    >
      <fieldset aria-describedby={errors.choose ? chooseId : undefined} className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] font-bold text-ink">{t('status.legend')}</legend>
        {options.map((option, index) => {
          const checked = target === option;
          return (
            <label
              key={option}
              className={clsx(
                'flex min-h-tap cursor-pointer items-center gap-3 rounded-control border px-3.5 py-2.5 text-base text-ink',
                checked ? 'border-accent bg-accent-2' : 'border-line bg-paper',
                busy && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                ref={index === 0 ? firstRadio : undefined}
                type="radio"
                name={`${id}-status`}
                value={option}
                checked={checked}
                disabled={busy}
                className="size-5 shrink-0 accent-accent"
                onChange={() => {
                  setTarget(option);
                  setErrors((previous) => ({ ...previous, choose: undefined }));
                }}
              />
              <span className="min-w-0 font-bold wrap-anywhere">{t(`trust-badge:${STATUS_WORDS[option]}`)}</span>
              {checked ? <Check aria-hidden="true" className="ml-auto size-5 shrink-0" /> : null}
            </label>
          );
        })}
        {errors.choose ? <FieldError id={chooseId}>{errors.choose}</FieldError> : null}
      </fieldset>

      {target !== '' && isVerified(target) ? (
        <Field label={t('status.org.label')} hint={t('status.org.hint')} error={errors.org}>
          {(control) => (
            <input
              {...control}
              ref={orgRef}
              type="text"
              value={org}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => {
                setOrg(event.target.value);
                setErrors((previous) => ({ ...previous, org: undefined }));
              }}
            />
          )}
        </Field>
      ) : null}

      <Field label={t('status.note.label')} hint={t('status.note.hint')} error={errors.note}>
        {(control) => (
          <textarea
            {...control}
            ref={noteRef}
            rows={3}
            value={note}
            disabled={busy}
            onChange={(event) => {
              setNote(event.target.value);
              setErrors((previous) => ({ ...previous, note: undefined }));
            }}
          />
        )}
      </Field>

      {failure === null ? null : <FailureNotice>{failure}</FailureNotice>}

      <div className={ACTIONS}>
        <Button type="submit" loading={pending} disabled={locked} className="w-full sm:w-auto">
          {pending ? t('status.saving') : t('status.save')}
        </Button>
        <Button variant="secondary" disabled={busy} className="w-full sm:w-auto" onClick={onCancel}>
          {t('status.cancel')}
        </Button>
      </div>
    </form>
  );
}

// --- the unpublish dialog ------------------------------------------------------------------------------------------

function UnpublishBody({
  drill,
  title,
  onCancel,
  onDone,
  onGone,
}: {
  drill: DrillSummary;
  title: string;
  onCancel: () => void;
  onDone: (detail: DrillDetail) => void;
  onGone: () => void;
}) {
  const { t } = useTranslation('drills');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const mutation = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: (body: { reason: string }) => api.post(pathOf(ADMIN.unpublishDrill.path, drill.slug), { body, schema: ADMIN.unpublishDrill.response }),
    onSuccess: onDone,
    onError: (problem) => {
      const view = describeProblem(problem, (key) => t(key));
      if (view.fieldErrors.reason !== undefined) setError(t('unpublish.errors.reason'));
      else setFailure(view.formMessage);
      if (isApiProblem(problem) && problem.kind === 'not_found') onGone();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const pending = mutation.isPending;

  // The confirm button was disabled while the request ran, which drops its focus: after a failure put it back.
  useEffect(() => {
    if (mutation.isError) confirmRef.current?.focus();
  }, [mutation.isError]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (inFlight.current || pending) return;
    if (reason.trim() === '') {
      setError(t('unpublish.errors.reason'));
      reasonRef.current?.focus();
      return;
    }
    setError(null);
    setFailure(null);
    inFlight.current = true;
    mutation.mutate({ reason: reason.trim() });
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <Dialog.Title className="m-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">
        {t('unpublish.title', { title })}
      </Dialog.Title>
      <Dialog.Description className="m-0 text-base wrap-break-word text-ink">{t('unpublish.body')}</Dialog.Description>
      <Field label={t('unpublish.reason.label')} hint={t('unpublish.reason.hint')} error={error ?? undefined}>
        {(control) => (
          <textarea
            {...control}
            ref={reasonRef}
            rows={3}
            value={reason}
            disabled={pending}
            onChange={(event) => {
              setReason(event.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      {failure === null ? null : <FailureNotice>{failure}</FailureNotice>}
      <div className={ACTIONS}>
        <Button variant="secondary" disabled={pending} className="w-full sm:w-auto" onClick={onCancel}>
          {t('unpublish.cancel')}
        </Button>
        <Button ref={confirmRef} type="submit" variant="danger" loading={pending} className="w-full sm:w-auto">
          {pending ? null : <EyeOff aria-hidden="true" className="size-5 shrink-0" />}
          {t('unpublish.confirm')}
        </Button>
      </div>
    </form>
  );
}

// --- one row -------------------------------------------------------------------------------------------------------

function LatestReview({ review, locale, id }: { review: DrillReview; locale: Locale; id: string }) {
  const { t } = useTranslation(['drills', 'trust-badge']);
  const word = (status: TrustStatus) => t(`trust-badge:${STATUS_WORDS[status]}`);
  const org = review.orgLabel.trim();
  return (
    <section aria-labelledby={id} className="grid gap-1 rounded-control border border-line bg-bg px-3.5 py-3 text-base text-ink">
      <h3 id={id} className="m-0 text-xs font-bold tracking-[.12em] text-muted uppercase">
        {t('row.latest')}
      </h3>
      <p className="m-0 font-bold wrap-anywhere">{t('row.by', { reviewer: review.reviewer, date: formatDate(review.at, locale) })}</p>
      {review.from === review.to ? null : <p className="m-0">{t('row.moved', { from: word(review.from), to: word(review.to) })}</p>}
      {org === '' ? null : <p className="m-0 wrap-anywhere">{t('row.org', { org })}</p>}
      <p className="m-0 wrap-anywhere">{review.note}</p>
    </section>
  );
}

function DrillRow({
  drill,
  review,
  locale,
  locked,
  onSaved,
  onUnpublished,
  onGone,
}: {
  drill: DrillSummary;
  review: DrillReview | undefined;
  locale: Locale;
  locked: boolean;
  onSaved: (detail: DrillDetail) => void;
  onUnpublished: (detail: DrillDetail, title: string) => void;
  onGone: () => void;
}) {
  const { t } = useTranslation(['drills', 'trust-badge']);
  const id = useId();
  const title = pickLocalized(drill.title, locale) ?? drill.slug;
  const [panel, setPanel] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [saved, setSaved] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const unpublishRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // The panel closes (Cancel or a saved status) while the button is still disabled by the lock: focus it once it can take it.
  useEffect(() => {
    if (restoreFocus.current && !panel && !locked) {
      restoreFocus.current = false;
      changeRef.current?.focus();
    }
  }, [panel, locked]);

  function closePanel(): void {
    restoreFocus.current = true;
    setPanel(false);
  }

  return (
    <li>
      <Card className="grid gap-4">
        <TrustBadge status={drill.status} source={drill.source} orgLabel={drill.orgLabel} className="self-start" />
        <div className="grid gap-1">
          <h2 id={`${id}-title`} className="m-0 text-[22px] leading-[1.1] font-bold tracking-[-.03em] wrap-break-word text-ink">
            <a href={`/commons/${encodeURIComponent(drill.slug)}`}>{title}</a>
          </h2>
          <p className="m-0 text-sm wrap-anywhere text-muted">{drill.slug}</p>
        </div>

        {/* Always mounted, so a screen reader announces the text when it appears. */}
        <div role="status" className="empty:-mt-4">
          {saved ? (
            <p className="m-0 flex items-center gap-2 font-bold text-ink">
              <Check aria-hidden="true" className="size-5 shrink-0" />
              {t('row.saved')}
            </p>
          ) : null}
        </div>
        {review === undefined ? null : <LatestReview review={review} locale={locale} id={`${id}-latest`} />}

        <div className={ACTIONS}>
          <Button
            ref={changeRef}
            variant="secondary"
            disabled={locked}
            aria-expanded={panel}
            aria-describedby={`${id}-title`}
            className="w-full sm:w-auto"
            onClick={() => {
              if (panel) closePanel();
              else {
                setSaved(false);
                setPanel(true);
              }
            }}
          >
            <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
            {t('row.changeStatus')}
          </Button>
          <Button
            ref={unpublishRef}
            variant="danger"
            disabled={locked}
            aria-describedby={`${id}-title`}
            className="w-full sm:w-auto"
            onClick={() => setDialog(true)}
          >
            <EyeOff aria-hidden="true" className="size-5 shrink-0" />
            {t('row.unpublish')}
          </Button>
        </div>

        {panel ? (
          <StatusForm
            drill={drill}
            title={title}
            locked={locked}
            onCancel={closePanel}
            onSaved={(detail) => {
              setSaved(true);
              closePanel();
              onSaved(detail);
            }}
            onGone={onGone}
          />
        ) : null}
      </Card>

      <Dialog.Root
        open={dialog}
        onOpenChange={(next) => {
          // The request cannot be taken back: the dialog stays until it has answered.
          if (!next && locked) return;
          setDialog(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            // Radix returns focus to a Dialog.Trigger, and there is none here: give it back to the button that opened this.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              unpublishRef.current?.focus();
            }}
            className={clsx(
              'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-md -translate-x-1/2 -translate-y-1/2',
              'overflow-y-auto rounded-card border border-line bg-paper p-5.5 text-ink shadow-soft',
            )}
          >
            <UnpublishBody
              drill={drill}
              title={title}
              onCancel={() => setDialog(false)}
              onDone={(detail) => {
                setDialog(false);
                onUnpublished(detail, title);
              }}
              onGone={onGone}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </li>
  );
}

// --- data ----------------------------------------------------------------------------------------------------------

function useDrills(locale: Locale) {
  return useInfiniteQuery({
    queryKey: [...LIST_KEY, locale],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ locale });
      if (pageParam !== undefined) params.set('cursor', pageParam);
      return api.get(`${COMMONS.listDrills.path}?${params}`, { schema: COMMONS.listDrills.response, signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * The failure to show instead of the list. React Query clears `error` the moment a retry starts when there is no data yet; keep
 * the last failure on screen meanwhile so Try again stays put, disabled and busy, instead of flashing to skeletons. Once there
 * is data (a failing NEXT page) the list stays and nothing full-screen is shown.
 */
function useFailure(query: UseInfiniteQueryResult<unknown>): unknown {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  if (query.data !== undefined) return null;
  return query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? last.current : null);
}

// --- the page ------------------------------------------------------------------------------------------------------

type TakenDown = { slug: string; title: string; reason: string };

function Loading() {
  const { t } = useTranslation('drills');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-48 rounded-card" />
      <Skeleton className="h-48 rounded-card" />
      <Skeleton className="h-48 rounded-card" />
    </div>
  );
}

function DrillsPage() {
  const { t, i18n } = useTranslation(['drills', 'trust-badge']);
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const queryClient = useQueryClient();
  const query = useDrills(locale);
  const failure = useFailure(query);
  const locked = useIsMutating({ mutationKey: ACTION_KEY }) > 0;

  const [latest, setLatest] = useState<Readonly<Record<string, DrillReview>>>({});
  const [takenDown, setTakenDown] = useState<readonly TakenDown[]>([]);
  const notices = useRef<HTMLUListElement>(null);

  // A takedown removes the row the focus was on: move it to the notice that says what happened.
  useEffect(() => {
    if (takenDown.length > 0) notices.current?.querySelector<HTMLElement>('li:last-child > [role="status"]')?.focus();
  }, [takenDown.length]);

  /** The server has the last word: ask for the list again, and mark every cached public commons page stale. */
  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    void queryClient.invalidateQueries({ queryKey: ['commons'] });
  }

  /** Edits the rows of every cached list page; `total`, when the server sent one, follows the number of rows taken out. */
  function changeList(edit: (items: DrillSummary[]) => DrillSummary[]): void {
    queryClient.setQueriesData<ListData>({ queryKey: LIST_KEY }, (data) =>
      data === undefined
        ? data
        : {
            ...data,
            pages: data.pages.map((page) => {
              const rows = edit(page.items);
              return { ...page, items: rows, ...(page.total === undefined ? {} : { total: page.total - (page.items.length - rows.length) }) };
            }),
          },
    );
  }

  function saved(detail: DrillDetail): void {
    const review = newestReview(detail.reviews);
    if (review !== undefined) {
      setLatest((previous) => ({ ...previous, [detail.slug]: review }));
      changeList((rows) => rows.map((row) => (row.slug === detail.slug ? withReview(row, review) : row)));
    }
    refresh();
  }

  function unpublished(detail: DrillDetail, title: string): void {
    // The answer is the detail as it was published plus its new row: that row's note is the reason as the server kept it.
    const reason = newestReview(detail.reviews)?.note ?? '';
    setTakenDown((previous) => [...previous, { slug: detail.slug, title, reason }]);
    changeList((rows) => rows.filter((row) => row.slug !== detail.slug));
    refresh();
  }

  const pages = query.data?.pages;
  const items = pages?.flatMap((page) => page.items) ?? [];

  let content: ReactNode;
  if (pages !== undefined) {
    content =
      items.length === 0 ? (
        <EmptyState className="mt-8" title={t('empty.title')} hint={t('empty.hint')} />
      ) : (
        <section className="mt-8">
          <ul role="list" aria-label={t('list')} className="m-0 grid list-none gap-4 p-0">
            {items.map((drill) => (
              <DrillRow
                key={drill.slug}
                drill={drill}
                review={latest[drill.slug]}
                locale={locale}
                locked={locked}
                onSaved={saved}
                onUnpublished={unpublished}
                onGone={refresh}
              />
            ))}
          </ul>
          {query.isFetchNextPageError ? (
            <Notice tone="warn" className="mt-4">
              {describeProblem(query.error, (key) => t(key)).formMessage}
            </Notice>
          ) : null}
          {query.hasNextPage ? (
            <Button variant="secondary" className="mt-4 w-full sm:w-auto" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchNextPageError ? t('error.retry') : t('more')}
            </Button>
          ) : null}
        </section>
      );
  } else if (failure !== null) {
    content = (
      <ErrorState
        className="mt-8"
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else {
    content = <Loading />;
  }

  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
      <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
      {takenDown.length === 0 ? null : (
        <ul ref={notices} role="list" className="m-0 mt-8 grid list-none gap-3 p-0">
          {takenDown.map((entry) => (
            <li key={entry.slug}>
              <Notice tabIndex={-1}>{t('takenDown', { title: entry.title, reason: entry.reason })}</Notice>
            </li>
          ))}
        </ul>
      )}
      {content}
    </main>
  );
}

export const Route = createFileRoute('/admin/drills')({ component: DrillsPage });
