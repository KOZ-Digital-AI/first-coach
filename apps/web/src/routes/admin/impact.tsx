import { ENDPOINTS as ADMIN, type ImpactMetrics } from '@api-types/admin';
import type { Locale } from '@api-types/primitives';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { type ReactNode, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';

/**
 * /admin/impact: "Are people getting better?" An Operate-mode screen: one calm column, one headline number, then plain cards.
 * It sits under the admin layout (routes/admin/route.tsx), whose role guard is COSMETIC: the API's requireAdmin answers 401/403
 * to anyone else, and a refusal shows here as an ordinary load failure. Every string is in impact.messages.ts.
 *
 * One call, through the typed client: GET /api/admin/impact (ImpactMetrics, shared/admin.ts). Aggregates only, so nothing on
 * this screen names, ranks or compares people; progress is measured against each player's own first result.
 *
 * Readings of the criteria (each pinned by impact.test.tsx):
 * - "headline = players who improved / median improvement". ImpactMetrics has no "players who improved" count (it is aggregates
 *   only, and the count is not in the contract), so the headline is the MEDIAN IMPROVEMENT, with the number of players who
 *   retested (the players that improvement is measured on) beside it. Reported as a contract gap.
 * - The median is shown to one decimal with its sign written out (+ or a minus), plus a sentence saying which way it went, so a
 *   decline is never told by colour alone. With no retest at all (playersRetested is 0) there is nothing to compare: a dash and
 *   a sentence, never "0%" (the API sends 0 there, not null).
 * - "Zero data" = every number is 0 and no week has a session: one EmptyState replaces the headline and the cards. A single
 *   non-zero number is real data and shows the full screen (zeros then read as honest zeros).
 * - Weekly series = one row per week in the order the API sends them (oldest first): date, a CSS bar whose length is that week's
 *   share of the busiest week, and the number itself (the bar never carries the value alone). With no session in any week the
 *   list is replaced by a sentence.
 * - "Mutation buttons": the screen changes nothing, so its only action is Refresh (and Try again on a failed load). Both are
 *   disabled and aria-busy while a request is in flight, and the last good numbers stay on screen during and after a failed refresh.
 * - Training hours are rounded to one decimal here (the API sends them unrounded).
 * - Queries do not retry by themselves and do not refetch on focus; Refresh and Try again are the way to ask again.
 */

const IMPACT_KEY = ['admin', 'impact'] as const;

/** Nothing recorded at all: every total is 0 and no week holds a session. */
const isEmpty = (m: ImpactMetrics): boolean =>
  m.playersWithBaseline === 0 &&
  m.playersRetested === 0 &&
  m.sessionsCompleted === 0 &&
  m.trainingHours === 0 &&
  m.activeContributors === 0 &&
  m.verifiedCoaches === 0 &&
  m.openMethodologies === 0 &&
  m.byWeek.every((week) => week.sessionsCompleted === 0);

const round1 = (value: number): number => Math.round(value * 10) / 10;

const H2 = 'm-0 text-xl leading-[1.2] font-bold tracking-[-.025em] text-ink';

// --- states -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('impact');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-56 rounded-card" />
      <Skeleton className="h-28 rounded-card" />
      <Skeleton className="h-28 rounded-card" />
    </div>
  );
}

// --- the headline -------------------------------------------------------------------------------

function Headline({ metrics, locale }: { metrics: ImpactMetrics; locale: Locale }) {
  const { t } = useTranslation('impact');
  const retested = metrics.playersRetested > 0;
  const pct = round1(metrics.medianImprovementPct);

  // The dash and the sentence carry "nothing to compare"; the signed number and the sentence carry the direction.
  let figure = '—';
  let sentence = t('headline.none');
  let Icon = Minus;
  if (retested) {
    const magnitude = `${formatNumber(Math.abs(pct), locale)}%`;
    if (pct > 0) {
      figure = `+${magnitude}`;
      sentence = t('headline.up');
      Icon = TrendingUp;
    } else if (pct < 0) {
      figure = `−${magnitude}`;
      sentence = t('headline.down');
      Icon = TrendingDown;
    } else {
      figure = magnitude;
      sentence = t('headline.flat');
    }
  }

  return (
    <Card variant="ink" role="region" aria-labelledby="impact-headline" className="mt-8">
      <h2 id="impact-headline" className="m-0 text-xs font-bold tracking-[.12em] text-white uppercase">
        {t('headline.label')}
      </h2>
      <p className="m-0 mt-3 text-[clamp(56px,17vw,112px)] leading-[.9] font-extrabold tracking-[-.08em] wrap-break-word">{figure}</p>
      <p className="m-0 mt-4 flex items-start gap-2 text-lg leading-[1.35] font-bold">
        <Icon aria-hidden="true" className="mt-0.5 size-6 shrink-0" />
        <span className="min-w-0">{sentence}</span>
      </p>
      {retested ? (
        <p className="m-0 mt-3 text-base">{t('headline.retested', { players: formatNumber(metrics.playersRetested, locale) })}</p>
      ) : null}
      <p className="m-0 mt-3 text-sm leading-[1.45] text-white/80">{t('headline.basis')}</p>
    </Card>
  );
}

// --- the cards ----------------------------------------------------------------------------------

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <dt className="text-base font-bold text-ink">{label}</dt>
      <dd className="m-0 mt-1.5 text-[30px] leading-none font-bold tracking-[-.04em] wrap-break-word text-ink">{value}</dd>
      <dd className="m-0 mt-2 text-sm leading-[1.4] text-muted">{hint}</dd>
    </Card>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className={H2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const CARDS = 'm-0 mt-4 grid gap-3 sm:grid-cols-2';

// --- the weekly series --------------------------------------------------------------------------

function Weeks({ weeks, locale }: { weeks: ImpactMetrics['byWeek']; locale: Locale }) {
  const { t } = useTranslation('impact');
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }), [locale]);
  const max = Math.max(0, ...weeks.map((week) => week.sessionsCompleted));

  return (
    <div className="mt-8">
      <h3 id="impact-weeks" className="m-0 text-base font-bold text-ink">
        {t('weeks.title')}
      </h3>
      <p className="m-0 mt-1 text-sm text-muted">{t('weeks.lead')}</p>
      {max === 0 ? (
        <p className="m-0 mt-4 text-base text-ink">{t('weeks.none')}</p>
      ) : (
        <ol aria-labelledby="impact-weeks" className="m-0 mt-4 grid list-none gap-2 p-0">
          {weeks.map((week) => (
            <li key={week.weekStart} className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-3">
              <span className="text-sm text-muted">{date.format(new Date(`${week.weekStart}T00:00:00Z`))}</span>
              {/* The number beside it carries the value; the bar is only its length, so it is hidden from assistive tech. */}
              <span aria-hidden="true" className="block h-2.5 overflow-hidden rounded-pill bg-line">
                <span className="block h-full rounded-pill bg-accent" style={{ width: `${(week.sessionsCompleted / max) * 100}%` }} />
              </span>
              <span className="text-right text-base font-bold text-ink tabular-nums">{formatNumber(week.sessionsCompleted, locale)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// --- the page -----------------------------------------------------------------------------------

function Numbers({ metrics, locale }: { metrics: ImpactMetrics; locale: Locale }) {
  const { t } = useTranslation('impact');
  const n = (value: number) => formatNumber(value, locale);
  return (
    <>
      <Headline metrics={metrics} locale={locale} />

      <Group id="impact-players" title={t('groups.players')}>
        <dl className={CARDS}>
          <Stat label={t('cards.baseline.label')} value={n(metrics.playersWithBaseline)} hint={t('cards.baseline.hint')} />
          <Stat label={t('cards.retested.label')} value={n(metrics.playersRetested)} hint={t('cards.retested.hint')} />
        </dl>
      </Group>

      <Group id="impact-practice" title={t('groups.practice')}>
        <dl className={CARDS}>
          <Stat label={t('cards.sessions.label')} value={n(metrics.sessionsCompleted)} hint={t('cards.sessions.hint')} />
          <Stat label={t('cards.hours.label')} value={n(round1(metrics.trainingHours))} hint={t('cards.hours.hint')} />
        </dl>
        <Weeks weeks={metrics.byWeek} locale={locale} />
      </Group>

      <Group id="impact-commons" title={t('groups.commons')}>
        <dl className={CARDS}>
          <Stat label={t('cards.contributors.label')} value={n(metrics.activeContributors)} hint={t('cards.contributors.hint')} />
          <Stat label={t('cards.coaches.label')} value={n(metrics.verifiedCoaches)} hint={t('cards.coaches.hint')} />
          <Stat label={t('cards.methodologies.label')} value={n(metrics.openMethodologies)} hint={t('cards.methodologies.hint')} />
        </dl>
      </Group>
    </>
  );
}

function ImpactPage() {
  const { t, i18n } = useTranslation('impact');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const query = useQuery({
    queryKey: IMPACT_KEY,
    queryFn: ({ signal }) => api.get(ADMIN.getImpact.path, { schema: ADMIN.getImpact.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // React Query clears `error` the moment a retry starts when there is no data yet. Keep the last failure on screen so Try again
  // stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  let body: ReactNode;
  if (query.data !== undefined) {
    body = (
      <>
        <div className="mt-5">
          <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? t('refresh.busy') : t('refresh.label')}
          </Button>
        </div>
        {/* A failed refresh keeps the last good numbers below it and says so. */}
        {query.error !== null ? (
          <Notice tone="warn" className="mt-4">
            {t('refresh.error')}
          </Notice>
        ) : null}
        {isEmpty(query.data) ? (
          <EmptyState className="mt-8" title={t('empty.title')} hint={t('empty.hint')} />
        ) : (
          <Numbers metrics={query.data} locale={locale} />
        )}
      </>
    );
  } else if (failure !== null) {
    body = (
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
    body = <Loading />;
  }

  return (
    <main className="mx-auto w-full max-w-190 px-3 pt-8 pb-13.5 sm:px-5">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
      <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
      {body}
    </main>
  );
}

export const Route = createFileRoute('/admin/impact')({ component: ImpactPage });
