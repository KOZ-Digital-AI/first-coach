import { CalendarDate } from '@api-types/domain';
import type { Locale } from '@api-types/primitives';
import { SessionProgress } from '@api-types/session';
import { skipToken, useIsRestoring, useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ArrowRight, Check } from 'lucide-react';
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { SESSION_SUMMARY_QUERY_KEY, TODAY_QUERY_KEY } from '../../features/train/events-client';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';

/**
 * /train/summary: the calm end of a session (fc-mol-urn.10). It shows the drills completed, the minutes trained so far, the
 * current streak, the sessions finished and the next session date, with links to My Journey and back home.
 *
 * Where the numbers come from: this screen makes NO request. The events client (features/train/events-client.ts) writes the
 * answer of POST /api/player/session-events into the in-memory query cache: ['today'] (the session) and ['session-summary']
 * ({ progress, nextSessionDate, sessionId }). Both are plain cache reads (`queryFn: skipToken`: the observers can never fetch).
 *
 * Readings of the criteria where they are open, and gaps found:
 *  - "Finished": the summary is there, its sessionId equals the ['today'] session's id, and that session has drills that are all
 *    done. Otherwise the player is sent to /train (history replace, once) and meanwhile sees an empty state that links there.
 *    GAP: the events client writes ['session-summary'] for ANY accepted batch (a drill_done response also carries progress), so
 *    the extra "every drill is done" check is what keeps a half-done session out; a session whose drills are all done but that
 *    was never finished (session_finished not sent) still shows the summary if the player opens this URL by hand, with the
 *    progress as of the last batch. The contract has no `finished` flag on TodaySession to check.
 *  - "Minutes trained today": SessionProgress.minutesTrained sums every done drill of every session, so it is shown as a
 *    cumulative figure ("Minutes trained so far"), never as "today" (coordinator decision).
 *  - "Drills completed" is this session's done drills out of its total, from ['today'] (SessionProgress counts sessions, not drills).
 *  - The next session date is a calendar day (YYYY-MM-DD): it is formatted in UTC so the device's time zone can not shift it.
 *  - Loading: the query cache is still being restored (the persisted cache restores ['today'] on a cold start; the summary key is
 *    never persisted, so after a reload the player lands on /train). Empty: nothing finished. Error: the cached summary is not
 *    the contract's shape (nothing sensible to show); its one action leads back to /train. Success: the summary.
 *  - Disabled: the screen has no mutation and sends no request, so there is no button that could be disabled in flight.
 *  - Links are plain anchors that navigate through the router (like /train's drill rows): the target routes belong to other beads.
 *  - Only `Route` and the small SummaryDepsContext seam are exported (see /train for why the page itself is not).
 */

const TRAIN_PATH = '/train';
const JOURNEY_PATH = '/progress';
const HOME_PATH = '/';

// --- dependencies -----------------------------------------------------------------------------------------------------------

/** The seam for tests (nothing in the app provides it): how the screen navigates. */
export const SummaryDepsContext = createContext<{ navigate?: (to: string, options?: { replace?: boolean }) => void }>({});

// --- data ---------------------------------------------------------------------------------------------------------------------

/** The events client's SessionSummary, checked again on the way out of the cache (the cache can hold anything). */
const CachedSummary = z.object({ progress: SessionProgress, nextSessionDate: CalendarDate, sessionId: z.string() });

type SessionState = { id?: unknown; items?: unknown };

/** Finished = the summary belongs to the ['today'] session and every one of that session's drills is done. */
function isFinished(summary: unknown, today: unknown): boolean {
  if (typeof summary !== 'object' || summary === null || typeof today !== 'object' || today === null) return false;
  const { sessionId } = summary as { sessionId?: unknown };
  const { id, items } = today as SessionState;
  if (typeof sessionId !== 'string' || sessionId !== id) return false;
  return Array.isArray(items) && items.length > 0 && items.every((item) => (item as { done?: unknown } | null)?.done === true);
}

const DATE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };

/** `2026-09-23` -> "Wednesday, September 23" (per language). A calendar day, so UTC keeps it on that day everywhere. */
function formatDay(date: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(DATE_TAGS[locale], { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

// --- pieces -------------------------------------------------------------------------------------------------------------------

const H1 = 'm-0 text-[length:clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-0.05em] wrap-break-word text-ink';
const LINK =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere no-underline motion-safe:transition-transform';
const LINK_PRIMARY = `${LINK} border-ink bg-ink text-white motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK} border-line bg-paper text-ink`;

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-base font-bold text-muted">{label}</dt>
      <dd className="m-0 text-[26px] leading-tight font-bold tracking-[-0.04em] wrap-anywhere text-ink">{children}</dd>
    </div>
  );
}

// --- the page -----------------------------------------------------------------------------------------------------------------

function SummaryPage() {
  const { t, i18n } = useTranslation('summary');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const router = useRouter({ warn: false });
  const injected = useContext(SummaryDepsContext);
  const navigate =
    injected.navigate ?? ((to: string, options?: { replace?: boolean }) => (options?.replace === true ? router?.history.replace(to) : router?.history.push(to)));

  // Plain cache reads: `skipToken` means these observers can never fetch, whatever is (not) in the cache.
  const restoring = useIsRestoring();
  const summaryQuery = useQuery<unknown>({ queryKey: SESSION_SUMMARY_QUERY_KEY, queryFn: skipToken });
  const todayQuery = useQuery<unknown>({ queryKey: TODAY_QUERY_KEY, queryFn: skipToken });

  const finished = isFinished(summaryQuery.data, todayQuery.data);
  const unfinished = !restoring && !finished;
  useEffect(() => {
    if (unfinished) navigate(TRAIN_PATH, { replace: true });
    // `navigate` is a fresh closure on every render; the redirect must fire once per change, not once per render.
  }, [unfinished]);

  function go(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }

  const parsed = finished ? CachedSummary.safeParse(summaryQuery.data) : undefined;
  let heading = t('eyebrow');
  let body: ReactNode;

  if (restoring) {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <p className="m-0 text-base text-muted">{t('loading')}</p>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-2/3" />
      </div>
    );
  } else if (!finished) {
    body = (
      <EmptyState
        title={t('empty.title')}
        hint={t('empty.hint')}
        action={
          <a href={TRAIN_PATH} onClick={(event) => go(event, TRAIN_PATH)} className={LINK_PRIMARY}>
            {t('empty.action')}
          </a>
        }
      />
    );
  } else if (parsed === undefined || !parsed.success) {
    body = <ErrorState title={t('error.title')} message={t('error.message')} retryLabel={t('error.action')} onRetry={() => navigate(TRAIN_PATH)} />;
  } else {
    const { progress, nextSessionDate } = parsed.data;
    const items = (todayQuery.data as { items: Array<{ done: boolean }> }).items;
    const done = items.filter((item) => item.done).length;
    heading = t('title');
    body = (
      <>
        <Card variant="ink" className="flex flex-col gap-3 sm:p-8">
          <dl className="m-0">
            <dt className="flex items-center gap-2 text-base font-bold text-white">
              <Check aria-hidden="true" className="size-5 shrink-0" />
              {t('stats.drills')}
            </dt>
            <dd className="m-0 mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-white">
              <span className="text-[96px] leading-[.8] font-extrabold tracking-[-0.08em] sm:text-[128px]">{formatNumber(done, locale)}</span>{' '}
              <span className="text-xl font-bold tracking-tight">{t('stats.drillsOf', { total: formatNumber(items.length, locale) })}</span>
            </dd>
          </dl>
        </Card>

        <Card className="p-5.5 sm:p-7">
          <dl className="m-0 grid gap-6 sm:grid-cols-2">
            <Stat label={t('stats.minutes')}>{formatNumber(progress.minutesTrained, locale)}</Stat>
            <Stat label={t('stats.streak')}>{formatNumber(progress.streakDays, locale)}</Stat>
            <Stat label={t('stats.sessions')}>{formatNumber(progress.sessionsCompleted, locale)}</Stat>
            <Stat label={t('stats.next')}>{formatDay(nextSessionDate, locale)}</Stat>
          </dl>
        </Card>

        <div className="flex flex-col gap-3 sm:flex-row">
          <a href={JOURNEY_PATH} onClick={(event) => go(event, JOURNEY_PATH)} className={`${LINK_PRIMARY} w-full sm:w-auto`}>
            {t('links.journey')}
            <ArrowRight aria-hidden="true" className="size-5 shrink-0" />
          </a>
          <a href={HOME_PATH} onClick={(event) => go(event, HOME_PATH)} className={`${LINK_SECONDARY} w-full sm:w-auto`}>
            {t('links.home')}
          </a>
        </div>
      </>
    );
  }

  const success = !restoring && finished && parsed?.success === true;
  return (
    <main className="mx-auto flex w-[min(840px,100%-24px)] flex-col gap-6 py-8 sm:w-[min(840px,100%-40px)] sm:py-12">
      <header className="flex flex-col gap-3">
        {success ? <p className="m-0 text-xs font-bold tracking-[0.12em] text-accent uppercase">{t('eyebrow')}</p> : null}
        <h1 className={H1}>{heading}</h1>
        {success ? <p className="m-0 max-w-[65ch] text-lg text-ink">{t('lead')}</p> : null}
      </header>
      {body}
    </main>
  );
}

export const Route = createFileRoute('/train/summary')({ component: SummaryPage });
