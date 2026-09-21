import {
  CONTRIBUTION_TRANSITIONS,
  type DecisionAction,
  type DecisionResponse,
  ENDPOINTS as ADMIN,
  type ModerationQueueItem,
  QUEUE_STATES,
} from '@api-types/admin';
import type { ContributionAttachment } from '@api-types/contributions';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, type Locale, type TrustStatus } from '@api-types/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ArrowLeft, Check, CircleAlert, CircleX, ExternalLink, FilePlus2, Paperclip, PencilLine, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, LANGUAGE_NAMES, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /admin/contributions/:id: the review screen of ONE contribution. An Operate-mode screen: one calm column. It sits under the admin
 * layout (routes/admin/route.tsx), whose role guard is COSMETIC: the API's requireAdmin answers 401/403 to anyone else, and a refusal
 * shows here as an ordinary load failure. Every string is in review.messages.ts (the words of closed sets come from queue.messages.ts
 * and trust-badge.messages.ts, so both screens say the same word for the same thing).
 *
 * The queue (routes/admin/index.tsx) already shows the submission, the diff of an improvement and a note-only decision, so this screen
 * adds only what the queue has no room for: the private VIDEO, a moderation CHECKLIST, INLINE EDITS limited to what the API accepts
 * for the contribution's kind, and an approval that carries the edits, the initial TRUST STATUS and an ORGANISATION label in ONE
 * request. Two calls, through the typed client (shared/admin.ts): GET /api/admin/contributions?state=<state> and
 * POST /api/admin/contributions/:id/decision. No mock or fixture data in this file.
 *
 * Readings of the criteria (each pinned by review.test.tsx):
 * - There is no single-contribution endpoint, so the contribution is picked out of the state lists by id: pending first, then the
 *   other queue states, stopping at the first that holds it (one request in the usual case). One in no list is "not waiting for
 *   review". A contribution that is not pending is shown read-only: CONTRIBUTION_TRANSITIONS offers no action for it.
 * - The video plays from the private media route, /api/media/<attachment id> (the attachment's own `url` points at the upload store,
 *   which is not the route that checks who may read it). The other files are links to the same route.
 * - The checklist gates Approve only: an approval with a check unticked is refused here with no request. It is not sent (the
 *   contract has no field for it). Reject and Request changes do not need it.
 * - Editable fields = what the API accepts: NEW: name, sport, skill, goal, ages, level, instructions, duration, equipment, the four
 *   notes, source, source link. IMPROVEMENT: the same minus sport, skill and goal (the drill keeps its own). Author, language, kind and
 *   the target drill are never editable, so they get no control. Only CHANGED fields are sent, as `edits`, and only with an approval.
 *   A source link left blank is never sent: the API cannot remove one.
 * - Approve always sends `status` (Community preselected). Expert and Academy verified need a note; Academy verified also needs the
 *   organisation, which is offered for the two verified statuses only and is sent when it is not blank (as on /admin/drills).
 * - A server 422 is shown at the field its pointer names, in the screen's own words (never the server's text): /edits/<key>,
 *   /orgLabel, /note. An invalid edit with no field (/edits) and every other failure keep the form as it was, so the same decision
 *   can be sent again.
 * - 409 / 404 on the decision: someone decided, or the coach withdrew it. Nothing was saved (nothing was applied before the answer),
 *   so the contribution is looked up again; it is then shown as the state it now has, or as no longer waiting for review.
 * - A decision replaces the screen from the response (state, title, reviewer note, link to the drill) and takes the contribution out of
 *   the queue's cached pending list without a second GET; the queue's other lists are marked stale.
 * - Only `Route` is exported: a route file's other exports end up in the entry chunk.
 */

const LOOKUP_KEY = (id: string) => ['admin', 'contribution', id] as const;
/** The queue's own cache keys (routes/admin/index.tsx: [...QUEUE_KEY, state]). */
const QUEUE_KEY = ['admin', 'contributions'] as const;

const EYEBROW = 'm-0 text-xs font-bold tracking-[.12em] text-accent uppercase';
const H2 = 'm-0 text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-anywhere text-ink';
const LINK =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border border-line bg-paper px-4.5 py-2.5 text-center font-bold wrap-anywhere text-ink hover:bg-bg';
const LEGEND = 'mb-2 p-0 text-[13px] font-bold text-ink';

// --- what an admin may edit ---------------------------------------------------------------------

/** In the order of the form. */
const EDIT_KEYS = [
  'name',
  'sport',
  'skill',
  'goal',
  'ageMin',
  'ageMax',
  'level',
  'durationMin',
  'equipment',
  'instructions',
  'mistakes',
  'progression',
  'regression',
  'safety',
  'source',
  'sourceUrl',
] as const;
type EditKey = (typeof EDIT_KEYS)[number];

/** The API refuses these on an improvement (the drill keeps its own); on a new method they are editable. */
const LOCKED_ON_IMPROVEMENT: readonly EditKey[] = ['sport', 'skill', 'goal'];

type Control = 'text' | 'number' | 'area' | 'select';
const CONFIG: Readonly<Record<EditKey, { label: string; control: Control; wide?: boolean; hint?: string; options?: readonly string[]; words?: string }>> = {
  name: { label: 'queue:fields.name', control: 'text', wide: true },
  sport: { label: 'queue:review.facts.sport', control: 'text', hint: 'edit.hints.sport' },
  skill: { label: 'queue:review.facts.skill', control: 'text', hint: 'edit.hints.skill' },
  goal: { label: 'queue:fields.goal', control: 'select', options: GOALS, words: 'queue:goal' },
  ageMin: { label: 'queue:fields.ageMin', control: 'number' },
  ageMax: { label: 'queue:fields.ageMax', control: 'number' },
  level: { label: 'queue:fields.level', control: 'select', options: EXPERIENCE_LEVELS, words: 'queue:level' },
  durationMin: { label: 'queue:fields.durationMin', control: 'number' },
  equipment: { label: 'queue:fields.equipment', control: 'select', options: EQUIPMENT, words: 'queue:equipment' },
  instructions: { label: 'queue:fields.instructions', control: 'area', wide: true },
  mistakes: { label: 'queue:fields.mistakes', control: 'area', wide: true },
  progression: { label: 'queue:fields.progression', control: 'area', wide: true },
  regression: { label: 'queue:fields.regression', control: 'area', wide: true },
  safety: { label: 'queue:fields.safety', control: 'area', wide: true },
  source: { label: 'queue:fields.source', control: 'text', wide: true },
  sourceUrl: { label: 'queue:fields.sourceUrl', control: 'text', wide: true, hint: 'edit.hints.sourceUrl' },
};

type Payload = ModerationQueueItem['contribution']['payload'];
type Draft = Record<EditKey, string>;
type ErrorCode = 'required' | 'whole' | 'positive' | 'ageOrder' | 'url' | 'server';
type EditErrors = Partial<Record<EditKey, ErrorCode>>;

const draftOf = (payload: Payload): Draft => ({
  name: payload.name,
  sport: payload.sport,
  skill: payload.skill,
  goal: payload.goal,
  ageMin: String(payload.ageMin),
  ageMax: String(payload.ageMax),
  level: payload.level,
  durationMin: String(payload.durationMin),
  equipment: payload.equipment,
  instructions: payload.instructions,
  mistakes: payload.mistakes,
  progression: payload.progression,
  regression: payload.regression,
  safety: payload.safety,
  source: payload.source,
  sourceUrl: payload.sourceUrl ?? '',
});

/**
 * Checks the offered fields and collects the CHANGED ones. A single-line text is compared and sent trimmed; a note is compared and
 * sent as typed; a number is compared as a number; a blank source link is skipped (it cannot be removed).
 */
function checkEdits(draft: Draft, payload: Payload, keys: readonly EditKey[]): { errors: EditErrors; edits: Record<string, string | number> } {
  const errors: EditErrors = {};
  const edits: Record<string, string | number> = {};
  for (const key of keys) {
    const raw = draft[key];
    const original: unknown = payload[key];
    switch (key) {
      case 'name':
      case 'sport':
      case 'skill':
      case 'source': {
        const value = raw.trim();
        if (value === '') errors[key] = 'required';
        else if (value !== original) edits[key] = value;
        break;
      }
      case 'instructions':
        if (raw.trim() === '') errors[key] = 'required';
        else if (raw !== original) edits[key] = raw;
        break;
      case 'mistakes':
      case 'progression':
      case 'regression':
      case 'safety':
      case 'goal':
      case 'level':
      case 'equipment':
        if (raw !== original) edits[key] = raw;
        break;
      case 'ageMin':
      case 'ageMax': {
        const value = raw.trim();
        if (!/^\d+$/.test(value)) errors[key] = 'whole';
        else if (Number(value) !== original) edits[key] = Number(value);
        break;
      }
      case 'durationMin': {
        const value = raw.trim();
        if (!/^\d+$/.test(value) || Number(value) === 0) errors[key] = 'positive';
        else if (Number(value) !== original) edits[key] = Number(value);
        break;
      }
      case 'sourceUrl': {
        const value = raw.trim();
        if (value === '') break;
        if (!/^https?:\/\/\S+$/i.test(value)) errors[key] = 'url';
        else if (value !== original) edits[key] = value;
        break;
      }
    }
  }
  if (keys.includes('ageMin') && keys.includes('ageMax') && errors.ageMin === undefined && errors.ageMax === undefined && Number(draft.ageMax) < Number(draft.ageMin)) {
    errors.ageMax = 'ageOrder';
  }
  return { errors, edits };
}

// --- small helpers ------------------------------------------------------------------------------

const STATUSES = ['COMMUNITY', 'REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED'] as const satisfies readonly TrustStatus[];
/** The words of each trust status: the trust badge's own (namespace `trust-badge`). */
const STATUS_WORDS = { COMMUNITY: 'community', REVIEWED: 'reviewed', EXPERT_VERIFIED: 'expertVerified', ACADEMY_VERIFIED: 'academyVerified' } as const satisfies Record<TrustStatus, string>;
const isVerified = (status: TrustStatus): boolean => status === 'EXPERT_VERIFIED' || status === 'ACADEMY_VERIFIED';

const CHECKS = ['original', 'safe', 'minors'] as const;
type Checks = Record<(typeof CHECKS)[number], boolean>;
const NO_CHECKS: Checks = { original: false, safe: false, minors: false };

/** The private media route (fc-mol-70i.6): the only route that decides who may read an unapproved attachment. */
const mediaUrl = (attachmentId: string): string => `/api/media/${encodeURIComponent(attachmentId)}`;
const editId = (key: EditKey) => `review-edit-${key}`;

function formatSize(bytes: number, locale: Locale): string {
  const [unit, divisor] = bytes >= 1_048_576 ? (['megabyte', 1_048_576] as const) : bytes >= 1024 ? (['kilobyte', 1024] as const) : (['byte', 1] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / divisor);
}

/** There is no single-contribution endpoint: read the state lists, pending first, until one holds the id. */
async function findContribution(id: string, signal: AbortSignal): Promise<ModerationQueueItem | null> {
  for (const state of QUEUE_STATES) {
    const items = await api.get(`${ADMIN.listContributions.path}?${new URLSearchParams({ state }).toString()}`, { schema: ADMIN.listContributions.response, signal });
    const found = items.find((item) => item.contribution.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

/** Words + icon, like Field's own error: an error is never colour alone. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="m-0 flex items-start gap-2 font-bold text-danger">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm font-bold text-ink">{label}</dt>
      <dd className="m-0 min-w-0 text-base wrap-anywhere text-ink">{children}</dd>
    </div>
  );
}

function Loading() {
  const { t } = useTranslation('review');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-6 grid gap-4">
      <Skeleton className="h-24 rounded-card" />
      <Skeleton className="h-56 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

// --- the video and the files --------------------------------------------------------------------

function Media({ files, locale }: { files: ContributionAttachment[]; locale: Locale }) {
  const { t } = useTranslation(['review', 'queue']);
  const videos = files.filter((file) => file.kind === 'video');
  const others = files.filter((file) => file.kind !== 'video');
  return (
    <section aria-labelledby="review-media" className="mt-8">
      <h2 id="review-media" className={H2}>
        {t('media.title')}
      </h2>
      {videos.length === 0 ? (
        <p className="m-0 mt-3 text-base text-ink">{t('media.none')}</p>
      ) : (
        <div className="mt-4 grid gap-4">
          {videos.map((file) => (
            // The private route, by attachment id: it checks who may read this file. No autoplay; the admin starts it.
            <video
              key={file.id}
              controls
              preload="metadata"
              src={mediaUrl(file.id)}
              aria-label={t('media.videoLabel', { name: file.filename ?? t('queue:fileKind.video') })}
              className="max-h-[70vh] w-full rounded-control border border-line bg-ink"
            >
              {t('media.unsupported')}
            </video>
          ))}
        </div>
      )}
      {others.length === 0 ? null : (
        <ul className="m-0 mt-4 grid list-none gap-2 p-0">
          {others.map((file) => {
            const kind = t(`queue:fileKind.${file.kind}`);
            return (
              <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                <Paperclip aria-hidden="true" className="size-4 shrink-0" />
                <a href={mediaUrl(file.id)} target="_blank" rel="noopener noreferrer" className="font-bold wrap-anywhere text-ink underline underline-offset-2">
                  {file.filename ?? kind}
                </a>
                <span className="text-sm text-muted">{file.size === undefined ? kind : `${kind} · ${formatSize(file.size, locale)}`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- the review ---------------------------------------------------------------------------------

function Review({ open, fresh, locale, refreshing }: { open: ModerationQueueItem; fresh: ModerationQueueItem | null; locale: Locale; refreshing: boolean }) {
  const { t } = useTranslation(['review', 'queue', 'trust-badge']);
  const queryClient = useQueryClient();
  const id = open.contribution.id;

  const [draft, setDraft] = useState<Draft>(() => draftOf(open.contribution.payload));
  const [editErrors, setEditErrors] = useState<EditErrors>({});
  const [editsRejected, setEditsRejected] = useState(false);
  const [checks, setChecks] = useState<Checks>(NO_CHECKS);
  const [checksMissing, setChecksMissing] = useState(false);
  const [status, setStatus] = useState<TrustStatus>('COMMUNITY');
  const [org, setOrg] = useState('');
  const [orgMissing, setOrgMissing] = useState(false);
  const [note, setNote] = useState('');
  const [noteMissing, setNoteMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [decided, setDecided] = useState<{ action: DecisionAction; response: DecisionResponse } | null>(null);
  const [focus, setFocus] = useState<{ id: string } | null>(null);
  const inFlight = useRef(false);

  // Focus is asked for by state, so it lands after the screen has shown what it points at (an error, a message).
  useEffect(() => {
    if (focus !== null) document.getElementById(focus.id)?.focus();
  }, [focus]);

  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>): Promise<DecisionResponse> =>
      api.post(ADMIN.decideContribution.path.replace(':id', encodeURIComponent(id)), { body, schema: ADMIN.decideContribution.response }),
    onSuccess: (response, body) => {
      // The mutation returns the updated resource: take the contribution out of the queue's cached pending list instead of asking again.
      queryClient.setQueryData<ModerationQueueItem[]>([...QUEUE_KEY, 'pending'], (old) => old?.filter((item) => item.contribution.id !== response.contribution.id));
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      setDecided({ action: body.action as DecisionAction, response });
      setFocus({ id: 'review-message' });
    },
    onError: (error) => {
      // Someone decided (409) or the contribution is gone (404): nothing was saved, and what is on screen is stale.
      if (isApiProblem(error) && (error.kind === 'conflict' || error.kind === 'not_found')) {
        setConflict(true);
        setFocus({ id: 'review-message' });
        void queryClient.invalidateQueries({ queryKey: LOOKUP_KEY(id) });
        return;
      }
      const view = describeProblem(error, (key) => t(key));
      const next: EditErrors = {};
      for (const key of EDIT_KEYS) if (view.fieldErrors[`edits.${key}`] !== undefined) next[key] = 'server';
      const firstEdit = EDIT_KEYS.find((key) => next[key] !== undefined);
      const onOrg = view.fieldErrors.orgLabel !== undefined;
      const onNote = view.fieldErrors.note !== undefined;
      const onEdits = view.fieldErrors.edits !== undefined;
      setEditErrors(next);
      setOrgMissing(onOrg);
      setNoteMissing(onNote);
      setEditsRejected(onEdits && firstEdit === undefined);
      if (firstEdit !== undefined || onOrg || onNote || onEdits) {
        setFocus({ id: firstEdit !== undefined ? editId(firstEdit) : onOrg ? 'review-org' : onNote ? 'review-note' : 'review-message' });
      } else {
        setFailure(view.formMessage);
        setFocus({ id: 'review-message' });
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const item = fresh ?? open;
  const gone = fresh === null && decided === null;
  const contribution = decided?.response.contribution ?? item.contribution;
  const { submitter } = item;
  const { payload } = contribution;
  const improvement = payload.kind === 'improvement';
  const actions = decided === null && !gone ? CONTRIBUTION_TRANSITIONS[contribution.state] : [];
  const canApprove = actions.includes('approve');
  const pending = decide.isPending;
  const pendingAction = pending ? (decide.variables?.action as DecisionAction | undefined) : undefined;
  const locked = pending || refreshing;
  const offered = useMemo(() => EDIT_KEYS.filter((key) => !(improvement && LOCKED_ON_IMPROVEMENT.includes(key))), [improvement]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const drillSlug = decided?.response.drill?.slug ?? contribution.resultingDrillSlug;

  function submit(action: DecisionAction): void {
    if (inFlight.current || locked) return;
    const trimmed = note.trim();
    setFailure(null);
    setConflict(false);
    setEditsRejected(false);

    if (action !== 'approve') {
      setEditErrors({});
      setChecksMissing(false);
      setOrgMissing(false);
      if (trimmed === '') {
        setNoteMissing(true);
        setFocus({ id: 'review-note' });
        return;
      }
      setNoteMissing(false);
      inFlight.current = true;
      decide.mutate({ action, note: trimmed });
      return;
    }

    const { errors, edits } = checkEdits(draft, payload, offered);
    const checkMissing = !CHECKS.every((key) => checks[key]);
    const noOrg = status === 'ACADEMY_VERIFIED' && org.trim() === '';
    const noNote = isVerified(status) && trimmed === '';
    setEditErrors(errors);
    setChecksMissing(checkMissing);
    setOrgMissing(noOrg);
    setNoteMissing(noNote);
    const firstEdit = EDIT_KEYS.find((key) => errors[key] !== undefined);
    if (firstEdit !== undefined || checkMissing || noOrg || noNote) {
      const first = CHECKS.find((key) => !checks[key]);
      setFocus({ id: firstEdit !== undefined ? editId(firstEdit) : checkMissing ? `review-check-${first}` : noOrg ? 'review-org' : 'review-note' });
      return;
    }
    inFlight.current = true;
    decide.mutate({
      action,
      ...(Object.keys(edits).length > 0 ? { edits } : {}),
      status,
      ...(trimmed === '' ? {} : { note: trimmed }),
      ...(isVerified(status) && org.trim() !== '' ? { orgLabel: org.trim() } : {}),
    });
  }

  function change(key: EditKey, value: string): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setEditErrors((previous) => ({ ...previous, [key]: undefined }));
  }

  function renderField(key: EditKey): ReactNode {
    const config = CONFIG[key];
    const code = editErrors[key];
    const props = {
      label: t(config.label),
      hint: config.hint === undefined ? undefined : t(config.hint),
      error: code === undefined ? undefined : t(`edit.errors.${code}`),
      id: editId(key),
      className: config.wide ? 'sm:col-span-2' : undefined,
    };
    return (
      <Field key={key} {...props}>
        {(control) => {
          if (config.control === 'select') {
            return (
              <select {...control} value={draft[key]} disabled={locked} onChange={(event) => change(key, event.target.value)}>
                {config.options?.map((option) => (
                  <option key={option} value={option}>
                    {t(`${config.words}.${option}`)}
                  </option>
                ))}
              </select>
            );
          }
          if (config.control === 'area') {
            return <textarea {...control} rows={4} value={draft[key]} disabled={locked} onChange={(event) => change(key, event.target.value)} className={clsx(control.className, 'resize-y')} />;
          }
          return (
            <input
              {...control}
              type="text"
              inputMode={config.control === 'number' ? 'numeric' : key === 'sourceUrl' ? 'url' : undefined}
              autoComplete="off"
              value={draft[key]}
              disabled={locked}
              onChange={(event) => change(key, event.target.value)}
            />
          );
        }}
      </Field>
    );
  }

  const noteError = noteMissing ? t('decision.note.required') : undefined;
  const state = contribution.state;
  const reviewerNote = contribution.reviewerNote;

  return (
    <>
      <p className={clsx(EYEBROW, 'mt-8')}>{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink">{payload.name}</h1>

      {conflict ? (
        <div id="review-message" tabIndex={-1} className="mt-6 focus-visible:outline-offset-4">
          <Notice tone="warn">
            <p className="m-0">{t('decision.conflict')}</p>
          </Notice>
        </div>
      ) : null}

      {gone ? (
        <Notice className="mt-6">
          <div>
            <p className="m-0 font-bold">{t('missing.title')}</p>
            <p className="m-0 mt-1">{t('missing.hint')}</p>
          </div>
        </Notice>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <Tag tone={state === 'approved' ? 'accent' : state === 'rejected' ? 'danger' : state === 'changes_requested' ? 'warning' : 'neutral'}>{t(`queue:state.${state}`)}</Tag>
            <Tag>
              {improvement ? <Wrench aria-hidden="true" className="size-3.5 shrink-0" /> : <FilePlus2 aria-hidden="true" className="size-3.5 shrink-0" />}
              {t(`queue:kind.${payload.kind}`)}
            </Tag>
          </div>

          <section aria-labelledby="review-about" className="mt-8">
            <h2 id="review-about" className={H2}>
              {t('about')}
            </h2>
            <dl className="m-0 mt-4 grid gap-3">
              <Fact label={t('queue:review.facts.by')}>{submitter.name}</Fact>
              <Fact label={t('queue:review.facts.sent')}>{date.format(new Date(contribution.createdAt))}</Fact>
              <Fact label={t('queue:review.facts.language')}>{LANGUAGE_NAMES[payload.locale]}</Fact>
              <Fact label={t('queue:fields.author')}>{payload.author}</Fact>
              {improvement && payload.targetDrillSlug !== undefined ? <Fact label={t('queue:review.facts.improves')}>{payload.targetDrillSlug}</Fact> : null}
              {improvement && payload.improvementKind !== undefined ? <Fact label={t('queue:review.facts.changeKind')}>{t(`queue:improvementKind.${payload.improvementKind}`)}</Fact> : null}
            </dl>
            <p className="m-0 mt-3 text-sm text-muted">{t('lockedNote')}</p>
          </section>

          <Media files={contribution.attachments} locale={locale} />

          {reviewerNote === undefined || reviewerNote === '' ? null : (
            <div className="mt-8 rounded-control border border-line bg-bg p-3.5">
              <p className="m-0 text-sm font-bold text-ink">{t('decision.reviewerNote')}</p>
              <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{reviewerNote}</p>
            </div>
          )}

          {decided !== null ? (
            <div id="review-message" tabIndex={-1} className="mt-8 grid gap-3 focus-visible:outline-offset-4">
              <Notice>
                <p className="m-0 font-bold">{t(`decision.outcome.${decided.action}`)}</p>
              </Notice>
              {decided.action === 'approve' && drillSlug !== undefined ? (
                <Link to="/commons/$slug" params={{ slug: drillSlug }} className={clsx(LINK, 'w-full sm:w-auto sm:justify-self-start')}>
                  <ExternalLink aria-hidden="true" className="size-5 shrink-0" />
                  {t('decision.openDrill')}
                </Link>
              ) : null}
            </div>
          ) : actions.length === 0 ? (
            <Notice className="mt-8">
              <p className="m-0">{t(`noActions.${state}`)}</p>
            </Notice>
          ) : (
            <>
              {canApprove ? (
                <>
                  <section aria-labelledby="review-edit" className="mt-8">
                    <h2 id="review-edit" className={H2}>
                      {t('edit.title')}
                    </h2>
                    <p className="m-0 mt-1 text-sm text-muted">{t('edit.hint')}</p>
                    {improvement ? <p className="m-0 mt-1 text-sm text-muted">{t('edit.improvementNote')}</p> : null}
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">{offered.map(renderField)}</div>
                  </section>

                  <fieldset aria-describedby={checksMissing ? 'review-check-error' : undefined} className="m-0 mt-8 grid min-w-0 gap-2 border-0 p-0">
                    <legend className={clsx(H2, 'mb-1 p-0')}>{t('checklist.title')}</legend>
                    <p className="m-0 text-sm text-muted">{t('checklist.hint')}</p>
                    {CHECKS.map((key) => (
                      <label
                        key={key}
                        className={clsx(
                          'flex min-h-tap cursor-pointer items-start gap-3 rounded-control border px-3.5 py-2.5 text-base text-ink',
                          checks[key] ? 'border-accent bg-accent-2' : 'border-line bg-paper',
                          locked && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <input
                          id={`review-check-${key}`}
                          type="checkbox"
                          checked={checks[key]}
                          disabled={locked}
                          className="mt-0.5 size-5 shrink-0 accent-accent"
                          onChange={(event) => {
                            setChecks((previous) => ({ ...previous, [key]: event.target.checked }));
                            setChecksMissing(false);
                          }}
                        />
                        <span className="min-w-0 wrap-anywhere">{t(`checklist.${key}`)}</span>
                      </label>
                    ))}
                    {checksMissing ? <FieldError id="review-check-error">{t('checklist.required')}</FieldError> : null}
                  </fieldset>
                </>
              ) : null}

              <section aria-labelledby="review-decision" className="mt-8 grid gap-4">
                <h2 id="review-decision" className={H2}>
                  {t('decision.title')}
                </h2>
                {failure === null ? null : (
                  <div id="review-message" tabIndex={-1} role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink focus-visible:outline-offset-4">
                    <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                    <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                      <p className="m-0 font-bold">{t('decision.failed.title')}</p>
                      <p className="m-0 text-muted">{failure}</p>
                      <p className="m-0">{t('decision.failed.hint')}</p>
                    </div>
                  </div>
                )}
                {editsRejected ? (
                  <div id="review-message" tabIndex={-1} role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink focus-visible:outline-offset-4">
                    <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                    <p className="m-0 min-w-0 wrap-anywhere">{t('edit.errors.form')}</p>
                  </div>
                ) : null}

                {canApprove ? (
                  <>
                    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
                      <legend className={LEGEND}>{t('status.legend')}</legend>
                      <p className="m-0 text-sm text-muted">{t('status.hint')}</p>
                      {STATUSES.map((option) => {
                        const checked = status === option;
                        return (
                          <label
                            key={option}
                            className={clsx(
                              'flex min-h-tap cursor-pointer items-center gap-3 rounded-control border px-3.5 py-2.5 text-base text-ink',
                              checked ? 'border-accent bg-accent-2' : 'border-line bg-paper',
                              locked && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            <input
                              type="radio"
                              name="review-status"
                              value={option}
                              checked={checked}
                              disabled={locked}
                              className="size-5 shrink-0 accent-accent"
                              onChange={() => {
                                setStatus(option);
                                setOrgMissing(false);
                              }}
                            />
                            <span className="min-w-0 font-bold wrap-anywhere">{t(`trust-badge:${STATUS_WORDS[option]}`)}</span>
                            {checked ? <Check aria-hidden="true" className="ml-auto size-5 shrink-0" /> : null}
                          </label>
                        );
                      })}
                    </fieldset>

                    {isVerified(status) ? (
                      <Field id="review-org" label={t('status.org.label')} hint={t('status.org.hint')} error={orgMissing ? t('status.org.required') : undefined}>
                        {(control) => (
                          <input
                            {...control}
                            type="text"
                            autoComplete="off"
                            value={org}
                            disabled={locked}
                            onChange={(event) => {
                              setOrg(event.target.value);
                              setOrgMissing(false);
                            }}
                          />
                        )}
                      </Field>
                    ) : null}
                  </>
                ) : null}

                <Field id="review-note" label={t('decision.note.label')} hint={t('decision.note.hint')} error={noteError}>
                  {(control) => (
                    <textarea
                      {...control}
                      rows={4}
                      value={note}
                      disabled={locked}
                      onChange={(event) => {
                        setNote(event.target.value);
                        setNoteMissing(false);
                      }}
                      className={clsx(control.className, 'resize-y')}
                    />
                  )}
                </Field>

                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                  {canApprove ? (
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
            </>
          )}
        </>
      )}
    </>
  );
}

// --- the page -----------------------------------------------------------------------------------

function ReviewPage() {
  const { t, i18n } = useTranslation('review');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const { id } = Route.useParams();

  const query = useQuery({
    queryKey: LOOKUP_KEY(id),
    queryFn: ({ signal }) => findContribution(id, signal),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // React Query clears `error` the moment a retry starts when there is no data yet. Keep the last failure on screen so Try again
  // stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  // What the contribution looked like when it was found: the fallback once a later look-up finds it in no list.
  const seen = useRef<ModerationQueueItem | null>(null);
  if (query.data !== undefined && query.data !== null) seen.current = query.data;

  const back = (
    <div className="mt-6">
      <Link to="/admin" className={clsx(LINK, 'w-full sm:w-auto')}>
        <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
        {t('back')}
      </Link>
    </div>
  );

  let body: ReactNode;
  if (query.data === undefined) {
    body =
      failure === null ? (
        <Loading />
      ) : (
        <ErrorState
          className="mt-6"
          title={t('error.title')}
          message={describeProblem(failure, (key) => t(key)).formMessage}
          retryLabel={t('error.retry')}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      );
  } else if (query.data === null && seen.current === null) {
    body = (
      <>
        <p className={clsx(EYEBROW, 'mt-8')}>{t('eyebrow')}</p>
        <h1 className="m-0 mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink">{t('missing.title')}</h1>
        <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('missing.hint')}</p>
      </>
    );
  } else {
    body = <Review key={id} open={(seen.current ?? query.data)!} fresh={query.data} locale={locale} refreshing={query.isFetching} />;
  }

  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      {back}
      {body}
    </main>
  );
}

export const Route = createFileRoute('/admin/contributions/$id')({ component: ReviewPage });
