import type { PlayerProfile } from '@api-types/domain';
import type { OnboardingOptions } from '@api-types/onboarding';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { type FormEvent, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { formatNumber, toLocale } from '../../lib/i18n';

/** The five answers this step collects. `undefined` = not chosen yet. */
export type ConditionsValue = Partial<
  Pick<PlayerProfile, 'equipment' | 'space' | 'partner' | 'daysPerWeek' | 'minutesPerSession'>
>;

export type ConditionsStepProps = {
  /** The onboarding payload (GET /api/onboarding/:sport). Only the lists this step shows are read; the parent fetches. */
  options: Pick<OnboardingOptions, 'equipment' | 'spaces' | 'partner' | 'daysPerWeek' | 'minutesPerSession'>;
  /** The current draft. Controlled: nothing is selected unless it is in here. */
  value: ConditionsValue;
  /** Receives the WHOLE next draft (`{ ...value, [changedField]: picked }`), so a parent can `setDraft(next)`. */
  onChange: (next: ConditionsValue) => void;
  onContinue: () => void;
  onBack: () => void;
};

type Choice = string | number | boolean;

/*
 * Reading chosen where the criteria are open: "valid" means all five answers are set AND each one is
 * an entry of the matching list in `options` (an answer the payload no longer offers is not valid).
 * The parent fetches; this component never does.
 */
function isComplete(options: ConditionsStepProps['options'], value: ConditionsValue): boolean {
  // The profile types days as a plain integer while the payload lists literals, hence the widening.
  const offered = (list: readonly Choice[], answer: Choice | undefined) => answer !== undefined && list.includes(answer);
  return (
    offered(options.equipment, value.equipment) &&
    offered(options.spaces, value.space) &&
    offered(options.partner, value.partner) &&
    offered(options.daysPerWeek, value.daysPerWeek) &&
    offered(options.minutesPerSession, value.minutesPerSession)
  );
}

/*
 * DESIGN.md "Options and Selection": paper card, 12px radius; selected = Field Green border + Morning Mint fill
 * + a check icon (the second signal) + the native checked state. Each card is a real radio inside its label, so the
 * browser gives one Tab stop per question, arrow-key movement and Space to pick. The input is visually hidden; the
 * focus ring is drawn on the card (DESIGN.md Visible Focus Rule). min-h-14 keeps every card above the 44px floor.
 */
const CARD =
  'flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-control border p-4 text-base text-ink ' +
  'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent';

type OptionGroupProps<T extends Choice> = {
  legend: string;
  name: string;
  options: readonly T[];
  selected: T | undefined;
  labelOf: (option: T) => string;
  onSelect: (option: T) => void;
  /** `wide`: one column on a phone, two from 600px (long labels). `compact`: short labels in a wrapping row. */
  layout: 'wide' | 'compact';
};

function OptionGroup<T extends Choice>({ legend, name, options, selected, labelOf, onSelect, layout }: OptionGroupProps<T>) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-3 p-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink">{legend}</legend>
      <div className={layout === 'wide' ? 'grid grid-cols-1 gap-2 min-[600px]:grid-cols-2' : 'flex flex-wrap gap-2'}>
        {options.map((option) => {
          const isSelected = selected === option;
          return (
            <label
              key={String(option)}
              className={clsx(
                CARD,
                layout === 'compact' && 'min-w-14 flex-1 justify-center',
                isSelected ? 'border-accent bg-accent-2 font-bold' : 'border-line bg-paper',
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(option)}
                checked={isSelected}
                onChange={() => onSelect(option)}
                className="sr-only"
              />
              <span className="min-w-0 wrap-anywhere">{labelOf(option)}</span>
              {isSelected ? <Check aria-hidden="true" data-slot="selected-mark" className="size-5 shrink-0" /> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ConditionsStep({ options, value, onChange, onContinue, onBack }: ConditionsStepProps) {
  const { t, i18n } = useTranslation('conditions-step');
  const id = useId();
  const locale = toLocale(i18n.language);
  const complete = isComplete(options, value);

  // A missing message renders '' (lib/i18n.ts); a payload value the messages do not know yet then shows as itself.
  const labelled = (key: string, option: Choice): string => t(key) || String(option);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (complete) onContinue();
  }

  return (
    <form noValidate aria-labelledby={`${id}-title`} onSubmit={submit} className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h2 id={`${id}-title`} className="text-[length:clamp(32px,5vw,60px)] leading-none font-bold tracking-[-0.05em] wrap-break-word text-ink">
          {t('title')}
        </h2>
        <p className="text-lg text-muted">{t('lead')}</p>
      </div>

      <OptionGroup
        legend={t('equipment.legend')}
        name={`${id}-equipment`}
        options={options.equipment}
        selected={value.equipment}
        labelOf={(option) => labelled(`equipment.options.${option}`, option)}
        onSelect={(equipment) => onChange({ ...value, equipment })}
        layout="wide"
      />
      <OptionGroup
        legend={t('space.legend')}
        name={`${id}-space`}
        options={options.spaces}
        selected={value.space}
        labelOf={(option) => labelled(`space.options.${option}`, option)}
        onSelect={(space) => onChange({ ...value, space })}
        layout="wide"
      />
      <OptionGroup
        legend={t('partner.legend')}
        name={`${id}-partner`}
        options={options.partner}
        selected={value.partner}
        labelOf={(option) => labelled(`partner.options.${option}`, option)}
        onSelect={(partner) => onChange({ ...value, partner })}
        layout="compact"
      />
      <OptionGroup
        legend={t('daysPerWeek.legend')}
        name={`${id}-days`}
        options={options.daysPerWeek}
        selected={value.daysPerWeek}
        labelOf={(option) => formatNumber(option, locale)}
        onSelect={(daysPerWeek) => onChange({ ...value, daysPerWeek })}
        layout="compact"
      />
      <OptionGroup
        legend={t('minutesPerSession.legend')}
        name={`${id}-minutes`}
        options={options.minutesPerSession}
        selected={value.minutesPerSession}
        labelOf={(option) => t('minutesPerSession.value', { value: formatNumber(option, locale) })}
        onSelect={(minutesPerSession) => onChange({ ...value, minutesPerSession })}
        layout="compact"
      />

      <div className="flex flex-col gap-3">
        {complete ? null : (
          <p id={`${id}-incomplete`} className="text-base text-muted">
            {t('incomplete')}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={onBack}>
            {t('back')}
          </Button>
          <Button
            type="submit"
            disabled={!complete}
            aria-describedby={complete ? undefined : `${id}-incomplete`}
            className="flex-1"
          >
            {t('continue')}
          </Button>
        </div>
      </div>
    </form>
  );
}
