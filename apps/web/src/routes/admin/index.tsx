import {
  CONTRIBUTION_TRANSITIONS,
  type DecisionAction,
  type DecisionResponse,
  ENDPOINTS as ADMIN,
  type ModerationQueueItem,
  QUEUE_STATES,
  type QueueState,
} from '@api-types/admin';
import type { ContributionAttachment } from '@api-types/contributions';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, type Locale } from '@api-types/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ArrowLeft, Check, ChevronRight, CircleX, ExternalLink, FilePlus2, Paperclip, PencilLine, Wrench, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, LANGUAGE_NAMES, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /admin: the review queue. An Operate-mode screen: one calm column, one row per contribution, the review of one contribution in
 * place of the list. It sits under the admin layout (routes/admin/route.tsx), whose role guard is COSMETIC: the API's requireAdmin
 * answers 401/403 to anyone else, and a refusal shows here as an ordinary load failure. Every string is in queue.messages.ts.
 *
 * Two calls, through the typed client (shared/admin.ts): GET /api/admin/contributions?state=<tab> (ModerationQueueItem[]: the full
 * payload, the diff of an improvement, duplicateOf) and POST /api/admin/contributions/:id/decision (the updated contribution, and
 * the created drill on an approval). No mock or fixture data in this file.
 *
 * Readings of the criteria (each pinned by queue.test.tsx):
 * - "each opens the review screen": the review is a view of this same route, not a second route (this bead owns one route file), and
 *   opening it costs no request because the list already carries the full payload and the diff. Back returns to the list, on the same
 *   tab, with focus on the button that opened it. It is component state, not the URL: the address does not name a contribution.
 *   Contract gap to report: the admin layout's "Review queue" link goes to /admin/queue, which no route serves (index.tsx is /admin).
 * - Tabs = one request each (`?state=`), pending first and selected; the tab list is a real ARIA tab list with arrow keys. The API
 *   has no counts and no pagination, so a tab shows no count and the list is the whole state.
 * - "attachment indicator": "Files: 2" with a paperclip, only when the contribution has files. "Possible duplicate" is a written
 *   tag (never colour alone), on both rows the API flags; the review names the other contribution's id (there is no admin screen
 *   for a single contribution to link to).
 * - The decision shows only the actions CONTRIBUTION_TRANSITIONS allows for the state (a pending one: all three, nothing else: none,
 *   with a sentence saying why). No trust-status picker and no edits: the contract's `status` defaults to COMMUNITY on the server and
 *   a drill's status is changed on /admin/drills; the criteria ask for neither.
 * - The note is required to reject or to ask for changes. A blank one is refused here with no request; the server's own 422 on
 *   /note is shown at the same field. An approval may carry a note, and a blank one is not sent.
 * - "roll back / refresh on 409": nothing is applied before the server answers, so there is nothing to roll back. A 409 (someone
 *   decided, or the coach withdrew) or a 404 says nothing was saved and reads the tab's list again; the contribution then leaves it and
 *   the review says so. Every other failure keeps the form and the note as they were, so the same decision can be tried again.
 * - "Mutation buttons": Approve, Request changes and Reject (and the note and Back) are locked while the decision request runs, and
 *   until the list read that follows a 409 has finished. Refresh is the list's own control, disabled and aria-busy while it runs.
 *   The last good list stays on screen during and after a failed refresh.
 * - A decision removes the contribution from the tab's cached list from the response (no second GET); the other tabs read again
 *   when opened. Queries do not retry by themselves and do not refetch on focus.
 * - Only `Route` is exported: a route file's other exports end up in the entry chunk.
 */

const QUEUE_KEY = ['admin', 'contributions'] as const;
const TAB_ID = (state: QueueState) => `queue-tab-${state}`;
const PANEL_ID = 'queue-panel';
const ROW_BUTTON_ID = (id: string) => `queue-review-${id}`;

const EYEBROW = 'm-0 text-xs font-bold tracking-[.12em] text-accent uppercase';
const H2 = 'm-0 text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-anywhere text-ink';
const LINK =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border border-line bg-paper px-4.5 py-2.5 text-center font-bold wrap-anywhere text-ink hover:bg-bg';
// 44px tall, wrapping words, a check icon on the chosen tab: the choice is never colour alone.
const TAB =
  'flex min-h-tap min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-line bg-paper px-3 py-2 text-center text-base font-bold wrap-anywhere text-ink hover:bg-bg data-[selected=true]:border-accent data-[selected=true]:bg-accent-2 sm:px-4';

const FIELD_KEYS = ['name', 'goal', 'instructions', 'mistakes', 'progression', 'regression', 'safety', 'ageMin', 'ageMax', 'level', 'equipment', 'durationMin', 'source', 'sourceUrl', 'author'] as const;
/** Diff fields whose values are members of a closed set: written out in words, not shown as the raw value. */
const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = { level: EXPERIENCE_LEVELS, goal: GOALS, equipment: EQUIPMENT };

/** A file address that is safe to link to: a web address or a path on this site. Anything else (javascript:, data:) is shown as text. */
const isLinkable = (url: string): boolean => /^\/(?![/\\])/.test(url) || /^https?:\/\//i.test(url);

function formatSize(bytes: number, locale: Locale): string {
  const [unit, divisor] = bytes >= 1_048_576 ? (['megabyte', 1_048_576] as const) : bytes >= 1024 ? (['kilobyte', 1024] as const) : (['byte', 1] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / divisor);
}

// --- states -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('queue');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-6 grid gap-4">
      <Skeleton className="h-40 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

// --- tabs ---------------------------------------------------------------------------------------

function Tabs({ state, onChange }: { state: QueueState; onChange: (next: QueueState) => void }) {
  const { t } = useTranslation('queue');

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = QUEUE_STATES.indexOf(state);
    const last = QUEUE_STATES.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = QUEUE_STATES[next]!;
    onChange(target);
    document.getElementById(TAB_ID(target))?.focus();
  }

  return (
    // Roving tabindex: one tab stop for the list; the arrow keys move within it and choose the tab they land on.
    <div role="tablist" aria-label={t('tabsLabel')} onKeyDown={onKeyDown} className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {QUEUE_STATES.map((tabState) => {
        const selected = tabState === state;
        return (
          <button
            key={tabState}
            id={TAB_ID(tabState)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={PANEL_ID}
            tabIndex={selected ? 0 : -1}
            data-selected={selected}
            className={TAB}
            onClick={() => onChange(tabState)}
          >
            {selected ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
            {t(`tabs.${tabState}`)}
          </button>
        );
      })}
    </div>
  );
}

// --- a row --------------------------------------------------------------------------------------

function Row({ item, locale, onOpen }: { item: ModerationQueueItem; locale: Locale; onOpen: () => void }) {
  const { t } = useTranslation('queue');
  const { contribution, submitter, duplicateOf } = item;
  const { payload } = contribution;
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale]);
  const improvement = payload.kind === 'improvement';
  const files = contribution.attachments.length;

  return (
    <li>
      <Card className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h2 className={clsx(H2, 'min-w-0')}>{payload.name}</h2>
          <div className="flex flex-wrap gap-2">
            <Tag>
              {improvement ? <Wrench aria-hidden="true" className="size-3.5 shrink-0" /> : <FilePlus2 aria-hidden="true" className="size-3.5 shrink-0" />}
              {t(`kind.${payload.kind}`)}
            </Tag>
            {duplicateOf === undefined ? null : (
              <Tag tone="warning">
                <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                {t('row.duplicate')}
              </Tag>
            )}
          </div>
        </div>
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
          {improvement && payload.targetDrillSlug !== undefined ? <span>{t('row.improves', { drill: payload.targetDrillSlug })}</span> : null}
          {improvement && payload.improvementKind !== undefined ? <span>{t('row.change', { kind: t(`improvementKind.${payload.improvementKind}`) })}</span> : null}
          <span>{t('row.skill', { skill: payload.skill })}</span>
          <span>{t('row.by', { name: submitter.name })}</span>
          <span>{t('row.sent', { date: date.format(new Date(contribution.createdAt)) })}</span>
          {files > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Paperclip aria-hidden="true" className="size-3.5 shrink-0" />
              {t('row.files', { n: formatNumber(files, locale) })}
            </span>
          ) : null}
        </p>
        <Button id={ROW_BUTTON_ID(contribution.id)} variant="secondary" aria-label={t('row.reviewNamed', { name: payload.name })} className="w-full sm:w-auto sm:self-start" onClick={onOpen}>
          {t('row.review')}
          <ChevronRight aria-hidden="true" className="size-5 shrink-0" />
        </Button>
      </Card>
    </li>
  );
}

// --- the review ---------------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm font-bold text-ink">{label}</dt>
      <dd className="m-0 min-w-0 text-base wrap-anywhere text-ink">{children}</dd>
    </div>
  );
}

/** One value of a diff entry, in words: empty, a closed-set member, a number, a text. */
function useDiffValue(locale: Locale) {
  const { t } = useTranslation('queue');
  return (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return t('review.diff.empty');
    if (typeof value === 'number') return formatNumber(value, locale);
    if (typeof value === 'string') return ENUM_FIELDS[field]?.includes(value) ? t(`${field}.${value}`) : value;
    return JSON.stringify(value);
  };
}

function Diff({ diff, locale }: { diff: NonNullable<ModerationQueueItem['diff']>; locale: Locale }) {
  const { t } = useTranslation('queue');
  const valueOf = useDiffValue(locale);

  function labelOf(field: string): string {
    const [base = field, language] = field.split('.');
    const known = (FIELD_KEYS as readonly string[]).includes(base);
    const label = known ? t(`fields.${base}`) : field;
    const shown = toLocale(language);
    return shown === undefined ? label : t('review.diff.inLanguage', { field: label, language: LANGUAGE_NAMES[shown] });
  }

  if (diff.length === 0) return <p className="m-0 mt-3 text-base text-ink">{t('review.diff.none')}</p>;
  return (
    <ol aria-labelledby="queue-diff" className="m-0 mt-4 grid list-none gap-3 p-0">
      {diff.map((entry) => {
        const base = entry.field.split('.')[0] ?? entry.field;
        return (
          <li key={entry.field} className="grid gap-2 rounded-control border border-line bg-paper p-3.5">
            <p className="m-0 text-base font-bold text-ink">{labelOf(entry.field)}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="min-w-0 rounded-control border border-line bg-bg p-3">
                <p className="m-0 text-xs font-bold text-muted">{t('review.diff.before')}</p>
                <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{valueOf(base, entry.before)}</p>
              </div>
              <div className="min-w-0 rounded-control border border-accent bg-accent-2 p-3">
                <p className="m-0 text-xs font-bold text-ink">{t('review.diff.after')}</p>
                <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{valueOf(base, entry.after)}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Files({ files, locale }: { files: ContributionAttachment[]; locale: Locale }) {
  const { t } = useTranslation('queue');
  return (
    <section aria-labelledby="queue-files" className="mt-8">
      <h2 id="queue-files" className={H2}>
        {t('review.files.title')}
      </h2>
      <ul aria-labelledby="queue-files" className="m-0 mt-3 grid list-none gap-2 p-0">
        {files.map((file) => {
          const kind = t(`fileKind.${file.kind}`);
          const name = file.filename ?? kind;
          return (
            <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
              <Paperclip aria-hidden="true" className="size-4 shrink-0" />
              {isLinkable(file.url) ? (
                <a href={file.url} target="_blank" rel="noopener noreferrer" className="font-bold wrap-anywhere text-ink underline underline-offset-2">
                  {name}
                </a>
              ) : (
                <span className="font-bold wrap-anywhere">{name}</span>
              )}
              <span className="text-sm text-muted">{file.size === undefined ? kind : `${kind} · ${formatSize(file.size, locale)}`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Method({ payload }: { payload: ModerationQueueItem['contribution']['payload'] }) {
  const { t } = useTranslation('queue');
  const parts = [
    ['instructions', payload.instructions],
    ['mistakes', payload.mistakes],
    ['progression', payload.progression],
    ['regression', payload.regression],
    ['safety', payload.safety],
  ] as const;
  return (
    <section aria-labelledby="queue-method" className="mt-8">
      <h2 id="queue-method" className={H2}>
        {t('review.method.title')}
      </h2>
      <dl className="m-0 mt-4 grid gap-4">
        {parts.map(([key, value]) => (
          <div key={key}>
            <dt className="text-sm font-bold text-ink">{t(`fields.${key}`)}</dt>
            {value.trim() === '' ? (
              <dd className="m-0 mt-1 text-base text-muted">{t('review.method.blank')}</dd>
            ) : (
              <dd className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{value}</dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

function Review({
  open,
  fresh,
  locale,
  listKey,
  refreshing,
  onBack,
}: {
  /** What the row showed when it was opened: the fallback once the contribution has left the list. */
  open: ModerationQueueItem;
  /** The contribution as the list has it now; undefined once it is no longer in the tab. */
  fresh: ModerationQueueItem | undefined;
  locale: Locale;
  listKey: readonly unknown[];
  /** The list is being read again (after a 409): the decision is not offered until it has been. */
  refreshing: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation('queue');
  const queryClient = useQueryClient();
  const id = open.contribution.id;

  const [note, setNote] = useState('');
  const [noteMissing, setNoteMissing] = useState(false);
  const [decided, setDecided] = useState<{ action: DecisionAction; response: DecisionResponse } | null>(null);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);

  const decide = useMutation({
    mutationFn: (variables: { action: DecisionAction; note: string }): Promise<DecisionResponse> =>
      api.post(ADMIN.decideContribution.path.replace(':id', encodeURIComponent(id)), {
        // A blank note is not sent: the contract makes it optional for an approval.
        body: variables.note === '' ? { action: variables.action } : { action: variables.action, note: variables.note },
        schema: ADMIN.decideContribution.response,
      }),
    onSuccess: (response, variables) => {
      // The mutation returns the updated resource: take the contribution out of this tab's list instead of asking for the list again.
      queryClient.setQueryData<ModerationQueueItem[]>(listKey, (old) => old?.filter((item) => item.contribution.id !== response.contribution.id));
      setDecided({ action: variables.action, response });
    },
    onError: (error) => {
      // Someone decided (409) or the contribution is gone (404): the list is stale, so read it again.
      if (isApiProblem(error) && (error.kind === 'conflict' || error.kind === 'not_found')) void queryClient.invalidateQueries({ queryKey: listKey });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const view = describeProblem(decide.error, (key) => t(key));
  const conflict = decide.isError && (view.kind === 'conflict' || view.kind === 'not_found');
  const serverNote = decide.isError && view.fieldErrors.note !== undefined;
  const failed = decide.isError && !conflict && !serverNote;
  const noteError = noteMissing || serverNote;

  // The person opened this from a button that is no longer on screen: land on the page title.
  useEffect(() => headingRef.current?.focus(), []);
  // A message replaces the button that was pressed (it is disabled while the request runs): put focus where the answer is.
  useEffect(() => {
    if (decide.isError) (serverNote ? noteRef : messageRef).current?.focus();
  }, [decide.isError, serverNote]);
  useEffect(() => {
    if (decided !== null) messageRef.current?.focus();
  }, [decided]);

  const item = fresh ?? open;
  const { contribution, submitter, duplicateOf, diff } = item;
  const { payload } = contribution;
  const state = decided?.response.contribution.state ?? contribution.state;
  const gone = fresh === undefined && decided === null;
  const actions = decided === null && !gone ? CONTRIBUTION_TRANSITIONS[contribution.state] : [];
  const pending = decide.isPending;
  const locked = pending || refreshing;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const improvement = payload.kind === 'improvement';
  const drillSlug = decided?.response.drill?.slug ?? decided?.response.contribution.resultingDrillSlug ?? contribution.resultingDrillSlug;
  const reviewerNote = decided?.response.contribution.reviewerNote ?? contribution.reviewerNote;

  function submit(action: DecisionAction): void {
    if (inFlight.current) return;
    const trimmed = note.trim();
    if (action !== 'approve' && trimmed === '') {
      setNoteMissing(true);
      noteRef.current?.focus();
      return;
    }
    setNoteMissing(false);
    inFlight.current = true;
    decide.mutate({ action, note: trimmed });
  }

  const pendingAction = pending ? decide.variables?.action : undefined;

  return (
    <>
      <div className="mt-6">
        <Button variant="secondary" disabled={pending} className="w-full sm:w-auto" onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
          {t('review.back')}
        </Button>
      </div>
      <p className={clsx(EYEBROW, 'mt-8')}>{t('title')}</p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="m-0 mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink focus-visible:outline-offset-4"
      >
        {payload.name}
      </h1>

      {gone ? (
        <div className="mt-6 grid gap-3">
          {conflict ? (
            <Notice tone="warn">
              <p className="m-0">{t('decision.conflict')}</p>
            </Notice>
          ) : null}
          <Notice>
            <p className="m-0">{t('decision.gone')}</p>
          </Notice>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <Tag tone={state === 'approved' ? 'accent' : state === 'rejected' ? 'danger' : state === 'changes_requested' ? 'warning' : 'neutral'}>
              {t(`state.${state}`)}
            </Tag>
            <Tag>
              {improvement ? <Wrench aria-hidden="true" className="size-3.5 shrink-0" /> : <FilePlus2 aria-hidden="true" className="size-3.5 shrink-0" />}
              {t(`kind.${payload.kind}`)}
            </Tag>
          </div>

          {duplicateOf === undefined ? null : (
            <Notice tone="warn" className="mt-6">
              <div>
                <p className="m-0 font-bold">{t('review.duplicate.title')}</p>
                <p className="m-0 mt-1">{t('review.duplicate.body', { id: duplicateOf })}</p>
              </div>
            </Notice>
          )}

          <section aria-labelledby="queue-about" className="mt-8">
            <h2 id="queue-about" className={H2}>
              {t('review.about')}
            </h2>
            <dl className="m-0 mt-4 grid gap-3">
              <Fact label={t('review.facts.by')}>{submitter.name}</Fact>
              <Fact label={t('review.facts.sent')}>{date.format(new Date(contribution.createdAt))}</Fact>
              <Fact label={t('review.facts.language')}>{LANGUAGE_NAMES[payload.locale]}</Fact>
              {improvement && payload.targetDrillSlug !== undefined ? <Fact label={t('review.facts.improves')}>{payload.targetDrillSlug}</Fact> : null}
              {improvement && payload.improvementKind !== undefined ? <Fact label={t('review.facts.changeKind')}>{t(`improvementKind.${payload.improvementKind}`)}</Fact> : null}
              <Fact label={t('review.facts.sport')}>{payload.sport}</Fact>
              <Fact label={t('review.facts.skill')}>{payload.skill}</Fact>
              <Fact label={t('review.facts.ages')}>{`${formatNumber(payload.ageMin, locale)}–${formatNumber(payload.ageMax, locale)}`}</Fact>
              <Fact label={t('fields.level')}>{t(`level.${payload.level}`)}</Fact>
              <Fact label={t('fields.goal')}>{t(`goal.${payload.goal}`)}</Fact>
              <Fact label={t('fields.durationMin')}>{formatNumber(payload.durationMin, locale)}</Fact>
              <Fact label={t('fields.equipment')}>{t(`equipment.${payload.equipment}`)}</Fact>
              <Fact label={t('fields.author')}>{payload.author}</Fact>
              <Fact label={t('fields.source')}>
                {payload.source}
                {payload.sourceUrl === undefined ? null : (
                  <>
                    {' '}
                    <a href={payload.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                      {payload.sourceUrl}
                      <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                    </a>
                  </>
                )}
              </Fact>
            </dl>
          </section>

          {improvement ? (
            <section aria-labelledby="queue-diff" className="mt-8">
              <h2 id="queue-diff" className={H2}>
                {t('review.diff.title')}
              </h2>
              {diff === undefined ? (
                <p className="m-0 mt-3 text-base text-ink">{t('review.diff.unavailable')}</p>
              ) : (
                <>
                  <p className="m-0 mt-1 text-sm text-muted">{t('review.diff.lead')}</p>
                  <Diff diff={diff} locale={locale} />
                </>
              )}
            </section>
          ) : null}

          <Method payload={payload} />
          {contribution.attachments.length > 0 ? <Files files={contribution.attachments} locale={locale} /> : null}

          {reviewerNote === undefined || reviewerNote === '' ? null : (
            <div className="mt-8 rounded-control border border-line bg-bg p-3.5">
              <p className="m-0 text-sm font-bold text-ink">{t('review.note')}</p>
              <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{reviewerNote}</p>
            </div>
          )}

          {decided !== null ? (
            <div ref={messageRef} tabIndex={-1} className="mt-8 grid gap-3 focus-visible:outline-offset-4">
              <Notice>
                <p className="m-0 font-bold">{t(`decision.outcome.${decided.action}`)}</p>
              </Notice>
              {decided.action === 'approve' && drillSlug !== undefined ? (
                <Link
                  to="/commons/$slug"
                  params={{ slug: drillSlug }}
                  aria-label={t('review.openDrillNamed', { name: payload.name })}
                  className={clsx(LINK, 'w-full sm:w-auto sm:justify-self-start')}
                >
                  <ExternalLink aria-hidden="true" className="size-5 shrink-0" />
                  {t('review.openDrill')}
                </Link>
              ) : null}
            </div>
          ) : actions.length === 0 ? (
            <div className="mt-8 grid gap-3">
              <Notice>
                <p className="m-0">{t(`review.noActions.${contribution.state}`)}</p>
              </Notice>
              {contribution.state === 'approved' && contribution.resultingDrillSlug !== undefined ? (
                <Link
                  to="/commons/$slug"
                  params={{ slug: contribution.resultingDrillSlug }}
                  aria-label={t('review.openDrillNamed', { name: payload.name })}
                  className={clsx(LINK, 'w-full sm:w-auto sm:justify-self-start')}
                >
                  <ExternalLink aria-hidden="true" className="size-5 shrink-0" />
                  {t('review.openDrill')}
                </Link>
              ) : null}
            </div>
          ) : (
            <section aria-labelledby="queue-decision" className="mt-8 grid gap-4">
              <h2 id="queue-decision" className={H2}>
                {t('decision.title')}
              </h2>
              {conflict ? (
                <div ref={messageRef} tabIndex={-1} className="focus-visible:outline-offset-4">
                  <Notice tone="warn">
                    <p className="m-0">{t('decision.conflict')}</p>
                  </Notice>
                </div>
              ) : null}
              {failed ? (
                <div ref={messageRef} tabIndex={-1} role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink focus-visible:outline-offset-4">
                  <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                  <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                    <p className="m-0 font-bold">{t('decision.failed.title')}</p>
                    <p className="m-0 text-muted">{view.formMessage}</p>
                    <p className="m-0">{t('decision.failed.hint')}</p>
                  </div>
                </div>
              ) : null}
              <Field label={t('decision.note.label')} hint={t('decision.note.hint')} error={noteError ? t('decision.note.required') : undefined}>
                {(control) => (
                  <textarea
                    {...control}
                    ref={noteRef}
                    rows={4}
                    value={note}
                    readOnly={locked}
                    onChange={(event) => {
                      setNote(event.target.value);
                      if (noteMissing) setNoteMissing(false);
                    }}
                    className={clsx(control.className, 'resize-y')}
                  />
                )}
              </Field>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {actions.includes('approve') ? (
                  <Button loading={pendingAction === 'approve'} disabled={locked} className="w-full sm:w-auto" onClick={() => submit('approve')}>
                    {pendingAction === 'approve' ? null : <Check aria-hidden="true" className="size-5 shrink-0" />}
                    {t('decision.approve')}
                  </Button>
                ) : null}
                {actions.includes('request_changes') ? (
                  <Button variant="secondary" loading={pendingAction === 'request_changes'} disabled={locked} className="w-full sm:w-auto" onClick={() => submit('request_changes')}>
                    {pendingAction === 'request_changes' ? null : <PencilLine aria-hidden="true" className="size-5 shrink-0" />}
                    {t('decision.requestChanges')}
                  </Button>
                ) : null}
                {actions.includes('reject') ? (
                  <Button variant="danger" loading={pendingAction === 'reject'} disabled={locked} className="w-full sm:w-auto" onClick={() => submit('reject')}>
                    {pendingAction === 'reject' ? null : <CircleX aria-hidden="true" className="size-5 shrink-0" />}
                    {t('decision.reject')}
                  </Button>
                ) : null}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

// --- the page -----------------------------------------------------------------------------------

function QueuePage() {
  const { t, i18n } = useTranslation('queue');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const [state, setState] = useState<QueueState>('pending');
  const [open, setOpen] = useState<ModerationQueueItem | null>(null);
  const returnFocus = useRef<string | null>(null);

  const listKey = useMemo(() => [...QUEUE_KEY, state] as const, [state]);
  const query = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      api.get(`${ADMIN.listContributions.path}?${new URLSearchParams({ state }).toString()}`, { schema: ADMIN.listContributions.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // React Query clears `error` the moment a retry starts when there is no data yet. Keep the last failure on screen so Try again
  // stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  // Back from a review: the row's button it came from, or (the contribution was decided and is gone) the chosen tab.
  useEffect(() => {
    if (open !== null || returnFocus.current === null) return;
    const target = document.getElementById(ROW_BUTTON_ID(returnFocus.current)) ?? document.getElementById(TAB_ID(state));
    returnFocus.current = null;
    target?.focus();
  }, [open, state]);

  function close(): void {
    returnFocus.current = open?.contribution.id ?? null;
    setOpen(null);
  }

  const items = query.data;

  let body: ReactNode;
  if (items !== undefined) {
    body = (
      <>
        <div className="mt-6">
          <Button variant="secondary" loading={query.isFetching} className="w-full sm:w-auto" onClick={() => void query.refetch()}>
            {query.isFetching ? t('refresh.busy') : t('refresh.label')}
          </Button>
        </div>
        {/* A failed refresh keeps the last good list below it and says so. */}
        {query.error !== null ? (
          <Notice tone="warn" className="mt-4">
            {t('refresh.error')}
          </Notice>
        ) : null}
        {items.length === 0 ? (
          <EmptyState className="mt-6" title={t('empty.title')} hint={t(`empty.hint.${state}`)} />
        ) : (
          <ul aria-label={t('list')} className="m-0 mt-6 grid list-none gap-4 p-0">
            {items.map((item) => (
              <Row
                key={item.contribution.id}
                item={item}
                locale={locale}
                onOpen={() => {
                  setOpen(item);
                }}
              />
            ))}
          </ul>
        )}
      </>
    );
  } else if (failure !== null) {
    body = (
      <ErrorState
        className="mt-6"
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else {
    body = <Loading />;
  }

  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      {open === null ? (
        <>
          <p className={EYEBROW}>{t('eyebrow')}</p>
          <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
          <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
          <Tabs state={state} onChange={setState} />
          <div role="tabpanel" id={PANEL_ID} aria-labelledby={TAB_ID(state)}>
            {body}
          </div>
        </>
      ) : (
        <Review
          key={open.contribution.id}
          open={open}
          fresh={items?.find((item) => item.contribution.id === open.contribution.id)}
          locale={locale}
          listKey={listKey}
          refreshing={query.isFetching}
          onBack={close}
        />
      )}
    </main>
  );
}

export const Route = createFileRoute('/admin/')({ component: QueuePage });
