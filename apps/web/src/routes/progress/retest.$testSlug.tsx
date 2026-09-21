import type { SkillTest } from '@api-types/domain';
import { ENDPOINTS, Journey, type JourneyTest, type TestResultsRequest, TestResultsResponse } from '@api-types/journey';
import { ENDPOINTS as ONBOARDING, OnboardingOptions } from '@api-types/onboarding';
import { type Locale, pickLocalized } from '@api-types/primitives';
import { keepPreviousData, type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, CircleAlert, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /progress/retest/:testSlug: RETEST. An Operate-mode screen, one calm column at 360px. It shows how to take one skill test
 * again, the player's previous result and one numeric box; saving sends ONE POST /api/player/test-results and answers with
 * the comparison "Your previous result: 14 · Today: 21 · +50%", built from the RESPONSE (the server's journey row for this
 * test), never from what was typed. Every string lives in features/journey/retest.messages.ts.
 *
 * Only `Route` is exported: the route splitter leaves every other export in the entry chunk (see routes/train/onboarding.tsx).
 *
 * Readings of the criteria where they are open:
 * - Data. Two reads, no more: the test itself (protocol, unit, direction) comes from GET /api/onboarding/football, the same
 *   query (and cache key) the onboarding wizard uses, because that is the one endpoint that carries the localised protocol;
 *   the previous result is the `latest` of this test's row in GET /api/player/journey (same key as /progress). A test the
 *   player has no result for yet simply has no previous result.
 * - States. loading = a named busy status; error = ErrorState (generic localised words, never the server's text) whose Try
 *   again is natively disabled and busy while the refetch is in flight; empty = the API's 404/401 for the journey (no profile
 *   or no session: nothing to retest yet, so it leads to START TRAINING) or a slug that is not a skill test of this sport;
 *   disabled = the box and the Save button while the POST is in flight (and a ref refuses a second submit in the same tick);
 *   success = the comparison.
 * - Input. ONE box. A time (lower is better) may have decimals (a comma counts as the point), a count must be whole; never
 *   negative, never blank, never non-finite (the API refuses a negative value too). Nothing is sent until it parses. The
 *   optional `errors` and `attempts` of the contract are not collected here.
 * - Retries. The clientUuid belongs to the attempt: the same number keeps the same uuid (so a retry after a dropped
 *   connection is a replay the server ignores), a changed number is a new attempt with a new one. The offline outbox is not
 *   wired to this screen; a failed save is shown, and the player presses Save again.
 * - Personal best. Earned when this result is strictly better (by the test's direction) than every earlier result in the
 *   response's history. Equalling the old best is not a new one. Otherwise the standing best is named, calmly.
 * - Tone. A lower result is neutral (no red, no alarm role): "Lower than last time", "Results go up and down", and a link to
 *   continue the plan. `changePct` is signed so that a positive number is ALWAYS an improvement, also for a time.
 * - Sport. `football`, as the onboarding wizard (the profile has no sport).
 * - Links. Back to /progress is a router Link; /train is a plain anchor because that route belongs to another bead and is
 *   not in the route tree yet (same reading as routes/progress/index.tsx).
 * - If the response somehow has no row for this test, the typed number is shown as today's result, with no comparison.
 */

const SPORT = 'football';
/** Where START TRAINING and Continue my plan lead (a plain anchor: the route is not in the tree yet). */
const TRAIN_PATH = '/train';

const MINUS = '−';
const NBSP = ' ';

// --- data ---------------------------------------------------------------------------------------

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// The same request and cache key as the onboarding wizard (routes/train/onboarding.tsx).
const fetchOptions = (locale: Locale, signal: AbortSignal): Promise<OnboardingOptions> =>
  api.get(`${ONBOARDING.getOptions.path.replace(':sport', encodeURIComponent(SPORT))}?${new URLSearchParams({ locale })}`, {
    schema: OnboardingOptions,
    signal,
  });

// The same request and cache key as /progress (routes/progress/index.tsx), so both screens share one journey.
function fetchJourney(locale: Locale, signal: AbortSignal): Promise<Journey> {
  const zone = browserTimeZone();
  return api.get(`${ENDPOINTS.getJourney.path}?locale=${locale}`, {
    schema: Journey,
    signal,
    ...(zone === undefined ? {} : { headers: { 'X-Timezone': zone } }),
  });
}

/** 404 (no profile yet) and 401 (no session yet): either way this player has no journey, which is not a failure. */
const hasNoJourney = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'unauthorized');

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

// --- parsing ------------------------------------------------------------------------------------

type Invalid = 'empty' | 'notNumber' | 'negative' | 'whole' | 'tooBig';
type Parsed = { ok: true; value: number } | { ok: false; reason: Invalid };

/** Non-negative finite number; a comma counts as the decimal point; `decimals: false` needs a whole number. */
function parseAmount(raw: string, decimals: boolean): Parsed {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (/^-\d+(?:[.,]\d+)?$/.test(text)) return { ok: false, reason: 'negative' };
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return { ok: false, reason: 'notNumber' };
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value)) return { ok: false, reason: 'tooBig' };
  if (!decimals && /[.,]/.test(text)) return { ok: false, reason: 'whole' };
  return { ok: true, value };
}

/** "1. Warm up." -> "Warm up." One step per non-blank line; the wording is left as given. */
function protocolSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((line) => line !== '');
}

// --- formatting ---------------------------------------------------------------------------------

/** `21 touches`; the unit is the API's plain text, shown as sent. */
const withUnit = (value: number, unit: string, locale: Locale): string => `${formatNumber(value, locale)}${NBSP}${unit}`;

const LOCALE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };

/** The API's metric is plain lower-case text ("sprint over 20 m"); a title starts with a capital. */
const capitalise = (text: string, locale: Locale): string => text.charAt(0).toLocaleUpperCase(LOCALE_TAGS[locale]) + text.slice(1);

/** One decimal at most; the sign is decided AFTER rounding, so 0.04 reads as a plain 0%. */
function formatChange(changePct: number, locale: Locale): { text: string; trend: 'better' | 'same' | 'lower' } {
  const size = Math.round(Math.abs(changePct) * 10) / 10;
  if (size === 0) return { text: '0%', trend: 'same' };
  return changePct > 0 ? { text: `+${formatNumber(size, locale)}%`, trend: 'better' } : { text: `${MINUS}${formatNumber(size, locale)}%`, trend: 'lower' };
}

const isBetter = (direction: SkillTest['direction'], value: number, than: number): boolean => (direction === 'higher' ? value > than : value < than);

// --- shared styling -----------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK_BASE} border-ink bg-paper text-ink`;

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';

const TREND = {
  better: { icon: TrendingUp, chip: 'border-transparent bg-accent-2', key: 'result.better' },
  same: { icon: Minus, chip: 'border-line bg-bg', key: 'result.same' },
  lower: { icon: TrendingDown, chip: 'border-line bg-bg', key: 'result.lower' },
} as const;

// --- pieces -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('retest');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
    </div>
  );
}

function Protocol({ test, locale }: { test: SkillTest; locale: Locale }) {
  const { t } = useTranslation('retest');
  const text = pickLocalized(test.protocol, locale);
  const steps = text === undefined ? [] : protocolSteps(text);
  if (steps.length === 0) return null;
  return (
    <Card className="mt-6 grid gap-3">
      <h2 className="m-0 text-xl leading-tight font-bold tracking-tight text-ink">
        {t('protocol.title')}
      </h2>
      <ol className="m-0 grid list-decimal gap-2 pl-6 text-base leading-[1.45] text-ink marker:font-bold">
        {steps.map((step, index) => (
          <li key={`${index}-${step}`} className="pl-1 wrap-anywhere">
            {step}
          </li>
        ))}
      </ol>
    </Card>
  );
}

type FormProps = { test: SkillTest; testSlug: string; previous: number | undefined; locale: Locale; onSaved: (response: TestResultsResponse, typed: number) => void };

function RetestForm({ test, testSlug, previous, locale, onSaved }: FormProps) {
  const { t } = useTranslation('retest');
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState('');
  const [invalid, setInvalid] = useState<Invalid | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  // One uuid per attempt: the same number reuses it (a retry is a replay), a changed number gets a new one.
  const ids = useRef(new Map<number, string>());
  const decimals = test.direction === 'lower';

  const save = useMutation({
    mutationFn: (value: number): Promise<TestResultsResponse> => {
      let clientUuid = ids.current.get(value);
      if (clientUuid === undefined) {
        clientUuid = crypto.randomUUID();
        ids.current.set(value, clientUuid);
      }
      const request: TestResultsRequest = { results: [{ testSlug, value, clientUuid }] };
      return api.post(ENDPOINTS.postTestResults.path, { body: request, schema: TestResultsResponse });
    },
    onSuccess: (response, value) => {
      // The progress screen must not keep showing the numbers from before this retest.
      void queryClient.invalidateQueries({ queryKey: ['journey'] });
      onSaved(response, value);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  // A natively disabled control can drop keyboard focus: after a failed save, put it back on Save.
  useEffect(() => {
    if (save.isError) formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  }, [save.isError]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlight.current) return;
    const parsed = parseAmount(raw, decimals);
    save.reset();
    if (!parsed.ok) {
      setInvalid(parsed.reason);
      inputRef.current?.focus();
      return;
    }
    setInvalid(null);
    inFlight.current = true;
    save.mutate(parsed.value);
  }

  const pending = save.isPending;
  const failure = save.isError ? describeProblem(save.error, (key) => t(key)) : null;

  return (
    <Card className="mt-6 grid gap-5">
      {previous === undefined ? (
        <p className="m-0 text-base text-muted">{t('previous.none')}</p>
      ) : (
        <p className="m-0 flex flex-col gap-1">
          <span className="text-base text-muted">{t('previous.label')}</span>{' '}
          <strong className="text-[30px] leading-none font-bold tracking-[-.04em] text-ink">{withUnit(previous, test.unit, locale)}</strong>
        </p>
      )}
      <form ref={formRef} noValidate onSubmit={submit}>
        <fieldset disabled={pending} className="m-0 grid min-w-0 gap-4 border-0 p-0">
          <Field label={t('form.label')} hint={t('form.hint', { unit: test.unit })} error={invalid === null ? undefined : t(`invalid.${invalid}`)}>
            {(control) => (
              <input
                {...control}
                ref={inputRef}
                disabled={pending}
                type="text"
                inputMode={decimals ? 'decimal' : 'numeric'}
                enterKeyHint="done"
                autoComplete="off"
                value={raw}
                onChange={(event) => {
                  setRaw(event.target.value);
                  setInvalid(null);
                }}
              />
            )}
          </Field>
          {failure === null ? null : (
            <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
              <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                <p className="m-0 font-bold">{t('saveError.title')}</p>
                <p className="m-0 text-muted">{failure.formMessage}</p>
                <p className="m-0">{t('saveError.hint')}</p>
              </div>
            </div>
          )}
          <Button type="submit" loading={pending} className="w-full sm:w-auto">
            {t('form.submit')}
          </Button>
        </fieldset>
      </form>
    </Card>
  );
}

type Saved = { response: TestResultsResponse; typed: number };

function Result({ test, testSlug, saved, locale }: { test: SkillTest; testSlug: string; saved: Saved; locale: Locale }) {
  const { t } = useTranslation('retest');
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The form that was just replaced held the focus: move it to what is new.
  useEffect(() => headingRef.current?.focus(), []);

  const row: JourneyTest | undefined = saved.response.journey.tests.find((candidate) => candidate.testSlug === testSlug);
  const today = row?.latest ?? saved.typed;
  const previous = row?.previous;
  const change = previous === undefined || row?.changePct === undefined ? undefined : formatChange(row.changePct, locale);
  const Trend = change === undefined ? undefined : TREND[change.trend].icon;
  const earlier = (row?.history ?? []).slice(0, -1).map((point) => point.value);
  const newBest = previous !== undefined && earlier.length > 0 && earlier.every((value) => isBetter(test.direction, today, value));

  return (
    <section aria-labelledby="retest-result" className="mt-6">
      <Card elevated className="grid gap-5">
        <h2 id="retest-result" ref={headingRef} tabIndex={-1} className={H2}>
          {t('result.title')}
        </h2>

        <div className="grid gap-3">
          {previous === undefined ? null : (
            <p className="m-0 flex flex-col gap-1">
              <span className="text-base text-muted">{t('result.previous')}</span>{' '}
              <strong className="text-2xl leading-tight font-bold tracking-tight text-ink">{withUnit(previous, test.unit, locale)}</strong>
            </p>
          )}
          <p className="m-0 flex flex-col gap-1">
            <span className="text-base text-muted">{t('result.today')}</span>{' '}
            <strong className="text-[30px] leading-none font-bold tracking-[-.04em] text-ink">{withUnit(today, test.unit, locale)}</strong>
          </p>
        </div>

        {change !== undefined && Trend !== undefined ? (
          <p className={`m-0 inline-flex max-w-full items-center gap-2 self-start rounded-pill border px-3.5 py-2 text-base text-ink ${TREND[change.trend].chip}`}>
            <Trend aria-hidden="true" className="size-5 shrink-0" />
            <span className="font-bold">{change.text}</span>
            <span>{t(TREND[change.trend].key)}</span>
          </p>
        ) : null}

        {previous === undefined ? <p className="m-0 text-base text-ink">{t('result.first')}</p> : null}

        {newBest ? (
          <Notice role="note">{t('result.personalBest', { value: withUnit(today, test.unit, locale) })}</Notice>
        ) : previous !== undefined && row !== undefined ? (
          <p className="m-0 text-base text-muted">{t('result.personalBestKept', { value: withUnit(row.personalBest, test.unit, locale) })}</p>
        ) : null}

        {change?.trend === 'lower' ? (
          <Notice role="note">
            <div className="flex flex-col gap-1">
              <p className="m-0 font-bold">{t('result.encourageTitle')}</p>
              <p className="m-0">{t('result.encourageHint')}</p>
            </div>
          </Notice>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link to="/progress" className={LINK_PRIMARY}>
            {t('actions.journey')}
          </Link>
          {change?.trend === 'lower' ? (
            <a href={TRAIN_PATH} className={LINK_SECONDARY}>
              {t('actions.plan')}
            </a>
          ) : null}
        </div>
      </Card>
    </section>
  );
}

// --- the page -----------------------------------------------------------------------------------

function RetestPage() {
  const { t, i18n } = useTranslation('retest');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const { testSlug } = Route.useParams();
  const [saved, setSaved] = useState<Saved | null>(null);

  // Switching language refetches (protocols and names are language-specific); keep the old screen up meanwhile so a typed
  // number or a saved result is not lost to a skeleton flash.
  const options = useQuery({
    queryKey: ['onboarding-options', SPORT, locale],
    queryFn: ({ signal }) => fetchOptions(locale, signal),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const journey = useQuery({
    queryKey: ['journey', locale],
    queryFn: ({ signal }) => fetchJourney(locale, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const optionsFailure = useFailure(options);
  const journeyFailure = useFailure(journey);
  const failure = optionsFailure ?? (hasNoJourney(journeyFailure) ? null : journeyFailure);

  const test = options.data?.tests.find((candidate) => candidate.slug === testSlug);
  const row = journey.data?.tests.find((candidate) => candidate.testSlug === testSlug);
  // The title waits for both answers so it does not flip from the API's plain metric to the journey's localised name.
  const name = journey.data === undefined ? undefined : (row?.name ?? (test === undefined ? undefined : capitalise(test.metric, locale)));

  let body: ReactNode;
  if (failure !== null) {
    body = (
      <ErrorState
        className="mt-8"
        title={t('error.title')}
        message={describeProblem(failure, (key) => t(key)).formMessage}
        retryLabel={t('error.retry')}
        retrying={options.isFetching || journey.isFetching}
        onRetry={() => {
          if (optionsFailure !== null) void options.refetch();
          if (journeyFailure !== null && !hasNoJourney(journeyFailure)) void journey.refetch();
        }}
      />
    );
  } else if (journeyFailure !== null) {
    body = (
      <EmptyState
        className="mt-8"
        title={t('empty.noJourney.title')}
        hint={t('empty.noJourney.hint')}
        action={
          <a href={TRAIN_PATH} className={LINK_PRIMARY}>
            {t('empty.noJourney.action')}
          </a>
        }
      />
    );
  } else if (options.data === undefined || journey.data === undefined) {
    body = <Loading />;
  } else if (test === undefined) {
    body = (
      <EmptyState
        className="mt-8"
        title={t('empty.unknown.title')}
        hint={t('empty.unknown.hint')}
        action={
          <Link to="/progress" className={LINK_PRIMARY}>
            {t('empty.unknown.action')}
          </Link>
        }
      />
    );
  } else if (saved !== null) {
    body = <Result test={test} testSlug={testSlug} saved={saved} locale={locale} />;
  } else {
    body = (
      <>
        <Protocol test={test} locale={locale} />
        <RetestForm
          test={test}
          testSlug={testSlug}
          previous={row?.latest}
          locale={locale}
          onSaved={(response, typed) => setSaved({ response, typed })}
        />
      </>
    );
  }

  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <div className="max-w-160">
        <Link to="/progress" className="-ml-2 inline-flex min-h-tap min-w-tap items-center gap-2 rounded-control px-2 font-bold text-ink">
          <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
          {t('back')}
        </Link>
        <p className="m-0 mt-4 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1 className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink">
          {name ?? t('title')}
        </h1>
        {test === undefined ? null : <p className="m-0 mt-3 text-base text-muted">{t(`direction.${test.direction}`)}</p>}
        <p className="m-0 mt-5 text-lg leading-[1.45] wrap-break-word text-ink">{t('lead')}</p>
        {body}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/progress/retest/$testSlug')({ component: RetestPage });
