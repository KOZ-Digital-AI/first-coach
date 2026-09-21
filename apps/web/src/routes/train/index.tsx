import { pickLocalized } from '@api-types/primitives';
import { ENDPOINTS, type SessionEvent, type TodayItem, type TodaySession } from '@api-types/session';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Check, ChevronRight } from 'lucide-react';
import { type ComponentType, createContext, type MouseEvent, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { TrustBadge } from '../../features/commons/TrustBadge';
import { makeEvent, submitEvents, TODAY_QUERY_KEY } from '../../features/train/events-client';
import { type Api, api as appApi } from '../../lib/api';
import { ensurePlayerSession } from '../../lib/auth';
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { ApiProblem, describeProblem } from '../../lib/problem';
import { type TodaySlotProps, useSlot } from '../../lib/slots';

/**
 * /train: today's session (fc-mol-urn.8). Opens with GET /api/player/today (one call), lists the drills, shows the roadmap focus
 * and the `today` slot, and finishes the session with one session_finished event.
 *
 *  1. The session lives in the React Query cache under ['today'] (TODAY_QUERY_KEY): that is the key the persisted cache
 *     allow-lists (so the screen opens offline with the last known session) and the key the events client writes the server's
 *     answer to. The request sends `?locale=<ui locale>` and `X-Timezone: <the device's IANA zone>` (the server's "today" is
 *     the player's local day). It never retries by itself: Try again is the way out. A cached session is shown at once and
 *     refreshed behind it; a refresh that fails keeps the cached session on screen with a notice.
 *  2. A player who is not onboarded (the server answers 404 "not onboarded") is sent to /train/onboarding (history replace, so
 *     Back does not bounce them here again).
 *  3. Tapping a drill goes to the drill player, /train/drill/<itemId>. Finishing is one session_finished event through the
 *     events client and then /train/summary. The button is disabled until every drill is done and while the request is in
 *     flight; a ref also refuses a second finish in the same tick. A failed finish keeps the SAME event, so Try again
 *     resends the same clientUuid (the server is idempotent by it).
 *  4. Every component of the `today` slot (features/*\/today-extra.tsx) renders after the roadmap panel inside
 *     `<div data-slot="today">`; they take no props and read the ['today'] cache themselves.
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - TRACK AND LEVEL (fc-mol-urn.11): each row shows the drill's track (TodayItem.track, its primary skill) above the title and
 *    its level (TodayItem.level, an ExperienceLevel) in the meta line. Both are OPTIONAL on the contract (a session cached by an
 *    older build, or answered by an older server, has neither): a row without one shows nothing in its place, never a blank
 *    label. The contract carries only the track SLUG: the five root tracks (the only primary skills of the seeded drills) are
 *    worded in `today.messages.ts` (`tracks`, the roadmap screen's wording); any other slug is shown humanised. The focus panel
 *    below still humanises its own skill slugs (its existing behaviour), so a skill can read slightly differently there.
 *  - Skill names in the focus panel: the roadmap carries only the skill SLUG (no localised name), so it is shown humanised,
 *    as the skill tree does. `focus.reason` and `currentLevelLabel` are free text in the contract but the API sends keys
 *    (goal | weakest; Foundation | Basic | Intermediate | Advanced): known keys are worded here, anything else is shown as sent.
 *  - The API has no anonymous "no session" answer for a first visit, so the anonymous sign-in is ensured before the request
 *    (as the onboarding wizard does before it submits). If that fails the request still goes out: its own answer is the truth.
 *  - The drill player and the summary routes belong to other beads and are not in the route tree yet, so navigation is
 *    `router.history.push` with a path constant each (DRILL_PATH, SUMMARY_PATH), like the wizard's roadmap redirect.
 *  - The drill swap endpoint (POST /api/player/today/swap, bead urn.6) is not used: the criteria ask for no swap control.
 *  - Only `Route` and the small TodayDepsContext seam are exported (see the wizard for why the page itself is not).
 */

const ONBOARDING_PATH = '/train/onboarding';
const SUMMARY_PATH = '/train/summary';
const drillPath = (itemId: string): string => `/train/drill/${encodeURIComponent(itemId)}`;

/** The planner's item reason keys and the roadmap's focus reason keys / level labels that this screen words itself. */
const ITEM_REASONS: ReadonlySet<string> = new Set(['warmup', 'focus', 'fill']);
const FOCUS_REASONS: ReadonlySet<string> = new Set(['goal', 'weakest']);
const LEVEL_LABELS: ReadonlySet<string> = new Set(['Foundation', 'Basic', 'Intermediate', 'Advanced']);
/** The skill graph's root tracks, which `today.messages.ts` words; a drill's primary skill is one of them. */
const TRACKS: ReadonlySet<string> = new Set(['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination']);

// --- dependencies -----------------------------------------------------------------------------------------------------------

export type TodayDeps = {
  api: Pick<Api, 'get'>;
  /** Resolves once the player has a (possibly anonymous) session. */
  ensureSession: () => Promise<unknown>;
  /** The device's IANA time zone, or undefined when it cannot be read (then no X-Timezone header is sent). */
  timeZone: () => string | undefined;
  /** How session events are made and sent (the events client). */
  events: { makeEvent: typeof makeEvent; submitEvents: typeof submitEvents };
  /** Overrides the components collected for the `today` slot. */
  slots: readonly ComponentType<TodaySlotProps>[];
};

/**
 * The seam for tests: the page's collaborators (and `navigate`) can be supplied through this context. Nothing in the app
 * provides it, so the defaults apply. It is the ONLY export besides `Route`, and it imports nothing at runtime.
 */
export const TodayDepsContext = createContext<Partial<TodayDeps> & { navigate?: (to: string, options?: { replace?: boolean }) => void }>({});

function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** `weak-foot` -> `Weak foot` (the skill tree's rule: the contract has no localised skill name). */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

// --- pieces -------------------------------------------------------------------------------------------------------------------

const H1 = 'm-0 text-[length:clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-0.05em] wrap-break-word text-ink';

function DrillRow({ item, index, onOpen }: { item: TodayItem; index: number; onOpen: (event: MouseEvent<HTMLAnchorElement>, itemId: string) => void }) {
  const { t, i18n } = useTranslation('today');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const goal = pickLocalized(item.content.goal, locale) ?? '';
  const title = item.content.title === undefined ? goal : (pickLocalized(item.content.title, locale) ?? goal);
  const reason = item.reason?.trim() ?? '';
  const track = item.track === undefined ? '' : TRACKS.has(item.track) ? t(`tracks.${item.track}`) : humanise(item.track);

  return (
    <li>
      <a
        href={drillPath(item.itemId)}
        onClick={(event) => onOpen(event, item.itemId)}
        className="flex min-h-tap items-start gap-4 rounded-control py-4 text-ink no-underline motion-safe:transition-colors hover:bg-bg"
      >
        <span
          className={
            item.done
              ? 'flex size-10 shrink-0 items-center justify-center rounded-pill bg-accent text-base font-bold text-white opacity-90'
              : 'flex size-10 shrink-0 items-center justify-center rounded-pill bg-ink text-base font-bold text-white'
          }
        >
          {item.done ? <Check aria-hidden="true" className="size-5" /> : formatNumber(index + 1, locale)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          {track === '' ? null : <span className="text-xs font-bold tracking-[0.12em] text-muted uppercase wrap-anywhere">{track}</span>}
          <span className="text-xl leading-tight font-bold tracking-tight wrap-anywhere">{title}</span>
          {goal !== '' && goal !== title ? <span className="text-base text-muted wrap-anywhere">{goal}</span> : null}
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-bold">
            <span>{t('drill.minutes', { minutes: formatNumber(item.minutes, locale) })}</span>
            {item.level === undefined ? null : <span>{t('drill.level', { level: t(`drill.levels.${item.level}`) })}</span>}
            {reason === '' ? null : <Tag>{ITEM_REASONS.has(reason) ? t(`reasons.${reason}`) : reason}</Tag>}
            <TrustBadge status={item.status} source={item.attribution.source} />
            <span className="inline-flex items-center gap-1">
              {item.done ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
              {item.done ? t('drill.done') : t('drill.todo')}
            </span>
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="mt-2 size-5 shrink-0 text-muted" />
      </a>
    </li>
  );
}

function FocusPanel({ roadmap }: { roadmap: TodaySession['roadmapSummary'] }) {
  const { t, i18n } = useTranslation('today');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const headingId = useId();
  const level = roadmap.currentLevelLabel;
  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-5">
      <h2 id={headingId} className="m-0 text-[clamp(28px,4vw,44px)] leading-none font-bold tracking-[-0.05em] wrap-break-word text-ink">
        {t('focus.title')}
      </h2>
      <dl className="m-0 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-bold text-muted">{t('focus.level')}</dt>
          <dd className="m-0 text-xl font-bold tracking-tight wrap-anywhere">{LEVEL_LABELS.has(level) ? t(`focus.levels.${level}`) : level}</dd>
        </div>
        <div>
          <dt className="text-sm font-bold text-muted">{t('focus.perWeek')}</dt>
          <dd className="m-0 text-xl font-bold tracking-tight">{formatNumber(roadmap.sessionsPerWeek, locale)}</dd>
        </div>
        <div>
          <dt className="text-sm font-bold text-muted">{t('focus.perSession')}</dt>
          <dd className="m-0 text-xl font-bold tracking-tight">{formatNumber(roadmap.minutesPerSession, locale)}</dd>
        </div>
      </dl>
      <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
        {roadmap.focus.map((focus) => (
          <li key={focus.skill} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <span className="text-xl leading-tight font-bold tracking-tight wrap-anywhere">{humanise(focus.skill)}</span>
            <span className="text-base font-bold">
              {t('focus.range', { from: formatNumber(focus.level, locale), to: formatNumber(focus.targetLevel, locale) })}
            </span>
            <span className="text-base text-muted wrap-anywhere">{FOCUS_REASONS.has(focus.reason) ? t(`focus.reasons.${focus.reason}`) : focus.reason}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- the page --------------------------------------------------------------------------------------------------------------------

function TodayPage() {
  const { t, i18n } = useTranslation('today');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const router = useRouter({ warn: false });
  const injected = useContext(TodayDepsContext);
  const [deps] = useState(() => ({
    api: appApi,
    ensureSession: ensurePlayerSession,
    timeZone: browserTimeZone,
    events: { makeEvent, submitEvents },
    ...injected,
  }));
  const globSlots = useSlot('today');
  const slots = deps.slots ?? globSlots;
  const navigate =
    injected.navigate ?? ((to: string, options?: { replace?: boolean }) => (options?.replace === true ? router?.history.replace(to) : router?.history.push(to)));
  const hintId = useId();

  const today = useQuery({
    queryKey: TODAY_QUERY_KEY,
    queryFn: async ({ signal }) => {
      // A first visit has no session at all; the server's answer to this call is what counts, so a failure here is not final.
      await deps.ensureSession().catch(() => undefined);
      const zone = deps.timeZone();
      return deps.api.get(`${ENDPOINTS.getToday.path}?${new URLSearchParams({ locale })}`, {
        schema: ENDPOINTS.getToday.response,
        signal,
        ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
      });
    },
    retry: false,
  });

  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));
  const notOnboarded = today.error instanceof ApiProblem && today.error.kind === 'not_found';
  useEffect(() => {
    if (notOnboarded) navigate(ONBOARDING_PATH, { replace: true });
    // `navigate` is a fresh closure on every render; the redirect must fire once per failure, not once per render.
  }, [notOnboarded]);

  // --- finishing ---
  const [saving, setSaving] = useState(false);
  const [finishFailure, setFinishFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<SessionEvent | null>(null);

  async function finish(session: TodaySession) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setFinishFailure(null);
    try {
      let event = pending.current;
      if (event === null || event.sessionId !== session.id) {
        event = deps.events.makeEvent('session_finished', { sessionId: session.id });
        pending.current = event;
      }
      await deps.events.submitEvents([event]);
      pending.current = null;
      navigate(SUMMARY_PATH);
      // Stays "saving" (button disabled) until the summary replaces this page: no second tap can send a second event.
    } catch (error) {
      setFinishFailure(describeProblem(error, translate).formMessage);
      setSaving(false);
      inFlight.current = false;
    }
  }

  function openDrill(event: MouseEvent<HTMLAnchorElement>, itemId: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(drillPath(itemId));
  }

  // --- render ---
  const session = today.data;
  let body: ReactNode;
  if (notOnboarded) {
    body = (
      <p role="status" className="m-0 text-base font-bold text-ink">
        {t('redirecting')}
      </p>
    );
  } else if (session === undefined) {
    body = today.isError ? (
      <ErrorState
        title={t('loadError.title')}
        message={describeProblem(today.error, translate).formMessage}
        retryLabel={t('retry')}
        onRetry={() => void today.refetch()}
        retrying={today.isFetching}
      />
    ) : (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <p className="m-0 text-base text-muted">{t('loading')}</p>
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-2/3" />
      </div>
    );
  } else if (session.items.length === 0) {
    body = (
      <EmptyState
        title={t('empty.title')}
        hint={t('empty.hint')}
        action={
          <Button variant="secondary" loading={today.isFetching} onClick={() => void today.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else {
    const done = session.items.filter((item) => item.done).length;
    const total = session.items.length;
    const everyDone = done === total;
    const completed = t('completed', { done: formatNumber(done, locale), total: formatNumber(total, locale) });
    body = (
      <>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tag tone="accent">{completed}</Tag>
            <div
              role="progressbar"
              aria-label={t('progress')}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-valuetext={completed}
              className="h-2.5 min-w-24 flex-1 rounded-pill bg-line"
            >
              <div className="h-full rounded-pill bg-accent" style={{ width: `${(done / total) * 100}%` }} />
            </div>
          </div>
          <ol aria-label={t('list')} className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {session.items.map((item, index) => (
              <DrillRow key={item.itemId} item={item} index={index} onOpen={openDrill} />
            ))}
          </ol>
        </div>

        <div className="flex flex-col gap-3" aria-busy={saving}>
          {everyDone ? <Notice tone="info">{t('allDone')}</Notice> : null}
          {finishFailure === null ? null : (
            <ErrorState
              title={t('finishError.title')}
              message={finishFailure}
              retryLabel={t('retry')}
              retrying={saving}
              onRetry={() => void finish(session)}
            />
          )}
          <Button
            className="w-full sm:w-auto sm:self-start"
            disabled={!everyDone}
            loading={saving}
            aria-describedby={everyDone ? undefined : hintId}
            onClick={() => void finish(session)}
          >
            {t('finish')}
          </Button>
          {everyDone ? null : (
            <p id={hintId} className="m-0 text-base text-muted">
              {t('finishHint')}
            </p>
          )}
          {saving ? (
            <p role="status" className="m-0 text-base font-bold text-ink">
              {t('finishing')}
            </p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <main className="mx-auto flex w-[min(840px,100%-24px)] flex-col gap-6 py-8 sm:w-[min(840px,100%-40px)] sm:py-12">
      <header className="flex flex-col gap-3">
        {session === undefined ? null : <p className="m-0 text-xs font-bold tracking-[0.12em] text-accent uppercase">{t('eyebrow')}</p>}
        <h1 className={H1}>{session === undefined ? t('eyebrow') : t('title', { minutes: formatNumber(session.totalMinutes, locale) })}</h1>
        {session === undefined ? null : <p className="m-0 max-w-[65ch] text-lg text-ink">{t('lead')}</p>}
      </header>

      {session !== undefined && today.isError && !notOnboarded ? <Notice tone="warn">{t('stale')}</Notice> : null}

      <div className="flex flex-col gap-5 rounded-card border border-line bg-paper p-5 shadow-soft sm:p-7">{body}</div>

      {session === undefined || notOnboarded ? null : <FocusPanel roadmap={session.roadmapSummary} />}

      {session === undefined || notOnboarded || slots.length === 0 ? null : (
        <div data-slot="today" className="flex flex-col gap-6">
          {slots.map((Slot, index) => (
            <Slot key={index} />
          ))}
        </div>
      )}
    </main>
  );
}

export const Route = createFileRoute('/train/')({ component: TodayPage });
