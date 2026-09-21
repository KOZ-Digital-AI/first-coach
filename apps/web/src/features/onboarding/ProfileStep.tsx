import { AGE_MAX, AGE_MIN } from '@api-types/domain';
import type { OnboardingOptions } from '@api-types/onboarding';
import type { ExperienceLevel, Goal } from '@api-types/primitives';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { formatNumber, toLocale } from '../../lib/i18n';

/**
 * Onboarding step 1: age, current level, main goal.
 *
 * Presentational: it never fetches. The choices for level and goal come ONLY from `options` (the merged
 * GET /api/onboarding/:sport payload); the messages file only labels the contract's enum values.
 *
 * Readings of the criteria:
 * - The draft keeps the age as the raw text the child typed, so "12.5" and "" stay visible and can be rejected;
 *   `onContinue` receives the parsed integer.
 * - The age message appears once the field has been left (blur) and then follows the value live, so a child typing
 *   "12" is not told "1" is wrong.
 * - A draft level/goal that the current options do not offer counts as not chosen.
 */

export type ProfileDraft = {
  /** Raw text of the age field. */
  age: string;
  level: ExperienceLevel | null;
  goal: Goal | null;
};

export type ProfileValues = { age: number; level: ExperienceLevel; goal: Goal };

export type ProfileStepProps = {
  options: Pick<OnboardingOptions, 'levels' | 'goals'>;
  value: ProfileDraft;
  /** Receives the whole next draft. */
  onChange: (next: ProfileDraft) => void;
  onContinue: (values: ProfileValues) => void;
};

/** Whole number of digits only (no sign, decimals or exponent) within the contract bounds, else null. */
function parseAge(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const age = Number(text);
  return age >= AGE_MIN && age <= AGE_MAX ? age : null;
}

type ChoiceGroupProps<V extends string> = {
  legend: string;
  name: string;
  values: readonly V[];
  selected: V | null;
  labelOf: (value: V) => string;
  onSelect: (value: V) => void;
};

/* DESIGN.md Options and Selection: paper card, 12px radius; selected = Field Green border + Morning Mint fill + a check
 * icon (never colour alone). The native radio is visually hidden but stays focusable, so arrow keys and Space work; the
 * focus ring is drawn on the card. */
function ChoiceGroup<V extends string>({ legend, name, values, selected, labelOf, onSelect }: ChoiceGroupProps<V>) {
  return (
    <fieldset role="radiogroup" className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-[13px] font-bold text-ink">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {values.map((choice) => {
          const checked = choice === selected;
          return (
            <label
              key={choice}
              className={clsx(
                'flex min-h-tap min-w-0 cursor-pointer items-center gap-3 rounded-control border p-4 wrap-anywhere text-ink',
                'has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                checked ? 'border-accent bg-accent-2' : 'border-line bg-paper hover:bg-bg',
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice}
                checked={checked}
                onChange={() => onSelect(choice)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={clsx(
                  'grid size-6 shrink-0 place-items-center rounded-pill border',
                  checked ? 'border-accent bg-accent text-white' : 'border-line bg-white',
                )}
              >
                {checked ? <Check aria-hidden="true" size={16} strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 font-bold">{labelOf(choice)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ProfileStep({ options, value, onChange, onContinue }: ProfileStepProps) {
  const { t, i18n } = useTranslation('profile-step');
  const groupId = useId();
  const hintId = `${groupId}-continue-hint`;
  const [touched, setTouched] = useState(false);

  const locale = toLocale(i18n.language);
  const bounds = { min: formatNumber(AGE_MIN, locale), max: formatNumber(AGE_MAX, locale) };

  const age = parseAge(value.age);
  const level = value.level !== null && options.levels.includes(value.level) ? value.level : null;
  const goal = value.goal !== null && options.goals.includes(value.goal) ? value.goal : null;
  const complete = age !== null && level !== null && goal !== null;

  // A value the messages do not know falls back to the raw enum value: never a blank card.
  const labelFor = (group: 'levels' | 'goals') => (choice: string) => t(`${group}.${choice}`) || choice;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (age === null || level === null || goal === null) {
      setTouched(true);
      return;
    }
    onContinue({ age, level, goal });
  }

  return (
    <form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-6">
      <h2 className="text-xl font-bold tracking-[-0.025em] text-ink wrap-break-word">{t('title')}</h2>

      <Field
        label={t('age.label')}
        hint={t('age.hint', bounds)}
        error={touched && age === null ? t('age.error', bounds) : undefined}
      >
        {(control) => (
          <input
            {...control}
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min={AGE_MIN}
            max={AGE_MAX}
            step={1}
            value={value.age}
            onChange={(event) => onChange({ ...value, age: event.target.value })}
            onBlur={() => setTouched(true)}
          />
        )}
      </Field>

      <ChoiceGroup
        legend={t('level.legend')}
        name={`${groupId}-level`}
        values={options.levels}
        selected={level}
        labelOf={labelFor('levels')}
        onSelect={(next) => onChange({ ...value, level: next })}
      />

      <ChoiceGroup
        legend={t('goal.legend')}
        name={`${groupId}-goal`}
        values={options.goals}
        selected={goal}
        labelOf={labelFor('goals')}
        onSelect={(next) => onChange({ ...value, goal: next })}
      />

      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={!complete} aria-describedby={complete ? undefined : hintId} className="w-full sm:w-auto sm:self-start">
          {t('continue')}
        </Button>
        {complete ? null : (
          <p id={hintId} className="text-[13px] text-muted wrap-break-word">
            {t('continueHint')}
          </p>
        )}
      </div>
    </form>
  );
}
