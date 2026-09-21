import { ENDPOINTS } from '@api-types/stats';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/empty-state';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
// Importing lib/i18n registers the i18n instance before the first render (see the convention in that file).
import { formatNumber, toLocale } from '../lib/i18n';

/**
 * / : the landing page. Persuade mode, but calm: one headline, one primary action, the dedication card, four real
 * numbers and the six steps of how the product works. All words live in features/landing/landing.messages.ts
 * (namespace `landing`). It says nothing about a monument and promises no career to a child (PRODUCT.md).
 *
 * Readings of the criteria:
 * - START TRAINING / CONTRIBUTE are the two buttons. They navigate, so they are real links styled like the Button primitive
 *   (the primitive is a <button>), at least 44px tall. Their targets (/train, /contribute) belong to later beads and are not
 *   in the route tree yet, so they are plain anchors (a hard navigation); a typed <Link> would not compile until then.
 * - The page makes no mutation. "Mutation buttons are disabled while a request is in flight" is met by the one control that
 *   sends a request, the stat strip's retry: it is disabled (and shows a spinner) while its request runs. The CTAs are links
 *   and stay usable in every state, including error.
 * - Empty means the four counts are all zero (nothing published yet): the strip then says so in words instead of showing
 *   four zeros. A single zero among real numbers is still shown as a number.
 * - The stat strip is fed by GET /api/commons/stats: one call per render. The call is not retried by itself (the retry is the
 *   visitor's, so the quiet retry appears at once) and does not repeat when the tab regains focus.
 * - The stat labels sit before their numbers in the markup ("Sports: 1") so no plural agreement is needed in ru or kk; from
 *   600px the number is drawn above its label.
 * - The 60 is the dedication numeral (the 60th birthday), not data, so it is fixed and hidden from assistive technology: the
 *   summary sentence next to it already starts with "60".
 * - The how-it-works copy names no AI and no "verified" drills: the LLM is optional and the seeded drills are community drafts.
 */

export const Route = createFileRoute('/')({ component: LandingPage });

const STAT_IDS = ['drills', 'tracks', 'contributions', 'sports'] as const;
const STEP_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;

// The Button primitive's own classes (components/ui/button.tsx), applied to anchors. Same tap size, radius and focus ring
// (the global :focus-visible rule); primary is the only filled dark control and lifts 1px on hover when motion is allowed.
const CTA =
  'inline-flex min-h-tap min-w-tap w-full max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere min-[600px]:w-auto motion-safe:transition-transform';
const CTA_PRIMARY = `${CTA} border-ink bg-ink text-white motion-safe:hover:-translate-y-px`;
const CTA_SECONDARY = `${CTA} border-line bg-paper text-ink`;

// Cells of the stat strip: a ledger row on a phone (label left, number right), a stacked cell from 600px.
const CELL = 'bg-paper px-4 py-3.5 min-[600px]:p-5.5';

function useCommonsStats() {
  return useQuery({
    queryKey: ['commons', 'stats'],
    queryFn: ({ signal }) => api.get(ENDPOINTS.getStats.path, { schema: ENDPOINTS.getStats.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

function StatStrip() {
  const { t, i18n } = useTranslation('landing');
  const locale = toLocale(i18n.language);
  const stats = useCommonsStats();
  const region = useRef<HTMLElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  // A natively disabled button drops keyboard focus, so once a retry settles focus goes back to the retry button (it failed
  // again) or on to the numbers (it worked). Only set by a click on the retry, so a plain page load never moves focus.
  const restoreFocus = useRef(false);
  // The result timestamps are dependencies too: a fast retry can settle inside one render, with isFetching never seen as true.
  useEffect(() => {
    if (stats.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    (retry.current ?? region.current)?.focus();
  }, [stats.isFetching, stats.errorUpdatedAt, stats.dataUpdatedAt]);

  const data = stats.data;
  // While a retry runs react-query flips a data-less query back to "pending", so failure is remembered by its error count:
  // the strip keeps showing the retry (disabled, spinning) instead of collapsing back into skeletons and losing the button.
  const failed = data === undefined && stats.errorUpdateCount > 0;
  const pending = data === undefined && !failed;
  const empty = data !== undefined && STAT_IDS.every((id) => data[id] === 0);

  if (empty) {
    return (
      <section aria-label={t('stats.label')} ref={region} tabIndex={-1}>
        <EmptyState title={t('stats.empty.title')} hint={t('stats.empty.hint')} />
      </section>
    );
  }

  return (
    <section aria-label={t('stats.label')} aria-busy={pending} ref={region} tabIndex={-1}>
      <div className="overflow-hidden rounded-card border border-line">
        {pending ? (
          <>
            <p role="status" className="sr-only">
              {t('stats.loading')}
            </p>
            <div className="grid gap-px bg-line min-[600px]:grid-cols-2 min-[900px]:grid-cols-4">
              {STAT_IDS.map((id) => (
                <div key={id} className={clsx(CELL, 'flex items-center justify-between gap-3 min-[600px]:flex-col min-[600px]:items-start')}>
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-7 w-14" />
                </div>
              ))}
            </div>
          </>
        ) : data !== undefined ? (
          <ul role="list" className="grid gap-px bg-line min-[600px]:grid-cols-2 min-[900px]:grid-cols-4">
            {STAT_IDS.map((id) => (
              <li
                key={id}
                className={clsx(
                  CELL,
                  'flex items-baseline justify-between gap-3 min-[600px]:flex-col-reverse min-[600px]:items-start min-[600px]:justify-end min-[600px]:gap-1',
                )}
              >
                <span className="min-w-0 text-base wrap-anywhere text-muted">{t(`stats.${id}`)}</span>
                <span className="text-[26px] leading-none font-bold tracking-[-.04em] text-ink tabular-nums min-[600px]:text-[30px]">
                  {formatNumber(data[id], locale)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div role="status" className="flex flex-col gap-3 bg-paper p-4 min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between">
            <div className="min-w-0 wrap-anywhere">
              <p className="text-base font-bold text-ink">{t('stats.error.title')}</p>
              <p className="text-base text-muted">{t('stats.error.message')}</p>
            </div>
            <Button
              ref={retry}
              variant="secondary"
              loading={stats.isFetching}
              onClick={() => {
                restoreFocus.current = true;
                void stats.refetch();
              }}
              className="w-full min-[600px]:w-auto"
            >
              {t('stats.error.retry')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function DedicationCard() {
  const { t, i18n } = useTranslation('landing');
  return (
    <aside aria-label={t('card.label')}>
      <Card variant="ink" className="flex min-h-80 flex-col justify-between gap-8 min-[900px]:min-h-107.5">
        {/* Numeral: 96px up to 600px, 128px above (DESIGN.md). Hidden from assistive tech: the summary starts with "60". */}
        <p
          aria-hidden="true"
          className="text-[96px] leading-[.8] font-extrabold tracking-[-.08em] min-[600px]:text-[128px]"
        >
          {formatNumber(60, toLocale(i18n.language))}
        </p>
        <div>
          <p className="text-[28px] leading-[1.1] font-bold wrap-break-word min-[600px]:text-[32px]">
            <span className="block">{t('card.summary.years')}</span>{' '}
            <span className="block">{t('card.summary.sessions')}</span>{' '}
            <span className="block">{t('card.summary.free')}</span>
          </p>
          <p className="mt-4 text-base text-white/80">{t('card.credit')}</p>
          <p className="mt-1 text-base text-white/80">{t('card.dedication')}</p>
        </div>
      </Card>
    </aside>
  );
}

function HowItWorks() {
  const { t } = useTranslation('landing');
  return (
    <section aria-labelledby="how-heading" className="pt-13.5">
      <p className="text-xs font-bold tracking-[.12em] text-accent uppercase">{t('how.eyebrow')}</p>
      <h2
        id="how-heading"
        className="mt-3 max-w-190 text-[clamp(32px,5vw,60px)] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink"
      >
        {t('how.title')}
      </h2>
      <p className="mt-4 max-w-190 text-lg leading-[1.5] wrap-break-word text-muted">{t('how.intro')}</p>
      <ol role="list" className="mt-8 grid gap-4 min-[600px]:grid-cols-2 min-[900px]:grid-cols-3">
        {STEP_IDS.map((id, index) => (
          <li key={id}>
            <Card className="flex h-full items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-pill bg-accent-2 font-extrabold text-ink"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-break-word text-ink">
                  {t(`how.steps.${id}.title`)}
                </h3>
                <p className="mt-2 text-base leading-[1.45] text-muted">{t(`how.steps.${id}.body`)}</p>
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LandingPage() {
  const { t } = useTranslation('landing');
  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-9 pb-13.5 sm:px-5 min-[900px]:pt-23">
      <div className="grid items-center gap-10 min-[900px]:grid-cols-[1.12fr_.88fr] min-[900px]:gap-16">
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
          <h1 className="mt-4 max-w-225 text-[clamp(48px,7vw,96px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">
            {t('headline')}
          </h1>
          <p className="mt-6 max-w-180 text-lg leading-[1.45] wrap-break-word text-ink min-[600px]:text-xl">{t('intro')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="/train" className={CTA_PRIMARY}>
              {t('cta.start')}
            </a>
            <a href="/contribute" className={CTA_SECONDARY}>
              {t('cta.contribute')}
            </a>
          </div>
        </div>
        <DedicationCard />
      </div>
      <div className="mt-9 min-[900px]:mt-12">
        <StatStrip />
      </div>
      <HowItWorks />
    </main>
  );
}
