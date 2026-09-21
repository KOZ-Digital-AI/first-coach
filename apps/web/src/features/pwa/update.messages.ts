import type { MessageBundle } from '../../lib/i18n';

// Update-available prompt copy (namespace `update`, from the file name; registered by the eager glob in lib/i18n.ts).
// `{{version}}` is the build the person is running now. The tone is the app's: plain and calm, no urgency: `later` is a
// perfectly good answer, and `reloadHint` says what accepting does so nobody is surprised mid-drill. "you" in the singular
// informal (сен / ты) like the drill screens.
// The Kazakh text is a first draft and still needs a native review, in particular `available` ("нұсқа" for "version") and
// `later` ("Кейінірек").
export default {
  kk: {
    available: 'Жаңа нұсқа қолжетімді',
    update: 'Жаңарту',
    later: 'Кейінірек',
    reloadHint: 'Жаңартқанда бет қайта жүктеледі.',
    failed: 'Жаңарту мүмкін болмады. Қайталап көр.',
    version: 'Қазіргі нұсқа: {{version}}',
  },
  ru: {
    available: 'Доступна новая версия',
    update: 'Обновить',
    later: 'Позже',
    reloadHint: 'При обновлении страница перезагрузится.',
    failed: 'Не удалось обновить. Попробуй ещё раз.',
    version: 'Текущая версия: {{version}}',
  },
  en: {
    available: 'New version available',
    update: 'Update',
    later: 'Later',
    reloadHint: 'The page reloads when you update.',
    failed: 'Could not update. Try again.',
    version: 'Current version: {{version}}',
  },
} satisfies MessageBundle;
