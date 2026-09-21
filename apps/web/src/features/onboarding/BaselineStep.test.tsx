import { describe, expect, mock, test } from 'bun:test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { Equipment, Locale } from '@api-types/primitives';
import type { SkillTest } from '@api-types/domain';
import { EQUIPMENT_OWNED as API_EQUIPMENT_OWNED } from '../../../../api/src/planner/candidates';
import { createI18n, LOCALES } from '../../lib/i18n';
import messagesModule from './baseline-step.messages';
import { BaselineStep, EQUIPMENT_OWNED, type BaselineDraftResult, type BaselineFinalResult } from './BaselineStep';

/*
 * Written from the bead's acceptance criteria and the parent brief, not from the implementation:
 *  - the tests come from props (no hard-coded list), each with its localized protocol shown BEFORE a
 *    numeric input that carries the unit;
 *  - slalom-like tests (a "lower is better" time) also take an optional errors counter (the estimator
 *    only reads errors on those);
 *  - "Skip" is a toggle whose payload is `{ value: 0, skipped: true }` (contract: value is required);
 *    entering a value un-skips;
 *  - equipment the player lacks pre-skips a test, with the reason;
 *  - non-negative finite numbers only; decimals only where time is measured; Continue waits for
 *    every test to have a value or be skipped.
 */

// --- fixtures -----------------------------------------------------------------------------------

/** Three-locale protocol with a warm-up rule and a stop rule, tagged so tests can tell tests apart. */
function protocol(tag: string) {
  return {
    kk: `1. ${tag}: тегіс әрі құрғақ жер тап.\n2. ${tag}: алдымен жылын.\n3. ${tag}: аяғың ауырса, тоқта.`,
    ru: `1. ${tag}: найди ровное сухое место.\n2. ${tag}: сначала разомнись.\n3. ${tag}: если заболела нога, остановись.`,
    en: `1. ${tag}: find a flat, dry place.\n2. ${tag}: warm up first.\n3. ${tag}: stop if your leg hurts.`,
  };
}

function skillTest(fields: Pick<SkillTest, 'slug' | 'metric' | 'unit' | 'direction' | 'equipment'>): SkillTest {
  return { ...fields, skill: `${fields.slug}-skill`, protocol: protocol(fields.slug) };
}

const juggling = skillTest({ slug: 'juggling-max-touches', metric: 'maximum consecutive touches', unit: 'touches', direction: 'higher', equipment: 'ball' });
const wall = skillTest({ slug: 'wall-passing-60s', metric: 'successful passes in 60 s', unit: 'passes', direction: 'higher', equipment: 'ball_wall' });
const mastery = skillTest({ slug: 'ball-mastery-30s', metric: 'touches in 30 s', unit: 'touches', direction: 'higher', equipment: 'ball' });
const slalom = skillTest({ slug: 'slalom-time', metric: 'completion time', unit: 's', direction: 'lower', equipment: 'cones' });
const weakFoot = skillTest({ slug: 'weak-foot-passes', metric: 'successful passes out of 10 attempts', unit: 'passes', direction: 'higher', equipment: 'ball_wall' });
const SEEDED: SkillTest[] = [juggling, wall, mastery, slalom, weakFoot];

// Tests no seed file has ever heard of: the component must render whatever the props say.
const sprint = skillTest({ slug: 'sprint-20m', metric: 'sprint over 20 m', unit: 'seconds', direction: 'lower', equipment: 'nothing' });
const plank = skillTest({ slug: 'plank-hold', metric: 'plank hold', unit: 'reps', direction: 'higher', equipment: 'nothing' });

const SKIP_LABEL: Record<Locale, string> = {
  kk: 'Өткізіп жіберу — қазір жасай алмаймын',
  ru: 'Пропустить — сейчас не могу',
  en: "Skip — I can't do this now",
};

// --- harness ------------------------------------------------------------------------------------

type RenderOptions = {
  tests?: readonly SkillTest[];
  equipment?: Equipment;
  results?: BaselineDraftResult[];
  locale?: Locale;
};

function renderStep(options: RenderOptions = {}) {
  const { tests = SEEDED, equipment = 'full_field', results = [], locale = 'en' } = options;
  const onChange = mock((_results: BaselineDraftResult[]) => {});
  const onContinue = mock((_results: BaselineFinalResult[]) => {});
  const onBack = mock(() => {});
  const i18n = createI18n({
    modules: { '../features/onboarding/baseline-step.messages.ts': { default: messagesModule } },
    storage: { getItem: () => null, setItem: () => {} },
    languages: [locale],
    root: { lang: '' },
    dev: false,
  });

  // The parent owns the draft: mirror that so typing and toggling behave as in the wizard.
  function Harness() {
    const [draft, setDraft] = useState<BaselineDraftResult[]>(results);
    return (
      <BaselineStep
        tests={tests}
        equipment={equipment}
        results={draft}
        onChange={(next) => {
          onChange(next);
          setDraft(next);
        }}
        onContinue={onContinue}
        onBack={onBack}
      />
    );
  }

  render(
    <I18nextProvider i18n={i18n}>
      <Harness />
    </I18nextProvider>,
  );
  return { user: userEvent.setup(), onChange, onContinue, onBack };
}

const regionOf = (test: SkillTest) => screen.getByRole('region', { name: test.metric });
const valueInput = (test: SkillTest) => within(regionOf(test)).getByLabelText<HTMLInputElement>(/^(your result|нәтижең|твой результат)/i);
const skipButton = (test: SkillTest, locale: Locale = 'en') => within(regionOf(test)).getByRole<HTMLButtonElement>('button', { name: SKIP_LABEL[locale] });
const continueButton = (name = 'Continue') => screen.getByRole<HTMLButtonElement>('button', { name });

function lastChange(spy: ReturnType<typeof renderStep>['onChange']): BaselineDraftResult[] {
  const call = spy.mock.calls.at(-1);
  if (call === undefined) throw new Error('onChange was never called');
  return call[0];
}
const entryFor = (results: BaselineDraftResult[], test: SkillTest) => results.find((entry) => entry.testSlug === test.slug);

// --- tests come from props ----------------------------------------------------------------------

describe('tests come from props', () => {
  test('renders one labelled region per test it is given, in the given order', () => {
    renderStep({ tests: [sprint, plank] });
    const regions = screen.getAllByRole('region');
    expect(regions).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'sprint over 20 m' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'plank hold' })).toBeTruthy();
    expect(regions[0]).toBe(screen.getByRole('region', { name: 'sprint over 20 m' }));
    expect(regions[1]).toBe(screen.getByRole('region', { name: 'plank hold' }));
  });

  test('a different list renders a different set: nothing is hard-coded to the seeded five', () => {
    renderStep({ tests: [plank] });
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: juggling.metric })).toBeNull();
    expect(screen.queryByRole('region', { name: slalom.metric })).toBeNull();
    expect(screen.queryByText(/juggling-max-touches/)).toBeNull();
  });

  test('a test nobody has heard of gets the full treatment (protocol, input, skip)', () => {
    renderStep({ tests: [plank] });
    const region = regionOf(plank);
    expect(within(region).getAllByRole('listitem')).toHaveLength(3);
    expect(valueInput(plank)).toBeTruthy();
    expect(skipButton(plank)).toBeTruthy();
  });

  test('with no tests there is a plain note and Continue is available', async () => {
    const { user, onContinue } = renderStep({ tests: [] });
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(screen.getByText(/no skill tests/i)).toBeTruthy();
    expect(continueButton().disabled).toBe(false);
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([]);
  });

  test('shows how many tests are done as a number, not a colour', async () => {
    const { user } = renderStep({ tests: [sprint, plank] });
    expect(screen.getByText('Done: 0 of 2')).toBeTruthy();
    await user.type(valueInput(sprint), '4.2');
    expect(screen.getByText('Done: 1 of 2')).toBeTruthy();
    await user.click(skipButton(plank));
    expect(screen.getByText('Done: 2 of 2')).toBeTruthy();
  });
});

// --- protocol -----------------------------------------------------------------------------------

describe('protocol', () => {
  test('is shown as numbered steps, one list item per line, with the text as given', () => {
    renderStep({ tests: [juggling] });
    const region = regionOf(juggling);
    const steps = within(region).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'juggling-max-touches: find a flat, dry place.',
      'juggling-max-touches: warm up first.',
      'juggling-max-touches: stop if your leg hurts.',
    ]);
    expect(within(region).getByRole('list').tagName).toBe('OL');
  });

  test('keeps the safety text (warm-up and stop rules) visible', () => {
    renderStep({ tests: [wall] });
    expect(screen.getByText(/warm up first/i)).toBeTruthy();
    expect(screen.getByText(/stop if your leg hurts/i)).toBeTruthy();
  });

  test('comes BEFORE the input in reading and tab order', () => {
    renderStep({ tests: [slalom] });
    const region = regionOf(slalom);
    const lastStep = within(region).getAllByRole('listitem').at(-1)!;
    const input = valueInput(slalom);
    expect(lastStep.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('has a "how to measure" heading', () => {
    renderStep({ tests: [juggling] });
    expect(within(regionOf(juggling)).getByText('How to measure')).toBeTruthy();
  });

  test('is picked for the current language', () => {
    renderStep({ tests: [juggling], locale: 'kk' });
    expect(within(regionOf(juggling)).getByText('juggling-max-touches: алдымен жылын.')).toBeTruthy();
  });

  test('falls back to another language when the current one has no text', () => {
    const onlyRussian: SkillTest = { ...juggling, protocol: { ru: '1. Сначала разомнись.\n2. Считай касания.' } };
    renderStep({ tests: [onlyRussian], locale: 'kk' });
    const steps = within(regionOf(onlyRussian)).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual(['Сначала разомнись.', 'Считай касания.']);
  });
});

// --- the numeric input --------------------------------------------------------------------------

describe('result input', () => {
  test('is a labelled control that names the unit', () => {
    renderStep({ tests: [juggling, slalom] });
    expect(valueInput(juggling).id).not.toBe('');
    expect(within(regionOf(juggling)).getByText(/your result.*touches/i).tagName).toBe('LABEL');
    expect(within(regionOf(slalom)).getByText(/your result.*\bs\b/i).tagName).toBe('LABEL');
  });

  test('is a number-only text field for phones (numeric keypad), not free text', () => {
    renderStep({ tests: [juggling, slalom] });
    expect(valueInput(juggling).getAttribute('inputmode')).toBe('numeric');
    expect(valueInput(slalom).getAttribute('inputmode')).toBe('decimal');
  });

  test('shows a value that is already in the draft', () => {
    renderStep({ tests: [juggling], results: [{ testSlug: juggling.slug, value: 12, skipped: false }] });
    expect(valueInput(juggling).value).toBe('12');
  });

  test('typing emits the typed number for that test', async () => {
    const { user, onChange } = renderStep({ tests: [juggling, wall] });
    await user.type(valueInput(juggling), '12');
    expect(entryFor(lastChange(onChange), juggling)).toEqual({ testSlug: juggling.slug, value: 12, skipped: false });
    expect(entryFor(lastChange(onChange), wall)).toBeUndefined();
  });

  test('zero is a valid result', async () => {
    const { user, onChange } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '0');
    expect(entryFor(lastChange(onChange), juggling)).toEqual({ testSlug: juggling.slug, value: 0, skipped: false });
    expect(within(regionOf(juggling)).queryByRole('alert')).toBeNull();
  });
});

// --- errors counter -----------------------------------------------------------------------------

describe('errors counter (only where the contract allows it)', () => {
  test('appears for a time test (lower is better) and for no other', () => {
    renderStep({ tests: SEEDED });
    expect(within(regionOf(slalom)).getByLabelText(/^errors/i)).toBeTruthy();
    for (const other of [juggling, wall, mastery, weakFoot]) {
      expect(within(regionOf(other)).queryByLabelText(/errors/i)).toBeNull();
    }
  });

  test('is decided by the test data, not by its slug', () => {
    renderStep({ tests: [sprint, plank] });
    expect(within(regionOf(sprint)).getByLabelText(/^errors/i)).toBeTruthy();
    expect(within(regionOf(plank)).queryByLabelText(/errors/i)).toBeNull();
  });

  test('is optional: a time alone is enough, and errors are left out of the payload', async () => {
    const { user, onChange, onContinue } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), '14.5');
    expect(entryFor(lastChange(onChange), slalom)).toEqual({ testSlug: slalom.slug, value: 14.5, skipped: false });
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([{ testSlug: slalom.slug, value: 14.5, skipped: false }]);
  });

  test('is sent with the time when filled in', async () => {
    const { user, onChange, onContinue } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), '14.5');
    await user.type(within(regionOf(slalom)).getByLabelText(/^errors/i), '2');
    expect(entryFor(lastChange(onChange), slalom)).toEqual({ testSlug: slalom.slug, value: 14.5, errors: 2, skipped: false });
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([{ testSlug: slalom.slug, value: 14.5, errors: 2, skipped: false }]);
  });

  test('takes whole, non-negative numbers only, and a bad one blocks Continue', async () => {
    const { user } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), '14.5');
    const errors = within(regionOf(slalom)).getByLabelText<HTMLInputElement>(/^errors/i);
    for (const bad of ['-1', '1.5', 'two']) {
      await user.clear(errors);
      await user.type(errors, bad);
      expect(errors.getAttribute('aria-invalid')).toBe('true');
      expect(within(regionOf(slalom)).getByRole('alert').textContent).not.toBe('');
      expect(continueButton().disabled).toBe(true);
    }
    await user.clear(errors);
    await user.type(errors, '0');
    expect(errors.getAttribute('aria-invalid')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });
});

// --- skipping -----------------------------------------------------------------------------------

describe('skip', () => {
  test('has the wording "Skip — I can\'t do this now" and is a real button', () => {
    renderStep({ tests: [juggling] });
    expect(skipButton(juggling).tagName).toBe('BUTTON');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('false');
  });

  test('toggles the payload: skipped carries value 0 and skipped: true, and no errors', async () => {
    const { user, onChange } = renderStep({ tests: [juggling, slalom] });
    await user.click(skipButton(slalom));
    expect(entryFor(lastChange(onChange), slalom)).toEqual({ testSlug: slalom.slug, value: 0, skipped: true });
    expect(skipButton(slalom).getAttribute('aria-pressed')).toBe('true');
    expect(entryFor(lastChange(onChange), juggling)).toBeUndefined();
  });

  test('says in words that a skipped test falls back to the level the player chose', async () => {
    const { user } = renderStep({ tests: [juggling] });
    expect(within(regionOf(juggling)).queryByText(/level you chose/i)).toBeNull();
    await user.click(skipButton(juggling));
    expect(within(regionOf(juggling)).getByText(/level you chose/i)).toBeTruthy();
    expect(within(regionOf(juggling)).getByText(/^skipped/i)).toBeTruthy();
  });

  test('pressing it again un-skips: the test is pending again', async () => {
    const { user, onChange } = renderStep({ tests: [juggling] });
    await user.click(skipButton(juggling));
    await user.click(skipButton(juggling));
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('false');
    expect(entryFor(lastChange(onChange), juggling)?.skipped).toBe(false);
    expect(within(regionOf(juggling)).queryByText(/level you chose/i)).toBeNull();
    expect(continueButton().disabled).toBe(true);
  });

  test('entering a value on a skipped test un-skips it', async () => {
    const { user, onChange } = renderStep({ tests: [juggling] });
    await user.click(skipButton(juggling));
    await user.type(valueInput(juggling), '9');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('false');
    expect(entryFor(lastChange(onChange), juggling)).toEqual({ testSlug: juggling.slug, value: 9, skipped: false });
  });

  test('skipping clears a value typed earlier, so nothing measured is sent as skipped', async () => {
    const { user, onChange } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '9');
    await user.click(skipButton(juggling));
    expect(valueInput(juggling).value).toBe('');
    expect(entryFor(lastChange(onChange), juggling)).toEqual({ testSlug: juggling.slug, value: 0, skipped: true });
  });

  test('a skipped result already in the draft is shown as skipped', () => {
    renderStep({ tests: [juggling], results: [{ testSlug: juggling.slug, value: 0, skipped: true }] });
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('true');
    expect(within(regionOf(juggling)).getByText(/^skipped/i)).toBeTruthy();
  });

  test('a skipped test counts as done: skipping every test enables Continue with all-skipped results', async () => {
    const { user, onContinue } = renderStep({ tests: [juggling, slalom] });
    expect(continueButton().disabled).toBe(true);
    await user.click(skipButton(juggling));
    expect(continueButton().disabled).toBe(true);
    await user.click(skipButton(slalom));
    expect(continueButton().disabled).toBe(false);
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([
      { testSlug: juggling.slug, value: 0, skipped: true },
      { testSlug: slalom.slug, value: 0, skipped: true },
    ]);
  });
});

// --- equipment pre-skip -------------------------------------------------------------------------

describe('equipment the player lacks', () => {
  test("'Ball only' pre-skips wall passing and slalom, and only those", () => {
    renderStep({ tests: SEEDED, equipment: 'ball' });
    expect(skipButton(wall).getAttribute('aria-pressed')).toBe('true');
    expect(skipButton(slalom).getAttribute('aria-pressed')).toBe('true');
    expect(skipButton(weakFoot).getAttribute('aria-pressed')).toBe('true');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('false');
    expect(skipButton(mastery).getAttribute('aria-pressed')).toBe('false');
  });

  test('gives the reason in words, naming what is missing', () => {
    renderStep({ tests: SEEDED, equipment: 'ball' });
    expect(within(regionOf(wall)).getByText(/needs a ball and a wall/i)).toBeTruthy();
    expect(within(regionOf(slalom)).getByText(/needs cones/i)).toBeTruthy();
    expect(within(regionOf(juggling)).queryByText(/needs/i)).toBeNull();
  });

  test('pre-skipped tests are in the payload without the player touching them', async () => {
    const { user, onChange, onContinue } = renderStep({ tests: [juggling, wall, slalom], equipment: 'ball' });
    await user.type(valueInput(juggling), '7');
    expect(lastChange(onChange)).toEqual([
      { testSlug: juggling.slug, value: 7, skipped: false },
      { testSlug: wall.slug, value: 0, skipped: true },
      { testSlug: slalom.slug, value: 0, skipped: true },
    ]);
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([
      { testSlug: juggling.slug, value: 7, skipped: false },
      { testSlug: wall.slug, value: 0, skipped: true },
      { testSlug: slalom.slug, value: 0, skipped: true },
    ]);
  });

  test('Continue only waits for the tests the player can do', async () => {
    const { user } = renderStep({ tests: [juggling, wall], equipment: 'ball' });
    expect(continueButton().disabled).toBe(true);
    await user.type(valueInput(juggling), '7');
    expect(continueButton().disabled).toBe(false);
  });

  test('the player can still do a pre-skipped test: entering a value un-skips it', async () => {
    const { user, onChange } = renderStep({ tests: [wall], equipment: 'ball' });
    await user.type(valueInput(wall), '21');
    expect(skipButton(wall).getAttribute('aria-pressed')).toBe('false');
    expect(within(regionOf(wall)).queryByText(/needs/i)).toBeNull();
    expect(entryFor(lastChange(onChange), wall)).toEqual({ testSlug: wall.slug, value: 21, skipped: false });
  });

  test('pressing skip on a pre-skipped test un-skips it (pending until a value is entered)', async () => {
    const { user, onChange } = renderStep({ tests: [wall], equipment: 'ball' });
    await user.click(skipButton(wall));
    expect(skipButton(wall).getAttribute('aria-pressed')).toBe('false');
    expect(entryFor(lastChange(onChange), wall)?.skipped).toBe(false);
    expect(continueButton().disabled).toBe(true);
  });

  test("a result the player already gave is not overridden by the pre-skip", () => {
    renderStep({ tests: [wall], equipment: 'ball', results: [{ testSlug: wall.slug, value: 30, skipped: false }] });
    expect(valueInput(wall).value).toBe('30');
    expect(skipButton(wall).getAttribute('aria-pressed')).toBe('false');
  });

  // What each preset lets a player do, written out independently of the implementation.
  const expectedSkipped: Record<Equipment, string[]> = {
    nothing: [juggling, wall, mastery, slalom, weakFoot].map((test) => test.slug),
    ball: [wall, slalom, weakFoot].map((test) => test.slug),
    ball_wall: [slalom].map((test) => test.slug),
    cones: [wall, weakFoot].map((test) => test.slug),
    full_field: [],
  };
  test.each(Object.keys(expectedSkipped) as Equipment[])('preset %s pre-skips exactly the tests it cannot do', (equipment) => {
    renderStep({ tests: SEEDED, equipment });
    const skipped = SEEDED.filter((test) => skipButton(test).getAttribute('aria-pressed') === 'true').map((test) => test.slug);
    expect(skipped).toEqual(SEEDED.map((test) => test.slug).filter((slug) => expectedSkipped[equipment].includes(slug)));
  });

  test('the ownership table matches the planner, which decides which drills the same preset unlocks', () => {
    expect(EQUIPMENT_OWNED).toEqual(API_EQUIPMENT_OWNED);
  });
});

// --- validation ---------------------------------------------------------------------------------

describe('validation', () => {
  test('a negative value is rejected with a message and never emitted', async () => {
    const { user, onChange } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '-3');
    const region = regionOf(juggling);
    expect(within(region).getByRole('alert').textContent).toMatch(/below 0/i);
    expect(valueInput(juggling).getAttribute('aria-invalid')).toBe('true');
    expect(onChange.mock.calls.flatMap((call) => call[0]).some((entry) => entry.value !== null && entry.value < 0)).toBe(false);
    expect(entryFor(lastChange(onChange), juggling)?.value ?? null).toBeNull();
  });

  test('an invalid value blocks Continue and says why in words next to the button', async () => {
    const { user, onContinue } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '-3');
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText(/fix the results/i)).toBeTruthy();
    await user.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('the message goes away when the value is corrected', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '-3');
    await user.clear(valueInput(juggling));
    await user.type(valueInput(juggling), '3');
    expect(within(regionOf(juggling)).queryByRole('alert')).toBeNull();
    expect(valueInput(juggling).getAttribute('aria-invalid')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  test.each(['abc', '1e3', '12 touches', '--3', '1..5', '.', '∞'])('%p is not a number', async (typed) => {
    const { user } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), typed);
    expect(within(regionOf(slalom)).getByRole('alert').textContent).toMatch(/enter a number/i);
    expect(continueButton().disabled).toBe(true);
  });

  test('a number too large to be finite is rejected', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '9'.repeat(400));
    expect(within(regionOf(juggling)).getByRole('alert').textContent).toMatch(/too big/i);
    expect(continueButton().disabled).toBe(true);
  });

  test('a time accepts decimals, with a point or a comma', async () => {
    const { user, onChange } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), '12.5');
    expect(entryFor(lastChange(onChange), slalom)?.value).toBe(12.5);
    await user.clear(valueInput(slalom));
    await user.type(valueInput(slalom), '9,25');
    expect(entryFor(lastChange(onChange), slalom)?.value).toBe(9.25);
    expect(within(regionOf(slalom)).queryByRole('alert')).toBeNull();
  });

  test('a count needs a whole number', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '3.5');
    expect(within(regionOf(juggling)).getByRole('alert').textContent).toMatch(/whole number/i);
    expect(continueButton().disabled).toBe(true);
  });

  test('a negative time is rejected too', async () => {
    const { user } = renderStep({ tests: [slalom] });
    await user.type(valueInput(slalom), '-0.5');
    expect(within(regionOf(slalom)).getByRole('alert').textContent).toMatch(/below 0/i);
  });

  test('an empty box is not an error, it is just not done yet', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.click(valueInput(juggling));
    expect(within(regionOf(juggling)).queryByRole('alert')).toBeNull();
    expect(screen.getByText(/enter a result or skip/i)).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
  });

  test('the error is only about the test it belongs to', async () => {
    const { user } = renderStep({ tests: [juggling, wall] });
    await user.type(valueInput(juggling), '-1');
    expect(within(regionOf(juggling)).getByRole('alert')).toBeTruthy();
    expect(within(regionOf(wall)).queryByRole('alert')).toBeNull();
  });
});

// --- continue and back --------------------------------------------------------------------------

describe('continue and back', () => {
  test('Continue is disabled until every test has a value or is skipped', async () => {
    const { user } = renderStep({ tests: [juggling, wall, slalom] });
    expect(continueButton().disabled).toBe(true);
    await user.type(valueInput(juggling), '5');
    expect(continueButton().disabled).toBe(true);
    await user.click(skipButton(wall));
    expect(continueButton().disabled).toBe(true);
    await user.type(valueInput(slalom), '15.2');
    expect(continueButton().disabled).toBe(false);
  });

  test('Continue sends one result per test, in the order of the tests, with measured values as typed', async () => {
    const { user, onContinue } = renderStep({ tests: [slalom, juggling, wall] });
    await user.type(valueInput(juggling), '12');
    await user.click(skipButton(wall));
    await user.type(valueInput(slalom), '15.2');
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith([
      { testSlug: slalom.slug, value: 15.2, skipped: false },
      { testSlug: juggling.slug, value: 12, skipped: false },
      { testSlug: wall.slug, value: 0, skipped: true },
    ]);
  });

  test('a zero result is a result, not a skip', async () => {
    const { user, onContinue } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '0');
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([{ testSlug: juggling.slug, value: 0, skipped: false }]);
  });

  test('a result already in the draft is enough to continue', async () => {
    const { user, onContinue } = renderStep({
      tests: [juggling, wall],
      results: [
        { testSlug: juggling.slug, value: 12, skipped: false },
        { testSlug: wall.slug, value: 0, skipped: true },
      ],
    });
    expect(continueButton().disabled).toBe(false);
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([
      { testSlug: juggling.slug, value: 12, skipped: false },
      { testSlug: wall.slug, value: 0, skipped: true },
    ]);
  });

  test('Back is always available and does not need the tests to be done', async () => {
    const { user, onBack, onContinue } = renderStep({ tests: [juggling] });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

// --- privacy note -------------------------------------------------------------------------------

describe('privacy note', () => {
  test('says in plain words that results are private', () => {
    renderStep({ tests: [juggling] });
    expect(screen.getByText(/your results are private/i)).toBeTruthy();
  });
});

// --- languages ----------------------------------------------------------------------------------

describe('languages', () => {
  const EXPECT: Record<Locale, { skip: string; back: string; cont: string; privacy: RegExp; progress: string; howTo: string }> = {
    kk: { skip: SKIP_LABEL.kk, back: 'Артқа', cont: 'Жалғастыру', privacy: /нәтижелерің жеке/i, progress: 'Дайын: 0 / 1', howTo: 'Қалай өлшеу керек' },
    ru: { skip: SKIP_LABEL.ru, back: 'Назад', cont: 'Продолжить', privacy: /результаты личные/i, progress: 'Готово: 0 из 1', howTo: 'Как измерить' },
    en: { skip: SKIP_LABEL.en, back: 'Back', cont: 'Continue', privacy: /your results are private/i, progress: 'Done: 0 of 1', howTo: 'How to measure' },
  };

  test.each([...LOCALES])('%s: every visible string is in that language', (locale) => {
    renderStep({ tests: [juggling], locale });
    const expected = EXPECT[locale];
    expect(skipButton(juggling, locale)).toBeTruthy();
    expect(screen.getByRole('button', { name: expected.back })).toBeTruthy();
    expect(continueButton(expected.cont).disabled).toBe(true);
    expect(screen.getByText(expected.privacy)).toBeTruthy();
    expect(screen.getByText(expected.progress)).toBeTruthy();
    expect(within(regionOf(juggling)).getByText(expected.howTo)).toBeTruthy();
  });

  test.each([...LOCALES])('%s: the interface text never leaks a raw key or another language', (locale) => {
    renderStep({ tests: [slalom], equipment: 'ball', locale });
    const region = regionOf(slalom);
    // The metric and the unit come from the data (English seed text); the rest is the interface.
    expect(region.textContent).not.toMatch(/undefined|howToMeasure|equipmentNeeds|invalid\./);
    const text = region.textContent ?? '';
    const others = LOCALES.filter((other) => other !== locale);
    for (const other of others) expect(text).not.toContain(SKIP_LABEL[other]);
  });

  const NEGATIVE: Record<Locale, string> = {
    kk: 'Нәтиже 0-ден кем болмауы керек.',
    ru: 'Результат не может быть меньше 0.',
    en: 'The result cannot be below 0.',
  };
  test.each([...LOCALES])('%s: the validation and equipment messages are translated', async (locale) => {
    const { user } = renderStep({ tests: [wall, juggling], equipment: 'ball', locale });
    expect(within(regionOf(wall)).getByText(/^(Skipped|Өткізілді|Пропущено)/)).toBeTruthy();
    await user.type(valueInput(juggling), '-1');
    expect(within(regionOf(juggling)).getByRole('alert').textContent).toBe(NEGATIVE[locale]);
  });

  test('the messages file has the same non-blank keys in kk, ru and en', () => {
    const leaves = (tree: unknown, prefix = ''): string[] =>
      Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        typeof value === 'string' ? (value.trim() === '' ? [] : [`${prefix}${key}`]) : leaves(value, `${prefix}${key}.`),
      );
    const kk = leaves(messagesModule.kk).sort();
    expect(kk.length).toBeGreaterThan(15);
    expect(leaves(messagesModule.ru).sort()).toEqual(kk);
    expect(leaves(messagesModule.en).sort()).toEqual(kk);
  });

  test('the messages file names a reason for every equipment preset', () => {
    for (const locale of LOCALES) {
      const needs = (messagesModule[locale] as { equipmentNeeds: Record<string, string> }).equipmentNeeds;
      for (const preset of Object.keys(API_EQUIPMENT_OWNED)) expect(needs[preset]?.trim()).toBeTruthy();
    }
  });
});

// --- accessibility and keyboard -----------------------------------------------------------------

describe('accessibility and keyboard', () => {
  test('every input has a visible label and the skip button describes which test it belongs to', () => {
    renderStep({ tests: SEEDED });
    for (const test of SEEDED) {
      const region = regionOf(test);
      for (const input of within(region).getAllByRole('textbox')) {
        const labelled = input.labels?.[0];
        expect(labelled?.textContent?.trim()).toBeTruthy();
        expect(labelled?.classList.contains('sr-only')).toBe(false);
      }
      expect(skipButton(test).getAttribute('aria-describedby')).toBeTruthy();
      expect(document.getElementById(skipButton(test).getAttribute('aria-describedby')!)?.textContent).toBe(test.metric);
    }
  });

  test('an invalid input is described by its own message', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.type(valueInput(juggling), '-3');
    const alert = within(regionOf(juggling)).getByRole('alert');
    expect(valueInput(juggling).getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });

  test('tab order follows the reading order: input, errors, skip, then the next test, then Back, Continue', async () => {
    const { user } = renderStep({ tests: [slalom, juggling] });
    const order: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement;
      order.push(active.tagName === 'BUTTON' ? `button:${active.textContent?.trim()}` : (active.labels?.[0]?.textContent?.trim() ?? active.tagName));
    }
    expect(order).toEqual([
      'Your result, s',
      'Errors',
      `button:${SKIP_LABEL.en}`,
      'Your result, touches',
      `button:${SKIP_LABEL.en}`,
      'button:Back',
    ]);
    // Continue is disabled, so Tab does not stop on it.
    expect(continueButton().disabled).toBe(true);
  });

  test('skip works from the keyboard with Enter and with Space', async () => {
    const { user } = renderStep({ tests: [juggling] });
    skipButton(juggling).focus();
    await user.keyboard('{Enter}');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('true');
    await user.keyboard(' ');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('false');
  });

  test('the whole step can be completed from the keyboard', async () => {
    const { user, onContinue } = renderStep({ tests: [juggling, wall] });
    await user.tab();
    await user.keyboard('11');
    await user.tab(); // the skip button of the first test
    await user.tab(); // the second test's input
    await user.tab(); // its skip button
    await user.keyboard('{Enter}');
    await user.tab(); // Back
    await user.tab(); // Continue, now enabled
    expect(document.activeElement).toBe(continueButton());
    await user.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledWith([
      { testSlug: juggling.slug, value: 11, skipped: false },
      { testSlug: wall.slug, value: 0, skipped: true },
    ]);
  });

  test('touch targets: the buttons and inputs carry the 44px minimum', () => {
    renderStep({ tests: [slalom] });
    for (const element of [valueInput(slalom), skipButton(slalom), continueButton(), screen.getByRole('button', { name: 'Back' })]) {
      expect(element.classList.contains('min-h-tap')).toBe(true);
    }
  });

  test('state is never colour alone: a skipped test shows a written status, and the toggle is exposed as pressed', async () => {
    const { user } = renderStep({ tests: [juggling] });
    await user.click(skipButton(juggling));
    const status = within(regionOf(juggling)).getByText(/^skipped/i);
    expect(status.textContent).not.toBe('');
    expect(skipButton(juggling).getAttribute('aria-pressed')).toBe('true');
  });
});
