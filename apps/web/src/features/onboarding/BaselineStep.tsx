import { clsx } from 'clsx';
import { Check, Info } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickLocalized } from '@api-types/primitives';
import type { SkillTest } from '@api-types/domain';
import type { Equipment } from '@api-types/primitives';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field } from '../../components/ui/field';
import { Notice } from '../../components/ui/notice';
import { DEFAULT_LOCALE, toLocale } from '../../lib/i18n';

/*
 * Onboarding step: baseline skill tests. Presentational and controlled: the tests come from props (the
 * onboarding options), the draft lives in the parent, nothing is fetched here.
 *
 * Readings chosen where the bead is silent (also reported to the parent):
 *  - Draft entries exist only for a test that is skipped or has been touched. `value: null` with
 *    `skipped: false` means "not measured yet" (blank or unparsable box). A skipped test carries
 *    `value: 0` because the contract makes `value` required (the server then uses the self level).
 *  - "Errors" is offered for a lower-is-better (time) test: the level estimator only reads `errors` there
 *    (planner/levels.ts). SkillTest has no field that says "takes errors", so this is the contract's rule.
 *  - Decimals (point or comma) are accepted where time is measured; a count (higher is better) and the
 *    errors counter must be whole numbers. Nothing negative, nothing non-finite.
 *  - The player's kit is one preset, not a list. What a preset covers is `EQUIPMENT_OWNED`, a copy of the
 *    table in api/src/planner/candidates.ts (the web may only import shared/*); a test pins them equal.
 *  - The API sends `metric` and `unit` as plain English text (not localized), so they are shown as sent.
 *  - `attempts` (weak foot: "successes out of 10 attempts") is not collected: nothing in SkillTest says which
 *    tests take it, and the estimator ignores it.
 */

/** One entry of the parent's draft. `results` may omit tests that were never touched. */
export type BaselineDraftResult = {
  testSlug: string;
  /** `null` = not measured yet. A skipped test has 0 (the contract requires a number). */
  value: number | null;
  errors?: number;
  skipped: boolean;
};

/** What Continue sends: one complete entry per test, ready to become a BaselineResult (plus a clientUuid). */
export type BaselineFinalResult = {
  testSlug: string;
  value: number;
  errors?: number;
  skipped: boolean;
};

/** What each equipment preset lets a player do. Copy of `EQUIPMENT_OWNED` in api/src/planner/candidates.ts. */
export const EQUIPMENT_OWNED: Readonly<Record<Equipment, readonly Equipment[]>> = {
  nothing: ['nothing'],
  ball: ['nothing', 'ball'],
  ball_wall: ['nothing', 'ball', 'ball_wall'],
  cones: ['nothing', 'ball', 'cones'],
  full_field: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
};

export type BaselineStepProps = {
  /** Straight from OnboardingOptions.tests. */
  tests: readonly SkillTest[];
  /** The player's kit (PlayerProfile.equipment): tests that need more are pre-skipped. */
  equipment: Equipment;
  results: readonly BaselineDraftResult[];
  onChange: (results: BaselineDraftResult[]) => void;
  onContinue: (results: BaselineFinalResult[]) => void;
  onBack: () => void;
};

// --- parsing ------------------------------------------------------------------------------------

type Invalid = 'notNumber' | 'negative' | 'whole' | 'tooBig';
type Parsed = { ok: true; value: number } | { ok: false; reason: Invalid | 'empty' };

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

// --- per-test view ------------------------------------------------------------------------------

type Raw = { value?: string; errors?: string };

type View = {
  test: SkillTest;
  status: 'pending' | 'done' | 'skipped' | 'invalid';
  /** The kit does not cover this test (whether or not the player has un-skipped it since). */
  lacksKit: boolean;
  valueText: string;
  errorsText: string;
  value: Parsed;
  errors: Parsed;
  takesErrors: boolean;
  decimals: boolean;
};

const takesErrors = (test: SkillTest): boolean => test.direction === 'lower';

function draftOf(test: SkillTest, entry: BaselineDraftResult | undefined, lacksKit: boolean): BaselineDraftResult | undefined {
  if (entry !== undefined) return entry;
  return lacksKit ? { testSlug: test.slug, value: 0, skipped: true } : undefined;
}

function viewOf(test: SkillTest, entry: BaselineDraftResult | undefined, raw: Raw | undefined, equipment: Equipment): View {
  const lacksKit = !EQUIPMENT_OWNED[equipment].includes(test.equipment);
  const skipped = draftOf(test, entry, lacksKit)?.skipped === true;
  const fromDraft = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));
  const valueText = skipped ? '' : (raw?.value ?? fromDraft(entry?.value));
  const errorsText = skipped || !takesErrors(test) ? '' : (raw?.errors ?? fromDraft(entry?.errors));
  const decimals = test.direction === 'lower';
  const value = parseAmount(valueText, decimals);
  const errors = parseAmount(errorsText, false);
  const wrong = (parsed: Parsed) => !parsed.ok && parsed.reason !== 'empty';
  let status: View['status'];
  if (skipped) status = 'skipped';
  else if (wrong(value) || wrong(errors)) status = 'invalid';
  else status = value.ok ? 'done' : 'pending';
  return { test, status, lacksKit, valueText, errorsText, value, errors, takesErrors: takesErrors(test), decimals };
}

// --- component ----------------------------------------------------------------------------------

export function BaselineStep({ tests, equipment, results, onChange, onContinue, onBack }: BaselineStepProps) {
  const { t, i18n } = useTranslation('baseline-step');
  const locale = toLocale(i18n.language) ?? DEFAULT_LOCALE;
  const [raw, setRaw] = useState<Record<string, Raw>>({});

  const entryOf = (test: SkillTest) => results.find((entry) => entry.testSlug === test.slug);
  const views = tests.map((test) => viewOf(test, entryOf(test), raw[test.slug], equipment));

  /** The whole draft in the order of the tests, with `next` replacing this test's entry. */
  function emit(next: BaselineDraftResult): void {
    onChange(
      tests.flatMap((test) => {
        if (test.slug === next.testSlug) return [next];
        const current = draftOf(test, entryOf(test), !EQUIPMENT_OWNED[equipment].includes(test.equipment));
        return current === undefined ? [] : [current];
      }),
    );
  }

  function edit(view: View, patch: Raw): void {
    const merged = { value: view.valueText, errors: view.errorsText, ...patch };
    setRaw((current) => ({ ...current, [view.test.slug]: merged }));
    const value = parseAmount(merged.value, view.decimals);
    const errors = view.takesErrors ? parseAmount(merged.errors, false) : ({ ok: false, reason: 'empty' } as const);
    emit({
      testSlug: view.test.slug,
      value: value.ok ? value.value : null,
      ...(errors.ok ? { errors: errors.value } : {}),
      skipped: false,
    });
  }

  function toggleSkip(view: View): void {
    setRaw((current) => ({ ...current, [view.test.slug]: { value: '', errors: '' } }));
    emit(
      view.status === 'skipped'
        ? { testSlug: view.test.slug, value: null, skipped: false }
        : { testSlug: view.test.slug, value: 0, skipped: true },
    );
  }

  const done = views.filter((view) => view.status === 'done' || view.status === 'skipped').length;
  const anyInvalid = views.some((view) => view.status === 'invalid');
  const ready = done === views.length;

  function proceed(): void {
    if (!ready) return;
    onContinue(
      views.map((view): BaselineFinalResult => {
        if (view.status === 'skipped' || !view.value.ok) return { testSlug: view.test.slug, value: 0, skipped: true };
        return {
          testSlug: view.test.slug,
          value: view.value.value,
          ...(view.errors.ok ? { errors: view.errors.value } : {}),
          skipped: false,
        };
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h2 className="text-[32px] leading-none font-bold tracking-[-0.05em] text-ink">{t('title')}</h2>
        <p className="text-lg leading-normal text-ink">{t('lead')}</p>
        <Notice>{t('privacy')}</Notice>
      </header>

      {views.length === 0 ? (
        <Notice>{t('empty')}</Notice>
      ) : (
        <ul role="list" className="flex list-none flex-col gap-4 p-0">
          {views.map((view, index) => (
            <li key={view.test.slug}>
              <TestCard
                view={view}
                index={index + 1}
                total={views.length}
                protocol={pickLocalized(view.test.protocol, locale)}
                onValue={(text) => edit(view, { value: text })}
                onErrors={(text) => edit(view, { errors: text })}
                onSkip={() => toggleSkip(view)}
              />
            </li>
          ))}
        </ul>
      )}

      <footer className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="h-2.5 flex-1 overflow-hidden rounded-pill bg-line">
            <div className="h-full rounded-pill bg-accent" style={{ width: `${views.length === 0 ? 100 : (done / views.length) * 100}%` }} />
          </div>
          <p className="text-[13px] font-bold text-ink">{t('progress', { done, total: views.length })}</p>
        </div>
        {!ready ? <p className="text-base text-ink">{anyInvalid ? t('blockedInvalid') : t('blockedIncomplete')}</p> : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
          <Button variant="secondary" onClick={onBack} className="w-full sm:w-auto">
            {t('back')}
          </Button>
          <Button variant="primary" disabled={!ready} onClick={proceed} className="w-full sm:w-auto">
            {t('continue')}
          </Button>
        </div>
      </footer>
    </div>
  );
}

// --- one test -----------------------------------------------------------------------------------

const SKIP_BUTTON =
  'inline-flex min-h-tap min-w-tap max-w-full cursor-pointer items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold text-ink wrap-anywhere';

type TestCardProps = {
  view: View;
  index: number;
  total: number;
  protocol: string | undefined;
  onValue: (text: string) => void;
  onErrors: (text: string) => void;
  onSkip: () => void;
};

function TestCard({ view, index, total, protocol, onValue, onErrors, onSkip }: TestCardProps) {
  const { t } = useTranslation('baseline-step');
  const headingId = useId();
  const { test } = view;
  const skipped = view.status === 'skipped';
  const steps = protocol === undefined ? [] : protocolSteps(protocol);

  const message = (parsed: Parsed, negativeKey: 'negative' | 'errorsNegative'): string | undefined => {
    if (parsed.ok || parsed.reason === 'empty') return undefined;
    return t(`invalid.${parsed.reason === 'negative' ? negativeKey : parsed.reason}`);
  };

  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-bold tracking-[0.12em] text-accent uppercase">{t('testOf', { index, total })}</p>
        <h3 id={headingId} className="text-xl leading-tight font-bold tracking-[-0.025em] text-ink wrap-anywhere">
          {test.metric}
        </h3>
      </div>

      {/* The protocol carries the warm-up and soft-ball rules: it comes first and is shown as sent. */}
      {steps.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="font-bold text-ink">{t('howToMeasure')}</p>
          <ol role="list" className="flex list-none flex-col gap-2 p-0 [counter-reset:step]">
            {steps.map((step, position) => (
              <li
                key={position}
                className="flex items-start gap-3 text-base leading-[1.45] text-ink [counter-increment:step] before:grid before:size-7 before:shrink-0 before:place-items-center before:rounded-pill before:bg-accent-2 before:text-sm before:font-bold before:text-ink before:content-[counter(step)]"
              >
                <span className="min-w-0 pt-0.5 wrap-anywhere">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className={clsx('grid gap-3', view.takesErrors && 'sm:grid-cols-2')}>
        <Field
          label={t('valueLabel', { unit: test.unit })}
          hint={view.decimals ? t('valueHintDecimal') : undefined}
          error={message(view.value, 'negative')}
        >
          {(control) => (
            <input
              {...control}
              aria-describedby={[control['aria-describedby'], headingId].filter(Boolean).join(' ')}
              type="text"
              inputMode={view.decimals ? 'decimal' : 'numeric'}
              autoComplete="off"
              value={view.valueText}
              onChange={(event) => onValue(event.target.value)}
            />
          )}
        </Field>
        {view.takesErrors ? (
          <Field label={t('errorsLabel')} hint={t('errorsHint')} error={message(view.errors, 'errorsNegative')}>
            {(control) => (
              <input
                {...control}
                aria-describedby={[control['aria-describedby'], headingId].filter(Boolean).join(' ')}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={view.errorsText}
                onChange={(event) => onErrors(event.target.value)}
              />
            )}
          </Field>
        ) : null}
      </div>

      <button
        type="button"
        aria-pressed={skipped}
        aria-describedby={headingId}
        onClick={onSkip}
        className={clsx(SKIP_BUTTON, skipped ? 'border-accent bg-accent-2' : 'border-line bg-paper hover:bg-bg')}
      >
        {skipped ? <Check aria-hidden="true" className="size-5 shrink-0" /> : null}
        {t('skip')}
      </button>

      {/* Always in the DOM so a screen reader announces the text when it appears. */}
      <div role="status" className="empty:hidden">
        {skipped ? (
          <p className="flex items-start gap-2 text-base text-ink">
            <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 wrap-anywhere">
              {view.lacksKit ? t('skippedEquipment', { needs: t(`equipmentNeeds.${test.equipment}`) }) : t('skipped')}
            </span>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
