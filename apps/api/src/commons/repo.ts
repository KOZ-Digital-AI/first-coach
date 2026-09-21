// Commons read repository (fc-mol-f2u.12): every read of the Open Sport Commons goes through here.
//
// Consumers: the commons routes (list, detail, skill graph), the stats route and the planner's
// candidate filter. Every function takes the bun:sqlite Database as its first parameter (no
// module singleton) and is synchronous, like bun:sqlite. SQL uses bound parameters only: no
// caller-supplied value is ever concatenated into a statement.
//
// Rules that hold for EVERY read
//   - A drill is PUBLISHED when drills.unpublished_at IS NULL and current_version_id is set (a
//     drill mid-way through loading has no current version yet). Anything else is invisible:
//     not listed, not counted (stats, facets), not a planner candidate, and getDrill returns
//     null (routes answer 404) without touching its history or reviews.
//   - Text follows requested -> ru -> en (primitives' pickLocalized). Locale-aware results keep
//     every locale of a text and FILL the requested locale's slot from the fallback, so a client
//     that reads text[locale] always finds text, and the other locales are still there.
//
// CHOICES the contract leaves open (each pinned by a test):
//   - Facet counts are over the FILTERED result set (all filters, `q` included), never over the
//     page: limit and cursor change `items` only. A facet does not ignore its own filter.
//   - `q` is a literal, case-insensitive substring match on the title and goal resolved for the
//     requested locale. It is matched here in JS, not with SQL LIKE: SQLite lower() and LIKE
//     only fold ASCII, which would make Cyrillic and Kazakh search case-sensitive.
//   - Drills are ordered by resolved title (lower-cased), then slug; the cursor is keyset based
//     (the last item's title key and slug), so rows inserted between pages neither repeat nor
//     skip items.
//   - A drill without a primary skill has no `track`, which DrillSummary requires: it is not
//     listed until the loader links one.
//   - DrillDetail.history lists EVERY version of the drill (the current one included), newest
//     first; reviews cover all the drill's versions, newest first.
import type { Database } from 'bun:sqlite';
import type { DrillDetail, DrillFacets, DrillListResponse, DrillSummary, SkillGraph, SkillNode } from '../shared/commons';
import type { CommonsDrillQuery } from '../shared/commons-api';
import type { Attribution } from '../shared/domain';
import type { CommonsStats } from '../shared/stats';
import { EQUIPMENT, EXPERIENCE_LEVELS, TRUST_STATUSES, pickLocalized } from '../shared/primitives';
import type { DrillContent, Equipment, ExperienceLevel, Locale, LocalizedText, Space, TrustStatus } from '../shared/primitives';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** The `cursor` of a list request could not be decoded (routes answer 400 on the "/cursor" pointer). */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

// --- helpers ---------------------------------------------------------------------------------

type Bindings = Record<string, string | number | null>;

/** A drill the commons shows: not unpublished and linked to its current version. */
const PUBLISHED = 'd.unpublished_at IS NULL AND d.current_version_id IS NOT NULL';

/** Fills the requested locale's slot from requested -> ru -> en; a text with nothing usable is returned as is. */
function localize(text: LocalizedText, locale: Locale): LocalizedText {
  const picked = pickLocalized(text, locale);
  return picked === undefined ? text : { ...text, [locale]: picked };
}

const localizeAll = (texts: LocalizedText[], locale: Locale): LocalizedText[] => texts.map((text) => localize(text, locale));

function localizeContent(content: DrillContent, locale: Locale): DrillContent {
  return {
    ...content,
    ...(content.title === undefined ? {} : { title: localize(content.title, locale) }),
    goal: localize(content.goal, locale),
    instructions: localize(content.instructions, locale),
    mistakes: localizeAll(content.mistakes, locale),
    progressions: localizeAll(content.progressions, locale),
    regressions: localizeAll(content.regressions, locale),
    safety: localizeAll(content.safety, locale),
    media: content.media.map((media) => (media.caption === undefined ? media : { ...media, caption: localize(media.caption, locale) })),
  };
}

interface AttributionColumns {
  semver: string;
  license: string;
  author_name: string;
  source: string;
  source_url: string | null;
  created_at: string;
}

function attributionOf(row: AttributionColumns): Attribution {
  return {
    author: row.author_name,
    source: row.source,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    license: row.license as Attribution['license'],
    createdAt: row.created_at,
    semver: row.semver,
  };
}

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

/** Code-unit comparison: deterministic on every platform, unlike localeCompare. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- listDrills ------------------------------------------------------------------------------

/** The filters of GET /api/commons/drills; `locale` is the separate third argument. */
export type DrillListFilters = Omit<CommonsDrillQuery, 'locale'>;

interface ListRow {
  drillId: string;
  slug: string;
  versionId: string;
  status: string;
  level: string;
  minutes: number;
  equipment: string;
  space: string;
  title: string | null;
  goal: string;
  track: string;
}

interface Entry {
  drillId: string;
  summary: DrillSummary;
  /** Lower-cased resolved title, the primary sort key. */
  key: string;
}

interface Cursor {
  k: string;
  s: string;
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(text: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor> | null;
    if (typeof value?.k === 'string' && typeof value.s === 'string') return { k: value.k, s: value.s };
  } catch {
    // falls through to the error below
  }
  throw new InvalidCursorError();
}

const after = (entry: Entry, cursor: Cursor): boolean => {
  const byKey = compare(entry.key, cursor.k);
  return byKey > 0 || (byKey === 0 && compare(entry.summary.slug, cursor.s) > 0);
};

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function countBy<T extends string>(order: readonly T[], values: string[]): { value: T; count: number }[] {
  return order
    .map((value) => ({ value, count: values.filter((each) => each === value).length }))
    .filter((entry) => entry.count > 0);
}

export function listDrills(db: Database, filters: DrillListFilters, locale: Locale): DrillListResponse {
  const bindings: Bindings = {
    $status: filters.status ?? null,
    $equipment: filters.equipment ?? null,
    $level: filters.level ?? null,
    $skill: filters.skill ?? null,
  };
  const rows = db
    .query<ListRow, Bindings>(
      `SELECT d.id AS drillId, d.slug AS slug, v.id AS versionId, v.status AS status, v.level AS level,
              v.minutes AS minutes, v.equipment AS equipment, v.space AS space,
              json_extract(v.content, '$.title') AS title, json_extract(v.content, '$.goal') AS goal,
              pk.slug AS track
         FROM drills d
         JOIN drill_versions v ON v.id = d.current_version_id
         JOIN drill_skills ps ON ps.drill_id = d.id AND ps.is_primary = 1
         JOIN skills pk ON pk.id = ps.skill_id
        WHERE ${PUBLISHED}
          AND ($status IS NULL OR v.status = $status)
          AND ($equipment IS NULL OR v.equipment = $equipment)
          AND ($level IS NULL OR v.level = $level)
          AND ($skill IS NULL OR EXISTS (
                SELECT 1 FROM drill_skills fs JOIN skills fk ON fk.id = fs.skill_id
                 WHERE fs.drill_id = d.id AND fk.slug = $skill))`,
    )
    .all(bindings);

  const needle = (filters.q ?? '').trim().toLowerCase();
  const entries: Entry[] = [];
  for (const row of rows) {
    const goal = parseJson<LocalizedText>(row.goal);
    const title = row.title === null ? goal : parseJson<LocalizedText>(row.title);
    const resolvedTitle = pickLocalized(title, locale) ?? '';
    const searchable = [resolvedTitle, pickLocalized(goal, locale) ?? ''].map((text) => text.toLowerCase());
    if (needle !== '' && !searchable.some((text) => text.includes(needle))) continue;
    entries.push({
      drillId: row.drillId,
      key: resolvedTitle.toLowerCase(),
      summary: {
        slug: row.slug,
        title: localize(title, locale),
        track: row.track,
        level: row.level as ExperienceLevel,
        minutes: row.minutes,
        equipment: row.equipment as Equipment,
        space: row.space as Space,
        status: row.status as TrustStatus,
        versionId: row.versionId,
      },
    });
  }
  entries.sort((a, b) => compare(a.key, b.key) || compare(a.summary.slug, b.summary.slug));

  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const start = cursor === null ? 0 : entries.findIndex((entry) => after(entry, cursor));
  const from = start === -1 ? entries.length : start;
  const limit = clampLimit(filters.limit);
  const page = entries.slice(from, from + limit);
  const last = page[page.length - 1];
  const hasMore = from + limit < entries.length;

  return {
    items: page.map((entry) => entry.summary),
    nextCursor: hasMore && last !== undefined ? encodeCursor({ k: last.key, s: last.summary.slug }) : null,
    total: entries.length,
    facets: facetsOf(db, entries, locale),
  };
}

interface SkillLinkRow {
  drillId: string;
  slug: string;
  names: string;
}

function facetsOf(db: Database, entries: Entry[], locale: Locale): DrillFacets {
  const summaries = entries.map((entry) => entry.summary);

  const inSet = new Set(entries.map((entry) => entry.drillId));
  const skills = new Map<string, { names: LocalizedText; count: number }>();
  if (inSet.size > 0) {
    const links = db
      .query<SkillLinkRow, []>(
        `SELECT ds.drill_id AS drillId, s.slug AS slug, s.names AS names
           FROM drill_skills ds
           JOIN skills s ON s.id = ds.skill_id
           JOIN drills d ON d.id = ds.drill_id
          WHERE ${PUBLISHED}`,
      )
      .all();
    for (const link of links) {
      if (!inSet.has(link.drillId)) continue;
      const known = skills.get(link.slug);
      if (known) known.count += 1;
      else skills.set(link.slug, { names: parseJson<LocalizedText>(link.names), count: 1 });
    }
  }

  return {
    skills: [...skills.entries()]
      .map(([slug, { names, count }]) => ({ slug, names: localize(names, locale), count }))
      .sort((a, b) => b.count - a.count || compare(a.slug, b.slug)),
    statuses: countBy(TRUST_STATUSES, summaries.map((s) => s.status)),
    equipment: countBy(EQUIPMENT, summaries.map((s) => s.equipment)),
    levels: countBy(EXPERIENCE_LEVELS, summaries.map((s) => s.level)),
  };
}

// --- getDrill --------------------------------------------------------------------------------

interface DetailRow extends AttributionColumns {
  drillId: string;
  slug: string;
  versionId: string;
  content: string;
}

interface HistoryRow {
  id: string;
  semver: string;
  created_at: string;
  change_summary: string | null;
}

interface ReviewRow {
  reviewer: string;
  org_label: string;
  from_status: string;
  to_status: string;
  note: string;
  reviewed_at: string;
}

/** The current version of a published drill, or null (unknown, unpublished or not yet linked): routes answer 404. */
export function getDrill(db: Database, slug: string, locale: Locale): DrillDetail | null {
  const row = db
    .query<DetailRow, Bindings>(
      `SELECT d.id AS drillId, d.slug AS slug, v.id AS versionId, v.semver AS semver, v.content AS content,
              v.license AS license, v.author_name AS author_name, v.source AS source,
              v.source_url AS source_url, v.created_at AS created_at
         FROM drills d
         JOIN drill_versions v ON v.id = d.current_version_id
        WHERE d.slug = $slug AND ${PUBLISHED}`,
    )
    .get({ $slug: slug });
  if (row === null) return null;

  const history = db
    .query<HistoryRow, [string]>(
      `SELECT id, semver, created_at, change_summary FROM drill_versions
        WHERE drill_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(row.drillId);
  const reviews = db
    .query<ReviewRow, [string]>(
      `SELECT r.reviewer, r.org_label, r.from_status, r.to_status, r.note, r.reviewed_at
         FROM reviews r JOIN drill_versions v ON v.id = r.drill_version_id
        WHERE v.drill_id = ? ORDER BY r.reviewed_at DESC, r.id DESC`,
    )
    .all(row.drillId);

  return {
    slug: row.slug,
    versionId: row.versionId,
    content: localizeContent(parseJson<DrillContent>(row.content), locale),
    attribution: attributionOf(row),
    history: history.map((h) => ({
      versionId: h.id,
      semver: h.semver,
      createdAt: h.created_at,
      ...(h.change_summary === null ? {} : { note: h.change_summary }),
    })),
    reviews: reviews.map((r) => ({
      reviewer: r.reviewer,
      orgLabel: r.org_label,
      from: r.from_status as TrustStatus,
      to: r.to_status as TrustStatus,
      note: r.note,
      at: r.reviewed_at,
    })),
  };
}

// --- getSkillGraph ---------------------------------------------------------------------------

interface SportRow {
  id: string;
  slug: string;
  graph_version: string;
}

interface SkillRow {
  id: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  names: string;
  levels: string;
  age_min: number;
  age_max: number;
  equipment: string;
  safety: string;
  outcomes: string;
  mistakes: string;
}

interface PrerequisiteRow {
  skill_id: string;
  slug: string;
  min_level: number;
}

/** The skill graph of one sport, or null for an unknown sport. Nodes come depth-first: a parent before its children, siblings by order then slug. */
export function getSkillGraph(db: Database, sport: string, locale: Locale): SkillGraph | null {
  const sportRow = db.query<SportRow, [string]>(`SELECT id, slug, graph_version FROM sports WHERE slug = ?`).get(sport);
  if (sportRow === null) return null;

  const skills = db
    .query<SkillRow, [string]>(
      `SELECT id, slug, parent_id, sort_order, names, levels, age_min, age_max, equipment, safety, outcomes, mistakes
         FROM skills WHERE sport_id = ?`,
    )
    .all(sportRow.id);
  const prerequisites = db
    .query<PrerequisiteRow, [string]>(
      `SELECT p.skill_id AS skill_id, pre.slug AS slug, p.min_level AS min_level
         FROM skill_prerequisites p
         JOIN skills s ON s.id = p.skill_id
         JOIN skills pre ON pre.id = p.prerequisite_id
        WHERE s.sport_id = ?
        ORDER BY pre.slug`,
    )
    .all(sportRow.id);

  const slugOf = new Map(skills.map((skill) => [skill.id, skill.slug]));
  const children = new Map<string | null, SkillRow[]>();
  for (const skill of skills) {
    const siblings = children.get(skill.parent_id) ?? [];
    siblings.push(skill);
    children.set(skill.parent_id, siblings);
  }
  const bySiblingOrder = (a: SkillRow, b: SkillRow) => a.sort_order - b.sort_order || compare(a.slug, b.slug);

  const ordered: SkillRow[] = [];
  const seen = new Set<string>();
  const visit = (skill: SkillRow): void => {
    if (seen.has(skill.id)) return;
    seen.add(skill.id);
    ordered.push(skill);
    for (const child of (children.get(skill.id) ?? []).sort(bySiblingOrder)) visit(child);
  };
  for (const root of (children.get(null) ?? []).sort(bySiblingOrder)) visit(root);
  // Anything a parent cycle kept out of the walk still belongs to the graph.
  for (const skill of [...skills].sort(bySiblingOrder)) visit(skill);

  const nodes: SkillNode[] = ordered.map((skill) => ({
    slug: skill.slug,
    parent: skill.parent_id === null ? null : (slugOf.get(skill.parent_id) ?? null),
    order: skill.sort_order,
    names: localize(parseJson<LocalizedText>(skill.names), locale),
    levels: localizeAll(parseJson<LocalizedText[]>(skill.levels), locale),
    prerequisites: prerequisites
      .filter((p) => p.skill_id === skill.id)
      .map((p) => ({ skill: p.slug, minLevel: p.min_level })),
    ageMin: skill.age_min,
    ageMax: skill.age_max,
    equipment: skill.equipment as Equipment,
    safety: localizeAll(parseJson<LocalizedText[]>(skill.safety), locale),
    outcomes: localizeAll(parseJson<LocalizedText[]>(skill.outcomes), locale),
    mistakes: localizeAll(parseJson<LocalizedText[]>(skill.mistakes), locale),
  }));
  return { sport: sportRow.slug, version: sportRow.graph_version, nodes };
}

// --- getStats --------------------------------------------------------------------------------

/**
 * The landing-page counters. `drills` = published drills; `tracks` = distinct primary skills of
 * published drills (a track is what DrillSummary.track names); `contributions` = contributed
 * versions (origin 'contribution') of published drills, 0 until the contributions bead writes
 * them; `sports` = every sport. Unpublished and unlinked drills count nowhere.
 */
export function getStats(db: Database): CommonsStats {
  const row = db
    .query<CommonsStats, []>(
      `SELECT
         (SELECT count(*) FROM drills d WHERE ${PUBLISHED}) AS drills,
         (SELECT count(DISTINCT ds.skill_id) FROM drill_skills ds JOIN drills d ON d.id = ds.drill_id
           WHERE ds.is_primary = 1 AND ${PUBLISHED}) AS tracks,
         (SELECT count(*) FROM drill_versions v JOIN drills d ON d.id = v.drill_id
           WHERE v.origin = 'contribution' AND ${PUBLISHED}) AS contributions,
         (SELECT count(*) FROM sports) AS sports`,
    )
    .get();
  return row ?? { drills: 0, tracks: 0, contributions: 0, sports: 0 };
}

// --- listPublishedVersions (planner candidates) -----------------------------------------------

/**
 * The planner's candidate filter. Every field is optional and narrows (AND); the list fields
 * are any-of, so an empty list matches nothing. The policy (which levels or kit suit a player)
 * belongs to the planner: this only expresses it.
 */
export interface PublishedVersionFilter {
  /** Sport slug. */
  sport?: string;
  /** Any of these skill slugs (a drill trains several; its track is just one of them). */
  skills?: readonly string[];
  /** The drill can be done in this space (any of its conditions.spaces, not only the primary one). */
  space?: Space;
  /** The drill's kit is one of these. */
  equipment?: readonly Equipment[];
  /** The drill's level is one of these. */
  levels?: readonly ExperienceLevel[];
  /** The player's age; a drill matches when the age lies in its range, an absent bound being open. */
  age?: number;
  /** false = the player has no partner: drills that need one are dropped. true or unset keeps them. */
  hasPartner?: boolean;
  /** Trust floor: this status or a higher one (TRUST_STATUSES order). */
  minStatus?: TrustStatus;
}

/** The CURRENT version of a published drill, with what the planner and the session item need. */
export interface PublishedVersion {
  drillId: string;
  slug: string;
  sport: string;
  /** drill_versions.id: the id `aiPlanUnknownIds` and TodayItem.drillVersionId use. */
  versionId: string;
  status: TrustStatus;
  level: ExperienceLevel;
  equipment: Equipment;
  /** The primary space; `spaces` has them all. */
  space: Space;
  spaces: Space[];
  partner: boolean;
  ageMin: number | null;
  ageMax: number | null;
  minutes: number;
  /** The primary skill slug, null while the loader has not linked one. */
  track: string | null;
  /** Every skill slug the drill trains, the track first, the rest by slug. */
  skills: string[];
  /** The full stored content, every locale. */
  content: DrillContent;
  attribution: Attribution;
}

interface VersionRow extends AttributionColumns {
  drillId: string;
  slug: string;
  sport: string;
  versionId: string;
  status: string;
  level: string;
  equipment: string;
  space: string;
  partner: number;
  age_min: number | null;
  age_max: number | null;
  minutes: number;
  content: string;
}

interface DrillSkillRow {
  drillId: string;
  slug: string;
  is_primary: number;
}

export function listPublishedVersions(db: Database, filter: PublishedVersionFilter = {}): PublishedVersion[] {
  const list = (values: readonly string[] | undefined): string | null => (values === undefined ? null : JSON.stringify(values));
  const floor = filter.minStatus === undefined ? null : TRUST_STATUSES.slice(TRUST_STATUSES.indexOf(filter.minStatus));

  const rows = db
    .query<VersionRow, Bindings>(
      `SELECT d.id AS drillId, d.slug AS slug, sp.slug AS sport, v.id AS versionId, v.semver AS semver,
              v.status AS status, v.level AS level, v.equipment AS equipment, v.space AS space,
              v.partner AS partner, v.age_min AS age_min, v.age_max AS age_max, v.minutes AS minutes,
              v.content AS content, v.license AS license, v.author_name AS author_name, v.source AS source,
              v.source_url AS source_url, v.created_at AS created_at
         FROM drills d
         JOIN sports sp ON sp.id = d.sport_id
         JOIN drill_versions v ON v.id = d.current_version_id
        WHERE ${PUBLISHED}
          AND ($sport IS NULL OR sp.slug = $sport)
          AND ($space IS NULL OR EXISTS (SELECT 1 FROM json_each(v.content, '$.conditions.spaces') WHERE value = $space))
          AND ($equipment IS NULL OR v.equipment IN (SELECT value FROM json_each($equipment)))
          AND ($levels IS NULL OR v.level IN (SELECT value FROM json_each($levels)))
          AND ($statuses IS NULL OR v.status IN (SELECT value FROM json_each($statuses)))
          AND ($age IS NULL OR ((v.age_min IS NULL OR v.age_min <= $age) AND (v.age_max IS NULL OR v.age_max >= $age)))
          AND ($noPartner = 0 OR v.partner = 0)
          AND ($skills IS NULL OR EXISTS (
                SELECT 1 FROM drill_skills fs JOIN skills fk ON fk.id = fs.skill_id
                 WHERE fs.drill_id = d.id AND fk.slug IN (SELECT value FROM json_each($skills))))
        ORDER BY d.slug`,
    )
    .all({
      $sport: filter.sport ?? null,
      $space: filter.space ?? null,
      $equipment: list(filter.equipment),
      $levels: list(filter.levels),
      $statuses: list(floor ?? undefined),
      $age: filter.age ?? null,
      $noPartner: filter.hasPartner === false ? 1 : 0,
      $skills: list(filter.skills),
    });
  if (rows.length === 0) return [];

  const skillLinks = db
    .query<DrillSkillRow, []>(
      `SELECT ds.drill_id AS drillId, s.slug AS slug, ds.is_primary AS is_primary
         FROM drill_skills ds JOIN skills s ON s.id = ds.skill_id JOIN drills d ON d.id = ds.drill_id
        WHERE ${PUBLISHED}
        ORDER BY ds.is_primary DESC, s.slug`,
    )
    .all();
  const skillsOf = new Map<string, DrillSkillRow[]>();
  for (const link of skillLinks) skillsOf.set(link.drillId, [...(skillsOf.get(link.drillId) ?? []), link]);

  return rows.map((row) => {
    const links = skillsOf.get(row.drillId) ?? [];
    const content = parseJson<DrillContent>(row.content);
    return {
      drillId: row.drillId,
      slug: row.slug,
      sport: row.sport,
      versionId: row.versionId,
      status: row.status as TrustStatus,
      level: row.level as ExperienceLevel,
      equipment: row.equipment as Equipment,
      space: row.space as Space,
      spaces: content.conditions.spaces,
      partner: row.partner === 1,
      ageMin: row.age_min,
      ageMax: row.age_max,
      minutes: row.minutes,
      track: links.find((link) => link.is_primary === 1)?.slug ?? null,
      skills: links.map((link) => link.slug),
      content,
      attribution: attributionOf(row),
    };
  });
}
