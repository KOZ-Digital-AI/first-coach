import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Locale } from '@api-types/primitives';
import { I18nextProvider } from 'react-i18next';
import { createApi } from '../../lib/api';
import { createI18n } from '../../lib/i18n';
import problemMessages from '../../lib/problem.messages';
import { Route, TodayDepsContext } from '../../routes/train/index';
import trustBadgeMessages from '../commons/trust-badge.messages';
import { createEventsClient } from './events-client';
import todayMessages from './today.messages';

// Same happy-dom registration rule as today.test.tsx (the verify command may run from the repo root).
if (typeof document === 'undefined') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
const { cleanup, render, screen, within } = await import('@testing-library/react');

/*
 * fc-mol-urn.11: each drill row of /train shows the drill's track (its primary skill) and its level, in kk, ru and en.
 * TodayItem.track / TodayItem.level are OPTIONAL on the contract (a cached PWA session, or an older server, has neither),
 * so a row without them must render exactly as before: no empty label, no "undefined", no blank "Level:".
 * The server is a fake `fetch` handed to the real `createApi`; the strings expected below are literal on purpose, so a
 * missing or mistyped message key cannot pass by echoing itself.
 * Kazakh wording still needs a native review.
 */

const attribution = {
  author: 'FIRST COACH Genesis',
  source: 'FIRST COACH Genesis',
  license: 'CC-BY-SA-4.0',
  createdAt: '2026-09-01T10:00:00Z',
  semver: '1.0.0',
};

type ItemFields = { itemId: string; track?: string; level?: string };

function item({ itemId, track, level }: ItemFields) {
  return {
    itemId,
    drillVersionId: `${itemId}-v1`,
    minutes: 6,
    done: false,
    reason: 'focus',
    ...(track === undefined ? {} : { track }),
    ...(level === undefined ? {} : { level }),
    content: {
      title: { kk: `Жаттығу ${itemId}`, ru: `Упражнение ${itemId}`, en: `Drill ${itemId}` },
      goal: { kk: `Мақсат ${itemId}`, ru: `Цель ${itemId}`, en: `Goal of ${itemId}` },
      instructions: { kk: 'Орында.', ru: 'Выполни.', en: 'Do it.' },
      dose: { reps: 20 },
      conditions: { equipment: 'ball', spaces: ['yard'] },
    },
    status: 'COMMUNITY',
    attribution,
  };
}

function session(items: unknown[]) {
  return {
    id: 'session-1',
    date: '2026-09-21',
    planner: 'rules',
    totalMinutes: 20,
    graphVersion: '0.1.0',
    items,
    roadmapSummary: {
      currentLevelLabel: 'Basic',
      sessionsPerWeek: 3,
      minutesPerSession: 20,
      focus: [
        { skill: 'sprint-speed', level: 2, targetLevel: 3, reason: 'goal' },
        { skill: 'coordination', level: 1, targetLevel: 2, reason: 'weakest' },
      ],
    },
  };
}

// The five root tracks of the skill graph (every seeded drill's primary skill is one of them), levels cycling.
const FIVE = [
  item({ itemId: 'item-1', track: 'dribbling', level: 'beginner' }),
  item({ itemId: 'item-2', track: 'weak-foot', level: 'basic' }),
  item({ itemId: 'item-3', track: 'passing-first-touch', level: 'intermediate' }),
  item({ itemId: 'item-4', track: 'ball-mastery', level: 'beginner' }),
  item({ itemId: 'item-5', track: 'juggling-coordination', level: 'basic' }),
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const MODULES = {
  './today.messages.ts': { default: todayMessages },
  '../commons/trust-badge.messages.ts': { default: trustBadgeMessages },
  '../../lib/problem.messages.ts': { default: problemMessages },
};

function mountToday(items: unknown[], locale: Locale = 'en', cached = false) {
  const data = session(items);
  const fetchImpl = async (): Promise<Response> => json(data);
  const i18n = createI18n({
    modules: MODULES,
    languages: [locale],
    storage: { getItem: () => null, setItem: () => undefined },
    root: { lang: '' },
    dev: false,
  });
  const api = createApi({ fetch: fetchImpl, language: () => locale, online: () => true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) queryClient.setQueryData(['today'], data);
  const events = createEventsClient({ api, queryClient });
  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the /train route has no component');
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <TodayDepsContext.Provider
          value={{
            api,
            ensureSession: mock(async () => ({ user: { id: 'player-1' } })),
            navigate: mock(() => undefined),
            timeZone: () => 'Asia/Almaty',
            events,
            slots: [],
          }}
        >
          <Page />
        </TodayDepsContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

const rows = async (locale: Locale) => within(await screen.findByRole('list', { name: todayMessages[locale].list })).getAllByRole('listitem');

describe('a drill row shows the drill track and level', () => {
  test('en: track name and "Level: ..." on every row, each its own drill', async () => {
    mountToday(FIVE, 'en');
    const list = await rows('en');
    const expected = [
      ['Dribbling', 'Level: Beginner'],
      ['Weaker foot', 'Level: Basic'],
      ['Passing and first touch', 'Level: Intermediate'],
      ['Ball mastery', 'Level: Beginner'],
      ['Juggling and coordination', 'Level: Basic'],
    ];
    expect(list).toHaveLength(5);
    expected.forEach(([track, level], index) => {
      expect(within(list[index]!).getByText(track!)).toBeTruthy();
      expect(within(list[index]!).getByText(level!)).toBeTruthy();
    });
    // A row does not borrow another row's track or level.
    expect(within(list[0]!).queryByText('Weaker foot')).toBeNull();
    expect(within(list[0]!).queryByText('Level: Basic')).toBeNull();
  });

  test('ru: the same, in Russian', async () => {
    mountToday(FIVE, 'ru');
    const list = await rows('ru');
    const expected = [
      ['Дриблинг', 'Уровень: Начальный'],
      ['Слабая нога', 'Уровень: Базовый'],
      ['Пас и первый приём', 'Уровень: Средний'],
      ['Владение мячом', 'Уровень: Начальный'],
      ['Жонглирование и координация', 'Уровень: Базовый'],
    ];
    expected.forEach(([track, level], index) => {
      expect(within(list[index]!).getByText(track!)).toBeTruthy();
      expect(within(list[index]!).getByText(level!)).toBeTruthy();
    });
  });

  test('kk: the same, in Kazakh', async () => {
    mountToday(FIVE, 'kk');
    const list = await rows('kk');
    const expected = [
      ['Дриблинг', 'Деңгей: Бастаушы'],
      ['Әлсіз аяқ', 'Деңгей: Негізгі'],
      ['Пас және допты алғаш қабылдау', 'Деңгей: Орта'],
      ['Допты меңгеру', 'Деңгей: Бастаушы'],
      ['Жонглёрлау және үйлесімділік', 'Деңгей: Негізгі'],
    ];
    expected.forEach(([track, level], index) => {
      expect(within(list[index]!).getByText(track!)).toBeTruthy();
      expect(within(list[index]!).getByText(level!)).toBeTruthy();
    });
  });

  test('a track slug the screen has no wording for is shown humanised, never blank and never the raw slug', async () => {
    mountToday([item({ itemId: 'item-1', track: 'sprint-speed', level: 'basic' })], 'en');
    const [row] = await rows('en');
    expect(within(row!).getByText('Sprint speed')).toBeTruthy();
    expect(within(row!).queryByText('sprint-speed')).toBeNull();
  });
});

describe('the fields are optional: a row without them renders as before', () => {
  test('an item with neither track nor level (an older server) shows no level label and no stray text', async () => {
    mountToday([item({ itemId: 'item-1' })], 'en');
    const [row] = await rows('en');
    expect(within(row!).getByText('Drill item-1')).toBeTruthy();
    expect(within(row!).queryByText(/Level/)).toBeNull();
    expect(row!.textContent).not.toMatch(/undefined|null/);
    // Nothing sits between the index badge and the title where the track would be.
    expect(row!.textContent).toMatch(/^1Drill item-1Goal of item-1/);
  });

  test('a session restored from the persisted cache without the fields still lists its drills', async () => {
    mountToday([item({ itemId: 'item-1' }), item({ itemId: 'item-2' })], 'ru', true);
    const list = await rows('ru');
    expect(list).toHaveLength(2);
    expect(within(list[0]!).queryByText(/Уровень/)).toBeNull();
  });

  test('a level without a track shows the level only, and a track without a level shows the track only', async () => {
    mountToday([item({ itemId: 'item-1', level: 'basic' }), item({ itemId: 'item-2', track: 'dribbling' })], 'en');
    const [first, second] = await rows('en');
    expect(within(first!).getByText('Level: Basic')).toBeTruthy();
    expect(within(first!).queryByText('Dribbling')).toBeNull();
    expect(within(second!).getByText('Dribbling')).toBeTruthy();
    expect(within(second!).queryByText(/Level/)).toBeNull();
  });
});
