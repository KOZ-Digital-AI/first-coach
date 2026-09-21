import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of /video, the Beta AI Video Coach capture screen (routes/video/index.tsx). Namespace = file base name (`capture`),
 * collected by the `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it. Generic failures (offline,
 * server, ...) come from lib/problem.messages.ts through describeProblem, never worded here. The Kazakh and Russian text still
 * needs a native-speaker review (bead fc-cjh).
 *
 * Plain language on purpose (PRODUCT.md): a 10-year-old and a parent should both follow it; "you" is the child. It says only
 * what the product does (contract: apps/api/src/shared/video.ts): the video never leaves the device; small pictures with the
 * face blurred and movement numbers are sent; those pictures are seen by an AI provider; it is a beta and it never ranks a
 * player against others (there is no overall score, only per-criterion scores of one clip).
 *
 * - `skills.<slug>.option` is the whole button sentence ("Analyse my dribbling") because the grammar of kk and ru does not
 *   allow a name to be dropped into a template; `name` is the short name used in "Skill: Dribbling".
 * - `gate.*` is the consent step: what stays on the phone, what is sent, and what to do in the privacy settings.
 * - `rerecord.<reason>` is keyed by the contract's RERECORD_REASONS (low_visibility | too_dark | too_short).
 * - `result.levels` is keyed by the contract's Confidence (low | medium | high); no plurals are needed (the numbers sit in
 *   {{seconds}} / {{sessions}} / {{n}} placeholders beside the words).
 */
export default {
  kk: {
    eyebrow: 'Бейне бапкер · Бета',
    title: 'Қысқа бейне түсір',
    lead: 'Бір дағың туралы кеңес алу үшін 10–30 секундтық бейне түсір. Бұл міндетті емес: жаттығуың онсыз да жұмыс істейді.',
    optional: {
      text: 'Бейне бапкер міндетті емес. Жаттығуың онсыз да жұмыс істейді.',
      back: 'Жаттығуға оралу',
    },
    skills: {
      title: 'Дағды таңда',
      hint: 'Қай дағыңды талдағың келеді?',
      chosen: 'Дағды: {{skill}}',
      change: 'Дағдыны өзгерту',
      'ball-mastery': { option: 'Допты меңгеруімді талда', name: 'Допты меңгеру' },
      dribbling: { option: 'Дриблингімді талда', name: 'Дриблинг' },
      'passing-first-touch': { option: 'Пасым мен допты алғаш қабылдауымды талда', name: 'Пас және допты алғаш қабылдау' },
      'weak-foot': { option: 'Әлсіз аяғымды талда', name: 'Әлсіз аяқ' },
      'juggling-coordination': { option: 'Жонглёрлауымды талда', name: 'Жонглёрлау және үйлесімділік' },
    },
    unavailable: {
      title: 'Бейне бапкер интернетсіз қолжетімсіз',
      hint: 'Қолдану үшін интернетке қосыл. Жаттығуың интернетсіз де жұмыс істейді.',
    },
    unsupported: {
      title: 'Бұл құрылғы талдауды іске қоса алмайды',
      hint: 'Бейне бапкерге жаңарақ браузер немесе телефон керек. Жаттығуың бұрынғыдай жұмыс істейді.',
    },
    disabled: {
      title: 'Бейне бапкер өшірулі',
      hint: 'Қазір ол қолжетімсіз. Жаттығуың бұрынғыдай жұмыс істейді.',
    },
    gate: {
      title: 'Бастамас бұрын',
      deviceTitle: 'Телефоныңда қалады',
      device: {
        video: 'Бейнең. Ол ешқашан жүктелмейді және біз бітіргенде жадтан өшіріледі.',
        reading: 'Қозғалысыңды оқу. Қол мен аяғыңның қайда екенін телефоның өзі табады.',
      },
      sentTitle: 'Кеңес алу үшін жіберіледі',
      sent: {
        pictures: 'Бірнеше шағын қозғалмайтын сурет, беті бұлдыратылған.',
        numbers: 'Қозғалысың туралы сандар, мысалы, минутына жанасу саны.',
        provider: 'Бұл суреттерді кеңесіңді жазатын жасанды интеллект (ЖИ) провайдері көреді.',
      },
      beta: 'Бұл бета нұсқа. Кеңес қате болуы мүмкін, және ол сені басқа ойыншылармен ешқашан салыстырмайды.',
      off: {
        title: 'Бейне талдау өшірулі',
        hint: 'Жалғастыру үшін оны құпиялылық баптауларында қос.',
      },
      guardian: {
        title: 'Ата-ана немесе қамқоршы келісуі керек',
        hint: 'Сен 13 жасқа толмағансың. Бейне талдауды құпиялылық баптауларында ата-анаң немесе қамқоршың растайды. Содан кейін осында қайт.',
      },
      open: 'Құпиялылық баптауларын ашу',
      recheck: 'Қостым: қайта тексеру',
      loading: 'Құпиялылық таңдауларың тексерілуде',
      error: { title: 'Құпиялылық таңдауларыңды тексере алмадық', retry: 'Қайталау' },
      noPlan: {
        title: 'Алдымен жоспарыңды құр',
        hint: 'Сені қорғау үшін жасың керек. Бұл бір минут алады.',
        action: 'Жоспарымды құру',
      },
    },
    capture: {
      title: 'Бейне жаз немесе таңда',
      loading: 'Кеңестер жүктелуде',
      empty: { title: 'Бұл дағдыға кеңес әзірше жоқ', hint: 'Басқа дағды таңда.' },
      error: { title: 'Кеңестерді жүктей алмадық', retry: 'Қайталау' },
      tipsTitle: 'Қалай түсіру керек',
      criteriaTitle: 'Бапкер нені қарайды',
      limits: 'Бейне 10-нан 30 секундқа дейін болуы керек.',
      record: 'Камерамен жазу',
      choose: 'Құрылғыдан бейне таңдау',
      noCamera: 'Бұл браузер мұнда жаза алмайды. Бұрыннан бар бейнені таңда.',
      opening: 'Камера күтілуде',
      camera: {
        denied: {
          title: 'Камера бұғатталған',
          hint: 'Браузер баптауларында бұл сайтқа камераға рұқсат бер, немесе бұрыннан бар бейнені таңда.',
        },
        unavailable: {
          title: 'Камера қолжетімсіз',
          hint: 'Оны басқа қолданба пайдалануы мүмкін. Қайталап көр, немесе бұрыннан бар бейнені таңда.',
        },
      },
    },
    recording: {
      preview: 'Камера көрінісі',
      countdown: 'Дайындал',
      elapsed: 'Жазу: {{seconds}} с',
      progress: 'Жазу ұзақтығы',
      keepGoing: 'Жалғастыр: тағы кемінде {{seconds}} секунд',
      stop: 'Жазуды тоқтату',
      cancel: 'Бас тарту',
    },
    checking: 'Бейнең тексерілуде',
    clip: {
      short: 'Бұл бейне {{seconds}} секунд. Ол тым қысқа.',
      long: 'Бұл бейне {{seconds}} секунд. Ол тым ұзын.',
      hint: 'Бапкер жеткілікті көруі үшін 10-нан 30 секундқа дейінгі бейне пайдалан.',
      unreadable: 'Бұл бейнені ашу мүмкін емес.',
      unreadableHint: 'Басқа бейне таңда немесе жаңасын жаз.',
    },
    processing: {
      title: 'Қозғалысың осы телефонда оқылуда',
      preparing: 'Дайындалуда',
      progress: 'Қозғалысыңды оқу',
      staysHere: 'Бейнең осы телефоннан шықпайды.',
      cancel: 'Бас тарту',
    },
    failed: {
      title: 'Бұл бейнені оқи алмадық',
      hint: 'Қайталап көр немесе жаңа бейне түсір.',
    },
    rerecord: {
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
      local: 'Ештеңе жіберілмеді.',
      action: 'Қайта түсіру',
    },
    review: {
      title: 'Жіберуге дайынсың ба?',
      lead: 'Тек мына суреттер мен қозғалыс сандары жіберіледі. Бетің бұлдыратылған, ал бейнең осы телефонда қалады.',
      picture: '{{total}} суреттің {{n}}-і, жіберіледі',
      send: 'Талдауға жіберу',
      sending: 'Жіберілуде, кеңес күтілуде',
      cancelSending: 'Жіберуден бас тарту',
      discard: 'Өшіріп, қайта бастау',
      error: { title: 'Кеңесті ала алмадық', retry: 'Қайталау' },
    },
    result: {
      title: 'Сенің кеңесің',
      beta: 'Бета',
      confidence: 'Қаншалықты сенімдіміз: {{level}}',
      levels: { low: 'төмен', medium: 'орташа', high: 'жоғары' },
      score: '{{score}} / 10',
      focus: 'Келесі назар',
      drills: 'Байқап көретін жаттығулар',
      repeat: '{{sessions}} жаттығудан кейін қайта түсір, сонда қалай өзгергеніңді көресің.',
      limits: 'Білу пайдалы',
      again: 'Тағы бір бейнені талдау',
    },
  },
  ru: {
    eyebrow: 'Видео-тренер · Бета',
    title: 'Сними короткое видео',
    lead: 'Сними 10–30 секунд и получи совет по одному навыку. Это не обязательно: тренировки работают и без этого.',
    optional: {
      text: 'Видео-тренер не обязателен. Твои тренировки работают и без него.',
      back: 'Назад к тренировке',
    },
    skills: {
      title: 'Выбери навык',
      hint: 'Какой навык разобрать?',
      chosen: 'Навык: {{skill}}',
      change: 'Сменить навык',
      'ball-mastery': { option: 'Разобрать моё владение мячом', name: 'Владение мячом' },
      dribbling: { option: 'Разобрать мой дриблинг', name: 'Дриблинг' },
      'passing-first-touch': { option: 'Разобрать мои пас и первый приём', name: 'Пас и первый приём' },
      'weak-foot': { option: 'Разобрать мою слабую ногу', name: 'Слабая нога' },
      'juggling-coordination': { option: 'Разобрать моё жонглирование', name: 'Жонглирование и координация' },
    },
    unavailable: {
      title: 'Видео-тренер недоступен без интернета',
      hint: 'Подключись к интернету, чтобы им пользоваться. Тренировки работают и без интернета.',
    },
    unsupported: {
      title: 'Это устройство не может запустить разбор',
      hint: 'Видео-тренеру нужен более новый браузер или телефон. Тренировки работают как обычно.',
    },
    disabled: {
      title: 'Видео-тренер выключен',
      hint: 'Сейчас он недоступен. Тренировки работают как обычно.',
    },
    gate: {
      title: 'Прежде чем начать',
      deviceTitle: 'Остаётся на твоём телефоне',
      device: {
        video: 'Твоё видео. Оно никогда не загружается и стирается из памяти, когда мы закончим.',
        reading: 'Чтение движений. Телефон сам находит, где твои руки и ноги.',
      },
      sentTitle: 'Отправляется, чтобы получить совет',
      sent: {
        pictures: 'Несколько маленьких неподвижных снимков с размытым лицом.',
        numbers: 'Числа о твоём движении, например, сколько касаний в минуту.',
        provider: 'Эти снимки видит поставщик ИИ, который пишет твой совет.',
      },
      beta: 'Это бета-версия. Совет может быть неточным, и он никогда не сравнивает тебя с другими игроками.',
      off: {
        title: 'Видеоразбор выключен',
        hint: 'Чтобы продолжить, включи его в настройках конфиденциальности.',
      },
      guardian: {
        title: 'Нужно согласие родителя или опекуна',
        hint: 'Тебе меньше 13 лет. Видеоразбор в настройках конфиденциальности подтверждает родитель или опекун. Потом возвращайся сюда.',
      },
      open: 'Открыть настройки конфиденциальности',
      recheck: 'Я включил: проверить ещё раз',
      loading: 'Проверяем твой выбор в настройках конфиденциальности',
      error: { title: 'Не удалось проверить твой выбор в настройках конфиденциальности', retry: 'Повторить' },
      noPlan: {
        title: 'Сначала создай план',
        hint: 'Нам нужен твой возраст, чтобы тебя защитить. Это займёт минуту.',
        action: 'Создать мой план',
      },
    },
    capture: {
      title: 'Запиши или выбери видео',
      loading: 'Загружаем советы',
      empty: { title: 'Для этого навыка советов пока нет', hint: 'Выбери другой навык.' },
      error: { title: 'Не удалось загрузить советы', retry: 'Повторить' },
      tipsTitle: 'Как снимать',
      criteriaTitle: 'На что смотрит тренер',
      limits: 'Видео должно длиться от 10 до 30 секунд.',
      record: 'Записать камерой',
      choose: 'Выбрать видео на устройстве',
      noCamera: 'Этот браузер не может здесь записывать. Выбери видео, которое уже есть.',
      opening: 'Ждём камеру',
      camera: {
        denied: {
          title: 'Камера заблокирована',
          hint: 'Разреши этому сайту камеру в настройках браузера или выбери видео, которое уже есть.',
        },
        unavailable: {
          title: 'Камера недоступна',
          hint: 'Возможно, её использует другое приложение. Попробуй ещё раз или выбери видео, которое уже есть.',
        },
      },
    },
    recording: {
      preview: 'Изображение с камеры',
      countdown: 'Приготовься',
      elapsed: 'Запись: {{seconds}} с',
      progress: 'Длительность записи',
      keepGoing: 'Продолжай: ещё минимум {{seconds}} сек.',
      stop: 'Остановить запись',
      cancel: 'Отмена',
    },
    checking: 'Проверяем твоё видео',
    clip: {
      short: 'Это видео длится {{seconds}} сек. Оно слишком короткое.',
      long: 'Это видео длится {{seconds}} сек. Оно слишком длинное.',
      hint: 'Возьми видео от 10 до 30 секунд, чтобы тренер увидел достаточно.',
      unreadable: 'Это видео не удаётся открыть.',
      unreadableHint: 'Выбери другое видео или запиши новое.',
    },
    processing: {
      title: 'Читаем твои движения на этом телефоне',
      preparing: 'Готовимся',
      progress: 'Чтение движений',
      staysHere: 'Твоё видео остаётся на этом телефоне.',
      cancel: 'Отмена',
    },
    failed: {
      title: 'Не удалось прочитать это видео',
      hint: 'Попробуй ещё раз или сними новое.',
    },
    rerecord: {
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
      local: 'Ничего не отправлено.',
      action: 'Снять ещё раз',
    },
    review: {
      title: 'Готов отправить?',
      lead: 'Отправляются только эти снимки и числа о движении. Лицо размыто, а видео остаётся на этом телефоне.',
      picture: 'Снимок {{n}} из {{total}}, будет отправлен',
      send: 'Отправить на разбор',
      sending: 'Отправляем и ждём совет',
      cancelSending: 'Отменить отправку',
      discard: 'Удалить и начать заново',
      error: { title: 'Не удалось получить совет', retry: 'Повторить' },
    },
    result: {
      title: 'Твой совет',
      beta: 'Бета',
      confidence: 'Насколько мы уверены: {{level}}',
      levels: { low: 'низко', medium: 'средне', high: 'высоко' },
      score: '{{score}} / 10',
      focus: 'На что обратить внимание',
      drills: 'Упражнения, которые стоит попробовать',
      repeat: 'Сними ещё раз через {{sessions}} тренировки, чтобы увидеть, как ты изменился.',
      limits: 'Полезно знать',
      again: 'Разобрать ещё одно видео',
    },
  },
  en: {
    eyebrow: 'Video Coach · Beta',
    title: 'Film a short clip',
    lead: 'Film 10 to 30 seconds and get one tip on a skill. It is optional: training works without it.',
    optional: {
      text: 'Video Coach is optional. Your training works without it.',
      back: 'Back to training',
    },
    skills: {
      title: 'Pick a skill',
      hint: 'Which skill should we look at?',
      chosen: 'Skill: {{skill}}',
      change: 'Change skill',
      'ball-mastery': { option: 'Analyse my ball mastery', name: 'Ball mastery' },
      dribbling: { option: 'Analyse my dribbling', name: 'Dribbling' },
      'passing-first-touch': { option: 'Analyse my passing and first touch', name: 'Passing and first touch' },
      'weak-foot': { option: 'Analyse my weaker foot', name: 'Weaker foot' },
      'juggling-coordination': { option: 'Analyse my juggling', name: 'Juggling and coordination' },
    },
    unavailable: {
      title: 'Video Coach is unavailable offline',
      hint: 'Connect to the internet to use it. Your training works offline.',
    },
    unsupported: {
      title: 'This device cannot run the analysis',
      hint: 'Video Coach needs a newer browser or phone. Your training works as always.',
    },
    disabled: {
      title: 'Video Coach is switched off',
      hint: 'It is not available right now. Your training works as always.',
    },
    gate: {
      title: 'Before you start',
      deviceTitle: 'Stays on your phone',
      device: {
        video: 'Your video. It is never uploaded, and it is cleared from memory when we finish.',
        reading: 'The movement reading. Your phone finds where your arms and legs are.',
      },
      sentTitle: 'Sent to get your feedback',
      sent: {
        pictures: 'A few small still pictures, with your face blurred.',
        numbers: 'Numbers about your movement, like touches per minute.',
        provider: 'These pictures are seen by an AI provider, which writes your feedback.',
      },
      beta: 'This is a beta. The feedback can be wrong, and it never ranks you against other players.',
      off: {
        title: 'Video analysis is off',
        hint: 'Turn it on in Privacy settings to go on.',
      },
      guardian: {
        title: 'A parent or guardian must say yes',
        hint: 'You are under 13. A parent or guardian confirms video analysis in Privacy settings. Then come back here.',
      },
      open: 'Open privacy settings',
      recheck: 'I turned it on: check again',
      loading: 'Checking your privacy choices',
      error: { title: 'Could not check your privacy choices', retry: 'Try again' },
      noPlan: {
        title: 'Set up your plan first',
        hint: 'We need your age to protect you. It takes a minute.',
        action: 'Set up my plan',
      },
    },
    capture: {
      title: 'Record or choose a clip',
      loading: 'Loading the tips',
      empty: { title: 'No tips for this skill yet', hint: 'Pick another skill.' },
      error: { title: 'Could not load the tips', retry: 'Try again' },
      tipsTitle: 'How to film',
      criteriaTitle: 'What the coach looks at',
      limits: 'Clips must be 10 to 30 seconds long.',
      record: 'Record with the camera',
      choose: 'Choose a video from this device',
      noCamera: 'This browser cannot record here. Choose a video you already have.',
      opening: 'Waiting for the camera',
      camera: {
        denied: {
          title: 'The camera is blocked',
          hint: 'Allow the camera for this site in your browser settings, or choose a video you already have.',
        },
        unavailable: {
          title: 'The camera is not available',
          hint: 'Another app may be using it. Try again, or choose a video you already have.',
        },
      },
    },
    recording: {
      preview: 'Camera preview',
      countdown: 'Get ready',
      elapsed: 'Recording: {{seconds}} s',
      progress: 'Recording length',
      keepGoing: 'Keep going: at least {{seconds}} more seconds',
      stop: 'Stop recording',
      cancel: 'Cancel',
    },
    checking: 'Checking your clip',
    clip: {
      short: 'This clip is {{seconds}} seconds. That is too short.',
      long: 'This clip is {{seconds}} seconds. That is too long.',
      hint: 'Use a clip of 10 to 30 seconds so the coach can see enough.',
      unreadable: 'This video cannot be opened.',
      unreadableHint: 'Try another video, or record a new one.',
    },
    processing: {
      title: 'Reading your movement on this phone',
      preparing: 'Getting ready',
      progress: 'Reading your movement',
      staysHere: 'Your video stays on this phone.',
      cancel: 'Cancel',
    },
    failed: {
      title: 'We could not read this clip',
      hint: 'Try again, or film a new clip.',
    },
    rerecord: {
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
      local: 'Nothing was sent.',
      action: 'Film again',
    },
    review: {
      title: 'Ready to send?',
      lead: 'Only these pictures and the movement numbers are sent. Your face is blurred and your video stays on this phone.',
      picture: 'Picture {{n}} of {{total}} that will be sent',
      send: 'Send for analysis',
      sending: 'Sending and waiting for feedback',
      cancelSending: 'Cancel sending',
      discard: 'Delete and start again',
      error: { title: 'We could not get your feedback', retry: 'Try again' },
    },
    result: {
      title: 'Your feedback',
      beta: 'Beta',
      confidence: 'How sure we are: {{level}}',
      levels: { low: 'Low', medium: 'Medium', high: 'High' },
      score: '{{score}} / 10',
      focus: 'Focus next',
      drills: 'Drills to try',
      repeat: 'Film again after {{sessions}} training sessions to see how you changed.',
      limits: 'Good to know',
      again: 'Analyse another clip',
    },
  },
} satisfies MessageBundle;
