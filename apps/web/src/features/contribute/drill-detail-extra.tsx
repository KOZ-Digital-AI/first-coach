import * as Dialog from '@radix-ui/react-dialog';
import type { DrillDetail } from '@api-types/commons';
import { ENDPOINTS as COMMONS_ENDPOINTS } from '@api-types/commons-api';
import { Contribution, type ContributionMeta, type ContributionPayloadRequest, ENDPOINTS, type ImprovementKind } from '@api-types/contributions';
import { GOALS, type Locale, pickLocalized } from '@api-types/primitives';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Check, CircleAlert, Send } from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { useSession } from '../../lib/auth';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';
import { signInUrl } from '../account/session-expired';

/**
 * "Suggest improvement" on every drill detail page (fc-mol-70i.11). A component of the `drill-detail` slot
 * (lib/slots.ts): routes/commons/$slug.tsx renders it, with no props, below the drill; it reads the drill's slug from the route
 * itself. Only the DEFAULT export is the slot component; the named exports (the test seam and its types) are ignored by the slot.
 * Every string is in features/contribute/suggest.messages.ts (namespace `suggest`).
 *
 * What it does.
 *  - A small card with a button. Nothing is requested until the button opens the dialog.
 *  - Who may suggest: only a contributor, a signed-in NON-anonymous account (the API's requireContributor says the same and
 *    answers 401/403 to anyone else; this check is UX, not security). Every visitor has a silent anonymous player session
 *    (lib/auth.ts), so "has a session" is not "is a contributor": only `user.isAnonymous === false` on a readable session is.
 *    Everyone else who presses the button goes to /account/sign-in?redirect=/commons/<slug> and lands on the same drill after
 *    signing in; the card says beforehand that players never need an account. While the session is read (or re-read: Better
 *    Auth keeps the PREVIOUS data meanwhile, which may be another person) the button is busy and disabled; an unreadable
 *    session says so and offers Try again, and never opens the form.
 *  - The dialog (Radix, like /contribute/mine) reads GET /api/contribute/meta?locale (the improvement kinds and the upload
 *    limits) and the drill (GET /api/commons/drills/:slug, the SAME React Query entry the drill page fills, so it is normally
 *    already cached). It asks for the kind, the proposed text, an optional video, the author (the account's name to start with)
 *    and the two attestations, checks them in the app's language (the form is noValidate; nothing is sent while anything is
 *    wrong, the first problem is focused) and sends ONE multipart POST /api/contributions: a `payload` part
 *    (ContributionPayloadRequest as JSON, kind "improvement" with targetDrillSlug) and, when chosen, a `video` part.
 *  - States. loading = a named busy status until both reads have arrived; empty = nothing can be suggested (the meta lists no
 *    improvement kind, skill or level); error = ErrorState with a Try again that is natively disabled and busy while it runs;
 *    disabled = every control, Cancel, Escape and the overlay are locked while the request is in flight, and it is sent once
 *    however hard Send is pressed; success = a thank-you with a link to My contributions. A failure keeps everything typed.
 *  - Failures. RFC 6901 pointers in a 422 land on their control with a written sentence (the server's English is never shown);
 *    a pointer with no control (the drill, the honeypot) is a form-level message; 409 (the caller already has the same
 *    undecided contribution; `instance` is its API URL, the page that lists it is My contributions) is said in words with that
 *    link; 413 and 415 land on the video field; anything else is the app's generic localised message.
 *
 * Readings of the criteria where they are open (each pinned by suggest.test.tsx)
 *  - The contract requires payload fields the dialog does not ask for. What the app knows is used: the drill gives the name
 *    (its title, else its slug written as words), the age range (open ends are 0 and 99, the seeded "no limit"), the equipment
 *    and the duration (a timed dose rounds up to whole minutes, any other dose is 1). CONTRACT GAP: no read of a drill carries
 *    its sport, skill, level or goal, so those four are the first valid value of the meta (sport, skill tree root, level) and
 *    GOALS[0]; the API derives an improvement's target from `targetDrillSlug` alone and ignores them. The proposed text goes in
 *    `instructions`; mistakes, progression, regression and safety are sent blank; `source` names the page it came from.
 *  - Video: one `video` part; only the meta's video/* types (a file with no type at all, which some browsers report for .mov, is
 *    left to the server, which reads the bytes) and at most meta.upload.maxMb. The photos and PDFs of the contract's `files` are
 *    not asked for here. There is no upload progress (fetch has none): a status line says a video can take a minute.
 *  - The honeypot `website` is sent as it is (empty for a person); a bot that fills it is refused by the server (422 /website).
 */

// --- the seam for tests -----------------------------------------------------------------------------------------------------

/** The part of Better Auth's `useSession()` result that this component reads; the real result is assignable to it. */
export interface SuggestSession {
  /** Validated here, not trusted. */
  data?: unknown;
  isPending: boolean;
  /** Better Auth keeps the PREVIOUS data while it re-reads the session; that may be another person, so it is never acted on. */
  isRefetching?: boolean;
  error?: unknown;
  refetch: () => unknown;
}

export interface SuggestDeps {
  /** Default: the real session hook. */
  session: SuggestSession;
}

/** Test seam: whatever is set replaces the real dependency. Nothing in the app provides it. */
export const SuggestDepsContext = createContext<Partial<SuggestDeps>>({});

// --- constants and small helpers ---------------------------------------------------------------------------------------------

const MINE_PATH = '/contribute/mine';
const BYTES_PER_MB = 1024 * 1024;
/** The seeded drills use 99 for "no upper age limit". */
const OPEN_ENDED_AGE = 99;
/** The same entry the drill page fills (routes/commons/$slug.tsx): [QUERY_KEY, slug, locale]. */
const DRILL_QUERY_KEY = 'commons-drill';
const DRILL_STALE_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `ball-mastery-ghost-ball` -> `Ball mastery ghost ball`. */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

// Link-button: the Button primitive is a <button>, and this navigates, so it is a real link with the same look (44px floor).
const LINK_SECONDARY =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border border-line bg-paper px-4.5 py-2.5 text-center font-bold wrap-anywhere text-ink hover:bg-bg';

// --- the session ----------------------------------------------------------------------------------------------------------------

type Access = 'loading' | 'error' | 'signed-out' | 'contributor';

/** Fails closed: only an explicit `isAnonymous === false` on a readable session is a contributor (the API's rule too). */
function resolveAccess(session: SuggestSession): Access {
  // Loading in EVERY branch, before the data or the error is looked at: a refetch keeps the previous session's data.
  if (session.isPending || session.isRefetching) return 'loading';
  if (session.error !== null && session.error !== undefined) return 'error';
  const { data } = session;
  if (data === null || data === undefined) return 'signed-out';
  if (!isRecord(data) || !isRecord(data.user)) return 'error';
  return data.user.isAnonymous === false ? 'contributor' : 'signed-out';
}

/** The account's name, to start the author field with. */
function accountName(session: SuggestSession): string {
  const user = isRecord(session.data) && isRecord(session.data.user) ? session.data.user : undefined;
  return typeof user?.name === 'string' ? user.name : '';
}

// --- the slot component -------------------------------------------------------------------------------------------------------

export default function SuggestImprovement() {
  const { session } = useContext(SuggestDepsContext);
  return session === undefined ? <WithRealSession /> : <Suggest session={session} />;
}

function WithRealSession() {
  return <Suggest session={useSession()} />;
}

function Suggest({ session }: { session: SuggestSession }) {
  const { t } = useTranslation('suggest');
  const router = useRouter();
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const [open, setOpen] = useState(false);
  // The dialog cannot be dismissed while its request is in flight; the body says when that is.
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  // A slot component reads the route param itself; outside a drill page there is nothing to suggest an improvement to.
  if (slug === undefined) return null;
  const access = resolveAccess(session);
  const returnPath = `/commons/${encodeURIComponent(slug)}`;

  let action: ReactNode;
  switch (access) {
    case 'contributor':
      action = <Button ref={opener} onClick={() => setOpen(true)}>{t('trigger.button')}</Button>;
      break;
    case 'signed-out':
      action = (
        <>
          <p className="m-0 text-base text-muted">{t('trigger.signInHint')}</p>
          <Button onClick={() => router.history.push(signInUrl(returnPath))}>{t('trigger.button')}</Button>
        </>
      );
      break;
    case 'error':
      action = (
        <>
          <Notice tone="warn">{t('trigger.sessionError')}</Notice>
          <Button variant="secondary" onClick={() => void session.refetch()}>
            {t('trigger.retry')}
          </Button>
        </>
      );
      break;
    case 'loading':
      action = <Button loading>{t('trigger.button')}</Button>;
      break;
    default: {
      // Exhaustive: a new Access value must be handled above. Anything unhandled at runtime offers nothing.
      const unhandled: never = access;
      action = unhandled;
    }
  }

  return (
    <Card className="flex flex-col items-start gap-3">
      <h2 className="m-0 text-xl leading-[1.2] font-bold tracking-[-.025em] text-ink">{t('trigger.title')}</h2>
      <p className="m-0 max-w-[65ch] text-base text-ink">{t('trigger.lead')}</p>
      {action}
      {access === 'contributor' ? (
        <Dialog.Root
          open={open}
          onOpenChange={(next) => {
            // The request cannot be taken back: the dialog stays until it has answered.
            if (!next && busy) return;
            setOpen(next);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
            <Dialog.Content
              onCloseAutoFocus={(event) => {
                // Radix returns focus to the trigger; there is none (the button sets `open`), so do it here.
                event.preventDefault();
                opener.current?.focus();
              }}
              className={clsx(
                'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-lg -translate-x-1/2 -translate-y-1/2',
                'gap-4 overflow-y-auto rounded-card border border-line bg-paper p-5.5 text-ink shadow-soft',
              )}
            >
              <DialogBody slug={slug} session={session} onBusy={setBusy} onClose={() => setOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </Card>
  );
}

// --- the dialog: reads, states -------------------------------------------------------------------------------------------------

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

function DialogBody({ slug, session, onBusy, onClose }: { slug: string; session: SuggestSession; onBusy: (busy: boolean) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation('suggest');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;

  const meta = useQuery({
    queryKey: ['contribute', 'meta', locale],
    queryFn: ({ signal }) => api.get(`${ENDPOINTS.getMeta.path}?${new URLSearchParams({ locale })}`, { schema: ENDPOINTS.getMeta.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const drill = useQuery({
    queryKey: [DRILL_QUERY_KEY, slug, locale],
    queryFn: ({ signal }) =>
      api.get(`${COMMONS_ENDPOINTS.getDrill.path.replace(':slug', encodeURIComponent(slug))}?${new URLSearchParams({ locale })}`, {
        schema: COMMONS_ENDPOINTS.getDrill.response,
        signal,
      }),
    staleTime: DRILL_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const metaFailure = useFailure(meta);
  const drillFailure = useFailure(drill);
  const failure = metaFailure ?? drillFailure;

  const title = drill.data?.content.title === undefined ? undefined : pickLocalized(drill.data.content.title, locale);
  const name = title ?? humanise(slug);

  let body: ReactNode;
  if (meta.data !== undefined && drill.data !== undefined) {
    const nothingToOffer = meta.data.improvementKinds.length === 0 || meta.data.skills.length === 0 || meta.data.levels.length === 0;
    body = nothingToOffer ? (
      <EmptyState title={t('empty.title')} hint={t('empty.hint')} action={<Button variant="secondary" onClick={onClose}>{t('actions.close')}</Button>} />
    ) : (
      <SuggestForm meta={meta.data} drillName={name} drillContent={drill.data.content} slug={slug} locale={locale} session={session} onBusy={onBusy} onClose={onClose} />
    );
  } else if (failure !== null) {
    body = (
      <ErrorState
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={meta.isFetching || drill.isFetching}
        onRetry={() => {
          if (metaFailure !== null) void meta.refetch();
          if (drillFailure !== null) void drill.refetch();
        }}
      />
    );
  } else {
    body = (
      <div role="status" aria-busy="true" aria-label={t('dialog.loading')} className="grid gap-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  return (
    <>
      <Dialog.Title className="m-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">{t('dialog.title')}</Dialog.Title>
      <Dialog.Description className={clsx('m-0 text-base wrap-break-word text-muted', drill.data === undefined && 'sr-only')}>
        {t('dialog.for', { name })}
      </Dialog.Description>
      {body}
    </>
  );
}

// --- the form ------------------------------------------------------------------------------------------------------------------------

type FieldKey = 'kind' | 'text' | 'video' | 'author' | 'rights' | 'noCommercial';
type FieldErrors = Partial<Record<FieldKey, string>>;
/** Top to bottom: the first of these that is wrong gets the focus. */
const FIELD_ORDER: readonly FieldKey[] = ['kind', 'text', 'video', 'author', 'rights', 'noCommercial'];

/** RFC 6901 pointer (as a dotted path by lib/problem) of the contract's payload -> the control that shows it. */
const POINTER_FIELDS: Readonly<Record<string, FieldKey>> = {
  improvementKind: 'kind',
  instructions: 'text',
  video: 'video',
  author: 'author',
  rightsAttested: 'rights',
  noCommercialContent: 'noCommercial',
};

interface FormFailure {
  message: string;
  /** The same suggestion is already waiting: the way to see it. */
  mine: boolean;
}

type DrillContent = DrillDetail['content'];

function SuggestForm({
  meta,
  drillName,
  drillContent,
  slug,
  locale,
  session,
  onBusy,
  onClose,
}: {
  meta: ContributionMeta;
  drillName: string;
  drillContent: DrillContent;
  slug: string;
  locale: Locale;
  session: SuggestSession;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('suggest');
  const base = useId();
  const idOf = (key: FieldKey): string => `${base}-${key}`;

  const [kind, setKind] = useState<ImprovementKind | ''>('');
  const [text, setText] = useState('');
  const [author, setAuthor] = useState(() => accountName(session));
  const [rights, setRights] = useState(false);
  const [noCommercial, setNoCommercial] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const trap = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const failedOnce = useRef(false);

  // The Send button was disabled while the request ran, which drops its focus: after a failure put it back.
  useEffect(() => {
    if (!pending && failedOnce.current) {
      failedOnce.current = false;
      sendRef.current?.focus();
    }
  }, [pending]);

  const videoTypes = meta.upload.mimeTypes.filter((type) => type.startsWith('video/'));
  const maxBytes = meta.upload.maxMb * BYTES_PER_MB;
  const max = formatNumber(meta.upload.maxMb, locale);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (kind === '' || !meta.improvementKinds.includes(kind)) found.kind = t('errors.kind');
    if (text.trim() === '') found.text = t('errors.text');
    if (video !== null) {
      if (video.type !== '' && !videoTypes.includes(video.type)) found.video = t('errors.videoType');
      else if (video.size > maxBytes) found.video = t('errors.videoSize', { max });
    }
    if (author.trim() === '') found.author = t('errors.author');
    if (!rights) found.rights = t('errors.rights');
    if (!noCommercial) found.noCommercial = t('errors.noCommercial');
    return found;
  }

  function payloadOf(chosen: ImprovementKind): ContributionPayloadRequest {
    const { conditions, dose } = drillContent;
    const ageMin = conditions.ageMin ?? 0;
    return {
      kind: 'improvement',
      targetDrillSlug: slug,
      improvementKind: chosen,
      locale,
      name: drillName,
      // Contract gap, see the header: no drill read carries these four.
      sport: meta.sports[0]!.slug,
      skill: meta.skills[0]!.slug,
      level: meta.levels[0]!,
      goal: GOALS[0],
      ageMin,
      ageMax: Math.max(conditions.ageMax ?? OPEN_ENDED_AGE, ageMin),
      equipment: conditions.equipment,
      durationMin: dose.durationSec === undefined ? 1 : Math.max(1, Math.ceil(dose.durationSec / 60)),
      instructions: text.trim(),
      mistakes: '',
      progression: '',
      regression: '',
      safety: '',
      source: `/commons/${slug}`,
      author: author.trim(),
      rightsAttested: true,
      noCommercialContent: true,
      website: (trap.current?.value ?? '') as '',
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    const found = validate();
    setErrors(found);
    const first = FIELD_ORDER.find((key) => found[key] !== undefined);
    if (first !== undefined || kind === '') {
      setFailure(null);
      if (first !== undefined) document.getElementById(idOf(first))?.focus();
      return;
    }

    inFlight.current = true;
    setPending(true);
    onBusy(true);
    setFailure(null);
    try {
      const body = new FormData();
      body.append('payload', JSON.stringify(payloadOf(kind)));
      if (video !== null) body.append('video', video);
      await api.post(ENDPOINTS.createContribution.path, { body, schema: Contribution });
      setDone(true);
    } catch (error) {
      const view = describeProblem(error, (key) => t(key));
      const next: FieldErrors = {};
      for (const path of Object.keys(view.fieldErrors)) {
        const key = POINTER_FIELDS[path];
        if (key !== undefined) next[key] = t('errors.field');
      }
      const status = isApiProblem(error) ? error.status : undefined;
      let shown: FormFailure | null = { message: view.formMessage, mine: false };
      if (view.kind === 'conflict') {
        shown = { message: t('errors.duplicate'), mine: true };
      } else if (view.kind === 'too_large') {
        next.video = t('errors.videoSize', { max });
        shown = null;
      } else if (status === 415) {
        next.video = t('errors.videoType');
        shown = null;
      } else if (view.kind === 'validation' && Object.keys(next).length === 0) {
        shown = { message: t('errors.rejected'), mine: false };
      }
      setErrors(next);
      setFailure(shown);
      failedOnce.current = true;
    } finally {
      inFlight.current = false;
      setPending(false);
      onBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="grid gap-3">
        <p className="m-0 flex items-center gap-2 text-xl leading-tight font-bold tracking-tight text-ink">
          <Check aria-hidden="true" className="size-6 shrink-0 text-accent" />
          <span>{t('success.title')}</span>
        </p>
        <p className="m-0 text-base text-ink">{t('success.body')}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Link to={MINE_PATH} className={LINK_SECONDARY}>
            {t('actions.mine')}
          </Link>
          <Button onClick={onClose}>{t('actions.close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      <Field id={idOf('kind')} label={t('fields.kind.label')} error={errors.kind}>
        {(control) => (
          <select
            {...control}
            required
            aria-required="true"
            disabled={pending}
            value={kind}
            onChange={(event) => setKind(event.target.value as ImprovementKind | '')}
          >
            <option value="">{t('fields.kind.placeholder')}</option>
            {meta.improvementKinds.map((option) => (
              <option key={option} value={option}>
                {t(`kinds.${option}`)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field id={idOf('text')} label={t('fields.text.label')} hint={t('fields.text.hint')} error={errors.text}>
        {(control) => (
          <textarea {...control} required aria-required="true" rows={6} disabled={pending} value={text} onChange={(event) => setText(event.target.value)} className={clsx(control.className, 'min-h-32 resize-y')} />
        )}
      </Field>

      <Field id={idOf('video')} label={t('fields.video.label')} hint={t('fields.video.hint', { max })} error={errors.video}>
        {(control) => (
          <input
            {...control}
            type="file"
            accept={videoTypes.join(',')}
            disabled={pending}
            onChange={(event) => setVideo(event.target.files?.[0] ?? null)}
            className={clsx(control.className, 'file:mr-3 file:rounded-control file:border-0 file:bg-accent-2 file:px-3 file:py-1.5 file:font-bold file:text-ink')}
          />
        )}
      </Field>

      <Field id={idOf('author')} label={t('fields.author.label')} hint={t('fields.author.hint')} error={errors.author}>
        {(control) => (
          <input {...control} type="text" required aria-required="true" autoComplete="name" disabled={pending} value={author} onChange={(event) => setAuthor(event.target.value)} />
        )}
      </Field>

      <div className="grid gap-3">
        <Attestation id={idOf('rights')} checked={rights} onChange={setRights} disabled={pending} error={errors.rights} label={t('fields.rights')} />
        <Attestation id={idOf('noCommercial')} checked={noCommercial} onChange={setNoCommercial} disabled={pending} error={errors.noCommercial} label={t('fields.noCommercial')} />
      </div>

      {/* The honeypot: invisible and unreachable for people and assistive tech; only a bot fills it. Sent as it is. */}
      <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] h-px w-px overflow-hidden">
        <input ref={trap} type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      {failure === null ? null : (
        <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="flex min-w-0 flex-col items-start gap-2 wrap-anywhere">
            <p className="m-0 font-bold">{t('errors.formTitle')}</p>
            <p className="m-0">{failure.message}</p>
            {failure.mine ? (
              <Link to={MINE_PATH} className={LINK_SECONDARY}>
                {t('actions.mine')}
              </Link>
            ) : null}
          </div>
        </div>
      )}

      {pending ? (
        <p role="status" className="m-0 text-base text-muted">
          {t('actions.sending')}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button ref={sendRef} type="submit" loading={pending}>
          {pending ? null : <Send aria-hidden="true" className="size-5 shrink-0" />}
          {t('actions.send')}
        </Button>
      </div>
    </form>
  );
}

/** One attestation: a real checkbox in a 44px label, its written error beside it (never colour alone). */
function Attestation({
  id,
  checked,
  onChange,
  disabled,
  error,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  error: string | undefined;
  label: string;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="flex min-h-tap cursor-pointer items-start gap-3 text-base text-ink">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-6 shrink-0 accent-accent"
        />
        <span className="min-w-0 wrap-anywhere">{label}</span>
      </label>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="m-0 flex items-start gap-2 font-bold text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{error}</span>
        </p>
      )}
    </div>
  );
}
