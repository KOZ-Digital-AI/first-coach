import type { MessageBundle } from '../../lib/i18n';

/**
 * Strings of /commons (the drill library screen). Namespace = file base name (`library`), collected by the `*.messages.ts` glob
 * in lib/i18n.ts, so nothing outside this file registers it. Generic failures (offline, server, ...) live in
 * lib/problem.messages.ts and are shown through describeProblem; the status words of the filter and the card are the trust
 * badge's own (trust-badge.messages.ts). The drills' titles and the track names arrive from the API in the requested language.
 *
 * - `levels` and `equipment` are keyed by the contract's ExperienceLevel and Equipment enums (`equipment` words match
 *   detail.messages.ts). They only NAME a value the facets already listed; they never decide which options exist.
 * - No plural keys: minutes are "10 min", the age is "from N" / "up to N" / "N-M" and the count line is "Showing N of M"
 *   ("Показано N из M", "Көрсетілгені: N / M"), so no Russian or Kazakh plural or case form is needed.
 * - Kazakh text still needs a native review.
 */
export default {
  kk: {
    eyebrow: 'Open Sport Commons',
    title: 'Спорт білімі — қоғамдық инфрақұрылым',
    intro:
      'Commons-тағы әрбір жаттығу ашық, оның нұсқалары сақталады және дереккөзі көрсетіледі. Кез келген жаттықтырушы, клуб немесе қолданба оны пайдаланып, жақсарта алады.',
    download: 'Commons JSON жүктеу',
    contribute: 'Әдіс ұсыну',
    filter: {
      legend: 'Жаттығуларды сүзгілеу',
      track: 'Бағыт',
      status: 'Мәртебе',
      equipment: 'Құрал-жабдық',
      level: 'Деңгей',
      search: 'Жаттығуларды іздеу',
      searchHint: 'Атауы мен мақсаты бойынша іздейді.',
      searchButton: 'Іздеу',
      all: 'Барлығы',
    },
    levels: { beginner: 'Бастаушы', basic: 'Негізгі', intermediate: 'Орташа' },
    equipment: {
      nothing: 'Ештеңе керек емес',
      ball: 'Доп',
      ball_wall: 'Доп + қабырға',
      cones: 'Конустар',
      full_field: 'Толық алаң',
    },
    card: {
      minutes: '{{count}} мин',
      level: 'Деңгейі: {{level}}',
      equipment: 'Құрал-жабдық: {{equipment}}',
      ageFrom: 'Жасы: {{min}} және одан үлкен',
      ageUpTo: 'Жасы: {{max}} және одан кіші',
      ageRange: 'Жасы: {{min}}–{{max}}',
      source: 'Дереккөз: {{source}}',
      licence: 'Лицензия: {{licence}}',
    },
    list: 'Жаттығулар',
    summary: 'Көрсетілгені: {{shown}} / {{total}}',
    summaryShown: 'Көрсетілгені: {{shown}}',
    updating: 'Жаңартып жатырмыз…',
    more: 'Тағы жаттығулар көрсету',
    loading: 'Жаттығуларды жүктеп жатырмыз…',
    error: { title: 'Жаттығулар жүктелмеді', retry: 'Қайталау' },
    empty: {
      title: 'Бұл сүзгілерге сәйкес жаттығу жоқ',
      hint: 'Сүзгілерді азайтып немесе басқа сөзді байқап көр.',
      clear: 'Сүзгілерді тазалау',
    },
    emptyAll: {
      title: 'Жаттығулар әлі жарияланбаған',
      hint: 'Кейінірек кіріп көр немесе өз әдісіңді ұсын.',
    },
  },
  ru: {
    eyebrow: 'Open Sport Commons',
    title: 'Спортивные знания как общественная инфраструктура',
    intro:
      'Каждое упражнение в Commons открыто, версионировано и указывает свой источник. Любой тренер, клуб или приложение может использовать его и улучшать.',
    download: 'Скачать Commons JSON',
    contribute: 'Предложить метод',
    filter: {
      legend: 'Фильтры упражнений',
      track: 'Направление',
      status: 'Статус',
      equipment: 'Инвентарь',
      level: 'Уровень',
      search: 'Поиск упражнений',
      searchHint: 'Ищет по названию и цели.',
      searchButton: 'Найти',
      all: 'Все',
    },
    levels: { beginner: 'Начальный', basic: 'Базовый', intermediate: 'Средний' },
    equipment: {
      nothing: 'Ничего не нужно',
      ball: 'Мяч',
      ball_wall: 'Мяч + стена',
      cones: 'Конусы',
      full_field: 'Полное поле',
    },
    card: {
      minutes: '{{count}} мин',
      level: 'Уровень: {{level}}',
      equipment: 'Инвентарь: {{equipment}}',
      ageFrom: 'Возраст от {{min}}',
      ageUpTo: 'Возраст до {{max}}',
      ageRange: 'Возраст {{min}}–{{max}}',
      source: 'Источник: {{source}}',
      licence: 'Лицензия: {{licence}}',
    },
    list: 'Упражнения',
    summary: 'Показано {{shown}} из {{total}}',
    summaryShown: 'Показано: {{shown}}',
    updating: 'Обновляем…',
    more: 'Показать ещё упражнения',
    loading: 'Загружаем упражнения…',
    error: { title: 'Упражнения не загрузились', retry: 'Повторить' },
    empty: {
      title: 'Нет упражнений по этим фильтрам',
      hint: 'Уберите часть фильтров или попробуйте другое слово.',
      clear: 'Сбросить фильтры',
    },
    emptyAll: {
      title: 'Упражнения ещё не опубликованы',
      hint: 'Загляните позже или предложите свой метод.',
    },
  },
  en: {
    eyebrow: 'Open Sport Commons',
    title: 'Sport knowledge as public infrastructure',
    intro: 'Every drill in the Commons is open, versioned and credited to its source, so any coach, club or app can use it and improve it.',
    download: 'Download Commons JSON',
    contribute: 'Contribute a method',
    filter: {
      legend: 'Filter drills',
      track: 'Track',
      status: 'Status',
      equipment: 'Equipment',
      level: 'Level',
      search: 'Search drills',
      searchHint: 'Searches titles and goals.',
      searchButton: 'Search',
      all: 'All',
    },
    levels: { beginner: 'Beginner', basic: 'Basic', intermediate: 'Intermediate' },
    equipment: {
      nothing: 'Nothing',
      ball: 'Ball',
      ball_wall: 'Ball + wall',
      cones: 'Cones',
      full_field: 'Full field',
    },
    card: {
      minutes: '{{count}} min',
      level: 'Level: {{level}}',
      equipment: 'Equipment: {{equipment}}',
      ageFrom: 'Age from {{min}}',
      ageUpTo: 'Age up to {{max}}',
      ageRange: 'Age {{min}}–{{max}}',
      source: 'Source: {{source}}',
      licence: 'Licence: {{licence}}',
    },
    list: 'Drills',
    summary: 'Showing {{shown}} of {{total}}',
    summaryShown: 'Showing {{shown}}',
    updating: 'Updating…',
    more: 'Show more drills',
    loading: 'Loading drills…',
    error: { title: 'The drills did not load', retry: 'Try again' },
    empty: {
      title: 'No drills match these filters',
      hint: 'Try fewer filters or a different word.',
      clear: 'Clear filters',
    },
    emptyAll: {
      title: 'No drills are published yet',
      hint: 'Come back soon, or contribute a method of your own.',
    },
  },
} satisfies MessageBundle;
