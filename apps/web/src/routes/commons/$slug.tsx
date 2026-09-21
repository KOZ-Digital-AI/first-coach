import type { DrillDetail, DrillHistoryEntry } from '@api-types/commons';
import { ENDPOINTS } from '@api-types/commons-api';
import { type Locale, type LocalizedText, pickLocalized, type TrustStatus } from '@api-types/primitives';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Eye, X } from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, type Ref, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { TrustBadge } from '../../features/commons/TrustBadge';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';
import { type DrillDetailSlotProps, useSlot } from '../../lib/slots';

/**
 * /commons/:slug: DRILL DETAIL. A Read-mode screen, one calm column at 360px: one drill of the Open Sport Commons from
 * GET /api/commons/drills/:slug, with its trust, its attribution and its version history. Every string of the screen lives in
 * features/commons/detail.messages.ts (namespace `detail`); the drill's own text arrives from the API in the active language.
 *
 * Only `Route` and the small DrillDetailDepsContext seam are exported (see routes/train/onboarding.tsx for why).
 *
 * Readings of the criteria where they are open:
 * - Data. ONE read, the typed client with the contract's own response schema (`commons-api` ENDPOINTS.getDrill), cached under
 *   ['commons-drill', slug, locale]. Nothing is hard-coded and nothing else is requested: the history, the reviews and the
 *   attribution all arrive with the drill.
 * - Order. Goal, at a glance (dose and conditions), SAFETY, video, instructions, mistakes, harder, easier, who checked it,
 *   attribution, version history, then the slot. Safety sits before the instructions so it is read before the child starts.
 * - Instructions. `instructions` is one LocalizedText; a numbered text ("1. ...\n2. ...") becomes one step per line with the
 *   typed number removed (the list draws its own numbers), any other text is a single step.
 * - Age. The seeded drills give `ageMax: 99` for "no upper limit"; 99 or more reads as open-ended ("from 5"), never "5-99".
 * - Trust. DrillDetail carries no status of its own (contract gap; the list's DrillSummary has one, and its extension is on
 *   hold in bead hum.6). The status is the one the NEWEST review moved the drill to (`reviews[].to`), COMMUNITY when there is
 *   no review; the organisation on the badge is that review's. Every review is listed under it with its reviewer and note.
 * - Video. Only `media` entries of kind "video" are shown, as a native player: controls, `preload="none"` (the file is not
 *   fetched until the child presses play) and never `autoplay`. Images and documents are not shown (the criteria name a video).
 * - Dates. `attribution.createdAt` and the history and review timestamps are written as a long date in the active language,
 *   in UTC, so one instant reads the same on every device.
 * - Version history. The API lists EVERY version, the current one included, newest first. The current one is marked with the
 *   word "Current"; an older one has an "Open version X" button. KNOWN API GAPS, said on screen and here, never papered over:
 *   the text of a superseded version cannot be read (backlog fc-h2p), so "opened read-only" shows only what the history entry
 *   holds (version, date, note) with a plain sentence that the text is not published yet; and the history has no
 *   "unpublished" marker (backlog fc-3vc), so nothing is marked as withdrawn. Opening a version makes no request. It replaces
 *   the current version's sections, so the current text is never passed off as an older one; the title and the list stay.
 *   Which version is open is local state (not in the URL). Focus moves to the opened version's heading, and back to the title.
 * - States. loading = a named busy status; empty = the not-found state (a 404, or a 400 for a slug no drill can have): calm
 *   words and the way back to the library; error = ErrorState (generic localised words, never the server's text) whose Try
 *   again is natively disabled and busy while its refetch runs; disabled = that Try again button (this screen has no mutation,
 *   so there is no other button to lock); success = the drill. Every state has an h1 (generic until the title is known).
 * - Slot. Every component of the `drill-detail` slot (features/*\/drill-detail-extra.tsx) renders in
 *   `<div data-slot="drill-detail">` below the content, on success only (a slot has nothing to add to a missing drill). The
 *   slot has no props: a slot component reads the route param itself.
 * - Library link. /commons (the library, another bead) is not in the route tree yet, so the destination is typed `string`
 *   (the same reading as the shell's navigation). It is still a router link.
 * - Nothing here compares a child with anyone or promises a professional career (PRODUCT.md).
 */

/** Where the way back leads. Typed `string` on purpose: the library route is not in the tree yet (see above). */
const LIBRARY_PATH: string = '/commons';

const QUERY_KEY = 'commons-drill';

/** The seeded drills use 99 for "no upper age limit". */
const OPEN_ENDED_AGE = 99;

type Translate = (key: string, options?: Record<string, unknown>) => string;

// --- the seam for tests --------------------------------------------------------------------------------------------------------

export type DrillDetailDeps = {
  /** Overrides the components collected for the `drill-detail` slot. */
  slots: readonly ComponentType<DrillDetailSlotProps>[];
};

/**
 * The seam for tests: the slot components can be supplied through this context. Nothing in the app provides it, so the
 * glob-collected components apply. It is the ONLY export besides `Route`, and it imports nothing at runtime.
 */
export const DrillDetailDepsContext = createContext<Partial<DrillDetailDeps>>({});

// --- helpers -------------------------------------------------------------------------------------------------------------------

/** The API answers "no such drill" with 404, and 400 for a slug that is not even well formed: both mean the same to a visitor. */
const isNotFound = (error: unknown): boolean => isApiProblem(error) && (error.kind === 'not_found' || error.kind === 'validation');

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

/** `ball-mastery-ghost-ball` -> `Ball mastery ghost ball`. */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

const text = (value: LocalizedText, locale: Locale): string => pickLocalized(value, locale) ?? '';
const texts = (values: readonly LocalizedText[], locale: Locale): string[] => values.map((value) => text(value, locale)).filter((line) => line !== '');

/** "1. Stand tall.\n2. Tap." -> ["Stand tall.", "Tap."]; text with no numbering is one step per non-blank line. */
function stepsOf(instructions: string): string[] {
  return instructions
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\d+\s*[.)]\s*/, ''))
    .filter((line) => line !== '');
}

const DATE_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };

/** A long date in the active language, in UTC. Anything unreadable is shown as it came. */
function formatDate(iso: string, locale: Locale): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  try {
    return new Intl.DateTimeFormat(DATE_TAGS[locale], { dateStyle: 'long', timeZone: 'UTC' }).format(time);
  } catch {
    return iso.slice(0, 10);
  }
}

/** "from 5", "up to 12", "6-12" or nothing at all. */
function ageOf(min: number | undefined, max: number | undefined, locale: Locale, t: Translate): string | undefined {
  const from = min !== undefined && min > 0 ? min : undefined;
  const to = max !== undefined && max < OPEN_ENDED_AGE ? max : undefined;
  if (from !== undefined && to !== undefined) return t('facts.ageRange', { min: formatNumber(from, locale), max: formatNumber(to, locale) });
  if (from !== undefined) return t('facts.ageFrom', { min: formatNumber(from, locale) });
  if (to !== undefined) return t('facts.ageUpTo', { max: formatNumber(to, locale) });
  return undefined;
}

const LICENCES: Readonly<Record<string, { name: string; url: string }>> = {
  'CC-BY-SA-4.0': { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC0-1.0': { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
};

/** The newest review first, whatever order the API used. */
const newestFirst = (reviews: DrillDetail['reviews']): DrillDetail['reviews'] =>
  [...reviews].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

// --- shared styling ------------------------------------------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px`;
const TEXT_LINK = 'inline-flex min-h-tap items-center font-bold text-ink underline decoration-accent decoration-2 underline-offset-4 wrap-anywhere';

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';

// --- pieces --------------------------------------------------------------------------------------------------------------------

/** A titled block of the page: a real region named by its heading. */
function Section({ title, children, className = 'mt-12' }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={className}>
      <h2 id={id} className={H2}>
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Label / value pairs as a description list: a fixed label column, hairlines between the rows. */
function Facts({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="m-0 divide-y divide-line">
      {rows.map(({ label, value }) => (
        <div key={label} className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-x-4 py-3 first:pt-0 last:pb-0">
          <dt className="font-bold wrap-anywhere text-ink">{label}</dt>
          <dd className="m-0 wrap-anywhere text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A bulleted list of short lines, each with a small icon (never a colour alone). */
function Lines({ lines, icon: Icon }: { lines: readonly string[]; icon: typeof X }) {
  return (
    <ul role="list" className="m-0 grid list-none gap-3 p-0">
      {lines.map((line, position) => (
        <li key={`${position}-${line}`} className="flex items-start gap-3">
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 wrap-break-word">{line}</span>
        </li>
      ))}
    </ul>
  );
}

function Loading() {
  const { t } = useTranslation('detail');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-28 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
    </div>
  );
}

/** The page head: the kicker and the h1, which every state has (generic until the drill's own title is known). */
function Head({ title, headingRef, children }: { title: string; headingRef?: Ref<HTMLHeadingElement>; children?: ReactNode }) {
  const { t } = useTranslation('detail');
  return (
    <header className="mt-4">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="m-0 mt-3 text-[clamp(40px,6vw,74px)] leading-[.94] font-bold tracking-[-.065em] wrap-break-word text-ink"
      >
        {title}
      </h1>
      {children}
    </header>
  );
}

function Video({ url, caption }: { url: string; caption: string }) {
  const { t } = useTranslation('detail');
  return (
    <figure className="m-0 grid gap-2">
      {/* controls + preload="none": nothing is downloaded until the child presses play, and nothing ever autoplays. */}
      <video
        src={url}
        controls
        preload="none"
        playsInline
        aria-label={caption === '' ? t('video') : caption}
        className="aspect-video w-full rounded-card bg-ink"
      />
      {caption === '' ? null : <figcaption className="text-base text-muted">{caption}</figcaption>}
    </figure>
  );
}

function Reviews({ reviews, locale }: { reviews: DrillDetail['reviews']; locale: Locale }) {
  const { t } = useTranslation('detail');
  if (reviews.length === 0) return <p className="m-0 text-base text-ink">{t('trust.none')}</p>;
  return (
    <ul role="list" className="m-0 list-none divide-y divide-line border-y border-line p-0">
      {reviews.map((review, position) => (
        <li key={`${position}-${review.at}`} className="grid gap-2 py-4">
          <TrustBadge status={review.to} orgLabel={review.orgLabel} className="self-start" />
          <p className="m-0 wrap-anywhere text-ink">
            <strong>{review.reviewer}</strong>
            {review.orgLabel === '' ? null : ` · ${review.orgLabel}`}
          </p>
          <time dateTime={review.at} className="text-base text-muted">
            {formatDate(review.at, locale)}
          </time>
          {review.note === '' ? null : <p className="m-0 wrap-break-word text-ink">{review.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/** An earlier version, read-only: the history entry is all the API gives (see the readings above). */
function EarlierVersion({ entry, locale, onBack }: { entry: DrillHistoryEntry; locale: Locale; onBack: () => void }) {
  const { t } = useTranslation('detail');
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The button that opened it (or the one that asked for another version) is gone: the focus goes to what is new.
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} ref={headingRef} tabIndex={-1} className={H2}>
        {t('version.title', { semver: entry.semver })}
      </h2>
      <div className="mt-4 grid gap-4">
        <Notice>{t('version.notice')}</Notice>
        <Card>
          <Facts
            rows={[
              { label: t('version.date'), value: <time dateTime={entry.createdAt}>{formatDate(entry.createdAt, locale)}</time> },
              { label: t('version.note'), value: entry.note === undefined || entry.note.trim() === '' ? t('version.noNote') : entry.note },
            ]}
          />
        </Card>
        <p className="m-0 text-base text-muted">{t('version.gap')}</p>
        <Button className="w-full sm:w-auto sm:self-start" onClick={onBack}>
          {t('version.back')}
        </Button>
      </div>
    </section>
  );
}

function History({
  entries,
  currentId,
  viewingId,
  locale,
  onOpen,
}: {
  entries: readonly DrillHistoryEntry[];
  currentId: string;
  viewingId: string | null;
  locale: Locale;
  onOpen: (entry: DrillHistoryEntry) => void;
}) {
  const { t } = useTranslation('detail');
  return (
    <Section title={t('history.title')}>
      <ul role="list" className="m-0 list-none divide-y divide-line border-y border-line p-0">
        {entries.map((entry) => {
          const isCurrent = entry.versionId === currentId;
          const isViewing = entry.versionId === viewingId;
          return (
            <li
              key={entry.versionId}
              aria-current={isViewing ? 'true' : undefined}
              className="flex flex-col gap-3 py-4 min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between"
            >
              <div className="grid min-w-0 gap-1">
                <p className="m-0 flex flex-wrap items-center gap-2 text-ink">
                  <strong>{entry.semver}</strong>
                  {isCurrent ? (
                    <Tag tone="accent">
                      <Check aria-hidden="true" className="size-4 shrink-0" />
                      {t('history.current')}
                    </Tag>
                  ) : null}
                  {isViewing ? (
                    <Tag>
                      <Eye aria-hidden="true" className="size-4 shrink-0" />
                      {t('history.viewing')}
                    </Tag>
                  ) : null}
                </p>
                <time dateTime={entry.createdAt} className="text-base text-muted">
                  {formatDate(entry.createdAt, locale)}
                </time>
                {entry.note === undefined || entry.note.trim() === '' ? null : <p className="m-0 wrap-break-word text-ink">{entry.note}</p>}
              </div>
              {isCurrent || isViewing ? null : (
                <Button variant="secondary" className="w-full min-[600px]:w-auto" onClick={() => onOpen(entry)}>
                  {t('history.open', { semver: entry.semver })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function DrillView({ slug, drill, locale }: { slug: string; drill: DrillDetail; locale: Locale }) {
  const { t } = useTranslation('detail');
  const injected = useContext(DrillDetailDepsContext);
  const globSlots = useSlot('drill-detail');
  const slots = injected.slots ?? globSlots;
  const [viewingId, setViewingId] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const { content, attribution } = drill;
  const title = (content.title === undefined ? '' : text(content.title, locale)) || humanise(slug);
  const reviews = newestFirst(drill.reviews);
  // DrillDetail has no status of its own (contract gap): it is where the newest review left it, COMMUNITY without any.
  const status: TrustStatus = reviews[0]?.to ?? 'COMMUNITY';
  const viewing = drill.history.find((entry) => entry.versionId === viewingId && entry.versionId !== drill.versionId);

  const steps = stepsOf(text(content.instructions, locale));
  const videos = content.media.filter((item) => item.kind === 'video');
  const safety = texts(content.safety, locale);
  const mistakes = texts(content.mistakes, locale);
  const harder = texts(content.progressions, locale);
  const easier = texts(content.regressions, locale);
  const { dose, conditions } = content;
  const age = ageOf(conditions.ageMin, conditions.ageMax, locale, t);
  const licence = LICENCES[attribution.license];

  const glance: { label: string; value: ReactNode }[] = [];
  if (dose.reps !== undefined) glance.push({ label: t('facts.reps'), value: formatNumber(dose.reps, locale) });
  if (dose.sets !== undefined) glance.push({ label: t('facts.sets'), value: formatNumber(dose.sets, locale) });
  if (dose.durationSec !== undefined) glance.push({ label: t('facts.time'), value: t('facts.timeValue', { value: formatNumber(dose.durationSec, locale) }) });
  glance.push({ label: t('facts.equipment'), value: t(`equipment.${conditions.equipment}`) });
  glance.push({ label: t('facts.where'), value: conditions.spaces.map((space) => t(`space.${space}`)).join(', ') });
  glance.push({ label: t('facts.partner'), value: conditions.partner ? t('facts.partnerYes') : t('facts.partnerNo') });
  if (age !== undefined) glance.push({ label: t('facts.age'), value: age });

  const source =
    attribution.sourceUrl === undefined ? (
      attribution.source
    ) : (
      <a href={attribution.sourceUrl} rel="noopener noreferrer" className={TEXT_LINK}>
        {attribution.source}
      </a>
    );

  function backToCurrent(): void {
    setViewingId(null);
    titleRef.current?.focus();
  }

  return (
    <>
      <Head title={title} headingRef={titleRef}>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <TrustBadge status={status} source={attribution.source} orgLabel={reviews[0]?.orgLabel} />
        </div>
      </Head>

      {viewing === undefined ? (
        <>
          <Section title={t('goal')} className="mt-8">
            <p className="m-0 max-w-[62ch] text-lg leading-[1.45] wrap-break-word text-ink">{text(content.goal, locale)}</p>
          </Section>

          <Section title={t('glance')}>
            <Card>
              <Facts rows={glance} />
            </Card>
          </Section>

          {safety.length === 0 ? null : (
            <Section title={t('safety')}>
              <Notice tone="warn" role="note">
                <ul role="list" className="m-0 grid list-none gap-2 p-0">
                  {safety.map((line, position) => (
                    <li key={`${position}-${line}`} className="wrap-break-word">
                      {line}
                    </li>
                  ))}
                </ul>
              </Notice>
            </Section>
          )}

          {videos.length === 0 ? null : (
            <Section title={t('video')}>
              <div className="grid gap-6">
                {videos.map((video, position) => (
                  <Video key={`${position}-${video.url}`} url={video.url} caption={video.caption === undefined ? '' : text(video.caption, locale)} />
                ))}
              </div>
            </Section>
          )}

          <Section title={t('how')}>
            {/* The list draws its own numbers with a CSS counter, so the steps carry no typed "1." and the text stays clean. */}
            <ol role="list" className="m-0 grid list-none gap-4 p-0 [counter-reset:step]">
              {steps.map((step, position) => (
                <li
                  key={`${position}-${step}`}
                  className={
                    'flex items-start gap-3 [counter-increment:step] before:grid before:size-9 before:shrink-0 before:place-items-center ' +
                    'before:rounded-pill before:bg-accent-2 before:font-bold before:text-ink before:content-[counter(step)]'
                  }
                >
                  <span className="min-w-0 pt-1 text-lg leading-[1.45] wrap-break-word text-ink">{step}</span>
                </li>
              ))}
            </ol>
          </Section>

          {mistakes.length === 0 ? null : (
            <Section title={t('mistakes')}>
              <Lines lines={mistakes} icon={X} />
            </Section>
          )}
          {harder.length === 0 ? null : (
            <Section title={t('harder')}>
              <Lines lines={harder} icon={ArrowUp} />
            </Section>
          )}
          {easier.length === 0 ? null : (
            <Section title={t('easier')}>
              <Lines lines={easier} icon={ArrowDown} />
            </Section>
          )}

          <Section title={t('trust.title')}>
            <Reviews reviews={reviews} locale={locale} />
          </Section>

          <Section title={t('source.title')}>
            <Card>
              <Facts
                rows={[
                  { label: t('source.author'), value: attribution.author },
                  { label: t('source.source'), value: source },
                  {
                    label: t('source.licence'),
                    value:
                      licence === undefined ? (
                        attribution.license
                      ) : (
                        <a href={licence.url} rel="noopener noreferrer" className={TEXT_LINK}>
                          {licence.name}
                        </a>
                      ),
                  },
                  { label: t('source.date'), value: <time dateTime={attribution.createdAt}>{formatDate(attribution.createdAt, locale)}</time> },
                  { label: t('source.version'), value: attribution.semver },
                ]}
              />
            </Card>
          </Section>
        </>
      ) : (
        <EarlierVersion key={viewing.versionId} entry={viewing} locale={locale} onBack={backToCurrent} />
      )}

      {drill.history.length === 0 ? null : (
        <History
          entries={drill.history}
          currentId={drill.versionId}
          viewingId={viewing?.versionId ?? null}
          locale={locale}
          onOpen={(entry) => setViewingId(entry.versionId)}
        />
      )}

      {slots.length === 0 ? null : (
        <div data-slot="drill-detail" className="mt-12 flex flex-col gap-6">
          {slots.map((Slot, position) => (
            <Slot key={position} />
          ))}
        </div>
      )}
    </>
  );
}

// --- the page ------------------------------------------------------------------------------------------------------------------

function DrillPage() {
  const { t, i18n } = useTranslation('detail');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const { slug } = Route.useParams();

  const query = useQuery({
    queryKey: [QUERY_KEY, slug, locale],
    queryFn: ({ signal }) =>
      api.get(`${ENDPOINTS.getDrill.path.replace(':slug', encodeURIComponent(slug))}?${new URLSearchParams({ locale })}`, {
        schema: ENDPOINTS.getDrill.response,
        signal,
      }),
    // Switching language refetches; keep the previous language on screen meanwhile (but never another drill).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === slug ? previous : undefined),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const failure = useFailure(query);

  let content: ReactNode;
  if (query.data !== undefined) {
    content = <DrillView slug={slug} drill={query.data} locale={locale} />;
  } else if (failure !== null && isNotFound(failure)) {
    content = (
      <>
        <Head title={t('title')} />
        <EmptyState
          className="mt-8"
          title={t('notFound.title')}
          hint={t('notFound.hint')}
          action={
            <Link to={LIBRARY_PATH} className={LINK_PRIMARY}>
              {t('notFound.action')}
            </Link>
          }
        />
      </>
    );
  } else if (failure !== null) {
    content = (
      <>
        <Head title={t('title')} />
        <ErrorState
          className="mt-8"
          title={t('error.title')}
          message={describeProblem(failure, (key) => t(key)).formMessage}
          retryLabel={t('error.retry')}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      </>
    );
  } else {
    content = (
      <>
        <Head title={t('title')} />
        <Loading />
      </>
    );
  }

  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <div className="max-w-160">
        <Link to={LIBRARY_PATH} className="-ml-2 inline-flex min-h-tap min-w-tap items-center gap-2 rounded-control px-2 font-bold text-ink">
          <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
          {t('back')}
        </Link>
        {content}
      </div>
    </main>
  );
}

export const Route = createFileRoute('/commons/$slug')({ component: DrillPage });
