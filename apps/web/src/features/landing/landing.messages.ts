import type { MessageBundle } from '../../lib/i18n';

// Landing page copy (the / route). Namespace `landing` (from the file name); registered by the eager glob in lib/i18n.ts.
//
// Calm, honest words for a child, a parent or a volunteer coach: the page names what the product is and does, and makes
// no promise about the future (no monument, no professional career; PRODUCT.md and DESIGN.md).
// Kazakh text still needs a native-speaker review (bead fc-cjh).
//
// - `card.summary.*` are the three sentences of the dark hero card, written in capitals as the criteria give them. They are
//   stored in capitals (not uppercased by CSS) so the words on screen and the words in the file are the same.
// - The stat labels (`stats.<id>`) are noun phrases that read as a heading before the number ("Sports: 1"), so no plural
//   agreement is needed in ru or kk and the three locales keep identical keys.
// - The how-it-works copy does not mention AI or "verified" drills: the product works with the LLM off, and the seeded drills
//   are community drafts.
export default {
  kk: {
    eyebrow: 'Open Sport Commons · Genesis шығарылымы',
    headline: 'Әрбір бала тамаша алғашқы бапкерге лайық.',
    intro:
      'Жаттықтырушылардың біліміне негізделген тегін, ашық жүйе: дағдыңды тексер, жоспар ал, жаттық, өз өсуіңді көр, келесі қадамға көш.',
    cta: {
      start: 'Жаттығуды бастау',
      contribute: 'Үлес қосу',
    },
    card: {
      label: 'Арнау',
      summary: {
        years: '60 ЖЫЛ.',
        sessions: '60 АШЫҚ ЖАТТЫҒУ.',
        free: 'ӘРКІМГЕ ТЕГІН.',
      },
      credit: 'KOZ AI жасаған.',
      dedication: 'Қайрат Боранбаевтың 60 жасқа толған күнінде бәріне ашылды.',
    },
    stats: {
      label: 'Сандармен',
      drills: 'Ашық жаттығулар',
      tracks: 'Дағды бағыттары',
      contributions: 'Қауымдастық үлестері',
      sports: 'Спорт түрлері',
      loading: 'Сандар жүктелуде',
      empty: {
        title: 'Әзірге ештеңе жарияланған жоқ',
        hint: 'Алғашқы жаттығулар жарияланған соң сандар осы жерде шығады.',
      },
      error: {
        title: 'Сандар жүктелмеді.',
        message: 'Бет қалған бөлігімен жұмыс істейді. Қайталап көріңіз.',
        retry: 'Қайталау',
      },
    },
    how: {
      eyebrow: 'Бұл қалай жұмыс істейді',
      title: 'Жаттығулар каталогы емес. Дағдыларды дамыту жүйесі.',
      intro:
        'FIRST COACH дағдылар картасына негізделген: әр дағды алдыңғы дағдымен, тексерумен, жаттығумен және келесі қадаммен байланысқан. Жаттығулар Open Sport Commons ашық білім қорынан алынады, оны кез келген адам жақсарта алады.',
      steps: {
        s1: {
          title: 'Өзіңді тексер',
          body: 'Қысқа алғашқы тексеру негізгі дағдылар бойынша қазіргі деңгейіңді көрсетеді.',
        },
        s2: {
          title: 'Жоспар ал',
          body: 'Жүйе әлсіз тұстарыңды таңдап, уақытыңа, орныңа және құралдарыңа сай жоспар құрады.',
        },
        s3: {
          title: 'Жаттық',
          body: 'Жаттығулар қадам-қадаммен жүреді: жиі кететін қателер, жеңілдетілген және күрделірек нұсқасы бар.',
        },
        s4: {
          title: 'Өсуіңді көр',
          body: 'Тексеруді қайталап, өз бұрынғы нәтижеңмен салыстыр. Басқа біреумен емес.',
        },
        s5: {
          title: 'Білім қос',
          body: 'Кез келген жаттықтырушы әдіс, бейне немесе жақсарту ұсына алады.',
        },
        s6: {
          title: 'Commons-ты жақсарт',
          body: 'Қарағаннан кейін үлесің ашық білім қорының бір бөлігіне айналады.',
        },
      },
    },
  },
  ru: {
    eyebrow: 'Open Sport Commons · Genesis-релиз',
    headline: 'Каждый ребёнок заслуживает отличного первого тренера.',
    intro:
      'Бесплатная открытая система, которая опирается на знания тренеров: проверь навыки, получи план, тренируйся, смотри свой прогресс и делай следующий шаг.',
    cta: {
      start: 'Начать тренировку',
      contribute: 'Добавить свой вклад',
    },
    card: {
      label: 'Посвящение',
      summary: {
        years: '60 ЛЕТ.',
        sessions: '60 ОТКРЫТЫХ ТРЕНИРОВОК.',
        free: 'БЕСПЛАТНО ДЛЯ ВСЕХ.',
      },
      credit: 'Создано KOZ AI.',
      dedication: 'Открыто для всех в день 60-летия Кайрата Боранбаева.',
    },
    stats: {
      label: 'В цифрах',
      drills: 'Открытые упражнения',
      tracks: 'Направления навыков',
      contributions: 'Вклады сообщества',
      sports: 'Виды спорта',
      loading: 'Цифры загружаются',
      empty: {
        title: 'Пока ничего не опубликовано',
        hint: 'Цифры появятся здесь, когда будут опубликованы первые упражнения.',
      },
      error: {
        title: 'Цифры не загрузились.',
        message: 'Остальная страница работает. Попробуйте ещё раз.',
        retry: 'Повторить',
      },
    },
    how: {
      eyebrow: 'Как это работает',
      title: 'Не каталог упражнений. Система развития навыков.',
      intro:
        'FIRST COACH строится вокруг карты навыков: каждый навык связан с предыдущим, с проверкой, упражнениями и следующим шагом. Упражнения берутся из открытой базы знаний Open Sport Commons, которую может улучшить любой человек.',
      steps: {
        s1: {
          title: 'Оцени себя',
          body: 'Короткая первая проверка показывает, на каком уровне ты сейчас по ключевым навыкам.',
        },
        s2: {
          title: 'Получи план',
          body: 'Система выбирает слабые места и собирает план под твоё время, место и инвентарь.',
        },
        s3: {
          title: 'Тренируйся',
          body: 'Пошаговые занятия с упражнениями, типичными ошибками, более лёгким и более сложным вариантом.',
        },
        s4: {
          title: 'Смотри свой прогресс',
          body: 'Повторяй проверки и сравнивай себя с самим собой прежним, а не с другими.',
        },
        s5: {
          title: 'Добавляй знания',
          body: 'Любой тренер может предложить методику, видео или улучшение.',
        },
        s6: {
          title: 'Улучшай Commons',
          body: 'После проверки вклад становится частью открытой базы знаний.',
        },
      },
    },
  },
  en: {
    eyebrow: 'Open Sport Commons · Genesis release',
    headline: 'Every child deserves a great first coach.',
    intro:
      "A free, open system built on coaches' knowledge: check your skills, get a plan, train, see your own progress and take the next step.",
    cta: {
      start: 'Start training',
      contribute: 'Contribute',
    },
    card: {
      label: 'Dedication',
      summary: {
        years: '60 YEARS.',
        sessions: '60 OPEN TRAINING SESSIONS.',
        free: 'FREE FOR EVERYONE.',
      },
      credit: 'Created by KOZ AI.',
      dedication: 'Opened to everyone on the 60th birthday of Kairat Boranbayev.',
    },
    stats: {
      label: 'In numbers',
      drills: 'Open drills',
      tracks: 'Skill tracks',
      contributions: 'Community contributions',
      sports: 'Sports',
      loading: 'Loading the numbers',
      empty: {
        title: 'Nothing published yet',
        hint: 'The numbers will appear here once the first drills are published.',
      },
      error: {
        title: "The numbers didn't load.",
        message: 'The rest of the page works. Try again in a moment.',
        retry: 'Try again',
      },
    },
    how: {
      eyebrow: 'How it works',
      title: 'Not a catalogue of drills. A system for building skills.',
      intro:
        'FIRST COACH is built around a skill map: each skill is linked to the one before it, to a check, to drills and to the next step. Drills come from Open Sport Commons, an open knowledge base that anyone can improve.',
      steps: {
        s1: {
          title: 'Check yourself',
          body: 'A short first check shows where you are on the key skills.',
        },
        s2: {
          title: 'Get a plan',
          body: 'The system picks your weaker spots and builds a plan around your time, place and equipment.',
        },
        s3: {
          title: 'Train',
          body: 'Step-by-step sessions with drills, common mistakes, an easier and a harder version.',
        },
        s4: {
          title: 'See your progress',
          body: 'Repeat the checks and compare yourself with your own earlier results, not with anyone else.',
        },
        s5: {
          title: 'Add knowledge',
          body: 'Any coach can suggest a method, a video or an improvement.',
        },
        s6: {
          title: 'Improve the Commons',
          body: 'After review, a contribution becomes part of the open knowledge base.',
        },
      },
    },
  },
} satisfies MessageBundle;
