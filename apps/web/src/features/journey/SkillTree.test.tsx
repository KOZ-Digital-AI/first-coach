import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NODE_STATES, TreeTrack as TreeTrackSchema, type TreeTrack } from '@api-types/journey';
import { I18nextProvider } from 'react-i18next';
import { createI18n, LOCALES, namespaceOf } from '../../lib/i18n';
import { SkillTree } from './SkillTree';
import messages from './skill-tree.messages';

// The web preload (bunfig.toml -> test/setup.ts) only applies when bun runs from apps/web. The bead verifies from the
// repo root, where there is no DOM, so register happy-dom here BEFORE Testing Library is imported (same rule and guard
// as TrustBadge.test.tsx and lib/i18n.test.ts).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { act, cleanup, render, screen, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');

/*
 * SkillTree is presentational: the contract's `tree` (GET /api/player/journey -> Journey.tree) arrives as a prop.
 * Contract under test (fc-mol-0bt.8): each track with its ordered nodes; each node's state as a marker AND a written
 * label (mastered / training now / locked), never colour alone; a track level bar; a collapsible track.
 */

type Locale = (typeof LOCALES)[number];
type Props = Parameters<typeof SkillTree>[0];
type State = TreeTrack['nodes'][number]['state'];

// --- fixtures ----------------------------------------------------------------------------------

const BALL: TreeTrack = {
  track: 'ball-mastery',
  nodes: [
    { slug: 'basic-touches', name: 'Basic touches', state: 'mastered', level: 1 },
    { slug: 'inside-touches', name: 'Inside touches', state: 'mastered', level: 2 },
    { slug: 'outside-touches', name: 'Outside touches', state: 'training', level: 3 },
    { slug: 'alternating-touches', name: 'Alternating touches', state: 'locked', level: 4 },
    { slug: 'direction-change', name: 'Direction change', state: 'locked', level: 4 },
  ],
};

const PASSING: TreeTrack = {
  track: 'passing',
  nodes: [
    { slug: 'short-pass', name: 'Short pass', state: 'training', level: 1 },
    { slug: 'long-pass', name: 'Long pass', state: 'locked', level: 2 },
  ],
};

const TREE: TreeTrack[] = [BALL, PASSING];

// Natural forms for each language. Kazakh still needs the scheduled native review; these are the shipped strings.
const EXPECTED: Record<
  Locale,
  Record<State, string> & { progress: (done: number, total: number) => string; levelLabel: string; emptyTitle: string }
> = {
  en: {
    mastered: 'Mastered',
    training: 'Training now',
    locked: 'Locked',
    progress: (done, total) => `${done} of ${total} mastered`,
    levelLabel: 'Track level',
    emptyTitle: 'No skills to show yet',
  },
  ru: {
    mastered: 'Освоено',
    training: 'Тренировка сейчас',
    locked: 'Закрыто',
    progress: (done, total) => `Освоено ${done} из ${total}`,
    levelLabel: 'Уровень направления',
    emptyTitle: 'Пока нет навыков',
  },
  kk: {
    mastered: 'Меңгерілді',
    training: 'Қазір жаттығуда',
    locked: 'Жабық',
    progress: (done, total) => `${total} ішінен ${done} меңгерілді`,
    levelLabel: 'Бағыт деңгейі',
    emptyTitle: 'Әзірше дағды жоқ',
  },
};

const MODULES = { './skill-tree.messages.ts': { default: messages } };
const noStorage = { getItem: () => null, setItem: () => {} };

/** An isolated i18n instance per render: no global state, no <html lang> writes, no storage. */
function setup(props: Partial<Props> = {}, locale: Locale = 'en') {
  const instance = createI18n({ modules: MODULES, languages: [locale], storage: noStorage, root: { lang: '' }, dev: false });
  const view = render(
    <I18nextProvider i18n={instance}>
      <SkillTree tree={TREE} {...props} />
    </I18nextProvider>,
  );
  return { ...view, instance };
}

const tokens = (element: Element): string[] => Array.from(element.classList);

/** The list item of a node, found by its visible name. */
const nodeItem = (name: string): HTMLElement => {
  const item = screen.getByText(name).closest('li');
  if (item === null) throw new Error(`no list item around "${name}"`);
  return item;
};

/** The collapsible panel a toggle controls. */
const panelOf = (toggle: HTMLElement): HTMLElement => {
  const id = toggle.getAttribute('aria-controls');
  const panel = id === null ? null : document.getElementById(id);
  if (panel === null) throw new Error('toggle does not point at a panel');
  return panel;
};

const toggleOf = (trackName: string): HTMLElement => screen.getByRole('button', { name: trackName });

/** Dotted paths of every string leaf. */
function leafKeys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value as object, `${prefix}${key}.`),
  );
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(() => {
    throw new Error('SkillTree must not fetch');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  globalThis.fetch = realFetch;
});

// --- the shared contract this component consumes -------------------------------------------------

describe('contract', () => {
  test('the node states are the three this component is written for', () => {
    expect([...NODE_STATES]).toEqual(['mastered', 'training', 'locked']);
  });

  test('the fixtures are valid contract tracks', () => {
    for (const track of TREE) expect(TreeTrackSchema.safeParse(track).success).toBe(true);
  });
});

// --- catalogue ------------------------------------------------------------------------------------

describe('skill-tree.messages.ts', () => {
  test('is registered by the file-name convention: namespace "skill-tree"', () => {
    expect(namespaceOf('./skill-tree.messages.ts')).toBe('skill-tree');
  });

  test('default-exports kk, ru and en with the same keys', () => {
    const [kk, ru, en] = [messages.kk, messages.ru, messages.en].map((tree) => leafKeys(tree).sort());
    expect(kk?.length).toBeGreaterThanOrEqual(6);
    expect(ru).toEqual(kk!);
    expect(en).toEqual(kk!);
  });

  test('every string is non-blank in every locale', () => {
    for (const locale of LOCALES) {
      for (const key of leafKeys(messages[locale])) {
        let node: unknown = messages[locale];
        for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
        expect(typeof node).toBe('string');
        expect((node as string).trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// --- tracks and ordered nodes ----------------------------------------------------------------------

describe('tracks and their nodes', () => {
  test('every track renders, in the order given, with its own name', () => {
    setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Ball mastery', 'Passing']);
  });

  test('a track lists its nodes in the order the contract gives them, not sorted by name', () => {
    setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    const names = within(panelOf(toggleOf('Ball mastery')))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(names.map((text) => text?.replace(/Mastered|Training now|Locked/g, '').trim())).toEqual([
      'Basic touches',
      'Inside touches',
      'Outside touches',
      'Alternating touches',
      'Direction change',
    ]);
    // ... and a list that is ordered: it is an <ol>.
    expect(panelOf(toggleOf('Ball mastery')).tagName).toBe('OL');
  });

  test('a node appears under its own track only', () => {
    setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    expect(within(panelOf(toggleOf('Passing'))).queryByText('Basic touches')).toBeNull();
    expect(within(panelOf(toggleOf('Passing'))).getByText('Short pass')).toBeTruthy();
    expect(within(panelOf(toggleOf('Ball mastery'))).queryByText('Short pass')).toBeNull();
  });

  test('a different tree renders a different set: nothing is hard-coded in the component', () => {
    const tree: TreeTrack[] = [{ track: 'juggling', nodes: [{ slug: 'first-juggle', name: 'First juggle', state: 'training', level: 1 }] }];
    setup({ tree, trackNames: { juggling: 'Juggling' } });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('First juggle')).toBeTruthy();
    expect(screen.queryByText('Basic touches')).toBeNull();
  });

  test('node names are rendered as text, never as markup', () => {
    const name = '<img src=x onerror=alert(1)>Sneaky';
    setup({ tree: [{ track: 'ball-mastery', nodes: [{ slug: 'sneaky', name, state: 'locked', level: 1 }] }] });
    expect(screen.getByText(name)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

// --- track names -----------------------------------------------------------------------------------

describe('track names', () => {
  test('the contract carries only a track slug, so a track without a supplied name reads as its humanised slug', () => {
    setup();
    expect(toggleOf('Ball mastery')).toBeTruthy();
    expect(toggleOf('Passing')).toBeTruthy();
  });

  test('a supplied name wins over the slug', () => {
    setup({ trackNames: { 'ball-mastery': 'Работа с мячом' } });
    expect(toggleOf('Работа с мячом')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ball mastery' })).toBeNull();
  });

  test('never renders "undefined" or an empty name', () => {
    setup({ tree: [{ track: 'x', nodes: [] }], trackNames: {} });
    expect(document.body.textContent).not.toContain('undefined');
    expect(screen.getByRole('button').textContent?.trim().length).toBeGreaterThan(0);
  });
});

// --- the three states ------------------------------------------------------------------------------

describe.each([...LOCALES])('locale %s: the three states render with their labels', (locale) => {
  const expected = EXPECTED[locale];

  test('a mastered node reads its written label', () => {
    setup({}, locale);
    expect(within(nodeItem('Basic touches')).getByText(expected.mastered)).toBeTruthy();
  });

  test('a training node reads its written label', () => {
    setup({}, locale);
    expect(within(nodeItem('Outside touches')).getByText(expected.training)).toBeTruthy();
  });

  test('a locked node reads its written label', () => {
    setup({}, locale);
    expect(within(nodeItem('Alternating touches')).getByText(expected.locked)).toBeTruthy();
  });

  test('each node carries only its own state label, never another one', () => {
    setup({}, locale);
    const each: [string, State][] = [
      ['Basic touches', 'mastered'],
      ['Outside touches', 'training'],
      ['Alternating touches', 'locked'],
    ];
    for (const [name, state] of each) {
      const text = nodeItem(name).textContent ?? '';
      for (const other of NODE_STATES) {
        if (other === state) expect(text).toContain(expected[other]);
        else expect(text).not.toContain(expected[other]);
      }
    }
  });
});

describe('not colour alone: a marker shape and a word', () => {
  test('every node has exactly one decorative svg marker next to its label', () => {
    setup();
    for (const name of ['Basic touches', 'Outside touches', 'Alternating touches']) {
      const markers = nodeItem(name).querySelectorAll('svg');
      expect(markers).toHaveLength(1);
      expect(markers[0]?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  test('the three states draw three different marker shapes', () => {
    setup();
    const shape = (name: string) => nodeItem(name).querySelector('svg')!.innerHTML;
    const shapes = [shape('Basic touches'), shape('Outside touches'), shape('Alternating touches')];
    expect(shapes.every((each) => each.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(3);
  });

  test('the three states have three different written labels in every locale', () => {
    for (const locale of LOCALES) {
      expect(new Set([EXPECTED[locale].mastered, EXPECTED[locale].training, EXPECTED[locale].locked]).size).toBe(3);
    }
  });

  test.each(NODE_STATES)('a %s node exposes its state as data-state', (state) => {
    setup({ tree: [{ track: 'ball-mastery', nodes: [{ slug: 'n', name: 'Node', state, level: 1 }] }] });
    expect(nodeItem('Node').getAttribute('data-state')).toBe(state);
  });

  test('the state is part of the node text, so a screen reader reads name and state together', () => {
    setup();
    expect(nodeItem('Outside touches').textContent).toContain('Outside touches');
    expect(nodeItem('Outside touches').textContent).toContain('Training now');
  });

  test('an unrecognised state from an older cache reads as the calmest one (locked), never blank', () => {
    const tree = [{ track: 'ball-mastery', nodes: [{ slug: 'n', name: 'Node', state: 'expert', level: 1 }] }] as unknown as TreeTrack[];
    setup({ tree });
    expect(nodeItem('Node').getAttribute('data-state')).toBe('locked');
    expect(within(nodeItem('Node')).getByText('Locked')).toBeTruthy();
  });

  test('no inline colours: tokens and classes only', () => {
    const { container } = setup();
    for (const element of Array.from(container.querySelectorAll('*'))) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/#|rgb|hsl/);
      expect(element.getAttribute('fill') ?? '').not.toMatch(/#|rgb|hsl/);
    }
  });
});

// --- the track level bar -----------------------------------------------------------------------------

describe('track level bar', () => {
  test('each track has a progressbar: mastered nodes out of the track nodes', () => {
    setup();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('aria-valuemin')).toBe('0');
    expect(bars[0]?.getAttribute('aria-valuenow')).toBe('2');
    expect(bars[0]?.getAttribute('aria-valuemax')).toBe('5');
    expect(bars[1]?.getAttribute('aria-valuenow')).toBe('0');
    expect(bars[1]?.getAttribute('aria-valuemax')).toBe('2');
  });

  test('the bar is named for its track, so the bars can be told apart', () => {
    setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    const names = screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-label'));
    expect(names[0]).toContain('Ball mastery');
    expect(names[1]).toContain('Passing');
    expect(names[0]).toContain('Track level');
    expect(new Set(names).size).toBe(2);
  });

  test.each([...LOCALES])('the number is written beside the bar in %s: colour is not the only carrier', (locale) => {
    setup({}, locale);
    expect(screen.getByText(EXPECTED[locale].progress(2, 5))).toBeTruthy();
    expect(screen.getByText(EXPECTED[locale].progress(0, 2))).toBeTruthy();
  });

  test('the fill is proportional to mastered / total', () => {
    setup();
    const [ball] = screen.getAllByRole('progressbar');
    const fill = ball!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('40%');
  });

  test('a fully mastered track fills the bar', () => {
    const done: TreeTrack = {
      track: 'ball-mastery',
      nodes: [
        { slug: 'a', name: 'A', state: 'mastered', level: 1 },
        { slug: 'b', name: 'B', state: 'mastered', level: 2 },
      ],
    };
    setup({ tree: [done] });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  test('a track with no nodes has no bar and no NaN', () => {
    setup({ tree: [{ track: 'ball-mastery', nodes: [] }] });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.body.textContent).not.toContain('NaN');
  });

  test('the bar stays visible when its track is collapsed', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(toggleOf('Ball mastery'));
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });
});

// --- collapsible per track ----------------------------------------------------------------------------

describe('collapsible tracks', () => {
  test('each track has a real <button> toggle, expanded to begin with, that controls its node list', () => {
    setup();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(panelOf(button).hidden).toBe(false);
    }
  });

  test('the toggle is the track heading, so the track name is in the outline', () => {
    setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Ball mastery', 'Passing']);
    expect(toggleOf('Ball mastery').closest('h3')).not.toBeNull();
  });

  test('clicking the toggle collapses the node list and back', async () => {
    const user = userEvent.setup();
    setup();
    const toggle = toggleOf('Ball mastery');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(toggle).hidden).toBe(true);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(toggle).hidden).toBe(false);
  });

  test('keyboard: Enter toggles a focused track', async () => {
    const user = userEvent.setup();
    setup();
    const toggle = toggleOf('Ball mastery');
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(toggle).hidden).toBe(true);
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(toggle).hidden).toBe(false);
  });

  test('keyboard: Space toggles a focused track', async () => {
    const user = userEvent.setup();
    setup();
    const toggle = toggleOf('Ball mastery');
    await user.tab();
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  test('keyboard: Tab reaches each track toggle in turn and nothing else', async () => {
    const user = userEvent.setup();
    setup();
    await user.tab();
    expect(document.activeElement).toBe(toggleOf('Ball mastery'));
    await user.tab();
    expect(document.activeElement).toBe(toggleOf('Passing'));
  });

  test('tracks collapse independently', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(toggleOf('Ball mastery'));
    expect(toggleOf('Ball mastery').getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf('Passing').getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(toggleOf('Passing')).hidden).toBe(false);
  });

  test('a collapsed track keeps its state when the tree is re-fetched (same tracks, new data)', async () => {
    const user = userEvent.setup();
    const { rerender, instance } = setup();
    await user.click(toggleOf('Ball mastery'));
    const advanced: TreeTrack[] = [
      { ...BALL, nodes: BALL.nodes.map((node) => (node.slug === 'outside-touches' ? { ...node, state: 'mastered' as const } : node)) },
      PASSING,
    ];
    rerender(
      <I18nextProvider i18n={instance}>
        <SkillTree tree={advanced} />
      </I18nextProvider>,
    );
    expect(toggleOf('Ball mastery').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('progressbar')[0]?.getAttribute('aria-valuenow')).toBe('3');
  });

  test('the toggle is a large touch target and shows a visible focus ring', () => {
    setup();
    const toggle = toggleOf('Ball mastery');
    expect(tokens(toggle)).toContain('min-h-11');
    expect(tokens(toggle)).toContain('w-full');
    // The global :focus-visible ring (app.css) must not be removed by the component.
    expect(toggle.className).not.toMatch(/outline-none|outline-0|focus:outline-none/);
  });

  test('the chevron is decorative: the state is in aria-expanded', () => {
    setup();
    const icons = toggleOf('Ball mastery').querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
  });
});

// --- empty tree ---------------------------------------------------------------------------------------

describe('an empty tree', () => {
  test.each([...LOCALES])('shows a calm empty state in %s and no toggles', (locale) => {
    setup({ tree: [] }, locale);
    expect(screen.getByText(EXPECTED[locale].emptyTitle)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

// --- language switch ----------------------------------------------------------------------------------

describe('language switch', () => {
  test('the labels follow the language without remounting', async () => {
    const { instance } = setup();
    const item = nodeItem('Basic touches');
    expect(item.textContent).toContain('Mastered');
    await act(async () => {
      await instance.changeLanguage('ru');
    });
    expect(item.textContent).toContain('Освоено');
    await act(async () => {
      await instance.changeLanguage('kk');
    });
    expect(item.textContent).toContain('Меңгерілді');
    expect(item.isConnected).toBe(true);
  });

  test('a collapsed track stays collapsed across a language switch', async () => {
    const user = userEvent.setup();
    const { instance } = setup({ trackNames: { 'ball-mastery': 'Ball mastery', passing: 'Passing' } });
    await user.click(toggleOf('Ball mastery'));
    await act(async () => {
      await instance.changeLanguage('ru');
    });
    expect(toggleOf('Ball mastery').getAttribute('aria-expanded')).toBe('false');
  });
});
