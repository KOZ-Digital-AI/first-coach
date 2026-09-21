import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the video analysis result screen (/video/result/:id). Namespace = file base name (`result`), collected by the
 * `*.messages.ts` glob in lib/i18n.ts. Generic failures (offline, server, ...) live in lib/problem.messages.ts and are shown
 * through describeProblem, never worded here.
 *
 * Placeholders: {{level}} (a confidence word), {{sessions}} (a number), {{skill}} (a skill name from this file).
 * The "x / 10" of a criterion is a number pair, formatted in code with Intl, not a translatable string.
 * Tone (PRODUCT.md): the player is compared with their own earlier analyses only; nothing here scolds, ranks, hypes or promises
 * a future, and there is no wording of an overall score anywhere (the API has none). The pose-only limitation line is the
 * required sentence in English. Kazakh text still needs a native-speaker review.
 */
export default {
  kk: {
    title: 'Сенің талдауың',
    beta: 'Бета',
    back: 'Бейне бапкер',
    loading: 'Талдауыңды жүктеп жатырмыз',
    skill: 'Дағды: {{skill}}',
    skills: {
      'ball-mastery': 'Допты меңгеру',
      dribbling: 'Дриблинг',
      'passing-first-touch': 'Пас және алғашқы жанасу',
      'weak-foot': 'Әлсіз аяқ',
      'juggling-coordination': 'Жонглерлеу және үйлесім',
    },
    analysedOn: 'Талдау күні:',
    limitation: 'Тек дене қалпы — доп әзірге бақыланбайды',
    confidence: 'Қаншалықты сенімдіміз: {{level}}',
    levels: { low: 'төмен', medium: 'орташа', high: 'жоғары' },
    criteria: {
      title: 'Бөлшектеп қарау',
      lead: '1-ден 10-ға дейінгі баға бүгінгі деңгейіңді көрсетеді.',
    },
    focus: 'Келесі назар',
    drills: {
      title: 'Келесі ұсыныс',
      hint: 'Жаттығуды ашып, оны бүгінгі сабаққа қос.',
    },
    repeat: '{{sessions}} жаттығудан кейін бағалауды қайтала',
    limits: 'Білу пайдалы',
    history: {
      title: 'Осы дағдының бұрынғы талдаулары',
      lead: 'Тек өзіңмен салыстыру үшін. Кішкентай қадамдарды іздеп көр.',
      none: 'Бұл осы дағдыдан алғашқы талдауың. Келесі жолы соған салыстыра аласың.',
    },
    again: 'Тағы бір бейнені талдау',
    rerecord: {
      lead: 'Бұл жолы баға қойылмады. Анығырақ бейне дәлірек кеңес береді.',
      low_visibility: {
        title: 'Сені жеткілікті көре алмадық',
        hint: 'Бүкіл денең көрінетіндей, жарық жерде тұр да, қайта түсір.',
      },
      too_dark: {
        title: 'Бейне тым қараңғы болды',
        hint: 'Жарығырақ жерде, жарық алдыңнан түсетіндей етіп түсір.',
      },
      too_short: {
        title: 'Бейне бағалау үшін тым қысқа болды',
        hint: 'Жаттығуды тоқтамай 10-нан 30 секундқа дейін түсір.',
      },
      action: 'Қайта түсіру',
    },
    tips: {
      title: 'Қалай түсіру керек',
      loading: 'Түсіру кеңестерін жүктеп жатырмыз',
      error: {
        title: 'Түсіру кеңестерін жүктей алмадық',
        retry: 'Қайталап көру',
      },
    },
    empty: {
      none: {
        title: 'Әзірге талдау жоқ',
        hint: 'Қысқа бейне түсір, алғашқы талдауың осында пайда болады.',
        action: 'Бейнені талдау',
      },
      unknown: {
        title: 'Бұл талдауды таба алмадық',
        hint: 'Сілтеме қате болуы мүмкін. Жаңа бейнені кез келген уақытта түсіре аласың.',
        action: 'Бейне бапкерге өту',
      },
    },
    error: {
      title: 'Талдауыңды жүктей алмадық',
      retry: 'Қайталап көру',
    },
    disabled: {
      title: 'Бейне бапкер өшірулі',
      hint: 'Қазір ол қолжетімсіз. Жаттығуың бұрынғыдай жұмыс істейді.',
      action: 'Жаттығуға оралу',
    },
  },
  ru: {
    title: 'Твой разбор',
    beta: 'Бета',
    back: 'Видео-тренер',
    loading: 'Загружаем твой разбор',
    skill: 'Навык: {{skill}}',
    skills: {
      'ball-mastery': 'Владение мячом',
      dribbling: 'Дриблинг',
      'passing-first-touch': 'Пас и первый приём',
      'weak-foot': 'Слабая нога',
      'juggling-coordination': 'Жонглирование и координация',
    },
    analysedOn: 'Дата разбора:',
    limitation: 'Только поза — мяч пока не отслеживается',
    confidence: 'Насколько мы уверены: {{level}}',
    levels: { low: 'низко', medium: 'средне', high: 'высоко' },
    criteria: {
      title: 'По частям',
      lead: 'Оценка от 1 до 10 показывает, где ты сейчас.',
    },
    focus: 'На что обратить внимание',
    drills: {
      title: 'Что попробовать дальше',
      hint: 'Открой упражнение и добавь его в сегодняшнюю тренировку.',
    },
    repeat: 'Повтори оценку через {{sessions}} тренировки',
    limits: 'Полезно знать',
    history: {
      title: 'Твои прошлые разборы этого навыка',
      lead: 'Только чтобы сравнивать себя с собой. Ищи маленькие шаги вперёд.',
      none: 'Это твой первый разбор этого навыка. В следующий раз сможешь сравнить с ним.',
    },
    again: 'Разобрать ещё одно видео',
    rerecord: {
      lead: 'На этот раз оценки нет. Более чёткое видео даст более точный совет.',
      low_visibility: {
        title: 'Мы плохо тебя видели',
        hint: 'Встань так, чтобы всё тело было в кадре, при хорошем свете, и сними ещё раз.',
      },
      too_dark: {
        title: 'Видео получилось слишком тёмным',
        hint: 'Снимай там, где светлее, чтобы свет был перед тобой.',
      },
      too_short: {
        title: 'Видео слишком короткое для разбора',
        hint: 'Сними от 10 до 30 секунд упражнения без остановки.',
      },
      action: 'Снять ещё раз',
    },
    tips: {
      title: 'Как снимать',
      loading: 'Загружаем советы по съёмке',
      error: {
        title: 'Не удалось загрузить советы по съёмке',
        retry: 'Повторить',
      },
    },
    empty: {
      none: {
        title: 'Разборов пока нет',
        hint: 'Сними короткое видео, и твой первый разбор появится здесь.',
        action: 'Разобрать видео',
      },
      unknown: {
        title: 'Мы не нашли этот разбор',
        hint: 'Возможно, ссылка неверная. Новое видео можно снять в любой момент.',
        action: 'Открыть видео-тренера',
      },
    },
    error: {
      title: 'Не удалось загрузить твой разбор',
      retry: 'Повторить',
    },
    disabled: {
      title: 'Видео-тренер выключен',
      hint: 'Сейчас он недоступен. Тренировки работают как обычно.',
      action: 'Назад к тренировке',
    },
  },
  en: {
    title: 'Your analysis',
    beta: 'Beta',
    back: 'Video Coach',
    loading: 'Loading your analysis',
    skill: 'Skill: {{skill}}',
    skills: {
      'ball-mastery': 'Ball mastery',
      dribbling: 'Dribbling',
      'passing-first-touch': 'Passing and first touch',
      'weak-foot': 'Weaker foot',
      'juggling-coordination': 'Juggling and coordination',
    },
    analysedOn: 'Analysed on',
    limitation: 'Pose only — the ball is not tracked yet',
    confidence: 'Confidence: {{level}}',
    levels: { low: 'Low', medium: 'Medium', high: 'High' },
    criteria: {
      title: 'Part by part',
      lead: 'Each score from 1 to 10 shows where you are today.',
    },
    focus: 'Focus next',
    drills: {
      title: 'Recommended next',
      hint: "Open a drill and add it to today's session.",
    },
    repeat: 'Repeat assessment after {{sessions}} sessions',
    limits: 'Good to know',
    history: {
      title: 'Your earlier analyses of this skill',
      lead: 'Only for comparing with yourself. Look for small steps forward.',
      none: 'This is your first analysis of this skill. Next time you can compare with it.',
    },
    again: 'Analyse another clip',
    rerecord: {
      lead: 'There is no score this time. A clearer clip gives a better tip.',
      low_visibility: {
        title: 'We could not see you well enough',
        hint: 'Stand so your whole body is in the picture, in good light, then film again.',
      },
      too_dark: {
        title: 'The clip was too dark',
        hint: 'Film where it is brighter, with the light in front of you.',
      },
      too_short: {
        title: 'The clip was too short to judge',
        hint: 'Film 10 to 30 seconds of the drill without stopping.',
      },
      action: 'Film again',
    },
    tips: {
      title: 'How to film',
      loading: 'Loading the filming tips',
      error: {
        title: 'We could not load the filming tips',
        retry: 'Try again',
      },
    },
    empty: {
      none: {
        title: 'No analyses yet',
        hint: 'Film a short clip and your first analysis will be here.',
        action: 'Analyse a clip',
      },
      unknown: {
        title: 'We cannot find this analysis',
        hint: 'The link may be wrong. You can film a new clip at any time.',
        action: 'Open Video Coach',
      },
    },
    error: {
      title: 'We could not load your analysis',
      retry: 'Try again',
    },
    disabled: {
      title: 'Video Coach is switched off',
      hint: 'It is not available right now. Your training works as always.',
      action: 'Back to training',
    },
  },
} satisfies MessageBundle;
