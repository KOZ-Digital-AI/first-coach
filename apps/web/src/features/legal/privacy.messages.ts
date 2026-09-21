import type { MessageBundle } from '../../lib/i18n';

// Privacy policy copy. Namespace `privacy` (from the file name); registered by the eager glob in lib/i18n.ts.
//
// Plain language on purpose: a 10-year-old and a parent should both be able to follow it, so short sentences, no legal
// terms, "we" is KOZ AI. It describes only what the product does (see the contract in apps/api/src/shared/privacy.ts and
// PRODUCT.md); it promises nothing else. The whole page is marked as pending legal review (`status`).
// Kazakh text still needs a native review (fc-cjh); the Kazakh anchors in privacy.test.tsx move with it.
//
// Shape: `sections.<id>.title` plus the keys PRIVACY_SECTIONS lists for that section (paragraphs, then a bulleted list,
// then closing paragraphs). `contact.<where>` is the lead-in before the contact address; it is only shown when the
// address (VITE_CONTACT_EMAIL) is set.

export type PrivacySection = {
  id: string;
  /** Keys under `sections.<id>` rendered as paragraphs before the list. */
  paragraphs: readonly string[];
  /** Keys rendered as a bulleted list. */
  items: readonly string[];
  /** Keys rendered as paragraphs after the list. */
  closing: readonly string[];
  /** Which lead-in (`contact.<key>`) the contact address gets at the end of the section, if any. */
  contact?: 'guardians' | 'takedown';
};

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  { id: 'who', paragraphs: ['p1', 'p2'], items: [], closing: [] },
  { id: 'stored', paragraphs: ['p1'], items: ['i1', 'i2', 'i3', 'i4', 'i5'], closing: ['p2'] },
  { id: 'video', paragraphs: ['p1', 'p2', 'p3'], items: [], closing: [] },
  { id: 'coaches', paragraphs: ['p1', 'p2'], items: [], closing: [] },
  { id: 'ads', paragraphs: ['p1', 'p2'], items: [], closing: [] },
  { id: 'yourData', paragraphs: ['p1'], items: ['i1', 'i2', 'i3'], closing: ['p2'] },
  { id: 'guardians', paragraphs: ['p1', 'p2'], items: [], closing: [], contact: 'guardians' },
  { id: 'takedown', paragraphs: ['p1', 'p2'], items: [], closing: [], contact: 'takedown' },
];

export default {
  kk: {
    eyebrow: 'Сіздің құпиялылығыңыз',
    title: 'Құпиялылық саясаты',
    lead: 'Бұл бетте FIRST COACH сіз туралы не сақтайтыны, оны не істейтіні және ешқашан не істемейтіні қарапайым тілмен жазылған.',
    status: {
      label: 'Заңгерлік тексеруді күтуде.',
      note: 'Бұл — қарапайым тілмен жазылған саясат. Заңгер оны әлі тексерген жоқ, сондықтан мәтін өзгеруі мүмкін.',
    },
    contact: {
      guardians: 'Ата-аналар мен қамқоршылардың сұрақтары бар ма? Бізге жазыңыз:',
      takedown: 'Сұрау үшін бізге жазыңыз:',
    },
    sections: {
      who: {
        title: 'FIRST COACH-ты кім жүргізеді',
        p1: 'FIRST COACH-ты KOZ AI жүргізеді. Ол тегін және ашық код: ақы төлеудің қажеті жоқ, жазылым да жоқ.',
        p2: 'Осы беттегінің бәрі FIRST COACH қолданбасына және оның артындағы қызметке қатысты.',
      },
      stored: {
        title: 'Біз нені сақтаймыз',
        p1: 'Жаттығу үшін аты-жөніңіз, электрондық поштаңыз немесе құпиясөз қажет емес. FIRST COACH тек жаттығуларыңызды жоспарлау және жетістігіңізді көрсету үшін қажетті нәрсені ғана сақтайды:',
        i1: 'басында берген жауаптарыңыз: жасыңыз, деңгейіңіз, мақсатыңыз, құралдарыңыз бен орныңыз, серіктеспен жаттығасыз ба, аптасына неше күн және бір жаттығуға неше минут жаттығасыз, сондай-ақ тіліңіз',
        i2: 'тест нәтижелеріңіз',
        i3: 'жаттығу жоспарыңыз',
        i4: 'қандай жаттығуларды және қашан орындағаныңыз',
        i5: 'құпиялылық баптауларындағы таңдауларыңыз, мысалы, бейне талдауы қосулы ма',
        p2: 'Браузердегі шағын файл (cookie) қолданбаға қайта келгенде сізді танып, жетістігіңізді сақтап тұруға көмектеседі. Ол сіздің атыңызбен байланысты емес.',
      },
      video: {
        title: 'Бейнеңіз телефоныңызда қалады',
        p1: 'Кері байланыс алу үшін өзіңізді бейнеге түсірсеңіз, бейне телефоннан ешқашан шықпайды. Ол жүктелмейді және ешкімге жіберілмейді.',
        p2: 'Тек сіз «иә» десеңіз ғана — осы үшін бөлек қадамда — бейнеден алынған жеке кадрларды (қозғалмайтын суреттерді) жасанды интеллект (ЖИ) провайдеріне жіберуге болады, сонда ЖИ қалай қозғалатыныңызды көре алады. Кадрлар — фотоға ұқсас, бейне емес.',
        p3: '«Жоқ» деп жауап берсеңіз де, жаттығуларды орындай бересіз. Өз шешіміңізді кез келген уақытта құпиялылық баптауларында өзгерте аласыз.',
      },
      coaches: {
        title: 'Жаттығу қосатын жаттықтырушылар',
        p1: 'Қауымдастықпен жаттығу бөлісетін жаттықтырушы электрондық пошта мен құпиясөз арқылы кіреді. Біз сол поштаны және жаттықтырушы жіберген барлық нәрсені, соның ішінде қосуды таңдаған бейне немесе фотоларды, жаттығу жарияланбас бұрын тексерілуі үшін сақтаймыз.',
        p2: 'Ойыншыларға бұлай істеудің қажеті жоқ.',
      },
      ads: {
        title: 'Жарнама да, бақылау да жоқ',
        p1: 'FIRST COACH-та жарнама жоқ. Біз сіз туралы сақтаған ештеңе жарнама үшін қолданылмайды және оны сатпаймыз.',
        p2: 'Біз үшінші тарап аналитикасын да, бақылау құралдарын да қолданбаймыз.',
      },
      yourData: {
        title: 'Деректерді жүктеп алу немесе жою',
        p1: 'Бұл — сіздің деректеріңіз. Құпиялылық баптауларында мына әрекеттерді жасай аласыз:',
        i1: 'біз сіз туралы сақтаған барлық нәрсені файл ретінде жүктеп алу',
        i2: 'біз сіз туралы сақтаған барлық нәрсені жою',
        i3: 'жетістігіңізді басқа телефонға көшіру үшін қалпына келтіру кодын жасау. Біз оны бір-ақ рет көрсетеміз, сондықтан жазып алып, сенімді жерде сақтаңыз: коды бар кез келген адам жетістігіңізді аша алады.',
        p2: 'Жойғаннан кейін сеанс аяқталады, ал жетістікті қайтару мүмкін емес: басынан бастайсыз.',
      },
      guardians: {
        title: 'Ата-аналар мен қамқоршылар үшін',
        p1: 'Бала 13 жасқа толмаса, бейне талдауын қосу үшін ата-ана немесе қамқоршы растауы керек. Оны өшіруге әрқашан болады.',
        p2: 'Балаңызбен бірге құпиялылық баптауларын кез келген уақытта ашып, таңдауларды көруге, деректерді жүктеп алуға немесе жоюға болады.',
      },
      takedown: {
        title: 'Жаттығуды алып тастауды қалай сұрауға болады',
        p1: 'Жаттығулар кез келген адам қолдана алатын ашық кітапханадан алынады. Егер жаттығу онда болмауы керек болса — мысалы, ол біреудің нәрсесін рұқсатсыз қолданса, қауіпті болса, баланың суретін көрсетсе немесе жай ғана қате болса — оны алып тастауды сұрай аласыз.',
        p2: 'Қай жаттығу екенін және неге екенін жазыңыз. Біз оны кітапханадан жасырамыз және ол алынған ашық файлдардан алып тастаймыз.',
      },
    },
  },
  ru: {
    eyebrow: 'Ваша приватность',
    title: 'Политика конфиденциальности',
    lead: 'На этой странице простыми словами написано, что FIRST COACH хранит о вас, что с этим делает и чего не делает никогда.',
    status: {
      label: 'Ожидает юридической проверки.',
      note: 'Это политика простым языком. Юрист её ещё не проверил, поэтому текст может измениться.',
    },
    contact: {
      guardians: 'Вопросы от родителей и опекунов? Напишите нам:',
      takedown: 'Чтобы попросить, напишите нам:',
    },
    sections: {
      who: {
        title: 'Кто ведёт FIRST COACH',
        p1: 'FIRST COACH ведёт KOZ AI. Приложение бесплатное и с открытым кодом: платить не нужно, подписки нет.',
        p2: 'Всё на этой странице относится к приложению FIRST COACH и сервису, который за ним стоит.',
      },
      stored: {
        title: 'Что мы храним',
        p1: 'Чтобы заниматься, не нужны ни имя, ни почта, ни пароль. FIRST COACH хранит только то, что нужно, чтобы составить тренировки и показывать ваш прогресс:',
        i1: 'ответы, которые вы дали в начале: возраст, уровень, цель, инвентарь и место, занимаетесь ли вы с партнёром, сколько дней в неделю и минут за занятие, а также язык',
        i2: 'результаты ваших тестов',
        i3: 'ваш план тренировок',
        i4: 'какие упражнения вы выполнили и когда',
        i5: 'ваш выбор в настройках приватности, например включён ли видеоразбор',
        p2: 'Маленький файл в браузере (cookie) помогает приложению узнать вас, когда вы вернётесь, и ваш прогресс сохраняется. Он не связан с вашим именем.',
      },
      video: {
        title: 'Ваше видео остаётся на телефоне',
        p1: 'Если вы снимаете себя на видео, чтобы получить разбор, видео никогда не покидает ваш телефон. Его не загружают и никому не отправляют.',
        p2: 'Только если вы скажете «да» отдельным шагом, специально для этого, отдельные стоп-кадры из видео могут быть отправлены поставщику ИИ, чтобы ИИ посмотрел, как вы двигаетесь. Стоп-кадры — это как фотографии, а не видео.',
        p3: 'Ответ «нет» не мешает выполнять упражнения. Передумать можно в любой момент в настройках приватности.',
      },
      coaches: {
        title: 'Тренеры, которые добавляют упражнения',
        p1: 'Тренер, который делится упражнением с сообществом, входит по почте и паролю. Мы храним эту почту и всё, что тренер присылает, включая видео или фото, которые он решил приложить, чтобы упражнение можно было проверить до публикации.',
        p2: 'Игрокам этого делать не нужно.',
      },
      ads: {
        title: 'Никакой рекламы и слежки',
        p1: 'В FIRST COACH нет рекламы. Ничего из того, что мы храним о вас, не используется для рекламы, и мы это не продаём.',
        p2: 'Мы не используем стороннюю аналитику и сторонние инструменты слежки.',
      },
      yourData: {
        title: 'Скачать или удалить свои данные',
        p1: 'Это ваши данные. В настройках приватности можно:',
        i1: 'скачать всё, что мы о вас храним, одним файлом',
        i2: 'удалить всё, что мы о вас храним',
        i3: 'создать код восстановления, чтобы перенести прогресс на другой телефон. Мы показываем его только один раз, поэтому запишите его и храните в надёжном месте: с ним любой сможет открыть ваш прогресс.',
        p2: 'После удаления сеанс завершается, а прогресс вернуть нельзя: вы начнёте с самого начала.',
      },
      guardians: {
        title: 'Для родителей и опекунов',
        p1: 'Если ребёнку нет 13 лет, включить видеоразбор можно только после подтверждения родителя или опекуна. Выключить его можно всегда.',
        p2: 'Вы можете в любой момент открыть настройки приватности вместе с ребёнком: посмотреть выбор, скачать данные или удалить их.',
      },
      takedown: {
        title: 'Как попросить убрать упражнение',
        p1: 'Упражнения берутся из открытой библиотеки, которой может пользоваться любой. Если упражнения там быть не должно, например оно использует чужое без разрешения, небезопасно, показывает изображение ребёнка или просто неверно, вы можете попросить нас его убрать.',
        p2: 'Укажите, что это за упражнение и почему. Мы скроем его в библиотеке и уберём из открытых файлов, откуда оно взято.',
      },
    },
  },
  en: {
    eyebrow: 'Your privacy',
    title: 'Privacy policy',
    lead: 'This page says, in plain words, what FIRST COACH keeps about you, what it does with it, and what it never does.',
    status: {
      label: 'Pending legal review.',
      note: 'This is a plain-language policy. A lawyer has not checked it yet, so it may change.',
    },
    contact: {
      guardians: 'Questions from parents and guardians? Write to us:',
      takedown: 'To ask, write to us:',
    },
    sections: {
      who: {
        title: 'Who runs FIRST COACH',
        p1: 'FIRST COACH is run by KOZ AI. It is free and open source: nobody pays, and there is no subscription.',
        p2: 'Everything on this page is about the FIRST COACH app and the service behind it.',
      },
      stored: {
        title: 'What we keep',
        p1: 'You do not need a name, an email or a password to train. FIRST COACH keeps only what it needs to plan your training and show your progress:',
        i1: 'the answers you gave at the start: your age, your level, your goal, your equipment and space, whether you train with a partner, how many days and minutes you train, and your language',
        i2: 'your test results',
        i3: 'your training plan',
        i4: 'the drills you finished, and when',
        i5: 'your privacy choices, such as whether video feedback is on',
        p2: 'A small file in your browser (a cookie) lets the app recognise you when you come back, so your progress is still there. It is not linked to your name.',
      },
      video: {
        title: 'Your video stays on your phone',
        p1: 'If you record a video of yourself to get feedback, the video never leaves your phone. It is not uploaded and it is not sent to anyone.',
        p2: 'Only if you say yes, in a separate step just for this, can single still pictures (frames) taken from the video be sent to an AI provider, so the AI can look at how you move. Still pictures are like photos, not video.',
        p3: 'Saying no never stops you from doing your drills. You can change your mind at any time in the privacy settings.',
      },
      coaches: {
        title: 'Coaches who add drills',
        p1: 'A coach who shares a drill with the community signs in with an email and a password. We keep that email and whatever the coach sends in, including any video or photos they choose to attach, so the drill can be checked before it is published.',
        p2: 'Players never need to do this.',
      },
      ads: {
        title: 'No ads and no tracking',
        p1: 'FIRST COACH shows no ads. Nothing we keep about you is used for advertising, and we never sell it.',
        p2: 'We use no third-party analytics or tracking tools.',
      },
      yourData: {
        title: 'Download or delete your data',
        p1: 'It is your data. In the privacy settings you can:',
        i1: 'download everything we keep about you, as a file',
        i2: 'delete everything we keep about you',
        i3: 'make a recovery code, so you can move your progress to another phone. We show it only once, so write it down and keep it safe: anyone who has it can open your progress.',
        p2: 'Deleting ends your session, and your progress cannot be brought back. You would start again from the beginning.',
      },
      guardians: {
        title: 'For parents and guardians',
        p1: 'If a child is under 13, a parent or guardian has to confirm before video feedback can be turned on. Turning it off is always allowed.',
        p2: 'You can open the privacy settings together with your child at any time, to see the choices, download the data or delete it.',
      },
      takedown: {
        title: 'How to ask us to take a drill down',
        p1: 'Drills come from an open library that anyone can use. If a drill should not be there, for example because it uses something without permission, it is not safe, it shows a child’s picture, or it is simply wrong, you can ask us to take it down.',
        p2: 'Say which drill it is and why. We will hide it from the library and remove it from the open files it came from.',
      },
    },
  },
} satisfies MessageBundle;
