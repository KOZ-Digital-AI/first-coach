import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the drill player (/train/drill/:itemId). Namespace = file base name (`drill-player`), collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it.
 * Numbers arrive already formatted for the language ({{n}}, {{total}}, {{minutes}}, {{seconds}}, {{min}}, {{max}}, {{value}}).
 * Wording avoids plural forms on purpose (label: value pairs, "Reps: 20"), so one phrase per language is enough.
 * `needs.equipment` is keyed by the contract's Equipment values and `needs.spaces` by its Space values; `swap.none` by the swap
 * direction that was asked (easier | harder).
 * Kazakh text still needs a native review.
 */
export default {
  kk: {
    back: 'Бүгінгі жаттығулар',
    toSession: 'Бүгінгі жаттығуларға оралу',
    position: 'Жаттығу {{n}} / {{total}}',
    minutes: '{{minutes}} мин',
    state: {
      done: 'Орындалды',
      todo: 'Әлі орындалмады',
    },
    loading: 'Жаттығу жүктелуде…',
    loadError: {
      title: 'Жаттығуды жүктеу мүмкін болмады',
    },
    retry: 'Қайталау',
    redirecting: 'Алдымен жоспарыңды құрайық…',
    notFound: {
      title: 'Бұл жаттығу бүгінгі жоспарда жоқ',
      hint: 'Жаттығуды бүгінгі тізімнен аш.',
    },
    offline: 'Байланыс жоқ. Жаттығу соңғы сақталған жоспардан көрсетілді. Сақтау үшін байланыс керек.',
    safety: {
      label: 'Қауіпсіздік',
      title: 'Алдымен қауіпсіздік',
    },
    video: {
      play: 'Бейнені ойнату',
      offline: 'Бейне үшін интернет керек.',
      error: 'Бейне жүктелмеді. Қайталап көр.',
    },
    instructions: {
      title: 'Қалай орындау керек',
    },
    target: {
      title: 'Мақсатың',
      reps: 'Қайталау',
      sets: 'Серия',
      time: 'Уақыт',
      seconds: '{{seconds}} сек',
    },
    timer: {
      label: 'Өткен уақыт',
      start: 'Таймерді қосу',
      pause: 'Таймерді тоқтату',
      resume: 'Таймерді жалғастыру',
      reset: 'Таймерді нөлге қайтару',
      reached: 'Мақсатты уақытқа жеттің',
    },
    needs: {
      title: 'Не қажет',
      equipmentLabel: 'Құрал-жабдық',
      spaceLabel: 'Орын',
      partnerLabel: 'Серіктес',
      ageLabel: 'Жас',
      equipment: {
        nothing: 'Ештеңе қажет емес',
        ball: 'Доп',
        ball_wall: 'Доп және қабырға',
        cones: 'Конустар',
        full_field: 'Толық алаң',
      },
      spaces: {
        home_3x3: 'Үй, шамамен 3 × 3 метр',
        yard: 'Аула',
        field: 'Алаң',
        gym: 'Спортзал',
      },
      partner: {
        yes: 'Серіктеспен',
        no: 'Жалғыз',
      },
      age: {
        range: '{{min}}–{{max}} жас',
        from: '{{min}} жастан бастап',
        to: '{{max}} жасқа дейін',
      },
    },
    mistakes: {
      title: 'Жиі кететін қателер',
    },
    easier: {
      title: 'Жеңілдету',
    },
    harder: {
      title: 'Қиындату',
    },
    turn: {
      title: 'Сенің кезегің',
    },
    done: 'Дайын',
    undo: 'Болдырмау',
    saving: 'Сақталуда…',
    saved: {
      done: 'Орындалды деп белгіленді.',
      undone: 'Орындалмады деп белгіленді.',
    },
    actionError: {
      title: 'Сақтау мүмкін болмады',
    },
    result: {
      label: 'Нәтижең (міндетті емес)',
      hint: 'Сан жаз, мысалы, неше рет орындадың.',
      save: 'Нәтижені сақтау',
      saved: 'Нәтиже сақталды: {{value}}',
      errors: {
        empty: 'Санды жаз.',
        notNumber: 'Тек цифр жаз, мысалы, 12.',
        negative: 'Сан нөлден кем болмауы керек.',
      },
    },
    swap: {
      title: 'Деңгейің сәйкес емес пе?',
      hint: 'Бұл жаттығуды жеңілірегіне немесе қиынырағына ауыстыр.',
      tooHard: 'Тым қиын',
      tooEasy: 'Тым оңай',
      replaced: {
        easier: 'Жеңілірек жаттығуға ауыстырылды.',
        harder: 'Қиынырақ жаттығуға ауыстырылды.',
      },
      offline: 'Жаттығуды ауыстыру үшін интернет керек.',
      finished: 'Алдымен «Дайын» белгісін болдырма, сонда жаттығуды ауыстыра аласың.',
      none: {
        easier: 'Қазір саған жеңілірек жаттығу жоқ.',
        harder: 'Қазір саған қиынырақ жаттығу жоқ.',
      },
      error: {
        title: 'Жаттығуды ауыстыру мүмкін болмады',
      },
    },
    next: 'Келесі жаттығу',
  },
  ru: {
    back: 'Занятие на сегодня',
    toSession: 'Назад к занятию на сегодня',
    position: 'Упражнение {{n}} из {{total}}',
    minutes: '{{minutes}} мин',
    state: {
      done: 'Готово',
      todo: 'Ещё не сделано',
    },
    loading: 'Загружаем упражнение…',
    loadError: {
      title: 'Не удалось загрузить упражнение',
    },
    retry: 'Повторить',
    redirecting: 'Сначала настроим твой план…',
    notFound: {
      title: 'Этого упражнения нет в занятии на сегодня',
      hint: 'Открой упражнение из сегодняшнего списка.',
    },
    offline: 'Нет соединения. Упражнение показано из последнего сохранённого занятия. Чтобы сохранить, нужна связь.',
    safety: {
      label: 'Безопасность',
      title: 'Сначала безопасность',
    },
    video: {
      play: 'Смотреть видео',
      offline: 'Для видео нужен интернет.',
      error: 'Не удалось загрузить видео. Попробуй ещё раз.',
    },
    instructions: {
      title: 'Как выполнять',
    },
    target: {
      title: 'Твоя цель',
      reps: 'Повторения',
      sets: 'Подходы',
      time: 'Время',
      seconds: '{{seconds}} с',
    },
    timer: {
      label: 'Прошло времени',
      start: 'Запустить таймер',
      pause: 'Остановить таймер',
      resume: 'Продолжить таймер',
      reset: 'Сбросить таймер',
      reached: 'Нужное время достигнуто',
    },
    needs: {
      title: 'Что понадобится',
      equipmentLabel: 'Инвентарь',
      spaceLabel: 'Место',
      partnerLabel: 'Партнёр',
      ageLabel: 'Возраст',
      equipment: {
        nothing: 'Ничего не нужно',
        ball: 'Мяч',
        ball_wall: 'Мяч и стена',
        cones: 'Конусы',
        full_field: 'Полное поле',
      },
      spaces: {
        home_3x3: 'Дома, примерно 3 × 3 метра',
        yard: 'Двор',
        field: 'Поле',
        gym: 'Спортзал',
      },
      partner: {
        yes: 'С партнёром',
        no: 'Одному',
      },
      age: {
        range: 'От {{min}} до {{max}} лет',
        from: 'От {{min}} лет',
        to: 'До {{max}} лет',
      },
    },
    mistakes: {
      title: 'Частые ошибки',
    },
    easier: {
      title: 'Сделать проще',
    },
    harder: {
      title: 'Сделать сложнее',
    },
    turn: {
      title: 'Твой ход',
    },
    done: 'Готово',
    undo: 'Отменить',
    saving: 'Сохраняем…',
    saved: {
      done: 'Отмечено как выполненное.',
      undone: 'Отмечено как невыполненное.',
    },
    actionError: {
      title: 'Не удалось сохранить',
    },
    result: {
      label: 'Твой результат (необязательно)',
      hint: 'Число, например сколько раз ты выполнил.',
      save: 'Сохранить результат',
      saved: 'Результат сохранён: {{value}}',
      errors: {
        empty: 'Введи число.',
        notNumber: 'Только цифры, например 12.',
        negative: 'Число не может быть меньше нуля.',
      },
    },
    swap: {
      title: 'Не твой уровень?',
      hint: 'Замени это упражнение на более простое или более сложное.',
      tooHard: 'Слишком сложно',
      tooEasy: 'Слишком легко',
      replaced: {
        easier: 'Заменено на более простое упражнение.',
        harder: 'Заменено на более сложное упражнение.',
      },
      offline: 'Чтобы заменить упражнение, нужен интернет.',
      finished: 'Сначала отмени отметку «Готово», тогда упражнение можно заменить.',
      none: {
        easier: 'Сейчас для тебя нет более простого упражнения.',
        harder: 'Сейчас для тебя нет более сложного упражнения.',
      },
      error: {
        title: 'Не удалось заменить упражнение',
      },
    },
    next: 'Следующее упражнение',
  },
  en: {
    back: "Today's session",
    toSession: "Back to today's session",
    position: 'Drill {{n}} of {{total}}',
    minutes: '{{minutes}} min',
    state: {
      done: 'Done',
      todo: 'To do',
    },
    loading: 'Loading your drill…',
    loadError: {
      title: 'Could not load this drill',
    },
    retry: 'Try again',
    redirecting: 'Setting up your plan first…',
    notFound: {
      title: "This drill is not in today's session",
      hint: "Open a drill from today's list.",
    },
    offline: 'You are offline. This drill is shown from your last session. Saving needs a connection.',
    safety: {
      label: 'Safety',
      title: 'Safety first',
    },
    video: {
      play: 'Play video',
      offline: 'Video needs an internet connection.',
      error: 'The video could not be loaded. Try again.',
    },
    instructions: {
      title: 'How to do it',
    },
    target: {
      title: 'Your target',
      reps: 'Reps',
      sets: 'Sets',
      time: 'Time',
      seconds: '{{seconds}} s',
    },
    timer: {
      label: 'Time so far',
      start: 'Start timer',
      pause: 'Pause timer',
      resume: 'Resume timer',
      reset: 'Reset timer',
      reached: 'Target time reached',
    },
    needs: {
      title: 'What you need',
      equipmentLabel: 'Equipment',
      spaceLabel: 'Space',
      partnerLabel: 'Partner',
      ageLabel: 'Age',
      equipment: {
        nothing: 'No equipment',
        ball: 'A ball',
        ball_wall: 'A ball and a wall',
        cones: 'Cones',
        full_field: 'A full pitch',
      },
      spaces: {
        home_3x3: 'Home, about 3 by 3 metres',
        yard: 'Yard',
        field: 'Field',
        gym: 'Gym',
      },
      partner: {
        yes: 'With a partner',
        no: 'On your own',
      },
      age: {
        range: 'Ages {{min}} to {{max}}',
        from: 'From age {{min}}',
        to: 'Up to age {{max}}',
      },
    },
    mistakes: {
      title: 'Common mistakes',
    },
    easier: {
      title: 'Make it easier',
    },
    harder: {
      title: 'Make it harder',
    },
    turn: {
      title: 'Your turn',
    },
    done: 'Done',
    undo: 'Undo',
    saving: 'Saving…',
    saved: {
      done: 'Marked as done.',
      undone: 'Marked as not done.',
    },
    actionError: {
      title: 'Could not save that',
    },
    result: {
      label: 'Your result (optional)',
      hint: 'A number, for example how many times you did it.',
      save: 'Save result',
      saved: 'Result saved: {{value}}',
      errors: {
        empty: 'Type a number.',
        notNumber: 'Use digits only, for example 12.',
        negative: 'The number cannot be below zero.',
      },
    },
    swap: {
      title: 'Not the right level?',
      hint: 'Swap this drill for an easier or a harder one.',
      tooHard: 'Too hard',
      tooEasy: 'Too easy',
      replaced: {
        easier: 'Swapped for an easier drill.',
        harder: 'Swapped for a harder drill.',
      },
      offline: 'Swapping a drill needs an internet connection.',
      finished: 'Undo "Done" first, then you can swap this drill.',
      none: {
        easier: 'There is no easier drill for you right now.',
        harder: 'There is no harder drill for you right now.',
      },
      error: {
        title: 'Could not swap the drill',
      },
    },
    next: 'Next drill',
  },
} satisfies MessageBundle;
