import { type DrillContent, type Locale, type LocalizedText, pickLocalized } from '@api-types/primitives';
import { ENDPOINTS, type SessionEvent, type TodayItem, type TodaySession } from '@api-types/session';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, Play, Undo2 } from 'lucide-react';
import {
  type ComponentType,
  createContext,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { seedTodayFromDevice } from '../../bootstrap';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { TrustBadge } from '../../features/commons/TrustBadge';
import { makeEvent, submitEvents, TODAY_QUERY_KEY } from '../../features/train/events-client';
import { type Api, api as appApi } from '../../lib/api';
import { ensurePlayerSession } from '../../lib/auth';
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { ApiProblem, describeProblem, isApiProblem } from '../../lib/problem';
import { type DrillSlotProps, useSlot } from '../../lib/slots';

/**
 * /train/drill/:itemId: the drill player. An Operate-mode screen for one drill of today's session, used outdoors, on a cheap
 * phone, often with one hand. Copy lives in features/train/drill-player.messages.ts (kk / ru / en).
 *
 *  1. Data. The drill is read from the cached today session, React Query key ['today'] (TODAY_QUERY_KEY), the same cache /train
 *     fills and the persisted-cache allow-list restores, so a drill opens with no network. A session that is in the cache and
 *     younger than STALE_MS causes no request at all. Only when there is none (a deep link, a cleared cache) the screen asks
 *     GET /api/player/today itself, exactly as /train does (locale, X-Timezone, anonymous sign-in first); a 404 "not onboarded"
 *     sends the player to /train/onboarding. There is no refetch on focus or reconnect: /train owns keeping the session fresh, and a
 *     background refetch must never overwrite an optimistic change that is still in flight.
 *     OFFLINE COLD RELOAD (fc-mol-eay.12): when that request fails (no network, and no readable session) and the cache holds no
 *     session (no persisted cache), the session the last player downloaded is put into the cache (`seedTodayFromDevice`,
 *     bootstrap.ts) and the drill opens from it, with all its text. The load error stays only when the device holds nothing.
 *  2. Mutations. Done, Undo and Save result are session events through the events client (never fetch directly). Done and Undo
 *     are OPTIMISTIC: the ['today'] cache is patched at once and restored to the snapshot if the post fails. The server's
 *     session then replaces the cache (the events client does that). A result has no representation in the session, so it is
 *     not guessed: it is confirmed after the post, and the box keeps what was typed if the post fails. A swap cannot be guessed
 *     either (the server picks the replacement), so it waits for the answer, which replaces the cache. ONE lock covers every
 *     mutation: while any request is in flight every mutation button is disabled (the acting one shows the spinner), and a ref
 *     refuses a second start in the same tick.
 *  3. Retries. A failed action is kept, and Try again (or pressing the same button again) resends the SAME event, so the
 *     clientUuid and `at` are stable and the server, which is idempotent by clientUuid, ignores a replay of an event whose answer
 *     was lost. The event is forgotten only when it succeeds; a later, separate action gets a new uuid. A result is a different
 *     event per number typed.
 *  4. Timer. A count-up timer built on TIMESTAMPS: it stores when it started and how much had already been counted, and shows
 *     `counted + (now - startedAt)`. The interval only asks for a re-render; it is never the source of the time. So a tab that
 *     sleeps (or a phone that is locked) cannot make it drift, and it is corrected the moment the tab wakes (visibilitychange,
 *     focus, pageshow). A clock that jumps backwards never shows negative time. It resets when the drill is swapped.
 *  5. Offline. The screen renders from the cache and says so. Swap is disabled with a written reason (it needs the server);
 *     so is playing the video (nothing is precached). Saving a Done while offline is tried and, on failure, rolled back with the
 *     calm offline message: the offline outbox is not wired to the events client yet (events-client.ts says so).
 *  6. Slot. Every component of the `drill` slot (features/*\/drill-extra.tsx) renders in `<div data-slot="drill">` after the
 *     page content. They take no props and read the ['today'] cache and the route param themselves.
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - Only the first video of `content.media` is shown (kind "video"); images and documents are not shown: the bead asks for
 *    "an optional short video". The video element does not exist until Play is tapped, so nothing is downloaded before.
 *  - "reps/time": the dose is shown as label: value pairs (Reps, Sets, Time), only those the drill has, with a timer beside it.
 *    `durationSec`, when there is one, is the target the timer reports as reached (in words).
 *  - "Done" and "Undo" are one toggle by the drill's state. The state is also in the header, as a written word with a check.
 *    Next drill becomes the primary control once the drill is done; before that Done is (one primary action per view).
 *    On the last drill the next step is "Back to today's session" (where Finish session lives).
 *  - Swap of a finished drill is refused by the API (409), so it is disabled here with the reason ("Undo Done first").
 *    A swap keeps the item id and its place; it starts a fresh timer. `?locale=` and `X-Timezone` are sent, as the swap route
 *    reads today's session the way GET does. 409 "no alternative" is worded for the direction that was asked.
 *  - CONTRACT GAP: TodayItem carries no per-drill track or level, and no `result` read-back, so neither is shown.
 *  - Navigation is `router.history.push` with a path constant, like /train, through the same `navigate` seam.
 *  - Only `Route` and the small DrillPlayerDepsContext seam are exported (see routes/train/onboarding.tsx for why).
 */

const TRAIN_PATH = '/train';
const ONBOARDING_PATH = '/train/onboarding';
const drillPath = (itemId: string): string => `/train/drill/${encodeURIComponent(itemId)}`;

/** A cached session younger than this is not asked for again when a drill opens. */
const STALE_MS = 30_000;
/** How often a running timer asks to be redrawn. It is only a nudge: the time itself comes from timestamps. */
const TICK_MS = 250;

// --- dependencies -----------------------------------------------------------------------------------------------------------

export type DrillPlayerDeps = {
  api: Pick<Api, 'get' | 'post'>;
  /** Resolves once the player has a (possibly anonymous) session. */
  ensureSession: () => Promise<unknown>;
  /** The device's IANA time zone, or undefined when it cannot be read (then no X-Timezone header is sent). */
  timeZone: () => string | undefined;
  /** How session events are made and sent (the events client). */
  events: { makeEvent: typeof makeEvent; submitEvents: typeof submitEvents };
  /** The clock, in milliseconds since the epoch. The timer is built on it. */
  now: () => number;
  /** Whether the browser reports a connection. Re-read when the window fires `online` / `offline`. */
  isOnline: () => boolean;
  /** Overrides the components collected for the `drill` slot. */
  slots: readonly ComponentType<DrillSlotProps>[];
};

/**
 * The seam for tests: the screen's collaborators (and `navigate`) can be supplied through this context. Nothing in the app
 * provides it, so the defaults apply. It is the ONLY export besides `Route`, and it imports nothing at runtime.
 */
export const DrillPlayerDepsContext = createContext<Partial<DrillPlayerDeps> & { navigate?: (to: string, options?: { replace?: boolean }) => void }>({});

function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

// --- helpers ------------------------------------------------------------------------------------------------------------------

type Direction = 'easier' | 'harder';

/** What the player can do. A result carries its number; a swap its direction. */
type Action = { kind: 'done' } | { kind: 'undone' } | { kind: 'result'; value: number } | { kind: 'swap'; direction: Direction };

/** Which control started a request: it shows the spinner, and gets keyboard focus back when the request settles. */
type ControlKey = 'toggle' | 'result' | 'easier' | 'harder';

const controlOf = (action: Action): ControlKey => (action.kind === 'swap' ? (action.direction === 'easier' ? 'easier' : 'harder') : action.kind === 'result' ? 'result' : 'toggle');

const EVENT_TYPES = { done: 'drill_done', undone: 'drill_undone', result: 'result' } as const;

/** One key per event the player has tried: the same tap on the same session is the same event. */
const eventKey = (sessionId: string, action: Exclude<Action, { kind: 'swap' }>): string =>
  `${sessionId}:${action.kind}:${action.kind === 'result' ? action.value : ''}`;

function patchItem(session: TodaySession, itemId: string, patch: Partial<TodayItem>): TodaySession {
  return { ...session, items: session.items.map((item) => (item.itemId === itemId ? { ...item, ...patch } : item)) };
}

type Amount = { ok: true; value: number } | { ok: false; reason: 'empty' | 'notNumber' | 'negative' };

/** A non-negative finite number; a comma counts as the decimal point. */
function parseAmount(raw: string): Amount {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (/^-\d+(?:[.,]\d+)?$/.test(text)) return { ok: false, reason: 'negative' };
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return { ok: false, reason: 'notNumber' };
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'notNumber' };
}

function localizedList(texts: readonly LocalizedText[], locale: Locale): string[] {
  return texts.map((text) => pickLocalized(text, locale)).filter((text): text is string => text !== undefined);
}

/** "1. Set cones.\n2. Go." -> ["Set cones.", "Go."] when every line is numbered (numbers come from the list), else null. */
function numberedSteps(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => /^\d+[.)]\s*\S/.test(line)) ? lines.map((line) => line.replace(/^\d+[.)]\s*/, '')) : null;
}

const formatClock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// --- styling ------------------------------------------------------------------------------------------------------------------

/** Section heading: the Title role of DESIGN.md (20px, bold), because a phone screen has many of them. */
const H2 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';
const LIST = 'm-0 flex list-disc flex-col gap-2 pl-6 text-base text-ink';
// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere no-underline';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK_BASE} border-line bg-paper text-ink`;
const LINK_QUIET = 'inline-flex min-h-tap items-center gap-2 self-start rounded-control font-bold text-ink no-underline hover:underline';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className={H2}>{title}</h2>
      {children}
    </section>
  );
}

// --- pieces -------------------------------------------------------------------------------------------------------------------

/** The count-up timer. Time = counted before + (now - started), so it never depends on how often anything ticks. */
function DrillTimer({ targetSec, now }: { targetSec: number | undefined; now: () => number }) {
  const { t } = useTranslation('drill-player');
  const [clock, setClock] = useState<{ counted: number; since: number | null }>({ counted: 0, since: null });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const running = clock.since !== null;

  useEffect(() => {
    if (!running) return;
    const nudge = () => redraw();
    const id = setInterval(nudge, TICK_MS);
    // A tab that slept or a phone that was locked: redraw the moment it is back, so the time is right at once.
    document.addEventListener('visibilitychange', nudge);
    window.addEventListener('focus', nudge);
    window.addEventListener('pageshow', nudge);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', nudge);
      window.removeEventListener('focus', nudge);
      window.removeEventListener('pageshow', nudge);
    };
  }, [running]);

  const elapsed = clock.counted + (clock.since === null ? 0 : Math.max(0, now() - clock.since));
  const reached = targetSec !== undefined && elapsed >= targetSec * 1000;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-bg p-4">
      <p
        role="timer"
        aria-label={t('timer.label')}
        className="m-0 text-[clamp(56px,20vw,96px)] leading-none font-extrabold tracking-[-0.05em] text-ink tabular-nums"
      >
        {formatClock(elapsed)}
      </p>
      {reached ? (
        <p role="status" className="m-0 flex items-center gap-2 font-bold text-ink">
          <Check aria-hidden="true" className="size-5 shrink-0" />
          {t('timer.reached')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          onClick={() =>
            setClock(running ? { counted: clock.counted + Math.max(0, now() - (clock.since ?? 0)), since: null } : { counted: clock.counted, since: now() })
          }
        >
          {running ? t('timer.pause') : clock.counted > 0 ? t('timer.resume') : t('timer.start')}
        </Button>
        {running || clock.counted > 0 ? (
          <Button variant="ghost" onClick={() => setClock({ counted: 0, since: null })}>
            {t('timer.reset')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Lazy video: no <video> exists (so nothing is downloaded) until the player taps Play. */
function DrillVideo({ media, online, locale }: { media: DrillContent['media'][number]; online: boolean; locale: Locale }) {
  const { t } = useTranslation('drill-player');
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const reasonId = useId();
  const caption = media.caption === undefined ? undefined : pickLocalized(media.caption, locale);

  return (
    <div className="flex flex-col gap-3">
      {playing ? (
        <video
          controls
          autoPlay
          playsInline
          preload="metadata"
          src={media.url}
          onError={() => {
            setPlaying(false);
            setFailed(true);
          }}
          className="aspect-video w-full rounded-card bg-ink"
        />
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-card border border-line bg-paper p-4">
          <Button
            variant="secondary"
            disabled={!online}
            aria-describedby={online ? undefined : reasonId}
            onClick={() => {
              setFailed(false);
              setPlaying(true);
            }}
          >
            <Play aria-hidden="true" className="size-5 shrink-0" />
            {t('video.play')}
          </Button>
          {online ? null : (
            <p id={reasonId} className="m-0 text-center text-base text-muted">
              {t('video.offline')}
            </p>
          )}
        </div>
      )}
      {failed && !playing ? <Notice tone="warn">{t('video.error')}</Notice> : null}
      {caption === undefined ? null : <p className="m-0 text-base text-muted wrap-anywhere">{caption}</p>}
    </div>
  );
}

// --- the screen -----------------------------------------------------------------------------------------------------------------

function DrillScreen({ itemId }: { itemId: string }) {
  const { t, i18n } = useTranslation('drill-player');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const router = useRouter({ warn: false });
  const queryClient = useQueryClient();
  const injected = useContext(DrillPlayerDepsContext);
  const [deps] = useState(() => ({
    api: appApi,
    ensureSession: ensurePlayerSession,
    timeZone: browserTimeZone,
    events: { makeEvent, submitEvents },
    now: Date.now,
    isOnline: browserOnline,
    ...injected,
  }));
  const globSlots = useSlot('drill');
  const slots = deps.slots ?? globSlots;
  const navigate =
    injected.navigate ?? ((to: string, options?: { replace?: boolean }) => (options?.replace === true ? router?.history.replace(to) : router?.history.push(to)));
  const online = useSyncExternalStore(subscribeOnline, deps.isOnline, () => true);
  const swapReasonId = useId();
  const translate = (key: Parameters<NonNullable<Parameters<typeof describeProblem>[1]>>[0]) => String(i18n.t(key));

  const today = useQuery({
    queryKey: TODAY_QUERY_KEY,
    queryFn: async ({ signal }) => {
      // Same request as /train: a deep link has no session at all, and the server's own answer is what counts.
      await deps.ensureSession().catch(() => undefined);
      const zone = deps.timeZone();
      return deps.api.get(`${ENDPOINTS.getToday.path}?${new URLSearchParams({ locale })}`, {
        schema: ENDPOINTS.getToday.response,
        signal,
        ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
      });
    },
    retry: false,
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const notOnboarded = today.error instanceof ApiProblem && today.error.kind === 'not_found';
  useEffect(() => {
    if (notOnboarded) navigate(ONBOARDING_PATH, { replace: true });
    // `navigate` is a fresh closure on every render; the redirect must fire once per failure, not once per render.
  }, [notOnboarded]);

  // The request failed and the cache holds no session: fall back to the one the last player downloaded (never on a 404 answer).
  useEffect(() => {
    if (today.isError && !notOnboarded && today.data === undefined) seedTodayFromDevice(queryClient);
  }, [today.isError, today.data, notOnboarded, queryClient]);

  // --- mutations ---
  const [busy, setBusy] = useState<ControlKey | null>(null);
  /** What was last achieved, shown in the polite live region. */
  const [outcome, setOutcome] = useState<Action | null>(null);
  const [failure, setFailure] = useState<{ action: Action; message: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const inFlight = useRef(false);
  /** Events that were tried and not yet acknowledged: the same tap resends the same event. */
  const unacknowledged = useRef(new Map<string, SessionEvent>());
  /** Disabling the button that was pressed drops keyboard focus; it is put back when the request settles. */
  const buttons = useRef<Partial<Record<ControlKey, HTMLButtonElement | null>>>({});
  const refocus = useRef<ControlKey | null>(null);
  useEffect(() => {
    if (busy === null && refocus.current !== null) {
      buttons.current[refocus.current]?.focus();
      refocus.current = null;
    }
  }, [busy]);

  async function run(action: Action) {
    if (inFlight.current) return;
    const before = queryClient.getQueryData<TodaySession>(TODAY_QUERY_KEY);
    if (before === undefined) return;
    inFlight.current = true;
    refocus.current = controlOf(action);
    setBusy(controlOf(action));
    setFailure(null);
    setOutcome(null);
    try {
      // A refetch that lands after the optimistic change would undo it; the events client's answer is the one that counts.
      await queryClient.cancelQueries({ queryKey: TODAY_QUERY_KEY });
      if (action.kind === 'swap') {
        const zone = deps.timeZone();
        const swapped = await deps.api.post(`${ENDPOINTS.postSwap.path}?${new URLSearchParams({ locale })}`, {
          body: { itemId, direction: action.direction },
          schema: ENDPOINTS.postSwap.response,
          ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
        });
        queryClient.setQueryData(TODAY_QUERY_KEY, swapped);
      } else {
        const eventId = eventKey(before.id, action);
        const event =
          unacknowledged.current.get(eventId) ??
          deps.events.makeEvent(EVENT_TYPES[action.kind], {
            sessionId: before.id,
            itemId,
            ...(action.kind === 'result' ? { value: action.value } : {}),
          });
        unacknowledged.current.set(eventId, event);
        if (action.kind !== 'result') queryClient.setQueryData(TODAY_QUERY_KEY, patchItem(before, itemId, { done: action.kind === 'done' }));
        await deps.events.submitEvents([event]);
        unacknowledged.current.delete(eventId);
        if (action.kind === 'result') setTyped('');
      }
      setOutcome(action);
    } catch (error) {
      // Rollback. (When the post itself failed the events client has not touched the cache, so the guess is still in it.)
      if (action.kind === 'done' || action.kind === 'undone') queryClient.setQueryData(TODAY_QUERY_KEY, before);
      const noAlternative = action.kind === 'swap' && isApiProblem(error) && error.kind === 'conflict';
      setFailure({
        action,
        message: noAlternative ? t(`swap.none.${action.direction}`) : describeProblem(error, translate).formMessage,
      });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function saveResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const parsed = parseAmount(typed);
    if (!parsed.ok) {
      setTypedError(t(`result.errors.${parsed.reason}`));
      return;
    }
    setTypedError(null);
    void run({ kind: 'result', value: parsed.value });
  }

  function go(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }

  // --- render ---
  const session = today.data;
  const index = session === undefined ? -1 : session.items.findIndex((entry) => entry.itemId === itemId);
  const item = session === undefined || index < 0 ? undefined : session.items[index];

  const backLink = (
    <a href={TRAIN_PATH} onClick={(event) => go(event, TRAIN_PATH)} className={LINK_QUIET}>
      <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
      {t('back')}
    </a>
  );

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
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (item === undefined) {
    body = (
      <EmptyState
        title={t('notFound.title')}
        hint={t('notFound.hint')}
        action={
          <a href={TRAIN_PATH} onClick={(event) => go(event, TRAIN_PATH)} className={LINK_SECONDARY}>
            {t('toSession')}
          </a>
        }
      />
    );
  } else {
    body = drillView(item, session);
  }

  // A plain function, NOT a component declared in a component: a fresh component type every render would remount the timer.
  function drillView(current: TodayItem, all: TodaySession): ReactNode {
    const content = current.content;
    const title = content.title === undefined ? undefined : pickLocalized(content.title, locale);
    const goal = pickLocalized(content.goal, locale) ?? '';
    const heading = title ?? goal;
    const instructions = pickLocalized(content.instructions, locale) ?? '';
    const steps = numberedSteps(instructions);
    const safety = localizedList(content.safety, locale);
    const mistakes = localizedList(content.mistakes, locale);
    const easier = localizedList(content.regressions, locale);
    const harder = localizedList(content.progressions, locale);
    const video = content.media.find((entry) => entry.kind === 'video');
    const next = all.items[index + 1];
    const { dose, conditions } = content;
    const locked = busy !== null;
    const swapBlocked = !online ? t('swap.offline') : current.done ? t('swap.finished') : null;

    const doses: [string, string][] = [];
    if (dose.reps !== undefined) doses.push([t('target.reps'), formatNumber(dose.reps, locale)]);
    if (dose.sets !== undefined) doses.push([t('target.sets'), formatNumber(dose.sets, locale)]);
    if (dose.durationSec !== undefined) doses.push([t('target.time'), t('target.seconds', { seconds: formatNumber(dose.durationSec, locale) })]);

    const age =
      conditions.ageMin !== undefined && conditions.ageMax !== undefined
        ? t('needs.age.range', { min: formatNumber(conditions.ageMin, locale), max: formatNumber(conditions.ageMax, locale) })
        : conditions.ageMin !== undefined
          ? t('needs.age.from', { min: formatNumber(conditions.ageMin, locale) })
          : conditions.ageMax !== undefined
            ? t('needs.age.to', { max: formatNumber(conditions.ageMax, locale) })
            : null;

    const outcomeText =
      outcome === null
        ? ''
        : outcome.kind === 'done'
          ? t('saved.done')
          : outcome.kind === 'undone'
            ? t('saved.undone')
            : outcome.kind === 'result'
              ? t('result.saved', { value: formatNumber(outcome.value, locale) })
              : t(`swap.replaced.${outcome.direction}`);

    const failureView = (mine: (action: Action) => boolean) =>
      failure !== null && mine(failure.action) ? (
        <ErrorState
          title={failure.action.kind === 'swap' ? t('swap.error.title') : t('actionError.title')}
          message={failure.message}
          retryLabel={t('retry')}
          retrying={locked}
          onRetry={() => void run(failure.action)}
        />
      ) : null;

    return (
      <>
        <header className="flex flex-col gap-3">
          <p className="m-0 text-xs font-bold tracking-[0.12em] text-accent uppercase">
            {t('position', { n: formatNumber(index + 1, locale), total: formatNumber(all.items.length, locale) })}
          </p>
          <h1 className="m-0 text-[length:clamp(36px,9vw,64px)] leading-[.98] font-bold tracking-[-0.05em] wrap-break-word text-ink">{heading}</h1>
          {goal !== '' && goal !== heading ? <p className="m-0 max-w-[65ch] text-lg text-ink wrap-anywhere">{goal}</p> : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-bold">
            <span>{t('minutes', { minutes: formatNumber(current.minutes, locale) })}</span>
            <TrustBadge status={current.status} source={current.attribution.source} />
            <span className="inline-flex items-center gap-1">
              {current.done ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
              {current.done ? t('state.done') : t('state.todo')}
            </span>
          </div>
        </header>

        {safety.length === 0 ? null : (
          <Notice tone="warn" role="region" aria-label={t('safety.label')}>
            <div className="flex flex-col gap-2">
              <h2 className={H2}>{t('safety.title')}</h2>
              <ul className={LIST}>
                {safety.map((note, position) => (
                  <li key={position}>{note}</li>
                ))}
              </ul>
            </div>
          </Notice>
        )}

        {video === undefined ? null : <DrillVideo key={current.drillVersionId} media={video} online={online} locale={locale} />}

        <Card className="flex flex-col gap-6">
          {instructions === '' ? null : (
            <Section title={t('instructions.title')}>
              {steps === null ? (
                <p className="m-0 max-w-[65ch] text-lg whitespace-pre-line text-ink wrap-anywhere">{instructions}</p>
              ) : (
                <ol className="m-0 flex list-decimal flex-col gap-2 pl-6 text-lg text-ink wrap-anywhere">
                  {steps.map((step, position) => (
                    <li key={position}>{step}</li>
                  ))}
                </ol>
              )}
            </Section>
          )}
          <Section title={t('target.title')}>
            {doses.length === 0 ? null : (
              <dl className="m-0 flex flex-wrap gap-x-8 gap-y-3">
                {doses.map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1">
                    <dt className="text-sm font-bold text-muted">{label}</dt>
                    <dd className="m-0 text-2xl leading-none font-bold tracking-tight">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <DrillTimer key={current.drillVersionId} targetSec={dose.durationSec} now={deps.now} />
          </Section>
        </Card>

        <Card elevated className="flex flex-col gap-5" aria-busy={locked}>
          <h2 className={H2}>{t('turn.title')}</h2>
          <div className="flex flex-col gap-3 sm:flex-row">
            {current.done ? (
              <Button
                ref={(node) => void (buttons.current.toggle = node)}
                variant="secondary"
                disabled={locked}
                loading={busy === 'toggle'}
                onClick={() => void run({ kind: 'undone' })}
              >
                <Undo2 aria-hidden="true" className="size-5 shrink-0" />
                {t('undo')}
              </Button>
            ) : (
              <Button
                ref={(node) => void (buttons.current.toggle = node)}
                disabled={locked}
                loading={busy === 'toggle'}
                onClick={() => void run({ kind: 'done' })}
              >
                <Check aria-hidden="true" className="size-5 shrink-0" />
                {t('done')}
              </Button>
            )}
            {next === undefined ? (
              <a href={TRAIN_PATH} onClick={(event) => go(event, TRAIN_PATH)} className={current.done ? LINK_PRIMARY : LINK_SECONDARY}>
                {t('toSession')}
              </a>
            ) : (
              <a href={drillPath(next.itemId)} onClick={(event) => go(event, drillPath(next.itemId))} className={current.done ? LINK_PRIMARY : LINK_SECONDARY}>
                {t('next')}
                <ArrowRight aria-hidden="true" className="size-5 shrink-0" />
              </a>
            )}
          </div>

          <p role="status" className="m-0 min-h-6 text-base font-bold text-ink">
            {locked ? t('saving') : outcomeText}
          </p>
          {failureView((action) => action.kind !== 'swap')}

          <form noValidate onSubmit={saveResult} className="flex flex-col gap-3">
            <Field label={t('result.label')} hint={t('result.hint')} error={typedError}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={typed}
                  disabled={locked}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setTypedError(null);
                  }}
                />
              )}
            </Field>
            <Button ref={(node) => void (buttons.current.result = node)} type="submit" variant="secondary" className="self-start" disabled={locked} loading={busy === 'result'}>
              {t('result.save')}
            </Button>
          </form>
        </Card>

        <Card className="flex flex-col gap-6">
          <Section title={t('needs.title')}>
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-sm font-bold text-muted">{t('needs.equipmentLabel')}</dt>
                <dd className="m-0 text-base font-bold">{t(`needs.equipment.${conditions.equipment}`)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm font-bold text-muted">{t('needs.spaceLabel')}</dt>
                <dd className="m-0 text-base font-bold">{conditions.spaces.map((space) => t(`needs.spaces.${space}`)).join(', ')}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm font-bold text-muted">{t('needs.partnerLabel')}</dt>
                <dd className="m-0 text-base font-bold">{conditions.partner ? t('needs.partner.yes') : t('needs.partner.no')}</dd>
              </div>
              {age === null ? null : (
                <div className="flex flex-col gap-1">
                  <dt className="text-sm font-bold text-muted">{t('needs.ageLabel')}</dt>
                  <dd className="m-0 text-base font-bold">{age}</dd>
                </div>
              )}
            </dl>
          </Section>
          {mistakes.length === 0 ? null : (
            <Section title={t('mistakes.title')}>
              <ul className={LIST}>
                {mistakes.map((text, position) => (
                  <li key={position}>{text}</li>
                ))}
              </ul>
            </Section>
          )}
          {easier.length === 0 ? null : (
            <Section title={t('easier.title')}>
              <ul className={LIST}>
                {easier.map((text, position) => (
                  <li key={position}>{text}</li>
                ))}
              </ul>
            </Section>
          )}
          {harder.length === 0 ? null : (
            <Section title={t('harder.title')}>
              <ul className={LIST}>
                {harder.map((text, position) => (
                  <li key={position}>{text}</li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={t('swap.title')}>
            <p className="m-0 text-base text-muted">{t('swap.hint')}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                ref={(node) => void (buttons.current.easier = node)}
                variant="secondary"
                disabled={locked || swapBlocked !== null}
                loading={busy === 'easier'}
                aria-describedby={swapBlocked === null ? undefined : swapReasonId}
                onClick={() => void run({ kind: 'swap', direction: 'easier' })}
              >
                {t('swap.tooHard')}
              </Button>
              <Button
                ref={(node) => void (buttons.current.harder = node)}
                variant="secondary"
                disabled={locked || swapBlocked !== null}
                loading={busy === 'harder'}
                aria-describedby={swapBlocked === null ? undefined : swapReasonId}
                onClick={() => void run({ kind: 'swap', direction: 'harder' })}
              >
                {t('swap.tooEasy')}
              </Button>
            </div>
            {swapBlocked === null ? null : (
              <p id={swapReasonId} className="m-0 text-base text-muted">
                {swapBlocked}
              </p>
            )}
            {failureView((action) => action.kind === 'swap')}
          </Section>
        </Card>
      </>
    );
  }

  return (
    <main className="mx-auto flex w-[min(720px,100%-24px)] flex-col gap-6 py-6 sm:w-[min(720px,100%-40px)] sm:py-10">
      {backLink}
      {!online && item !== undefined ? <Notice tone="info">{t('offline')}</Notice> : null}
      {body}
      {item === undefined || notOnboarded || slots.length === 0 ? null : (
        <div data-slot="drill" className="flex flex-col gap-6">
          {slots.map((Slot, position) => (
            <Slot key={position} />
          ))}
        </div>
      )}
    </main>
  );
}

function DrillPage() {
  const { itemId } = Route.useParams();
  // Keyed by the item, so moving to the next drill (same route, new param) starts from a clean screen.
  return <DrillScreen key={itemId} itemId={itemId} />;
}

export const Route = createFileRoute('/train/drill/$itemId')({ component: DrillPage });
