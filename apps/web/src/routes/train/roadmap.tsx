import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from '@api-types/domain';
import type { Roadmap } from '@api-types/domain';
import { StartResponse } from '@api-types/onboarding';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { type Api, api as appApi } from '../../lib/api';
import { ensurePlayerSession, PlayerSessionError } from '../../lib/auth';
import { describeProblem, ApiProblem, type Translate } from '../../lib/problem';

/**
 * /train/roadmap: MY ROADMAP, the plan GET /api/player/me returns for the player (fc-mol-9l4.15). Operate mode: one page, one
 * primary action ("Open today's training", to /train), everything else is reading. All words live in
 * features/roadmap/roadmap.messages.ts (namespace `roadmap`).
 *
 * Data: the typed client + React Query, under the key ['me'] (the first entry of the persisted allow-list in
 * lib/query-persist.ts), so the last known plan opens offline. The answer is parsed with the contract's StartResponse (GET
 * /api/player/me is not declared in the shared contracts; it answers the same `{ profile, roadmap }`). The screen shows only
 * the roadmap; the profile is not needed here.
 *
 * Readings of the criteria where they are open:
 *  - "Redirected to /train/onboarding" is a 404 from GET /api/player/me (the API's "not onboarded" answer), and the redirect
 *    REPLACES this page in the history so Back does not bounce the player between the two. Nothing else redirects: a 5xx or
 *    a network failure is an error state with Try again. Any 404 counts (the status is what the API promises).
 *  - The request is made after ensurePlayerSession(), like the wizard's, so a visitor who opens this URL first (no session
 *    yet, which the API would answer with a 401) becomes an anonymous player, gets the 404 and lands in the setup.
 *  - The page has no mutation. "Disabled while a request is in flight" is met by the only controls that send a request: the
 *    Try again buttons, disabled (and spinning) while their request runs. The action to /train is a link and stays usable.
 *  - "Empty": the plan holds no focus skills, or no track levels. The contract makes the first impossible for a fresh answer
 *    (2-3 items) but a restored, persisted answer is not parsed again, so it is handled; tracks may legitimately be [].
 *  - The planner writes KEYS into `currentLevelLabel` (Foundation ... Advanced) and each focus `reason` (goal, weakest), and
 *    only a slug for a skill: the client words them. A value it has no words for is shown as the server sent it (a slug
 *    humanised), never blank and never a raw key.
 *  - With a saved plan and a failed refresh, the plan stays on screen with a notice ("Showing your last saved roadmap") and
 *    Try again; the fetch runs with networkMode 'always' so an offline refresh fails at once instead of waiting forever.
 *  - Nothing here compares the player with anyone, and nothing promises a professional career (PRODUCT.md).
 *  - Only `Route` and the small RoadmapDepsContext seam are exported (the route splitter keeps every other export in the entry
 *    chunk, and this page pulls zod, the auth client and the API client, which belong in the lazy chunk; see onboarding.tsx).
 *  - The DESIGN.md roadmap item keeps its 3px Field Green left edge (its "only directional accent").
 */

const ME_KEY = ['me'] as const;
const ME_PATH = '/api/player/me';
const TRAIN_PATH = '/train';
const ONBOARDING_PATH = '/train/onboarding';

const LEVEL_LABELS: readonly string[] = ['Foundation', 'Basic', 'Intermediate', 'Advanced'];
const REASON_KEYS: readonly string[] = ['goal', 'weakest'];
const KNOWN_TRACKS: readonly string[] = ['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination'];

// --- dependencies -----------------------------------------------------------------------------------------------------------

export type RoadmapDeps = {
  api: Pick<Api, 'get'>;
  /** Resolves once the player has a (possibly anonymous) session. */
  ensureSession: () => Promise<unknown>;
  /** Go to a path inside the app; `replace` swaps the current history entry. */
  navigate: (to: string, options?: { replace?: boolean }) => void;
};

/**
 * The seam for tests: the page's collaborators can be supplied through this context. Nothing in the app provides it, so the
 * defaults apply. It imports nothing (see the note above about the entry chunk).
 */
export const RoadmapDepsContext = createContext<Partial<RoadmapDeps>>({});

// --- small pieces -------------------------------------------------------------------------------------------------------------

/** `sprint-speed` -> `Sprint speed`. */
function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a failed session is, as the client's own error type (so its localised sentence can be chosen). */
function asProblem(error: unknown): unknown {
  if (error instanceof PlayerSessionError) return new ApiProblem({ kind: error.kind === 'offline' ? 'offline' : 'unknown', cause: error });
  return error;
}

// The Button primitive's own classes (components/ui/button.tsx), applied to anchors: the actions here navigate, so they are
// real links. Same tap size, radius and focus ring; primary is the only filled dark control.
const LINK =
  'inline-flex min-h-tap min-w-tap w-full max-w-full items-center justify-center rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere sm:w-auto motion-safe:transition-transform';
const LINK_PRIMARY = `${LINK} border-ink bg-ink text-white sm:self-start motion-safe:hover:-translate-y-px`;
const LINK_SECONDARY = `${LINK} border-line bg-paper text-ink`;

/** A link inside the app: a plain click navigates through the router, anything else (new tab, middle click) is the browser's. */
function AppLink({ to, navigate, className, children }: { to: string; navigate: RoadmapDeps['navigate']; className: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

/** Five segments; the first `level` are filled, the next one (the target) is outlined. Decorative: the numbers carry the meaning. */
function LevelStrip({ level, target }: { level: number; target: number }) {
  return (
    <div aria-hidden="true" className="flex gap-1.5">
      {Array.from({ length: SKILL_LEVEL_MAX }, (_, index) => {
        const n = index + 1;
        return (
          <span
            key={n}
            className={clsx(
              'h-2.5 flex-1 rounded-pill',
              n <= level ? 'bg-accent' : n === target ? 'border border-dashed border-accent bg-accent-2' : 'bg-line',
            )}
          />
        );
      })}
    </div>
  );
}

// --- the page -------------------------------------------------------------------------------------------------------------------

function RoadmapPage({ deps }: { deps: RoadmapDeps }) {
  const { t, i18n } = useTranslation('roadmap');
  const focusHeadingId = useId();
  const skillsHeadingId = useId();

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: async ({ signal }) => {
      try {
        await deps.ensureSession();
      } catch (error) {
        throw asProblem(error);
      }
      return deps.api.get(ME_PATH, { schema: StartResponse, signal });
    },
    retry: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
  });

  // Retrying a failed query that holds no data flips it back to "pending" and clears its error, which would collapse the error
  // (and its disabled, spinning Try again) into the loading skeleton. So the last error is remembered until the query succeeds.
  const remembered = useRef<unknown>(null);
  if (me.isError) remembered.current = me.error;
  else if (me.isSuccess) remembered.current = null;
  const error = me.isError ? me.error : me.data === undefined && me.isFetching ? remembered.current : null;

  const notOnboarded = error instanceof ApiProblem && error.status === 404;
  // Runs when the answer turns into "not onboarded", and only then: a later refetch that is still a 404 changes nothing here.
  useEffect(() => {
    if (notOnboarded) deps.navigate(ONBOARDING_PATH, { replace: true });
  }, [notOnboarded, deps]);

  // A natively disabled button drops keyboard focus, so once a retry settles focus goes back to what is left to act on (the
  // alert, the notice's button) or to the heading when it worked. Only set by a click, so a plain page load never moves focus.
  const heading = useRef<HTMLHeadingElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const noticeRetry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (me.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    (alertBox.current ?? noticeRetry.current ?? heading.current)?.focus();
  }, [me.isFetching, me.errorUpdatedAt, me.dataUpdatedAt]);
  const retry = () => {
    restoreFocus.current = true;
    void me.refetch();
  };

  const translate: Translate = (key) => String(i18n.t(key));
  const roadmap: Roadmap | undefined = me.data?.roadmap;

  let body: ReactNode;
  if (notOnboarded) {
    body = (
      <div role="status" className="flex min-w-0 flex-col items-start gap-3 rounded-card border border-dashed border-line p-5.5 wrap-anywhere">
        <p className="text-xl leading-tight font-bold tracking-tight text-ink">{t('notOnboarded.title')}</p>
        <AppLink to={ONBOARDING_PATH} navigate={deps.navigate} className={LINK_SECONDARY}>
          {t('notOnboarded.action')}
        </AppLink>
      </div>
    );
  } else if (roadmap !== undefined) {
    body = (
      <RoadmapView
        roadmap={roadmap}
        navigate={deps.navigate}
        focusHeadingId={focusHeadingId}
        skillsHeadingId={skillsHeadingId}
        stale={
          me.isError ? (
            <Notice>
              <p className="font-bold">{t('stale.title')}</p>
              <p>{t('stale.hint')}</p>
              <Button ref={noticeRetry} variant="secondary" className="mt-3 w-full sm:w-auto" loading={me.isFetching} onClick={retry}>
                {t('retry')}
              </Button>
            </Notice>
          ) : null
        }
      />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        ref={alertBox}
        tabIndex={-1}
        title={t('error.title')}
        message={describeProblem(error, translate).formMessage}
        retryLabel={t('retry')}
        retrying={me.isFetching}
        onRetry={retry}
      />
    );
  } else {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <p className="text-base text-muted">{t('loading')}</p>
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-[min(840px,100%-24px)] flex-col gap-6 py-8 sm:w-[min(840px,100%-40px)] sm:py-12">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-bold tracking-[0.12em] text-accent uppercase">{t('eyebrow')}</p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-[length:clamp(32px,5vw,60px)] leading-none font-bold tracking-[-0.05em] wrap-break-word text-ink focus:outline-none"
        >
          {t('title')}
        </h1>
      </header>
      {body}
    </main>
  );
}

function RoadmapView({
  roadmap,
  navigate,
  stale,
  focusHeadingId,
  skillsHeadingId,
}: {
  roadmap: Roadmap;
  navigate: RoadmapDeps['navigate'];
  stale: ReactNode;
  focusHeadingId: string;
  skillsHeadingId: string;
}) {
  const { t } = useTranslation('roadmap');

  const levelLabel = LEVEL_LABELS.includes(roadmap.currentLevelLabel) ? t(`levels.${roadmap.currentLevelLabel}`) : roadmap.currentLevelLabel;
  const trackName = (slug: string): string => (KNOWN_TRACKS.includes(slug) ? t(`tracks.${slug}`) : humanise(slug));
  const reasonText = (reason: string): string => (REASON_KEYS.includes(reason) ? t(`focus.reason.${reason}`) : reason);
  const plan = [
    t('plan.weeks', { count: roadmap.weeks }),
    t('plan.sessions', { count: roadmap.sessionsPerWeek }),
    t('plan.minutes', { minutes: roadmap.minutesPerSession }),
  ]
    .map((part) => part.replace(/ /g, '\u00a0')) // a number never wraps away from its unit; the parts wrap at the " · "
    .join(' · ');

  return (
    <div className="flex flex-col gap-8">
      {stale}

      <div className="flex flex-col gap-4">
        <Card variant="ink" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-bold tracking-[0.12em] text-white/80 uppercase">{t('levelNow')}</p>
            <p className="text-[length:clamp(36px,10vw,64px)] leading-none font-bold tracking-[-0.04em] wrap-break-word">{levelLabel}</p>
          </div>
          <div className="flex flex-col gap-1 border-t border-white/20 pt-4">
            <p className="text-xs font-bold tracking-[0.12em] text-white/80 uppercase">{t('goalLabel')}</p>
            <p className="text-xl leading-tight font-bold tracking-tight">{t(`goals.${roadmap.goal}`)}</p>
          </div>
          <p className="text-base text-white/80">{plan}</p>
        </Card>
        <AppLink to={TRAIN_PATH} navigate={navigate} className={LINK_PRIMARY}>
          {t('start')}
        </AppLink>
      </div>

      <section aria-labelledby={focusHeadingId} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={focusHeadingId} className="text-[length:clamp(24px,4vw,32px)] leading-tight font-bold tracking-tight text-ink">
            {t('focus.title')}
          </h2>
          <p className="text-base text-muted">{t('focus.lead')}</p>
        </div>
        {roadmap.focus.length === 0 ? (
          <EmptyState
            title={t('focus.empty.title')}
            hint={t('focus.empty.hint')}
            action={
              <AppLink to={ONBOARDING_PATH} navigate={navigate} className={LINK_SECONDARY}>
                {t('focus.empty.action')}
              </AppLink>
            }
          />
        ) : (
          <ul aria-label={t('focus.listLabel')} className="m-0 flex list-none flex-col gap-3 p-0">
            {roadmap.focus.map((item) => {
              const holding = item.targetLevel <= item.level;
              return (
                <li
                  key={item.skill}
                  className="flex min-w-0 flex-col gap-3 rounded-card border-y border-r border-line border-l-[3px] border-l-accent bg-paper p-5.5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 className="min-w-0 text-xl leading-tight font-bold tracking-tight wrap-anywhere text-ink">{trackName(item.skill)}</h3>
                    {holding ? (
                      <p className="text-base font-bold text-ink">{t('focus.hold', { level: item.level })}</p>
                    ) : (
                      <p className="text-base font-bold text-ink">
                        <span aria-hidden="true">{t('focus.change', { from: item.level, to: item.targetLevel })}</span>
                        <span className="sr-only">{t('focus.changeSr', { from: item.level, to: item.targetLevel })}</span>
                      </p>
                    )}
                  </div>
                  <LevelStrip level={item.level} target={item.targetLevel} />
                  <p className="text-base text-muted wrap-anywhere">{reasonText(item.reason)}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby={skillsHeadingId} className="flex flex-col gap-3">
        <h2 id={skillsHeadingId} className="text-[length:clamp(24px,4vw,32px)] leading-tight font-bold tracking-tight text-ink">
          {t('skills.title')}
        </h2>
        {roadmap.tracks.length === 0 ? (
          <EmptyState title={t('skills.empty.title')} hint={t('skills.empty.hint')} />
        ) : (
          <ul
            aria-label={t('skills.listLabel')}
            className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-paper p-0"
          >
            {roadmap.tracks.map((track) => {
              const name = trackName(track.skill);
              const levelText = t('skills.level', { level: track.level, max: SKILL_LEVEL_MAX });
              return (
                <li key={track.skill} className="flex min-w-0 flex-col gap-2 px-5.5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="min-w-0 text-base font-bold wrap-anywhere text-ink">{name}</span>
                    <span className="text-base text-ink">{levelText}</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={name}
                    aria-valuemin={SKILL_LEVEL_MIN}
                    aria-valuemax={SKILL_LEVEL_MAX}
                    aria-valuenow={track.level}
                    aria-valuetext={levelText}
                    className="h-2.5 overflow-hidden rounded-pill bg-line"
                  >
                    <div className="h-full rounded-pill bg-accent" style={{ width: `${(track.level / SKILL_LEVEL_MAX) * 100}%` }} />
                  </div>
                  <div>
                    <Tag>{t(`skills.source.${track.source}`)}</Tag>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function RoadmapRoute() {
  const router = useRouter({ warn: false });
  const injected = useContext(RoadmapDepsContext);
  const [deps] = useState<RoadmapDeps>(() => ({
    api: appApi,
    ensureSession: ensurePlayerSession,
    // The routes /train and /train/onboarding are typed by the generated route tree only when they exist, so the history is used.
    navigate: (to, options) => (options?.replace ? router?.history.replace(to) : router?.history.push(to)),
    ...injected,
  }));
  return <RoadmapPage deps={deps} />;
}

export const Route = createFileRoute('/train/roadmap')({ component: RoadmapRoute });
