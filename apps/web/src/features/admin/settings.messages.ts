import type { MessageBundle } from '../../lib/i18n';

// Admin settings screen copy (routes/admin/settings.tsx). Namespace `settings` (from the file name); registered by the eager glob
// in lib/i18n.ts, so no central catalogue is edited.
//
// KAZAKH (and Russian) TEXT STILL NEEDS A NATIVE-SPEAKER REVIEW (bead fc-cjh). Two choices there are deliberate and worth a
// look: (1) the low-pool warning and the count hint put the number after a colon ("... : 19") so no noun has to agree with it in
// ru or kk; (2) the trust status names are copied from trust-badge.messages.ts so the same status has the same name everywhere.
//
// `{{min}}` is the pool floor (20) and is filled from a constant in the screen, never typed into a sentence.
export default {
  kk: {
    eyebrow: 'Әкімші',
    title: 'Баптаулар',
    lead: 'Ойыншыларға қандай жаттығулар ұсынылатынын және қандай мүмкіндіктер қосулы екенін таңдаңыз. Өзгерістер сақтаған бойда іске асады.',
    loading: 'Баптаулар жүктелуде',
    error: { title: 'Баптауларды жүктей алмадық', retry: 'Қайталау' },
    empty: {
      title: 'Әзірге өзгертетін баптау жоқ',
      hint: 'Сервер ешқандай баптау көрсетпеді. Келесі жаңартудан кейін қайта қараңыз.',
    },
    drills: {
      title: 'Жаттығуларды таңдау',
      legend: 'Жасына қарай ұсынылатын ең төменгі сенім деңгейі',
      hint: 'Ойыншыларға осы немесе одан жоғары сенім деңгейіндегі жаттығулар ғана ұсынылады.',
    },
    band: { u10: '10 жасқа дейін', u14: '10–13 жас', adult: '14 жас және одан үлкен' },
    status: {
      COMMUNITY: 'Қауымдастық',
      REVIEWED: 'Қаралған',
      EXPERT_VERIFIED: 'Сарапшы тексерген',
      ACADEMY_VERIFIED: 'Академия тексерген',
    },
    pool: {
      count: 'Осы және одан жоғары деңгейдегі жаттығулар: {{drills}}',
      unknown: 'Жаттығулар санын анықтай алмадық, сондықтан жаттығулар аз болатыны туралы ескертулер әзірге өшірулі.',
      warnTitle: '{{band}}: жаттығулар аз',
      warnBody: 'Ең төменгі деңгейді «{{status}}» дейін көтерсеңіз, таңдауға {{min}} жаттығудан аз қалады (барлығы: {{drills}}).',
    },
    uploads: {
      title: 'Жүктеу',
      label: 'Жүктеу көлемінің шегі (МБ)',
      hint: 'Бір файлдың ең үлкен көлемі, бүтін мегабайтпен.',
    },
    features: {
      title: 'Мүмкіндіктер',
      on: 'Қосулы',
      off: 'Өшірулі',
      ai: { label: 'AI жоспарлаушы', hint: 'AI жаттықтырушы сабақ жоспарлауға көмектеседі.' },
      video: { label: 'Бейне жаттықтырушы', hint: 'Ойыншыларға бейне бойынша пікір алуға мүмкіндік береді.' },
    },
    retest: {
      title: 'Қайта тестілеу',
      label: 'Қайта тестілеу еске салғышы (күн)',
      hint: 'Ойыншының алғашқы тестінен кейін қанша күннен соң қайта тестілеу ұсынылады, үтірмен бөліңіз. Мысалы: 7, 14, 30.',
    },
    actions: {
      save: 'Баптауларды сақтау',
      saving: 'Сақталуда…',
      discard: 'Өзгерістерді болдырмау',
      clean: 'Әзірге өзгеріс жоқ.',
      dirty: 'Сақталмаған өзгерістер бар.',
    },
    saved: 'Баптаулар сақталды. Олар бірден іске асады.',
    failed: 'Ештеңе сақталмады',
    fieldError: {
      minStatus: 'Төрт сенім деңгейінің бірін таңдаңыз.',
      uploadMaxMb: 'Мегабайттың бүтін санын енгізіңіз, 1 немесе одан көп.',
      retest: 'Күндердің бүтін санын үтірмен бөліп енгізіңіз, әрқайсысы 1 немесе одан көп.',
      toggle: 'Бұл баптауды сақтау мүмкін болмады.',
    },
    server: {
      title: 'Серверде орнатылады',
      lead: 'Модель идентификаторлары мен құпиялар сервер ортасында сақталады. Олардың орнатылғанын осы жерден көресіз, бірақ өзгерте алмайсыз.',
      aiKey: 'AI провайдер кілті',
      configured: 'Бапталған',
      notConfigured: 'Бапталмаған',
      checking: 'Тексерілуде…',
      unknown: 'Тексере алмадық',
    },
  },
  ru: {
    eyebrow: 'Администратор',
    title: 'Настройки',
    lead: 'Выберите, какие упражнения предлагать игрокам и какие функции включены. Изменения действуют сразу после сохранения.',
    loading: 'Загружаем настройки',
    error: { title: 'Не удалось загрузить настройки', retry: 'Повторить' },
    empty: {
      title: 'Пока нет настроек для изменения',
      hint: 'Сервер не прислал ни одной настройки. Загляните после следующего обновления.',
    },
    drills: {
      title: 'Выбор упражнений',
      legend: 'Минимальный статус доверия по возрасту',
      hint: 'Игрокам предлагаются только упражнения с этим статусом доверия или выше.',
    },
    band: { u10: 'Младше 10 лет', u14: '10–13 лет', adult: '14 лет и старше' },
    status: {
      COMMUNITY: 'Сообщество',
      REVIEWED: 'Рецензировано',
      EXPERT_VERIFIED: 'Проверено экспертом',
      ACADEMY_VERIFIED: 'Проверено академией',
    },
    pool: {
      count: 'Упражнений с этим статусом и выше: {{drills}}',
      unknown: 'Не удалось посчитать упражнения, поэтому предупреждения о малом выборе пока выключены.',
      warnTitle: '{{band}}: слишком мало упражнений',
      warnBody: 'Если поднять минимум до «{{status}}», останется меньше {{min}} упражнений на выбор (всего: {{drills}}).',
    },
    uploads: {
      title: 'Загрузки',
      label: 'Ограничение размера загрузки (МБ)',
      hint: 'Самый большой файл, который можно загрузить, в целых мегабайтах.',
    },
    features: {
      title: 'Функции',
      on: 'Включено',
      off: 'Выключено',
      ai: { label: 'ИИ-планировщик', hint: 'ИИ-тренер помогает составлять план занятий.' },
      video: { label: 'Видеотренер', hint: 'Игроки получают отзыв по видео.' },
    },
    retest: {
      title: 'Повторные тесты',
      label: 'Напоминания о повторном тесте (дни)',
      hint: 'Через сколько дней после первого теста игроку предлагают пройти его снова, через запятую. Например: 7, 14, 30.',
    },
    actions: {
      save: 'Сохранить настройки',
      saving: 'Сохраняем…',
      discard: 'Отменить изменения',
      clean: 'Изменений пока нет.',
      dirty: 'Есть несохранённые изменения.',
    },
    saved: 'Настройки сохранены. Они действуют сразу.',
    failed: 'Ничего не сохранено',
    fieldError: {
      minStatus: 'Выберите один из четырёх статусов доверия.',
      uploadMaxMb: 'Введите целое число мегабайт, 1 или больше.',
      retest: 'Введите целые дни через запятую, каждое 1 или больше.',
      toggle: 'Не удалось сохранить эту настройку.',
    },
    server: {
      title: 'Задаётся на сервере',
      lead: 'Идентификаторы моделей и секреты хранятся в окружении сервера. Здесь видно, заданы ли они, но изменить их нельзя.',
      aiKey: 'Ключ ИИ-провайдера',
      configured: 'Настроен',
      notConfigured: 'Не настроен',
      checking: 'Проверяем…',
      unknown: 'Не удалось проверить',
    },
  },
  en: {
    eyebrow: 'Admin',
    title: 'Settings',
    lead: 'Choose which drills players are offered and which features are on. Changes apply as soon as you save.',
    loading: 'Loading settings',
    error: { title: 'Could not load the settings', retry: 'Try again' },
    empty: {
      title: 'No settings to change yet',
      hint: 'The server did not list any settings. Check back after the next update.',
    },
    drills: {
      title: 'Drill choice',
      legend: 'Lowest trust status offered, by age',
      hint: 'Players are only offered drills at this trust status or higher.',
    },
    band: { u10: 'Under 10', u14: 'Ages 10 to 13', adult: 'Age 14 and older' },
    status: {
      COMMUNITY: 'Community',
      REVIEWED: 'Reviewed',
      EXPERT_VERIFIED: 'Expert verified',
      ACADEMY_VERIFIED: 'Academy verified',
    },
    pool: {
      count: 'Drills at this status or higher: {{drills}}',
      unknown: 'Could not count the drills, so low-drill warnings are off for now.',
      warnTitle: '{{band}}: too few drills',
      warnBody: 'Raising the minimum to “{{status}}” would leave fewer than {{min}} drills to choose from ({{drills}} in total).',
    },
    uploads: {
      title: 'Uploads',
      label: 'Upload size limit (MB)',
      hint: 'The largest file a person can upload, in whole megabytes.',
    },
    features: {
      title: 'Features',
      on: 'On',
      off: 'Off',
      ai: { label: 'AI planner', hint: 'The AI coach helps plan sessions.' },
      video: { label: 'Video coach', hint: 'Players can get feedback on a video.' },
    },
    retest: {
      title: 'Retests',
      label: 'Retest reminders (days)',
      hint: 'Days after a player’s first test when they are asked to test again, separated by commas. For example: 7, 14, 30.',
    },
    actions: {
      save: 'Save settings',
      saving: 'Saving…',
      discard: 'Discard changes',
      clean: 'No changes yet.',
      dirty: 'You have unsaved changes.',
    },
    saved: 'Settings saved. They apply right away.',
    failed: 'Nothing was saved',
    fieldError: {
      minStatus: 'Choose one of the four trust statuses.',
      uploadMaxMb: 'Enter a whole number of megabytes, 1 or more.',
      retest: 'Enter whole days, 1 or more, separated by commas.',
      toggle: 'This setting could not be saved.',
    },
    server: {
      title: 'Set on the server',
      lead: 'Model ids and secrets live in the server environment. You can see here whether they are set, but not change them.',
      aiKey: 'AI provider key',
      configured: 'Configured',
      notConfigured: 'Not configured',
      checking: 'Checking…',
      unknown: 'Could not check',
    },
  },
} satisfies MessageBundle;
