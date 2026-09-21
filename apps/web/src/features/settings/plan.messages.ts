import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of /settings/plan ("Plan settings"). Namespace = file base name (`plan`), collected by the `*.messages.ts` glob in
 * lib/i18n.ts, so nothing outside this file registers it. Generic failures (offline, server, ...) live in
 * lib/problem.messages.ts and are shown through describeProblem, never worded here. Kazakh text still needs a native-speaker
 * review.
 *
 * - Option labels are keyed by the contract's enum values (`goals.<goal>`, `equipment.options.<value>`, `space.options.<value>`,
 *   `partner.options.true|false`); the LIST of choices always comes from GET /api/onboarding/:sport, these are only its words.
 *   The wording matches the onboarding steps (profile-step / conditions-step).
 * - `success.tracks` names the skill-graph root tracks and `success.reason` the reason keys the planner writes into a focus
 *   item (`goal`, `weakest`), as in roadmap.messages.ts. A value it has no words for is shown as the server sent it.
 * - No plural keys: the day count is a bare number under its legend and minutes are "{{value}} min", so no Russian or Kazakh
 *   plural form is needed.
 * - The player is only ever measured against themselves; nothing here promises a professional career (PRODUCT.md).
 */
export default {
  kk: {
    eyebrow: 'Баптаулар',
    title: 'Жоспар баптаулары',
    lead: 'Не бар екенін және қаншалықты жиі жаттығатыныңды өзгерт. Жоспарды соған қарай қайта құрамыз.',
    back: 'Менің жоспарым',
    loading: 'Жоспар баптауларын жүктеп жатырмыз',
    error: {
      title: 'Жоспар баптауларын жүктей алмадық',
      retry: 'Қайталау',
    },
    empty: {
      title: 'Жоспар әлі жоқ',
      hint: 'Бірнеше сұраққа жауап беріп, алғашқы дағды тесттерін орында. Содан кейін жоспарыңды осында өзгерте аласың.',
      action: 'Жоспарымды баптау',
    },
    goal: { legend: 'Басты мақсат' },
    goals: {
      control: 'Допты сенімді ұстау',
      dribbling: 'Дриблингті жақсарту',
      passing: 'Пас және допты алғаш қабылдау',
      weakfoot: 'Әлсіз аяқты жаттықтыру',
      coordination: 'Үйлесімділік',
    },
    equipment: {
      legend: 'Сенде не бар?',
      options: {
        nothing: 'Ештеңе жоқ',
        ball: 'Тек доп',
        ball_wall: 'Доп + қабырға',
        cones: 'Конустар',
        full_field: 'Толық алаң',
      },
    },
    space: {
      legend: 'Қайда жаттығасың?',
      options: {
        home_3x3: 'Үйде 3×3 м',
        yard: 'Аула',
        field: 'Алаң',
        gym: 'Жаттығу залы',
      },
    },
    partner: {
      legend: 'Бірге жаттығатын адам бар ма?',
      options: { true: 'Иә', false: 'Жоқ' },
    },
    daysPerWeek: { legend: 'Аптасына неше күн' },
    minutesPerSession: { legend: 'Бір жаттығу неше минут', value: '{{value}} мин' },
    save: {
      submit: 'Өзгерістерді сақтау',
      unchanged: 'Сақтау үшін бірдеңені өзгерт.',
    },
    saveError: {
      title: 'Жоспарды сақтай алмадық',
      hint: 'Таңдауларың орнында тұр. «Өзгерістерді сақтау» түймесін қайта бас.',
    },
    success: {
      title: 'Жоспар жаңартылды',
      lead: 'Жоспарың қайта құрылды. Енді мына дағдыларға назар аудар.',
      saved: 'Таңдауларың сақталды.',
      listLabel: 'Назардағы дағдылар',
      change: 'Деңгей {{from}} → {{to}}',
      hold: 'Деңгей {{level}}: осы деңгейді сақта',
      start: 'Бүгінгі жаттығуды ашу',
      reason: {
        goal: 'Бұл сен мақсат етіп таңдаған дағды.',
        weakest: 'Дамуға жақсы орын: осындағы кішкентай қадам көбірек көмектеседі.',
      },
      tracks: {
        'ball-mastery': 'Допты меңгеру',
        dribbling: 'Дриблинг',
        'passing-first-touch': 'Пас және допты алғаш қабылдау',
        'weak-foot': 'Әлсіз аяқ',
        'juggling-coordination': 'Жонглёрлау және үйлесімділік',
      },
    },
    reset: {
      title: 'Бастапқы тесттерді қайта тапсыру',
      hint: 'Қазір қай деңгейде екеніңді білу үшін дағды тесттерін қайтадан орында. Қазіргі жоспарың өшіріледі, жаңасын аласың. Бұрынғы нәтижелерің қалады.',
      open: 'Бастапқы тесттерді қайта тапсыру',
      dialog: {
        title: 'Бастапқы тесттерді қайта тапсырасың ба?',
        body: 'Қазіргі жоспарың мен бүгінгі аяқталмаған жаттығуың өшіріледі. Бұрынғы тест нәтижелерің мен тарихың қалады. Сосын бастапқы тесттерді қайта орындап, жаңа жоспар аласың.',
        confirm: 'Иә, қайта тапсырамын',
        cancel: 'Жоспарым қала берсін',
      },
      error: {
        title: 'Жоспарды өшіре алмадық',
        hint: 'Қайталау үшін «Иә, қайта тапсырамын» түймесін бас.',
      },
    },
  },
  ru: {
    eyebrow: 'Настройки',
    title: 'Настройки плана',
    lead: 'Измени, что у тебя есть и как часто ты тренируешься. Мы перестроим план под это.',
    back: 'Мой план',
    loading: 'Загружаем настройки плана',
    error: {
      title: 'Не удалось загрузить настройки плана',
      retry: 'Повторить',
    },
    empty: {
      title: 'Плана пока нет',
      hint: 'Ответь на несколько вопросов и сделай первые тесты навыков. После этого ты сможешь менять план здесь.',
      action: 'Настроить мой план',
    },
    goal: { legend: 'Главная цель' },
    goals: {
      control: 'Увереннее контролировать мяч',
      dribbling: 'Улучшить дриблинг',
      passing: 'Пас и первый приём',
      weakfoot: 'Подтянуть слабую ногу',
      coordination: 'Координация',
    },
    equipment: {
      legend: 'Что у тебя есть?',
      options: {
        nothing: 'Ничего',
        ball: 'Только мяч',
        ball_wall: 'Мяч + стена',
        cones: 'Конусы',
        full_field: 'Полное поле',
      },
    },
    space: {
      legend: 'Где ты будешь тренироваться?',
      options: {
        home_3x3: 'Дома 3×3 м',
        yard: 'Двор',
        field: 'Поле',
        gym: 'Спортзал',
      },
    },
    partner: {
      legend: 'Есть с кем тренироваться?',
      options: { true: 'Да', false: 'Нет' },
    },
    daysPerWeek: { legend: 'Дней в неделю' },
    minutesPerSession: { legend: 'Минут за одну тренировку', value: '{{value}} мин' },
    save: {
      submit: 'Сохранить изменения',
      unchanged: 'Измени что-нибудь, чтобы сохранить.',
    },
    saveError: {
      title: 'Не удалось сохранить план',
      hint: 'Твой выбор остался на месте. Нажми «Сохранить изменения» ещё раз.',
    },
    success: {
      title: 'План обновлён',
      lead: 'Твой план перестроен. Вот на чём сосредоточиться теперь.',
      saved: 'Твой выбор сохранён.',
      listLabel: 'Навыки в фокусе',
      change: 'Уровень {{from}} → {{to}}',
      hold: 'Уровень {{level}}: удерживай его',
      start: 'Открыть тренировку на сегодня',
      reason: {
        goal: 'Этот навык ты выбрал своей целью.',
        weakest: 'Хорошее место для роста: маленький шаг здесь даст больше всего.',
      },
      tracks: {
        'ball-mastery': 'Владение мячом',
        dribbling: 'Дриблинг',
        'passing-first-touch': 'Пас и первый приём',
        'weak-foot': 'Слабая нога',
        'juggling-coordination': 'Жонглирование и координация',
      },
    },
    reset: {
      title: 'Пройти базовые тесты заново',
      hint: 'Сделай тесты навыков ещё раз, чтобы увидеть, где ты сейчас. Текущий план будет удалён, и ты получишь новый. Прошлые результаты останутся.',
      open: 'Пройти базовые тесты заново',
      dialog: {
        title: 'Пройти базовые тесты заново?',
        body: 'Твой текущий план и незавершённая тренировка на сегодня будут удалены. Прошлые результаты тестов и история останутся. Потом ты снова пройдёшь базовые тесты и получишь новый план.',
        confirm: 'Да, пройти заново',
        cancel: 'Оставить мой план',
      },
      error: {
        title: 'Не удалось удалить план',
        hint: 'Чтобы повторить, нажми «Да, пройти заново».',
      },
    },
  },
  en: {
    eyebrow: 'Settings',
    title: 'Plan settings',
    lead: 'Change what you have and how often you train. We rebuild your plan around it.',
    back: 'My roadmap',
    loading: 'Loading your plan settings',
    error: {
      title: 'We could not load your plan settings',
      retry: 'Try again',
    },
    empty: {
      title: 'No plan yet',
      hint: 'Answer a few questions and take the first skill tests. Then you can change your plan here.',
      action: 'Set up my plan',
    },
    goal: { legend: 'Main goal' },
    goals: {
      control: 'Control the ball with confidence',
      dribbling: 'Improve dribbling',
      passing: 'Passing and first touch',
      weakfoot: 'Improve my weaker foot',
      coordination: 'Coordination',
    },
    equipment: {
      legend: 'What do you have?',
      options: {
        nothing: 'Nothing',
        ball: 'Ball only',
        ball_wall: 'Ball + wall',
        cones: 'Cones',
        full_field: 'Full field',
      },
    },
    space: {
      legend: 'Where will you train?',
      options: {
        home_3x3: 'Home 3×3 m',
        yard: 'Yard',
        field: 'Field',
        gym: 'Gym',
      },
    },
    partner: {
      legend: 'Is there someone to train with?',
      options: { true: 'Yes', false: 'No' },
    },
    daysPerWeek: { legend: 'Days per week' },
    minutesPerSession: { legend: 'Minutes per session', value: '{{value}} min' },
    save: {
      submit: 'Save changes',
      unchanged: 'Change something to save.',
    },
    saveError: {
      title: 'We could not save your plan',
      hint: 'Your choices are still here. Press "Save changes" again.',
    },
    success: {
      title: 'Plan updated',
      lead: 'Your plan is rebuilt. This is what you focus on now.',
      saved: 'Your choices are saved.',
      listLabel: 'Focus skills',
      change: 'Level {{from}} → {{to}}',
      hold: 'Level {{level}}: keep it steady',
      start: "Open today's training",
      reason: {
        goal: 'This is the skill you chose as your goal.',
        weakest: 'A good place to grow: a small step here helps the most.',
      },
      tracks: {
        'ball-mastery': 'Ball mastery',
        dribbling: 'Dribbling',
        'passing-first-touch': 'Passing and first touch',
        'weak-foot': 'Weaker foot',
        'juggling-coordination': 'Juggling and coordination',
      },
    },
    reset: {
      title: 'Redo baseline',
      hint: 'Take the skill tests again to see where you are now. Your current plan is cleared and you get a new one. Your earlier results stay.',
      open: 'Redo baseline',
      dialog: {
        title: 'Redo your baseline?',
        body: "This clears your current plan and today's unfinished training. Your earlier test results and history stay. You then take the baseline tests again and get a new plan.",
        confirm: 'Yes, redo baseline',
        cancel: 'Keep my plan',
      },
      error: {
        title: 'We could not reset your plan',
        hint: 'Press "Yes, redo baseline" to try again.',
      },
    },
  },
} satisfies MessageBundle;
