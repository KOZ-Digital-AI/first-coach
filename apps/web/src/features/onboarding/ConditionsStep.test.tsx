import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION } from '@api-types/domain';
import type { OnboardingOptions } from '@api-types/onboarding';
import { EQUIPMENT, SPACES, type Locale } from '@api-types/primitives';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES } from '../../lib/i18n';
import { ConditionsStep, type ConditionsValue } from './ConditionsStep';
import messages from './conditions-step.messages';

/*
 * ConditionsStep is presentational: the option lists, the draft and every callback arrive as props.
 * Contract under test (fc-mol-9l4.13): equipment and space as option cards, partner yes/no, days per
 * week and minutes per session, all from the options payload; the selected card carries an icon as
 * well as colour; Continue is disabled until the draft is valid. Strings come from the kk/ru/en
 * messages file, registered by the repo's `*.messages.ts` glob (namespace = file base name).
 */

type Props = Parameters<typeof ConditionsStep>[0];
type Options = Props['options'];

// --- fixtures ----------------------------------------------------------------------------------

const CONTRACT_OPTIONS: OnboardingOptions = {
  levels: ['beginner', 'basic', 'intermediate'],
  goals: ['control', 'dribbling', 'passing', 'weakfoot', 'coordination'],
  equipment: [...EQUIPMENT],
  spaces: [...SPACES],
  partner: [true, false],
  daysPerWeek: [...DAYS_PER_WEEK],
  minutesPerSession: [...MINUTES_PER_SESSION],
  tests: [],
};

const COMPLETE: ConditionsValue = {
  equipment: 'ball',
  space: 'yard',
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
};

const MODULES = { '../features/onboarding/conditions-step.messages.ts': { default: messages } };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function tree(locale: Locale, path: string): string {
  let node: unknown = messages[locale];
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  if (typeof node !== 'string') throw new Error(`no string at ${locale}:${path}`);
  return node;
}

type Handlers = { onChange: ReturnType<typeof mock>; onContinue: ReturnType<typeof mock>; onBack: ReturnType<typeof mock> };

function setup(overrides: Partial<Props> = {}, locale: Locale = 'en') {
  const handlers: Handlers = { onChange: mock(), onContinue: mock(), onBack: mock() };
  const i18n = createI18n({ modules: MODULES, languages: [locale], storage: memoryStorage(), root: { lang: '' }, dev: false });
  const tsx = (extra: Partial<Props>) => (
    <I18nextProvider i18n={i18n}>
      <ConditionsStep
        options={CONTRACT_OPTIONS}
        value={{}}
        {...handlers}
        {...overrides}
        {...extra}
      />
    </I18nextProvider>
  );
  const view = render(tsx({}));
  return { ...handlers, rerender: (extra: Partial<Props>) => view.rerender(tsx(extra)) };
}

const group = (name: string) => screen.getByRole('group', { name });
const radiosIn = (name: string) => within(group(name)).getAllByRole<HTMLInputElement>('radio');
const labelsIn = (name: string) => radiosIn(name).map((radio) => radio.labels?.[0]?.textContent?.trim());
const continueButton = (locale: Locale = 'en') => screen.getByRole<HTMLButtonElement>('button', { name: tree(locale, 'continue') });

const EN = {
  equipment: tree('en', 'equipment.legend'),
  space: tree('en', 'space.legend'),
  partner: tree('en', 'partner.legend'),
  days: tree('en', 'daysPerWeek.legend'),
  minutes: tree('en', 'minutesPerSession.legend'),
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(() => {
    throw new Error('ConditionsStep must not fetch');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  globalThis.fetch = realFetch;
});

// --- option sets come from props -----------------------------------------------------------------

describe('option sets come from the options prop', () => {
  test('the contract equipment set renders as the five named cards, in payload order', () => {
    setup();
    expect(labelsIn(EN.equipment)).toEqual(['Nothing', 'Ball only', 'Ball + wall', 'Cones', 'Full field']);
  });

  test('the contract space set renders as the four named cards, in payload order', () => {
    setup();
    expect(labelsIn(EN.space)).toEqual(['Home 3×3 m', 'Yard', 'Field', 'Gym']);
  });

  test('partner renders a Yes and a No card, days the numerals and minutes the durations', () => {
    setup();
    expect(labelsIn(EN.partner)).toEqual(['Yes', 'No']);
    expect(labelsIn(EN.days)).toEqual(['2', '3', '4', '5', '6']);
    expect(labelsIn(EN.minutes)).toEqual(['10 min', '15 min', '20 min', '30 min', '45 min']);
  });

  test('a different payload renders a different set: nothing is hard-coded in the component', () => {
    const options: Options = {
      equipment: ['cones', 'ball'],
      spaces: ['gym'],
      partner: [true],
      daysPerWeek: [4],
      minutesPerSession: [15, 30],
    };
    setup({ options });
    expect(labelsIn(EN.equipment)).toEqual(['Cones', 'Ball only']);
    expect(labelsIn(EN.space)).toEqual(['Gym']);
    expect(labelsIn(EN.partner)).toEqual(['Yes']);
    expect(labelsIn(EN.days)).toEqual(['4']);
    expect(labelsIn(EN.minutes)).toEqual(['15 min', '30 min']);
  });

  test('a value the messages do not know yet still renders as a card, labelled by the payload value', () => {
    const options: Options = { ...CONTRACT_OPTIONS, equipment: ['ball', 'trampoline' as never], spaces: ['roof' as never] };
    setup({ options });
    expect(labelsIn(EN.equipment)).toEqual(['Ball only', 'trampoline']);
    expect(labelsIn(EN.space)).toEqual(['roof']);
  });

  test('rerendering with a new payload replaces the cards', () => {
    const view = setup({ options: { ...CONTRACT_OPTIONS, equipment: ['ball'] } });
    expect(labelsIn(EN.equipment)).toEqual(['Ball only']);
    view.rerender({ options: { ...CONTRACT_OPTIONS, equipment: ['cones', 'full_field'] } });
    expect(labelsIn(EN.equipment)).toEqual(['Cones', 'Full field']);
  });
});

// --- selecting cards updates the value ------------------------------------------------------------

describe('selecting a card reports the new draft through onChange', () => {
  const CASES: { field: keyof ConditionsValue; group: string; card: string; expected: ConditionsValue }[] = [
    { field: 'equipment', group: EN.equipment, card: 'Cones', expected: { ...COMPLETE, equipment: 'cones' } },
    { field: 'space', group: EN.space, card: 'Gym', expected: { ...COMPLETE, space: 'gym' } },
    { field: 'partner', group: EN.partner, card: 'Yes', expected: { ...COMPLETE, partner: true } },
    { field: 'daysPerWeek', group: EN.days, card: '5', expected: { ...COMPLETE, daysPerWeek: 5 } },
    { field: 'minutesPerSession', group: EN.minutes, card: '45 min', expected: { ...COMPLETE, minutesPerSession: 45 } },
  ];

  test.each(CASES)('$field: clicking "$card" changes only that field, keeping the other four', async ({ group: name, card, expected }) => {
    const { onChange } = setup({ value: COMPLETE });
    await userEvent.click(within(group(name)).getByText(card));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(expected);
  });

  test('from an empty draft the first pick reports just that field', async () => {
    const { onChange } = setup({ value: {} });
    await userEvent.click(within(group(EN.space)).getByText('Field'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual({ space: 'field' });
  });

  test('the value that round-trips is the payload value, not the label: home_3x3 and ball_wall', async () => {
    const { onChange } = setup({ value: {} });
    await userEvent.click(within(group(EN.space)).getByText('Home 3×3 m'));
    await userEvent.click(within(group(EN.equipment)).getByText('Ball + wall'));
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([{ space: 'home_3x3' }, { equipment: 'ball_wall' }]);
  });

  test('partner No reports false (a chosen answer, not a missing one)', async () => {
    const { onChange } = setup({ value: { partner: true } });
    await userEvent.click(within(group(EN.partner)).getByText('No'));
    expect(onChange.mock.calls[0]?.[0]).toEqual({ partner: false });
  });

  test('partner Yes reports true', async () => {
    const { onChange } = setup({ value: { partner: false } });
    await userEvent.click(within(group(EN.partner)).getByText('Yes'));
    expect(onChange.mock.calls[0]?.[0]).toEqual({ partner: true });
  });

  test('a controlled component does not select by itself: it shows what the value prop says', async () => {
    const view = setup({ value: {} });
    await userEvent.click(within(group(EN.equipment)).getByText('Cones'));
    expect(radiosIn(EN.equipment).some((radio) => radio.checked)).toBe(false);
    view.rerender({ value: { equipment: 'cones' } });
    expect(radiosIn(EN.equipment).filter((radio) => radio.checked).map((radio) => radio.labels?.[0]?.textContent?.trim())).toEqual(['Cones']);
  });
});

// --- the selected card is marked with more than colour --------------------------------------------

describe('the selected card carries an icon, not only a colour', () => {
  const marked = (name: string) =>
    radiosIn(name)
      .filter((radio) => radio.labels?.[0]?.querySelector('svg[data-slot="selected-mark"]') !== null)
      .map((radio) => radio.labels?.[0]?.textContent?.trim());
  const checked = (name: string) =>
    radiosIn(name)
      .filter((radio) => radio.checked)
      .map((radio) => radio.labels?.[0]?.textContent?.trim());

  test('exactly the chosen card of each group is checked and has the check mark; the rest have neither', () => {
    setup({ value: COMPLETE });
    expect(checked(EN.equipment)).toEqual(['Ball only']);
    expect(marked(EN.equipment)).toEqual(['Ball only']);
    expect(checked(EN.space)).toEqual(['Yard']);
    expect(marked(EN.space)).toEqual(['Yard']);
    expect(checked(EN.partner)).toEqual(['No']);
    expect(marked(EN.partner)).toEqual(['No']);
    expect(checked(EN.days)).toEqual(['3']);
    expect(marked(EN.days)).toEqual(['3']);
    expect(checked(EN.minutes)).toEqual(['20 min']);
    expect(marked(EN.minutes)).toEqual(['20 min']);
  });

  test('with nothing chosen no card is checked or marked', () => {
    setup({ value: {} });
    for (const name of Object.values(EN)) {
      expect(checked(name)).toEqual([]);
      expect(marked(name)).toEqual([]);
    }
  });

  test('the mark is decorative for assistive tech: the checked state is what is announced', () => {
    setup({ value: COMPLETE });
    const mark = document.querySelector('svg[data-slot="selected-mark"]');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });

  test('the mark and the checked state move with the value', () => {
    const view = setup({ value: { equipment: 'ball' } });
    view.rerender({ value: { equipment: 'full_field' } });
    expect(checked(EN.equipment)).toEqual(['Full field']);
    expect(marked(EN.equipment)).toEqual(['Full field']);
  });

  test('partner true checks Yes and partner false checks No (not inverted)', () => {
    const view = setup({ value: { partner: true } });
    expect(checked(EN.partner)).toEqual(['Yes']);
    view.rerender({ value: { partner: false } });
    expect(checked(EN.partner)).toEqual(['No']);
  });
});

// --- Continue is gated on a valid draft ------------------------------------------------------------

describe('Continue is disabled until every answer is chosen from the payload', () => {
  test('an empty draft disables Continue', () => {
    setup({ value: {} });
    expect(continueButton().disabled).toBe(true);
  });

  test('a complete draft enables Continue', () => {
    setup({ value: COMPLETE });
    expect(continueButton().disabled).toBe(false);
  });

  test.each(Object.keys(COMPLETE) as (keyof ConditionsValue)[])('a draft missing only %s keeps Continue disabled', (field) => {
    const partial: ConditionsValue = { ...COMPLETE };
    delete partial[field];
    setup({ value: partial });
    expect(continueButton().disabled).toBe(true);
  });

  test('partner false counts as answered (falsy is not missing)', () => {
    setup({ value: { ...COMPLETE, partner: false } });
    expect(continueButton().disabled).toBe(false);
  });

  test.each([
    ['equipment', { equipment: 'full_field' }, { equipment: ['ball', 'cones'] }],
    ['space', { space: 'gym' }, { spaces: ['yard', 'field'] }],
    ['daysPerWeek', { daysPerWeek: 6 }, { daysPerWeek: [2, 3, 4] }],
    ['minutesPerSession', { minutesPerSession: 45 }, { minutesPerSession: [10, 15, 20] }],
    ['partner', { partner: true }, { partner: [false] }],
  ] as [string, ConditionsValue, Partial<Options>][])('a %s the payload does not offer keeps Continue disabled', (_field, value, narrowed) => {
    setup({ value: { ...COMPLETE, ...value }, options: { ...CONTRACT_OPTIONS, ...narrowed } });
    expect(continueButton().disabled).toBe(true);
  });

  test('choosing the last missing answer (rerender with the new draft) enables Continue', () => {
    const view = setup({ value: { ...COMPLETE, minutesPerSession: undefined } });
    expect(continueButton().disabled).toBe(true);
    view.rerender({ value: COMPLETE });
    expect(continueButton().disabled).toBe(false);
  });

  test('a disabled Continue says why, in words, and the button points at that text', () => {
    setup({ value: {} });
    const button = continueButton();
    const hintId = button.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toBe(tree('en', 'incomplete'));
  });

  test('a valid draft shows no incomplete hint', () => {
    setup({ value: COMPLETE });
    expect(screen.queryByText(tree('en', 'incomplete'))).toBeNull();
  });

  test('clicking a disabled Continue does not call onContinue', async () => {
    const { onContinue } = setup({ value: {} });
    await userEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('clicking an enabled Continue calls onContinue once', async () => {
    const { onContinue } = setup({ value: COMPLETE });
    await userEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test('Back is always available and calls onBack, even from an empty draft', async () => {
    const { onBack, onContinue } = setup({ value: {} });
    const back = screen.getByRole<HTMLButtonElement>('button', { name: tree('en', 'back') });
    expect(back.disabled).toBe(false);
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

// --- locales -------------------------------------------------------------------------------------------

function flatten(node: unknown, prefix = ''): Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return { [prefix]: node };
  return Object.assign({}, ...Object.entries(node).map(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`)));
}

describe('messages: kk, ru and en', () => {
  test('all three locales carry exactly the same keys, every one a non-blank string', () => {
    const [kk, ru, en] = [flatten(messages.kk), flatten(messages.ru), flatten(messages.en)];
    expect(Object.keys(kk).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const locale of [kk, ru, en]) {
      for (const [key, text] of Object.entries(locale)) {
        expect(typeof text, key).toBe('string');
        expect((text as string).trim(), key).not.toBe('');
      }
    }
  });

  test('every contract equipment, space and partner answer has a label in every locale', () => {
    for (const locale of LOCALES) {
      for (const value of EQUIPMENT) expect(tree(locale, `equipment.options.${value}`).trim(), `${locale} ${value}`).not.toBe('');
      for (const value of SPACES) expect(tree(locale, `space.options.${value}`).trim(), `${locale} ${value}`).not.toBe('');
      expect(tree(locale, 'partner.options.true').trim()).not.toBe('');
      expect(tree(locale, 'partner.options.false').trim()).not.toBe('');
    }
  });

  test('the file default-exports { kk, ru, en } for the registry (namespace = conditions-step)', () => {
    expect(Object.keys(messages).sort()).toEqual(['en', 'kk', 'ru']);
  });
});

describe.each(LOCALES)('locale %s renders its own strings', (locale) => {
  test('heading, lead, legends, every option label and both buttons are this locale\'s text', () => {
    setup({ value: {} }, locale);
    expect(screen.getByRole('heading', { name: tree(locale, 'title') })).toBeTruthy();
    expect(screen.getByText(tree(locale, 'lead'))).toBeTruthy();

    const legends = ['equipment', 'space', 'partner', 'daysPerWeek', 'minutesPerSession'] as const;
    for (const key of legends) expect(group(tree(locale, `${key}.legend`))).toBeTruthy();

    expect(labelsIn(tree(locale, 'equipment.legend'))).toEqual(EQUIPMENT.map((value) => tree(locale, `equipment.options.${value}`)));
    expect(labelsIn(tree(locale, 'space.legend'))).toEqual(SPACES.map((value) => tree(locale, `space.options.${value}`)));
    expect(labelsIn(tree(locale, 'partner.legend'))).toEqual([tree(locale, 'partner.options.true'), tree(locale, 'partner.options.false')]);
    expect(labelsIn(tree(locale, 'daysPerWeek.legend'))).toEqual(['2', '3', '4', '5', '6']);
    expect(labelsIn(tree(locale, 'minutesPerSession.legend'))).toEqual(
      MINUTES_PER_SESSION.map((minutes) => tree(locale, 'minutesPerSession.value').replace('{{value}}', String(minutes))),
    );

    expect(continueButton(locale)).toBeTruthy();
    expect(screen.getByRole('button', { name: tree(locale, 'back') })).toBeTruthy();
  });

  test('the incomplete hint is this locale\'s text', () => {
    setup({ value: {} }, locale);
    expect(screen.getByText(tree(locale, 'incomplete'))).toBeTruthy();
  });

  test('no other locale\'s heading leaks in', () => {
    setup({ value: {} }, locale);
    for (const other of LOCALES.filter((candidate) => candidate !== locale)) {
      expect(screen.queryByText(tree(other, 'title'))).toBeNull();
    }
  });
});

describe('the three locales are genuinely different texts for the headline strings', () => {
  test.each(['title', 'lead', 'continue', 'back', 'incomplete', 'equipment.legend', 'space.legend'])('%s differs between kk, ru and en', (path) => {
    const texts = LOCALES.map((locale) => tree(locale, path));
    expect(new Set(texts).size).toBe(3);
  });
});

// --- labelled controls and keyboard --------------------------------------------------------------------

describe('labelled controls', () => {
  test('each of the five questions is a named group and every card is a radio with an accessible name', () => {
    setup({ value: {} });
    for (const name of Object.values(EN)) {
      const radios = radiosIn(name);
      expect(radios.length).toBeGreaterThan(0);
      for (const radio of radios) {
        expect(radio.type).toBe('radio');
        expect(screen.getByRole('radio', { name: radio.labels?.[0]?.textContent?.trim() ?? '', hidden: false })).toBeTruthy();
        expect((radio.labels?.[0]?.textContent ?? '').trim()).not.toBe('');
      }
    }
  });

  test('the cards of one question share a radio name and different questions do not collide', () => {
    setup({ value: {} });
    const names = Object.values(EN).map((legend) => new Set(radiosIn(legend).map((radio) => radio.name)));
    for (const set of names) {
      expect(set.size).toBe(1);
      expect([...set][0]).not.toBe('');
    }
    expect(new Set(names.map((set) => [...set][0])).size).toBe(5);
  });

  test('the step has a heading naming it and Continue and Back are real buttons', () => {
    setup({ value: {} });
    expect(screen.getByRole('heading', { name: tree('en', 'title') }).tagName).toMatch(/^H[1-6]$/);
    expect(continueButton().tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: tree('en', 'back') }).tagName).toBe('BUTTON');
  });
});

describe('keyboard operability', () => {
  test('Tab reaches the equipment group first and Space picks the focused card', async () => {
    const { onChange } = setup({ value: {} });
    await userEvent.tab();
    const first = radiosIn(EN.equipment)[0] as HTMLInputElement;
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual({ equipment: 'nothing' });
  });

  test('arrow keys move the choice inside a group and report the payload value', async () => {
    const { onChange } = setup({ value: { space: 'yard' } });
    (radiosIn(EN.space).find((radio) => radio.checked) as HTMLInputElement).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual({ space: 'field' });
  });

  test('the whole step is reachable by Tab: one stop per question, then Back and Continue', async () => {
    setup({ value: COMPLETE });
    const stops: (Element | null)[] = [];
    for (let i = 0; i < 7; i += 1) {
      await userEvent.tab();
      stops.push(document.activeElement);
    }
    const focusedRadios = stops.filter((el) => el instanceof HTMLInputElement && el.type === 'radio') as HTMLInputElement[];
    expect(focusedRadios).toHaveLength(5);
    expect(focusedRadios.every((radio) => radio.checked)).toBe(true);
    expect(stops.slice(5).map((el) => el?.textContent?.trim())).toEqual([tree('en', 'back'), tree('en', 'continue')]);
  });

  test('Enter on Continue calls onContinue when valid', async () => {
    const { onContinue } = setup({ value: COMPLETE });
    continueButton().focus();
    await userEvent.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test('Enter on a card of a complete draft submits the step (native form behaviour)', async () => {
    const { onContinue } = setup({ value: COMPLETE });
    (radiosIn(EN.equipment).find((radio) => radio.checked) as HTMLInputElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test('Enter on a card of an incomplete draft does not submit', async () => {
    const { onContinue } = setup({ value: {} });
    radiosIn(EN.equipment)[0]?.focus();
    await userEvent.keyboard('{Enter}');
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('console stays quiet while rendering (no React warnings)', () => {
    const error = spyOn(console, 'error');
    setup({ value: COMPLETE });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
