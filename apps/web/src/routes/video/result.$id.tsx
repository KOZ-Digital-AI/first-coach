import { EntityId, type Locale } from '@api-types/primitives';
import { ENDPOINTS as VIDEO, RerecordReason, Rubric, type VideoAnalysis, VideoAnalysisList } from '@api-types/video';
import { keepPreviousData, type UseQueryResult, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /video/result/:id: the RESULT of one Beta AI Video Coach analysis. An Operate/Read-mode screen, one calm column at 360px. Every
 * string lives in features/video/result.messages.ts.
 *
 * Only `Route` is exported: the route splitter leaves every other export in the entry chunk (see routes/train/onboarding.tsx).
 *
 * WHAT IT SHOWS: "Your analysis" + a Beta tag; the fixed limitation line (the coach reads the pose only, the ball is not tracked);
 * the confidence in words; each rubric criterion as label + score as a NUMBER + a BAR + the note; the Focus next sentence; the
 * recommended drills (links to their commons pages, with a hint to add one to today's session); "Repeat assessment after 3
 * sessions"; the API's own limitations; and the player's EARLIER analyses of the same skill. There is NO overall score: the API has
 * none, and this screen never computes one (no sum, no mean, no "out of 100"). Every number shown is one criterion's own 1-10 score.
 *
 * DATA. There is NO single-item endpoint (contract fc-mol-0g0): the analysis is found by id in GET /api/player/video-analyses (the
 * caller's own rows only, newest first). An id that is not in that list is "not found". A finished analysis needs no second call.
 * The list is a React Query entry under ['video', 'analyses'], which is not on lib/query-persist's allow-list: nothing of it is
 * written to the device.
 *
 * THE RE-RECORD VARIANT. A rerecord verdict is NOT stored (the API keeps finished analyses only), so it has no id to look up. The
 * capture screen (routes/video/index.tsx) shows it inline today; this screen offers it as a route for a caller that wants one:
 * `/video/result/<anything>?rerecord=low_visibility|too_dark|too_short[&skill=<skillSlug>]`. When `rerecord` is a known reason the
 * id is ignored, the reason is shown with the filming tips of that skill (GET /api/video/rubrics/:skillSlug, in the active
 * language) INSTEAD of scores, and nothing else is requested. Without `skill` there are no tips to look up; a skill the rubric does
 * not know (404) leaves the reason without tips. An unknown reason is ignored (the id is looked up as usual).
 *
 * HISTORY. "Earlier analyses of the same skill" = the rows after this one in the newest-first list that have the same skillSlug.
 * They are listed with their date and their own criterion scores, for comparing with YOURSELF only: the API returns the caller's
 * rows only, and this screen adds no ranking, no best/worst and no difference figure.
 *
 * STATES. loading = a named busy status; error = ErrorState (generic localised words, never the server's text) whose Try again is
 * natively disabled and busy while the refetch is in flight; empty = no analyses at all (also the API's 404/401) or an id that is not
 * in the list; disabled = a 403 (Video Coach switched off): words and a way back, no retry; success = the analysis. The screen has
 * no mutation: the only buttons are the two Try again ones.
 *
 * Links. /video, /commons/:slug, /train and this route are router Links (all four routes exist in the tree).
 */

const LOCALE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };
const SCORE_MAX = 10;
/** The skills the messages file names; any other slug shows no skill name (nothing is guessed from a slug). */
const KNOWN_SKILLS: ReadonlySet<string> = new Set(['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination']);

// --- data ---------------------------------------------------------------------------------------

const analysesQuery = () => ({
  queryKey: ['video', 'analyses'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.get(VIDEO.listAnalyses.path, { schema: VideoAnalysisList, signal }),
  retry: false,
});

const rubricQuery = (skill: string, locale: Locale) => ({
  queryKey: ['video', 'rubric', skill, locale] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get(`${VIDEO.getRubric.path.replace(':skillSlug', encodeURIComponent(skill))}?${new URLSearchParams({ locale })}`, {
      schema: Rubric,
      signal,
    }),
  retry: false,
});

/** 404 (no profile yet) and 401 (no session yet): either way this player has no analyses, which is not a failure. */
const hasNoAnalyses = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'unauthorized');
const isForbidden = (error: unknown): boolean => isApiProblem(error) && error.kind === 'forbidden';

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

/** The route's search: a known re-record reason and a well-formed skill slug, or nothing. Anything else is dropped. */
function validateSearch(search: Record<string, unknown>): { rerecord?: RerecordReason; skill?: string } {
  const reason = RerecordReason.safeParse(search.rerecord);
  const skill = EntityId.safeParse(search.skill);
  return { ...(reason.success ? { rerecord: reason.data } : {}), ...(skill.success ? { skill: skill.data } : {}) };
}

// --- formatting ---------------------------------------------------------------------------------

const formatDate = (iso: string, locale: Locale): string => new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium' }).format(new Date(iso));

/** "7 / 10": one criterion's own score against the scale. A language-neutral number pair, not a sentence. */
const scoreText = (score: number, locale: Locale): string => `${formatNumber(score, locale)} / ${formatNumber(SCORE_MAX, locale)}`;

// --- shared styling -----------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK_BASE} border-ink bg-paper text-ink`;

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const H3 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';
const BODY = 'm-0 text-base leading-[1.45] wrap-break-word text-ink';
const MUTED = 'm-0 text-base leading-[1.45] wrap-break-word text-muted';
const ACTIONS = 'flex flex-col gap-3 sm:flex-row';

// --- pieces -------------------------------------------------------------------------------------

/** The bar of one criterion: a meter from 0 to 10. The number is always beside it (never colour alone). */
function ScoreBar({ label, score, locale }: { label: string; score: number; locale: Locale }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={SCORE_MAX}
      aria-valuenow={score}
      aria-valuetext={scoreText(score, locale)}
      className="h-2.5 overflow-hidden rounded-pill bg-line"
    >
      <div className="h-full rounded-pill bg-accent" style={{ width: `${(score / SCORE_MAX) * 100}%` }} />
    </div>
  );
}

function Loading() {
  const { t } = useTranslation('result');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-10 w-3/4" />
      <Skeleton className="h-32 rounded-card" />
      <Skeleton className="h-32 rounded-card" />
    </div>
  );
}

function Criteria({ analysis, locale }: { analysis: VideoAnalysis; locale: Locale }) {
  const { t } = useTranslation('result');
  return (
    <section aria-labelledby="criteria-title" className="grid gap-3">
      <h2 id="criteria-title" className={H2}>
        {t('criteria.title')}
      </h2>
      <p className={MUTED}>{t('criteria.lead')}</p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {analysis.scores.map((score) => (
          <li key={score.key}>
            <Card className="grid gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className={H3}>{score.label}</h3>
                <span className="shrink-0 text-xl font-bold text-ink">{scoreText(score.score, locale)}</span>
              </div>
              <ScoreBar label={score.label} score={score.score} locale={locale} />
              <p className={MUTED}>{score.note}</p>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recommended({ analysis }: { analysis: VideoAnalysis }) {
  const { t } = useTranslation('result');
  if (analysis.recommended.length === 0) return null;
  return (
    <section aria-labelledby="drills-title" className="grid gap-3">
      <h2 id="drills-title" className={H2}>
        {t('drills.title')}
      </h2>
      <p className={MUTED}>{t('drills.hint')}</p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {analysis.recommended.map((drill) => (
          <li key={drill.drillVersionId} className="grid gap-1 rounded-control border border-line bg-paper p-4">
            <Link to="/commons/$slug" params={{ slug: drill.slug }} className="inline-flex min-h-tap items-center font-bold text-ink underline">
              {drill.title}
            </Link>
            <span className="text-base text-muted">{drill.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ earlier, locale }: { earlier: readonly VideoAnalysis[]; locale: Locale }) {
  const { t } = useTranslation('result');
  return (
    <section aria-labelledby="history-title" className="grid gap-3">
      <h2 id="history-title" className={H2}>
        {t('history.title')}
      </h2>
      <p className={MUTED}>{t('history.lead')}</p>
      {earlier.length === 0 ? (
        <p className={BODY}>{t('history.none')}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {earlier.map((row) => (
            <li key={row.id} className="grid gap-2 rounded-control border border-line bg-paper p-4">
              <Link to="/video/result/$id" params={{ id: row.id }} className="inline-flex min-h-tap items-center font-bold text-ink underline">
                <time dateTime={row.createdAt}>{formatDate(row.createdAt, locale)}</time>
              </Link>
              <ul className="m-0 grid list-none gap-1 p-0">
                {row.scores.map((score) => (
                  <li key={score.key} className="flex items-baseline justify-between gap-3 text-base text-ink">
                    <span className="min-w-0 wrap-anywhere">{score.label}</span>
                    <span className="shrink-0 font-bold">{scoreText(score.score, locale)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Success({ analysis, earlier, locale }: { analysis: VideoAnalysis; earlier: readonly VideoAnalysis[]; locale: Locale }) {
  const { t } = useTranslation('result');
  return (
    <div className="mt-6 grid gap-6">
      <Notice role="note">{t('limitation')}</Notice>
      <div className="grid gap-1">
        {KNOWN_SKILLS.has(analysis.skillSlug) ? <p className={BODY}>{t('skill', { skill: t(`skills.${analysis.skillSlug}`) })}</p> : null}
        <p className={MUTED}>
          {t('analysedOn')} <time dateTime={analysis.createdAt}>{formatDate(analysis.createdAt, locale)}</time>
        </p>
        <p className={BODY}>{t('confidence', { level: t(`levels.${analysis.confidence}`) })}</p>
      </div>
      <Criteria analysis={analysis} locale={locale} />
      <Card variant="ink" className="grid gap-2">
        <h2 className="m-0 text-xl leading-tight font-bold tracking-tight text-white">{t('focus')}</h2>
        <p className="m-0 text-lg leading-[1.45]">{analysis.focusNext}</p>
      </Card>
      <Recommended analysis={analysis} />
      <p className={`${BODY} flex items-start gap-2`}>
        <RefreshCw aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <span className="min-w-0">{t('repeat', { sessions: analysis.repeatAfterSessions })}</span>
      </p>
      {analysis.limitations.length === 0 ? null : (
        <section aria-labelledby="limits-title" className="grid gap-2">
          <h2 id="limits-title" className={H3}>
            {t('limits')}
          </h2>
          <ul className="m-0 grid list-disc gap-1 pl-5">
            {analysis.limitations.map((line) => (
              <li key={line} className={MUTED}>
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}
      <History earlier={earlier} locale={locale} />
      <div className={ACTIONS}>
        <Link to="/video" className={`${LINK_PRIMARY} w-full sm:w-auto`}>
          {t('again')}
        </Link>
      </div>
    </div>
  );
}

// --- the re-record variant ----------------------------------------------------------------------

function Tips({ skill, locale }: { skill: string; locale: Locale }) {
  const { t } = useTranslation(['result', 'problem']);
  const rubric = useQuery(rubricQuery(skill, locale));
  const failure = useFailure(rubric);
  if (failure !== null) {
    // A skill without a rubric (404) simply has no tips to show: the reason above stays the whole answer.
    if (isApiProblem(failure) && failure.kind === 'not_found') return null;
    return (
      <ErrorState
        title={t('result:tips.error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('result:tips.error.retry')}
        retrying={rubric.isFetching}
        onRetry={() => void rubric.refetch()}
      />
    );
  }
  if (rubric.data === undefined) {
    return (
      <div role="status" aria-busy="true" aria-label={t('result:tips.loading')} className="grid gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }
  if (rubric.data.recordingTips.length === 0) return null;
  return (
    <section aria-labelledby="tips-title" className="grid gap-3">
      <h2 id="tips-title" className={H2}>
        {t('result:tips.title')}
      </h2>
      <ul className="m-0 grid list-disc gap-2 pl-5">
        {rubric.data.recordingTips.map((tip) => (
          <li key={tip} className={BODY}>
            {tip}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Rerecord({ reason, skill, locale }: { reason: RerecordReason; skill: string | undefined; locale: Locale }) {
  const { t } = useTranslation('result');
  return (
    <Frame heading={t(`rerecord.${reason}.title`)}>
      <div className="mt-6 grid gap-6">
        <div className="grid gap-2">
          <p className={BODY}>{t(`rerecord.${reason}.hint`)}</p>
          <p className={MUTED}>{t('rerecord.lead')}</p>
        </div>
        {skill === undefined ? null : <Tips skill={skill} locale={locale} />}
        <div className={ACTIONS}>
          <Link to="/video" className={`${LINK_PRIMARY} w-full sm:w-auto`}>
            {t('rerecord.action')}
          </Link>
        </div>
      </div>
    </Frame>
  );
}

// --- the page -----------------------------------------------------------------------------------

/** The one column: back link, the h1 (with the Beta tag beside it, never inside its name) and the body. */
function Frame({ heading, beta = true, children }: { heading: ReactNode; beta?: boolean; children: ReactNode }) {
  const { t } = useTranslation('result');
  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <div className="max-w-160">
        <Link to="/video" className="-ml-2 inline-flex min-h-tap min-w-tap items-center gap-2 rounded-control px-2 font-bold text-ink">
          <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
          {t('back')}
        </Link>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="m-0 min-w-0 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.04em] wrap-break-word text-ink">{heading}</h1>
          {beta ? <Tag tone="warning">{t('beta')}</Tag> : null}
        </div>
        {children}
      </div>
    </main>
  );
}

function AnalysisPage({ id, locale }: { id: string; locale: Locale }) {
  const { t } = useTranslation(['result', 'problem']);
  // The list is one entry for every id (opening an earlier analysis needs no new request); keep it up while a retry runs.
  const list = useQuery({ ...analysesQuery(), placeholderData: keepPreviousData });
  const failure = useFailure(list);

  const rows = list.data ?? [];
  const index = rows.findIndex((row) => row.id === id);
  const analysis = rows[index];
  const earlier = analysis === undefined ? [] : rows.slice(index + 1).filter((row) => row.skillSlug === analysis.skillSlug);

  let body: ReactNode;
  if (failure !== null && !hasNoAnalyses(failure)) {
    body = isForbidden(failure) ? (
      <EmptyState
        className="mt-8"
        title={t('result:disabled.title')}
        hint={t('result:disabled.hint')}
        action={
          <Link to="/train" className={LINK_SECONDARY}>
            {t('result:disabled.action')}
          </Link>
        }
      />
    ) : (
      <ErrorState
        className="mt-8"
        title={t('result:error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('result:error.retry')}
        retrying={list.isFetching}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (failure !== null || (list.data !== undefined && rows.length === 0)) {
    body = (
      <EmptyState
        className="mt-8"
        title={t('result:empty.none.title')}
        hint={t('result:empty.none.hint')}
        action={
          <Link to="/video" className={LINK_PRIMARY}>
            {t('result:empty.none.action')}
          </Link>
        }
      />
    );
  } else if (list.data === undefined) {
    body = <Loading />;
  } else if (analysis === undefined) {
    body = (
      <EmptyState
        className="mt-8"
        title={t('result:empty.unknown.title')}
        hint={t('result:empty.unknown.hint')}
        action={
          <Link to="/video" className={LINK_PRIMARY}>
            {t('result:empty.unknown.action')}
          </Link>
        }
      />
    );
  } else {
    body = <Success analysis={analysis} earlier={earlier} locale={locale} />;
  }

  return <Frame heading={t('result:title')}>{body}</Frame>;
}

function ResultPage() {
  const { i18n } = useTranslation('result');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const { id } = Route.useParams();
  // Validated again here: the router hands the raw search over when the route is mounted through `Route.update` (as the generated
  // route tree and the tests do), so a value that is not a known reason never reaches the variant.
  const { rerecord, skill } = validateSearch(Route.useSearch() as Record<string, unknown>);
  return rerecord === undefined ? <AnalysisPage id={id} locale={locale} /> : <Rerecord reason={rerecord} skill={skill} locale={locale} />;
}

export const Route = createFileRoute('/video/result/$id')({ validateSearch, component: ResultPage });
