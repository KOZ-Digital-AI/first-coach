import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of /train/roadmap ("My roadmap"). Namespace = file base name (`roadmap`), collected by the `*.messages.ts` glob in
 * lib/i18n.ts. Kazakh text still needs a native review.
 *
 * - `levels` is keyed by the label the planner writes into `currentLevelLabel` (Foundation, Basic, Intermediate, Advanced) and
 *   `focus.reason` by the reason keys it writes into a focus item (`goal`, `weakest`): the contract types both as free
 *   strings, the planner sends these keys and leaves the words to the client. A value that is not one of them is shown as the
 *   server sent it.
 * - `tracks` names the five skill-graph root tracks. The roadmap carries only their slug; any other slug is shown humanised.
 * - `goals` is keyed by the contract's Goal enum, like `profile-step.messages.ts` (same wording).
 * - `plan.weeks` and `plan.sessions` are plural keys ({{count}}); the screen joins the three parts with " · ". `minutes` is
 *   not a plural key ({{minutes}}): a Russian or Kazakh abbreviation ("мин") never changes with the number.
 * - Nothing here promises a professional career (PRODUCT.md): progress is measured against the player's own last time.
 */
export default {
  kk: {
    eyebrow: 'FIRST COACH / Футбол',
    title: 'Менің жоспарым',
    loading: 'Жоспарыңызды жүктеп жатырмыз…',
    retry: 'Қайталау',
    levelNow: 'Қазіргі деңгейіңіз',
    levels: {
      Foundation: 'Бастапқы',
      Basic: 'Негізгі',
      Intermediate: 'Орта',
      Advanced: 'Жоғары',
    },
    goalLabel: 'Мақсатыңыз',
    goals: {
      control: 'Допты сенімді ұстау',
      dribbling: 'Дриблингті жақсарту',
      passing: 'Пас және допты алғаш қабылдау',
      weakfoot: 'Әлсіз аяқты жаттықтыру',
      coordination: 'Үйлесімділік',
    },
    plan: {
      weeks_one: '{{count}} апта',
      weeks_other: '{{count}} апта',
      sessions_one: 'аптасына {{count}} жаттығу',
      sessions_other: 'аптасына {{count}} жаттығу',
      minutes: 'әр жаттығу {{minutes}} мин',
    },
    start: 'Бүгінгі жаттығуды ашу',
    focus: {
      title: 'Назар аударатын дағдылар',
      lead: 'Кішкентай қадамдар. Тек өзіңіздің алдыңғы нәтижеңізбен салыстырамыз.',
      listLabel: 'Назардағы дағдылар',
      change: 'Деңгей {{from}} → {{to}}',
      changeSr: '{{from}}-деңгейден {{to}}-деңгейге',
      hold: 'Деңгей {{level}}: осы деңгейді сақтаңыз',
      reason: {
        goal: 'Бұл сіз мақсат етіп таңдаған дағды.',
        weakest: 'Дамуға жақсы орын: осындағы кішкентай қадам көбірек көмектеседі.',
      },
      empty: {
        title: 'Назардағы дағды әзірге жоқ',
        hint: 'Баптау сұрақтарына қайта жауап беріңіз, біз жоспар құрамыз.',
        action: 'Жауаптарды жаңарту',
      },
    },
    skills: {
      title: 'Дағдыларыңыздың деңгейі',
      listLabel: 'Дағдылар деңгейі',
      level: 'Деңгей {{level}} / {{max}}',
      source: {
        test: 'Сынақ нәтижесі бойынша',
        self: 'Өз бағаңыз',
      },
      empty: {
        title: 'Деңгейлер әзірге жоқ',
        hint: 'Жоспарда болған кезде осында көрінеді.',
      },
    },
    tracks: {
      'ball-mastery': 'Допты меңгеру',
      dribbling: 'Дриблинг',
      'passing-first-touch': 'Пас және допты алғаш қабылдау',
      'weak-foot': 'Әлсіз аяқ',
      'juggling-coordination': 'Жонглёрлау және үйлесімділік',
    },
    notOnboarded: {
      title: 'Баптауға өтіп жатырмыз…',
      action: 'Жоспарымды баптау',
    },
    error: { title: 'Жоспарды жүктей алмадық' },
    stale: {
      title: 'Соңғы сақталған жоспар көрсетіліп тұр',
      hint: 'Қазір жаңарта алмадық.',
    },
  },
  ru: {
    eyebrow: 'FIRST COACH / Футбол',
    title: 'Мой план',
    loading: 'Загружаем ваш план…',
    retry: 'Повторить',
    levelNow: 'Ваш уровень сейчас',
    levels: {
      Foundation: 'Начальный',
      Basic: 'Базовый',
      Intermediate: 'Средний',
      Advanced: 'Продвинутый',
    },
    goalLabel: 'Ваша цель',
    goals: {
      control: 'Увереннее контролировать мяч',
      dribbling: 'Улучшить дриблинг',
      passing: 'Пас и первый приём',
      weakfoot: 'Подтянуть слабую ногу',
      coordination: 'Координация',
    },
    plan: {
      weeks_one: '{{count}} неделя',
      weeks_few: '{{count}} недели',
      weeks_many: '{{count}} недель',
      weeks_other: '{{count}} недели',
      sessions_one: '{{count}} занятие в неделю',
      sessions_few: '{{count}} занятия в неделю',
      sessions_many: '{{count}} занятий в неделю',
      sessions_other: '{{count}} занятия в неделю',
      minutes: '{{minutes}} мин на занятие',
    },
    start: 'Открыть тренировку на сегодня',
    focus: {
      title: 'На чём сосредоточиться',
      lead: 'Маленькие шаги. Мы сравниваем только с вашим прошлым результатом.',
      listLabel: 'Навыки в фокусе',
      change: 'Уровень {{from}} → {{to}}',
      changeSr: 'С уровня {{from}} на уровень {{to}}',
      hold: 'Уровень {{level}}: удерживайте его',
      reason: {
        goal: 'Этот навык вы выбрали своей целью.',
        weakest: 'Хорошее место для роста: маленький шаг здесь даст больше всего.',
      },
      empty: {
        title: 'Пока нет навыков в фокусе',
        hint: 'Ответьте на вопросы настройки ещё раз, и мы построим план.',
        action: 'Обновить ответы',
      },
    },
    skills: {
      title: 'Уровни ваших навыков',
      listLabel: 'Уровни навыков',
      level: 'Уровень {{level}} / {{max}}',
      source: {
        test: 'По результату теста',
        self: 'Ваша собственная оценка',
      },
      empty: {
        title: 'Уровней пока нет',
        hint: 'Они появятся здесь, когда будут в плане.',
      },
    },
    tracks: {
      'ball-mastery': 'Владение мячом',
      dribbling: 'Дриблинг',
      'passing-first-touch': 'Пас и первый приём',
      'weak-foot': 'Слабая нога',
      'juggling-coordination': 'Жонглирование и координация',
    },
    notOnboarded: {
      title: 'Открываем настройку…',
      action: 'Настроить мой план',
    },
    error: { title: 'Не удалось загрузить план' },
    stale: {
      title: 'Показан последний сохранённый план',
      hint: 'Обновить его сейчас не получилось.',
    },
  },
  en: {
    eyebrow: 'FIRST COACH / Football',
    title: 'My roadmap',
    loading: 'Loading your roadmap…',
    retry: 'Try again',
    levelNow: 'Your level now',
    levels: {
      Foundation: 'Foundation',
      Basic: 'Basic',
      Intermediate: 'Intermediate',
      Advanced: 'Advanced',
    },
    goalLabel: 'Your goal',
    goals: {
      control: 'Control the ball with confidence',
      dribbling: 'Improve dribbling',
      passing: 'Passing and first touch',
      weakfoot: 'Improve my weaker foot',
      coordination: 'Coordination',
    },
    plan: {
      weeks_one: '{{count}} week',
      weeks_other: '{{count}} weeks',
      sessions_one: '{{count}} session/week',
      sessions_other: '{{count}} sessions/week',
      minutes: '{{minutes}} min/session',
    },
    start: "Open today's training",
    focus: {
      title: 'Your focus skills',
      lead: 'Small steps, compared only with your own last time.',
      listLabel: 'Focus skills',
      change: 'Level {{from}} → {{to}}',
      changeSr: 'From level {{from}} to level {{to}}',
      hold: 'Level {{level}}: keep it steady',
      reason: {
        goal: 'This is the skill you chose as your goal.',
        weakest: 'A good place to grow: a small step here helps the most.',
      },
      empty: {
        title: 'No focus skills yet',
        hint: 'Answer the setup questions again and we will build your plan.',
        action: 'Update my answers',
      },
    },
    skills: {
      title: 'Your skill levels',
      listLabel: 'Skill levels',
      level: 'Level {{level}} / {{max}}',
      source: {
        test: 'From your skill test',
        self: 'Your own estimate',
      },
      empty: {
        title: 'No skill levels yet',
        hint: 'They will appear here once your plan has them.',
      },
    },
    tracks: {
      'ball-mastery': 'Ball mastery',
      dribbling: 'Dribbling',
      'passing-first-touch': 'Passing and first touch',
      'weak-foot': 'Weaker foot',
      'juggling-coordination': 'Juggling and coordination',
    },
    notOnboarded: {
      title: 'Taking you to the setup…',
      action: 'Set up my plan',
    },
    error: { title: "We couldn't load your roadmap" },
    stale: {
      title: 'Showing your last saved roadmap',
      hint: "We couldn't refresh it just now.",
    },
  },
} satisfies MessageBundle;
