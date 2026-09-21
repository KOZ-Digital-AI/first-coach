import { type Contribution, type ContributionState, ENDPOINTS } from '@api-types/contributions';
import type { Locale } from '@api-types/primitives';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, CircleX, Clock, ExternalLink, PencilLine, Plus, Undo2 } from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { signInUrl } from '../../features/account/session-expired';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { DEFAULT_LOCALE, toLocale } from '../../lib/i18n';
import { describeProblem, isApiProblem } from '../../lib/problem';

/**
 * /contribute/mine: "My contributions". An Operate-mode screen: one calm column, one card per contribution. All words live in
 * features/contribute/mine.messages.ts (namespace `mine`).
 *
 * Data: GET /api/contributions/mine (Contribution[], shared/contributions.ts) and DELETE /api/contributions/:id (withdraw, which
 * answers with the updated Contribution), both through the typed client. The list is cached under ['contributions', 'mine']: the
 * contribute form should invalidate that key after a submit or a resubmit. Nothing here is mocked or seeded.
 *
 * Readings of the criteria (each pinned by mine.test.tsx):
 * - "Withdraw for undecided ones" = the states the API lets the owner withdraw from: pending and changes_requested (a withdraw
 *   from anything else is a 409). "Edit and resubmit" is only for changes_requested, as the criteria say.
 * - "Edit and resubmit" is a link to the edit screen of that contribution, /contribute/<id>/edit (fc-mol-70i.10), as a TanStack
 *   route with a param, not a search param on the form (fc-c9l).
 * - The approved item links to the published drill at /commons/<resultingDrillSlug>; without a slug there is no link, never a
 *   broken one.
 * - Anonymous players are not contributors. requireContributor answers 403 to them (401 with no session at all), and the screen
 *   sends both to /account/sign-in?redirect=/contribute/mine with history.replace, so Back does not bounce them here again.
 *   While that happens the screen says why and offers the same link. (In the running app a 401 is also handled by the
 *   session-expired handler, which leads to the same place.)
 * - The list keeps the order the API sends (newest first). The state is never told by colour alone: every tag is a written word
 *   with its own icon, and a sentence under the title says what it means.
 * - Withdraw is a request that cannot be taken back, so it sits behind a confirm dialog (Radix Dialog, like /settings/plan). While
 *   it runs, every Withdraw button, both dialog buttons and Refresh are disabled and the dialog cannot be dismissed. A failure
 *   stays in the dialog with a message and the same button. A 409/404 (someone decided meanwhile) reloads the list, so the item
 *   shows its real state and the dialog goes away. On success the returned resource replaces the item (no second GET), a status
 *   line says so, and focus goes to the item's title (the button it came from is gone).
 * - Refresh is the read's own control: disabled and aria-busy while a request runs, and the last good list stays on screen
 *   during and after a failed refresh. Queries do not retry by themselves and do not refetch on focus.
 * - Only `Route` is exported: a route file's other exports end up in the entry chunk.
 */

const MINE_KEY = ['contributions', 'mine'] as const;
const RETURN_PATH = '/contribute/mine';
/** Where the contribute form (for a new contribution) lives. Owned by a sibling bead. */
const FORM_PATH = '/contribute';

/** The states in which the owner can still withdraw (the API answers 409 otherwise). */
const UNDECIDED: readonly ContributionState[] = ['pending', 'changes_requested'];
const isUndecided = (state: ContributionState): boolean => UNDECIDED.includes(state);

const STATE_VIEW: Record<ContributionState, { tone: 'neutral' | 'accent' | 'warning' | 'danger'; Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = {
  pending: { tone: 'neutral', Icon: Clock },
  changes_requested: { tone: 'warning', Icon: PencilLine },
  approved: { tone: 'accent', Icon: CircleCheck },
  rejected: { tone: 'danger', Icon: CircleX },
  withdrawn: { tone: 'neutral', Icon: Undo2 },
};

const titleId = (id: string): string => `mine-title-${id}`;

// Link-buttons: the Button primitive is a <button>, and these navigate, so they are real links with the same look (44px floor).
const LINK = 'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere';
const LINK_PRIMARY = clsx(LINK, 'border-ink bg-ink text-white motion-safe:transition-transform motion-safe:hover:-translate-y-px');
const LINK_SECONDARY = clsx(LINK, 'border-line bg-paper text-ink hover:bg-bg');

// --- states -------------------------------------------------------------------------------------

function Loading() {
  const { t } = useTranslation('mine');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-40 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}

/** Shown for a moment while the visitor is sent to sign-in: says why, and is the fallback link. */
function NotAContributor() {
  const { t } = useTranslation('mine');
  return (
    <Card className="mt-8 grid gap-3">
      <h2 className="m-0 text-xl leading-[1.2] font-bold tracking-[-.025em] text-ink">{t('signIn.title')}</h2>
      <p className="m-0 text-base text-ink">{t('signIn.hint')}</p>
      <p role="status" className="m-0 text-base text-muted">
        {t('signIn.redirecting')}
      </p>
      <Link to={'/account/sign-in' as never} search={{ redirect: RETURN_PATH } as never} className={clsx(LINK_PRIMARY, 'w-full sm:w-auto sm:self-start')}>
        {t('signIn.link')}
      </Link>
    </Card>
  );
}

// --- one contribution ---------------------------------------------------------------------------

function ContributionItem({
  contribution,
  locale,
  busy,
  onWithdraw,
}: {
  contribution: Contribution;
  locale: Locale;
  /** A withdrawal is running somewhere: every mutation button is disabled. */
  busy: boolean;
  onWithdraw: () => void;
}) {
  const { t } = useTranslation('mine');
  const { id, state, payload, reviewerNote, resultingDrillSlug } = contribution;
  const name = payload.name;
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale]);
  const { tone, Icon } = STATE_VIEW[state];
  const changed = contribution.updatedAt !== contribution.createdAt;

  return (
    <li>
      <Card className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h2
            id={titleId(id)}
            tabIndex={-1}
            className="m-0 min-w-0 text-xl leading-[1.2] font-bold tracking-[-.025em] wrap-anywhere text-ink focus-visible:outline-offset-4"
          >
            {name}
          </h2>
          <Tag tone={tone}>
            <Icon aria-hidden className="size-3.5 shrink-0" />
            {t(`state.${state}`)}
          </Tag>
        </div>
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
          <span>{t(`kind.${payload.kind}`)}</span>
          <span>{t('sent', { date: date.format(new Date(contribution.createdAt)) })}</span>
          {changed ? <span>{t('updated', { date: date.format(new Date(contribution.updatedAt)) })}</span> : null}
        </p>
        <p className="m-0 text-base text-ink">{t(`stateHint.${state}`)}</p>
        {reviewerNote ? (
          <div className="rounded-control border border-line bg-bg p-3.5">
            <p className="m-0 text-sm font-bold text-ink">{t('note.label')}</p>
            <p className="m-0 mt-1 text-base wrap-anywhere whitespace-pre-line text-ink">{reviewerNote}</p>
          </div>
        ) : null}
        {isUndecided(state) || (state === 'approved' && resultingDrillSlug !== undefined) ? (
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {state === 'changes_requested' ? (
              <Link
                to="/contribute/$id/edit"
                params={{ id }}
                aria-label={t('actions.editNamed', { name })}
                className={clsx(LINK_PRIMARY, 'w-full sm:w-auto')}
              >
                <PencilLine aria-hidden className="size-5 shrink-0" />
                {t('actions.edit')}
              </Link>
            ) : null}
            {isUndecided(state) ? (
              <Button variant="secondary" disabled={busy} aria-label={t('actions.withdrawNamed', { name })} className="w-full sm:w-auto" onClick={onWithdraw}>
                <Undo2 aria-hidden="true" className="size-5 shrink-0" />
                {t('actions.withdraw')}
              </Button>
            ) : null}
            {state === 'approved' && resultingDrillSlug !== undefined ? (
              <Link
                to="/commons/$slug"
                params={{ slug: resultingDrillSlug }}
                aria-label={t('actions.viewNamed', { name })}
                className={clsx(LINK_SECONDARY, 'w-full sm:w-auto')}
              >
                <ExternalLink aria-hidden className="size-5 shrink-0" />
                {t('actions.view')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

// --- the page -----------------------------------------------------------------------------------

function MinePage() {
  const { t, i18n } = useTranslation('mine');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const router = useRouter();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MINE_KEY,
    queryFn: ({ signal }) => api.get(ENDPOINTS.listMine.path, { schema: ENDPOINTS.listMine.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // An anonymous player (403) and a visitor with no session (401) are not contributors: sign in, then come back here.
  const notAContributor = isApiProblem(query.error) && (query.error.kind === 'forbidden' || query.error.kind === 'unauthorized');
  useEffect(() => {
    if (notAContributor) router.history.replace(signInUrl(RETURN_PATH));
  }, [notAContributor, router]);

  // React Query clears `error` the moment a retry starts when there is no data yet. Keep the last failure on screen so Try again
  // stays put, disabled and busy, instead of flashing to skeletons and losing the button.
  const lastFailure = useRef<unknown>(null);
  if (query.error !== null) lastFailure.current = query.error;
  const failure = query.error ?? (query.isFetching && query.errorUpdateCount > 0 ? lastFailure.current : null);

  // --- withdraw ---
  const [targetId, setTargetId] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; name: string } | null>(null);
  const inFlight = useRef(false);
  const focusAfterClose = useRef<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const withdraw = useMutation({
    mutationFn: (id: string): Promise<Contribution> =>
      api.delete(ENDPOINTS.withdrawContribution.path.replace(':id', encodeURIComponent(id)), { schema: ENDPOINTS.withdrawContribution.response }),
    onSuccess: (updated) => {
      // The mutation returns the updated resource: put it in the list instead of asking for the list again.
      queryClient.setQueryData<Contribution[]>(MINE_KEY, (old) => old?.map((item) => (item.id === updated.id ? updated : item)));
      focusAfterClose.current = updated.id;
      setDone({ id: updated.id, name: updated.payload.name });
      setTargetId(null);
    },
    onError: (error) => {
      // Someone decided (409) or removed it (404) meanwhile: the list is stale, so read it again.
      if (isApiProblem(error) && (error.kind === 'conflict' || error.kind === 'not_found')) void queryClient.invalidateQueries({ queryKey: MINE_KEY });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const pending = withdraw.isPending;
  const withdrawFailure = withdraw.isError ? describeProblem(withdraw.error, (key) => t(key)) : null;

  // The confirm button was disabled while the request ran, which drops its focus: after a failure put it back.
  useEffect(() => {
    if (withdraw.isError) confirmRef.current?.focus();
  }, [withdraw.isError]);

  // The button that opened the dialog is gone after a withdrawal: land on the item's title, the next useful place.
  useEffect(() => {
    if (done === null) return;
    document.getElementById(titleId(done.id))?.focus();
  }, [done]);

  const items = query.data;
  const target = items?.find((item) => item.id === targetId);
  // Derived, so an item that is no longer undecided (reloaded after a conflict) takes its dialog with it.
  const dialogOpen = target !== undefined && isUndecided(target.state);

  function confirm(): void {
    if (inFlight.current || target === undefined) return;
    inFlight.current = true;
    withdraw.mutate(target.id);
  }

  let body: ReactNode;
  if (notAContributor) {
    body = <NotAContributor />;
  } else if (items !== undefined) {
    body = (
      <>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button variant="secondary" loading={query.isFetching} disabled={pending} className="w-full sm:w-auto" onClick={() => void query.refetch()}>
            {query.isFetching ? t('refresh.busy') : t('refresh.label')}
          </Button>
          {items.length > 0 ? (
            <Link to={FORM_PATH as never} className={clsx(LINK_SECONDARY, 'w-full sm:w-auto')}>
              <Plus aria-hidden className="size-5 shrink-0" />
              {t('another')}
            </Link>
          ) : null}
        </div>
        {/* A failed refresh keeps the last good list below it and says so. */}
        {query.error !== null ? (
          <Notice tone="warn" className="mt-4">
            {t('refresh.error')}
          </Notice>
        ) : null}
        {done === null ? null : (
          <Notice className="mt-4">{t('withdrawn', { name: done.name })}</Notice>
        )}
        {items.length === 0 ? (
          <EmptyState
            className="mt-8"
            title={t('empty.title')}
            hint={t('empty.hint')}
            action={
              <Link to={FORM_PATH as never} className={clsx(LINK_PRIMARY, 'w-full sm:w-auto')}>
                <Plus aria-hidden className="size-5 shrink-0" />
                {t('empty.action')}
              </Link>
            }
          />
        ) : (
          <ul aria-label={t('list')} className="m-0 mt-8 grid list-none gap-4 p-0">
            {items.map((item) => (
              <ContributionItem
                key={item.id}
                contribution={item}
                locale={locale}
                busy={pending}
                onWithdraw={() => {
                  withdraw.reset();
                  setDone(null);
                  setTargetId(item.id);
                }}
              />
            ))}
          </ul>
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

      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(next) => {
          // The request cannot be taken back: the dialog stays until it has answered.
          if (!next && !pending) setTargetId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              // After a withdrawal the effect above has already moved focus to the item; do not send it back to a vanished button.
              if (focusAfterClose.current !== null) {
                event.preventDefault();
                focusAfterClose.current = null;
              }
            }}
            className={clsx(
              'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-md -translate-x-1/2 -translate-y-1/2',
              'gap-4 overflow-y-auto rounded-card border border-line bg-paper p-5.5 text-ink shadow-soft',
            )}
          >
            <Dialog.Title className="m-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">{t('dialog.title')}</Dialog.Title>
            <Dialog.Description className="m-0 text-base wrap-break-word text-ink">
              {t('dialog.body', { name: target?.payload.name ?? '' })}
            </Dialog.Description>
            {withdrawFailure === null ? null : (
              <div role="alert" className="flex items-start gap-2 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
                  <p className="m-0 font-bold">{t('dialog.error.title')}</p>
                  <p className="m-0 text-muted">{withdrawFailure.formMessage}</p>
                  <p className="m-0">{t('dialog.error.hint')}</p>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" disabled={pending} onClick={() => setTargetId(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button ref={confirmRef} variant="danger" loading={pending} onClick={confirm}>
                {pending ? null : <Undo2 aria-hidden="true" className="size-5 shrink-0" />}
                {t('dialog.confirm')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

export const Route = createFileRoute('/contribute/mine')({ component: MinePage });
