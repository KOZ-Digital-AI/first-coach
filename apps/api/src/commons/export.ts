// Open Sport Commons export (fc-mol-hum.2): the public, downloadable dataset behind
// GET /api/commons/export.json and its JSON Schema behind GET /api/commons/schema.json.
//
// `buildExport(db)` is pure: it only reads, and it reads the normalized tables directly (bound
// parameters only) because the repository's reads localize text, while the export keeps every
// locale exactly as stored. The document is the shared `CommonsExport` contract, and it is parsed
// through that contract before it is returned, so this module can never emit a document that
// breaks the schema it publishes: stored data that does, throws (the app answers 500).
//
// What is exported
//   - Every sport, ordered by slug; each with its skill graph (parents before children, siblings
//     by order then slug, prerequisites by slug), its skill tests (the "assessments", by slug) and
//     its PUBLISHED drills (unpublished_at IS NULL and a current version), ordered by slug.
//   - A drill is its CURRENT version: content, attribution (author, source, licence, semver),
//     the version history (newest first) and the reviews of all its versions (newest first).
//
// CHOICES the contract leaves open
//   - `generated_at` is required by the contract but is not the clock: it is the newest stamp among
//     the exported rows (created_at of sports, skills, tests and drill versions, reviewed_at of
//     reviews), or the epoch for an empty database. The same data therefore always serialises to the
//     same bytes, and the stamp moves exactly when exported data does.
//   - The contract's SkillTest has no `thresholds`, and its schema forbids unknown keys, so the
//     level thresholds stored on skill tests are NOT exported: adding them would make the export
//     fail its own published schema.
//   - `schema_version` is the version of THIS document format (not of any sport's graph).
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { CommonsExport } from "../shared/commons";

/** Version of the export document format; bump when the CommonsExport contract changes shape. */
export const EXPORT_SCHEMA_VERSION = "1.0.0";

/** The attribution line of CONTENT-LICENSE.md, verbatim (a test pins it to that file). */
export const ATTRIBUTION_NOTICE =
  "Source: Open Sport Commons by FIRST COACH (KOZ AI) and contributors, licensed CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/";

/** The stamp of an export with no exported row at all. */
const EPOCH = "1970-01-01T00:00:00.000Z";

/** A drill the commons shows: not unpublished and linked to its current version. */
const PUBLISHED = "d.unpublished_at IS NULL AND d.current_version_id IS NOT NULL";

/** Code-unit comparison: deterministic on every platform, unlike localeCompare. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

/** The JSON Schema (draft 2020-12) of the export, generated from the contract: never hand-written. */
export function buildSchema(): Record<string, unknown> {
  return z.toJSONSchema(CommonsExport);
}

// --- rows ------------------------------------------------------------------------------------

interface SportRow {
  id: string;
  slug: string;
  name: string;
  graph_version: string;
  created_at: string;
}

interface SkillRow {
  id: string;
  slug: string;
  sport_id: string;
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
  created_at: string;
}

interface PrerequisiteRow {
  skill_id: string;
  slug: string;
  min_level: number;
}

interface TestRow {
  sport_id: string;
  slug: string;
  skill: string;
  metric: string;
  unit: string;
  direction: string;
  protocol: string;
  equipment: string;
  created_at: string;
}

interface DrillRow {
  drill_id: string;
  sport_id: string;
  slug: string;
  version_id: string;
  semver: string;
  content: string;
  license: string;
  author_name: string;
  source: string;
  source_url: string | null;
  created_at: string;
}

interface HistoryRow {
  drill_id: string;
  id: string;
  semver: string;
  created_at: string;
  change_summary: string | null;
}

interface ReviewRow {
  drill_id: string;
  reviewer: string;
  org_label: string;
  from_status: string;
  to_status: string;
  note: string;
  reviewed_at: string;
}

const groupBy = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
};

/** Skills parent-first (siblings by order, then slug); anything a parent cycle hides is appended. */
function inGraphOrder(skills: SkillRow[]): SkillRow[] {
  const children = groupBy(skills, (skill) => skill.parent_id ?? "");
  const bySiblingOrder = (a: SkillRow, b: SkillRow) => a.sort_order - b.sort_order || compare(a.slug, b.slug);
  const ordered: SkillRow[] = [];
  const seen = new Set<string>();
  const visit = (skill: SkillRow): void => {
    if (seen.has(skill.id)) return;
    seen.add(skill.id);
    ordered.push(skill);
    for (const child of (children.get(skill.id) ?? []).sort(bySiblingOrder)) visit(child);
  };
  for (const root of skills.filter((skill) => skill.parent_id === null).sort(bySiblingOrder)) visit(root);
  for (const skill of [...skills].sort(bySiblingOrder)) visit(skill);
  return ordered;
}

// --- buildExport -----------------------------------------------------------------------------

export function buildExport(db: Database): CommonsExport {
  const stamps: string[] = [];
  const stamp = <T extends { created_at: string }>(rows: T[]): T[] => {
    for (const row of rows) stamps.push(row.created_at);
    return rows;
  };

  const sports = stamp(db.query<SportRow, []>(`SELECT id, slug, name, graph_version, created_at FROM sports`).all()).sort(
    (a, b) => compare(a.slug, b.slug),
  );
  const skills = stamp(
    db
      .query<SkillRow, []>(
        `SELECT id, slug, sport_id, parent_id, sort_order, names, levels, age_min, age_max, equipment,
                safety, outcomes, mistakes, created_at
           FROM skills`,
      )
      .all(),
  );
  const slugOf = new Map(skills.map((skill) => [skill.id, skill.slug]));
  const prerequisites = groupBy(
    db
      .query<PrerequisiteRow, []>(
        `SELECT p.skill_id AS skill_id, pre.slug AS slug, p.min_level AS min_level
           FROM skill_prerequisites p JOIN skills pre ON pre.id = p.prerequisite_id
          ORDER BY pre.slug`,
      )
      .all(),
    (row) => row.skill_id,
  );
  const tests = groupBy(
    stamp(
      db
        .query<TestRow, []>(
          `SELECT s.sport_id AS sport_id, t.slug AS slug, s.slug AS skill, t.metric AS metric, t.unit AS unit,
                  t.direction AS direction, t.protocol AS protocol, t.equipment AS equipment, t.created_at AS created_at
             FROM skill_tests t JOIN skills s ON s.id = t.skill_id
            ORDER BY t.slug`,
        )
        .all(),
    ),
    (row) => row.sport_id,
  );
  const drills = groupBy(
    stamp(
      db
        .query<DrillRow, []>(
          `SELECT d.id AS drill_id, d.sport_id AS sport_id, d.slug AS slug, v.id AS version_id, v.semver AS semver,
                  v.content AS content, v.license AS license, v.author_name AS author_name, v.source AS source,
                  v.source_url AS source_url, v.created_at AS created_at
             FROM drills d JOIN drill_versions v ON v.id = d.current_version_id
            WHERE ${PUBLISHED}
            ORDER BY d.slug`,
        )
        .all(),
    ),
    (row) => row.sport_id,
  );
  const history = groupBy(
    stamp(
      db
        .query<HistoryRow, []>(
          `SELECT v.drill_id AS drill_id, v.id AS id, v.semver AS semver, v.created_at AS created_at,
                  v.change_summary AS change_summary
             FROM drill_versions v JOIN drills d ON d.id = v.drill_id
            WHERE ${PUBLISHED}
            ORDER BY v.created_at DESC, v.rowid DESC`,
        )
        .all(),
    ),
    (row) => row.drill_id,
  );
  const reviews = groupBy(
    db
      .query<ReviewRow, []>(
        `SELECT v.drill_id AS drill_id, r.reviewer AS reviewer, r.org_label AS org_label, r.from_status AS from_status,
                r.to_status AS to_status, r.note AS note, r.reviewed_at AS reviewed_at
           FROM reviews r JOIN drill_versions v ON v.id = r.drill_version_id JOIN drills d ON d.id = v.drill_id
          WHERE ${PUBLISHED}
          ORDER BY r.reviewed_at DESC, r.id DESC`,
      )
      .all(),
    (row) => row.drill_id,
  );
  for (const rows of reviews.values()) for (const row of rows) stamps.push(row.reviewed_at);

  const document = {
    schema_version: EXPORT_SCHEMA_VERSION,
    license: "CC-BY-SA-4.0",
    attribution_notice: ATTRIBUTION_NOTICE,
    generated_at: stamps.reduce((newest, each) => (Date.parse(each) > Date.parse(newest) ? each : newest), EPOCH),
    sports: sports.map((sport) => ({
      slug: sport.slug,
      name: parseJson(sport.name),
      graph: {
        sport: sport.slug,
        version: sport.graph_version,
        nodes: inGraphOrder(skills.filter((skill) => skill.sport_id === sport.id)).map((skill) => ({
          slug: skill.slug,
          parent: skill.parent_id === null ? null : (slugOf.get(skill.parent_id) ?? null),
          order: skill.sort_order,
          names: parseJson(skill.names),
          levels: parseJson(skill.levels),
          prerequisites: (prerequisites.get(skill.id) ?? []).map((row) => ({ skill: row.slug, minLevel: row.min_level })),
          ageMin: skill.age_min,
          ageMax: skill.age_max,
          equipment: skill.equipment,
          safety: parseJson(skill.safety),
          outcomes: parseJson(skill.outcomes),
          mistakes: parseJson(skill.mistakes),
        })),
      },
      tests: (tests.get(sport.id) ?? []).map((test) => ({
        slug: test.slug,
        skill: test.skill,
        metric: test.metric,
        unit: test.unit,
        direction: test.direction,
        protocol: parseJson(test.protocol),
        equipment: test.equipment,
      })),
      drills: (drills.get(sport.id) ?? []).map((drill) => ({
        slug: drill.slug,
        versionId: drill.version_id,
        content: parseJson(drill.content),
        attribution: {
          author: drill.author_name,
          source: drill.source,
          ...(drill.source_url === null ? {} : { sourceUrl: drill.source_url }),
          license: drill.license,
          createdAt: drill.created_at,
          semver: drill.semver,
        },
        history: (history.get(drill.drill_id) ?? []).map((entry) => ({
          versionId: entry.id,
          semver: entry.semver,
          createdAt: entry.created_at,
          ...(entry.change_summary === null ? {} : { note: entry.change_summary }),
        })),
        reviews: (reviews.get(drill.drill_id) ?? []).map((review) => ({
          reviewer: review.reviewer,
          orgLabel: review.org_label,
          from: review.from_status,
          to: review.to_status,
          note: review.note,
          at: review.reviewed_at,
        })),
      })),
    })),
  };
  return CommonsExport.parse(document);
}
