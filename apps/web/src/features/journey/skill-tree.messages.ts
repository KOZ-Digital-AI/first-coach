import type { MessageBundle } from '../../lib/i18n';

/*
 * Strings of the skill tree (My Journey). Namespace = file base name (`skill-tree`), collected by the `*.messages.ts`
 * glob in lib/i18n.ts, so nothing outside this file registers it.
 * `states` is keyed by the contract's node state (shared/journey NODE_STATES). `progress` takes the mastered count and the
 * track's node count through {{done}} and {{total}}; the sentence is worded per language so no plural form is needed.
 * Kazakh text still needs a native review.
 */
export default {
  kk: {
    treeLabel: 'Дағды бағыттары',
    levelLabel: 'Бағыт деңгейі',
    progress: '{{total}} ішінен {{done}} меңгерілді',
    states: {
      mastered: 'Меңгерілді',
      training: 'Қазір жаттығуда',
      locked: 'Жабық',
    },
    emptyTrack: 'Бұл бағытта әзірше дағды жоқ.',
    emptyTitle: 'Әзірше дағды жоқ',
    emptyHint: 'Бастапқы тесттен кейін бағыттарың осында пайда болады.',
  },
  ru: {
    treeLabel: 'Направления навыков',
    levelLabel: 'Уровень направления',
    progress: 'Освоено {{done}} из {{total}}',
    states: {
      mastered: 'Освоено',
      training: 'Тренировка сейчас',
      locked: 'Закрыто',
    },
    emptyTrack: 'В этом направлении пока нет навыков.',
    emptyTitle: 'Пока нет навыков',
    emptyHint: 'Твои направления появятся здесь после первых тестов.',
  },
  en: {
    treeLabel: 'Skill tracks',
    levelLabel: 'Track level',
    progress: '{{done}} of {{total}} mastered',
    states: {
      mastered: 'Mastered',
      training: 'Training now',
      locked: 'Locked',
    },
    emptyTrack: 'No skills in this track yet.',
    emptyTitle: 'No skills to show yet',
    emptyHint: 'Your tracks will appear here after your first tests.',
  },
} satisfies MessageBundle;
