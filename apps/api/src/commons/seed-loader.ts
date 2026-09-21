// Idempotent seed loader (fc-mol-f2u.11): config/commons/<sport>/*.json -> the commons tables.
//
// `loadSeed(db, dir)` runs at every boot (boot hook 20-seed) after the migrations. Directory
// layout, one folder per sport:
//   <dir>/<sport>/skill-graph.json   required     SeedSkillGraphFile
//   <dir>/<sport>/tests.json         optional     SeedTestsFile
//   <dir>/<sport>/rubrics.json       optional     SeedRubricsFile (validated only: 001_commons has no
//                                                 rubric table, and migrations are frozen)
//   <dir>/<sport>/<track>.json       any other    SeedDrillTrackFile (`track` = the drills' primary skill)
// A missing or empty <dir> is a clean no-op (config/commons does not exist until the seed
// content lands). Non-JSON files and dot-entries are ignored.
//
// Phases
//   1. VALIDATE EVERYTHING, WRITE NOTHING. Every file is parsed with the seed schemas, each sport's
//      graph goes through `validateGraph` (SQL prevents neither prerequisite cycles nor links
//      across sports), tests / rubrics / drills must name skills of their own sport, slugs must
//      be unique across the whole seed, and no seed slug may already belong to another sport in
//      the database. All problems are collected into one SeedError: `<file>: <path>: <message>`,
//      never the file's content.
//   2. ONE `db.transaction(...).immediate()` for every write of every sport. A validated seed the
//      database still refuses rolls all of it back, so the database is either loaded or untouched.
//
// Write rules
//   - Sports, skills, prerequisites and tests use `INSERT .. ON CONFLICT DO UPDATE .. WHERE <a
//     column differs>`: seed text is mutable and updates in place; an unchanged row is not even
//     written (no change is counted by SQLite), so an unchanged seed is a byte-identical no-op.
//   - sports.name is not part of the seed: it is filled from the slug on insert and left alone.
//   - sports.graph_version = `<seed version>+<first 12 hex of sha256 of the canonical graph>`. The
//     hash makes the version move whenever nodes or the seed's own version move, even when the
//     author forgot to bump `version`, and only then.
//   - Drills are identified by slug. A drill's CONTENT HASH is sha256 of the canonical JSON of its
//     stored form: the content object, the filter columns, level, minutes, the attribution
//     fields (license, author, source, source url) and the skills mapping (skill slug + is
//     primary, sorted). The seed's semver, created_at, status, origin and the change summary are
//     provenance, not content, and stay out of it. The hash of the seed form is compared with the
//     hash of the same form read back from the drill's CURRENT version and mapping.
//       equal   -> nothing is touched (status set by moderation included)
//       new     -> drill (current_version_id NULL) -> version with the seed's semver -> mapping ->
//                  UPDATE drills.current_version_id
//       changed -> a NEW drill_versions row: semver = patch bump of the current version's (1.0.9 ->
//                  1.0.10, a prerelease is dropped, an already taken semver is skipped), parent =
//                  the current version, status = the current version's status (the loader is not a
//                  moderation actor: it neither upgrades nor silently downgrades trust, and a
//                  status change always comes with a reviews row written by the server); then the
//                  pointer moves and the mapping is rewritten (drill_skills is a link table, not
//                  history). Older versions are never touched.
//   - Nothing is ever deleted (the only DELETE is the drill_skills mapping of a changed drill). A
//     row absent from the seed simply stays. drill_versions is only ever INSERTed: the immutability
//     trigger is never tripped.
//   - Ids are deterministic: the slug for sports, skills, tests and drills (an id already in the
//     database wins), `<drill id>@<semver>` for versions.
//   - New drills start as COMMUNITY: the seed schema carries no trust status, and this is the
//     lowest one; moderation promotes it and the promotion survives later loads.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { EXPERIENCE_LEVELS } from "../shared/primitives";
import type { DrillContent, TrustStatus } from "../shared/primitives";
import { validateGraph } from "./graph";
import type { GraphProblem } from "./graph";
import { SeedDrillTrackFile, SeedRubricsFile, SeedSkillGraphFile, SeedTestsFile } from "./seed-schema";
import type { SeedDrill, SeedSkillNode, SeedTest } from "./seed-schema";

// --- public surface ---------------------------------------------------------------------------

export interface SeedSummary {
  /** Rows WRITTEN by this load (inserted or changed): all zero for an unchanged seed. */
  sports: number;
  skills: number;
  tests: number;
  drills: { inserted: number; updated: number; unchanged: number };
  /** New drill_versions rows: drills.inserted + drills.updated. */
  versions: number;
}

export interface SeedLoadOptions {
  /** Clock for created_at (tests). Read once per load. */
  now?: () => Date;
}

export interface SeedIssue {
  /** Path of the file relative to the seed directory, e.g. `football/skill-graph.json`. */
  file: string;
  /** Dotted JSON path inside the file (`drills.0.license`), `$` for the file itself. */
  path: string;
  message: string;
}

const MAX_LISTED_ISSUES = 50;

/** The seed is invalid: `message` lists `<file>: <path>: <message>` per problem, `issues` has them as data. */
export class SeedError extends Error {
  readonly issues: SeedIssue[];

  constructor(issues: SeedIssue[]) {
    const lines = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `${issue.file}: ${issue.path}: ${issue.message}`);
    if (issues.length > MAX_LISTED_ISSUES) lines.push(`...and ${issues.length - MAX_LISTED_ISSUES} more problems`);
    super(`Invalid seed (${issues.length} ${issues.length === 1 ? "problem" : "problems"})\n${lines.join("\n")}`);
    this.name = "SeedError";
    this.issues = issues;
  }
}

const emptySummary = (): SeedSummary => ({
  sports: 0,
  skills: 0,
  tests: 0,
  drills: { inserted: 0, updated: 0, unchanged: 0 },
  versions: 0,
});

// --- small helpers ----------------------------------------------------------------------------

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with object keys sorted at every depth: equal data gives equal text. */
function canonical(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => compare(a, b))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const pathOf = (path: readonly PropertyKey[]): string => (path.length === 0 ? "$" : path.map(String).join("."));

// --- phase 1: read and validate ---------------------------------------------------------------

interface TrackFile {
  /** Relative path, e.g. `football/ball-control.json`. */
  file: string;
  data: z.infer<typeof SeedDrillTrackFile>;
}

interface SportSeed {
  slug: string;
  graphFile: string;
  graph: z.infer<typeof SeedSkillGraphFile>;
  testsFile: string;
  tests: z.infer<typeof SeedTestsFile> | undefined;
  rubricsFile: string;
  rubrics: z.infer<typeof SeedRubricsFile> | undefined;
  tracks: TrackFile[];
}

const GRAPH_FILE = "skill-graph.json";
const TESTS_FILE = "tests.json";
const RUBRICS_FILE = "rubrics.json";

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Parses one file; a problem becomes issues and `undefined`. Never echoes the file's text. */
function parseFile<S extends z.ZodType>(root: string, file: string, schema: S, issues: SeedIssue[]): z.infer<S> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, file), "utf8").replace(/^﻿/, ""));
  } catch {
    issues.push({ file, path: "$", message: "not valid JSON (or unreadable)" });
    return undefined;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) issues.push({ file, path: pathOf(issue.path), message: issue.message });
  return undefined;
}

/** Reads and schema-checks one sport folder; undefined when any of its files is unusable. */
function readSport(root: string, sport: string, issues: SeedIssue[]): SportSeed | undefined {
  const before = issues.length;
  const folder = join(root, sport);
  const names = readdirSync(folder)
    .filter((name) => !name.startsWith(".") && name.endsWith(".json") && isFile(join(folder, name)))
    .sort(compare);

  const graphFile = `${sport}/${GRAPH_FILE}`;
  const testsFile = `${sport}/${TESTS_FILE}`;
  const rubricsFile = `${sport}/${RUBRICS_FILE}`;

  let graph: SportSeed["graph"] | undefined;
  if (names.includes(GRAPH_FILE)) graph = parseFile(root, graphFile, SeedSkillGraphFile, issues);
  else issues.push({ file: graphFile, path: "$", message: "required file is missing" });
  const tests = names.includes(TESTS_FILE) ? parseFile(root, testsFile, SeedTestsFile, issues) : undefined;
  const rubrics = names.includes(RUBRICS_FILE) ? parseFile(root, rubricsFile, SeedRubricsFile, issues) : undefined;

  const tracks: TrackFile[] = [];
  for (const name of names) {
    if (name === GRAPH_FILE || name === TESTS_FILE || name === RUBRICS_FILE) continue;
    const file = `${sport}/${name}`;
    const data = parseFile(root, file, SeedDrillTrackFile, issues);
    if (data) tracks.push({ file, data });
  }

  const sportField: [string, string | undefined][] = [
    [graphFile, graph?.sport],
    [testsFile, tests?.sport],
    [rubricsFile, rubrics?.sport],
    ...tracks.map((track): [string, string] => [track.file, track.data.sport]),
  ];
  for (const [file, declared] of sportField) {
    if (declared !== undefined && declared !== sport) {
      issues.push({ file, path: "sport", message: `does not match its folder "${sport}"` });
    }
  }

  if (issues.length > before || graph === undefined) return undefined;
  return { slug: sport, graphFile, graph, testsFile, tests, rubricsFile, rubrics, tracks };
}

/** Where a graph problem sits in the files. */
function locate(problem: GraphProblem, sport: SportSeed): SeedIssue {
  const nodes = sport.graph.nodes;
  const nodeAt = nodes.findIndex((node) => node.slug === problem.slug);
  const graphIssue = (path: string): SeedIssue => ({ file: sport.graphFile, path, message: problem.message });

  switch (problem.kind) {
    case "dangling_prerequisite": {
      const at = nodes[nodeAt]?.prerequisites.findIndex((p) => p.skill === problem.target) ?? -1;
      return graphIssue(`nodes.${nodeAt}.prerequisites.${at}.skill`);
    }
    case "dangling_parent":
      return graphIssue(`nodes.${nodeAt}.parent`);
    case "prerequisite_cycle":
      return graphIssue(`nodes.${nodeAt}.prerequisites`);
    case "parent_cycle":
      return graphIssue(`nodes.${nodeAt}.parent`);
    case "mixed_cycle":
    case "duplicate_slug":
      return graphIssue(`nodes.${nodeAt}`);
    case "dangling_drill_skill":
    case "dangling_progression":
    case "dangling_regression": {
      for (const track of sport.tracks) {
        const at = track.data.drills.findIndex((drill) => drill.slug === problem.slug);
        if (at === -1) continue;
        const drill = track.data.drills[at]!;
        if (problem.kind === "dangling_drill_skill") return { file: track.file, path: "track", message: problem.message };
        const key = problem.kind === "dangling_progression" ? "progressionSlugs" : "regressionSlugs";
        const item = (drill[key] ?? []).indexOf(problem.target ?? "");
        return { file: track.file, path: `drills.${at}.${key}.${item}`, message: problem.message };
      }
      return graphIssue("$");
    }
  }
}

/** Graph integrity, and every reference from tests, rubrics and drills to a skill of this sport. */
function checkSport(sport: SportSeed, issues: SeedIssue[]): void {
  const drills = sport.tracks.flatMap((track) =>
    track.data.drills.map((drill) => ({
      slug: drill.slug,
      skill: track.data.track,
      progression: drill.progressionSlugs,
      regression: drill.regressionSlugs,
    })),
  );
  const report = validateGraph(sport.graph.nodes, drills);
  for (const problem of report.problems) issues.push(locate(problem, sport));

  const skills = new Set(sport.graph.nodes.map((node) => node.slug));
  sport.tests?.tests.forEach((test, at) => {
    if (!skills.has(test.skill)) {
      issues.push({ file: sport.testsFile, path: `tests.${at}.skill`, message: `Skill "${test.skill}" is not a skill of ${sport.slug}` });
    }
  });
  sport.rubrics?.rubrics.forEach((rubric, at) => {
    if (!skills.has(rubric.skill)) {
      issues.push({ file: sport.rubricsFile, path: `rubrics.${at}.skill`, message: `Skill "${rubric.skill}" is not a skill of ${sport.slug}` });
    }
  });
}

/** Slugs are unique across the whole seed (the tables are unique on slug, not per sport). */
function checkUniqueSlugs(sports: SportSeed[], issues: SeedIssue[]): void {
  const seen = (label: string): ((slug: string, where: string, issue: Omit<SeedIssue, "message">) => void) => {
    const first = new Map<string, string>();
    return (slug, where, issue) => {
      const earlier = first.get(slug);
      if (earlier === undefined) first.set(slug, where);
      else issues.push({ ...issue, message: `${label} slug "${slug}" is already used in ${earlier}` });
    };
  };
  const skill = seen("Skill");
  const test = seen("Test");
  const drill = seen("Drill");
  for (const sport of sports) {
    sport.graph.nodes.forEach((node, at) => skill(node.slug, sport.graphFile, { file: sport.graphFile, path: `nodes.${at}.slug` }));
    sport.tests?.tests.forEach((t, at) => test(t.slug, sport.testsFile, { file: sport.testsFile, path: `tests.${at}.slug` }));
    for (const track of sport.tracks) {
      track.data.drills.forEach((d, at) => drill(d.slug, track.file, { file: track.file, path: `drills.${at}.slug` }));
    }
  }
}

/** Read-only: a seed slug that already belongs to ANOTHER sport in the database is refused, never moved. */
function checkAgainstDatabase(db: Database, sports: SportSeed[], issues: SeedIssue[]): void {
  const sportOf = (sql: string, slug: string): string | undefined =>
    db.query<{ sport: string }, [string]>(sql).get(slug)?.sport;
  const refuse = (label: string, slug: string, owner: string | undefined, sport: string, issue: Omit<SeedIssue, "message">) => {
    if (owner !== undefined && owner !== sport) {
      issues.push({ ...issue, message: `${label} slug "${slug}" already belongs to sport "${owner}"` });
    }
  };
  for (const sport of sports) {
    sport.graph.nodes.forEach((node, at) =>
      refuse(
        "Skill",
        node.slug,
        sportOf(`SELECT sp.slug AS sport FROM skills s JOIN sports sp ON sp.id = s.sport_id WHERE s.slug = ?`, node.slug),
        sport.slug,
        { file: sport.graphFile, path: `nodes.${at}.slug` },
      ),
    );
    sport.tests?.tests.forEach((test, at) =>
      refuse(
        "Test",
        test.slug,
        sportOf(
          `SELECT sp.slug AS sport FROM skill_tests t JOIN skills s ON s.id = t.skill_id JOIN sports sp ON sp.id = s.sport_id WHERE t.slug = ?`,
          test.slug,
        ),
        sport.slug,
        { file: sport.testsFile, path: `tests.${at}.slug` },
      ),
    );
    for (const track of sport.tracks) {
      track.data.drills.forEach((drill, at) =>
        refuse(
          "Drill",
          drill.slug,
          sportOf(`SELECT sp.slug AS sport FROM drills d JOIN sports sp ON sp.id = d.sport_id WHERE d.slug = ?`, drill.slug),
          sport.slug,
          { file: track.file, path: `drills.${at}.slug` },
        ),
      );
    }
  }
}

// --- phase 2: write ---------------------------------------------------------------------------

type Params = SQLQueryBindings[];

interface StoredForm {
  content: DrillContent;
  equipment: string;
  space: string;
  partner: 0 | 1;
  ageMin: number;
  ageMax: number;
  level: string;
  minutes: number;
  license: string;
  author: string;
  source: string;
  sourceUrl: string | null;
  skills: { slug: string; primary: boolean }[];
}

/** The seed drill in the shape it is stored in (see the content-hash rules in the header). */
function seedForm(drill: SeedDrill, track: string, titleOf: Map<string, SeedDrill["title"]>): StoredForm {
  const titles = (slugs: string[] | undefined) => (slugs ?? []).map((slug) => titleOf.get(slug)!);
  return {
    content: {
      title: drill.title,
      goal: drill.goal,
      instructions: drill.instructions,
      dose: drill.dose,
      mistakes: drill.mistakes ?? [],
      progressions: titles(drill.progressionSlugs),
      regressions: titles(drill.regressionSlugs),
      conditions: {
        equipment: drill.equipment,
        spaces: [drill.space],
        partner: drill.partner ?? false,
        ageMin: drill.ageMin,
        ageMax: drill.ageMax,
      },
      safety: drill.safety ?? [],
      media: [],
    },
    equipment: drill.equipment,
    space: drill.space,
    partner: drill.partner ? 1 : 0,
    ageMin: drill.ageMin,
    ageMax: drill.ageMax,
    level: EXPERIENCE_LEVELS[drill.level - 1]!,
    minutes: drill.minutes,
    license: drill.license,
    author: drill.author,
    source: drill.source,
    sourceUrl: drill.sourceUrl ?? null,
    skills: [{ slug: track, primary: true }],
  };
}

interface VersionRow {
  id: string;
  semver: string;
  status: TrustStatus;
  content: string;
  equipment: string;
  space: string;
  partner: number;
  age_min: number;
  age_max: number;
  level: string;
  minutes: number;
  license: string;
  author_name: string;
  source: string;
  source_url: string | null;
}

const bump = (semver: string): string => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(semver);
  if (match === null) throw new Error(`Cannot bump semver "${semver}"`);
  return `${match[1]}.${match[2]}.${BigInt(match[3]!) + 1n}`;
};

class Writer {
  private readonly stamp: string;
  readonly summary = emptySummary();

  constructor(
    private readonly db: Database,
    now: Date,
  ) {
    this.stamp = now.toISOString();
  }

  /** Runs a statement; the number of rows it actually changed (an upsert whose WHERE fails changes none). */
  private run(sql: string, params: Params): number {
    return this.db.query(sql).run(...params).changes;
  }

  private idOf(table: "sports" | "skills" | "skill_tests" | "drills", slug: string): string {
    return this.db.query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE slug = ?`).get(slug)?.id ?? slug;
  }

  writeSport(sport: SportSeed): void {
    const sportId = this.idOf("sports", sport.slug);
    const graphVersion = `${sport.graph.version}+${sha256(canonical({ version: sport.graph.version, nodes: sport.graph.nodes })).slice(0, 12)}`;
    const name = canonical({ kk: sport.slug, ru: sport.slug, en: sport.slug });
    const sportChanges = this.run(
      `INSERT INTO sports (id, slug, name, graph_version, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET graph_version = excluded.graph_version
        WHERE graph_version IS NOT excluded.graph_version`,
      [sportId, sport.slug, name, graphVersion, this.stamp],
    );
    if (sportChanges > 0) this.summary.sports += 1;

    this.writeSkills(sportId, sport);
    for (const test of sport.tests?.tests ?? []) this.writeTest(test);

    const titleOf = new Map<string, SeedDrill["title"]>();
    for (const track of sport.tracks) for (const drill of track.data.drills) titleOf.set(drill.slug, drill.title);
    for (const track of sport.tracks) {
      for (const drill of track.data.drills) this.writeDrill(sportId, drill, seedForm(drill, track.data.track, titleOf));
    }
  }

  private writeSkills(sportId: string, sport: SportSeed): void {
    const bySlug = new Map(sport.graph.nodes.map((node) => [node.slug, node]));
    // Parents first: skills.parent_id is a foreign key checked per statement.
    const order = validateGraph(sport.graph.nodes, []).order;
    const written = new Set<string>();
    for (const slug of order) {
      if (this.writeSkill(sportId, bySlug.get(slug)!) > 0) written.add(slug);
    }
    for (const node of sport.graph.nodes) {
      for (const prerequisite of node.prerequisites) {
        const changed = this.run(
          `INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES (?, ?, ?)
           ON CONFLICT (skill_id, prerequisite_id) DO UPDATE SET min_level = excluded.min_level
            WHERE min_level IS NOT excluded.min_level`,
          [this.idOf("skills", node.slug), this.idOf("skills", prerequisite.skill), prerequisite.minLevel],
        );
        if (changed > 0) written.add(node.slug);
      }
    }
    this.summary.skills += written.size;
  }

  private writeSkill(sportId: string, node: SeedSkillNode): number {
    const parentId = node.parent === null ? null : this.idOf("skills", node.parent);
    return this.run(
      `INSERT INTO skills (id, slug, sport_id, parent_id, sort_order, names, levels, age_min, age_max, equipment,
                           safety, outcomes, mistakes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET
         parent_id = excluded.parent_id, sort_order = excluded.sort_order, names = excluded.names,
         levels = excluded.levels, age_min = excluded.age_min, age_max = excluded.age_max,
         equipment = excluded.equipment, safety = excluded.safety, outcomes = excluded.outcomes,
         mistakes = excluded.mistakes
       WHERE parent_id IS NOT excluded.parent_id OR sort_order IS NOT excluded.sort_order
          OR names IS NOT excluded.names OR levels IS NOT excluded.levels
          OR age_min IS NOT excluded.age_min OR age_max IS NOT excluded.age_max
          OR equipment IS NOT excluded.equipment OR safety IS NOT excluded.safety
          OR outcomes IS NOT excluded.outcomes OR mistakes IS NOT excluded.mistakes`,
      [
        this.idOf("skills", node.slug),
        node.slug,
        sportId,
        parentId,
        node.order,
        canonical(node.names),
        canonical(node.levels),
        node.ageMin,
        node.ageMax,
        node.equipment,
        canonical(node.safety),
        canonical(node.outcomes),
        canonical(node.mistakes),
        this.stamp,
      ],
    );
  }

  private writeTest(test: SeedTest): void {
    const changed = this.run(
      `INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET
         skill_id = excluded.skill_id, metric = excluded.metric, unit = excluded.unit,
         direction = excluded.direction, protocol = excluded.protocol, equipment = excluded.equipment
       WHERE skill_id IS NOT excluded.skill_id OR metric IS NOT excluded.metric OR unit IS NOT excluded.unit
          OR direction IS NOT excluded.direction OR protocol IS NOT excluded.protocol
          OR equipment IS NOT excluded.equipment`,
      [
        this.idOf("skill_tests", test.slug),
        test.slug,
        this.idOf("skills", test.skill),
        test.metric,
        test.unit,
        test.direction,
        canonical(test.protocol),
        test.equipment,
        this.stamp,
      ],
    );
    if (changed > 0) this.summary.tests += 1;
  }

  // --- drills ---------------------------------------------------------------------------------

  private mappingOf(drillId: string): StoredForm["skills"] {
    return this.db
      .query<{ slug: string; is_primary: number }, [string]>(
        `SELECT s.slug AS slug, ds.is_primary AS is_primary FROM drill_skills ds
           JOIN skills s ON s.id = ds.skill_id WHERE ds.drill_id = ? ORDER BY s.slug`,
      )
      .all(drillId)
      .map((row) => ({ slug: row.slug, primary: row.is_primary === 1 }));
  }

  private storedForm(version: VersionRow, drillId: string): StoredForm {
    return {
      content: JSON.parse(version.content) as DrillContent,
      equipment: version.equipment,
      space: version.space,
      partner: version.partner === 1 ? 1 : 0,
      ageMin: version.age_min,
      ageMax: version.age_max,
      level: version.level,
      minutes: version.minutes,
      license: version.license,
      author: version.author_name,
      source: version.source,
      sourceUrl: version.source_url,
      skills: this.mappingOf(drillId),
    };
  }

  private semverTaken(drillId: string, semver: string): boolean {
    return this.db.query(`SELECT 1 FROM drill_versions WHERE drill_id = ? AND semver = ?`).get(drillId, semver) !== null;
  }

  private insertVersion(
    drillId: string,
    semver: string,
    parentId: string | null,
    status: TrustStatus,
    form: StoredForm,
    summary: string | null,
  ): string {
    const id = `${drillId}@${semver}`;
    this.run(
      `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space,
                                   partner, age_min, age_max, level, minutes, license, author_name, author_user_id,
                                   source, source_url, origin, change_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'seed', ?, ?)`,
      [
        id,
        drillId,
        semver,
        parentId,
        status,
        canonical(form.content),
        form.equipment,
        form.space,
        form.partner,
        form.ageMin,
        form.ageMax,
        form.level,
        form.minutes,
        form.license,
        form.author,
        form.source,
        form.sourceUrl,
        summary,
        this.stamp,
      ],
    );
    this.summary.versions += 1;
    return id;
  }

  private writeMapping(drillId: string, form: StoredForm): void {
    this.run(`DELETE FROM drill_skills WHERE drill_id = ?`, [drillId]);
    for (const skill of form.skills) {
      this.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES (?, ?, ?)`, [
        drillId,
        this.idOf("skills", skill.slug),
        skill.primary ? 1 : 0,
      ]);
    }
  }

  private writeDrill(sportId: string, drill: SeedDrill, form: StoredForm): void {
    const existing = this.db
      .query<{ id: string; current_version_id: string | null }, [string]>(`SELECT id, current_version_id FROM drills WHERE slug = ?`)
      .get(drill.slug);

    if (existing === null) {
      const drillId = drill.slug;
      this.run(`INSERT INTO drills (id, slug, sport_id, current_version_id, created_at) VALUES (?, ?, ?, NULL, ?)`, [
        drillId,
        drill.slug,
        sportId,
        this.stamp,
      ]);
      const versionId = this.insertVersion(drillId, drill.semver, null, "COMMUNITY", form, null);
      this.writeMapping(drillId, form);
      this.run(`UPDATE drills SET current_version_id = ? WHERE id = ?`, [versionId, drillId]);
      this.summary.drills.inserted += 1;
      return;
    }

    const current =
      existing.current_version_id === null
        ? null
        : this.db.query<VersionRow, [string]>(`SELECT * FROM drill_versions WHERE id = ?`).get(existing.current_version_id);
    if (current !== null && sha256(canonical(this.storedForm(current, existing.id))) === sha256(canonical(form))) {
      this.summary.drills.unchanged += 1;
      return;
    }

    let semver = current === null ? drill.semver : bump(current.semver);
    while (this.semverTaken(existing.id, semver)) semver = bump(semver);
    const versionId = this.insertVersion(existing.id, semver, current?.id ?? null, current?.status ?? "COMMUNITY", form, "Updated from seed");
    this.writeMapping(existing.id, form);
    this.run(`UPDATE drills SET current_version_id = ? WHERE id = ?`, [versionId, existing.id]);
    this.summary.drills.updated += 1;
  }
}

// --- entry point ------------------------------------------------------------------------------

export function loadSeed(db: Database, dir: string, opts: SeedLoadOptions = {}): SeedSummary {
  if (!isDirectory(dir)) return emptySummary();

  const issues: SeedIssue[] = [];
  const sports: SportSeed[] = [];
  const folders = readdirSync(dir)
    .filter((name) => !name.startsWith(".") && isDirectory(join(dir, name)))
    .sort(compare);
  for (const folder of folders) {
    const sport = readSport(dir, folder, issues);
    if (sport === undefined) continue;
    checkSport(sport, issues);
    sports.push(sport);
  }
  // Cross-sport rules and the database check run on every sport that could be read.
  checkUniqueSlugs(sports, issues);
  checkAgainstDatabase(db, sports, issues);
  if (issues.length > 0) throw new SeedError(issues);
  if (sports.length === 0) return emptySummary();

  const writer = new Writer(db, (opts.now ?? (() => new Date()))());
  db.transaction(() => {
    for (const sport of sports) writer.writeSport(sport);
  }).immediate();
  return writer.summary;
}
