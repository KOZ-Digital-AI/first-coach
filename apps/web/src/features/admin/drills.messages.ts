import type { MessageBundle } from '../../lib/i18n';

// Admin drill actions copy (routes/admin/drills.tsx). Namespace `drills` (from the file name); registered by the eager glob in
// lib/i18n.ts, so no central catalogue is edited. The words of the four trust statuses are the trust badge's own (namespace
// `trust-badge`) and generic failures come from `problem`, so neither is repeated here.
//
// KAZAKH (and Russian) TEXT STILL NEEDS A NATIVE-SPEAKER REVIEW (bead fc-cjh). No noun has to agree with a variable: the drill
// title, the organisation, the reviewer and the reason are always placed after a colon or inside quotation marks.
//
// `unpublish.body` is the CONSEQUENCE sentence of the confirm dialog: the drill leaves the library at once and its media stop
// being public (fc-mol-0v3.5), and this screen has no way to bring it back.
export default {
  kk: {
    eyebrow: 'Әкімші',
    title: 'Жаттығулар',
    lead: 'Жарияланған әр жаттығу және оған қаншалықты сенуге болатыны. Мәртебесін өзгертіңіз немесе жаттығуды жариялаудан алыңыз.',
    loading: 'Жаттығулар жүктелуде…',
    list: 'Жарияланған жаттығулар',
    more: 'Тағы жаттығулар көрсету',
    empty: {
      title: 'Жарияланған жаттығу әлі жоқ',
      hint: 'Жаттығу мақұлданған соң осында пайда болады.',
    },
    error: { title: 'Жаттығуларды жүктей алмадық', retry: 'Қайталау' },
    row: {
      changeStatus: 'Мәртебені өзгерту',
      unpublish: 'Жариялаудан алу',
      latest: 'Соңғы тексеру',
      by: '{{reviewer}}, {{date}}',
      moved: 'Бұрын: {{from}}. Енді: {{to}}',
      org: 'Ұйым: {{org}}',
      saved: 'Мәртебе сақталды.',
    },
    status: {
      form: 'Мәртебені өзгерту: {{title}}',
      legend: 'Жаңа мәртебе',
      note: {
        label: 'Тексерушінің ескертпесі',
        hint: 'Неге дәл осы мәртебе. Ол тексеру жазбасымен бірге сақталады.',
      },
      org: {
        label: 'Ұйым',
        hint: 'Академия тексерген мәртебесі үшін міндетті, мысалы «FC Kairat Academy». Сарапшы тексерген үшін міндетті емес.',
      },
      save: 'Мәртебені сақтау',
      saving: 'Сақталуда…',
      cancel: 'Бас тарту',
      errors: {
        choose: 'Жаңа мәртебені таңдаңыз.',
        note: 'Осы шешім туралы ескертпе жазыңыз.',
        org: 'Академия тексерген мәртебесі үшін ұйымның атауы керек.',
        same: 'Жаттығуда бұл мәртебе бұрыннан бар. Тізімді жаңартып көріңіз.',
      },
    },
    unpublish: {
      title: 'Жариялаудан алу: «{{title}}»?',
      body: 'Ол кітапханадан бәріне бірден жоғалады, медиафайлдары жалпыға қолжетімсіз болады. Мұнда мұны қайтару мүмкін емес.',
      reason: {
        label: 'Себебі',
        hint: 'Тексеру жазбасымен бірге сақталады, мысалы құқық иесінің шағымы.',
      },
      cancel: 'Жарияланған күйде қалдыру',
      confirm: 'Иә, жариялаудан алу',
      errors: { reason: 'Жариялаудан алу себебін жазыңыз.' },
    },
    takenDown: '«{{title}}» жариялаудан алынды. Себебі: {{reason}}',
  },
  ru: {
    eyebrow: 'Администратор',
    title: 'Упражнения',
    lead: 'Каждое опубликованное упражнение и степень доверия к нему. Задайте статус или снимите упражнение с публикации.',
    loading: 'Загружаем упражнения…',
    list: 'Опубликованные упражнения',
    more: 'Показать ещё упражнения',
    empty: {
      title: 'Опубликованных упражнений пока нет',
      hint: 'Упражнение появится здесь после одобрения.',
    },
    error: { title: 'Не удалось загрузить упражнения', retry: 'Повторить' },
    row: {
      changeStatus: 'Изменить статус',
      unpublish: 'Снять с публикации',
      latest: 'Последняя проверка',
      by: '{{reviewer}}, {{date}}',
      moved: 'Было: {{from}}. Стало: {{to}}',
      org: 'Организация: {{org}}',
      saved: 'Статус сохранён.',
    },
    status: {
      form: 'Изменить статус: {{title}}',
      legend: 'Новый статус',
      note: {
        label: 'Заметка проверяющего',
        hint: 'Почему выбран именно этот статус. Она сохранится вместе с записью о проверке.',
      },
      org: {
        label: 'Организация',
        hint: 'Обязательна для статуса «Проверено академией», например «FC Kairat Academy». Для статуса эксперта необязательна.',
      },
      save: 'Сохранить статус',
      saving: 'Сохраняем…',
      cancel: 'Отмена',
      errors: {
        choose: 'Выберите новый статус.',
        note: 'Напишите заметку об этом решении.',
        org: 'Для статуса «Проверено академией» нужно название организации.',
        same: 'У упражнения уже такой статус. Попробуйте обновить список.',
      },
    },
    unpublish: {
      title: 'Снять с публикации: «{{title}}»?',
      body: 'Упражнение сразу исчезнет из библиотеки для всех, а его медиафайлы перестанут быть общедоступными. Отсюда это не отменить.',
      reason: {
        label: 'Причина',
        hint: 'Сохраняется вместе с записью о проверке, например жалоба правообладателя.',
      },
      cancel: 'Оставить опубликованным',
      confirm: 'Да, снять с публикации',
      errors: { reason: 'Напишите причину снятия с публикации.' },
    },
    takenDown: '«{{title}}» снято с публикации. Причина: {{reason}}',
  },
  en: {
    eyebrow: 'Admin',
    title: 'Drills',
    lead: 'Every published drill and how far it is trusted. Set its status, or take it down.',
    loading: 'Loading drills…',
    list: 'Published drills',
    more: 'Show more drills',
    empty: {
      title: 'No published drills yet',
      hint: 'A drill appears here once it has been approved.',
    },
    error: { title: 'We could not load the drills', retry: 'Try again' },
    row: {
      changeStatus: 'Change status',
      unpublish: 'Unpublish',
      latest: 'Latest review',
      by: 'By {{reviewer}}, {{date}}',
      moved: 'Changed from {{from}} to {{to}}',
      org: 'Organisation: {{org}}',
      saved: 'Status saved.',
    },
    status: {
      form: 'Change status: {{title}}',
      legend: 'New status',
      note: {
        label: 'Reviewer note',
        hint: 'Why this status. It is saved with the review.',
      },
      org: {
        label: 'Organisation',
        hint: 'Required for Academy verified, for example “FC Kairat Academy”. Optional for Expert verified.',
      },
      save: 'Save status',
      saving: 'Saving…',
      cancel: 'Cancel',
      errors: {
        choose: 'Choose the new status.',
        note: 'Write a note about this decision.',
        org: 'Academy verified needs the name of the organisation.',
        same: 'This drill already has that status. Try refreshing the list.',
      },
    },
    unpublish: {
      title: 'Unpublish “{{title}}”?',
      body: 'It leaves the library for everyone right away and its media stop being public. You cannot undo this from here.',
      reason: {
        label: 'Reason',
        hint: 'Kept with the review record, for example a rights complaint.',
      },
      cancel: 'Keep it published',
      confirm: 'Unpublish drill',
      errors: { reason: 'Write a reason to unpublish.' },
    },
    takenDown: '“{{title}}” was unpublished. Reason: {{reason}}',
  },
} satisfies MessageBundle;
