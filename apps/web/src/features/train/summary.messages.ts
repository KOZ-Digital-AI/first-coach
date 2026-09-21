import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the session summary screen (/train/summary). Namespace = file base name (`summary`), collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it.
 * Numbers arrive already formatted for the language ({{total}}). Wording avoids plural forms on purpose (a label plus a
 * bare number: "Sessions finished  4"), so one phrase per language is enough.
 * Calm by design (DESIGN.md / PRODUCT.md): it praises turning up, compares only with the player's own past sessions, never
 * with other children, promises no career and never scolds; the empty and error copy blames nobody.
 * The minutes figure is CUMULATIVE ("so far"), never "today": the API's minutesTrained sums every done drill ever.
 * Kazakh text still needs a native review (as everywhere else in this repo).
 */
export default {
  kk: {
    eyebrow: 'Жаттығу қорытындысы',
    title: 'Жаттығу аяқталды',
    lead: 'Жарайсың, жаттығуды орындадың. Прогресің тек өзіңнің бұрынғы жаттығуларыңмен салыстырылады.',
    stats: {
      drills: 'Орындалған жаттығулар',
      drillsOf: '/ {{total}}',
      minutes: 'Осы кезге дейінгі жаттығу минуттары',
      streak: 'Қазіргі серия (қатарынан күн)',
      sessions: 'Аяқталған жаттығу сессиялары',
      next: 'Келесі жаттығу',
    },
    links: {
      journey: 'Менің жолым',
      home: 'Басты бетке',
    },
    loading: 'Қорытынды дайындалып жатыр…',
    empty: {
      title: 'Аяқталған жаттығу әлі жоқ',
      hint: 'Жаттығуларды орындап болғанда, қорытынды осында пайда болады.',
      action: 'Жаттығуға өту',
    },
    error: {
      title: 'Қорытындыны көрсете алмадық',
      message: 'Жаттығу бетіне оралып, жалғастыр.',
      action: 'Жаттығуға өту',
    },
  },
  ru: {
    eyebrow: 'Итоги тренировки',
    title: 'Тренировка завершена',
    lead: 'Молодец, ты позанимался. Твой прогресс сравнивается только с твоими прежними тренировками.',
    stats: {
      drills: 'Выполнено упражнений',
      drillsOf: 'из {{total}}',
      minutes: 'Всего минут тренировок',
      streak: 'Текущая серия (дней подряд)',
      sessions: 'Завершено тренировок',
      next: 'Следующая тренировка',
    },
    links: {
      journey: 'Мой путь',
      home: 'На главную',
    },
    loading: 'Готовим итоги…',
    empty: {
      title: 'Завершённой тренировки пока нет',
      hint: 'Когда ты выполнишь все упражнения, итоги появятся здесь.',
      action: 'К тренировке',
    },
    error: {
      title: 'Не получилось показать итоги',
      message: 'Вернись к тренировке и продолжай.',
      action: 'К тренировке',
    },
  },
  en: {
    eyebrow: 'Session summary',
    title: 'Session complete',
    lead: 'Nice work, you showed up and did the drills. Your progress is measured only against your own earlier sessions.',
    stats: {
      drills: 'Drills completed',
      drillsOf: 'of {{total}}',
      minutes: 'Minutes trained so far',
      streak: 'Current streak (days in a row)',
      sessions: 'Sessions finished',
      next: 'Next session',
    },
    links: {
      journey: 'My Journey',
      home: 'Back home',
    },
    loading: 'Getting your summary ready…',
    empty: {
      title: 'No finished session yet',
      hint: 'Finish all the drills of your session and your summary will be waiting here.',
      action: 'Go to your session',
    },
    error: {
      title: 'We could not show your summary',
      message: 'Go back to your session and carry on.',
      action: 'Go to your session',
    },
  },
} satisfies MessageBundle;
