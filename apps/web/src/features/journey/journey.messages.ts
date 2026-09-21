import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the My Journey screen (/progress). Namespace = file base name (`journey`), collected by the `*.messages.ts`
 * glob in lib/i18n.ts, so nothing outside this file registers it. The skill tree keeps its own words in
 * skill-tree.messages.ts and generic failures in lib/problem.messages.ts.
 *
 * Placeholders: {{date}} (a formatted date), {{n}} (a count; deliberately not `count`, which i18next reads as a plural
 * selector). Sentences that would need a plural form are worded so they do not ("Current streak (days)").
 * `milestones.names` is keyed by the API's milestone keys (apps/api/src/player/milestones.ts MILESTONE_KEYS).
 * Tone: the player is only ever compared with their own earlier results; a fall is "lower than last time", never a failure.
 * Kazakh text still needs a native review.
 */
export default {
  kk: {
    eyebrow: 'Прогресс',
    title: 'Менің жолым',
    lead: 'Өзіңді тек өзіңнің бұрынғы нәтижелеріңмен салыстырасың.',
    loading: 'Жолыңды жүктеп жатырмыз',
    metrics: {
      sessions: 'Аяқталған жаттығулар',
      minutes: 'Жаттығу минуттары',
      streak: 'Ағымдағы серия (күн)',
      improving: 'Дамып келе жатқан дағдылар',
    },
    tests: {
      title: 'Дағды тексерулері',
      empty: 'Дағды тексерулері әзірше жоқ. Алғашқы нәтижең осында пайда болады.',
      previous: 'Алдыңғы жолы',
      latest: 'Қазір',
      first: 'Алғашқы нәтиже',
      better: 'Алдыңғы жолдан жақсы',
      same: 'Алдыңғы жолмен бірдей',
      lower: 'Алдыңғыдан төмен',
      higherIsBetter: 'Көп болған сайын жақсы',
      lowerIsBetter: 'Аз болған сайын жақсы',
      personalBest: 'Жеке рекорд',
      allResults: 'Барлық нәтижелер ({{n}})',
      nextRetest: 'Келесі тест: {{date}}',
      retestTitle: 'Тестті қайта тапсыратын уақыт',
      retestHint: 'Алдыңғы жолдан бері қаншалықты өскеніңді көр.',
      retestAction: 'Тестті қазір қайта тапсыру',
    },
    milestones: {
      title: 'Жетістіктер',
      achievedOn: 'Орындалды: {{date}}',
      upcoming: 'Алда',
      names: {
        FIRST_SESSION: 'Алғашқы жаттығу аяқталды',
        TEN_TRAINING_DAYS: '10 жаттығу күні',
        THOUSAND_TOUCHES: '1 000 жанасу',
        WEAK_FOOT_LEVEL_2: 'Әлсіз аяқ: 2-деңгей',
        FIVE_HOURS_TRAINED: '5 сағат жаттығу',
        FIRST_RETEST: 'Алғашқы қайта тест',
        other: 'Тағы бір жетістік',
      },
    },
    tree: { title: 'Дағдылар ағашы' },
    empty: {
      title: 'Жолың алғашқы тестен басталады',
      hint: 'Қысқа тест жасап, алғашқы жаттығуды орында. Прогресің осында көрінеді.',
      action: 'ЖАТТЫҒУДЫ БАСТАУ',
    },
    error: {
      title: 'Жолыңды жүктей алмадық',
      retry: 'Қайталау',
    },
  },
  ru: {
    eyebrow: 'Прогресс',
    title: 'Мой путь',
    lead: 'Ты сравниваешься только со своими прежними результатами.',
    loading: 'Загружаем твой путь',
    metrics: {
      sessions: 'Завершено тренировок',
      minutes: 'Минут тренировок',
      streak: 'Текущая серия (дней)',
      improving: 'Навыков растёт',
    },
    tests: {
      title: 'Проверки навыков',
      empty: 'Проверок навыков пока нет. Твой первый результат появится здесь.',
      previous: 'В прошлый раз',
      latest: 'Сейчас',
      first: 'Первый результат',
      better: 'Лучше, чем в прошлый раз',
      same: 'Так же, как в прошлый раз',
      lower: 'Ниже, чем в прошлый раз',
      higherIsBetter: 'Чем больше, тем лучше',
      lowerIsBetter: 'Чем меньше, тем лучше',
      personalBest: 'Личный рекорд',
      allResults: 'Все результаты ({{n}})',
      nextRetest: 'Следующий тест: {{date}}',
      retestTitle: 'Пора пройти тест ещё раз',
      retestHint: 'Посмотри, как ты вырос с прошлого раза.',
      retestAction: 'Пройти тест сейчас',
    },
    milestones: {
      title: 'Достижения',
      achievedOn: 'Достигнуто: {{date}}',
      upcoming: 'Впереди',
      names: {
        FIRST_SESSION: 'Первая тренировка позади',
        TEN_TRAINING_DAYS: '10 дней тренировок',
        THOUSAND_TOUCHES: '1 000 касаний',
        WEAK_FOOT_LEVEL_2: 'Слабая нога: уровень 2',
        FIVE_HOURS_TRAINED: '5 часов тренировок',
        FIRST_RETEST: 'Первый повторный тест',
        other: 'Ещё одно достижение',
      },
    },
    tree: { title: 'Дерево навыков' },
    empty: {
      title: 'Твой путь начинается с первого теста',
      hint: 'Пройди короткий тест и первое упражнение, и твой прогресс появится здесь.',
      action: 'НАЧАТЬ ТРЕНИРОВКУ',
    },
    error: {
      title: 'Не удалось загрузить твой путь',
      retry: 'Повторить',
    },
  },
  en: {
    eyebrow: 'Progress',
    title: 'My journey',
    lead: 'You are compared only with your own earlier results.',
    loading: 'Loading your journey',
    metrics: {
      sessions: 'Sessions completed',
      minutes: 'Minutes trained',
      streak: 'Current streak (days)',
      improving: 'Skills improving',
    },
    tests: {
      title: 'Skill checks',
      empty: 'No skill checks yet. Your first result will show up here.',
      previous: 'Last time',
      latest: 'Now',
      first: 'First result',
      better: 'Better than last time',
      same: 'Same as last time',
      lower: 'Lower than last time',
      higherIsBetter: 'More is better',
      lowerIsBetter: 'Less is better',
      personalBest: 'Personal best',
      allResults: 'All results ({{n}})',
      nextRetest: 'Next retest: {{date}}',
      retestTitle: 'Time for a retest',
      retestHint: 'See how far you have come since last time.',
      retestAction: 'Retest now',
    },
    milestones: {
      title: 'Milestones',
      achievedOn: 'Achieved {{date}}',
      upcoming: 'Coming up',
      names: {
        FIRST_SESSION: 'First session finished',
        TEN_TRAINING_DAYS: '10 training days',
        THOUSAND_TOUCHES: '1,000 touches',
        WEAK_FOOT_LEVEL_2: 'Weak foot: level 2',
        FIVE_HOURS_TRAINED: '5 hours trained',
        FIRST_RETEST: 'First retest done',
        other: 'Another milestone',
      },
    },
    tree: { title: 'Skill tree' },
    empty: {
      title: 'Your journey starts with the first check',
      hint: 'Do a short skill check and a first drill, and your progress will show up here.',
      action: 'START TRAINING',
    },
    error: {
      title: 'We could not load your journey',
      retry: 'Try again',
    },
  },
} satisfies MessageBundle;
