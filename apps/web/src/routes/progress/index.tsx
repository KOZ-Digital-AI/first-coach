import { ENDPOINTS, Journey } from '@api-types/journey';
import type { Journey as JourneyData, JourneyTest } from '@api-types/journey';
import type { Locale } from '@api-types/primitives';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Check, Circle, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { SkillTree } from '../../features/journey/SkillTree';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /progress: MY JOURNEY. An Operate-mode screen, one calm column at 360px that grows into two and four columns. ONE call,
 * GET /api/player/journey, feeds all of it (metrics, per-test history, milestones, retest prompts and the SkillTree); the
 * screen shows the player only against their own past, and every string lives in features/journey/journey.messages.ts.
 *
 * Readings of the criteria:
 * - States. loading = a named busy status with skeletons; error = ErrorState (generic localised words, never the server's
 *   text) whose Try again is natively disabled and busy while the refetch is in flight; empty = no sessions, no skill checks
 *   and no achieved milestone, OR the API's 404 "not onboarded" / 401 "no session" (a player with no profile has, by definition, no journey);
 *   success = the dashboard. "Disabled": this screen has no mutation (a retest is taken in its own flow), so the only
 *   control that sends a request is Try again, and it is the one that is disabled while in flight.
 * - Session. This screen does not sign anyone in (the anonymous sign-in belongs to the app shell / the training flow). A
 *   visitor with no session yet gets a 401, and a player with no session has no journey: it is the same empty state as
 *   the 404, leading to START TRAINING, not an error and not a "session expired" message.
 * - Language and time zone. `?locale=` is the active language (node and skill names are resolved server-side and the query
 *   key follows the language) and X-Timezone is the browser's IANA zone, which the API uses for the streak and milestone days.
 * - Upcoming milestones. The API lists only the ACHIEVED ones (an entry with no achievedAt would also count as upcoming), and
 *   the shared contract has no key list, so MILESTONE_KEYS is a copy of MILESTONE_KEYS in apps/api/src/player/milestones.ts
 *   (the web may only import shared/*). A key this list does not know still shows when achieved, under a generic name.
 * - Percentage. `changePct` is signed so that a positive number is ALWAYS an improvement, also for a lower-is-better test.
 *   It is shown rounded to one decimal, with a real minus sign, an icon and a written phrase, never colour alone; a fall is
 *   "lower than last time" in a neutral tone, never red, never a failure.
 * - Links, not router Links. START TRAINING and Retest now are plain anchors to TRAIN_PATH / retestPath(slug): those routes belong
 *   to other beads and are not in the route tree yet, so a typed <Link> could not compile. One constant / builder each to repoint.
 * - Retries. The query does not retry by itself: Try again is the way out, so a failure is never a silent 7-second wait.
 * - Track names. Journey.tree carries only the track SLUG (no localised name, and a second call for it would break the
 *   1-call budget), so SkillTree shows its humanised slug.
 */

/** Where START TRAINING leads (the landing page's START TRAINING goes to the same place). */
const TRAIN_PATH = '/train';
/** Where Retest now leads for one test: the retest screen /progress/retest/:testSlug. The slug is URL-encoded. */
export const retestPath = (testSlug: string): string => `/progress/retest/${encodeURIComponent(testSlug)}`;

/** Copy of MILESTONE_KEYS in apps/api/src/player/milestones.ts, in the order upcoming ones are listed. */
const MILESTONE_KEYS = ['FIRST_SESSION', 'TEN_TRAINING_DAYS', 'THOUSAND_TOUCHES', 'WEAK_FOOT_LEVEL_2', 'FIVE_HOURS_TRAINED', 'FIRST_RETEST'] as const;

const DATE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };
const MINUS = '\u2212';
const NBSP = '\u00a0';

// --- data ---------------------------------------------------------------------------------------

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function fetchJourney(locale: Locale, signal: AbortSignal): Promise<JourneyData> {
  const zone = browserTimeZone();
  return api.get(`${ENDPOINTS.getJourney.path}?locale=${locale}`, {
    schema: Journey,
    signal,
    ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
  });
}

/** 404 (no profile yet) and 401 (no session yet): either way this player has no journey to show, which is not a failure. */
const hasNoJourney = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'unauthorized');

const hasAchieved = (journey: JourneyData): boolean => journey.milestones.some((milestone) => milestone.achievedAt !== undefined);

/** Nothing to show yet: no finished session, no skill check, no milestone. */
const hasNothing = (journey: JourneyData): boolean =>
  journey.tests.length === 0 && journey.metrics.sessionsCompleted === 0 && journey.metrics.minutesTrained === 0 && !hasAchieved(journey);

// --- formatting ---------------------------------------------------------------------------------

/** `21 touches`; the unit is the API's plain text, shown as sent. */
const withUnit = (value: number, unit: string, locale: Locale): string => `${formatNumber(value, locale)}${NBSP}${unit}`;

function formatDate(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(DATE_TAGS[locale], { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** One decimal at most; the sign is decided AFTER rounding, so 0.04 reads as a plain 0%. */
function formatChange(changePct: number, locale: Locale): { text: string; trend: 'better' | 'same' | 'lower' } {
  const size = Math.round(Math.abs(changePct) * 10) / 10;
  if (size === 0) return { text: '0%', trend: 'same' };
  return changePct > 0 ? { text: `+${formatNumber(size, locale)}%`, trend: 'better' } : { text: `${MINUS}${formatNumber(size, locale)}%`, trend: 'lower' };
}

// --- shared styling -----------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere text-ink';
const LINK_PRIMARY = 'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border border-ink bg-ink px-4.5 py-2.5 text-center font-bold wrap-anywhere text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px';
const LINK_SECONDARY = `${LINK_BASE} border-ink bg-paper`;

const H2 = 'text-[clamp(28px,4vw,44px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10 grid gap-4">
      <h2 id={id} className={H2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// --- pieces -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('journey');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28 rounded-card" />
        ))}
      </div>
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
    </div>
  );
}

function Empty() {
  const { t } = useTranslation('journey');
  return (
    <EmptyState
      className="mt-8"
      title={t('empty.title')}
      hint={t('empty.hint')}
      action={
        <a href={TRAIN_PATH} className={LINK_PRIMARY}>
          {t('empty.action')}
        </a>
      }
    />
  );
}

/** A plain paper tile, not <Card>: the 2-up grid at 360px leaves no room for the card's 22px padding. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse justify-end gap-1 rounded-card border border-line bg-paper p-4 wrap-anywhere">
      <dt className="text-base leading-snug text-muted">{label}</dt>
      <dd className="m-0 text-[30px] leading-none font-bold tracking-[-.04em] text-ink">{value}</dd>
    </div>
  );
}

function Metrics({ journey, locale }: { journey: JourneyData; locale: Locale }) {
  const { t } = useTranslation('journey');
  const { metrics } = journey;
  return (
    <dl className="m-0 mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric label={t('metrics.sessions')} value={formatNumber(metrics.sessionsCompleted, locale)} />
      <Metric label={t('metrics.minutes')} value={formatNumber(metrics.minutesTrained, locale)} />
      <Metric label={t('metrics.streak')} value={formatNumber(metrics.streakDays, locale)} />
      <Metric label={t('metrics.improving')} value={formatNumber(metrics.skillsImproving, locale)} />
    </dl>
  );
}

const TREND = {
  better: { icon: TrendingUp, chip: 'border-transparent bg-accent-2', key: 'tests.better' },
  same: { icon: Minus, chip: 'border-line bg-bg', key: 'tests.same' },
  lower: { icon: TrendingDown, chip: 'border-line bg-bg', key: 'tests.lower' },
} as const;

function TestCard({ test, due, locale }: { test: JourneyTest; due: boolean; locale: Locale }) {
  const { t } = useTranslation('journey');
  // A percentage only means something next to a previous result; a lone first result has neither.
  const change = test.previous === undefined || test.changePct === undefined ? undefined : formatChange(test.changePct, locale);
  const Trend = change === undefined ? undefined : TREND[change.trend].icon;

  return (
    <li className="min-w-0">
      <Card className="flex h-full flex-col gap-4">
        <div>
          <h3 className="m-0 text-xl leading-tight font-bold tracking-tight wrap-anywhere text-ink">{test.name}</h3>
          <p className="m-0 mt-1 text-base text-muted">{t(test.direction === 'lower' ? 'tests.lowerIsBetter' : 'tests.higherIsBetter')}</p>
        </div>

        {test.previous !== undefined && test.latest !== undefined ? (
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <p className="m-0 flex flex-col">
              <span className="text-base text-muted">{t('tests.previous')}</span>
              <span className="text-2xl leading-tight font-bold tracking-tight text-ink">{withUnit(test.previous, test.unit, locale)}</span>
            </p>
            <ArrowRight aria-hidden="true" className="mb-1.5 size-6 shrink-0 text-muted" />
            <p className="m-0 flex flex-col">
              <span className="text-base text-muted">{t('tests.latest')}</span>
              <span className="text-2xl leading-tight font-bold tracking-tight text-ink">{withUnit(test.latest, test.unit, locale)}</span>
            </p>
          </div>
        ) : test.latest !== undefined ? (
          <p className="m-0 flex flex-col">
            <span className="text-base text-muted">{t('tests.first')}</span>
            <span className="text-2xl leading-tight font-bold tracking-tight text-ink">{withUnit(test.latest, test.unit, locale)}</span>
          </p>
        ) : null}

        {change !== undefined && Trend !== undefined ? (
          <p className={`m-0 inline-flex max-w-full items-center gap-2 self-start rounded-pill border px-3.5 py-2 text-base text-ink ${TREND[change.trend].chip}`}>
            <Trend aria-hidden="true" className="size-5 shrink-0" />
            <span className="font-bold">{change.text}</span>
            <span>{t(TREND[change.trend].key)}</span>
          </p>
        ) : null}

        <p className="m-0 text-base text-ink">
          <span className="text-muted">{t('tests.personalBest')}</span> <strong>{withUnit(test.personalBest, test.unit, locale)}</strong>
        </p>

        {due ? (
          <Notice role="note">
            <div className="flex flex-col items-start gap-2">
              <p className="m-0 font-bold">{t('tests.retestTitle')}</p>
              <p className="m-0">{t('tests.retestHint')}</p>
              <a href={retestPath(test.testSlug)} className={LINK_SECONDARY}>
                {t('tests.retestAction')}
                <span className="sr-only">: {test.name}</span>
              </a>
            </div>
          </Notice>
        ) : test.retestDueAt !== undefined ? (
          <p className="m-0 text-base text-muted">{t('tests.nextRetest', { date: formatDate(test.retestDueAt, locale) })}</p>
        ) : null}

        {test.history.length > 0 ? (
          <details className="border-t border-line pt-1">
            <summary className="flex min-h-tap cursor-pointer items-center text-base font-bold text-ink">
              {t('tests.allResults', { n: formatNumber(test.history.length, locale) })}
            </summary>
            <ol className="m-0 grid list-none gap-1 p-0 pb-2">
              {test.history.map((point, index) => (
                <li key={`${point.at}-${index}`} className="flex flex-wrap justify-between gap-x-3 text-base text-ink">
                  <span className="font-bold">{withUnit(point.value, test.unit, locale)}</span>
                  <span className="text-muted">{formatDate(point.at, locale)}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </Card>
    </li>
  );
}

function Tests({ journey, locale }: { journey: JourneyData; locale: Locale }) {
  const { t } = useTranslation('journey');
  const due = new Set(journey.retestsDue);
  return (
    <Section id="journey-tests" title={t('tests.title')}>
      {journey.tests.length === 0 ? (
        <p className="m-0 text-base text-muted">{t('tests.empty')}</p>
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
          {journey.tests.map((test) => (
            <TestCard key={test.testSlug} test={test} due={due.has(test.testSlug)} locale={locale} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type Badge = { key: string; name: string; achievedAt: string | undefined };

function badgesOf(journey: JourneyData, t: (key: string) => string): Badge[] {
  const known: readonly string[] = MILESTONE_KEYS;
  const nameOf = (key: string): string => t(known.includes(key) ? `milestones.names.${key}` : 'milestones.names.other');
  const achieved = journey.milestones.flatMap((milestone) =>
    milestone.achievedAt === undefined ? [] : [{ key: milestone.key, name: nameOf(milestone.key), achievedAt: milestone.achievedAt }],
  );
  const done = new Set(achieved.map((badge) => badge.key));
  const upcoming = MILESTONE_KEYS.filter((key) => !done.has(key)).map((key) => ({ key, name: nameOf(key), achievedAt: undefined }));
  return [...achieved, ...upcoming];
}

function Milestones({ journey, locale }: { journey: JourneyData; locale: Locale }) {
  const { t } = useTranslation('journey');
  return (
    <Section id="journey-milestones" title={t('milestones.title')}>
      <ul aria-label={t('milestones.title')} className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {badgesOf(journey, (key) => t(key)).map((badge) => {
          const achieved = badge.achievedAt !== undefined;
          return (
            <li
              key={badge.key}
              data-state={achieved ? 'achieved' : 'upcoming'}
              className={`flex min-h-tap min-w-0 items-start gap-3 rounded-control border px-3.5 py-2.5 ${achieved ? 'border-transparent bg-accent-2' : 'border-dashed border-line'}`}
            >
              {achieved ? <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink" /> : <Circle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />}
              <span className="flex min-w-0 flex-col">
                <span className="text-base leading-snug font-bold wrap-anywhere text-ink">{badge.name}</span>
                {/* Ink on Morning Mint (muted is not allowed there); muted on the plain page for the ones still ahead. */}
                <span className={`text-base leading-snug ${achieved ? 'text-ink' : 'text-muted'}`}>
                  {achieved ? t('milestones.achievedOn', { date: formatDate(badge.achievedAt!, locale) }) : t('milestones.upcoming')}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Dashboard({ journey, locale }: { journey: JourneyData; locale: Locale }) {
  const { t } = useTranslation('journey');
  return (
    <>
      <Metrics journey={journey} locale={locale} />
      <Tests journey={journey} locale={locale} />
      <Milestones journey={journey} locale={locale} />
      <Section id="journey-tree" title={t('tree.title')}>
        <SkillTree tree={journey.tree} />
      </Section>
    </>
  );
}

function JourneyPage() {
  const { t, i18n } = useTranslation('journey');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const query = useQuery({
    queryKey: ['journey', locale],
    queryFn: ({ signal }) => fetchJourney(locale, signal),
    // Switching language refetches (the names are resolved server-side); keep the old screen up meanwhile, no skeleton flash.
    placeholderData: keepPreviousData,
    retry: false,
  });

  // React Query clears `error` (and goes back to "pending") the moment a retry starts, when there is no data yet. Keep the last
  // failure on screen so Try again stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  let body: ReactNode;
  if (query.data !== undefined) {
    body = hasNothing(query.data) ? <Empty /> : <Dashboard journey={query.data} locale={locale} />;
  } else if (failure !== null) {
    body = hasNoJourney(failure) ? (
      <Empty />
    ) : (
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
    <main className="mx-auto w-full max-w-295 px-3 pt-8 pb-13.5 sm:px-5">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">{t('title')}</h1>
      <p className="m-0 mt-5 max-w-190 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
      {body}
    </main>
  );
}

export const Route = createFileRoute('/progress/')({ component: JourneyPage });
