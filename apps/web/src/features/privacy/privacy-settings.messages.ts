import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of /settings/privacy ("Your privacy"). The namespace is the file's base name: `privacy-settings`. It is NOT
 * `privacy`, because features/legal/privacy.messages.ts (the privacy policy page) already owns that namespace and a clash
 * throws when lib/i18n.ts builds its resources. Collected by the `*.messages.ts` glob in lib/i18n.ts, so nothing outside
 * this file registers it. Generic failures (offline, server, ...) live in lib/problem.messages.ts and are shown through
 * describeProblem, never worded here. Kazakh text still needs a native-speaker review.
 *
 * Plain language on purpose: a 10-year-old and a parent should both follow it (short sentences, no legal words, "you" is the
 * child). It says only what the product does (see the contract in apps/api/src/shared/privacy.ts, PRODUCT.md and the privacy
 * policy in features/legal): it promises nothing else and never compares the player with anyone.
 *
 * - `stored` lists what is kept and what is not asked for; `never` lists what is never done.
 * - `consents.video.hint` is the disclosure that a few still frames are sent to an AI provider.
 * - `guardian.*` is the under-13 confirmation. `saved.*` takes `{{name}}`, the toggle's own label (no plurals are needed).
 * - `state.on|off` is the word beside each switch, so the state is never colour or position alone.
 */
export default {
  kk: {
    eyebrow: 'Құпиялылық',
    title: 'Сенің құпиялылығың',
    lead: 'FIRST COACH сен туралы не білетінін өзің шешесің. Мұнда нені сақтайтынымызды және нені ешқашан істемейтінімізді жаздық.',
    back: 'Менің жоспарым',
    loading: 'Құпиялылық таңдауларын жүктеп жатырмыз',
    stored: {
      title: 'Біз нені сақтаймыз',
      keepTitle: 'Сақтаймыз',
      keep: {
        age: 'Жасың (жыл санымен), мысалы, 9.',
        results: 'Жаттығу нәтижелерің, сонда өзіңнің қалай өскеніңді көресің.',
      },
      notKeepTitle: 'Сақтамаймыз',
      notKeep: {
        name: 'Атың жоқ. Оны ешқашан сұрамаймыз.',
        email: 'Электрондық поштаң жоқ. Оны ешқашан сұрамаймыз.',
      },
    },
    never: {
      title: 'Біз ешқашан істемейтін нәрселер',
      items: {
        profiles: 'Ашық профиль жоқ. Сені ешкім іздеп таба алмайды.',
        messaging: 'Хат алмасу жоқ. Мұнда саған ешкім жаза алмайды.',
        ads: 'Жарнама жоқ. Жарнаманы көрсетпейміз де, сатпаймыз да.',
        rankings: 'Жалпы рейтинг жоқ. Сені тек өзіңнің бұрынғы нәтижеңмен салыстырамыз.',
      },
    },
    consents: {
      title: 'Сенің таңдауларың',
      lead: 'Екеуі де сен қосқанша өшірулі тұрады. Ойыңды кез келген уақытта өзгерте аласың.',
      video: {
        label: 'Бейне талдау',
        hint: 'Жаттығу бейнесін кеңес алу үшін жіберсең, оның бірнеше қозғалмайтын кадры жасанды интеллект (ЖИ) провайдеріне жіберіледі, сонда ол қимылдарыңды көре алады. Мұны кез келген уақытта өшіруге болады.',
      },
      model: {
        label: 'Модельді жақсарту',
        hint: 'Жаттығу нәтижелеріңді ЖИ жаттықтырушыны жақсарту үшін қолдануға рұқсат бер. Мұны кез келген уақытта өшіруге болады.',
      },
    },
    state: { on: 'Қосулы', off: 'Өшірулі' },
    guardian: {
      label: 'Ата-анам немесе қамқоршым қасымда және келіседі',
      hint: 'Сен 13 жасқа толмағансың, сондықтан бейне талдауды қосу үшін ата-анаң немесе қамқоршың «иә» деуі керек.',
      required: 'Алдымен ата-анаңнан немесе қамқоршыңнан белгі қоюын сұра.',
      confirmed: 'Ата-анаң немесе қамқоршың «иә» деді.',
    },
    saved: {
      on: 'Сақталды. {{name}} қосулы.',
      off: 'Сақталды. {{name}} өшірулі.',
    },
    saveFailed: 'Таңдауың сақталмады, сондықтан бұрынғы күйіне қайтты.',
    empty: {
      title: 'Алдымен баптауды аяқта',
      hint: 'Құпиялылық таңдаулары жоспарың құрылған соң пайда болады. Бірнеше сұраққа жауап беру жеткілікті.',
      action: 'Жоспарымды баптау',
    },
    error: {
      title: 'Таңдауларыңды жүктей алмадық',
      retry: 'Қайталау',
    },
  },
  ru: {
    eyebrow: 'Приватность',
    title: 'Твоя приватность',
    lead: 'Ты сам решаешь, что FIRST COACH знает о тебе. Здесь написано, что мы храним и чего никогда не делаем.',
    back: 'Мой план',
    loading: 'Загружаем настройки приватности',
    stored: {
      title: 'Что мы храним',
      keepTitle: 'Храним',
      keep: {
        age: 'Твой возраст в годах, например 9.',
        results: 'Твои результаты тренировок, чтобы ты видел, как растёшь.',
      },
      notKeepTitle: 'Не храним',
      notKeep: {
        name: 'Имени нет. Мы его никогда не спрашиваем.',
        email: 'Электронной почты нет. Мы её никогда не спрашиваем.',
      },
    },
    never: {
      title: 'Что мы никогда не делаем',
      items: {
        profiles: 'Публичных профилей нет. Тебя никто не найдёт.',
        messaging: 'Сообщений нет. Здесь тебе никто не может написать.',
        ads: 'Рекламы нет. Мы её не показываем и не продаём.',
        rankings: 'Общих рейтингов нет. Мы сравниваем тебя только с тобой прежним.',
      },
    },
    consents: {
      title: 'Твой выбор',
      lead: 'Оба пункта выключены, пока ты их не включишь. Передумать можно в любой момент.',
      video: {
        label: 'Анализ видео',
        hint: 'Если ты отправишь видео тренировки за советом, несколько неподвижных кадров из него уйдут провайдеру искусственного интеллекта (ИИ), чтобы он посмотрел на твои движения. Это можно выключить в любой момент.',
      },
      model: {
        label: 'Улучшение модели',
        hint: 'Разреши использовать твои результаты тренировок, чтобы улучшать ИИ-тренера. Это можно выключить в любой момент.',
      },
    },
    state: { on: 'Включено', off: 'Выключено' },
    guardian: {
      label: 'Родитель или опекун рядом и согласен',
      hint: 'Тебе меньше 13 лет, поэтому родитель или опекун должен сказать «да», прежде чем включится анализ видео.',
      required: 'Сначала попроси родителя или опекуна поставить галочку.',
      confirmed: 'Родитель или опекун сказал «да».',
    },
    saved: {
      on: 'Сохранено. {{name}}: включено.',
      off: 'Сохранено. {{name}}: выключено.',
    },
    saveFailed: 'Твой выбор не сохранился, поэтому всё вернулось как было.',
    empty: {
      title: 'Сначала закончи настройку',
      hint: 'Настройки приватности появятся, когда будет готов план. Для этого нужно ответить на несколько вопросов.',
      action: 'Настроить мой план',
    },
    error: {
      title: 'Не удалось загрузить твой выбор',
      retry: 'Повторить',
    },
  },
  en: {
    eyebrow: 'Privacy',
    title: 'Your privacy',
    lead: 'You decide what FIRST COACH knows about you. Here is what we keep and what we never do.',
    back: 'My plan',
    loading: 'Loading your privacy choices',
    stored: {
      title: 'What we keep',
      keepTitle: 'We keep',
      keep: {
        age: 'Your age in years, like 9.',
        results: 'Your training results, so you can see yourself getting better.',
      },
      notKeepTitle: 'We do not keep',
      notKeep: {
        name: 'No name. We never ask for it.',
        email: 'No email. We never ask for it.',
      },
    },
    never: {
      title: 'What we never do',
      items: {
        profiles: 'No public profiles. Nobody can look you up.',
        messaging: 'No messaging. Nobody can write to you here.',
        ads: 'No ads. We never show them and we never sell them.',
        rankings: 'No global rankings. We only compare you with your earlier self.',
      },
    },
    consents: {
      title: 'Your choices',
      lead: 'Both are off until you turn them on. You can change your mind at any time.',
      video: {
        label: 'Video analysis',
        hint: 'If you send a training video for tips, a few still frames from it are sent to an AI provider so it can look at your moves. You can turn this off at any time.',
      },
      model: {
        label: 'Model improvement',
        hint: 'Let us use your training results to improve the AI coach. You can turn this off at any time.',
      },
    },
    state: { on: 'On', off: 'Off' },
    guardian: {
      label: 'A parent or guardian is with me and says yes',
      hint: 'You are under 13, so a parent or guardian must say yes before video analysis can be turned on.',
      required: 'Ask a parent or guardian to tick the box first.',
      confirmed: 'A parent or guardian said yes.',
    },
    saved: {
      on: 'Saved. {{name}} is on.',
      off: 'Saved. {{name}} is off.',
    },
    saveFailed: 'Your choice was not saved, so it went back to how it was.',
    empty: {
      title: 'Finish setting up first',
      hint: 'Your privacy choices appear once your plan is set up. It only takes a few questions.',
      action: 'Set up my plan',
    },
    error: {
      title: 'We could not load your choices',
      retry: 'Try again',
    },
  },
} satisfies MessageBundle;
