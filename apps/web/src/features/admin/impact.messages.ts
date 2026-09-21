import type { MessageBundle } from '../../lib/i18n';

// Admin impact screen copy (routes/admin/impact.tsx). Namespace `impact` (from the file name); registered by the eager glob in
// lib/i18n.ts, so no central catalogue is edited.
//
// KAZAKH (and Russian) TEXT STILL NEEDS A NATIVE-SPEAKER REVIEW (bead fc-cjh). The sentences are built so that no noun has to agree
// with a number in ru or kk: every count sits after a colon ("Players who retested: 318"), never inside a plural phrase.
//
// `{{players}}` is the number of players who retested, already formatted for the language by the screen.
export default {
  kk: {
    eyebrow: 'Әсер',
    title: 'Адамдар жақсарып жатыр ма?',
    lead: 'Ойыншылар өздерінің алғашқы нәтижесімен салыстырғанда қалай өсіп жатыр және оның артында қанша жаттығу мен ашық білім тұр. Тек жалпы сандар: ешбір ойыншының аты аталмайды.',
    loading: 'Әсер көрсеткіштері жүктелуде',
    refresh: {
      label: 'Жаңарту',
      busy: 'Жаңартылуда…',
      error: 'Сандарды жаңарта алмадық. Көрсетілгені соңғы сәтті жүктеуден алынған.',
    },
    error: { title: 'Әсер көрсеткіштерін жүктей алмадық', retry: 'Қайталау' },
    empty: {
      title: 'Әзірге көрсететін ештеңе жоқ',
      hint: 'Әлі дерек жазылмаған. Ойыншылар алғашқы тестті тапсырғанда немесе жаттығуды аяқтағанда сандар осында пайда болады.',
    },
    headline: {
      label: 'Жақсарудың медианасы',
      basis:
        'Ойыншының сол тесттегі алғашқы нәтижесінен соңғысына дейінгі өзгеріс. Кіші мән жақсы болатын тестте де жақсару оң болып саналады.',
      retested: 'Қайта тестілеген ойыншылар: {{players}}',
      up: 'Әдеттегі қайта тестілеу нәтижесі алғашқысынан жақсы.',
      flat: 'Әдеттегі қайта тестілеу нәтижесі алғашқысымен тең.',
      down: 'Әдеттегі қайта тестілеу нәтижесі алғашқысынан төмен.',
      none: 'Әзірге қайта тестілеу жоқ, салыстыратын ештеңе жоқ.',
    },
    groups: { players: 'Ойыншылар', practice: 'Жаттығу', commons: 'Ашық қор' },
    cards: {
      baseline: { label: 'Бастапқы нәтижесі бар ойыншылар', hint: 'Кемінде бір тест тапсырған.' },
      retested: { label: 'Қайта тестілеген ойыншылар', hint: 'Бір дағдыны кемінде екі рет тексерген.' },
      sessions: { label: 'Аяқталған сабақтар', hint: 'Барлық уақыттағы.' },
      hours: { label: 'Жаттығу сағаттары', hint: 'Аяқталған сабақтардағы орындалды деп белгіленген жаттығулардың уақыты.' },
      contributors: { label: 'Белсенді авторлар', hint: 'Соңғы 90 күнде үлес жіберген.' },
      coaches: { label: 'Тексерілген жаттықтырушылар', hint: 'Кемінде «Қаралған» деңгейімен әдісті қараған.' },
      methodologies: { label: 'Ашық әдістемелер', hint: 'Қорда жарияланған жаттығулар.' },
    },
    weeks: {
      title: 'Аптасына аяқталған сабақтар',
      lead: 'Апта дүйсенбіден басталады. Соңғы 12 апта, ескісінен бастап.',
      none: 'Осы 12 аптада бірде-бір сабақ аяқталмады.',
    },
  },
  ru: {
    eyebrow: 'Влияние',
    title: 'Становятся ли люди лучше?',
    lead: 'Как игроки растут по сравнению с собственным первым результатом и сколько практики и открытых знаний за этим стоит. Только общие числа: ни один игрок не назван.',
    loading: 'Загружаем показатели влияния',
    refresh: {
      label: 'Обновить',
      busy: 'Обновляем…',
      error: 'Не удалось обновить числа. Показаны данные последней успешной загрузки.',
    },
    error: { title: 'Не удалось загрузить показатели влияния', retry: 'Повторить' },
    empty: {
      title: 'Пока нечего показать',
      hint: 'Данных ещё нет. Числа появятся, когда игроки пройдут первый тест или завершат тренировку.',
    },
    headline: {
      label: 'Медианный рост',
      basis:
        'Изменение от первого результата игрока до последнего в том же тесте. Улучшение считается положительным и там, где лучше меньшее значение.',
      retested: 'Игроков с повторным тестом: {{players}}',
      up: 'Обычный повторный результат лучше первого.',
      flat: 'Обычный повторный результат равен первому.',
      down: 'Обычный повторный результат ниже первого.',
      none: 'Повторных тестов пока нет, сравнивать нечего.',
    },
    groups: { players: 'Игроки', practice: 'Практика', commons: 'Открытая база' },
    cards: {
      baseline: { label: 'Игроки с исходным результатом', hint: 'Прошли хотя бы один тест.' },
      retested: { label: 'Игроки с повторным тестом', hint: 'Проверили один навык хотя бы дважды.' },
      sessions: { label: 'Завершённые занятия', hint: 'За всё время.' },
      hours: { label: 'Часы тренировок', hint: 'Время упражнений, отмеченных выполненными, в завершённых занятиях.' },
      contributors: { label: 'Активные авторы', hint: 'Предложили вклад за последние 90 дней.' },
      coaches: { label: 'Проверяющие тренеры', hint: 'Проверили метод со статусом «Проверено» или выше.' },
      methodologies: { label: 'Открытые методики', hint: 'Опубликованные упражнения в базе.' },
    },
    weeks: {
      title: 'Завершённые занятия по неделям',
      lead: 'Неделя начинается в понедельник. Последние 12 недель, от старых к новым.',
      none: 'За эти 12 недель не завершено ни одного занятия.',
    },
  },
  en: {
    eyebrow: 'Impact',
    title: 'Are people getting better?',
    lead: 'How players improve against their own first result, and how much practice and open knowledge stands behind it. Totals only: no player is named.',
    loading: 'Loading impact numbers',
    refresh: {
      label: 'Refresh',
      busy: 'Refreshing…',
      error: 'We could not refresh the numbers. What you see is from the last successful load.',
    },
    error: { title: 'We could not load the impact numbers', retry: 'Try again' },
    empty: {
      title: 'No impact to show yet',
      hint: 'Nothing has been recorded so far. Numbers appear here after players take their first test or finish a session.',
    },
    headline: {
      label: 'Median improvement',
      basis:
        "Change from each player's first result to their latest one in the same test. A gain counts as positive whether the test rewards a higher or a lower value.",
      retested: 'Players who retested: {{players}}',
      up: 'The typical retest is better than the first result.',
      flat: 'The typical retest matches the first result.',
      down: 'The typical retest is below the first result.',
      none: 'No player has retested yet, so there is nothing to compare.',
    },
    groups: { players: 'Players', practice: 'Practice', commons: 'Open commons' },
    cards: {
      baseline: { label: 'Players with a baseline', hint: 'Took at least one test.' },
      retested: { label: 'Players who retested', hint: 'Tested the same skill at least twice.' },
      sessions: { label: 'Sessions completed', hint: 'All time.' },
      hours: { label: 'Training hours', hint: 'Time in drills marked done, in finished sessions.' },
      contributors: { label: 'Active contributors', hint: 'Submitted a contribution in the last 90 days.' },
      coaches: { label: 'Verified coaches', hint: 'Reviewed a method at Reviewed status or above.' },
      methodologies: { label: 'Open methodologies', hint: 'Published drills in the commons.' },
    },
    weeks: {
      title: 'Sessions completed per week',
      lead: 'Weeks start on Monday. The last 12 weeks, oldest first.',
      none: 'No sessions were completed in these 12 weeks.',
    },
  },
} satisfies MessageBundle;
