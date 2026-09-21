import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the retest screen (/progress/retest/:testSlug). Namespace = file base name (`retest`), collected by the
 * `*.messages.ts` glob in lib/i18n.ts, so nothing outside this file registers it. Generic failures (offline, server, ...)
 * live in lib/problem.messages.ts and are shown through describeProblem, never worded here.
 *
 * Placeholders: {{unit}} (the API's plain-text unit, shown as sent), {{value}} (a number with its unit, already formatted).
 * Tone: the player is only ever compared with their own earlier results. A lower result is "lower than last time", never a
 * failure, and is followed by encouragement to keep going; nothing here celebrates, scolds or promises a future.
 * Kazakh text still needs a native-speaker review.
 */
export default {
  kk: {
    eyebrow: 'Дағды тексеруі',
    title: 'Қайта тест',
    lead: 'Тексеруді қайта орындап, нәтижеңді енгіз. Өзіңді тек өзіңнің бұрынғы нәтижелеріңмен салыстырасың.',
    back: 'Менің жолым',
    loading: 'Тексеруді жүктеп жатырмыз',
    direction: {
      higher: 'Көп болған сайын жақсы',
      lower: 'Аз болған сайын жақсы',
    },
    protocol: { title: 'Қалай орындау керек' },
    previous: {
      label: 'Алдыңғы нәтижең:',
      none: 'Бұрын нәтиже болған жоқ. Бүгін сенің бастапқы нүктең.',
    },
    form: {
      label: 'Бүгінгі нәтижең',
      hint: 'Өлшем бірлігі: {{unit}}.',
      submit: 'Нәтижені сақтау',
    },
    invalid: {
      empty: 'Нәтижеңді енгіз.',
      notNumber: 'Тек сандарды қолдан.',
      negative: 'Нәтиже нөлден кем болмайды.',
      whole: 'Бүтін сан керек.',
      tooBig: 'Бұл сан тым үлкен.',
    },
    saveError: {
      title: 'Нәтижені сақтай алмадық',
      hint: 'Саның орнында тұр. «Нәтижені сақтау» түймесін қайта бас.',
    },
    result: {
      title: 'Нәтиже сақталды',
      previous: 'Алдыңғы нәтижең:',
      today: 'Бүгін:',
      first: 'Бұл сенің алғашқы нәтижең. Келесі жолы қаншалықты өскеніңді көресің.',
      better: 'Алдыңғы жолдан жақсы',
      same: 'Алдыңғы жолмен бірдей',
      lower: 'Алдыңғыдан төмен',
      personalBest: 'Жаңа жеке рекорд: {{value}}',
      personalBestKept: 'Жеке рекорд: {{value}}',
      encourageTitle: 'Нәтиже кейде өседі, кейде төмендейді. Бұл қалыпты жағдай.',
      encourageHint: 'Жоспарыңмен жаттығуды жалғастыр. Келесі тест бүгінгі нәтижеден басталады.',
    },
    actions: {
      journey: 'Менің жолыма оралу',
      plan: 'Жоспарды жалғастыру',
    },
    empty: {
      noJourney: {
        title: 'Жолың алғашқы тестен басталады',
        hint: 'Қысқа тест жасап, алғашқы жаттығуды орында. Сосын тестті осында қайта тапсыра аласың.',
        action: 'ЖАТТЫҒУДЫ БАСТАУ',
      },
      unknown: {
        title: 'Бұл дағды тексеруін білмейміз',
        hint: 'Сілтеме қате немесе тексеру жойылған болуы мүмкін. Жолыңнан басқасын таңда.',
        action: 'Менің жолыма оралу',
      },
    },
    error: {
      title: 'Дағды тексеруін жүктей алмадық',
      retry: 'Қайталау',
    },
  },
  ru: {
    eyebrow: 'Проверка навыка',
    title: 'Повторный тест',
    lead: 'Пройди проверку ещё раз и введи результат. Ты сравниваешься только со своими прежними результатами.',
    back: 'Мой путь',
    loading: 'Загружаем проверку',
    direction: {
      higher: 'Чем больше, тем лучше',
      lower: 'Чем меньше, тем лучше',
    },
    protocol: { title: 'Как выполнить' },
    previous: {
      label: 'Твой прошлый результат:',
      none: 'Раньше результата не было. Сегодня твоя точка отсчёта.',
    },
    form: {
      label: 'Твой результат сегодня',
      hint: 'Единица измерения: {{unit}}.',
      submit: 'Сохранить результат',
    },
    invalid: {
      empty: 'Введи результат.',
      notNumber: 'Используй только цифры.',
      negative: 'Результат не может быть меньше нуля.',
      whole: 'Нужно целое число.',
      tooBig: 'Это число слишком большое.',
    },
    saveError: {
      title: 'Не удалось сохранить результат',
      hint: 'Твоё число осталось на месте. Нажми «Сохранить результат» ещё раз.',
    },
    result: {
      title: 'Результат сохранён',
      previous: 'Твой прошлый результат:',
      today: 'Сегодня:',
      first: 'Это твой первый результат. В следующий раз ты увидишь, как вырос.',
      better: 'Лучше, чем в прошлый раз',
      same: 'Так же, как в прошлый раз',
      lower: 'Ниже, чем в прошлый раз',
      personalBest: 'Новый личный рекорд: {{value}}',
      personalBestKept: 'Личный рекорд: {{value}}',
      encourageTitle: 'Результаты то растут, то снижаются. Это нормально.',
      encourageHint: 'Продолжай заниматься по своему плану. Следующий тест начнётся с сегодняшнего результата.',
    },
    actions: {
      journey: 'Вернуться к моему пути',
      plan: 'Продолжить план',
    },
    empty: {
      noJourney: {
        title: 'Твой путь начинается с первого теста',
        hint: 'Пройди короткий тест и первое упражнение. Потом здесь можно будет пройти тест ещё раз.',
        action: 'НАЧАТЬ ТРЕНИРОВКУ',
      },
      unknown: {
        title: 'Мы не знаем такой проверки',
        hint: 'Возможно, ссылка неверна или проверку убрали. Выбери другую на своём пути.',
        action: 'Вернуться к моему пути',
      },
    },
    error: {
      title: 'Не удалось загрузить проверку',
      retry: 'Повторить',
    },
  },
  en: {
    eyebrow: 'Skill check',
    title: 'Retest',
    lead: 'Do the check again and enter your result. You are compared only with your own earlier results.',
    back: 'My journey',
    loading: 'Loading your skill check',
    direction: {
      higher: 'More is better',
      lower: 'Less is better',
    },
    protocol: { title: 'How to do it' },
    previous: {
      label: 'Your previous result:',
      none: 'No earlier result yet. Today is your starting point.',
    },
    form: {
      label: 'Your result today',
      hint: 'Enter it in {{unit}}.',
      submit: 'Save result',
    },
    invalid: {
      empty: 'Enter your result.',
      notNumber: 'Use digits only.',
      negative: 'A result cannot be negative.',
      whole: 'Use a whole number.',
      tooBig: 'That number is too big.',
    },
    saveError: {
      title: 'We could not save your result',
      hint: 'Your number is still here. Press Save result to try again.',
    },
    result: {
      title: 'Your result is saved',
      previous: 'Your previous result:',
      today: 'Today:',
      first: 'This is your first result. Next time you will see how far you have come.',
      better: 'Better than last time',
      same: 'Same as last time',
      lower: 'Lower than last time',
      personalBest: 'New personal best: {{value}}',
      personalBestKept: 'Personal best: {{value}}',
      encourageTitle: 'Results go up and down, and that is normal.',
      encourageHint: 'Keep following your plan. Your next retest starts from today.',
    },
    actions: {
      journey: 'Back to my journey',
      plan: 'Continue my plan',
    },
    empty: {
      noJourney: {
        title: 'Your journey starts with the first check',
        hint: 'Do a short skill check and a first drill. Then you can retest here.',
        action: 'START TRAINING',
      },
      unknown: {
        title: 'We do not know this skill check',
        hint: 'The link may be wrong, or the check was removed. Pick one from your journey.',
        action: 'Back to my journey',
      },
    },
    error: {
      title: 'We could not load this skill check',
      retry: 'Try again',
    },
  },
} satisfies MessageBundle;
