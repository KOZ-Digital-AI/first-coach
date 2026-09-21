import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { aiPlanUnknownIds } from '../shared/ai';
import { DrillDetail, DrillListResponse, SkillGraph, graphProblems } from '../shared/commons';
import { CommonsStats } from '../shared/stats';
import { DrillContent } from '../shared/primitives';
import type { LocalizedText } from '../shared/primitives';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { DEFAULT_LIMIT, InvalidCursorError, MAX_LIMIT, getDrill, getSkillGraph, getStats, listDrills, listPublishedVersions } from './repo';

// Every test runs on a fresh in-memory database migrated with the real migrations, so the
// repository is exercised against the exact schema (STRICT tables, CHECKs, FKs, the
// immutability trigger) and no temp file is left behind.

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  seedGraph(db);
});

afterEach(() => {
  db.close();
});

// --- fixtures ------------------------------------------------------------------------------

const INJECTION = "'; DROP TABLE drills;--";

/** A text with all three locales, so an unrelated test never depends on the fallback. */
const t = (en: string): LocalizedText => ({ kk: `${en} (kk)`, ru: `${en} (ru)`, en });

function seedGraph(d: Database): void {
  d.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp1', 'football', '{"ru":"Футбол","en":"Football"}', '2.1.0')`);
  d.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp2', 'futsal', '{"en":"Futsal"}', '1.0.0')`);
  const skill = d.query(
    `INSERT INTO skills (id, slug, sport_id, parent_id, sort_order, names, levels, age_min, age_max, equipment, safety, outcomes, mistakes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const none = '[]';
  skill.run('k-ball', 'ball-control', 'sp1', null, 1, '{"ru":"Контроль мяча","en":"Ball control"}', none, 5, 99, 'ball', none, none, none);
  skill.run(
    'k-touch', 'first-touch', 'sp1', 'k-ball', 2, '{"kk":"Алғашқы тию","ru":"Первое касание","en":"First touch"}',
    '[{"ru":"Уровень 1","en":"Level 1"},{"en":"Level 2"}]', 6, 12, 'ball',
    '[{"en":"Clear the area"}]', '[{"ru":"Точный приём","en":"Clean reception"}]', '[{"en":"Heavy touch"}]',
  );
  skill.run('k-juggle', 'juggling', 'sp1', 'k-ball', 1, '{"en":"Juggling"}', none, 5, 99, 'ball', none, none, none);
  skill.run('k-adv', 'advanced-juggling', 'sp1', 'k-juggle', 1, '{"en":"Advanced juggling"}', none, 8, 99, 'ball', none, none, none);
  skill.run('k-fut', 'futsal-control', 'sp2', null, 1, '{"en":"Futsal control"}', none, 5, 99, 'ball', none, none, none);
  d.run(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('k-touch', 'k-juggle', 2)`);
  d.run(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('k-touch', 'k-adv', 3)`);
}

const SKILL_IDS: Record<string, string> = {
  'ball-control': 'k-ball',
  'first-touch': 'k-touch',
  juggling: 'k-juggle',
  'advanced-juggling': 'k-adv',
  'futsal-control': 'k-fut',
};

interface DrillSpec {
  slug: string;
  sport?: 'sp1' | 'sp2';
  /** `null` = a content without a title (the goal stands in). */
  title?: LocalizedText | null;
  goal?: LocalizedText;
  /** The first entry is the primary skill (the drill's track). */
  skills?: string[];
  status?: string;
  level?: string;
  equipment?: string;
  spaces?: string[];
  partner?: boolean;
  ageMin?: number;
  ageMax?: number;
  minutes?: number;
  origin?: string;
  unpublished?: boolean;
  /** The drill row exists and has a version, but is not linked to it yet (loader mid-way). */
  noCurrent?: boolean;
}

function contentOf(spec: Pick<DrillSpec, 'slug' | 'title' | 'goal' | 'equipment' | 'spaces' | 'partner' | 'ageMin' | 'ageMax'>): DrillContent {
  const conditions: Record<string, unknown> = {
    equipment: spec.equipment ?? 'cones',
    spaces: spec.spaces ?? ['yard'],
    partner: spec.partner ?? false,
  };
  if (spec.ageMin !== undefined) conditions.ageMin = spec.ageMin;
  if (spec.ageMax !== undefined) conditions.ageMax = spec.ageMax;
  return DrillContent.parse({
    ...(spec.title === null ? {} : { title: spec.title ?? t(spec.slug) }),
    goal: spec.goal ?? t(`Goal of ${spec.slug}`),
    instructions: t(`Do ${spec.slug}`),
    dose: { reps: 10 },
    mistakes: [t('Ball too far')],
    conditions,
    safety: [t('Clear the area')],
    media: [{ kind: 'video', url: 'https://example.org/v.mp4', caption: t('Demo') }],
  });
}

interface VersionSpec {
  id: string;
  drillId: string;
  semver?: string;
  parent?: string | null;
  status?: string;
  level?: string;
  minutes?: number;
  origin?: string;
  createdAt?: string;
  changeSummary?: string | null;
  sourceUrl?: string | null;
  content: DrillContent;
}

function insertVersion(v: VersionSpec): void {
  const c = v.content.conditions;
  db.query(
    `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space,
       partner, age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url,
       origin, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CC-BY-SA-4.0', 'Coach A', NULL, 'FIRST COACH Genesis', ?, ?, ?, ?)`,
  ).run(
    v.id, v.drillId, v.semver ?? '1.0.0', v.parent ?? null, v.status ?? 'COMMUNITY', JSON.stringify(v.content),
    c.equipment, c.spaces[0] as string, c.partner ? 1 : 0, c.ageMin ?? null, c.ageMax ?? null,
    v.level ?? 'basic', v.minutes ?? 10, v.sourceUrl === undefined ? 'https://example.org/source' : v.sourceUrl,
    v.origin ?? 'seed', v.changeSummary ?? null, v.createdAt ?? '2026-01-01T00:00:00.000Z',
  );
}

/** Inserts a drill with one version (`<slug>-v1`, current unless `noCurrent`) and its skill links. */
function addDrill(spec: DrillSpec): void {
  const id = spec.slug;
  db.query(`INSERT INTO drills (id, slug, sport_id, unpublished_at) VALUES (?, ?, ?, ?)`).run(
    id, spec.slug, spec.sport ?? 'sp1', spec.unpublished ? '2026-03-01T00:00:00.000Z' : null,
  );
  insertVersion({
    id: `${spec.slug}-v1`, drillId: id, status: spec.status, level: spec.level, minutes: spec.minutes, origin: spec.origin,
    content: contentOf(spec),
  });
  if (!spec.noCurrent) db.query(`UPDATE drills SET current_version_id = ? WHERE id = ?`).run(`${spec.slug}-v1`, id);
  (spec.skills ?? ['first-touch']).forEach((slug, index) => {
    db.query(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES (?, ?, ?)`).run(id, SKILL_IDS[slug] as string, index === 0 ? 1 : 0);
  });
}

function setCurrent(drillId: string, versionId: string): void {
  db.query(`UPDATE drills SET current_version_id = ? WHERE id = ?`).run(versionId, drillId);
}

function addReview(versionId: string, over: { reviewer?: string; org?: string; from?: string; to?: string; note?: string; at: string }): void {
  db.query(
    `INSERT INTO reviews (drill_version_id, reviewer, org_label, from_status, to_status, note, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(versionId, over.reviewer ?? 'Coach B', over.org ?? '', over.from ?? 'COMMUNITY', over.to ?? 'REVIEWED', over.note ?? '', over.at);
}

/** Four published drills plus two that must never show up (unpublished; not linked to a version yet). */
function catalog(): void {
  addDrill({ slug: 'five-gate-slalom', title: t('Five-Gate Slalom'), skills: ['first-touch', 'juggling'], status: 'COMMUNITY', level: 'basic', equipment: 'cones', spaces: ['yard'], minutes: 10 });
  addDrill({ slug: 'wall-passing', title: t('Wall Passing'), skills: ['first-touch'], status: 'REVIEWED', level: 'beginner', equipment: 'ball_wall', spaces: ['yard', 'gym'], minutes: 15, ageMin: 8, ageMax: 14 });
  addDrill({ slug: 'juggling-ladder', title: t('Juggling Ladder'), skills: ['juggling'], status: 'EXPERT_VERIFIED', level: 'intermediate', equipment: 'ball', spaces: ['field'], partner: true, minutes: 20 });
  addDrill({ slug: 'home-footwork', title: t('Home Footwork'), skills: ['ball-control'], status: 'COMMUNITY', level: 'beginner', equipment: 'nothing', spaces: ['home_3x3'], minutes: 5 });
  addDrill({ slug: 'hidden-drill', title: t('Hidden Drill'), skills: ['advanced-juggling', 'first-touch'], status: 'REVIEWED', level: 'basic', equipment: 'cones', unpublished: true, origin: 'contribution' });
  addDrill({ slug: 'half-loaded', title: t('Half Loaded'), skills: ['futsal-control', 'first-touch'], status: 'REVIEWED', level: 'basic', equipment: 'cones', noCurrent: true });
}

const slugs = (items: { slug: string }[]) => items.map((i) => i.slug);
const tableCount = (name: string) => (db.query(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n;

// --- listDrills ------------------------------------------------------------------------------

describe('listDrills: rows and unpublished exclusion', () => {
  test('returns the published drills as contract DrillSummary items, sorted by resolved title then slug', () => {
    catalog();
    const res = DrillListResponse.parse(listDrills(db, {}, 'en'));

    expect(slugs(res.items)).toEqual(['five-gate-slalom', 'home-footwork', 'juggling-ladder', 'wall-passing']);
    expect(res.total).toBe(4);
    expect(res.nextCursor).toBeNull();
    expect(res.items[0]).toEqual({
      slug: 'five-gate-slalom',
      title: t('Five-Gate Slalom'),
      track: 'first-touch', // the primary skill, not juggling
      level: 'basic',
      minutes: 10,
      equipment: 'cones',
      space: 'yard',
      status: 'COMMUNITY',
      versionId: 'five-gate-slalom-v1',
    });
  });

  test('an unpublished drill, and one not yet linked to a version, are absent from items, total and every facet', () => {
    catalog();
    const res = listDrills(db, {}, 'en');

    expect(slugs(res.items)).not.toContain('hidden-drill');
    expect(slugs(res.items)).not.toContain('half-loaded');
    expect(res.total).toBe(4);
    // hidden-drill is the only drill on advanced-juggling and half-loaded the only one on futsal-control
    const skillSlugs = res.facets.skills.map((s) => s.slug);
    expect(skillSlugs).not.toContain('advanced-juggling');
    expect(skillSlugs).not.toContain('futsal-control');
    // their extra first-touch link and their statuses do not inflate the counts
    expect(res.facets.skills.find((s) => s.slug === 'first-touch')?.count).toBe(2);
    expect(res.facets.statuses.find((s) => s.value === 'REVIEWED')?.count).toBe(1);
    // filtering by their skill finds nothing
    expect(listDrills(db, { skill: 'advanced-juggling' }, 'en').items).toEqual([]);
  });

  test('a drill unpublished later disappears; nothing is left in the list for it', () => {
    catalog();
    db.run(`UPDATE drills SET unpublished_at = '2026-04-01T00:00:00.000Z' WHERE slug = 'wall-passing'`);
    const res = listDrills(db, {}, 'en');
    expect(slugs(res.items)).toEqual(['five-gate-slalom', 'home-footwork', 'juggling-ladder']);
    expect(res.total).toBe(3);
  });

  test('a drill without a primary skill (no track) is not listed, so every item is a valid summary', () => {
    catalog();
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d-x', 'no-track', 'sp1')`);
    insertVersion({ id: 'x-v1', drillId: 'd-x', content: contentOf({ slug: 'no-track' }) });
    setCurrent('d-x', 'x-v1');
    const res = DrillListResponse.parse(listDrills(db, {}, 'en'));
    expect(slugs(res.items)).not.toContain('no-track');
  });

  test('the summary describes the CURRENT version, not an older one', () => {
    catalog();
    insertVersion({
      id: 'five-gate-slalom-v2', drillId: 'five-gate-slalom', semver: '1.1.0', parent: 'five-gate-slalom-v1',
      status: 'REVIEWED', level: 'intermediate', minutes: 12, createdAt: '2026-02-01T00:00:00.000Z',
      content: contentOf({ slug: 'five-gate-slalom', title: t('Slalom Reloaded'), equipment: 'ball' }),
    });
    setCurrent('five-gate-slalom', 'five-gate-slalom-v2');

    const res = listDrills(db, {}, 'en');
    const item = res.items.find((i) => i.slug === 'five-gate-slalom');
    expect(item).toMatchObject({ versionId: 'five-gate-slalom-v2', status: 'REVIEWED', level: 'intermediate', minutes: 12, equipment: 'ball', title: t('Slalom Reloaded') });
    expect(slugs(listDrills(db, { status: 'COMMUNITY' }, 'en').items)).not.toContain('five-gate-slalom');
    expect(slugs(listDrills(db, { status: 'REVIEWED' }, 'en').items)).toContain('five-gate-slalom');
  });

  test('an empty commons lists nothing with empty facets', () => {
    const res = DrillListResponse.parse(listDrills(db, {}, 'ru'));
    expect(res).toMatchObject({ items: [], nextCursor: null, total: 0, facets: { skills: [], statuses: [], equipment: [], levels: [] } });
  });
});

describe('listDrills: filters', () => {
  test('skill matches any skill the drill trains, not only its track', () => {
    catalog();
    expect(slugs(listDrills(db, { skill: 'juggling' }, 'en').items)).toEqual(['five-gate-slalom', 'juggling-ladder']);
    expect(slugs(listDrills(db, { skill: 'first-touch' }, 'en').items)).toEqual(['five-gate-slalom', 'wall-passing']);
  });

  test('status, equipment and level each narrow the list', () => {
    catalog();
    expect(slugs(listDrills(db, { status: 'REVIEWED' }, 'en').items)).toEqual(['wall-passing']);
    expect(slugs(listDrills(db, { equipment: 'ball' }, 'en').items)).toEqual(['juggling-ladder']);
    expect(slugs(listDrills(db, { level: 'beginner' }, 'en').items)).toEqual(['home-footwork', 'wall-passing']);
  });

  test('filters combine with AND', () => {
    catalog();
    expect(slugs(listDrills(db, { skill: 'first-touch', level: 'beginner' }, 'en').items)).toEqual(['wall-passing']);
    expect(listDrills(db, { skill: 'first-touch', level: 'beginner', status: 'COMMUNITY' }, 'en').items).toEqual([]);
  });

  test('an unknown skill matches nothing', () => {
    catalog();
    const res = listDrills(db, { skill: 'no-such-skill' }, 'en');
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  test('injection-shaped skill / status / equipment / level values are inert', () => {
    catalog();
    const before = tableCount('drills');
    for (const filters of [
      { skill: INJECTION }, { status: INJECTION }, { equipment: INJECTION }, { level: INJECTION },
    ]) {
      const res = listDrills(db, filters as never, 'en');
      expect(res.items).toEqual([]);
    }
    expect(tableCount('drills')).toBe(before);
    expect(tableCount('drill_versions')).toBeGreaterThan(0);
  });
});

describe('listDrills: q search', () => {
  test('matches the title case-insensitively, including non-ASCII (Cyrillic) case', () => {
    catalog();
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d-ru', 'ru-drill', 'sp1')`);
    insertVersion({ id: 'ru-v1', drillId: 'd-ru', content: contentOf({ slug: 'ru-drill', title: { ru: 'Удар по МЯЧУ', en: 'Ball strike' } }) });
    setCurrent('d-ru', 'ru-v1');
    db.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES ('d-ru', 'k-touch', 1)`);

    expect(slugs(listDrills(db, { q: 'juggling' }, 'en').items)).toEqual(['juggling-ladder']);
    expect(slugs(listDrills(db, { q: 'WALL PASS' }, 'en').items)).toEqual(['wall-passing']);
    expect(slugs(listDrills(db, { q: 'по мячу' }, 'ru').items)).toEqual(['ru-drill']);
  });

  test('matches the goal text too', () => {
    catalog();
    addDrill({ slug: 'goal-match', title: t('Plain'), goal: t('Improve the weak foot'), skills: ['juggling'] });
    expect(slugs(listDrills(db, { q: 'weak foot' }, 'en').items)).toEqual(['goal-match']);
  });

  test('searches the text as resolved for the requested locale: ru text answers a kk query when kk is missing', () => {
    addDrill({ slug: 'only-ru', title: { ru: 'Слалом между конусами' }, goal: { ru: 'Контроль' } });
    expect(slugs(listDrills(db, { q: 'слалом' }, 'kk').items)).toEqual(['only-ru']);
    expect(slugs(listDrills(db, { q: 'слалом' }, 'ru').items)).toEqual(['only-ru']);
  });

  test('an empty or blank q is no filter', () => {
    catalog();
    expect(listDrills(db, { q: '' }, 'en').total).toBe(4);
    expect(listDrills(db, { q: '   ' }, 'en').total).toBe(4);
    expect(listDrills(db, {}, 'en').total).toBe(4);
  });

  test('% and _ are literal characters, not wildcards', () => {
    catalog();
    addDrill({ slug: 'percent', title: { en: '100% Control' }, goal: { en: 'Percent' }, skills: ['juggling'] });
    addDrill({ slug: 'underscore', title: { en: 'Under_score' }, goal: { en: 'Under' }, skills: ['juggling'] });

    expect(slugs(listDrills(db, { q: '%' }, 'en').items)).toEqual(['percent']);
    expect(slugs(listDrills(db, { q: '_' }, 'en').items)).toEqual(['underscore']);
    expect(slugs(listDrills(db, { q: '100%' }, 'en').items)).toEqual(['percent']);
    expect(listDrills(db, { q: '%%' }, 'en').items).toEqual([]);
    expect(listDrills(db, { q: 'w_ll' }, 'en').items).toEqual([]); // would match "Wall" as a LIKE pattern
  });

  test('an injection-shaped q is inert and matches nothing', () => {
    catalog();
    const before = tableCount('drills');
    expect(listDrills(db, { q: INJECTION }, 'en').items).toEqual([]);
    expect(listDrills(db, { q: "' OR '1'='1" }, 'en').items).toEqual([]);
    expect(tableCount('drills')).toBe(before);
  });

  test('q combines with the other filters and its facets follow the match', () => {
    catalog();
    const res = listDrills(db, { q: 'a', skill: 'juggling' }, 'en');
    expect(slugs(res.items)).toEqual(['five-gate-slalom', 'juggling-ladder']); // both contain an "a"
    expect(listDrills(db, { q: 'ladder', skill: 'first-touch' }, 'en').items).toEqual([]);
    expect(listDrills(db, { q: 'ladder' }, 'en').facets.statuses).toEqual([{ value: 'EXPERT_VERIFIED', count: 1 }]);
  });
});

describe('listDrills: facets', () => {
  test('count the published drills, in contract order (status/level/equipment enum order; skills by count then slug)', () => {
    catalog();
    const { facets } = listDrills(db, {}, 'en');

    expect(facets.statuses).toEqual([
      { value: 'COMMUNITY', count: 2 },
      { value: 'REVIEWED', count: 1 },
      { value: 'EXPERT_VERIFIED', count: 1 },
    ]);
    expect(facets.levels).toEqual([
      { value: 'beginner', count: 2 },
      { value: 'basic', count: 1 },
      { value: 'intermediate', count: 1 },
    ]);
    expect(facets.equipment).toEqual([
      { value: 'nothing', count: 1 },
      { value: 'ball', count: 1 },
      { value: 'ball_wall', count: 1 },
      { value: 'cones', count: 1 },
    ]);
    // a drill counts under every skill it trains
    expect(facets.skills.map((s) => [s.slug, s.count])).toEqual([['first-touch', 2], ['juggling', 2], ['ball-control', 1]]);
  });

  test('CHOICE: counts are over the FILTERED result set, including the facet own filter (no facet-ignores-itself)', () => {
    catalog();
    const byStatus = listDrills(db, { status: 'REVIEWED' }, 'en').facets;
    expect(byStatus.statuses).toEqual([{ value: 'REVIEWED', count: 1 }]);
    expect(byStatus.levels).toEqual([{ value: 'beginner', count: 1 }]);

    const bySkill = listDrills(db, { skill: 'juggling' }, 'en').facets;
    expect(bySkill.statuses).toEqual([{ value: 'COMMUNITY', count: 1 }, { value: 'EXPERT_VERIFIED', count: 1 }]);
    // the matched drills are counted under all their skills
    expect(bySkill.skills.map((s) => [s.slug, s.count])).toEqual([['juggling', 2], ['first-touch', 1]]);
  });

  test('cover the whole filtered set, not the page: limit and cursor change items only', () => {
    catalog();
    const full = listDrills(db, {}, 'en');
    const page1 = listDrills(db, { limit: 1 }, 'en');
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(4);
    expect(page1.facets).toEqual(full.facets);

    const page2 = listDrills(db, { limit: 1, cursor: page1.nextCursor as string }, 'en');
    expect(page2.facets).toEqual(full.facets);
    expect(page2.total).toBe(4);
  });

  test('skill facets carry the names in the requested locale (fallback ru then en)', () => {
    catalog();
    const names = (locale: 'kk' | 'ru' | 'en') =>
      Object.fromEntries(listDrills(db, {}, locale).facets.skills.map((s) => [s.slug, s.names]));

    // first-touch has kk; juggling has only en; ball-control has ru and en
    expect(names('kk')['first-touch']?.kk).toBe('Алғашқы тию');
    expect(names('kk').juggling?.kk).toBe('Juggling');
    expect(names('kk')['ball-control']?.kk).toBe('Контроль мяча');
    expect(names('en')['ball-control']?.en).toBe('Ball control');
  });
});

describe('listDrills: locale fallback (requested -> ru -> en)', () => {
  const titleFor = (title: LocalizedText, locale: 'kk' | 'ru' | 'en') => {
    addDrill({ slug: 'loc', title, goal: { en: 'g' } });
    const item = DrillListResponse.parse(listDrills(db, {}, locale)).items.find((i) => i.slug === 'loc');
    return item?.title as LocalizedText;
  };

  test('a present requested-locale text is used as is', () => {
    expect(titleFor({ kk: 'Қазақша', ru: 'Русский', en: 'English' }, 'kk')).toEqual({ kk: 'Қазақша', ru: 'Русский', en: 'English' });
  });

  test('kk missing falls back to ru', () => {
    const title = titleFor({ ru: 'Русский', en: 'English' }, 'kk');
    expect(title.kk).toBe('Русский');
  });

  test('kk and ru missing fall back to en', () => {
    const title = titleFor({ en: 'English' }, 'kk');
    expect(title.kk).toBe('English');
  });

  test('en missing falls back to ru, never to kk', () => {
    const title = titleFor({ kk: 'Қазақша', ru: 'Русский' }, 'en');
    expect(title.en).toBe('Русский');
  });

  test('a blank requested-locale text counts as missing', () => {
    expect(titleFor({ kk: '   ', ru: 'Русский', en: 'English' }, 'kk').kk).toBe('Русский');
  });

  test('the other locales stay in the object', () => {
    expect(titleFor({ ru: 'Русский', en: 'English' }, 'kk')).toEqual({ kk: 'Русский', ru: 'Русский', en: 'English' });
  });

  test('a content without a title uses its goal as the summary title', () => {
    addDrill({ slug: 'untitled', title: null, goal: { ru: 'Цель', en: 'The goal' } });
    const item = listDrills(db, {}, 'en').items.find((i) => i.slug === 'untitled');
    expect(item?.title).toMatchObject({ ru: 'Цель', en: 'The goal' });
  });
});

describe('listDrills: pagination', () => {
  const setup = () => {
    for (const [slug, title] of [['zulu', 'Zulu'], ['same-b', 'Same'], ['alpha', 'Alpha'], ['same-a', 'Same'], ['mid', 'Mid']] as const) {
      addDrill({ slug, title: { en: title }, goal: { en: 'g' } });
    }
  };

  test('orders by title then slug and pages through the whole list without gaps or repeats, including across tied titles', () => {
    setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = DrillListResponse.parse(listDrills(db, { limit: 2, cursor }, 'en'));
      expect(res.items.length).toBeLessThanOrEqual(2);
      seen.push(...slugs(res.items));
      cursor = res.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined);

    expect(seen).toEqual(['alpha', 'mid', 'same-a', 'same-b', 'zulu']);
    expect(pages).toBe(3);
  });

  test('the last page has a null nextCursor; an exact-fit page does not point to an empty page', () => {
    setup();
    const exact = listDrills(db, { limit: 5 }, 'en');
    expect(exact.items).toHaveLength(5);
    expect(exact.nextCursor).toBeNull();
    expect(listDrills(db, { limit: 4 }, 'en').nextCursor).not.toBeNull();
  });

  test('the cursor is opaque and keyset-based: rows inserted between pages neither repeat nor skip items', () => {
    setup();
    const page1 = listDrills(db, { limit: 3 }, 'en');
    expect(slugs(page1.items)).toEqual(['alpha', 'mid', 'same-a']); // page break inside the tied titles

    addDrill({ slug: 'aardvark', title: { en: 'Aardvark' }, goal: { en: 'g' } }); // sorts before the cursor
    addDrill({ slug: 'yak', title: { en: 'Yak' }, goal: { en: 'g' } }); // sorts after it
    const page2 = listDrills(db, { limit: 3, cursor: page1.nextCursor as string }, 'en');
    expect(slugs(page2.items)).toEqual(['same-b', 'yak', 'zulu']);
    expect(page2.nextCursor).toBeNull();
  });

  test('an undecodable cursor is refused with InvalidCursorError, not treated as page one', () => {
    setup();
    for (const cursor of ['not a cursor', 'e30', Buffer.from('{"k":1,"s":2}').toString('base64url')]) {
      expect(() => listDrills(db, { cursor }, 'en')).toThrow(InvalidCursorError);
    }
  });

  test('limit defaults, is capped at MAX_LIMIT, and never below one', () => {
    setup();
    expect(DEFAULT_LIMIT).toBeGreaterThanOrEqual(1);
    expect(MAX_LIMIT).toBeGreaterThanOrEqual(DEFAULT_LIMIT);
    expect(listDrills(db, {}, 'en').items).toHaveLength(5); // default limit covers a small list
    expect(listDrills(db, { limit: 1_000_000 }, 'en').items).toHaveLength(5); // capped, not an error
    expect(listDrills(db, { limit: 0 }, 'en').items).toHaveLength(1);
  });
});

// --- getDrill --------------------------------------------------------------------------------

describe('getDrill', () => {
  test('returns the current version as a contract DrillDetail with attribution', () => {
    catalog();
    const detail = DrillDetail.parse(getDrill(db, 'five-gate-slalom', 'en'));

    expect(detail.slug).toBe('five-gate-slalom');
    expect(detail.versionId).toBe('five-gate-slalom-v1');
    expect(detail.content).toEqual(contentOf({ slug: 'five-gate-slalom', title: t('Five-Gate Slalom') }));
    expect(detail.attribution).toEqual({
      author: 'Coach A',
      source: 'FIRST COACH Genesis',
      sourceUrl: 'https://example.org/source',
      license: 'CC-BY-SA-4.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      semver: '1.0.0',
    });
    expect(detail.reviews).toEqual([]);
  });

  test('a null source_url leaves sourceUrl out instead of sending null', () => {
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'no-url', 'sp1')`);
    insertVersion({ id: 'v1', drillId: 'd1', sourceUrl: null, content: contentOf({ slug: 'no-url' }) });
    setCurrent('d1', 'v1');
    const detail = DrillDetail.parse(getDrill(db, 'no-url', 'en'));
    expect('sourceUrl' in detail.attribution).toBe(false);
  });

  test('unknown, unpublished and not-yet-linked slugs return null (routes answer 404)', () => {
    catalog();
    expect(getDrill(db, 'nope', 'en')).toBeNull();
    expect(getDrill(db, 'hidden-drill', 'en')).toBeNull();
    expect(getDrill(db, 'half-loaded', 'en')).toBeNull();
  });

  test('an unpublished drill leaks neither history nor reviews', () => {
    catalog();
    insertVersion({ id: 'hidden-v2', drillId: 'hidden-drill', semver: '1.1.0', parent: 'hidden-drill-v1', content: contentOf({ slug: 'hidden-drill' }), createdAt: '2026-02-01T00:00:00.000Z' });
    addReview('hidden-drill-v1', { at: '2026-02-02T00:00:00.000Z', note: 'secret note' });

    expect(getDrill(db, 'hidden-drill', 'en')).toBeNull();
    // and republishing brings it back, proving the row and its rows were there
    db.run(`UPDATE drills SET unpublished_at = NULL WHERE slug = 'hidden-drill'`);
    expect(getDrill(db, 'hidden-drill', 'en')?.reviews[0]?.note).toBe('secret note');
  });

  test('an injection-shaped slug returns null and changes nothing', () => {
    catalog();
    const before = tableCount('drills');
    expect(getDrill(db, INJECTION, 'en')).toBeNull();
    expect(getDrill(db, "x' OR '1'='1", 'en')).toBeNull();
    expect(tableCount('drills')).toBe(before);
  });

  test('the current version supplies content and attribution even when it is not the newest; history lists every version, newest first', () => {
    catalog();
    // v3 is inserted before v2 but created later; current is v2 (an older version can be current)
    insertVersion({ id: 'v3', drillId: 'wall-passing', semver: '1.2.0', parent: 'wall-passing-v1', createdAt: '2026-03-01T00:00:00.000Z', changeSummary: 'third', content: contentOf({ slug: 'wall-passing', title: t('Third') }) });
    insertVersion({ id: 'v2', drillId: 'wall-passing', semver: '1.1.0', parent: 'wall-passing-v1', createdAt: '2026-02-01T00:00:00.000Z', changeSummary: 'second', content: contentOf({ slug: 'wall-passing', title: t('Second') }) });
    setCurrent('wall-passing', 'v2');

    const detail = DrillDetail.parse(getDrill(db, 'wall-passing', 'en'));
    expect(detail.history).toEqual([
      { versionId: 'v3', semver: '1.2.0', createdAt: '2026-03-01T00:00:00.000Z', note: 'third' },
      { versionId: 'v2', semver: '1.1.0', createdAt: '2026-02-01T00:00:00.000Z', note: 'second' },
      { versionId: 'wall-passing-v1', semver: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    // the content and attribution are the CURRENT version's (v2), not the newest
    expect(detail.versionId).toBe('v2');
    expect(detail.content.title).toEqual(t('Second'));
    expect(detail.attribution.semver).toBe('1.1.0');
  });

  test('history is ordered by created_at DESC alone: not by semver (text or numeric), not by insertion order; equal created_at falls back to later-inserted first', () => {
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('h', 'ordered-history', 'sp1')`);
    // Insertion order a, b, c, d, e. created_at order (oldest to newest): a, c, b, then d and e tied.
    // Text semver order descending is 1.0.5, 1.0.4, 1.0.3, 1.0.2, 1.0.10 and insertion order
    // descending is e, d, c, b, a: neither equals the expected order below, nor does their ascending twin.
    const versions: [id: string, semver: string, createdAt: string][] = [
      ['h-a', '1.0.2', '2026-01-10T00:00:00.000Z'],
      ['h-b', '1.0.10', '2026-05-10T00:00:00.000Z'],
      ['h-c', '1.0.3', '2026-03-10T00:00:00.000Z'],
      ['h-d', '1.0.4', '2026-06-10T00:00:00.000Z'],
      ['h-e', '1.0.5', '2026-06-10T00:00:00.000Z'],
    ];
    for (const [id, semver, createdAt] of versions) {
      insertVersion({ id, drillId: 'h', semver, createdAt, content: contentOf({ slug: 'ordered-history' }) });
    }
    setCurrent('h', 'h-a'); // the oldest is current: the order must not depend on it either

    const detail = DrillDetail.parse(getDrill(db, 'ordered-history', 'en'));
    expect(detail.history.map((h) => h.versionId)).toEqual(['h-e', 'h-d', 'h-b', 'h-c', 'h-a']);
    expect(detail.history.map((h) => h.semver)).toEqual(['1.0.5', '1.0.4', '1.0.10', '1.0.3', '1.0.2']);
    expect(detail.versionId).toBe('h-a');
  });

  test('history never contains another drill\'s versions', () => {
    catalog();
    const detail = getDrill(db, 'wall-passing', 'en');
    expect(detail?.history.map((h) => h.versionId)).toEqual(['wall-passing-v1']);
  });

  test('reviews of all the drill\'s versions come newest-first with the contract field names; other drills\' reviews are excluded', () => {
    catalog();
    insertVersion({ id: 'wall-v2', drillId: 'wall-passing', semver: '1.1.0', parent: 'wall-passing-v1', status: 'EXPERT_VERIFIED', createdAt: '2026-02-01T00:00:00.000Z', content: contentOf({ slug: 'wall-passing' }) });
    setCurrent('wall-passing', 'wall-v2');
    addReview('wall-passing-v1', { reviewer: 'Coach B', at: '2026-01-05T09:00:00.000Z', from: 'COMMUNITY', to: 'REVIEWED', note: 'first' });
    addReview('wall-v2', { reviewer: 'Coach C', org: 'FC Kairat Academy', at: '2026-02-05T09:00:00.000Z', from: 'REVIEWED', to: 'EXPERT_VERIFIED', note: 'second' });
    addReview('juggling-ladder-v1', { reviewer: 'Someone Else', at: '2026-05-01T00:00:00.000Z', note: 'other drill' });

    const detail = DrillDetail.parse(getDrill(db, 'wall-passing', 'en'));
    expect(detail.reviews).toEqual([
      { reviewer: 'Coach C', orgLabel: 'FC Kairat Academy', from: 'REVIEWED', to: 'EXPERT_VERIFIED', note: 'second', at: '2026-02-05T09:00:00.000Z' },
      { reviewer: 'Coach B', orgLabel: '', from: 'COMMUNITY', to: 'REVIEWED', note: 'first', at: '2026-01-05T09:00:00.000Z' },
    ]);
  });

  test('content text follows requested -> ru -> en, for every localized field, and keeps the other locales', () => {
    addDrill({
      slug: 'sparse', title: { ru: 'Русский заголовок', en: 'English title' }, goal: { en: 'English goal' },
    });
    const kk = DrillDetail.parse(getDrill(db, 'sparse', 'kk'));
    expect(kk.content.title).toEqual({ kk: 'Русский заголовок', ru: 'Русский заголовок', en: 'English title' }); // ru before en
    expect(kk.content.goal).toEqual({ kk: 'English goal', en: 'English goal' }); // kk and ru missing: en
    expect(kk.content.instructions.kk).toBe('Do sparse (kk)'); // present: untouched
    expect(kk.content.mistakes[0]).toEqual(t('Ball too far'));
    expect(kk.content.media[0]?.caption).toEqual(t('Demo'));

    const en = DrillDetail.parse(getDrill(db, 'sparse', 'en'));
    expect(en.content.goal).toEqual({ en: 'English goal' });
  });

  test('missing-locale fallback also applies inside lists (mistakes, safety)', () => {
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'lists', 'sp1')`);
    const content = DrillContent.parse({
      goal: { ru: 'Цель' }, instructions: { ru: 'Как' }, dose: { reps: 1 },
      mistakes: [{ ru: 'Ошибка' }], safety: [{ en: 'Careful' }],
      conditions: { equipment: 'cones', spaces: ['yard'] },
    });
    insertVersion({ id: 'v1', drillId: 'd1', content });
    setCurrent('d1', 'v1');
    const detail = DrillDetail.parse(getDrill(db, 'lists', 'kk'));
    expect(detail.content.mistakes[0]).toEqual({ kk: 'Ошибка', ru: 'Ошибка' });
    expect(detail.content.safety[0]).toEqual({ kk: 'Careful', en: 'Careful' });
    expect(detail.content.title).toBeUndefined();
  });
});

// --- getSkillGraph ---------------------------------------------------------------------------

describe('getSkillGraph', () => {
  test('returns the sport graph as a contract SkillGraph: version, only that sport\'s nodes, in depth-first tree order (siblings by order, then slug)', () => {
    const graph = SkillGraph.parse(getSkillGraph(db, 'football', 'en'));
    expect(graph.sport).toBe('football');
    expect(graph.version).toBe('2.1.0');
    expect(graph.nodes.map((n) => n.slug)).toEqual(['ball-control', 'juggling', 'advanced-juggling', 'first-touch']);
    expect(graphProblems(graph)).toEqual([]);

    const futsal = SkillGraph.parse(getSkillGraph(db, 'futsal', 'en'));
    expect(futsal.nodes.map((n) => n.slug)).toEqual(['futsal-control']);
  });

  test('maps parent to the parent slug (null for a root) and prerequisites to slug + minLevel', () => {
    const graph = SkillGraph.parse(getSkillGraph(db, 'football', 'en'));
    const node = (slug: string) => graph.nodes.find((n) => n.slug === slug);

    expect(node('ball-control')?.parent).toBeNull();
    expect(node('advanced-juggling')?.parent).toBe('juggling');
    expect(node('first-touch')?.prerequisites).toEqual([
      { skill: 'advanced-juggling', minLevel: 3 },
      { skill: 'juggling', minLevel: 2 },
    ]);
    expect(node('juggling')?.prerequisites).toEqual([]);
  });

  test('carries the node fields: order, ages, equipment, levels, safety, outcomes, mistakes', () => {
    const touch = SkillGraph.parse(getSkillGraph(db, 'football', 'en')).nodes.find((n) => n.slug === 'first-touch');
    expect(touch).toMatchObject({ order: 2, ageMin: 6, ageMax: 12, equipment: 'ball' });
    expect(touch?.levels).toHaveLength(2);
    expect(touch?.safety).toEqual([{ en: 'Clear the area' }]);
    expect(touch?.mistakes).toEqual([{ en: 'Heavy touch' }]);
  });

  test('names and node texts follow requested -> ru -> en', () => {
    const nodes = (locale: 'kk' | 'ru' | 'en') => SkillGraph.parse(getSkillGraph(db, 'football', locale)).nodes;
    const find = (locale: 'kk' | 'ru' | 'en', slug: string) => nodes(locale).find((n) => n.slug === slug);

    expect(find('kk', 'first-touch')?.names.kk).toBe('Алғашқы тию'); // present
    expect(find('kk', 'ball-control')?.names.kk).toBe('Контроль мяча'); // ru before en
    expect(find('kk', 'juggling')?.names.kk).toBe('Juggling'); // only en
    expect(find('en', 'ball-control')?.names.en).toBe('Ball control');
    expect(find('kk', 'first-touch')?.levels[1]?.kk).toBe('Level 2'); // level descriptions too
    expect(find('kk', 'first-touch')?.outcomes[0]?.kk).toBe('Точный приём');
  });

  test('an unknown sport returns null; an injection-shaped one too', () => {
    expect(getSkillGraph(db, 'curling', 'en')).toBeNull();
    expect(getSkillGraph(db, INJECTION, 'en')).toBeNull();
    expect(tableCount('sports')).toBe(2);
  });

  test('a sport without skills is an empty graph, not null', () => {
    db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp3', 'padel', '{"en":"Padel"}', '0.1.0')`);
    expect(SkillGraph.parse(getSkillGraph(db, 'padel', 'en'))).toEqual({ sport: 'padel', version: '0.1.0', nodes: [] });
  });
});

// --- getStats --------------------------------------------------------------------------------

describe('getStats', () => {
  test('an empty commons is all zeros except the seeded sports', () => {
    expect(CommonsStats.parse(getStats(db))).toEqual({ drills: 0, tracks: 0, contributions: 0, sports: 2 });
  });

  test('counts published drills, distinct tracks of published drills and sports; unpublished and unlinked drills count nowhere', () => {
    catalog();
    // published tracks: first-touch (x2), juggling, ball-control. hidden-drill (advanced-juggling)
    // and half-loaded (futsal-control) must not add tracks.
    expect(CommonsStats.parse(getStats(db))).toEqual({ drills: 4, tracks: 3, contributions: 0, sports: 2 });
  });

  test('unpublishing a drill lowers the counts', () => {
    catalog();
    db.run(`UPDATE drills SET unpublished_at = '2026-04-01T00:00:00.000Z' WHERE slug = 'home-footwork'`);
    expect(getStats(db)).toMatchObject({ drills: 3, tracks: 2 }); // ball-control had only that drill
  });

  test('contributions count contributed versions of published drills only', () => {
    catalog(); // hidden-drill is an unpublished contribution
    expect(getStats(db).contributions).toBe(0);

    insertVersion({ id: 'wall-v2', drillId: 'wall-passing', semver: '1.1.0', parent: 'wall-passing-v1', origin: 'contribution', createdAt: '2026-02-01T00:00:00.000Z', content: contentOf({ slug: 'wall-passing' }) });
    addDrill({ slug: 'community-drill', origin: 'contribution', skills: ['juggling'] });
    expect(getStats(db).contributions).toBe(2);
  });
});

// --- listPublishedVersions (planner candidates) ------------------------------------------------

describe('listPublishedVersions', () => {
  const versionIds = (rows: { versionId: string }[]) => rows.map((r) => r.versionId);

  test('returns the CURRENT version of every published drill and nothing else, ordered by slug', () => {
    catalog();
    insertVersion({ id: 'five-gate-slalom-v2', drillId: 'five-gate-slalom', semver: '1.1.0', parent: 'five-gate-slalom-v1', createdAt: '2026-02-01T00:00:00.000Z', content: contentOf({ slug: 'five-gate-slalom' }) });
    setCurrent('five-gate-slalom', 'five-gate-slalom-v2');
    insertVersion({ id: 'five-gate-slalom-v3', drillId: 'five-gate-slalom', semver: '1.2.0', parent: 'five-gate-slalom-v2', createdAt: '2026-03-01T00:00:00.000Z', content: contentOf({ slug: 'five-gate-slalom' }) }); // newest but not current

    const rows = listPublishedVersions(db, {});
    expect(rows.map((r) => r.slug)).toEqual(['five-gate-slalom', 'home-footwork', 'juggling-ladder', 'wall-passing']);
    expect(versionIds(rows)).toEqual(['five-gate-slalom-v2', 'home-footwork-v1', 'juggling-ladder-v1', 'wall-passing-v1']);
    // never the unpublished or unlinked drills, never an older or non-current version
    expect(versionIds(rows)).not.toContain('hidden-drill-v1');
    expect(versionIds(rows)).not.toContain('half-loaded-v1');
    expect(versionIds(rows)).not.toContain('five-gate-slalom-v3');
  });

  test('each row carries what the planner needs: ids, filter columns, skills, full content and attribution', () => {
    catalog();
    const wall = listPublishedVersions(db, {}).find((r) => r.slug === 'wall-passing');
    expect(wall).toMatchObject({
      drillId: 'wall-passing',
      slug: 'wall-passing',
      versionId: 'wall-passing-v1',
      sport: 'football',
      status: 'REVIEWED',
      level: 'beginner',
      equipment: 'ball_wall',
      space: 'yard',
      spaces: ['yard', 'gym'],
      partner: false,
      ageMin: 8,
      ageMax: 14,
      minutes: 15,
      track: 'first-touch',
      skills: ['first-touch'],
      content: contentOf({ slug: 'wall-passing', title: t('Wall Passing'), equipment: 'ball_wall', spaces: ['yard', 'gym'], ageMin: 8, ageMax: 14 }),
      attribution: {
        author: 'Coach A', source: 'FIRST COACH Genesis', sourceUrl: 'https://example.org/source',
        license: 'CC-BY-SA-4.0', createdAt: '2026-01-01T00:00:00.000Z', semver: '1.0.0',
      },
    });
    const slalom = listPublishedVersions(db, {}).find((r) => r.slug === 'five-gate-slalom');
    expect(slalom?.skills).toEqual(['first-touch', 'juggling']); // track first, then the rest by slug
    expect(slalom?.ageMin).toBeNull();
  });

  test('the version ids are exactly the planner candidate set: aiPlanUnknownIds accepts them and flags an old or hidden one', () => {
    catalog();
    insertVersion({ id: 'wall-v2', drillId: 'wall-passing', semver: '1.1.0', parent: 'wall-passing-v1', createdAt: '2026-02-01T00:00:00.000Z', content: contentOf({ slug: 'wall-passing' }) });
    setCurrent('wall-passing', 'wall-v2');
    const candidates = versionIds(listPublishedVersions(db, {}));
    const plan = (ids: string[]) => ({ items: ids.map((drillVersionId) => ({ drillVersionId, minutes: 5, reason: 'r' })) });

    expect(aiPlanUnknownIds(plan(['wall-v2', 'home-footwork-v1']), candidates)).toEqual([]);
    expect(aiPlanUnknownIds(plan(['wall-passing-v1', 'hidden-drill-v1', 'half-loaded-v1']), candidates)).toEqual(['wall-passing-v1', 'hidden-drill-v1', 'half-loaded-v1']);
  });

  test('space matches any of the drill spaces, not only the primary one', () => {
    catalog();
    expect(listPublishedVersions(db, { space: 'gym' }).map((r) => r.slug)).toEqual(['wall-passing']);
    expect(listPublishedVersions(db, { space: 'yard' }).map((r) => r.slug)).toEqual(['five-gate-slalom', 'wall-passing']);
  });

  test('equipment and levels are any-of lists', () => {
    catalog();
    expect(listPublishedVersions(db, { equipment: ['ball', 'ball_wall'] }).map((r) => r.slug)).toEqual(['juggling-ladder', 'wall-passing']);
    expect(listPublishedVersions(db, { levels: ['beginner'] }).map((r) => r.slug)).toEqual(['home-footwork', 'wall-passing']);
    expect(listPublishedVersions(db, { equipment: [] })).toEqual([]);
    expect(listPublishedVersions(db, { levels: [] })).toEqual([]);
  });

  test('age keeps drills whose range contains it; an absent bound is open', () => {
    catalog(); // wall-passing is 8-14, the rest have no age range
    expect(listPublishedVersions(db, { age: 10 }).map((r) => r.slug)).toEqual(['five-gate-slalom', 'home-footwork', 'juggling-ladder', 'wall-passing']);
    expect(listPublishedVersions(db, { age: 7 }).map((r) => r.slug)).not.toContain('wall-passing');
    expect(listPublishedVersions(db, { age: 15 }).map((r) => r.slug)).not.toContain('wall-passing');
    expect(listPublishedVersions(db, { age: 8 }).map((r) => r.slug)).toContain('wall-passing'); // bounds inclusive
    expect(listPublishedVersions(db, { age: 14 }).map((r) => r.slug)).toContain('wall-passing');
  });

  test('hasPartner: false drops partner drills, true and unset keep them', () => {
    catalog();
    expect(listPublishedVersions(db, { hasPartner: false }).map((r) => r.slug)).toEqual(['five-gate-slalom', 'home-footwork', 'wall-passing']);
    expect(listPublishedVersions(db, { hasPartner: true })).toHaveLength(4);
    expect(listPublishedVersions(db, {})).toHaveLength(4);
  });

  test('minStatus is a floor on the trust ladder', () => {
    catalog();
    expect(listPublishedVersions(db, { minStatus: 'COMMUNITY' })).toHaveLength(4);
    expect(listPublishedVersions(db, { minStatus: 'REVIEWED' }).map((r) => r.slug)).toEqual(['juggling-ladder', 'wall-passing']);
    expect(listPublishedVersions(db, { minStatus: 'EXPERT_VERIFIED' }).map((r) => r.slug)).toEqual(['juggling-ladder']);
    expect(listPublishedVersions(db, { minStatus: 'ACADEMY_VERIFIED' })).toEqual([]);
  });

  test('skills is any-of over every skill the drill trains; sport narrows to one sport', () => {
    catalog();
    addDrill({ slug: 'futsal-drill', sport: 'sp2', skills: ['futsal-control'] });
    expect(listPublishedVersions(db, { skills: ['juggling'] }).map((r) => r.slug)).toEqual(['five-gate-slalom', 'juggling-ladder']);
    expect(listPublishedVersions(db, { skills: ['ball-control', 'first-touch'] }).map((r) => r.slug)).toEqual(['five-gate-slalom', 'home-footwork', 'wall-passing']);
    expect(listPublishedVersions(db, { skills: [] })).toEqual([]);
    expect(listPublishedVersions(db, { sport: 'futsal' }).map((r) => r.slug)).toEqual(['futsal-drill']);
    expect(listPublishedVersions(db, { sport: 'football' }).map((r) => r.slug)).not.toContain('futsal-drill');
  });

  test('filters combine with AND', () => {
    catalog();
    const rows = listPublishedVersions(db, { skills: ['first-touch'], levels: ['beginner', 'basic'], hasPartner: false, minStatus: 'REVIEWED', age: 10, space: 'gym', equipment: ['ball_wall'] });
    expect(rows.map((r) => r.slug)).toEqual(['wall-passing']);
    expect(listPublishedVersions(db, { skills: ['first-touch'], minStatus: 'EXPERT_VERIFIED' })).toEqual([]);
  });

  test('injection-shaped filter values are inert', () => {
    catalog();
    const before = tableCount('drill_versions');
    const attack = INJECTION as never;
    expect(listPublishedVersions(db, { skills: [INJECTION] })).toEqual([]);
    expect(listPublishedVersions(db, { sport: INJECTION })).toEqual([]);
    expect(listPublishedVersions(db, { space: attack })).toEqual([]);
    expect(listPublishedVersions(db, { equipment: [attack] })).toEqual([]);
    expect(listPublishedVersions(db, { levels: [attack] })).toEqual([]);
    expect(listPublishedVersions(db, { minStatus: attack })).toEqual([]);
    expect(tableCount('drill_versions')).toBe(before);
  });
});
