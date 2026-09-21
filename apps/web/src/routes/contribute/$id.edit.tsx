import {
  Contribution,
  ContributionMeta,
  type ContributionPayloadRequest,
  type ContributionState,
  EDITABLE_STATES,
  ENDPOINTS,
  type SkillOption,
} from '@api-types/contributions';
import { GOALS, type Locale, pickLocalized } from '@api-types/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, CircleX, Clock, ExternalLink, PencilLine, Undo2 } from 'lucide-react';
import { type ComponentType, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { signInUrl } from '../../features/account/session-expired';
import { api, createApi } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /contribute/:id/edit: "Edit and resubmit". An Operate-mode screen: one calm column, the reviewer's note first, then the
 * contribute form again, filled with what the coach sent. Every string is in features/contribute/edit.messages.ts (namespace `edit`).
 *
 * Data (all through the typed client, nothing mocked or seeded)
 *  - GET /api/contributions/mine, cached under ['contributions', 'mine'] (the key My contributions uses). The contract has no
 *    GET /api/contributions/:id, so the one contribution is found in that list by id; an id that is not in it (removed, or another
 *    account's: the API never says which) is "not found".
 *  - GET /api/contribute/meta?locale: the option lists, exactly as the contribute form reads them. An editable contribution waits
 *    for it; a decided one does not need it (it only gives names to the sport and skill, and falls back to the slug).
 *  - PUT /api/contributions/:id, multipart like the create call: a `payload` part (the contract's ContributionPayloadRequest) and,
 *    when a new video was chosen, a `video` part (the API then REPLACES all stored files; with no file part it keeps them).
 *
 * Readings of the criteria where they are open (each pinned by edit.test.tsx)
 *  - "decided state" = approved, rejected, withdrawn: read-only. pending and changes_requested are the contract's EDITABLE_STATES.
 *  - "reuses the form fields": the contribute form's fields, pre-filled. A stored choice the meta no longer offers is left blank and
 *    must be chosen again. The two attestations are asked again every time (never pre-ticked), the honeypot is invisible.
 *    kind, targetDrillSlug, improvementKind, sourceUrl and the content locale are not editable here and go back as stored.
 *  - The save is a plain fetch (no upload progress: the criteria ask for none): the button is busy and every field disabled until
 *    the answer, and the wait says when a video makes it long.
 *  - Success = "returning to My contributions with the state back to pending": the returned Contribution replaces the item in the
 *    cached list and the screen goes to /contribute/mine with history.replace, so Back does not return to a form that was just sent.
 *    My contributions shows the pending tag; there is no separate success screen to sit on.
 *  - Failures keep the answers. 422 pointers land on their fields (a localised sentence; the server's English is never shown), a
 *    pointer that names no field or the honeypot is a form-level message, 413/415 land on the video field. 404 and a state 409 mean
 *    the list is stale, so it is read again and the screen shows what is now true (not found, or the read-only view). A 409 whose
 *    `instance` names ANOTHER contribution of the coach's is the duplicate guard: it says so and links to editing that one.
 *  - Anonymous players are not contributors: the API answers 403 (401 with no session) to the list and the screen sends both to
 *    /account/sign-in?redirect=/contribute/<id>/edit with history.replace. The API's requireContributor is the real gate.
 *  - Only `Route` is exported: a route file's other exports end up in the entry chunk.
 */

const MINE_KEY = ['contributions', 'mine'] as const;
const MINE_PATH = '/contribute/mine';
const BYTES_PER_MB = 1024 * 1024;

const isEditable = (state: ContributionState): boolean => (EDITABLE_STATES as readonly ContributionState[]).includes(state);

const STATE_VIEW: Record<ContributionState, { tone: 'neutral' | 'accent' | 'warning' | 'danger'; Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = {
  pending: { tone: 'neutral', Icon: Clock },
  changes_requested: { tone: 'warning', Icon: PencilLine },
  approved: { tone: 'accent', Icon: CircleCheck },
  rejected: { tone: 'danger', Icon: CircleX },
  withdrawn: { tone: 'neutral', Icon: Undo2 },
};

const TEXT_KEYS = [
  'name',
  'sport',
  'skill',
  'ageMin',
  'ageMax',
  'level',
  'goal',
  'duration',
  'equipment',
  'instructions',
  'mistakes',
  'progression',
  'regression',
  'safety',
  'source',
  'author',
] as const;
type TextKey = (typeof TEXT_KEYS)[number];
type Values = Record<TextKey, string>;

/** Every control a message can land on, in the order they appear on the page (which is the order focus goes to). */
const FIELD_ORDER = [
  'name',
  'sport',
  'skill',
  'ageMin',
  'ageMax',
  'level',
  'goal',
  'duration',
  'equipment',
  'instructions',
  'mistakes',
  'progression',
  'regression',
  'safety',
  'video',
  'source',
  'author',
  'rightsAttested',
  'noCommercialContent',
] as const;
type FieldKey = (typeof FIELD_ORDER)[number];
type FieldErrors = Partial<Record<FieldKey, string>>;

/** A JSON Pointer's dotted path (lib/problem.ts pointerToPath) -> the control it belongs to. `website` is deliberately absent. */
const POINTER_FIELDS: Readonly<Record<string, FieldKey>> = {
  name: 'name',
  sport: 'sport',
  skill: 'skill',
  ageMin: 'ageMin',
  ageMax: 'ageMax',
  level: 'level',
  goal: 'goal',
  durationMin: 'duration',
  equipment: 'equipment',
  instructions: 'instructions',
  mistakes: 'mistakes',
  progression: 'progression',
  regression: 'regression',
  safety: 'safety',
  video: 'video',
  source: 'source',
  author: 'author',
  rightsAttested: 'rightsAttested',
  noCommercialContent: 'noCommercialContent',
};

interface SkillChoice {
  slug: string;
  /** With an indent per tree level, for the select. */
  label: string;
  name: string;
}

/** The skills tree as a flat list in tree order; a child is indented under its track. */
function flattenSkills(nodes: readonly SkillOption[], locale: Locale, depth = 0): SkillChoice[] {
  return nodes.flatMap((node) => {
    const name = pickLocalized(node.name, locale) ?? node.slug;
    return [{ slug: node.slug, label: `${'– '.repeat(depth)}${name}`, name }, ...flattenSkills(node.children, locale, depth + 1)];
  });
}

const TYPE_LABELS: Readonly<Record<string, string>> = { 'video/mp4': 'MP4', 'video/webm': 'WEBM', 'video/quicktime': 'MOV' };
const typeLabel = (mime: string): string => TYPE_LABELS[mime] ?? mime.slice(mime.indexOf('/') + 1).toUpperCase();

/** The `/api/contributions/<id>` a 409's `instance` points at, when it is another contribution than this one. */
function duplicateOf(error: unknown, ownId: string): string | null {
  if (!isApiProblem(error) || error.kind !== 'conflict') return null;
  const match = /^\/api\/contributions\/([^/?#]+)$/.exec(error.problem?.instance ?? '');
  if (match === null) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return id === ownId ? null : id;
  } catch {
    return null;
  }
}

/** React Query clears `error` the moment a retry starts when there is no data yet; keep the last failure so Try again stays put. */
function useKeptFailure(query: { error: unknown; isFetching: boolean; errorUpdateCount: number }): unknown {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  return query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? last.current : null);
}

// --- the page ------------------------------------------------------------------------------------------------------------------------

const PAGE = 'mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5';
const H2 = 'm-0 text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-anywhere text-ink';
const LINK = 'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = clsx(LINK, 'border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px');
const LINK_SECONDARY = clsx(LINK, 'border-line bg-paper text-ink hover:bg-bg');

function Page({ children }: { children: ReactNode }) {
  const { t } = useTranslation('edit');
  return (
    <main className={PAGE}>
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink">{t('title')}</h1>
      <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
      {children}
    </main>
  );
}

function Loading() {
  const { t } = useTranslation('edit');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-32 rounded-card" />
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}

/** Shown for a moment while the visitor is sent to sign-in: says why, and is the fallback link. */
function NotAContributor({ returnPath }: { returnPath: string }) {
  const { t } = useTranslation('edit');
  return (
    <Card className="mt-8 grid gap-3">
      <h2 className={H2}>{t('signIn.title')}</h2>
      <p className="m-0 text-base text-ink">{t('signIn.hint')}</p>
      <p role="status" className="m-0 text-base text-muted">
        {t('signIn.redirecting')}
      </p>
      <Link to={'/account/sign-in' as never} search={{ redirect: returnPath } as never} className={clsx(LINK_PRIMARY, 'w-full sm:w-auto sm:self-start')}>
        {t('signIn.link')}
      </Link>
    </Card>
  );
}

/** A link to My contributions: the quiet one ("Back ...") beside a form, or the primary next step of an empty state ("My contributions"). */
function BackLink({ primary = false }: { primary?: boolean }) {
  const { t } = useTranslation('edit');
  return (
    <Link to={MINE_PATH as never} className={clsx(primary ? LINK_PRIMARY : LINK_SECONDARY, 'w-full sm:w-auto')}>
      {primary ? t('notFound.action') : t('back')}
    </Link>
  );
}

function EditPage() {
  const { id } = Route.useParams();
  // Keyed by the id, so moving to another contribution (same route, new param) starts from a clean screen.
  return <EditScreen key={id} id={id} />;
}

function EditScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation('edit');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const router = useRouter();
  const returnPath = `/contribute/${encodeURIComponent(id)}/edit`;

  const list = useQuery({
    queryKey: MINE_KEY,
    queryFn: ({ signal }) => api.get(ENDPOINTS.listMine.path, { schema: ENDPOINTS.listMine.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const metaQuery = useQuery({
    queryKey: ['contribute', 'meta', locale],
    queryFn: ({ signal }) => api.get(`${ENDPOINTS.getMeta.path}?locale=${locale}`, { schema: ContributionMeta, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const listFailure = useKeptFailure(list);
  const metaFailure = useKeptFailure(metaQuery);

  // An anonymous player (403) and a visitor with no session (401) are not contributors: sign in, then come back here.
  const notAContributor = isApiProblem(list.error) && (list.error.kind === 'forbidden' || list.error.kind === 'unauthorized');
  useEffect(() => {
    if (notAContributor) router.history.replace(signInUrl(returnPath));
  }, [notAContributor, router, returnPath]);

  const item = list.data?.find((entry) => entry.id === id);
  const meta = metaQuery.data;

  let body: ReactNode;
  if (notAContributor) {
    body = <NotAContributor returnPath={returnPath} />;
  } else if (list.data !== undefined) {
    if (item === undefined) {
      body = <EmptyState className="mt-8" title={t('notFound.title')} hint={t('notFound.hint')} action={<BackLink primary />} />;
    } else if (!isEditable(item.state)) {
      body = <ReadOnly item={item} meta={meta} locale={locale} />;
    } else if (meta !== undefined) {
      body =
        meta.skills.length === 0 ? (
          <EmptyState className="mt-8" title={t('options.empty.title')} hint={t('options.empty.hint')} action={<BackLink primary />} />
        ) : (
          <>
            <ItemHead item={item} />
            <EditForm key={item.id} item={item} meta={meta} locale={locale} />
          </>
        );
    } else if (metaFailure !== null) {
      body = (
        <ErrorState
          className="mt-8"
          title={t('options.error.title')}
          message={describeProblem(metaFailure, (key) => t(key)).formMessage}
          retryLabel={t('options.error.retry')}
          retrying={metaQuery.isFetching}
          onRetry={() => void metaQuery.refetch()}
        />
      );
    } else {
      body = <Loading />;
    }
  } else if (listFailure !== null) {
    body = (
      <ErrorState
        className="mt-8"
        title={t('error.title')}
        message={describeProblem(listFailure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={list.isFetching}
        onRetry={() => void list.refetch()}
      />
    );
  } else {
    body = <Loading />;
  }

  return <Page>{body}</Page>;
}

// --- the contribution's head: name, state, hint, the reviewer's note ---------------------------------------------------------------

function ItemHead({ item }: { item: Contribution }) {
  const { t } = useTranslation('edit');
  const { tone, Icon } = STATE_VIEW[item.state];
  return (
    <Card className="mt-8 grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h2 className={clsx(H2, 'min-w-0')}>{item.payload.name}</h2>
        <Tag tone={tone}>
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {t(`state.${item.state}`)}
        </Tag>
      </div>
      <p className="m-0 text-base text-ink">{t(`stateHint.${item.state}`)}</p>
      {item.reviewerNote ? (
        <div className="rounded-control border border-line bg-bg p-3.5">
          <p className="m-0 text-sm font-bold text-ink">{t('note.label')}</p>
          <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{item.reviewerNote}</p>
        </div>
      ) : null}
    </Card>
  );
}

function Files({ files }: { files: Contribution['attachments'] }) {
  const { t } = useTranslation('edit');
  const labelId = useId();
  if (files.length === 0) return null;
  return (
    <div className="grid gap-2">
      <p id={labelId} className="m-0 text-[13px] font-bold text-ink">
        {t('files.label')}
      </p>
      <ul aria-labelledby={labelId} className="m-0 grid list-none gap-2 p-0">
        {files.map((file) => (
          <li key={file.id}>
            <a href={file.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-tap items-center wrap-anywhere text-ink underline">
              {file.filename ?? t(`files.kind.${file.kind}`)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- read-only: approved, rejected, withdrawn ---------------------------------------------------------------------------------------

function ReadOnly({ item, meta, locale }: { item: Contribution; meta: ContributionMeta | undefined; locale: Locale }) {
  const { t } = useTranslation('edit');
  const { payload } = item;
  const skills = useMemo(() => (meta === undefined ? [] : flattenSkills(meta.skills, locale)), [meta, locale]);
  const sportName = meta?.sports.find((sport) => sport.slug === payload.sport);
  const rows: Array<[string, string]> = [
    [t('fields.name.label'), payload.name],
    [t('fields.sport.label'), sportName === undefined ? payload.sport : (pickLocalized(sportName.name, locale) ?? payload.sport)],
    [t('fields.skill.label'), skills.find((skill) => skill.slug === payload.skill)?.name ?? payload.skill],
    [t('fields.ageMin.label'), formatNumber(payload.ageMin, locale)],
    [t('fields.ageMax.label'), formatNumber(payload.ageMax, locale)],
    [t('fields.level.label'), t(`levels.${payload.level}`)],
    [t('fields.goal.label'), t(`goals.${payload.goal}`)],
    [t('fields.duration.label'), formatNumber(payload.durationMin, locale)],
    [t('fields.equipment.label'), t(`equipment.${payload.equipment}`)],
    [t('fields.instructions.label'), payload.instructions],
    ...(['mistakes', 'progression', 'regression', 'safety'] as const)
      .filter((key) => payload[key].trim() !== '')
      .map((key): [string, string] => [t(`fields.${key}.label`), payload[key]]),
    [t('fields.source.label'), payload.source],
    [t('fields.author.label'), payload.author],
  ];
  return (
    <>
      <ItemHead item={item} />
      <Card className="mt-5 grid gap-4">
        <h2 className={H2}>{t('readonly.heading')}</h2>
        <dl className="m-0 grid gap-4">
          {rows.map(([label, value]) => (
            <div key={label} className="grid min-w-0 gap-1">
              <dt className="text-[13px] font-bold text-muted">{label}</dt>
              <dd className="m-0 text-base wrap-anywhere whitespace-pre-line text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <Files files={item.attachments} />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {item.state === 'approved' && item.resultingDrillSlug !== undefined ? (
            <Link to="/commons/$slug" params={{ slug: item.resultingDrillSlug }} className={clsx(LINK_PRIMARY, 'w-full sm:w-auto')}>
              <ExternalLink aria-hidden className="size-5 shrink-0" />
              {t('readonly.drill')}
            </Link>
          ) : null}
          <BackLink />
        </div>
      </Card>
    </>
  );
}

// --- the form ------------------------------------------------------------------------------------------------------------------------

/** The values each choice field may hold, from the meta. */
interface Choices {
  sport: ReadonlySet<string>;
  skill: ReadonlySet<string>;
  level: ReadonlySet<string>;
  goal: ReadonlySet<string>;
  equipment: ReadonlySet<string>;
}

function choicesOf(meta: ContributionMeta, skills: readonly SkillChoice[]): Choices {
  return {
    sport: new Set(meta.sports.map((sport) => sport.slug)),
    skill: new Set(skills.map((skill) => skill.slug)),
    level: new Set<string>(meta.levels),
    goal: new Set<string>(GOALS),
    equipment: new Set<string>(meta.equipment),
  };
}

/** The stored payload as the form's strings. A choice the meta does not offer any more is left blank. */
function initialValues(stored: Contribution['payload'], choices: Choices): Values {
  const values: Values = {
    name: stored.name,
    sport: stored.sport,
    skill: stored.skill,
    ageMin: String(stored.ageMin),
    ageMax: String(stored.ageMax),
    level: stored.level,
    goal: stored.goal,
    duration: String(stored.durationMin),
    equipment: stored.equipment,
    instructions: stored.instructions,
    mistakes: stored.mistakes,
    progression: stored.progression,
    regression: stored.regression,
    safety: stored.safety,
    source: stored.source,
    author: stored.author,
  };
  for (const key of ['sport', 'skill', 'level', 'goal', 'equipment'] as const) if (!choices[key].has(values[key])) values[key] = '';
  return values;
}

type Status = 'idle' | 'sending' | 'done';

function EditForm({ item, meta, locale }: { item: Contribution; meta: ContributionMeta; locale: Locale }) {
  const { t } = useTranslation('edit');
  const router = useRouter();
  const queryClient = useQueryClient();
  const uid = useId();
  const idOf = (key: string): string => `${uid}-${key}`;
  const stored = item.payload;
  const skills = useMemo(() => flattenSkills(meta.skills, locale), [meta.skills, locale]);
  const choices = useMemo(() => choicesOf(meta, skills), [meta, skills]);

  const [values, setValues] = useState<Values>(() => initialValues(stored, choices));
  const [rights, setRights] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [website, setWebsite] = useState('');
  const [video, setVideo] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [attention, setAttention] = useState<{ n: number; target: FieldKey | 'form' }>({ n: 0, target: 'form' });
  // A second submit in the same tick (double tap, Enter plus click) must not send twice, before state has caught up.
  const sending = useRef(false);
  const messageBox = useRef<HTMLDivElement>(null);
  // Sending, and after the answer until the screen has left: the form is never editable in between.
  const busy = status !== 'idle';

  const allowedVideo = meta.upload.mimeTypes.filter((mime) => mime.toLowerCase().startsWith('video/'));
  const maxMb = formatNumber(meta.upload.maxMb, locale);

  // Move focus to the first problem after a failed submit (a disabled submit button drops the keyboard's place).
  useEffect(() => {
    if (attention.n === 0) return;
    const target = attention.target === 'form' ? messageBox.current : document.getElementById(idOf(attention.target));
    target?.focus();
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when a problem is raised, not on every render

  const shown = (key: 'sport' | 'skill' | 'level' | 'goal' | 'equipment'): string => (choices[key].has(values[key]) ? values[key] : '');

  function clearError(key: FieldKey) {
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  }

  function change(key: TextKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    clearError(key);
    setFormError(null);
    setDuplicate(null);
  }

  /** What is wrong with the answers, in the app's language; empty when they can be sent. */
  function check(): FieldErrors {
    const problems: FieldErrors = {};
    const need = (key: TextKey) => {
      if (values[key].trim() === '') problems[key] = t('validation.required');
    };
    need('name');
    need('instructions');
    need('source');
    need('author');
    for (const key of ['sport', 'skill', 'level', 'goal', 'equipment'] as const) if (!choices[key].has(values[key])) problems[key] = t('validation.choose');

    const whole = (raw: string): number | null => (/^\d+$/.test(raw.trim()) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
    const ageMin = whole(values.ageMin);
    const ageMax = whole(values.ageMax);
    if (values.ageMin.trim() === '') problems.ageMin = t('validation.required');
    else if (ageMin === null) problems.ageMin = t('validation.wholeNumber');
    if (values.ageMax.trim() === '') problems.ageMax = t('validation.required');
    else if (ageMax === null) problems.ageMax = t('validation.wholeNumber');
    else if (ageMin !== null && ageMax < ageMin) problems.ageMax = t('validation.ageOrder');

    const minutes = whole(values.duration);
    if (values.duration.trim() === '') problems.duration = t('validation.required');
    else if (minutes === null || minutes < 1) problems.duration = t('validation.duration');

    if (video !== null) {
      if (video.type !== '' && !allowedVideo.includes(video.type.toLowerCase())) problems.video = t('validation.videoType');
      else if (video.size > meta.upload.maxMb * BYTES_PER_MB) problems.video = t('validation.videoSize', { maxMb });
    }
    if (!rights) problems.rightsAttested = t('validation.rightsAttested');
    if (!commercial) problems.noCommercialContent = t('validation.noCommercialContent');
    return problems;
  }

  /** The contract payload from answers that passed check(). What this screen does not edit goes back as stored. */
  function payloadOf(): ContributionPayloadRequest {
    const trimmed = (key: TextKey) => values[key].trim();
    return {
      kind: stored.kind,
      ...(stored.targetDrillSlug !== undefined && { targetDrillSlug: stored.targetDrillSlug }),
      ...(stored.improvementKind !== undefined && { improvementKind: stored.improvementKind }),
      locale: stored.locale,
      name: trimmed('name'),
      sport: values.sport,
      skill: values.skill,
      ageMin: Number(values.ageMin),
      ageMax: Number(values.ageMax),
      level: meta.levels.find((level) => level === values.level)!,
      goal: GOALS.find((goal) => goal === values.goal)!,
      instructions: trimmed('instructions'),
      durationMin: Number(values.duration),
      equipment: meta.equipment.find((equipment) => equipment === values.equipment)!,
      mistakes: trimmed('mistakes'),
      progression: trimmed('progression'),
      regression: trimmed('regression'),
      safety: trimmed('safety'),
      source: trimmed('source'),
      ...(stored.sourceUrl !== undefined && { sourceUrl: stored.sourceUrl }),
      author: trimmed('author'),
      rightsAttested: true,
      noCommercialContent: true,
      // The honeypot as typed: empty for a person. The contract types it as "", a bot's text is the server's to refuse (422 /website).
      website: website as '',
    };
  }

  function reject(error: unknown) {
    sending.current = false;
    setStatus('idle');
    // 404 (gone) and a state 409 (decided meanwhile): what is on screen is stale. Read the list again; the screen follows the truth.
    const other = duplicateOf(error, item.id);
    if (isApiProblem(error) && (error.kind === 'not_found' || (error.kind === 'conflict' && other === null))) {
      void queryClient.invalidateQueries({ queryKey: MINE_KEY });
    }
    if (other !== null) {
      setErrors({});
      setFormError(null);
      setDuplicate(other);
      setAttention((a) => ({ n: a.n + 1, target: 'form' }));
      return;
    }

    const view = describeProblem(error, (key) => t(key));
    const flagged: FieldErrors = {};
    for (const path of Object.keys(view.fieldErrors)) {
      const key = POINTER_FIELDS[path];
      if (key !== undefined) flagged[key] = t('errors.fieldRejected');
    }
    // 413 and 415 are about the file, not about a pointer: the video field says which limit or which types.
    if (video !== null && view.kind === 'too_large') flagged.video = t('errors.videoTooLarge', { maxMb });
    else if (video !== null && view.status === 415) flagged.video = t('errors.videoType');

    const first = FIELD_ORDER.find((key) => flagged[key] !== undefined);
    setErrors(flagged);
    if (first !== undefined) {
      setFormError(null);
      setAttention((a) => ({ n: a.n + 1, target: first }));
      return;
    }
    // Nothing to highlight: "check the highlighted fields" would point at nothing, so a validation failure gets the generic line.
    setFormError(view.kind === 'validation' ? t('problem:unknown') : view.formMessage);
    setAttention((a) => ({ n: a.n + 1, target: 'form' }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const problems = check();
    setFormError(null);
    setDuplicate(null);
    setErrors(problems);
    const first = FIELD_ORDER.find((key) => problems[key] !== undefined);
    if (first !== undefined) {
      setAttention((a) => ({ n: a.n + 1, target: first }));
      return;
    }

    sending.current = true;
    setStatus('sending');
    const body = new FormData();
    body.append('payload', JSON.stringify(payloadOf()));
    if (video !== null) body.append('video', video, video.name);
    let updated: Contribution;
    try {
      // The screen's own language goes in Accept-Language (the app-wide client reads the global one; both are the same in the app).
      const client = createApi({ language: () => locale });
      updated = await client.put(ENDPOINTS.updateContribution.path.replace(':id', encodeURIComponent(item.id)), { body, schema: Contribution });
    } catch (error) {
      reject(error);
      return;
    }
    // The mutation returns the updated resource: put it in the list instead of asking for the list again.
    queryClient.setQueryData<Contribution[]>(MINE_KEY, (old) => old?.map((entry) => (entry.id === updated.id ? updated : entry)));
    setStatus('done'); // `sending` stays set: the form is finished
    router.history.replace(MINE_PATH);
  }

  const summary = Object.keys(errors).length > 0;
  const options = <T extends string>(list: readonly T[], label: (value: T) => string) =>
    list.map((value) => (
      <option key={value} value={value}>
        {label(value)}
      </option>
    ));
  const optional = (label: string): ReactNode => (
    <>
      {label} <span className="font-normal text-muted">{t('optional')}</span>
    </>
  );

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="mt-5">
      <div aria-busy={busy || undefined} className="grid min-w-0 gap-5">
        <Notice>{t('notice.resubmit')}</Notice>
        {summary ? <Notice tone="warn">{t('validation.checkFields')}</Notice> : null}

        <Card role="group" aria-labelledby={idOf('about')} className="grid gap-4">
          <h2 id={idOf('about')} className={H2}>
            {t('sections.about')}
          </h2>
          <Field id={idOf('name')} label={t('fields.name.label')} hint={t('fields.name.hint')} error={errors.name}>
            {(c) => <input {...c} disabled={busy} type="text" autoComplete="off" value={values.name} onChange={(e) => change('name', e.target.value)} />}
          </Field>
          <Field id={idOf('sport')} label={t('fields.sport.label')} error={errors.sport}>
            {(c) => (
              <select {...c} disabled={busy} value={shown('sport')} onChange={(e) => change('sport', e.target.value)}>
                <option value="">{t('choose')}</option>
                {meta.sports.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {pickLocalized(entry.name, locale) ?? entry.slug}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id={idOf('skill')} label={t('fields.skill.label')} hint={t('fields.skill.hint')} error={errors.skill}>
            {(c) => (
              <select {...c} disabled={busy} value={shown('skill')} onChange={(e) => change('skill', e.target.value)}>
                <option value="">{t('choose')}</option>
                {skills.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
            <Field id={idOf('ageMin')} label={t('fields.ageMin.label')} error={errors.ageMin}>
              {(c) => (
                <input {...c} disabled={busy} type="text" inputMode="numeric" autoComplete="off" value={values.ageMin} onChange={(e) => change('ageMin', e.target.value)} />
              )}
            </Field>
            <Field id={idOf('ageMax')} label={t('fields.ageMax.label')} error={errors.ageMax}>
              {(c) => (
                <input {...c} disabled={busy} type="text" inputMode="numeric" autoComplete="off" value={values.ageMax} onChange={(e) => change('ageMax', e.target.value)} />
              )}
            </Field>
          </div>
          <Field id={idOf('level')} label={t('fields.level.label')} error={errors.level}>
            {(c) => (
              <select {...c} disabled={busy} value={shown('level')} onChange={(e) => change('level', e.target.value)}>
                <option value="">{t('choose')}</option>
                {options(meta.levels, (level) => t(`levels.${level}`))}
              </select>
            )}
          </Field>
          <Field id={idOf('goal')} label={t('fields.goal.label')} hint={t('fields.goal.hint')} error={errors.goal}>
            {(c) => (
              <select {...c} disabled={busy} value={shown('goal')} onChange={(e) => change('goal', e.target.value)}>
                <option value="">{t('choose')}</option>
                {options(GOALS, (goal) => t(`goals.${goal}`))}
              </select>
            )}
          </Field>
          <Field id={idOf('duration')} label={t('fields.duration.label')} error={errors.duration}>
            {(c) => (
              <input {...c} disabled={busy} type="text" inputMode="numeric" autoComplete="off" value={values.duration} onChange={(e) => change('duration', e.target.value)} />
            )}
          </Field>
          <Field id={idOf('equipment')} label={t('fields.equipment.label')} hint={t('fields.equipment.hint')} error={errors.equipment}>
            {(c) => (
              <select {...c} disabled={busy} value={shown('equipment')} onChange={(e) => change('equipment', e.target.value)}>
                <option value="">{t('choose')}</option>
                {options(meta.equipment, (equipment) => t(`equipment.${equipment}`))}
              </select>
            )}
          </Field>
        </Card>

        <Card role="group" aria-labelledby={idOf('how')} className="grid gap-4">
          <h2 id={idOf('how')} className={H2}>
            {t('sections.how')}
          </h2>
          <Field id={idOf('instructions')} label={t('fields.instructions.label')} hint={t('fields.instructions.hint')} error={errors.instructions}>
            {(c) => <textarea {...c} disabled={busy} rows={6} value={values.instructions} onChange={(e) => change('instructions', e.target.value)} />}
          </Field>
          {(['mistakes', 'progression', 'regression', 'safety'] as const).map((key) => (
            <Field key={key} id={idOf(key)} label={optional(t(`fields.${key}.label`))} hint={t(`fields.${key}.hint`)} error={errors[key]}>
              {(c) => <textarea {...c} disabled={busy} rows={3} value={values[key]} onChange={(e) => change(key, e.target.value)} />}
            </Field>
          ))}
        </Card>

        <Card role="group" aria-labelledby={idOf('media')} className="grid gap-4">
          <h2 id={idOf('media')} className={H2}>
            {t('sections.media')}
          </h2>
          <Files files={item.attachments} />
          {item.attachments.length > 0 ? <p className="m-0 text-[13px] text-muted">{t('files.replaceHint')}</p> : null}
          {allowedVideo.length > 0 ? (
            <Field
              id={idOf('video')}
              label={optional(t('fields.video.label'))}
              hint={t('fields.video.hint', { maxMb, types: allowedVideo.map(typeLabel).join(', ') })}
              error={errors.video}
            >
              {(c) => (
                <input
                  {...c}
                  disabled={busy}
                  type="file"
                  accept={allowedVideo.join(',')}
                  onChange={(e) => {
                    setVideo(e.target.files?.[0] ?? null);
                    clearError('video');
                    setFormError(null);
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field id={idOf('source')} label={t('fields.source.label')} hint={t('fields.source.hint')} error={errors.source}>
            {(c) => <input {...c} disabled={busy} type="text" autoComplete="off" value={values.source} onChange={(e) => change('source', e.target.value)} />}
          </Field>
          <Field id={idOf('author')} label={t('fields.author.label')} hint={t('fields.author.hint')} error={errors.author}>
            {(c) => <input {...c} disabled={busy} type="text" autoComplete="name" value={values.author} onChange={(e) => change('author', e.target.value)} />}
          </Field>
        </Card>

        <Card role="group" aria-labelledby={idOf('send')} className="grid gap-4">
          <h2 id={idOf('send')} className={H2}>
            {t('sections.send')}
          </h2>
          <Attestation
            id={idOf('rightsAttested')}
            checked={rights}
            disabled={busy}
            label={t('attest.rights')}
            error={errors.rightsAttested}
            onChange={(next) => {
              setRights(next);
              clearError('rightsAttested');
            }}
          />
          <Attestation
            id={idOf('noCommercialContent')}
            checked={commercial}
            disabled={busy}
            label={t('attest.noCommercial')}
            error={errors.noCommercialContent}
            onChange={(next) => {
              setCommercial(next);
              clearError('noCommercialContent');
            }}
          />
          {/* The honeypot: invisible and unreachable for a person (off-screen, out of the tab order, hidden from assistive tech). */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}>
            <label>
              {t('fields.website.label')}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
          </div>

          {formError !== null ? (
            <Notice ref={messageBox} tone="warn" tabIndex={-1}>
              {formError}
            </Notice>
          ) : null}
          {duplicate !== null ? (
            <Notice ref={messageBox} tone="warn" tabIndex={-1}>
              <p className="m-0">{t('errors.duplicate')}</p>
              <Link to="/contribute/$id/edit" params={{ id: duplicate }} className="mt-2 inline-flex min-h-tap items-center font-bold text-ink underline">
                {t('errors.duplicateLink')}
              </Link>
            </Notice>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button type="submit" loading={busy} className="w-full sm:w-auto">
              {busy ? t('submit.busy') : t('submit.label')}
            </Button>
            <BackLink />
          </div>
          {busy ? (
            <p role="status" className="m-0 text-base text-ink">
              {video === null ? t('saving') : t('savingVideo')}
            </p>
          ) : null}
        </Card>
      </div>
    </form>
  );
}

function Attestation({
  id,
  checked,
  label,
  error,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  error?: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* Selected = green border and mint fill AND the native tick: colour is never the only signal (DESIGN.md Options). */}
      <label
        htmlFor={id}
        className="flex min-h-tap cursor-pointer items-start gap-3 rounded-control border border-line bg-paper p-3.5 has-checked:border-accent has-checked:bg-accent-2"
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-6 shrink-0 accent-ink"
        />
        <span className="min-w-0 wrap-anywhere">{label}</span>
      </label>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="flex items-start gap-2 font-bold text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
    </div>
  );
}

export const Route = createFileRoute('/contribute/$id/edit')({ component: EditPage });
