import { Contribution, ContributionMeta, type ContributionPayloadRequest, ENDPOINTS, type SkillOption } from '@api-types/contributions';
import { GOALS, type Locale, pickLocalized } from '@api-types/primitives';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { Check, CircleAlert } from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { type DraftStorage, registerDraft, signInUrl, takeDraft } from '../../features/account/session-expired';
import { api, createApi, type FetchLike } from '../../lib/api';
import { useSession } from '../../lib/auth';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';

/**
 * /contribute: CONTRIBUTE A METHOD (spec section 17). An Operate-mode screen: one calm column, a form in four cards, one primary
 * action. Every string is in features/contribute/form.messages.ts (namespace `form`).
 *
 * Who sees it. Only a contributor: a signed-in, NON-anonymous account (the API's requireContributor says the same and answers
 * 401/403 to anyone else; this check is UX, not security). Every visitor has a silent anonymous player session (lib/auth.ts), so
 * "has a session" is not "is a contributor": only `user.isAnonymous === false` is. A loading, unreadable or user-less session is
 * never a contributor either. Everyone else is sent to /account/sign-in?redirect=/contribute (router.history.replace) and is shown
 * nothing of the form, so a broken form is never on screen.
 *
 * What it does.
 *  - GET /api/contribute/meta?locale (one call, React Query, typed by the contract) gives every option list and the upload limit.
 *  - Submit validates in the app's language (the form is noValidate), flags every bad field, focuses the first one and sends
 *    NOTHING while anything is bad (including the two attestations).
 *  - Then ONE multipart POST /api/contributions: a `payload` part (the contract's ContributionPayloadRequest as JSON) and, when a
 *    video was chosen, a `video` part. Upload progress needs XMLHttpRequest (fetch has none), so the request goes through the typed
 *    client with an injectable `fetch` that is backed by an XHR (`xhrFetch`): schema parsing, ApiProblem mapping and Accept-Language
 *    stay in lib/api.ts, and 401 still reaches the session-expired handler.
 *  - Success: the thank-you state, the sentence from the spec, a link to My contributions. Failure: RFC 6901 pointers in the 422
 *    land on their fields (flagged, with a localised sentence: the server's English is never shown); a pointer that names no field
 *    (or the honeypot) is a form-level message; 413/415 land on the video field; anything else is a form-level message. The answers
 *    are kept and the form is editable again.
 *  - Drafts: every change is saved to sessionStorage as `fc:draft:contribute-form` = { savedAt, value } (the format of
 *    features/account/session-expired.ts, so sign-out clears it, it expires after 30 minutes, and the 401 handler saves the same
 *    thing through registerDraft). Mount takes it back (takeDraft). The attestations, the honeypot and the video file are never in
 *    a draft: the person attests again, every time.
 *
 * Readings of the criteria where they are open (each pinned by form.test.tsx)
 *  - "video upload": one `video` part. The contract also has up to 3 `files` (photos, PDF); they are not in the criteria's field list.
 *    The allowed types are the meta's video/* types (the server requires the `video` part to be a video); a file with no type at all
 *    (some browsers do not know .mov) is left to the server, which sniffs the bytes.
 *  - "empty": the meta has no skill, so nothing can be chosen and nothing can be sent. (The contract's `sports` has min(1).)
 *  - Any skill node, track or leaf, can be chosen; the tree is shown flat with children indented. The meta does not tie a skill to a
 *    sport, so the skill list is not filtered by the sport (contract gap).
 *  - `sourceUrl`, `kind: improvement` and `targetDrillSlug` are the suggest-improvement dialog's; this form always sends kind "new".
 *  - The honeypot is sent as typed (empty for a person); a bot that fills it is refused by the server (422 /website).
 *  - Only `Route`, the test seam `ContributeDepsContext` and the `XhrLike` type are exported (a route file's other exports end up in
 *    the entry chunk, see routes/train/onboarding.tsx).
 */

// --- the seams ----------------------------------------------------------------------------------------------------------

/** The part of an XMLHttpRequest the upload uses; the real one is assignable to it. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
  getResponseHeader(name: string): string | null;
  withCredentials: boolean;
  readonly status: number;
  readonly responseText: string;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
}

/** The part of Better Auth's `useSession()` result that the screen reads; the real result is assignable to it. */
export interface ContributeSession {
  /** Validated here, not trusted. */
  data?: unknown;
  isPending: boolean;
  /** Better Auth keeps the PREVIOUS data while it re-reads the session; that may be another person, so it is never acted on. */
  isRefetching?: boolean;
  error?: unknown;
  refetch: () => unknown;
}

export interface ContributeDeps {
  /** Default: the real session hook. */
  session: ContributeSession;
  /** Default: `new XMLHttpRequest()`. */
  createXhr: () => XhrLike;
  /** Default: `router.history.replace`. */
  navigate: (to: string) => void;
  /** Default (absent): sessionStorage, looked up when used. `null`: nothing is saved or read. */
  storage?: DraftStorage | null;
  /** Default: `Date.now`. */
  now: () => number;
}

/** Test seam: whatever is set replaces the real dependency. */
export const ContributeDepsContext = createContext<Partial<ContributeDeps>>({});

// --- constants and small helpers ---------------------------------------------------------------------------------------------

const CONTRIBUTE_PATH = '/contribute';
const MINE_PATH = '/contribute/mine';
const DRAFT_NAME = 'contribute-form';
// features/account/session-expired.ts keeps drafts under `fc:draft:<name>` and clears exactly that prefix on sign-out. The prefix is
// not exported, so it is repeated here to save a draft on every change (that module saves only when a 401 hits).
const DRAFT_STORAGE_KEY = `fc:draft:${DRAFT_NAME}`;
const BYTES_PER_MB = 1024 * 1024;
/**
 * How long the meta counts as fresh. It is static reference data (sports, the skill tree, upload limits) that only changes with a
 * release, so it is read once per visit (fc-mol-70i.14). React Query's default (stale at once) made the form fetch it again whenever
 * it remounted, e.g. after the session re-read that hides the form (Gate), and on reconnect: the j5 gate saw 3 non-auth /api calls
 * against a budget of 2. The client keeps the query for 14 days (bootstrap.ts), so this is what decides. Sign-out clears the whole
 * client, and the language is in the key, so a fresh visit or another language still reads its own.
 */
const META_STALE_MS = 30 * 60 * 1000;

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

const EMPTY_VALUES: Values = {
  name: '',
  sport: '',
  skill: '',
  ageMin: '',
  ageMax: '',
  level: '',
  goal: '',
  duration: '',
  equipment: '',
  instructions: '',
  mistakes: '',
  progression: '',
  regression: '',
  safety: '',
  source: '',
  author: '',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBlank = (values: Values): boolean => TEXT_KEYS.every((key) => values[key] === '');

interface SkillChoice {
  slug: string;
  label: string;
}

/** The skills tree as a flat list in tree order; a child is indented under its track. */
function flattenSkills(nodes: readonly SkillOption[], locale: Locale, depth = 0): SkillChoice[] {
  return nodes.flatMap((node) => [
    { slug: node.slug, label: `${'– '.repeat(depth)}${pickLocalized(node.name, locale) ?? node.slug}` },
    ...flattenSkills(node.children, locale, depth + 1),
  ]);
}

const TYPE_LABELS: Readonly<Record<string, string>> = { 'video/mp4': 'MP4', 'video/webm': 'WEBM', 'video/quicktime': 'MOV' };
const typeLabel = (mime: string): string => TYPE_LABELS[mime] ?? mime.slice(mime.indexOf('/') + 1).toUpperCase();

// --- the session ----------------------------------------------------------------------------------------------------------------

type Access = 'loading' | 'error' | 'signed-out' | 'contributor';

/** Fails closed: only an explicit `isAnonymous === false` on a readable session is a contributor (the API's rule too). */
function resolveAccess(session: ContributeSession): Access {
  // Loading in EVERY branch, before the data or the error is looked at: a refetch keeps the previous session's data.
  if (session.isPending || session.isRefetching) return 'loading';
  if (session.error !== null && session.error !== undefined) return 'error';
  const { data } = session;
  if (data === null || data === undefined) return 'signed-out';
  if (!isRecord(data) || !isRecord(data.user)) return 'error';
  return data.user.isAnonymous === false ? 'contributor' : 'signed-out';
}

// --- drafts ----------------------------------------------------------------------------------------------------------------------

function storageOf(storage: DraftStorage | null | undefined): DraftStorage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.sessionStorage ?? null; // access itself can throw (blocked storage)
  } catch {
    return null;
  }
}

function writeDraft(storage: DraftStorage | null, values: Values, now: () => number): void {
  if (storage === null) return;
  try {
    if (isBlank(values)) storage.removeItem(DRAFT_STORAGE_KEY);
    else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ savedAt: now(), value: values }));
  } catch {
    // a full or blocked storage only means no draft
  }
}

function dropDraft(storage: DraftStorage | null): void {
  try {
    storage?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // nothing to keep either way
  }
}

/** A stored draft is `unknown`: only known keys with string values are taken, and a choice the meta does not offer is dropped. */
function readDraft(raw: unknown, choices: Choices): Values | null {
  if (!isRecord(raw)) return null;
  const values: Values = { ...EMPTY_VALUES };
  for (const key of TEXT_KEYS) {
    const value = raw[key];
    if (typeof value === 'string') values[key] = value;
  }
  for (const key of ['sport', 'skill', 'level', 'goal', 'equipment'] as const) {
    if (values[key] !== '' && !choices[key].has(values[key])) values[key] = '';
  }
  return isBlank(values) ? null : values;
}

// --- the upload ---------------------------------------------------------------------------------------------------------------------

/**
 * A `fetch` backed by an XMLHttpRequest, so the typed client can report upload progress (fetch has none). It does what api.ts's
 * contract needs of a fetch: a network failure REJECTS (a TypeError, which the client turns into an offline/network problem), an
 * answer of any status RESOLVES with a Response, and the caller's abort signal aborts the request.
 */
function xhrFetch(createXhr: () => XhrLike, onProgress: (percent: number | null) => void): FetchLike {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const xhr = createXhr();
      xhr.open(init?.method ?? 'GET', input);
      // The client sets Accept and Accept-Language, and NO Content-Type for a FormData body: the browser writes the boundary.
      new Headers(init?.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
      xhr.withCredentials = init?.credentials === 'include';
      xhr.upload.onprogress = (event) =>
        onProgress(event.lengthComputable && event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : null);
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status > 599) {
          reject(new TypeError('Network request failed'));
          return;
        }
        const type = xhr.getResponseHeader('content-type');
        resolve(
          new Response(xhr.responseText === '' ? null : xhr.responseText, {
            status: xhr.status,
            headers: type === null ? undefined : { 'content-type': type },
          }),
        );
      };
      xhr.onerror = () => reject(new TypeError('Network request failed'));
      xhr.ontimeout = () => reject(new TypeError('Network request timed out'));
      xhr.onabort = () => reject(new DOMException('The upload was aborted', 'AbortError'));
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('The upload was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(init?.body as FormData);
    });
}

// --- the page ------------------------------------------------------------------------------------------------------------------------

const PAGE = 'mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5';
const H2 = 'm-0 text-xl leading-[1.2] font-bold tracking-[-.025em] text-ink';
const LINK_PRIMARY =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border border-ink bg-ink px-4.5 py-2.5 text-center font-bold wrap-anywhere text-white';

function Page({ children }: { children: ReactNode }) {
  const { t } = useTranslation('form');
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
  const { t } = useTranslation('form');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-64 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

function SignedOut({ navigate }: { navigate: (to: string) => void }) {
  const { t } = useTranslation('form');
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    navigate(signInUrl(CONTRIBUTE_PATH));
  }, [navigate]);
  return (
    <div role="status" aria-busy="true" className="mt-8 grid gap-4">
      <p className="m-0 text-lg font-bold text-ink">{t('gate.redirecting')}</p>
      <Skeleton className="h-11 w-full max-w-64" />
    </div>
  );
}

/** Decides what a person SEES; the API's requireContributor is the real gate. */
function Gate({ session, deps }: { session: ContributeSession; deps: Omit<ContributeDeps, 'session'> }) {
  const { t } = useTranslation('form');
  const access = resolveAccess(session);
  let body: ReactNode;
  switch (access) {
    case 'contributor':
      body = <ContributeScreen deps={deps} />;
      break;
    case 'signed-out':
      body = <SignedOut navigate={deps.navigate} />;
      break;
    case 'error':
      body = (
        <ErrorState
          className="mt-8"
          title={t('gate.error.title')}
          message={t('gate.error.message')}
          retryLabel={t('gate.error.retry')}
          onRetry={() => void session.refetch()}
        />
      );
      break;
    case 'loading':
      body = <Loading />;
      break;
    default: {
      // Exhaustive: a new Access value must be handled above. Anything unhandled at runtime shows nothing of the form.
      const unhandled: never = access;
      body = unhandled;
    }
  }
  return <Page>{body}</Page>;
}

function ContributeScreen({ deps }: { deps: Omit<ContributeDeps, 'session'> }) {
  const { t, i18n } = useTranslation('form');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const query = useQuery({
    queryKey: ['contribute', 'meta', locale],
    queryFn: ({ signal }) => api.get(`${ENDPOINTS.getMeta.path}?locale=${locale}`, { schema: ContributionMeta, signal }),
    retry: false,
    staleTime: META_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // React Query clears `error` the moment a retry starts when there is no data yet. Keep the last failure on screen so Try again
  // stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  if (query.data !== undefined) {
    if (query.data.skills.length === 0) {
      return <EmptyState className="mt-8" title={t('load.empty.title')} hint={t('load.empty.hint')} />;
    }
    return <ContributeForm meta={query.data} locale={locale} deps={deps} />;
  }
  if (failure !== null) {
    return (
      <ErrorState
        className="mt-8"
        title={t('load.error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('load.error.retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <Loading />;
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

type Status = 'idle' | 'sending' | 'done';

function ContributeForm({ meta, locale, deps }: { meta: ContributionMeta; locale: Locale; deps: Omit<ContributeDeps, 'session'> }) {
  // A new key remounts the form: "Add another method" starts from nothing (and resets the file input, which cannot be controlled).
  const [round, setRound] = useState(0);
  return <FormRound key={round} meta={meta} locale={locale} deps={deps} again={() => setRound((n) => n + 1)} />;
}

function FormRound({
  meta,
  locale,
  deps,
  again,
}: {
  meta: ContributionMeta;
  locale: Locale;
  deps: Omit<ContributeDeps, 'session'>;
  again: () => void;
}) {
  const { t } = useTranslation('form');
  const uid = useId();
  const idOf = (key: string): string => `${uid}-${key}`;
  const storage = storageOf(deps.storage);
  const skills = useMemo(() => flattenSkills(meta.skills, locale), [meta.skills, locale]);
  const choices = useMemo(() => choicesOf(meta, skills), [meta, skills]);
  const onlySport = meta.sports.length === 1 ? meta.sports[0]!.slug : '';

  // The draft is taken ONCE, when the form first shows. It is written straight back, so a second run of this initializer (React
  // may run one twice while developing) still finds it.
  const [initial] = useState(() => {
    const taken = readDraft(takeDraft(DRAFT_NAME, storage, deps.now), choices);
    if (taken !== null) writeDraft(storage, taken, deps.now);
    return taken;
  });
  const [values, setValues] = useState<Values>(initial ?? EMPTY_VALUES);
  const [restored] = useState(initial !== null);
  const [rights, setRights] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [website, setWebsite] = useState('');
  const [video, setVideo] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [percent, setPercent] = useState<number | null>(0);
  const [attention, setAttention] = useState<{ n: number; target: FieldKey | 'form' }>({ n: 0, target: 'form' });
  // A second submit in the same tick (double tap, Enter plus click) must not send twice, before state has caught up.
  const sending = useRef(false);
  const formErrorBox = useRef<HTMLDivElement>(null);
  const busy = status === 'sending';

  const allowedVideo = meta.upload.mimeTypes.filter((mime) => mime.toLowerCase().startsWith('video/'));
  const maxMb = formatNumber(meta.upload.maxMb, locale);

  // Save the draft on every change; a blank form keeps none. A sent form keeps none either.
  useEffect(() => {
    if (status !== 'done') writeDraft(storage, values, deps.now);
  }, [values, status, storage, deps.now]);

  // The 401 handler (features/account/session-expired.ts) asks every registered draft for its value when the session expires.
  const latest = useRef({ values, status });
  latest.current = { values, status };
  useEffect(
    () => registerDraft(DRAFT_NAME, () => (latest.current.status === 'done' || isBlank(latest.current.values) ? undefined : latest.current.values)),
    [],
  );

  // Move focus to the first problem after a failed submit (a disabled submit button drops the keyboard's place).
  useEffect(() => {
    if (attention.n === 0) return;
    const target = attention.target === 'form' ? formErrorBox.current : document.getElementById(idOf(attention.target));
    target?.focus();
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when a problem is raised, not on every render

  const sport = values.sport || onlySport;
  const shown = (key: 'sport' | 'skill' | 'level' | 'goal' | 'equipment'): string => {
    const value = key === 'sport' ? sport : values[key];
    return choices[key].has(value) ? value : '';
  };

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
    if (!choices.sport.has(sport)) problems.sport = t('validation.choose');
    for (const key of ['skill', 'level', 'goal', 'equipment'] as const) if (!choices[key].has(values[key])) problems[key] = t('validation.choose');

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

  /** The contract payload from answers that passed check(). */
  function payloadOf(): ContributionPayloadRequest {
    const trimmed = (key: TextKey) => values[key].trim();
    return {
      kind: 'new',
      locale,
      name: trimmed('name'),
      sport,
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
    setPercent(0);
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
    if (first !== undefined) {
      setErrors(flagged);
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
    setErrors(problems);
    const first = FIELD_ORDER.find((key) => problems[key] !== undefined);
    if (first !== undefined) {
      setAttention((a) => ({ n: a.n + 1, target: first }));
      return;
    }

    sending.current = true;
    setStatus('sending');
    setPercent(0);
    const body = new FormData();
    body.append('payload', JSON.stringify(payloadOf()));
    if (video !== null) body.append('video', video, video.name);
    try {
      const client = createApi({ fetch: xhrFetch(deps.createXhr, setPercent), language: () => locale });
      await client.post(ENDPOINTS.createContribution.path, { body, schema: Contribution });
    } catch (error) {
      reject(error);
      return;
    }
    dropDraft(storage);
    setStatus('done'); // `sending` stays set: the form is finished
  }

  if (status === 'done') return <ThankYou again={again} />;

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
    <form noValidate onSubmit={(event) => void submit(event)} className="mt-8">
      <div aria-busy={busy || undefined} className="grid min-w-0 gap-5">
        <Notice>{t('notice.review')}</Notice>
        {restored ? <Notice>{t('restored')}</Notice> : null}
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
          {allowedVideo.length > 0 ? (
            <Field
              id={idOf('video')}
              label={optional(t('fields.video.label'))}
              hint={t('fields.video.hint', { maxMb, types: allowedVideo.map(typeLabel).join(', ') })}
              error={errors.video}
            >
              {(c) => (
                <input
                  {...c} disabled={busy}
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
            <Notice ref={formErrorBox} tone="warn" tabIndex={-1}>
              {formError}
            </Notice>
          ) : null}
          <Button type="submit" loading={busy} className="w-full sm:w-auto sm:self-start">
            {busy ? t('submit.busy') : t('submit.label')}
          </Button>
          {busy ? <Progress percent={percent} locale={locale} /> : null}
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

/** DESIGN.md Progress: a 10px pill track, a Field Green fill, and the number beside it in words. */
function Progress({ percent, locale }: { percent: number | null; locale: Locale }) {
  const { t } = useTranslation('form');
  const known = percent !== null;
  return (
    <div className="grid gap-2">
      <div
        role="progressbar"
        aria-label={t('progress.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        className="h-2.5 w-full overflow-hidden rounded-pill bg-line"
      >
        <div
          className={known ? 'h-full rounded-pill bg-accent motion-safe:transition-[width]' : 'h-full w-full rounded-pill bg-accent motion-safe:animate-pulse'}
          style={known ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p className="m-0 text-base text-ink">
        {!known ? t('submit.busy') : percent >= 100 ? t('progress.saving') : t('progress.sending', { percent: formatNumber(percent, locale) })}
      </p>
    </div>
  );
}

function ThankYou({ again }: { again: () => void }) {
  const { t } = useTranslation('form');
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <Card elevated role="region" aria-labelledby={headingId} className="mt-8 grid gap-4">
      <p className="m-0">
        <Tag tone="accent">
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
          {t('success.state')}
        </Tag>
      </p>
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-[clamp(28px,4vw,40px)] leading-[1.1] font-bold tracking-[-.025em] text-ink"
      >
        {t('success.title')}
      </h2>
      <p className="m-0 text-lg leading-[1.45] text-ink">{t('success.sentence')}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link to={MINE_PATH as never} className={LINK_PRIMARY}>
          {t('success.mine')}
        </Link>
        <Button variant="secondary" onClick={again}>
          {t('success.another')}
        </Button>
      </div>
    </Card>
  );
}

// --- the route ------------------------------------------------------------------------------------------------------------------------

function ContributeRoute() {
  const router = useRouter({ warn: false });
  const injected = useContext(ContributeDepsContext);
  const deps: Omit<ContributeDeps, 'session'> = {
    // The real XMLHttpRequest has every member of XhrLike; its onprogress just takes the fuller ProgressEvent.
    createXhr: injected.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike),
    navigate: injected.navigate ?? ((to) => router?.history.replace(to)),
    storage: injected.storage,
    now: injected.now ?? Date.now,
  };
  return injected.session === undefined ? <WithRealSession deps={deps} /> : <Gate session={injected.session} deps={deps} />;
}

/** The real session hook, in its own component so a test that injects a session never calls it. */
function WithRealSession({ deps }: { deps: Omit<ContributeDeps, 'session'> }) {
  return <Gate session={useSession()} deps={deps} />;
}

export const Route = createFileRoute('/contribute/')({ component: ContributeRoute });
