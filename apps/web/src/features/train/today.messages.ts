import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of today's session screen (/train). Namespace = file base name (`today`), collected by the `*.messages.ts` glob in
 * lib/i18n.ts, so nothing outside this file registers it.
 * Numbers arrive already formatted for the language ({{minutes}}, {{done}}, {{total}}, {{from}}, {{to}}). Wording avoids
 * plural forms on purpose ("Sessions per week: 3"), so one phrase per language is enough.
 * `reasons` is keyed by the planner's item reason keys (warmup | focus | fill), `focus.reasons` by the roadmap's focus reason
 * keys (goal | weakest) and `focus.levels` by the roadmap's level labels; a value the client does not know is shown as sent.
 * Kazakh text still needs a native review.
 */
export default {
  kk: {
    eyebrow: 'Бүгінгі жаттығу',
    title: 'Бүгін {{minutes}} мин',
    lead: 'Жаттығуларды ретімен орында. Ашу үшін жаттығуды бас.',
    completed: '{{done}}/{{total}} орындалды',
    progress: 'Жаттығу барысы',
    list: 'Бүгінгі жаттығулар',
    drill: {
      minutes: '{{minutes}} мин',
      done: 'Орындалды',
      todo: 'Әлі орындалмады',
    },
    reasons: {
      warmup: 'Жылыну',
      focus: 'Басты назар',
      fill: 'Қосымша жаттығу',
    },
    finish: 'Жаттығуды аяқтау',
    finishing: 'Жаттығу сақталуда…',
    finishHint: 'Барлық жаттығу орындалғанда аяқтауға болады.',
    allDone: 'Барлық жаттығу орындалды. Сақтау үшін жаттығуды аяқта.',
    finishError: {
      title: 'Жаттығуды сақтау мүмкін болмады',
    },
    loading: 'Бүгінгі жаттығу жүктелуде…',
    loadError: {
      title: 'Бүгінгі жаттығуды жүктеу мүмкін болмады',
    },
    retry: 'Қайталау',
    empty: {
      title: 'Бүгінге жаттығу әлі жоқ',
      hint: 'Орның мен құралдарыңа сай жаттығу табылмады. Сәл кейінірек қайталап көр.',
    },
    redirecting: 'Алдымен жоспарыңды құрайық…',
    stale: 'Жаңарту мүмкін болмады. Соңғы сақталған жаттығу көрсетілді.',
    focus: {
      title: 'Сенің назарың',
      level: 'Қазіргі деңгей',
      levels: {
        Foundation: 'Негіз',
        Basic: 'Базалық',
        Intermediate: 'Орташа',
        Advanced: 'Жоғары',
      },
      range: 'Деңгей: {{from}} – {{to}}',
      reasons: {
        goal: 'Сенің мақсатың',
        weakest: 'Осында өсуге орын бар',
      },
      perWeek: 'Аптасына жаттығу саны',
      perSession: 'Бір жаттығу, мин',
    },
  },
  ru: {
    eyebrow: 'Занятие на сегодня',
    title: '{{minutes}} мин сегодня',
    lead: 'Делай упражнения по порядку. Нажми на упражнение, чтобы открыть его.',
    completed: '{{done}}/{{total}} выполнено',
    progress: 'Ход занятия',
    list: 'Упражнения на сегодня',
    drill: {
      minutes: '{{minutes}} мин',
      done: 'Готово',
      todo: 'Ещё не сделано',
    },
    reasons: {
      warmup: 'Разминка',
      focus: 'Главный акцент',
      fill: 'Дополнительная практика',
    },
    finish: 'Завершить занятие',
    finishing: 'Сохраняем занятие…',
    finishHint: 'Завершить можно, когда все упражнения выполнены.',
    allDone: 'Все упражнения выполнены. Заверши занятие, чтобы сохранить его.',
    finishError: {
      title: 'Не удалось сохранить занятие',
    },
    loading: 'Загружаем занятие на сегодня…',
    loadError: {
      title: 'Не удалось загрузить занятие на сегодня',
    },
    retry: 'Повторить',
    empty: {
      title: 'Пока нет упражнений на сегодня',
      hint: 'Не нашлось упражнения под твоё место и инвентарь. Попробуй чуть позже.',
    },
    redirecting: 'Сначала настроим твой план…',
    stale: 'Не удалось обновить. Показано последнее сохранённое занятие.',
    focus: {
      title: 'Твой фокус',
      level: 'Текущий уровень',
      levels: {
        Foundation: 'Основа',
        Basic: 'Базовый',
        Intermediate: 'Средний',
        Advanced: 'Продвинутый',
      },
      range: 'Уровень: с {{from}} до {{to}}',
      reasons: {
        goal: 'Твоя цель',
        weakest: 'Здесь есть куда расти',
      },
      perWeek: 'Занятий в неделю',
      perSession: 'Минут за занятие',
    },
  },
  en: {
    eyebrow: "Today's session",
    title: '{{minutes}} min today',
    lead: 'Do the drills in order. Tap a drill to open it.',
    completed: '{{done}}/{{total}} completed',
    progress: 'Session progress',
    list: "Today's drills",
    drill: {
      minutes: '{{minutes}} min',
      done: 'Done',
      todo: 'To do',
    },
    reasons: {
      warmup: 'Warm-up',
      focus: 'Focus',
      fill: 'Extra practice',
    },
    finish: 'Finish session',
    finishing: 'Saving your session…',
    finishHint: 'Finish is available when every drill is done.',
    allDone: 'All drills done. Finish the session to save it.',
    finishError: {
      title: 'Could not save the session',
    },
    loading: "Loading today's session…",
    loadError: {
      title: "Could not load today's session",
    },
    retry: 'Try again',
    empty: {
      title: 'No drills today yet',
      hint: 'We could not find a drill that fits your place and kit. Try again a little later.',
    },
    redirecting: 'Setting up your plan first…',
    stale: 'Could not refresh. Showing the last saved session.',
    focus: {
      title: 'Your focus',
      level: 'Current level',
      levels: {
        Foundation: 'Foundation',
        Basic: 'Basic',
        Intermediate: 'Intermediate',
        Advanced: 'Advanced',
      },
      range: 'Level {{from}} to {{to}}',
      reasons: {
        goal: 'Your chosen goal',
        weakest: 'Room to grow',
      },
      perWeek: 'Sessions per week',
      perSession: 'Minutes per session',
    },
  },
} satisfies MessageBundle;
