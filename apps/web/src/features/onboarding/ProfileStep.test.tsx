import { describe, expect, mock, test } from 'bun:test';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { OnboardingOptions } from '@api-types/onboarding';
import { EXPERIENCE_LEVELS, GOALS, type ExperienceLevel, type Goal, type Locale } from '@api-types/primitives';
import { createI18n, LOCALES } from '../../lib/i18n';
import messages from './profile-step.messages';
import { ProfileStep, type ProfileDraft } from './ProfileStep';

/*
 * ProfileStep is presentational: the OnboardingOptions payload and the draft come in as props, `onChange` and `onContinue`
 * go out. Expected strings are written out for en/ru so a copy slip is caught, and read from the messages file for kk
 * (a native review of the Kazakh copy must not break the tests).
 */

// A full contract payload (only levels and goals matter here) proves the prop accepts the merged endpoint's shape.
const OPTIONS: OnboardingOptions = {
  levels: ['beginner', 'basic', 'intermediate'],
  goals: ['control', 'dribbling', 'passing', 'weakfoot', 'coordination'],
  equipment: [],
  spaces: [],
  partner: [],
  daysPerWeek: [],
  minutesPerSession: [],
  tests: [],
};

const EMPTY: ProfileDraft = { age: '', level: null, goal: null };
const ERROR_EN = 'Enter your age as a whole number from 5 to 99.';

function instanceFor(locale: Locale) {
  return createI18n({
    modules: { './profile-step.messages.ts': { default: messages } },
    languages: [locale],
    storage: { getItem: () => null, setItem: () => {} },
    root: { lang: '' },
  });
}

type HarnessProps = {
  locale?: Locale;
  options?: Pick<OnboardingOptions, 'levels' | 'goals'>;
  initial?: ProfileDraft;
  onChange?: (draft: ProfileDraft) => void;
  onContinue?: (values: { age: number; level: ExperienceLevel; goal: Goal }) => void;
};

/** Owns the draft the way the wizard will, so typing and clicking behave as in the app. */
function Harness({ locale = 'en', options = OPTIONS, initial = EMPTY, onChange, onContinue = () => {} }: HarnessProps) {
  const [instance] = useState(() => instanceFor(locale));
  const [draft, setDraft] = useState(initial);
  return (
    <I18nextProvider i18n={instance}>
      <ProfileStep
        options={options}
        value={draft}
        onChange={(next) => {
          setDraft(next);
          onChange?.(next);
        }}
        onContinue={onContinue}
      />
    </I18nextProvider>
  );
}

const ageInput = () => screen.getByLabelText<HTMLInputElement>('Age');
const continueButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' });
const radioNames = (group: HTMLElement) => within(group).queryAllByRole('radio').map((radio) => accessibleName(radio));
const levelGroup = () => screen.getByRole('radiogroup', { name: 'Current level' });
const goalGroup = () => screen.getByRole('radiogroup', { name: 'Main goal' });

function accessibleName(radio: HTMLElement): string {
  return (radio.closest('label')?.textContent ?? '').trim();
}

describe('age validation', () => {
  const INVALID = [
    ['empty', ''],
    ['below the minimum (4)', '4'],
    ['above the maximum (100)', '100'],
    ['a decimal (12.5)', '12.5'],
    ['text', 'abc'],
  ] as const;

  for (const [name, raw] of INVALID) {
    test(`${name} blocks Continue and shows the message, tied to the input`, async () => {
      const user = userEvent.setup();
      const onContinue = mock();
      render(<Harness initial={{ age: '', level: 'basic', goal: 'dribbling' }} onContinue={onContinue} />);

      await user.click(ageInput());
      if (raw !== '') await user.type(ageInput(), raw);
      await user.tab();

      expect(continueButton().disabled).toBe(true);
      const message = screen.getByRole('alert');
      expect(message.textContent).toContain(ERROR_EN);
      expect(ageInput().getAttribute('aria-invalid')).toBe('true');
      expect(ageInput().getAttribute('aria-describedby')?.split(' ')).toContain(message.id);

      await user.click(continueButton());
      expect(onContinue).not.toHaveBeenCalled();
    });
  }

  test('a pristine form shows no message and Continue is disabled', () => {
    render(<Harness />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(ageInput().value).toBe('');
    expect(continueButton().disabled).toBe(true);
  });

  test('the message goes away, and Continue is enabled, once the age is fixed', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ age: '', level: 'basic', goal: 'dribbling' }} />);
    await user.type(ageInput(), '4');
    await user.tab();
    expect(screen.getByRole('alert')).toBeTruthy();

    await user.clear(ageInput());
    await user.type(ageInput(), '9');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(ageInput().getAttribute('aria-invalid')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  for (const raw of ['5', '99', '12']) {
    test(`age ${raw} is accepted`, async () => {
      const user = userEvent.setup();
      render(<Harness initial={{ age: '', level: 'basic', goal: 'dribbling' }} />);
      await user.type(ageInput(), raw);
      await user.tab();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(continueButton().disabled).toBe(false);
    });
  }

  test('the age input is a labelled number field carrying the contract bounds', () => {
    render(<Harness />);
    expect(ageInput().tagName).toBe('INPUT');
    expect(ageInput().type).toBe('number');
    expect(ageInput().getAttribute('min')).toBe('5');
    expect(ageInput().getAttribute('max')).toBe('99');
    expect(ageInput().getAttribute('inputmode')).toBe('numeric');
  });
});

describe('Continue', () => {
  test('is disabled until age, level and goal are all chosen, then calls onContinue with typed values', async () => {
    const user = userEvent.setup();
    const onContinue = mock();
    render(<Harness onContinue={onContinue} />);
    expect(continueButton().disabled).toBe(true);

    await user.type(ageInput(), '12');
    expect(continueButton().disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    expect(continueButton().disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: 'Improve dribbling' }));
    expect(continueButton().disabled).toBe(false);

    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith({ age: 12, level: 'basic', goal: 'dribbling' });
  });

  test('stays disabled with a valid age and goal but no level', () => {
    render(<Harness initial={{ age: '12', level: null, goal: 'control' }} />);
    expect(continueButton().disabled).toBe(true);
  });

  test('stays disabled with a valid age and level but no goal', () => {
    render(<Harness initial={{ age: '12', level: 'basic', goal: null }} />);
    expect(continueButton().disabled).toBe(true);
  });

  test('stays disabled when the draft holds a level or goal that the options no longer offer', () => {
    const { unmount } = render(
      <Harness options={{ levels: ['beginner'], goals: OPTIONS.goals }} initial={{ age: '12', level: 'intermediate', goal: 'control' }} />,
    );
    expect(continueButton().disabled).toBe(true);
    unmount();

    render(<Harness options={{ levels: OPTIONS.levels, goals: ['passing'] }} initial={{ age: '12', level: 'basic', goal: 'control' }} />);
    expect(continueButton().disabled).toBe(true);
  });

  test('is enabled for a fully valid draft', () => {
    render(<Harness initial={{ age: '12', level: 'basic', goal: 'control' }} />);
    expect(continueButton().disabled).toBe(false);
  });

  test('says why it is disabled, and links the hint to the button', () => {
    render(<Harness />);
    const hint = document.getElementById(continueButton().getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Enter your age and choose a level and a goal.');
  });

  test('a fully valid draft has no disabled hint', () => {
    render(<Harness initial={{ age: '12', level: 'basic', goal: 'control' }} />);
    expect(screen.queryByText('Enter your age and choose a level and a goal.')).toBeNull();
  });

  test('pressing Enter in the age field submits a valid draft once', async () => {
    const user = userEvent.setup();
    const onContinue = mock();
    render(<Harness initial={{ age: '12', level: 'basic', goal: 'control' }} onContinue={onContinue} />);
    await user.click(ageInput());
    await user.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith({ age: 12, level: 'basic', goal: 'control' });
  });

  test('pressing Enter never submits an invalid draft', async () => {
    const user = userEvent.setup();
    const onContinue = mock();
    render(<Harness initial={{ age: '100', level: 'basic', goal: 'control' }} onContinue={onContinue} />);
    await user.click(ageInput());
    await user.keyboard('{Enter}');
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('a submit event on an invalid draft (bypassing the disabled button) does not call onContinue', () => {
    const onContinue = mock();
    render(<Harness initial={{ age: '4', level: 'basic', goal: 'control' }} onContinue={onContinue} />);
    fireEvent.submit(ageInput().closest('form') as HTMLFormElement);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe('options come only from the options prop', () => {
  test('renders exactly the offered levels and goals, in the offered order', () => {
    render(<Harness options={{ levels: ['beginner', 'intermediate'], goals: ['weakfoot', 'passing'] }} />);
    expect(radioNames(levelGroup())).toEqual(['Beginner', 'Intermediate']);
    expect(radioNames(goalGroup())).toEqual(['Improve my weaker foot', 'Passing and first touch']);
    expect(screen.queryByRole('radio', { name: 'Basic' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Improve dribbling' })).toBeNull();
  });

  test('a changed options prop changes the rendered choices', () => {
    const { rerender } = render(<Harness options={{ levels: ['beginner', 'basic'], goals: ['control'] }} />);
    expect(radioNames(levelGroup())).toEqual(['Beginner', 'Basic']);
    expect(radioNames(goalGroup())).toEqual(['Control the ball with confidence']);

    rerender(<Harness options={{ levels: ['intermediate'], goals: ['coordination', 'dribbling', 'passing'] }} />);
    expect(radioNames(levelGroup())).toEqual(['Intermediate']);
    expect(radioNames(goalGroup())).toEqual(['Coordination', 'Improve dribbling', 'Passing and first touch']);
  });

  test('the full contract payload renders every level and goal it lists', () => {
    render(<Harness />);
    expect(radioNames(levelGroup())).toEqual(['Beginner', 'Basic', 'Intermediate']);
    expect(radioNames(goalGroup())).toHaveLength(5);
  });

  test('a value the messages do not know is shown as its raw value, never blank', () => {
    render(<Harness options={{ levels: ['beginner', 'expert' as ExperienceLevel], goals: ['control'] }} />);
    expect(radioNames(levelGroup())).toEqual(['Beginner', 'expert']);
    expect(screen.getByRole('radio', { name: 'expert' })).toBeTruthy();
  });

  test('selecting a card reports the whole next draft through onChange', async () => {
    const user = userEvent.setup();
    const onChange = mock();
    render(<Harness initial={{ age: '12', level: null, goal: null }} onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    expect(onChange).toHaveBeenLastCalledWith({ age: '12', level: 'basic', goal: null });
    await user.click(screen.getByRole('radio', { name: 'Passing and first touch' }));
    expect(onChange).toHaveBeenLastCalledWith({ age: '12', level: 'basic', goal: 'passing' });
  });

  test('typing reports the raw age text through onChange', async () => {
    const user = userEvent.setup();
    const onChange = mock();
    render(<Harness onChange={onChange} />);
    await user.type(ageInput(), '12');
    expect(onChange).toHaveBeenLastCalledWith({ age: '12', level: null, goal: null });
  });

  test('shows the draft it is given: age text and the selected cards', () => {
    render(<Harness initial={{ age: '9', level: 'intermediate', goal: 'weakfoot' }} />);
    expect(ageInput().value).toBe('9');
    expect((screen.getByRole('radio', { name: 'Intermediate' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Beginner' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('radio', { name: 'Improve my weaker foot' }) as HTMLInputElement).checked).toBe(true);
  });

  test('does not fetch anything', async () => {
    const fetchSpy = mock(() => Promise.reject(new Error('ProfileStep must not fetch')));
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const user = userEvent.setup();
      render(<Harness />);
      await user.type(ageInput(), '12');
      await user.click(screen.getByRole('radio', { name: 'Basic' }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('labels, touch targets and the second signal', () => {
  test('every input is reachable by its label', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Age')).toBe(ageInput());
    expect((screen.getByLabelText('Beginner') as HTMLInputElement).type).toBe('radio');
    expect((screen.getByLabelText('Control the ball with confidence') as HTMLInputElement).type).toBe('radio');
  });

  test('the two groups are named radio groups, each with its own radios', () => {
    render(<Harness />);
    expect(within(levelGroup()).getAllByRole('radio')).toHaveLength(3);
    expect(within(goalGroup()).getAllByRole('radio')).toHaveLength(5);
    const names = new Set(screen.getAllByRole<HTMLInputElement>('radio').map((radio) => radio.name));
    expect(names.size).toBe(2);
  });

  test('every choice card is at least 44px tall and wraps long text', () => {
    render(<Harness />);
    for (const radio of screen.getAllByRole('radio')) {
      const card = radio.closest('label') as HTMLElement;
      expect(card.classList.contains('min-h-tap')).toBe(true);
      expect(card.classList.contains('wrap-anywhere') || card.classList.contains('break-words')).toBe(true);
    }
  });

  test('the whole card is the tap target: clicking its text selects it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('Intermediate'));
    expect((screen.getByRole('radio', { name: 'Intermediate' }) as HTMLInputElement).checked).toBe(true);
  });

  test('the selected card carries a check icon, an unselected one does not (not colour alone)', () => {
    render(<Harness initial={{ age: '', level: 'basic', goal: null }} />);
    const selected = screen.getByRole('radio', { name: 'Basic' }).closest('label') as HTMLElement;
    const other = screen.getByRole('radio', { name: 'Beginner' }).closest('label') as HTMLElement;
    expect(selected.querySelector('svg')).not.toBeNull();
    expect(selected.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(other.querySelector('svg')).toBeNull();
  });

  test('the step has a heading', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'A few questions to get started' })).toBeTruthy();
  });
});

describe('keyboard operability', () => {
  test('the whole step can be completed and submitted without a pointer', async () => {
    const user = userEvent.setup();
    const onContinue = mock();
    render(<Harness onContinue={onContinue} />);

    await user.tab();
    expect(document.activeElement).toBe(ageInput());
    await user.keyboard('12');

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Beginner' }));
    await user.keyboard(' ');
    expect((screen.getByRole('radio', { name: 'Beginner' }) as HTMLInputElement).checked).toBe(true);
    await user.keyboard('{ArrowDown}');
    expect((screen.getByRole('radio', { name: 'Basic' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Beginner' }) as HTMLInputElement).checked).toBe(false);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Control the ball with confidence' }));
    await user.keyboard(' ');

    await user.tab();
    expect(document.activeElement).toBe(continueButton());
    expect(continueButton().disabled).toBe(false);
    await user.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith({ age: 12, level: 'basic', goal: 'control' });
  });

  test('a disabled Continue is skipped by Tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).not.toBe(continueButton());
  });
});

describe('locales', () => {
  const RU = {
    heading: 'Несколько вопросов, чтобы начать',
    age: 'Возраст',
    level: 'Текущий уровень',
    goal: 'Главная цель',
    beginner: 'Начинающий',
    dribbling: 'Улучшить дриблинг',
    cont: 'Продолжить',
    error: 'Введите возраст целым числом от 5 до 99.',
  };

  test('ru renders Russian strings', async () => {
    const user = userEvent.setup();
    render(<Harness locale="ru" />);
    expect(screen.getByRole('heading', { name: RU.heading })).toBeTruthy();
    expect(screen.getByLabelText(RU.age)).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: RU.level })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: RU.goal })).toBeTruthy();
    expect(screen.getByRole('radio', { name: RU.beginner })).toBeTruthy();
    expect(screen.getByRole('radio', { name: RU.dribbling })).toBeTruthy();
    expect(screen.getByRole('button', { name: RU.cont })).toBeTruthy();
    await user.type(screen.getByLabelText(RU.age), '4');
    await user.tab();
    expect(screen.getByRole('alert').textContent).toContain(RU.error);
  });

  for (const locale of LOCALES) {
    test(`${locale} renders exactly its own messages, with the bounds filled in`, async () => {
      const user = userEvent.setup();
      const m = messages[locale];
      render(<Harness locale={locale} />);

      expect(screen.getByRole('heading', { name: m.title })).toBeTruthy();
      expect(screen.getByLabelText(m.age.label)).toBeTruthy();
      expect(screen.getByRole('radiogroup', { name: m.level.legend })).toBeTruthy();
      expect(screen.getByRole('radiogroup', { name: m.goal.legend })).toBeTruthy();
      expect(screen.getByRole('button', { name: m.continue })).toBeTruthy();
      for (const level of OPTIONS.levels) expect(screen.getByRole('radio', { name: m.levels[level] })).toBeTruthy();
      for (const goal of OPTIONS.goals) expect(screen.getByRole('radio', { name: m.goals[goal] })).toBeTruthy();

      const hintText = m.age.hint.replace('{{min}}', '5').replace('{{max}}', '99');
      expect(screen.getByText(hintText)).toBeTruthy();
      expect(hintText).not.toContain('{{');

      await user.type(screen.getByLabelText(m.age.label), '4');
      await user.tab();
      expect(screen.getByRole('alert').textContent).toContain(m.age.error.replace('{{min}}', '5').replace('{{max}}', '99'));
    });
  }

  test('the three locales render three different sets of strings', () => {
    const rendered = LOCALES.map((locale) => {
      const { unmount } = render(<Harness locale={locale} />);
      const text = document.body.textContent ?? '';
      unmount();
      return text;
    });
    expect(new Set(rendered).size).toBe(LOCALES.length);
    for (const text of rendered) expect(text.length).toBeGreaterThan(0);
  });
});

describe('profile-step messages', () => {
  function flatten(tree: unknown, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
      if (typeof value === 'string') out[`${prefix}${key}`] = value;
      else Object.assign(out, flatten(value, `${prefix}${key}.`));
    }
    return out;
  }

  test('kk, ru and en define exactly the same keys', () => {
    const kk = Object.keys(flatten(messages.kk)).sort();
    expect(kk.length).toBeGreaterThan(0);
    expect(Object.keys(flatten(messages.ru)).sort()).toEqual(kk);
    expect(Object.keys(flatten(messages.en)).sort()).toEqual(kk);
  });

  test('every value is non-empty text', () => {
    const blank: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(flatten(messages[locale]))) {
        if (value.trim() === '') blank.push(`${locale}.${key}`);
      }
    }
    expect(blank).toEqual([]);
  });

  test('the kk text is Kazakh, not a copy of the ru or en text', () => {
    const kk = flatten(messages.kk);
    const ru = flatten(messages.ru);
    const en = flatten(messages.en);
    const copied = Object.entries(kk)
      .filter(([key, value]) => value === ru[key] || value === en[key])
      .map(([key]) => key);
    expect(copied).toEqual([]);
  });

  test('every level and goal of the contract has a label in every locale', () => {
    const unlabelled: string[] = [];
    for (const locale of LOCALES) {
      const m = messages[locale] as unknown as { levels: Record<string, string>; goals: Record<string, string> };
      for (const level of EXPERIENCE_LEVELS) if (!m.levels[level]) unlabelled.push(`${locale} level ${level}`);
      for (const goal of GOALS) if (!m.goals[goal]) unlabelled.push(`${locale} goal ${goal}`);
    }
    expect(unlabelled).toEqual([]);
  });

  test('the age message and hint interpolate both bounds in every locale', () => {
    for (const locale of LOCALES) {
      expect(messages[locale].age.error).toContain('{{min}}');
      expect(messages[locale].age.error).toContain('{{max}}');
      expect(messages[locale].age.hint).toContain('{{min}}');
      expect(messages[locale].age.hint).toContain('{{max}}');
    }
  });
});
