import type { DrillFacets, DrillSummary } from '@api-types/commons';
import { CommonsDrillQuery, ENDPOINTS } from '@api-types/commons-api';
import { LICENSE_IDS, type Locale, type LocalizedText, pickLocalized, type TrustStatus } from '@api-types/primitives';
import { keepPreviousData, type UseInfiniteQueryResult, useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Download, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { TrustBadge } from '../../features/commons/TrustBadge';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, formatNumber, toLocale } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';

/**
 * /commons: the DRILL LIBRARY. An Operate-mode screen, one calm column at 360px that grows to a grid of cards: the drills of
 * the Open Sport Commons from GET /api/commons/drills, filterable by track, status, equipment and level and searchable by
 * text. Every string lives in features/commons/library.messages.ts (namespace `library`); the drill titles and the track
 * names arrive from the API in the active language.
 *
 * Only `Route` is exported (see routes/train/onboarding.tsx for why).
 *
 * Readings of the criteria where they are open:
 * - Data. The typed client with the contract's own schema (`commons-api` ENDPOINTS.listDrills). One list call gives the cards
 *   (fc-mol-hum.6 put age, source, licence and organisation into DrillSummary, so no card needs a detail call) AND the facets.
 *   It is an infinite query cached under ['commons', 'list', 'library', locale, filters] (the persisted allow-list of
 *   lib/query-persist.ts matches the ['commons', 'list'] prefix); "Show more drills" follows `nextCursor`.
 * - Filters. The four selects are built from `facets`; no enum is written here. Words for a value come from the messages, the
 *   track's own name comes from the facet. The facets are computed over the FILTERED list, so once a filter is chosen the
 *   response lists only what is left; the options seen earlier therefore stay on offer (and the chosen value is always one of
 *   them), or a visitor could not switch a filter in one step. "Track" is the API's `skill` parameter. The selects are disabled
 *   until the first answer brings any facets.
 * - URL. The filters and the search live in the search params (`skill`, `status`, `equipment`, `level`, `q`: the API's own
 *   names). validateSearch keeps a value only when the contract's query schema accepts it, so an edited URL can never make
 *   a request the API answers with a 400. A change of filter replaces the history entry (no back-button trail of clicks).
 * - Search. It is sent when submitted (button or Enter), trimmed, never per keystroke.
 * - States. loading = a named busy status under the header; empty = an EmptyState (with "Clear filters" when a filter is on,
 *   otherwise "nothing published yet"); error = ErrorState (generic localised words, never the server's text) whose Try again
 *   is natively disabled and busy while its refetch runs; disabled = that Try again, "Show more drills" while its page loads,
 *   and the selects before the first answer (this screen has no mutation, so there is no other button to lock); success =
 *   the cards. A change of filter keeps the earlier cards on screen, marked busy. A failing next page keeps the cards and adds a
 *   warning and a Try again.
 * - Header. "Download Commons JSON" is a plain download link to export.json. "Contribute a method" is a plain link to
 *   /contribute, which is not in the route tree yet (the same reading as the landing page).
 * - Age. The seeded drills give `ageMax: 99` for "no upper limit"; 99 or more reads as open-ended ("Age from 5").
 * - Nothing here ranks children or promises a professional career (PRODUCT.md).
 */

const QUERY_KEY = ['commons', 'list', 'library'] as const;

/** The seeded drills use 99 for "no upper age limit". */
const OPEN_ENDED_AGE = 99;

type Translate = (key: string, options?: Record<string, unknown>) => string;

// --- the search params -----------------------------------------------------------------------------------------------------

type FilterKey = 'skill' | 'status' | 'equipment' | 'level';
const FILTER_KEYS: readonly FilterKey[] = ['skill', 'status', 'equipment', 'level'];

export type LibrarySearch = Pick<CommonsDrillQuery, FilterKey | 'q'>;

/** The value if the contract's schema for that one parameter accepts it, else nothing. */
function known<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The known filters of a raw search object: a key is kept only when the contract accepts its value; nothing else survives. */
function parseSearch(search: Record<string, unknown>): LibrarySearch {
  const shape = CommonsDrillQuery.shape;
  const result: LibrarySearch = {};
  const skill = known(shape.skill, search.skill);
  const status = known(shape.status, search.status);
  const equipment = known(shape.equipment, search.equipment);
  const level = known(shape.level, search.level);
  if (skill !== undefined) result.skill = skill;
  if (status !== undefined) result.status = status;
  if (equipment !== undefined) result.equipment = equipment;
  if (level !== undefined) result.level = level;
  // The default search parser reads "?q=2024" as the number 2024: a search for digits must survive it.
  const q = typeof search.q === 'number' && Number.isFinite(search.q) ? String(search.q) : search.q;
  if (typeof q === 'string' && q.trim() !== '') result.q = q.trim();
  return result;
}

/**
 * The router merges what this returns OVER the raw search (`{...raw, ...validated}`), so a key that is left out would survive with
 * its raw, unchecked value. Every key of the screen is therefore always returned, `undefined` when the URL's value is not valid.
 */
function validateSearch(search: Record<string, unknown>): LibrarySearch {
  return { skill: undefined, status: undefined, equipment: undefined, level: undefined, q: undefined, ...parseSearch(search) };
}

export const Route = createFileRoute('/commons/')({ validateSearch, component: LibraryPage });

const isFiltered = (search: LibrarySearch): boolean => FILTER_KEYS.some((key) => search[key] !== undefined) || search.q !== undefined;

// --- helpers -------------------------------------------------------------------------------------------------------------------

/** `ball_wall` -> `Ball wall`; only for a value nobody has written words for. */
function humanise(value: string): string {
  const words = value.replace(/[-_]+/g, ' ').trim();
  return words === '' ? value : words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Age from 5", "Age up to 12", "Age 6-12" or nothing at all. */
function ageOf(min: number | undefined, max: number | undefined, locale: Locale, t: Translate): string | undefined {
  const from = min !== undefined && min > 0 ? min : undefined;
  const to = max !== undefined && max < OPEN_ENDED_AGE ? max : undefined;
  if (from !== undefined && to !== undefined) return t('card.ageRange', { min: formatNumber(from, locale), max: formatNumber(to, locale) });
  if (from !== undefined) return t('card.ageFrom', { min: formatNumber(from, locale) });
  if (to !== undefined) return t('card.ageUpTo', { max: formatNumber(to, locale) });
  return undefined;
}

const LICENCES: Readonly<Record<(typeof LICENSE_IDS)[number], string>> = {
  'CC-BY-SA-4.0': 'CC BY-SA 4.0',
  'CC-BY-4.0': 'CC BY 4.0',
  'CC0-1.0': 'CC0 1.0',
};
const licenceName = (id: string): string => (Object.hasOwn(LICENCES, id) ? LICENCES[id as keyof typeof LICENCES] : id);

/** The words of each trust status: the trust badge's own (namespace `trust-badge`), keyed by the contract's TrustStatus. */
const STATUS_WORDS = {
  COMMUNITY: 'community',
  REVIEWED: 'reviewed',
  EXPERT_VERIFIED: 'expertVerified',
  ACADEMY_VERIFIED: 'academyVerified',
} as const satisfies Record<TrustStatus, string>;

// --- the facets the selects are made from ------------------------------------------------------------------------------------

type Seen = Record<FilterKey, Map<string, LocalizedText | undefined>>;

/**
 * The options of the four selects: every value any answer of this visit listed, in the order they came (a new value is added at
 * the end). The facets narrow with the filters, so the newest answer alone would leave nothing to switch to. `arrived` is true
 * once any answer has brought facets. Mutating a ref during render is safe here: the merge is idempotent.
 */
function useSeenFacets(facets: DrillFacets | undefined): { seen: Seen; arrived: boolean } {
  const ref = useRef<{ arrived: boolean; seen: Seen }>({
    arrived: false,
    seen: { skill: new Map(), status: new Map(), equipment: new Map(), level: new Map() },
  });
  if (facets !== undefined) {
    const { seen } = ref.current;
    ref.current.arrived = true;
    for (const skill of facets.skills) seen.skill.set(skill.slug, skill.names);
    for (const entry of facets.statuses) seen.status.set(entry.value, undefined);
    for (const entry of facets.equipment) seen.equipment.set(entry.value, undefined);
    for (const entry of facets.levels) seen.level.set(entry.value, undefined);
  }
  return ref.current;
}

// --- data ----------------------------------------------------------------------------------------------------------------------

function useDrills(search: LibrarySearch, locale: Locale) {
  return useInfiniteQuery({
    queryKey: [...QUERY_KEY, locale, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ locale });
      for (const key of FILTER_KEYS) {
        const value = search[key];
        if (value !== undefined) params.set(key, value);
      }
      if (search.q !== undefined) params.set('q', search.q);
      if (pageParam !== undefined) params.set('cursor', pageParam);
      return api.get(`${ENDPOINTS.listDrills.path}?${params}`, { schema: ENDPOINTS.listDrills.response, signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A change of filter or language keeps the earlier cards on screen until the new answer comes.
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * The failure to show instead of the list. React Query clears `error` the moment a retry starts when there is no data yet; keep
 * the last failure on screen meanwhile so Try again stays put, disabled and busy, instead of flashing to skeletons. Once there
 * is data (a failing NEXT page) the list stays and nothing full-screen is shown.
 */
function useFailure(query: UseInfiniteQueryResult<unknown>): unknown {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  if (query.data !== undefined) return null;
  return query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? last.current : null);
}

// --- shared styling ------------------------------------------------------------------------------------------------------------

// Anchors that look like the Button primitive (which renders a <button>): 44px tall, visible focus from app.css.
const LINK_BASE =
  'inline-flex min-h-tap min-w-tap w-full max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere min-[600px]:w-auto motion-safe:transition-transform';
const LINK_PRIMARY = `${LINK_BASE} border-ink bg-ink text-white motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK_BASE} border-line bg-paper text-ink`;

const GRID = 'm-0 grid list-none gap-4 p-0 min-[720px]:grid-cols-2 min-[1040px]:grid-cols-3';

// --- pieces --------------------------------------------------------------------------------------------------------------------

function Header() {
  const { t } = useTranslation('library');
  return (
    <header className="mt-4">
      <p className="m-0 text-xs font-bold tracking-[.12em] text-accent uppercase">{t('eyebrow')}</p>
      <h1 className="m-0 mt-3 max-w-[18ch] text-[clamp(34px,5.5vw,64px)] leading-[.96] font-bold tracking-[-.06em] wrap-break-word text-ink min-[720px]:max-w-[22ch]">
        {t('title')}
      </h1>
      <p className="m-0 mt-4 max-w-[62ch] text-lg leading-[1.45] wrap-break-word text-ink">{t('intro')}</p>
      <div className="mt-6 flex flex-col gap-3 min-[600px]:flex-row">
        {/* Plain links: /contribute is a later bead's route (not in the tree yet), and the export is a file, not a page. */}
        <a href="/contribute" className={LINK_PRIMARY}>
          <Plus aria-hidden="true" className="size-5 shrink-0" />
          {t('contribute')}
        </a>
        <a href={ENDPOINTS.exportCommons.path} download className={LINK_SECONDARY}>
          <Download aria-hidden="true" className="size-5 shrink-0" />
          {t('download')}
        </a>
      </div>
    </header>
  );
}

type Option = { value: string; label: string };

function FilterSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly Option[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('library');
  return (
    <Field label={label}>
      {(control) => (
        <select {...control} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('filter.all')}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function Filters({
  search,
  seen,
  arrived,
  locale,
  onFilter,
  onSearch,
}: {
  search: LibrarySearch;
  seen: Seen;
  arrived: boolean;
  locale: Locale;
  onFilter: (key: FilterKey, value: string) => void;
  onSearch: (text: string) => void;
}) {
  const { t } = useTranslation(['library', 'trust-badge']);
  const [draft, setDraft] = useState(search.q ?? '');
  // The URL is the truth: a search that arrives from outside (a shared link, "Clear filters") replaces the box's text.
  useEffect(() => setDraft(search.q ?? ''), [search.q]);

  /** Every value seen, plus the chosen one (which an empty answer no longer lists). */
  function optionsOf(key: FilterKey, name: (value: string, names: LocalizedText | undefined) => string): Option[] {
    const values = new Map(seen[key]);
    const chosen = search[key];
    if (chosen !== undefined && !values.has(chosen)) values.set(chosen, undefined);
    return [...values].map(([value, names]) => ({ value, label: name(value, names) }));
  }

  const track = optionsOf('skill', (value, names) => (names === undefined ? undefined : pickLocalized(names, locale)) ?? humanise(value));
  const status = optionsOf('status', (value) =>
    Object.hasOwn(STATUS_WORDS, value) ? t(`trust-badge:${STATUS_WORDS[value as TrustStatus]}`) : humanise(value),
  );
  const equipment = optionsOf('equipment', (value) => t(`library:equipment.${value}`, { defaultValue: humanise(value) }));
  const level = optionsOf('level', (value) => t(`library:levels.${value}`, { defaultValue: humanise(value) }));

  const searchId = 'library-search';
  return (
    <form
      role="search"
      aria-label={t('filter.legend')}
      className="mt-9 grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft);
      }}
    >
      <div className="grid gap-4 min-[600px]:grid-cols-2 min-[1040px]:grid-cols-4">
        <FilterSelect label={t('filter.track')} value={search.skill ?? ''} options={track} disabled={!arrived} onChange={(value) => onFilter('skill', value)} />
        <FilterSelect label={t('filter.status')} value={search.status ?? ''} options={status} disabled={!arrived} onChange={(value) => onFilter('status', value)} />
        <FilterSelect
          label={t('filter.equipment')}
          value={search.equipment ?? ''}
          options={equipment}
          disabled={!arrived}
          onChange={(value) => onFilter('equipment', value)}
        />
        <FilterSelect label={t('filter.level')} value={search.level ?? ''} options={level} disabled={!arrived} onChange={(value) => onFilter('level', value)} />
      </div>
      <Field id={searchId} label={t('filter.search')} hint={t('filter.searchHint')} className="max-w-160">
        {(control) => (
          <div className="flex gap-2">
            <input {...control} type="search" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <Button type="submit" variant="secondary" className="shrink-0">
              {t('filter.searchButton')}
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

function DrillCard({ drill, track, locale }: { drill: DrillSummary; track: string; locale: Locale }) {
  const { t } = useTranslation('library');
  const title = pickLocalized(drill.title, locale) ?? humanise(drill.slug);
  const age = ageOf(drill.ageMin, drill.ageMax, locale, t);
  return (
    // The title link is stretched over the whole card (::after), so the card is one big tap target and one tab stop.
    <Card className="relative flex h-full flex-col gap-3 motion-safe:transition-colors hover:border-ink has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
      <TrustBadge status={drill.status} source={drill.source} orgLabel={drill.orgLabel} className="self-start" />
      <div className="grid gap-1.5">
        <p className="m-0 text-xs font-bold tracking-[.12em] wrap-anywhere text-accent uppercase">{track}</p>
        <h2 className="m-0 text-[22px] leading-[1.1] font-bold tracking-[-.03em] wrap-break-word text-ink">
          <Link to="/commons/$slug" params={{ slug: drill.slug }} className="after:absolute after:inset-0 after:rounded-card after:content-['']">
            {title}
          </Link>
        </h2>
      </div>
      <div className="flex flex-wrap gap-2">
        <Tag>{t('card.level', { level: t(`levels.${drill.level}`, { defaultValue: humanise(drill.level) }) })}</Tag>
        <Tag>{t('card.minutes', { count: formatNumber(drill.minutes, locale) })}</Tag>
        <Tag>{t('card.equipment', { equipment: t(`equipment.${drill.equipment}`, { defaultValue: humanise(drill.equipment) }) })}</Tag>
        {age === undefined ? null : <Tag>{age}</Tag>}
      </div>
      {drill.source === undefined && drill.license === undefined ? null : (
        <div className="mt-auto grid gap-1 border-t border-line pt-3 text-sm text-muted">
          {drill.source === undefined ? null : <p className="m-0 wrap-anywhere">{t('card.source', { source: drill.source })}</p>}
          {drill.license === undefined ? null : <p className="m-0 wrap-anywhere">{t('card.licence', { licence: licenceName(drill.license) })}</p>}
        </div>
      )}
    </Card>
  );
}

function Loading() {
  const { t } = useTranslation('library');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className={`mt-8 ${GRID}`}>
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-44 rounded-card" />
      <Skeleton className="h-44 rounded-card max-[719px]:hidden" />
    </div>
  );
}

// --- the page ------------------------------------------------------------------------------------------------------------------

function LibraryPage() {
  const { t, i18n } = useTranslation(['library', 'trust-badge']);
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  // Re-read through parseSearch: the router keeps unknown keys of the URL in the search it hands out.
  const search = parseSearch(Route.useSearch());
  const navigate = Route.useNavigate();

  const query = useDrills(search, locale);
  const failure = useFailure(query);
  const pages = query.data?.pages;
  const last = pages?.at(-1);
  const { seen, arrived } = useSeenFacets(last?.facets);

  function setFilter(key: FilterKey, value: string): void {
    void navigate({
      search: (previous: Record<string, unknown>) => {
        const next = { ...parseSearch(previous) };
        if (value === '') delete next[key];
        else Object.assign(next, { [key]: value });
        return next;
      },
      replace: true,
    });
  }

  /** validateSearch (parseSearch) trims the text and drops an empty one, so the URL and the request never hold stray spaces. */
  function setText(text: string): void {
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...parseSearch(previous), q: text }),
      replace: true,
    });
  }

  function clearFilters(): void {
    void navigate({ search: () => ({}), replace: true });
  }

  const trackName = (slug: string): string => {
    const names = seen.skill.get(slug);
    return (names === undefined ? undefined : pickLocalized(names, locale)) ?? humanise(slug);
  };

  // `total` is optional in the contract: without it only what is shown can be said.
  const countLine = (shown: number, total: number | undefined): string =>
    total === undefined
      ? t('summaryShown', { shown: formatNumber(shown, locale) })
      : t('summary', { shown: formatNumber(shown, locale), total: formatNumber(total, locale) });

  let content: ReactNode;
  if (pages !== undefined && last !== undefined) {
    const items = pages.flatMap((page) => page.items);
    if (items.length === 0) {
      const filtered = isFiltered(search);
      content = filtered ? (
        <EmptyState
          className="mt-8"
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={
            <Button variant="secondary" onClick={clearFilters}>
              {t('empty.clear')}
            </Button>
          }
        />
      ) : (
        <EmptyState className="mt-8" title={t('emptyAll.title')} hint={t('emptyAll.hint')} />
      );
    } else {
      content = (
        <section className="mt-8">
          <p className="m-0 mb-4 text-base text-muted" aria-live="polite">
            {query.isPlaceholderData ? t('updating') : countLine(items.length, last.total)}
          </p>
          <ul role="list" aria-label={t('list')} aria-busy={query.isPlaceholderData ? true : undefined} className={GRID}>
            {items.map((drill) => (
              <li key={drill.slug}>
                <DrillCard drill={drill} track={trackName(drill.track)} locale={locale} />
              </li>
            ))}
          </ul>
          {query.isFetchNextPageError ? (
            <Notice tone="warn" className="mt-4">
              {describeProblem(query.error, (key) => t(key)).formMessage}
            </Notice>
          ) : null}
          {query.hasNextPage ? (
            <Button
              variant="secondary"
              className="mt-4 w-full sm:w-auto"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchNextPageError ? t('error.retry') : t('more')}
            </Button>
          ) : null}
        </section>
      );
    }
  } else if (failure !== null) {
    content = (
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
    content = <Loading />;
  }

  return (
    <main className="mx-auto w-full max-w-295 px-3 pt-4 pb-13.5 sm:px-5">
      <Header />
      <Filters search={search} seen={seen} arrived={arrived} locale={locale} onFilter={setFilter} onSearch={setText} />
      {content}
    </main>
  );
}
