import { ENDPOINTS as ADMIN } from '@api-types/admin';
import { ENDPOINTS as COMMONS } from '@api-types/commons-api';
import { TRUST_STATUSES, TrustStatus } from '@api-types/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Check, CircleAlert, Minus, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { Skeleton } from '../../components/ui/skeleton';
import { Tag } from '../../components/ui/tag';
import { api } from '../../lib/api';
// Also registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import { formatNumber } from '../../lib/i18n';
import { describeProblem } from '../../lib/problem';

/**
 * /admin/settings: the admin settings screen. An Operate-mode screen: one calm column, grouped fields, one Save.
 * It sits under the admin layout (routes/admin/route.tsx), whose role guard is COSMETIC: the API's requireAdmin answers 401/403
 * to anyone else, and a refusal shows here as an ordinary load or save failure. Every string is in settings.messages.ts.
 *
 * Calls (all through the typed client): GET and PUT /api/admin/settings for the values; GET /api/commons/drills?limit=1 for the
 * per-status drill counts (public; its facets travel with the list); GET /health for whether an AI key is configured.
 *
 * Readings of the criteria (each pinned by settings.test.tsx):
 * - Field list. The shared contract leaves `Settings` a loose object, and the typed field list lives in apps/api/src/admin/settings.ts,
 *   which the web may not import (it reads bun:sqlite and is not under shared/). SettingsView below is a copy of that list. Every
 *   key is optional here, because `{}` is a valid loose Settings: a key the server does not send has no control, and none at all is
 *   the EMPTY state. A key with the wrong type is an error (schema), never a control filled from a guess. Keys this screen does
 *   not know are ignored and never sent back.
 * - Save = a PATCH-shaped PUT of ONLY the values the admin changed (the API takes any subset; it merges age bands one by one).
 *   The answer is the full settings and becomes the new saved state.
 * - Roll back on failure. Nothing enters the saved state until the server confirms it (no optimistic write). A failed save keeps
 *   what the admin typed, so nothing is lost, says in words that nothing was saved, and "Discard changes" returns to the last
 *   confirmed values.
 * - Field errors. The server's 422 pointers ("/uploadMaxMb", "/minStatusByAgeBand/u10", "/retestIntervalsDays/1") are put on their
 *   field with OUR localised sentence: the server's text is English and is never shown. A pointer with no field here (an unknown
 *   key) is a form-level message instead of an error that points at nothing. The screen also refuses values it can see are not
 *   whole numbers of 1 or more before sending, with the same sentences.
 * - Low drill pool. "Eligible drills" = published drills at or above the chosen status, counted from the unfiltered public list's
 *   facets (the planner narrows further by age, kit and skills, so this is an upper bound). The warning appears only for a band whose
 *   minimum is RAISED above its saved value and leaves fewer than MIN_POOL, and it warns without blocking the save.
 * - Env-only values. The API exposes exactly one: /health `aiAvailable` (OPENAI_API_KEY is set), shown as configured / not
 *   configured; the model ids (OPENAI_MODEL...) have no endpoint, so the panel says they live in the server environment rather than
 *   inventing a status. Both calls are advisory: their failure never blocks the form.
 * - Disabled. Every control and both buttons are disabled while the PUT is in flight (Save shows a spinner and aria-busy).
 * - Retries. Queries do not retry by themselves; Try again is the way out.
 */

/** Fewer eligible drills than this makes the choice too narrow for a player. Named in the bead: "fewer than 20 eligible drills". */
const MIN_POOL = 20;

type Status = TrustStatus;

const BANDS = ['u10', 'u14', 'adult'] as const;
type Band = (typeof BANDS)[number];

/** Copy of SettingsSchema in apps/api/src/admin/settings.ts, every key optional (see the header). */
const SettingsView = z.looseObject({
  minStatusByAgeBand: z.object({ u10: TrustStatus, u14: TrustStatus, adult: TrustStatus }).optional(),
  uploadMaxMb: z.int().optional(),
  aiPlannerEnabled: z.boolean().optional(),
  videoCoachEnabled: z.boolean().optional(),
  retestIntervalsDays: z.array(z.int()).optional(),
});
type SavedSettings = z.infer<typeof SettingsView>;

/** The one thing this screen reads from /health (the rest of that loose object is ignored). */
const Health = z.looseObject({ aiAvailable: z.boolean().optional() });

const SETTINGS_KEY = ['admin', 'settings'] as const;

const hasAnySetting = (saved: SavedSettings): boolean =>
  saved.minStatusByAgeBand !== undefined ||
  saved.uploadMaxMb !== undefined ||
  saved.aiPlannerEnabled !== undefined ||
  saved.videoCoachEnabled !== undefined ||
  saved.retestIntervalsDays !== undefined;

// --- the draft ----------------------------------------------------------------------------------

/** What the admin is editing: the saved values, with the two text fields held as text until they are sent. */
interface Draft {
  bands: Record<Band, Status> | undefined;
  upload: string | undefined;
  ai: boolean | undefined;
  video: boolean | undefined;
  retest: string | undefined;
}

const toDraft = (saved: SavedSettings): Draft => ({
  bands: saved.minStatusByAgeBand === undefined ? undefined : { ...saved.minStatusByAgeBand },
  upload: saved.uploadMaxMb === undefined ? undefined : String(saved.uploadMaxMb),
  ai: saved.aiPlannerEnabled,
  video: saved.videoCoachEnabled,
  retest: saved.retestIntervalsDays === undefined ? undefined : saved.retestIntervalsDays.join(', '),
});

/** A whole number of 1 or more, written in digits only. */
function parseWhole(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** Days separated by commas, semicolons or spaces; at least one, each a whole number of 1 or more. */
function parseDays(text: string): number[] | undefined {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const days = parts.map(parseWhole);
  return days.every((day): day is number => day !== undefined) ? days : undefined;
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

type FieldKey = Band | 'uploadMaxMb' | 'aiPlannerEnabled' | 'videoCoachEnabled' | 'retestIntervalsDays';
type FieldFlags = Partial<Record<FieldKey, true>>;

/** Page order, which is also the order focus goes to the first error in. */
const FIELD_ORDER: readonly FieldKey[] = ['u10', 'u14', 'adult', 'uploadMaxMb', 'aiPlannerEnabled', 'videoCoachEnabled', 'retestIntervalsDays'];
const fieldId = (key: FieldKey): string => `settings-${key}`;

interface Patch {
  minStatusByAgeBand?: Partial<Record<Band, Status>>;
  uploadMaxMb?: number;
  aiPlannerEnabled?: boolean;
  videoCoachEnabled?: boolean;
  retestIntervalsDays?: number[];
}

/** The values that differ from what is saved (the request body), and the fields whose text cannot be sent at all. */
function compare(saved: SavedSettings, draft: Draft): { patch: Patch; invalid: FieldFlags } {
  const patch: Patch = {};
  const invalid: FieldFlags = {};
  if (saved.minStatusByAgeBand !== undefined && draft.bands !== undefined) {
    for (const band of BANDS) {
      if (draft.bands[band] !== saved.minStatusByAgeBand[band]) (patch.minStatusByAgeBand ??= {})[band] = draft.bands[band];
    }
  }
  if (draft.upload !== undefined) {
    const value = parseWhole(draft.upload);
    if (value === undefined) invalid.uploadMaxMb = true;
    else if (value !== saved.uploadMaxMb) patch.uploadMaxMb = value;
  }
  if (draft.ai !== undefined && draft.ai !== saved.aiPlannerEnabled) patch.aiPlannerEnabled = draft.ai;
  if (draft.video !== undefined && draft.video !== saved.videoCoachEnabled) patch.videoCoachEnabled = draft.video;
  if (draft.retest !== undefined) {
    const days = parseDays(draft.retest);
    if (days === undefined) invalid.retestIntervalsDays = true;
    else if (saved.retestIntervalsDays === undefined || !sameList(days, saved.retestIntervalsDays)) patch.retestIntervalsDays = days;
  }
  return { patch, invalid };
}

/** Which of this screen's fields a server error path (dotted, from the RFC 6901 pointer) belongs to; none for an unknown key. */
function fieldsOfPath(path: string, present: (key: FieldKey) => boolean): FieldKey[] {
  const [head, second] = path.split('.');
  let keys: FieldKey[] = [];
  if (head === 'minStatusByAgeBand') keys = (BANDS as readonly string[]).includes(second ?? '') ? [second as Band] : [...BANDS];
  else if (head === 'uploadMaxMb' || head === 'aiPlannerEnabled' || head === 'videoCoachEnabled' || head === 'retestIntervalsDays') keys = [head];
  return keys.filter(present);
}

// --- pieces -------------------------------------------------------------------------------------

const H2 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10 border-t border-line pt-6">
      <h2 id={id} className={H2}>
        {title}
      </h2>
      <div className="mt-4 grid gap-4">{children}</div>
    </section>
  );
}

function Loading() {
  const { t } = useTranslation('settings');
  return (
    <div role="status" aria-busy="true" aria-label={t('loading')} className="mt-8 grid gap-4">
      <Skeleton className="h-11 w-full max-w-64" />
      <Skeleton className="h-28 rounded-card" />
      <Skeleton className="h-28 rounded-card" />
    </div>
  );
}

interface SwitchProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (checked: boolean) => void;
}

/** A real checkbox with role="switch" in a 44px row; the state is also written (On / Off), so it is never colour alone. */
function Switch({ id, label, hint, checked, disabled, error, onChange }: SwitchProps) {
  const { t } = useTranslation('settings');
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div data-tone={error === undefined ? 'default' : 'error'} className="flex min-w-0 flex-col gap-2">
      <label
        htmlFor={id}
        className="flex min-h-tap min-w-0 cursor-pointer items-start gap-3 rounded-control border border-line bg-white px-3.5 py-3 has-disabled:cursor-not-allowed has-disabled:bg-bg has-disabled:text-muted"
      >
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-labelledby={labelId}
          aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
          aria-invalid={error === undefined ? undefined : true}
          className="mt-0.5 size-6 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={labelId} className="text-base font-bold wrap-anywhere text-ink">
            {label}
          </span>
          <span id={hintId} className="text-[13px] wrap-anywhere text-muted">
            {hint}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-pill border px-2.25 py-1.5 text-xs leading-tight font-bold text-ink ${checked ? 'border-transparent bg-accent-2' : 'border-line bg-bg'}`}
        >
          {checked ? t('features.on') : t('features.off')}
        </span>
      </label>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="flex items-start gap-2 font-bold text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
    </div>
  );
}

/** Read-only: what the server's environment holds, as far as the API says. Never an input. */
function ServerPanel() {
  const { t } = useTranslation('settings');
  const health = useQuery({
    queryKey: [...SETTINGS_KEY, 'health'],
    queryFn: ({ signal }) => api.get('/health', { schema: Health, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const available = health.data?.aiAvailable;

  let status: ReactNode;
  if (health.isPending) {
    status = <span className="text-base text-muted">{t('server.checking')}</span>;
  } else if (available === true) {
    status = (
      <Tag tone="accent">
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
        {t('server.configured')}
      </Tag>
    );
  } else if (available === false) {
    status = (
      <Tag>
        <X aria-hidden="true" className="size-3.5 shrink-0" />
        {t('server.notConfigured')}
      </Tag>
    );
  } else {
    // The call failed, or the answer does not say: no guess.
    status = (
      <Tag>
        <Minus aria-hidden="true" className="size-3.5 shrink-0" />
        {t('server.unknown')}
      </Tag>
    );
  }

  return (
    <section aria-labelledby="settings-server" className="mt-10 rounded-card border border-dashed border-line p-5.5">
      <h2 id="settings-server" className={H2}>
        {t('server.title')}
      </h2>
      <p className="m-0 mt-2 text-base text-muted">{t('server.lead')}</p>
      <dl className="m-0 mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <dt className="text-base font-bold text-ink">{t('server.aiKey')}</dt>
        <dd className="m-0">{status}</dd>
      </dl>
    </section>
  );
}

// --- the form -----------------------------------------------------------------------------------

type Outcome = { kind: 'saved' } | { kind: 'failed'; message: string };

function SettingsForm({ saved }: { saved: SavedSettings }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  const [errors, setErrors] = useState<FieldFlags>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [settled, setSettled] = useState(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  const mutation = useMutation({
    mutationFn: (patch: Patch) => api.put(ADMIN.putSettings.path, { body: patch, schema: SettingsView }),
  });
  const saving = mutation.isPending;

  // Advisory: the counts only feed the hints and the warning. Their failure never blocks the form.
  const pool = useQuery({
    queryKey: [...SETTINGS_KEY, 'drill-pool'],
    queryFn: ({ signal }) => api.get(`${COMMONS.listDrills.path}?limit=1`, { schema: COMMONS.listDrills.response, signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const statusCounts = pool.data?.facets.statuses;
  const eligible = (min: Status): number | undefined => {
    if (statusCounts === undefined) return undefined;
    const from = TRUST_STATUSES.indexOf(min);
    return statusCounts.filter(({ value }) => TRUST_STATUSES.indexOf(value) >= from).reduce((sum, { count }) => sum + count, 0);
  };

  const { patch: pending, invalid: unsendable } = compare(saved, draft);
  const dirty = Object.keys(pending).length > 0 || Object.keys(unsendable).length > 0;

  // After a save (or a refusal to send), move focus to what happened: the first field with an error, else the result message.
  // Not while the request is still in flight: a disabled control cannot take focus.
  useEffect(() => {
    if (saving || !focusPending.current) return;
    focusPending.current = false;
    const first = FIELD_ORDER.find((key) => errors[key] === true);
    const target = first === undefined ? resultRef.current : document.getElementById(fieldId(first));
    target?.focus();
  }, [saving, settled, errors]);

  const settle = (): void => {
    focusPending.current = true;
    setSettled((count) => count + 1);
  };

  /** An edit clears its own error and the "saved" message; other errors and a failure message stay until the next save. */
  const edit = (key: FieldKey, next: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const { [key]: _cleared, ...rest } = current;
      return rest;
    });
    setOutcome((current) => (current?.kind === 'saved' ? null : current));
  };
  const setBand = (band: Band, status: Status): void => edit(band, { bands: { ...draft.bands!, [band]: status } });

  const present = (key: FieldKey): boolean =>
    (BANDS as readonly string[]).includes(key) ? saved.minStatusByAgeBand !== undefined : saved[key as Exclude<FieldKey, Band>] !== undefined;

  const save = (): void => {
    if (saving) return;
    const { patch, invalid } = compare(saved, draft);
    setOutcome(null);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      setOutcome({ kind: 'failed', message: t('problem:validation') });
      settle();
      return;
    }
    if (Object.keys(patch).length === 0) return;
    setErrors({});
    mutation.mutate(patch, {
      onSuccess: (data) => {
        queryClient.setQueryData(SETTINGS_KEY, data);
        setDraft(toDraft(data));
        setOutcome({ kind: 'saved' });
        settle();
      },
      onError: (error) => {
        const view = describeProblem(error, (key) => t(key));
        const flags: FieldFlags = {};
        for (const path of Object.keys(view.fieldErrors)) for (const key of fieldsOfPath(path, present)) flags[key] = true;
        setErrors(flags);
        // "Check the highlighted fields" only when there is a field to highlight.
        const message = view.kind === 'validation' && Object.keys(flags).length === 0 ? t('problem:unknown') : view.formMessage;
        setOutcome({ kind: 'failed', message });
        settle();
      },
    });
  };

  const discard = (): void => {
    setDraft(toDraft(saved));
    setErrors({});
    setOutcome(null);
  };

  const warnings = BANDS.flatMap((band) => {
    const now = draft.bands?.[band];
    const before = saved.minStatusByAgeBand?.[band];
    if (now === undefined || before === undefined || TRUST_STATUSES.indexOf(now) <= TRUST_STATUSES.indexOf(before)) return [];
    const count = eligible(now);
    return count !== undefined && count < MIN_POOL ? [{ band, status: now, count }] : [];
  });
  const warningOf = (band: Band) => warnings.find((warning) => warning.band === band);

  const errorText = (key: FieldKey, message: string): string | undefined => (errors[key] === true ? message : undefined);

  return (
    <form
      noValidate
      aria-busy={saving || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {draft.bands === undefined ? null : (
        <Group id="settings-drills" title={t('drills.title')}>
          <div role="group" aria-labelledby="settings-drills-legend" className="grid gap-4">
            <div className="grid gap-1">
              <p id="settings-drills-legend" className="m-0 text-base font-bold text-ink">
                {t('drills.legend')}
              </p>
              <p className="m-0 text-base text-muted">{t('drills.hint')}</p>
            </div>
            {pool.isError ? <Notice>{t('pool.unknown')}</Notice> : null}
            {BANDS.map((band) => {
              const count = eligible(draft.bands![band]);
              const warning = warningOf(band);
              return (
                <div key={band} className="grid gap-2">
                  <Field
                    id={fieldId(band)}
                    label={t(`band.${band}`)}
                    hint={count === undefined ? undefined : t('pool.count', { drills: formatNumber(count) })}
                    error={errorText(band, t('fieldError.minStatus'))}
                  >
                    {(control) => (
                      <select {...control} value={draft.bands![band]} disabled={saving} onChange={(event) => setBand(band, event.currentTarget.value as Status)}>
                        {TRUST_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {t(`status.${status}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {warning === undefined ? null : (
                    <Notice tone="warn">
                      <p className="m-0 font-bold">{t('pool.warnTitle', { band: t(`band.${band}`) })}</p>
                      <p className="m-0">
                        {t('pool.warnBody', { status: t(`status.${warning.status}`), min: formatNumber(MIN_POOL), drills: formatNumber(warning.count) })}
                      </p>
                    </Notice>
                  )}
                </div>
              );
            })}
          </div>
        </Group>
      )}

      {draft.upload === undefined ? null : (
        <Group id="settings-uploads" title={t('uploads.title')}>
          <Field id={fieldId('uploadMaxMb')} label={t('uploads.label')} hint={t('uploads.hint')} error={errorText('uploadMaxMb', t('fieldError.uploadMaxMb'))}>
            {(control) => (
              <input
                {...control}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={draft.upload}
                disabled={saving}
                onChange={(event) => edit('uploadMaxMb', { upload: event.currentTarget.value })}
              />
            )}
          </Field>
        </Group>
      )}

      {draft.ai === undefined && draft.video === undefined ? null : (
        <Group id="settings-features" title={t('features.title')}>
          {draft.ai === undefined ? null : (
            <Switch
              id={fieldId('aiPlannerEnabled')}
              label={t('features.ai.label')}
              hint={t('features.ai.hint')}
              checked={draft.ai}
              disabled={saving}
              error={errorText('aiPlannerEnabled', t('fieldError.toggle'))}
              onChange={(checked) => edit('aiPlannerEnabled', { ai: checked })}
            />
          )}
          {draft.video === undefined ? null : (
            <Switch
              id={fieldId('videoCoachEnabled')}
              label={t('features.video.label')}
              hint={t('features.video.hint')}
              checked={draft.video}
              disabled={saving}
              error={errorText('videoCoachEnabled', t('fieldError.toggle'))}
              onChange={(checked) => edit('videoCoachEnabled', { video: checked })}
            />
          )}
        </Group>
      )}

      {draft.retest === undefined ? null : (
        <Group id="settings-retest" title={t('retest.title')}>
          <Field id={fieldId('retestIntervalsDays')} label={t('retest.label')} hint={t('retest.hint')} error={errorText('retestIntervalsDays', t('fieldError.retest'))}>
            {(control) => (
              <input
                {...control}
                type="text"
                autoComplete="off"
                value={draft.retest}
                disabled={saving}
                onChange={(event) => edit('retestIntervalsDays', { retest: event.currentTarget.value })}
              />
            )}
          </Field>
        </Group>
      )}

      <div className="mt-10 border-t border-line pt-6">
        {outcome?.kind === 'saved' ? (
          <Notice ref={resultRef} tabIndex={-1} className="mb-4">
            <p className="m-0 font-bold">{t('saved')}</p>
          </Notice>
        ) : null}
        {outcome?.kind === 'failed' ? (
          <div ref={resultRef} tabIndex={-1} role="alert" className="mb-4 flex items-start gap-3 rounded-control border border-danger bg-paper px-3.5 py-3 text-base text-ink">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
            <div className="min-w-0 wrap-anywhere">
              <p className="m-0 font-bold">{t('failed')}</p>
              <p className="m-0">{outcome.message}</p>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button type="submit" loading={saving} disabled={!dirty} className="w-full sm:w-auto">
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
          <Button variant="secondary" disabled={!dirty || saving} onClick={discard} className="w-full sm:w-auto">
            {t('actions.discard')}
          </Button>
          <p className="m-0 min-w-0 text-base text-muted">{dirty ? t('actions.dirty') : t('actions.clean')}</p>
        </div>
      </div>
    </form>
  );
}

// --- the page -----------------------------------------------------------------------------------

function SettingsPage() {
  const { t } = useTranslation('settings');
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => api.get(ADMIN.getSettings.path, { schema: SettingsView, signal }),
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
        {hasAnySetting(query.data) ? (
          <SettingsForm saved={query.data} />
        ) : (
          <EmptyState className="mt-8" title={t('empty.title')} hint={t('empty.hint')} />
        )}
        <ServerPanel />
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

export const Route = createFileRoute('/admin/settings')({ component: SettingsPage });
