import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppDeps } from "../app";
import { DEFAULT_SEED_DIR, onBoot, resolveSeedDir } from "../boot/20-seed.boot";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { DrillDetail, DrillListResponse, SkillGraph, graphProblems } from "../shared/commons";
import { Semver } from "../shared/domain";
import { EntityId } from "../shared/primitives";
import { CommonsStats } from "../shared/stats";
import { validateGraph } from "./graph";
import { getDrill, getSkillGraph, getStats, listDrills, listPublishedVersions } from "./repo";
import type {
  SeedDrill,
  SeedDrillTrackFile,
  SeedRubricsFile,
  SeedSkillGraphFile,
  SeedSkillNode,
  SeedTest,
  SeedTestsFile,
} from "./seed-schema";
import { SeedError, loadSeed } from "./seed-loader";

// Every test runs on a fresh in-memory database migrated with the real migrations (STRICT
// tables, CHECKs, FKs and the drill_versions immutability trigger are all live) and a small
// seed directory written into a temp dir that afterEach removes.

let db: Database;
let root: string;
let dir: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  root = mkdtempSync(join(tmpdir(), "seed-loader-"));
  dir = join(root, "commons");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// --- seed fixtures ---------------------------------------------------------------------------

const t = (en: string) => ({ kk: `${en} (kk)`, ru: `${en} (ru)`, en });

const node = (slug: string, over: Partial<SeedSkillNode> = {}): SeedSkillNode => ({
  slug,
  parent: null,
  order: 1,
  names: t(slug),
  levels: [],
  prerequisites: [],
  ageMin: 5,
  ageMax: 99,
  equipment: "ball",
  safety: [],
  outcomes: [],
  mistakes: [],
  ...over,
});

const drill = (slug: string, over: Partial<SeedDrill> = {}): SeedDrill => ({
  slug,
  title: t(slug),
  goal: t(`${slug} goal`),
  instructions: t(`${slug} steps`),
  dose: { reps: 10 },
  minutes: 5,
  level: 1,
  ageMin: 6,
  ageMax: 12,
  equipment: "ball",
  space: "yard",
  license: "CC-BY-SA-4.0",
  author: "Coach A",
  source: "Academy",
  semver: "1.0.0",
  ...over,
});

interface SportSeed {
  graph: SeedSkillGraphFile;
  tests?: SeedTestsFile;
  /** Track file name (without .json) -> file. */
  tracks: Record<string, SeedDrillTrackFile>;
  rubrics?: SeedRubricsFile;
}
type Seed = Record<string, SportSeed>;

const football = (): SportSeed => ({
  graph: {
    sport: "football",
    version: "1.0.0",
    nodes: [
      node("ball-control", { order: 1 }),
      node("first-touch", { parent: "ball-control", order: 1, prerequisites: [{ skill: "juggling", minLevel: 2 }] }),
      node("juggling", { parent: "ball-control", order: 2 }),
    ],
  },
  tests: {
    sport: "football",
    tests: [
      {
        slug: "wall-pass-30s",
        skill: "first-touch",
        metric: "passes",
        unit: "count",
        direction: "higher",
        protocol: t("pass against a wall for 30 seconds"),
        equipment: "ball_wall",
      },
    ],
  },
  tracks: {
    "ball-control": {
      sport: "football",
      track: "ball-control",
      drills: [
        drill("wall-pass", { progressionSlugs: ["wall-pass-hard"], mistakes: [t("too hard")], safety: [t("clear the area")] }),
        drill("wall-pass-hard", { regressionSlugs: ["wall-pass"], partner: true, space: "home_3x3", minutes: 8 }),
      ],
    },
    "first-touch": {
      sport: "football",
      track: "first-touch",
      drills: [drill("cushion-touch", { level: 2, equipment: "nothing", ageMin: 8, ageMax: 14 })],
    },
  },
  rubrics: { sport: "football", rubrics: [{ skill: "first-touch", level: 1, criteria: t("controls the ball in one touch") }] },
});

const futsal = (): SportSeed => ({
  graph: { sport: "futsal", version: "1.0.0", nodes: [node("futsal-control")] },
  tracks: {
    "futsal-control": { sport: "futsal", track: "futsal-control", drills: [drill("futsal-pass")] },
  },
});

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Replaces the whole seed directory with `seed` (a sport missing from `seed` disappears). */
function writeSeed(seed: Seed): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [sport, files] of Object.entries(seed)) {
    mkdirSync(join(dir, sport));
    writeFileSync(join(dir, sport, "skill-graph.json"), json(files.graph));
    if (files.tests) writeFileSync(join(dir, sport, "tests.json"), json(files.tests));
    if (files.rubrics) writeFileSync(join(dir, sport, "rubrics.json"), json(files.rubrics));
    for (const [name, track] of Object.entries(files.tracks)) writeFileSync(join(dir, sport, `${name}.json`), json(track));
  }
}

const rawFile = (relative: string, text: string): void => {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), text);
};

const T0 = () => new Date("2026-03-01T10:00:00.000Z");
const T1 = () => new Date("2026-03-02T10:00:00.000Z");
const T2 = () => new Date("2026-03-03T10:00:00.000Z");

// --- database helpers ------------------------------------------------------------------------

const changes = (d: Database): number => d.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
const count = (d: Database, table: string): number =>
  d.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

const TABLES = ["sports", "skills", "skill_prerequisites", "skill_tests", "drills", "drill_versions", "drill_skills", "reviews"];

/** Row count and a content hash of every table (WITHOUT ROWID tables included), in a stable order. */
function fingerprint(d: Database): Record<string, string> {
  const names = d
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();
  const out: Record<string, string> = {};
  for (const { name } of names) {
    const rows = d
      .query(`SELECT * FROM "${name}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    out[name] = `${rows.length}:${new Bun.CryptoHasher("sha256").update(rows.join("\n")).digest("hex")}`;
  }
  return out;
}

/** The drills and drill_versions rows WITH their rowids: a rewrite (delete + insert) would change them. */
const drillRows = (d: Database): string =>
  JSON.stringify([
    d.query(`SELECT rowid, * FROM drills ORDER BY slug`).all(),
    d.query(`SELECT rowid, * FROM drill_versions ORDER BY rowid`).all(),
  ]);

interface VersionRow {
  id: string;
  drill_id: string;
  semver: string;
  parent_version_id: string | null;
  status: string;
  content: string;
  equipment: string;
  space: string;
  partner: number;
  age_min: number | null;
  age_max: number | null;
  level: string;
  minutes: number;
  license: string;
  author_name: string;
  author_user_id: string | null;
  source: string;
  source_url: string | null;
  origin: string;
  created_at: string;
}

const versionsOf = (slug: string): VersionRow[] =>
  db
    .query<VersionRow, [string]>(
      `SELECT v.* FROM drill_versions v JOIN drills d ON d.id = v.drill_id WHERE d.slug = ? ORDER BY v.rowid`,
    )
    .all(slug);

const currentOf = (slug: string): VersionRow =>
  db
    .query<VersionRow, [string]>(
      `SELECT v.* FROM drills d JOIN drill_versions v ON v.id = d.current_version_id WHERE d.slug = ?`,
    )
    .get(slug)!;

const mappingOf = (slug: string): { skill: string; primary: number }[] =>
  db
    .query<{ skill: string; primary: number }, [string]>(
      `SELECT s.slug AS skill, ds.is_primary AS "primary" FROM drill_skills ds
         JOIN drills d ON d.id = ds.drill_id JOIN skills s ON s.id = ds.skill_id
        WHERE d.slug = ? ORDER BY s.slug`,
    )
    .all(slug);

const graphVersion = (sport: string): string =>
  db.query<{ graph_version: string }, [string]>("SELECT graph_version FROM sports WHERE slug = ?").get(sport)!.graph_version;

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

const seedError = (fn: () => unknown): SeedError => {
  const error = caught(fn);
  expect(error).toBeInstanceOf(SeedError);
  return error as SeedError;
};

const ZERO = { sports: 0, skills: 0, tests: 0, drills: { inserted: 0, updated: 0, unchanged: 0 }, versions: 0 };

// --- first load ------------------------------------------------------------------------------

describe("loadSeed: first load", () => {
  test("inserts sports, skills, prerequisites, tests, drills, versions and the skills mapping", () => {
    writeSeed({ football: football(), futsal: futsal() });

    const summary = loadSeed(db, dir, { now: T0 });

    expect(summary).toEqual({ sports: 2, skills: 4, tests: 1, drills: { inserted: 4, updated: 0, unchanged: 0 }, versions: 4 });
    expect(count(db, "sports")).toBe(2);
    expect(count(db, "skills")).toBe(4);
    expect(count(db, "skill_prerequisites")).toBe(1);
    expect(count(db, "skill_tests")).toBe(1);
    expect(count(db, "drills")).toBe(4);
    expect(count(db, "drill_versions")).toBe(4);
    expect(count(db, "drill_skills")).toBe(4);
    expect(count(db, "reviews")).toBe(0);
  });

  test("every drill is linked to its current version, seeded with 1.0.0 (the seed's own semver), origin seed and no author account", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    for (const slug of ["wall-pass", "wall-pass-hard", "cushion-touch"]) {
      const versions = versionsOf(slug);
      expect(versions).toHaveLength(1);
      const [version] = versions;
      expect(currentOf(slug).id).toBe(version!.id);
      expect(version!.semver).toBe("1.0.0");
      expect(version!.parent_version_id).toBeNull();
      expect(version!.origin).toBe("seed");
      expect(version!.author_user_id).toBeNull();
      expect(version!.created_at).toBe("2026-03-01T10:00:00.000Z");
    }
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM drills WHERE current_version_id IS NULL").get()!.n).toBe(0);
  });

  test("the seed's semver is used as given, a prerelease included", () => {
    const seed = football();
    seed.tracks["ball-control"]!.drills[0]!.semver = "2.3.4-beta.1";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T0 });
    expect(currentOf("wall-pass").semver).toBe("2.3.4-beta.1");
  });

  test("filter columns and attribution are stored next to the content and agree with it", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    const hard = currentOf("wall-pass-hard");
    const content = JSON.parse(hard.content);
    expect(content.conditions).toEqual({ equipment: "ball", spaces: ["home_3x3"], partner: true, ageMin: 6, ageMax: 12 });
    expect(hard).toMatchObject({
      equipment: "ball",
      space: "home_3x3",
      partner: 1,
      age_min: 6,
      age_max: 12,
      minutes: 8,
      level: "beginner",
      license: "CC-BY-SA-4.0",
      author_name: "Coach A",
      source: "Academy",
      source_url: null,
    });
    expect(content.title).toEqual(t("wall-pass-hard"));
    expect(content.dose).toEqual({ reps: 10 });

    const touch = currentOf("cushion-touch");
    expect(touch).toMatchObject({ level: "basic", equipment: "nothing", partner: 0, age_min: 8, age_max: 14 });
  });

  test("a source url is stored when the seed has one", () => {
    const seed = football();
    seed.tracks["ball-control"]!.drills[0]!.sourceUrl = "https://example.org/wall-pass";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T0 });
    expect(currentOf("wall-pass").source_url).toBe("https://example.org/wall-pass");
  });

  test("progression and regression slugs are resolved to the titles of those drills", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    expect(JSON.parse(currentOf("wall-pass").content).progressions).toEqual([t("wall-pass-hard")]);
    expect(JSON.parse(currentOf("wall-pass-hard").content).regressions).toEqual([t("wall-pass")]);
  });

  test("the drill's track file names its primary skill, which is the only mapping row", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    expect(mappingOf("wall-pass")).toEqual([{ skill: "ball-control", primary: 1 }]);
    expect(mappingOf("cushion-touch")).toEqual([{ skill: "first-touch", primary: 1 }]);
  });

  test("skills keep their parent, order and prerequisites; tests reference their skill", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    const graph = getSkillGraph(db, "football", "en")!;
    const touch = graph.nodes.find((n) => n.slug === "first-touch")!;
    expect(touch.parent).toBe("ball-control");
    expect(touch.prerequisites).toEqual([{ skill: "juggling", minLevel: 2 }]);
    expect(graph.nodes.map((n) => n.slug).sort()).toEqual(["ball-control", "first-touch", "juggling"]);

    const row = db
      .query<{ skill: string; protocol: string; equipment: string; direction: string }, []>(
        `SELECT s.slug AS skill, t.protocol AS protocol, t.equipment AS equipment, t.direction AS direction
           FROM skill_tests t JOIN skills s ON s.id = t.skill_id WHERE t.slug = 'wall-pass-30s'`,
      )
      .get()!;
    expect(row.skill).toBe("first-touch");
    expect(row.equipment).toBe("ball_wall");
    expect(row.direction).toBe("higher");
    expect(JSON.parse(row.protocol)).toEqual(t("pass against a wall for 30 seconds"));
  });

  test("what was loaded is consumable through the read repository", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    const detail = getDrill(db, "wall-pass", "kk")!;
    expect(detail.content.title).toEqual(t("wall-pass"));
    expect(detail.attribution).toMatchObject({ author: "Coach A", source: "Academy", license: "CC-BY-SA-4.0", semver: "1.0.0" });
    expect(detail.versionId).toBe(currentOf("wall-pass").id);
    expect(detail.history.map((h) => h.semver)).toEqual(["1.0.0"]);

    const list = listDrills(db, {}, "en");
    expect(list.total).toBe(3);
    const summary = list.items.find((item) => item.slug === "cushion-touch")!;
    expect(summary).toMatchObject({ track: "first-touch", level: "basic", status: "COMMUNITY", equipment: "nothing" });
    expect(listDrills(db, { skill: "ball-control" }, "en").total).toBe(2);
  });

  test("a sport's name is not part of the seed: it is filled once and later left alone", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const name = db.query<{ name: string }, []>("SELECT name FROM sports WHERE slug = 'football'").get()!.name;
    expect(JSON.parse(name)).toEqual({ kk: "football", ru: "football", en: "football" });

    db.run(`UPDATE sports SET name = '{"en":"Football","ru":"Футбол"}' WHERE slug = 'football'`);
    const seed = football();
    seed.graph.nodes[0]!.names.en = "Ball control!";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });
    expect(db.query<{ name: string }, []>("SELECT name FROM sports WHERE slug = 'football'").get()!.name).toBe(
      '{"en":"Football","ru":"Футбол"}',
    );
  });

  test("ids do not depend on chance: two databases loaded from the same seed hold the same ids", () => {
    writeSeed({ football: football(), futsal: futsal() });
    const other = openDatabase(":memory:");
    try {
      migrate(other, MIGRATIONS_DIR);
      loadSeed(db, dir, { now: T0 });
      loadSeed(other, dir, { now: T1 });
      for (const table of ["sports", "skills", "skill_tests", "drills", "drill_versions"]) {
        const ids = (d: Database) => d.query<{ id: string }, []>(`SELECT id FROM ${table} ORDER BY id`).all();
        expect(ids(other)).toEqual(ids(db));
      }
    } finally {
      other.close();
    }
  });

  test("new drills start with the least trusted status: COMMUNITY", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    expect(db.query<{ status: string }, []>("SELECT DISTINCT status FROM drill_versions").all()).toEqual([{ status: "COMMUNITY" }]);
  });

  test("rubrics are validated but have no table to go to: nothing is written for them", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%rubric%'`).all();
    expect(tables).toEqual([]);
  });
});

// --- empty and missing directories ------------------------------------------------------------

describe("loadSeed: nothing to load", () => {
  test("a missing directory is a clean no-op with an all-zero summary", () => {
    const before = fingerprint(db);
    expect(loadSeed(db, join(root, "does-not-exist"), { now: T0 })).toEqual(ZERO);
    expect(fingerprint(db)).toEqual(before);
  });

  test("an empty directory is a clean no-op", () => {
    mkdirSync(dir);
    const before = fingerprint(db);
    expect(loadSeed(db, dir, { now: T0 })).toEqual(ZERO);
    expect(fingerprint(db)).toEqual(before);
  });

  test("stray files and hidden entries next to the sports are ignored", () => {
    writeSeed({ football: football() });
    writeFileSync(join(dir, "README.md"), "# not a sport\n");
    mkdirSync(join(dir, ".cache"));
    writeFileSync(join(dir, "football", "notes.txt"), "not json\n");
    expect(loadSeed(db, dir, { now: T0 }).drills.inserted).toBe(3);
  });
});

// --- idempotency -----------------------------------------------------------------------------

describe("loadSeed: second load", () => {
  test("is a no-op: no row changes at all, every table byte-identical, an all-unchanged summary", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const before = fingerprint(db);
    const rows = drillRows(db);
    const changesBefore = changes(db);

    const summary = loadSeed(db, dir, { now: T1 });

    expect(changes(db)).toBe(changesBefore);
    expect(fingerprint(db)).toEqual(before);
    expect(drillRows(db)).toBe(rows);
    expect(summary).toEqual({ ...ZERO, drills: { inserted: 0, updated: 0, unchanged: 4 } });
  });

  test("the order of keys in the seed files does not make a drill look changed", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const before = fingerprint(db);

    // Same data, keys written in reverse order.
    const file = join(dir, "football", "ball-control.json");
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
          : value;
    writeFileSync(file, json(reversed(JSON.parse(readFileSync(file, "utf8")))));

    expect(loadSeed(db, dir, { now: T1 }).drills.unchanged).toBe(3);
    expect(fingerprint(db)).toEqual(before);
  });
});

// --- a text change ---------------------------------------------------------------------------

describe("loadSeed: a changed drill", () => {
  test("gets a new immutable version with the patch bumped and the old one as parent; the old row is untouched", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const [first] = versionsOf("cushion-touch");
    const firstJson = JSON.stringify(first);
    const othersBefore = JSON.stringify([versionsOf("wall-pass"), versionsOf("wall-pass-hard")]);

    const seed = football();
    seed.tracks["first-touch"]!.drills[0]!.title.kk = "Жұмсақ тию";
    writeSeed({ football: seed });
    const summary = loadSeed(db, dir, { now: T1 });

    expect(summary.drills).toEqual({ inserted: 0, updated: 1, unchanged: 2 });
    expect(summary.versions).toBe(1);
    const versions = versionsOf("cushion-touch");
    expect(versions.map((v) => v.semver)).toEqual(["1.0.0", "1.0.1"]);
    expect(JSON.stringify(versions[0])).toBe(firstJson);
    const [, second] = versions;
    expect(second!.parent_version_id).toBe(first!.id);
    expect(second!.created_at).toBe("2026-03-02T10:00:00.000Z");
    expect(second!.origin).toBe("seed");
    expect(JSON.parse(second!.content).title.kk).toBe("Жұмсақ тию");
    expect(currentOf("cushion-touch").id).toBe(second!.id);
    expect(JSON.stringify([versionsOf("wall-pass"), versionsOf("wall-pass-hard")])).toBe(othersBefore);

    const detail = getDrill(db, "cushion-touch", "kk")!;
    expect(detail.content.title!.kk).toBe("Жұмсақ тию");
    expect(detail.history.map((h) => h.semver)).toEqual(["1.0.1", "1.0.0"]);
  });

  test("progression and regression text is derived from the titles it names: retitling a drill versions the drills that point at it", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    const seed = football();
    seed.tracks["ball-control"]!.drills[1]!.title.en = "Wall pass, harder";
    writeSeed({ football: seed });
    const summary = loadSeed(db, dir, { now: T1 });

    // wall-pass-hard itself, and wall-pass whose progression text is wall-pass-hard's title.
    expect(summary.drills).toEqual({ inserted: 0, updated: 2, unchanged: 1 });
    expect(JSON.parse(currentOf("wall-pass").content).progressions).toEqual([{ ...t("wall-pass-hard"), en: "Wall pass, harder" }]);
    expect(versionsOf("cushion-touch")).toHaveLength(1);
  });

  test("a change to any stored field counts: a filter column, the attribution and the dose", () => {
    const edits: [string, (d: SeedDrill) => void][] = [
      ["minutes", (d) => void (d.minutes = 9)],
      ["level", (d) => void (d.level = 3)],
      ["equipment", (d) => void (d.equipment = "cones")],
      ["space", (d) => void (d.space = "gym")],
      ["partner", (d) => void (d.partner = true)],
      ["ageMax", (d) => void (d.ageMax = 13)],
      ["author", (d) => void (d.author = "Coach B")],
      ["source", (d) => void (d.source = "Another source")],
      ["license", (d) => void (d.license = "CC0-1.0")],
      ["sourceUrl", (d) => void (d.sourceUrl = "https://example.org/x")],
      ["dose", (d) => void (d.dose = { reps: 20 })],
      ["instructions", (d) => void (d.instructions.en = "New steps")],
    ];
    for (const [field, edit] of edits) {
      const scratch = openDatabase(":memory:");
      try {
        migrate(scratch, MIGRATIONS_DIR);
        writeSeed({ football: football() });
        loadSeed(scratch, dir, { now: T0 });
        const seed = football();
        edit(seed.tracks["ball-control"]!.drills[0]!);
        writeSeed({ football: seed });
        const summary = loadSeed(scratch, dir, { now: T1 });
        expect({ field, updated: summary.drills.updated }).toEqual({ field, updated: 1 });
      } finally {
        scratch.close();
      }
    }
  });

  test("the seed's own semver is ignored on update: the loader bumps the patch of the current version", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const seed = football();
    const wall = seed.tracks["ball-control"]!.drills[0]!;
    wall.title.en = "Wall pass v2";
    wall.semver = "9.9.9";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });
    expect(currentOf("wall-pass").semver).toBe("1.0.1");
  });

  test("the bump is numeric and always a valid Semver: 1.0.9 -> 1.0.10, a prerelease is dropped", () => {
    const seed = football();
    seed.tracks["ball-control"]!.drills[0]!.semver = "1.0.9";
    seed.tracks["ball-control"]!.drills[1]!.semver = "2.3.4-beta.1";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T0 });

    seed.tracks["ball-control"]!.drills[0]!.title.en = "changed";
    seed.tracks["ball-control"]!.drills[1]!.title.en = "changed too";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });

    expect(currentOf("wall-pass").semver).toBe("1.0.10");
    expect(currentOf("wall-pass-hard").semver).toBe("2.3.5");
    for (const slug of ["wall-pass", "wall-pass-hard"]) expect(Semver.safeParse(currentOf(slug).semver).success).toBe(true);
  });

  test("a semver already taken by another version is skipped, never overwritten", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const edited = football();
    edited.tracks["ball-control"]!.drills[0]!.title.en = "Edited";
    writeSeed({ football: edited });
    loadSeed(db, dir, { now: T1 });
    const [v100, v101] = versionsOf("wall-pass");
    const v101Json = JSON.stringify(v101);

    // A moderator rolled the current pointer back to 1.0.0; the seed still carries the edit.
    db.run(`UPDATE drills SET current_version_id = ? WHERE slug = 'wall-pass'`, [v100!.id]);
    const summary = loadSeed(db, dir, { now: T2 });

    expect(summary.drills.updated).toBe(1);
    const versions = versionsOf("wall-pass");
    expect(versions.map((v) => v.semver)).toEqual(["1.0.0", "1.0.1", "1.0.2"]);
    expect(JSON.stringify(versions[1])).toBe(v101Json);
    expect(versions[2]!.parent_version_id).toBe(v100!.id);
    expect(currentOf("wall-pass").semver).toBe("1.0.2");
  });

  test("editing the same drill on three boots yields 1.0.0, 1.0.1, 1.0.2 and unchanged boots in between add nothing", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    const one = football();
    one.tracks["ball-control"]!.drills[0]!.goal.ru = "Новая цель";
    writeSeed({ football: one });
    expect(loadSeed(db, dir, { now: T1 }).versions).toBe(1);

    const settled = fingerprint(db);
    const changesBefore = changes(db);
    expect(loadSeed(db, dir, { now: T2 })).toEqual({ ...ZERO, drills: { inserted: 0, updated: 0, unchanged: 3 } });
    expect(changes(db)).toBe(changesBefore);
    expect(fingerprint(db)).toEqual(settled);

    const two = football();
    two.tracks["ball-control"]!.drills[0]!.goal.ru = "Ещё цель";
    writeSeed({ football: two });
    expect(loadSeed(db, dir, { now: T2 }).versions).toBe(1);

    const versions = versionsOf("wall-pass");
    expect(versions.map((v) => v.semver)).toEqual(["1.0.0", "1.0.1", "1.0.2"]);
    expect(versions.map((v) => v.parent_version_id)).toEqual([null, versions[0]!.id, versions[1]!.id]);
    expect(currentOf("wall-pass").id).toBe(versions[2]!.id);
  });

  test("changing only which skills a drill trains is a change: a new version, and the mapping follows the seed", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const oldVersion = JSON.stringify(versionsOf("wall-pass")[0]);
    expect(mappingOf("wall-pass")).toEqual([{ skill: "ball-control", primary: 1 }]);

    // Move the drill, content untouched, from the ball-control track to the first-touch track.
    const seed = football();
    const moved = seed.tracks["ball-control"]!.drills.splice(0, 1)[0]!;
    seed.tracks["first-touch"]!.drills.push(moved);
    // wall-pass-hard's regression still names wall-pass, which stays a drill of the sport.
    writeSeed({ football: seed });
    const summary = loadSeed(db, dir, { now: T1 });

    expect(summary.drills).toEqual({ inserted: 0, updated: 1, unchanged: 2 });
    expect(mappingOf("wall-pass")).toEqual([{ skill: "first-touch", primary: 1 }]);
    const versions = versionsOf("wall-pass");
    expect(versions.map((v) => v.semver)).toEqual(["1.0.0", "1.0.1"]);
    expect(JSON.stringify(versions[0])).toBe(oldVersion);
    expect(listDrills(db, {}, "en").items.find((i) => i.slug === "wall-pass")!.track).toBe("first-touch");
  });

  test("a version edited from the seed never touches the immutability trigger and leaves reviews alone", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const first = versionsOf("wall-pass")[0]!;
    db.run(
      `INSERT INTO reviews (drill_version_id, reviewer, from_status, to_status) VALUES (?, 'Ana', 'COMMUNITY', 'REVIEWED')`,
      [first.id],
    );
    const reviews = JSON.stringify(db.query("SELECT * FROM reviews").all());

    const seed = football();
    seed.tracks["ball-control"]!.drills[0]!.title.en = "Different";
    writeSeed({ football: seed });
    expect(() => loadSeed(db, dir, { now: T1 })).not.toThrow();

    expect(JSON.stringify(db.query("SELECT * FROM reviews").all())).toBe(reviews);
  });
});

// --- trust status ----------------------------------------------------------------------------

describe("loadSeed: trust status belongs to moderation, not to the loader", () => {
  test("an unchanged seed does not reset a status an admin changed", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    db.run(`UPDATE drill_versions SET status = 'EXPERT_VERIFIED' WHERE drill_id = (SELECT id FROM drills WHERE slug = 'wall-pass')`);
    const before = fingerprint(db);
    const changesBefore = changes(db);

    const summary = loadSeed(db, dir, { now: T1 });

    expect(summary.drills.unchanged).toBe(3);
    expect(summary.versions).toBe(0);
    expect(changes(db)).toBe(changesBefore);
    expect(fingerprint(db)).toEqual(before);
    expect(currentOf("wall-pass").status).toBe("EXPERT_VERIFIED");
  });

  test("a seed edit starts the new version at COMMUNITY: reviewed content is not inherited, the old version and its review stay", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const first = versionsOf("wall-pass")[0]!;
    db.run(`UPDATE drill_versions SET status = 'EXPERT_VERIFIED' WHERE id = ?`, [first.id]);
    db.run(
      `INSERT INTO reviews (drill_version_id, reviewer, from_status, to_status) VALUES (?, 'Ana', 'COMMUNITY', 'EXPERT_VERIFIED')`,
      [first.id],
    );
    const reviews = JSON.stringify(db.query("SELECT * FROM reviews").all());

    // An unchanged reload keeps the verification.
    const settled = fingerprint(db);
    const changesBefore = changes(db);
    loadSeed(db, dir, { now: T1 });
    expect(changes(db)).toBe(changesBefore);
    expect(fingerprint(db)).toEqual(settled);

    // Content nobody reviewed cannot keep the status.
    const seed = football();
    seed.tracks["ball-control"]!.drills[0]!.goal.en = "A different goal";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T2 });

    const [oldVersion, newVersion] = versionsOf("wall-pass");
    expect(newVersion!.semver).toBe("1.0.1");
    expect(newVersion!.status).toBe("COMMUNITY");
    expect(oldVersion!.status).toBe("EXPERT_VERIFIED");
    expect(currentOf("wall-pass").id).toBe(newVersion!.id);
    expect(JSON.stringify(db.query("SELECT * FROM reviews").all())).toBe(reviews);
    expect(listDrills(db, {}, "en").items.find((item) => item.slug === "wall-pass")!.status).toBe("COMMUNITY");
    expect(getDrill(db, "wall-pass", "en")!.reviews).toHaveLength(1);
  });
});

// --- the graph -------------------------------------------------------------------------------

describe("loadSeed: the skill graph", () => {
  test("graph_version changes with the graph and only with it", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const v0 = graphVersion("football");
    const futsal0 = graphVersion("futsal");
    expect(v0.startsWith("1.0.0")).toBe(true);

    // Unchanged, then a drill-only and a tests-only edit: same graph, same version.
    loadSeed(db, dir, { now: T1 });
    expect(graphVersion("football")).toBe(v0);

    const drillEdit = { football: football(), futsal: futsal() };
    drillEdit.football.tracks["ball-control"]!.drills[0]!.title.en = "Edited";
    drillEdit.football.tests!.tests[0]!.metric = "hits";
    writeSeed(drillEdit);
    loadSeed(db, dir, { now: T1 });
    expect(graphVersion("football")).toBe(v0);

    // A node edit changes the version of that sport only.
    const nodeEdit = { football: football(), futsal: futsal() };
    nodeEdit.football.graph.nodes[2]!.names.en = "Juggling!";
    writeSeed(nodeEdit);
    loadSeed(db, dir, { now: T2 });
    expect(graphVersion("football")).not.toBe(v0);
    expect(graphVersion("futsal")).toBe(futsal0);
    expect(getSkillGraph(db, "football", "en")!.version).toBe(graphVersion("football"));
  });

  test("skills, prerequisites and tests are updated in place, keeping their rows", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const rowid = (table: string, slug: string) =>
      db.query<{ rowid: number }, [string]>(`SELECT rowid FROM ${table} WHERE slug = ?`).get(slug)!.rowid;
    const touch = rowid("skills", "first-touch");
    const test0 = rowid("skill_tests", "wall-pass-30s");

    const seed = football();
    seed.graph.nodes[1]!.names.en = "First touch!";
    seed.graph.nodes[1]!.prerequisites = [{ skill: "juggling", minLevel: 3 }];
    seed.tests!.tests[0]!.unit = "hits";
    writeSeed({ football: seed });
    const summary = loadSeed(db, dir, { now: T1 });

    expect(summary).toMatchObject({ sports: 1, skills: 1, tests: 1 });
    expect(rowid("skills", "first-touch")).toBe(touch);
    expect(rowid("skill_tests", "wall-pass-30s")).toBe(test0);
    expect(count(db, "skills")).toBe(3);
    expect(JSON.parse(db.query<{ names: string }, []>("SELECT names FROM skills WHERE slug = 'first-touch'").get()!.names).en).toBe(
      "First touch!",
    );
    expect(db.query<{ min_level: number }, []>("SELECT min_level FROM skill_prerequisites").all()).toEqual([{ min_level: 3 }]);
    expect(db.query<{ unit: string }, []>("SELECT unit FROM skill_tests").all()).toEqual([{ unit: "hits" }]);
  });

  test("a new skill is inserted after its parent, whatever order the file lists them in", () => {
    const seed = football();
    seed.graph.nodes = [...seed.graph.nodes].reverse();
    writeSeed({ football: seed });
    expect(() => loadSeed(db, dir, { now: T0 })).not.toThrow();
    expect(count(db, "skills")).toBe(3);
  });
});

// --- nothing is ever deleted -----------------------------------------------------------------

describe("loadSeed: nothing is ever deleted", () => {
  test("a seed that shrinks leaves every row, version, skill, test and mapping in place", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const untouched = JSON.stringify([versionsOf("wall-pass-hard"), versionsOf("cushion-touch"), versionsOf("futsal-pass")]);

    // Drop a drill, a skill, a prerequisite, a test, the whole rubric file, a track file and a whole sport.
    // (skill_prerequisites is a link table, reconciled to the seed like drill_skills: the one edge
    // first-touch had is the one the seed no longer lists, so it goes; nothing else does.)
    const seed = football();
    seed.tracks["ball-control"]!.drills.pop();
    delete seed.tracks["first-touch"];
    seed.graph.nodes = seed.graph.nodes.filter((n) => n.slug !== "juggling");
    seed.graph.nodes[1]!.prerequisites = [];
    seed.tests!.tests = [];
    delete seed.rubrics;
    delete seed.tracks["ball-control"]!.drills[0]!.progressionSlugs; // its target is gone from the seed
    writeSeed({ football: seed });

    const summary = loadSeed(db, dir, { now: T1 });

    // Only wall-pass changed (it lost its progression): one more version, and not a single row fewer.
    expect(summary.drills).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(count(db, "sports")).toBe(2);
    expect(count(db, "skills")).toBe(4);
    expect(count(db, "skill_prerequisites")).toBe(0);
    expect(count(db, "skill_tests")).toBe(1);
    expect(count(db, "drills")).toBe(4);
    expect(count(db, "drill_versions")).toBe(5);
    expect(count(db, "drill_skills")).toBe(4);
    expect(JSON.stringify([versionsOf("wall-pass-hard"), versionsOf("cushion-touch"), versionsOf("futsal-pass")])).toBe(untouched);
    expect(getDrill(db, "cushion-touch", "en")).not.toBeNull();
    expect(getSkillGraph(db, "football", "en")!.nodes.map((n) => n.slug)).toContain("juggling");
  });

  test("an entirely empty seed directory after a load changes nothing", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const before = fingerprint(db);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    expect(loadSeed(db, dir, { now: T1 })).toEqual(ZERO);
    expect(fingerprint(db)).toEqual(before);
  });

  test("the loader source never uses the replace form of INSERT, which would bypass the immutability trigger", () => {
    const source = readFileSync(resolve(import.meta.dir, "seed-loader.ts"), "utf8");
    expect(source).not.toMatch(/\bOR\s+REPLACE\b/i);
    expect(source).not.toMatch(/\bREPLACE\s+INTO\b/i);
    // The only deletes are the two link tables (mapping and prerequisite edges), never history.
    expect(source).not.toMatch(/\bDELETE\s+FROM\s+(?!(?:drill_skills|skill_prerequisites)\b)/i);
  });
});

// --- the wire contracts ---------------------------------------------------------------------

describe("loadSeed: what it writes satisfies the shared contracts when read back", () => {
  test("repository output parses with DrillDetail (history included), DrillListResponse, SkillGraph and CommonsStats", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const seed = football();
    seed.tracks["first-touch"]!.drills[0]!.goal.en = "A different goal";
    writeSeed({ football: seed, futsal: futsal() });
    loadSeed(db, dir, { now: T1 }); // cushion-touch now has two versions

    for (const slug of ["wall-pass", "wall-pass-hard", "cushion-touch", "futsal-pass"]) {
      for (const locale of ["kk", "ru", "en"] as const) {
        const parsed = DrillDetail.safeParse(getDrill(db, slug, locale));
        expect({ slug, locale, error: parsed.error?.message }).toEqual({ slug, locale, error: undefined });
      }
    }
    expect(getDrill(db, "cushion-touch", "en")!.history).toHaveLength(2);

    for (const locale of ["kk", "ru", "en"] as const) {
      const parsed = DrillListResponse.safeParse(listDrills(db, {}, locale));
      expect({ locale, error: parsed.error?.message }).toEqual({ locale, error: undefined });
    }
    for (const sport of ["football", "futsal"]) {
      const graph = getSkillGraph(db, sport, "en");
      const parsed = SkillGraph.safeParse(graph);
      expect({ sport, error: parsed.error?.message }).toEqual({ sport, error: undefined });
      expect(graphProblems(graph!)).toEqual([]);
    }
    expect(CommonsStats.safeParse(getStats(db)).error).toBeUndefined();
  });

  test("every version id is an EntityId, is stable across a no-op reload, and the planner rows carry the same ids", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const idsOf = () =>
      db.query<{ id: string }, []>(`SELECT id FROM drill_versions ORDER BY id`).all().map((row) => row.id);
    const ids = idsOf();

    expect(ids).toHaveLength(4);
    for (const id of ids) expect({ id, ok: EntityId.safeParse(id).success }).toEqual({ id, ok: true });
    for (const row of listPublishedVersions(db)) {
      expect(EntityId.safeParse(row.versionId).success).toBe(true);
      expect(EntityId.safeParse(row.drillId).success).toBe(true);
      expect(row.versionId).toBe(currentOf(row.slug).id);
    }

    loadSeed(db, dir, { now: T1 });
    expect(idsOf()).toEqual(ids);
  });

  test("a version created by an edit has an EntityId too, and is distinct from the one it replaces", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const seed = football();
    seed.tracks["first-touch"]!.drills[0]!.goal.en = "A different goal";
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });

    const [first, second] = versionsOf("cushion-touch");
    expect(first!.id).not.toBe(second!.id);
    expect(EntityId.safeParse(second!.id).success).toBe(true);
    expect(DrillDetail.safeParse(getDrill(db, "cushion-touch", "en")).success).toBe(true);
  });
});

// --- every mutable column is guarded ----------------------------------------------------------

describe("loadSeed: each mutable column of a skill and of a test is updated in place, and only that one", () => {
  const columnsOf = (table: string): string[] =>
    db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  /** Not seed-mutable: identity, provenance, and the sport link (a slug never moves between sports). */
  const FIXED = new Set(["id", "slug", "created_at", "sport_id"]);
  const rows = (table: string): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all().map((row) => [String(row.slug ?? row.id), row]),
    );
  const differing = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
    Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  const others = (skipTable: string[]): Record<string, string> => {
    const all = fingerprint(db);
    for (const table of skipTable) delete all[table];
    return all;
  };

  const SKILL_EDITS: Record<string, (node: SeedSkillNode) => void> = {
    parent_id: (n) => void (n.parent = null),
    sort_order: (n) => void (n.order = 7),
    names: (n) => void (n.names.kk = "Өзгерген атау"),
    levels: (n) => void (n.levels = [t("Level one")]),
    age_min: (n) => void (n.ageMin = 6),
    age_max: (n) => void (n.ageMax = 98),
    equipment: (n) => void (n.equipment = "cones"),
    safety: (n) => void (n.safety = [t("Mind the wall")]),
    outcomes: (n) => void (n.outcomes = [t("Keeps the ball close")]),
    mistakes: (n) => void (n.mistakes = [t("Looks at the ball")]),
  };
  const TEST_EDITS: Record<string, (test: SeedTest) => void> = {
    skill_id: (x) => void (x.skill = "juggling"),
    metric: (x) => void (x.metric = "hits"),
    unit: (x) => void (x.unit = "seconds"),
    direction: (x) => void (x.direction = "lower"),
    protocol: (x) => void (x.protocol.ru = "Другой протокол"),
    equipment: (x) => void (x.equipment = "ball"),
  };

  test("the edit tables cover every column the tables have (a new column needs an edit and a WHERE guard)", () => {
    expect(Object.keys(SKILL_EDITS).sort()).toEqual(columnsOf("skills").filter((c) => !FIXED.has(c)).sort());
    expect(Object.keys(TEST_EDITS).sort()).toEqual(columnsOf("skill_tests").filter((c) => !FIXED.has(c)).sort());
  });

  for (const [column, edit] of Object.entries(SKILL_EDITS)) {
    test(`skills.${column}`, () => {
      writeSeed({ football: football() });
      loadSeed(db, dir, { now: T0 });
      const before = rows("skills");
      const rest = others(["skills", "sports"]);

      const seed = football();
      edit(seed.graph.nodes[2]!); // juggling
      writeSeed({ football: seed });
      const summary = loadSeed(db, dir, { now: T1 });

      const after = rows("skills");
      expect(summary).toMatchObject({ skills: 1, tests: 0, drills: { inserted: 0, updated: 0, unchanged: 3 } });
      for (const slug of Object.keys(before)) {
        expect({ slug, changed: differing(before[slug]!, after[slug]!) }).toEqual({
          slug,
          changed: slug === "juggling" ? [column] : [],
        });
      }
      expect(others(["skills", "sports"])).toEqual(rest);

      const settled = changes(db);
      expect(loadSeed(db, dir, { now: T2 })).toEqual({ ...ZERO, drills: { inserted: 0, updated: 0, unchanged: 3 } });
      expect(changes(db)).toBe(settled);
    });
  }

  for (const [column, edit] of Object.entries(TEST_EDITS)) {
    test(`skill_tests.${column}`, () => {
      writeSeed({ football: football() });
      loadSeed(db, dir, { now: T0 });
      const before = rows("skill_tests");
      const rest = others(["skill_tests"]);
      const changesBefore = changes(db);

      const seed = football();
      edit(seed.tests!.tests[0]!);
      writeSeed({ football: seed });
      const summary = loadSeed(db, dir, { now: T1 });

      const after = rows("skill_tests");
      expect(summary).toMatchObject({ sports: 0, skills: 0, tests: 1 });
      expect(differing(before["wall-pass-30s"]!, after["wall-pass-30s"]!)).toEqual([column]);
      expect(others(["skill_tests"])).toEqual(rest);
      expect(changes(db) - changesBefore).toBe(1);

      const settled = changes(db);
      expect(loadSeed(db, dir, { now: T2 }).tests).toBe(0);
      expect(changes(db)).toBe(settled);
    });
  }
});

// --- prerequisite edges follow the seed --------------------------------------------------------

describe("loadSeed: prerequisite edges are a link table, reconciled to the seed", () => {
  const edges = (): { skill: string; requires: string; minLevel: number }[] =>
    db
      .query<{ skill: string; requires: string; minLevel: number }, []>(
        `SELECT s.slug AS skill, p.slug AS requires, e.min_level AS minLevel
           FROM skill_prerequisites e JOIN skills s ON s.id = e.skill_id JOIN skills p ON p.id = e.prerequisite_id
          ORDER BY s.slug, p.slug`,
      )
      .all();

  test("reversing a prerequisite in the seed leaves the reversed edge only, so the stored graph stays acyclic", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    expect(edges()).toEqual([{ skill: "first-touch", requires: "juggling", minLevel: 2 }]);
    const version = graphVersion("football");

    const seed = football();
    seed.graph.nodes[1]!.prerequisites = [];
    seed.graph.nodes[2]!.prerequisites = [{ skill: "first-touch", minLevel: 1 }];
    writeSeed({ football: seed });
    const summary = loadSeed(db, dir, { now: T1 });

    expect(edges()).toEqual([{ skill: "juggling", requires: "first-touch", minLevel: 1 }]);
    expect(summary.skills).toBe(2);
    const graph = getSkillGraph(db, "football", "en")!;
    expect(validateGraph(graph.nodes, []).problems).toEqual([]);
    expect(graph.version).not.toBe(version);
    expect(graph.version).toBe(graphVersion("football"));
  });

  test("dropping one of several prerequisites of a skill removes exactly that edge", () => {
    const base = football();
    base.graph.nodes[1]!.prerequisites = [
      { skill: "juggling", minLevel: 2 },
      { skill: "ball-control", minLevel: 1 },
    ];
    writeSeed({ football: base });
    loadSeed(db, dir, { now: T0 });
    expect(edges()).toHaveLength(2);

    const seed = football();
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });

    expect(edges()).toEqual([{ skill: "first-touch", requires: "juggling", minLevel: 2 }]);
  });

  test("a skill the seed no longer lists keeps its edges, and the seed's skills keep theirs", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });

    // first-touch leaves the seed (with its tests, rubric and drills); its edge to juggling stays.
    const seed = football();
    seed.graph.nodes = seed.graph.nodes.filter((n) => n.slug !== "first-touch");
    seed.tests!.tests = [];
    delete seed.rubrics;
    delete seed.tracks["first-touch"];
    writeSeed({ football: seed });
    loadSeed(db, dir, { now: T1 });

    expect(edges()).toEqual([{ skill: "first-touch", requires: "juggling", minLevel: 2 }]);
    expect(count(db, "skills")).toBe(3);
  });

  test("the seed merged with the skills already in the database must be acyclic: a stored cycle aborts the load untouched", () => {
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const sportId = `(SELECT id FROM sports WHERE slug = 'football')`;
    for (const slug of ["legacy-a", "legacy-b"]) {
      db.run(
        `INSERT INTO skills (id, slug, sport_id, age_min, age_max, equipment, names) VALUES ('${slug}', '${slug}', ${sportId}, 5, 99, 'ball', '{"en":"${slug}"}')`,
      );
    }
    db.run(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('legacy-a', 'legacy-b', 1), ('legacy-b', 'legacy-a', 1)`);
    const before = fingerprint(db);

    const seed = football();
    seed.tracks["first-touch"]!.drills[0]!.goal.en = "A different goal"; // a real edit that must not land
    writeSeed({ football: seed });
    const error = seedError(() => loadSeed(db, dir, { now: T1 }));

    expect(error.message).toContain("football/skill-graph.json");
    expect(error.message).toContain("legacy-a");
    expect(fingerprint(db)).toEqual(before);
  });

  test("a skill outside the seed that points at a skill nobody has aborts the load, naming the sport's graph file", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    db.run(
      `INSERT INTO skills (id, slug, sport_id, age_min, age_max, equipment, names)
       VALUES ('legacy-x', 'legacy-x', (SELECT id FROM sports WHERE slug = 'football'), 5, 99, 'ball', '{"en":"x"}')`,
    );
    db.run(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('legacy-x', 'futsal-control', 1)`);
    const before = fingerprint(db);

    const error = seedError(() => loadSeed(db, dir, { now: T1 }));

    expect(error.message).toContain("football/skill-graph.json");
    expect(error.message).toContain("legacy-x");
    expect(fingerprint(db)).toEqual(before);
  });
});

// --- invalid seeds ---------------------------------------------------------------------------

type Mutation = (seed: Seed) => void;
interface InvalidCase {
  name: string;
  arrange: Mutation;
  file: string;
  path: string;
  /** Text the message must also carry. */
  mentions?: string;
}

const both = (): Seed => ({ football: football(), futsal: futsal() });

const INVALID: InvalidCase[] = [
  {
    name: "an unknown license",
    arrange: (s) => void ((s.football!.tracks["ball-control"]!.drills[0] as { license: string }).license = "GPL-3.0"),
    file: "football/ball-control.json",
    path: "drills.0.license",
  },
  {
    name: "a misspelt key",
    arrange: (s) => void ((s.football!.tracks["ball-control"]!.drills[1] as Record<string, unknown>).licence = "CC0-1.0"),
    file: "football/ball-control.json",
    path: "drills.1",
    mentions: "licence",
  },
  {
    name: "a blank locale",
    arrange: (s) => void (s.football!.tracks["first-touch"]!.drills[0]!.title.kk = "  "),
    file: "football/first-touch.json",
    path: "drills.0.title.kk",
  },
  {
    name: "a wrongly typed value in tests.json",
    arrange: (s) => void ((s.football!.tests!.tests[0] as { metric: unknown }).metric = 5),
    file: "football/tests.json",
    path: "tests.0.metric",
  },
  {
    name: "an invalid rubric level",
    arrange: (s) => void (s.football!.rubrics!.rubrics[0]!.level = 9),
    file: "football/rubrics.json",
    path: "rubrics.0.level",
  },
  {
    name: "a duplicate slug inside a file",
    arrange: (s) => void s.football!.tracks["ball-control"]!.drills.push(drill("wall-pass")),
    file: "football/ball-control.json",
    path: "drills.2.slug",
  },
  {
    name: "a prerequisite cycle",
    arrange: (s) => void (s.football!.graph.nodes[2]!.prerequisites = [{ skill: "first-touch", minLevel: 1 }]),
    file: "football/skill-graph.json",
    path: "nodes.",
    mentions: "first-touch",
  },
  {
    name: "a parent cycle",
    arrange: (s) => void (s.football!.graph.nodes[0]!.parent = "first-touch"),
    file: "football/skill-graph.json",
    path: "nodes.",
    mentions: "ball-control",
  },
  {
    name: "a prerequisite in another sport",
    arrange: (s) => void (s.futsal!.graph.nodes[0]!.prerequisites = [{ skill: "juggling", minLevel: 1 }]),
    file: "futsal/skill-graph.json",
    path: "nodes.0.prerequisites.0.skill",
    mentions: "juggling",
  },
  {
    name: "a parent that is not a skill",
    arrange: (s) => void (s.football!.graph.nodes[1]!.parent = "ghost"),
    file: "football/skill-graph.json",
    path: "nodes.1.parent",
  },
  {
    name: "a drill track that is not a skill",
    arrange: (s) => void (s.football!.tracks["ball-control"]!.track = "no-such-skill"),
    file: "football/ball-control.json",
    path: "track",
    mentions: "no-such-skill",
  },
  {
    name: "a progression that is not a drill",
    arrange: (s) => void (s.football!.tracks["ball-control"]!.drills[0]!.progressionSlugs = ["ghost-drill"]),
    file: "football/ball-control.json",
    path: "drills.0.progressionSlugs.0",
    mentions: "ghost-drill",
  },
  {
    name: "a regression that is not a drill",
    arrange: (s) => void (s.football!.tracks["ball-control"]!.drills[1]!.regressionSlugs = ["ghost-drill"]),
    file: "football/ball-control.json",
    path: "drills.1.regressionSlugs.0",
  },
  {
    name: "a test on an unknown skill",
    arrange: (s) => void (s.football!.tests!.tests[0]!.skill = "ghost-skill"),
    file: "football/tests.json",
    path: "tests.0.skill",
  },
  {
    name: "a rubric on an unknown skill",
    arrange: (s) => void (s.football!.rubrics!.rubrics[0]!.skill = "ghost-skill"),
    file: "football/rubrics.json",
    path: "rubrics.0.skill",
  },
  {
    name: "a sport field that disagrees with its directory",
    arrange: (s) => void (s.football!.graph.sport = "futsal"),
    file: "football/skill-graph.json",
    path: "sport",
  },
  {
    name: "a drill slug used in two track files",
    arrange: (s) => void s.football!.tracks["first-touch"]!.drills.push(drill("wall-pass")),
    file: "football/first-touch.json",
    path: "drills.1.slug",
  },
  {
    name: "a drill slug used in two sports",
    arrange: (s) => void s.futsal!.tracks["futsal-control"]!.drills.push(drill("wall-pass")),
    file: "futsal/futsal-control.json",
    path: "drills.1.slug",
  },
  {
    name: "a skill slug used in two sports",
    arrange: (s) => void s.futsal!.graph.nodes.push(node("juggling")),
    file: "futsal/skill-graph.json",
    path: "nodes.1.slug",
  },
  {
    name: "a test slug used in two sports",
    arrange: (s) => {
      s.futsal!.tests = { sport: "futsal", tests: [{ ...football().tests!.tests[0]!, skill: "futsal-control" }] };
    },
    file: "futsal/tests.json",
    path: "tests.0.slug",
  },
];

describe("loadSeed: an invalid seed aborts with the file and the path, and writes nothing", () => {
  for (const c of INVALID) {
    test(c.name, () => {
      const seed = both();
      c.arrange(seed);
      writeSeed(seed);
      const before = fingerprint(db);
      const changesBefore = changes(db);

      const error = seedError(() => loadSeed(db, dir, { now: T0 }));

      expect(error.message).toContain(c.file);
      expect(error.message).toContain(c.path);
      if (c.mentions) expect(error.message).toContain(c.mentions);
      expect(error.issues.some((issue) => issue.file === c.file && issue.path.startsWith(c.path.replace(/\.$/, "")))).toBe(true);
      expect(fingerprint(db)).toEqual(before);
      expect(changes(db)).toBe(changesBefore);
    });
  }

  test("a file that is not JSON is reported by name, without echoing its text", () => {
    writeSeed({ football: football() });
    rawFile("football/first-touch.json", "{ this is not json TOPSECRET-TOKEN");
    const error = seedError(() => loadSeed(db, dir, { now: T0 }));
    expect(error.message).toContain("football/first-touch.json");
    expect(error.message).not.toContain("TOPSECRET-TOKEN");
    expect(count(db, "drills")).toBe(0);
  });

  test("a sport without skill-graph.json is reported by name", () => {
    writeSeed({ football: football() });
    rmSync(join(dir, "football", "skill-graph.json"));
    const error = seedError(() => loadSeed(db, dir, { now: T0 }));
    expect(error.message).toContain("football/skill-graph.json");
    expect(count(db, "drills")).toBe(0);
  });

  test("the message names the file and path but not the offending value or other file content", () => {
    const seed = football();
    const wall = seed.tracks["ball-control"]!.drills[0]! as unknown as Record<string, unknown>;
    wall.license = "SECRET-LICENSE-VALUE";
    wall.author = "";
    seed.tracks["ball-control"]!.drills[1]!.title.en = "PRIVATE-TITLE-TEXT";
    writeSeed({ football: seed });

    const error = seedError(() => loadSeed(db, dir, { now: T0 }));

    expect(error.message).toContain("football/ball-control.json");
    expect(error.message).toContain("drills.0.license");
    expect(error.message).not.toContain("SECRET-LICENSE-VALUE");
    expect(error.message).not.toContain("PRIVATE-TITLE-TEXT");
    expect(JSON.stringify(error.issues)).not.toContain("SECRET-LICENSE-VALUE");
  });

  test("every bad file is reported, not just the first", () => {
    const seed = both();
    (seed.football!.tracks["ball-control"]!.drills[0] as { license: string }).license = "nope";
    seed.futsal!.tracks["futsal-control"]!.drills[0]!.minutes = -1;
    writeSeed(seed);

    const error = seedError(() => loadSeed(db, dir, { now: T0 }));

    expect(error.message).toContain("football/ball-control.json: drills.0.license");
    expect(error.message).toContain("futsal/futsal-control.json: drills.0.minutes");
    expect(error.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of error.issues) {
      expect(typeof issue.file).toBe("string");
      expect(typeof issue.path).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  test("the message format is `<file>: <path>: <message>`", () => {
    const seed = football();
    (seed.tracks["ball-control"]!.drills[0] as { license: string }).license = "nope";
    writeSeed({ football: seed });
    const error = seedError(() => loadSeed(db, dir, { now: T0 }));
    expect(error.message).toMatch(/^football\/ball-control\.json: drills\.0\.license: \S/m);
    expect(error.name).toBe("SeedError");
  });

  test("an invalid file in a LATER sport leaves an earlier valid sport unwritten, on an empty and on a loaded database", () => {
    // futsal sorts after football: football is valid and would be written first.
    const bad = both();
    bad.futsal!.tracks["futsal-control"]!.drills[0]!.level = 7;
    writeSeed(bad);
    seedError(() => loadSeed(db, dir, { now: T0 }));
    for (const table of TABLES) expect(count(db, table)).toBe(0);

    // Now with football already loaded and a real edit in it: the edit must not land either.
    writeSeed({ football: football() });
    loadSeed(db, dir, { now: T0 });
    const before = fingerprint(db);
    const rows = drillRows(db);
    const edited = both();
    edited.football!.tracks["ball-control"]!.drills[0]!.title.en = "Edited";
    edited.futsal!.tracks["futsal-control"]!.drills[0]!.level = 7;
    writeSeed(edited);
    seedError(() => loadSeed(db, dir, { now: T1 }));
    expect(fingerprint(db)).toEqual(before);
    expect(drillRows(db)).toBe(rows);
  });

  test("a drill that already lives in another sport is refused instead of being moved", () => {
    writeSeed({ football: football(), futsal: futsal() });
    loadSeed(db, dir, { now: T0 });
    const before = fingerprint(db);

    const seed = { football: football(), futsal: futsal() };
    seed.futsal.tracks["futsal-control"]!.drills.push(seed.football.tracks["ball-control"]!.drills.splice(0, 1)[0]!);
    seed.football.tracks["ball-control"]!.drills[0]!.regressionSlugs = undefined;
    delete seed.football.tracks["ball-control"]!.drills[0]!.regressionSlugs;
    writeSeed(seed);

    const error = seedError(() => loadSeed(db, dir, { now: T1 }));
    expect(error.message).toContain("futsal/futsal-control.json");
    expect(error.message).toContain("drills.1.slug");
    expect(fingerprint(db)).toEqual(before);
  });
});

// --- atomicity of the write phase ------------------------------------------------------------

describe("loadSeed: all writes are one transaction", () => {
  test("a failure in the middle of the writes rolls back everything written before it", () => {
    writeSeed({ football: football(), futsal: futsal() });
    // Valid seed, but the database refuses the last sport's first version: earlier writes must go.
    db.run(`CREATE TRIGGER refuse_futsal BEFORE INSERT ON drill_versions
              WHEN NEW.drill_id IN (SELECT id FROM drills WHERE slug = 'futsal-pass')
            BEGIN SELECT RAISE(ABORT, 'refused by test trigger'); END`);
    const before = fingerprint(db);

    expect(() => loadSeed(db, dir, { now: T0 })).toThrow(/refused by test trigger/);

    expect(fingerprint(db)).toEqual(before);
    for (const table of TABLES) expect(count(db, table)).toBe(0);
    // The connection is usable afterwards (no transaction left open).
    expect(() => db.run("BEGIN IMMEDIATE")).not.toThrow();
    db.run("ROLLBACK");
  });

  test("a failed load can simply be retried once the cause is gone", () => {
    writeSeed({ football: football(), futsal: futsal() });
    db.run(`CREATE TRIGGER refuse_futsal BEFORE INSERT ON drill_versions
              WHEN NEW.drill_id IN (SELECT id FROM drills WHERE slug = 'futsal-pass')
            BEGIN SELECT RAISE(ABORT, 'refused by test trigger'); END`);
    expect(() => loadSeed(db, dir, { now: T0 })).toThrow();
    db.run("DROP TRIGGER refuse_futsal");

    expect(loadSeed(db, dir, { now: T1 }).drills.inserted).toBe(4);
    expect(count(db, "drills")).toBe(4);
  });
});

// --- the boot hook ---------------------------------------------------------------------------

describe("20-seed boot hook", () => {
  let lines: string[];
  let saved: string | undefined;
  const deps = (): AppDeps => ({ db, version: "test" });
  const log = (line: string): void => void lines.push(line);
  const logged = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line));

  beforeEach(() => {
    lines = [];
    saved = process.env.SEED_DIR;
    delete process.env.SEED_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SEED_DIR;
    else process.env.SEED_DIR = saved;
  });

  test("sorts between 00-env and 40-backup, and is one of the real boot hooks", () => {
    const hooks = readdirSync(resolve(import.meta.dir, "..", "boot")).filter((f) => f.endsWith(".boot.ts"));
    expect(hooks).toContain("20-seed.boot.ts");
    expect("00-env.boot.ts" < "20-seed.boot.ts").toBe(true);
    expect("20-seed.boot.ts" < "40-backup.boot.ts").toBe(true);
  });

  test("the default seed directory is <repo root>/config/commons", () => {
    expect(DEFAULT_SEED_DIR).toBe(resolve(import.meta.dir, "../../../../config/commons"));
    expect(DEFAULT_SEED_DIR.endsWith(join("config", "commons"))).toBe(true);
  });

  test("SEED_DIR overrides the default, read when called; empty counts as unset", () => {
    expect(resolveSeedDir({})).toBe(DEFAULT_SEED_DIR);
    expect(resolveSeedDir({ SEED_DIR: "" })).toBe(DEFAULT_SEED_DIR);
    expect(resolveSeedDir({ SEED_DIR: "/somewhere/else" })).toBe("/somewhere/else");
    process.env.SEED_DIR = "/from/process/env";
    expect(resolveSeedDir()).toBe("/from/process/env");
  });

  test("loads the seed and logs one info line with the summary", async () => {
    writeSeed({ football: football() });

    await onBoot(deps(), { dir, log });

    expect(count(db, "drills")).toBe(3);
    expect(logged()).toEqual([
      {
        level: "info",
        msg: "seed loaded",
        sports: 1,
        skills: 3,
        tests: 1,
        drills: { inserted: 3, updated: 0, unchanged: 0 },
        versions: 3,
      },
    ]);
  });

  test("booting twice is harmless: the second boot reports everything unchanged", async () => {
    writeSeed({ football: football() });
    await onBoot(deps(), { dir, log });
    await onBoot(deps(), { dir, log });
    expect(logged()[1]).toMatchObject({ msg: "seed loaded", versions: 0, drills: { inserted: 0, updated: 0, unchanged: 3 } });
  });

  test("uses SEED_DIR when no dir is given, and an explicit dir wins over SEED_DIR", async () => {
    writeSeed({ football: football() });
    process.env.SEED_DIR = dir;
    await onBoot(deps(), { log });
    expect(count(db, "drills")).toBe(3);

    const other = openDatabase(":memory:");
    try {
      migrate(other, MIGRATIONS_DIR);
      process.env.SEED_DIR = join(root, "wrong");
      await onBoot({ db: other, version: "test" }, { dir, log });
      expect(count(other, "drills")).toBe(3);
    } finally {
      other.close();
    }
  });

  test("an explicit SEED_DIR that does not exist aborts the boot with a SeedError naming SEED_DIR and the path", async () => {
    const missing = join(root, "nope");
    process.env.SEED_DIR = missing;

    const error = await onBoot(deps(), { log }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toContain("SEED_DIR");
    expect((error as Error).message).toContain(missing);
    expect(lines).toEqual([]);
    expect(count(db, "drills")).toBe(0);
  });

  test("an explicit SEED_DIR that is a file aborts the boot too", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory\n");
    process.env.SEED_DIR = file;

    const error = await onBoot(deps(), { log }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toContain("SEED_DIR");
    expect((error as Error).message).toContain(file);
    expect(lines).toEqual([]);
  });

  test("an explicit dir option that does not exist is refused as well, never skipped", async () => {
    const error = await onBoot(deps(), { dir: join(root, "nope"), log }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeedError);
    expect(lines).toEqual([]);
  });

  test("without any override the hook reads config/commons: skipped while it does not exist, loaded once it does", async () => {
    await onBoot(deps(), { log });
    if (!existsSync(DEFAULT_SEED_DIR)) {
      expect(lines).toEqual(['{"level":"info","msg":"seed skipped","reason":"no config/commons"}']);
      expect(count(db, "drills")).toBe(0);
    } else {
      expect(logged()).toHaveLength(1);
      expect(logged()[0]).toMatchObject({ level: "info", msg: "seed loaded" });
    }
  });

  test("logs to the console by default", async () => {
    writeSeed({ football: football() });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await onBoot(deps(), { dir });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject({ level: "info", msg: "seed loaded" });
    } finally {
      spy.mockRestore();
    }
  });

  test("an invalid seed aborts the boot with the SeedError, file and path included", async () => {
    const seed = football();
    (seed.tracks["ball-control"]!.drills[0] as { license: string }).license = "nope";
    writeSeed({ football: seed });

    const error = await onBoot(deps(), { dir, log }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toContain("football/ball-control.json: drills.0.license");
    expect(count(db, "drills")).toBe(0);
    expect(lines).toEqual([]);
  });
});
