import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Hono } from "hono";
import { z } from "zod";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { CommonsExport } from "../shared/commons";
import { CommonsJsonSchemaDocument, ENDPOINTS } from "../shared/commons-api";
import { buildExport } from "./export";
import { getSkillGraph } from "./repo";
import { loadSeed } from "./seed-loader";

// Every test runs on a fresh in-memory database migrated with the real migrations and loaded with
// the REAL seed (config/commons): what is asserted here is what a third-party developer really
// downloads. The few tests that need a state the seed does not have (a review, a second version, a
// second sport, an unpublished drill) write it with plain SQL into that same database.

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SEED_DIR = resolve(REPO_ROOT, "config/commons");
const ROUTE_FILE = resolve(import.meta.dir, "../http/routes/commons-export.routes.ts");
const EXPORT_PATH = ENDPOINTS.exportCommons.path;
const SCHEMA_PATH = ENDPOINTS.commonsSchema.path;

/** The attribution line CONTENT-LICENSE.md tells redistributors to include. */
const ATTRIBUTION_LINE =
  "Source: Open Sport Commons by FIRST COACH (KOZ AI) and contributors, licensed CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "commons-export-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------------------------

/** A real createApp that mounts ONLY the export route module (a one-line re-export in a temp dir). */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(
    join(routesDir, "commons-export.routes.ts"),
    `export { register } from ${JSON.stringify(ROUTE_FILE)};\n`,
  );
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(SEED_DIR, "football", file), "utf8")) as T;

/** Every table's rows, so "the DB is unchanged" compares the whole database. */
function snapshot(): Record<string, unknown[]> {
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
}

const drillsOf = (doc: CommonsExport) => doc.sports.flatMap((sport) => sport.drills);
const firstSlug = (): string =>
  db.query<{ slug: string }, []>(`SELECT slug FROM drills ORDER BY slug LIMIT 1`).get()?.slug ?? "";

/**
 * Inserts a NEW version of a drill as a copy of its current one with `content` rewritten by the
 * SQL expression `contentSql` (test-controlled text), optionally with another licence / author,
 * and moves the drill's current pointer to it.
 */
function addVersion(
  slug: string,
  semver: string,
  contentSql: string,
  createdAt: string,
  override: { license?: string; author?: string } = {},
): string {
  const id = `${slug}-v${semver}`;
  db.query(
    `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space, partner,
       age_min, age_max, level, minutes, license, author_name, source, source_url, origin, change_summary, created_at)
     SELECT ?, drill_id, ?, id, status, ${contentSql}, equipment, space, partner,
       age_min, age_max, level, minutes, coalesce(?, license), coalesce(?, author_name), source, source_url, origin, 'test edit', ?
       FROM drill_versions WHERE id = (SELECT current_version_id FROM drills WHERE slug = ?)`,
  ).run(id, semver, override.license ?? null, override.author ?? null, createdAt, slug);
  db.query(`UPDATE drills SET current_version_id = ? WHERE slug = ?`).run(id, slug);
  return id;
}

function unpublish(slug: string): void {
  db.query(`UPDATE drills SET unpublished_at = '2026-09-21T00:00:00.000Z' WHERE slug = ?`).run(slug);
}

function compileSchema(schema: Record<string, unknown>) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// --- buildExport on the real seed ---------------------------------------------------------------

describe("buildExport on the real seed", () => {
  let doc: CommonsExport;

  beforeEach(() => {
    loadSeed(db, SEED_DIR);
    doc = buildExport(db);
  });

  test("the document parses with the CommonsExport contract", () => {
    expect(CommonsExport.safeParse(doc).success).toBe(true);
  });

  test("one sport, football, with 60 published drills", () => {
    expect(doc.sports.map((sport) => sport.slug)).toEqual(["football"]);
    expect(drillsOf(doc)).toHaveLength(60);
  });

  test("every drill has a non-empty author, source, licence and a semver", () => {
    for (const drill of drillsOf(doc)) {
      expect(text(drill.attribution.author)).toBe(true);
      expect(text(drill.attribution.source)).toBe(true);
      expect(text(drill.attribution.license)).toBe(true);
      expect(drill.attribution.semver).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("each drill's attribution is the one stored on its current version", () => {
    const rows = db
      .query<{ slug: string; author_name: string; source: string; license: string; semver: string }, []>(
        `SELECT d.slug, v.author_name, v.source, v.license, v.semver
           FROM drills d JOIN drill_versions v ON v.id = d.current_version_id`,
      )
      .all();
    const bySlug = new Map(drillsOf(doc).map((drill) => [drill.slug, drill.attribution]));

    expect(bySlug.size).toBe(rows.length);
    for (const row of rows) {
      expect(bySlug.get(row.slug)).toMatchObject({
        author: row.author_name,
        source: row.source,
        license: row.license,
        semver: row.semver,
      });
    }
  });

  test("the top level names the CC BY-SA 4.0 licence and carries the attribution line", () => {
    expect(doc.license).toBe("CC-BY-SA-4.0");
    expect(doc.attribution_notice).toContain("CC BY-SA 4.0");
    expect(doc.attribution_notice).toBe(ATTRIBUTION_LINE);
  });

  test("the attribution notice is the line CONTENT-LICENSE.md gives", () => {
    expect(readFileSync(join(REPO_ROOT, "CONTENT-LICENSE.md"), "utf8")).toContain(doc.attribution_notice);
  });

  test("every drill keeps its title, goal and instructions in kk, ru and en as stored", () => {
    for (const drill of drillsOf(doc)) {
      for (const field of [drill.content.title, drill.content.goal, drill.content.instructions]) {
        for (const locale of ["kk", "ru", "en"] as const) {
          expect(text(field?.[locale])).toBe(true);
        }
      }
    }
  });

  test("the graph is the football graph: 30 skills, 5 roots, every name in three locales", () => {
    const graph = doc.sports[0]?.graph;

    expect(graph?.sport).toBe("football");
    expect(graph?.nodes).toHaveLength(30);
    expect(graph?.nodes.filter((node) => node.parent === null)).toHaveLength(5);
    for (const node of graph?.nodes ?? []) {
      for (const locale of ["kk", "ru", "en"] as const) expect(text(node.names[locale])).toBe(true);
    }
  });

  test("the graph version is the stored sport's graph_version", () => {
    const stored = db.query<{ graph_version: string }, []>(`SELECT graph_version FROM sports`).get();

    expect(doc.sports[0]?.graph.version).toBe(stored?.graph_version ?? "missing");
  });

  test("skills carry the seed's prerequisites, levels, age ranges, equipment and safety", () => {
    type SeedNode = { slug: string; prerequisites?: { skill: string; minLevel: number }[]; levels: unknown[]; ageMin: number; ageMax: number; equipment: string; safety: unknown[] };
    const seed = readJson<{ nodes: SeedNode[] }>("skill-graph.json").nodes;
    const nodes = new Map(doc.sports[0]?.graph.nodes.map((node) => [node.slug, node]));
    const byPrereq = (a: { skill: string }, b: { skill: string }) => (a.skill < b.skill ? -1 : 1);

    expect(seed.flatMap((node) => node.prerequisites ?? [])).not.toHaveLength(0);
    for (const expected of seed) {
      const node = nodes.get(expected.slug);
      expect(node?.prerequisites.slice().sort(byPrereq)).toEqual((expected.prerequisites ?? []).slice().sort(byPrereq));
      expect(node?.levels).toHaveLength(expected.levels.length);
      expect(node?.ageMin).toBe(expected.ageMin);
      expect(node?.ageMax).toBe(expected.ageMax);
      expect(node?.equipment).toBe(expected.equipment);
      expect(node?.safety).toHaveLength(expected.safety.length);
    }
  });

  test("the drills' tracks are the graph's five roots", () => {
    const tracks = db
      .query<{ slug: string }, []>(
        `SELECT DISTINCT s.slug FROM drill_skills ds JOIN skills s ON s.id = ds.skill_id WHERE ds.is_primary = 1 ORDER BY s.slug`,
      )
      .all()
      .map((row) => row.slug);
    const roots = (doc.sports[0]?.graph.nodes ?? []).filter((node) => node.parent === null).map((node) => node.slug).sort();

    expect(tracks).toHaveLength(5);
    expect(roots).toEqual(tracks);
  });

  test("assessments are the seed's skill tests, each protocol in three locales", () => {
    const seed = readJson<{ tests: { slug: string; skill: string; metric: string; unit: string; direction: string; equipment: string }[] }>("tests.json").tests;
    const tests = doc.sports[0]?.tests ?? [];

    expect(tests.map((test) => test.slug)).toEqual(seed.map((test) => test.slug).sort());
    for (const expected of seed) {
      expect(tests.find((test) => test.slug === expected.slug)).toMatchObject({
        skill: expected.skill,
        metric: expected.metric,
        unit: expected.unit,
        direction: expected.direction,
        equipment: expected.equipment,
      });
    }
    for (const test of tests) {
      for (const locale of ["kk", "ru", "en"] as const) expect(text(test.protocol[locale])).toBe(true);
    }
  });

  test("drills carry progressions, regressions, safety and an age range from their content", () => {
    const drills = drillsOf(doc);

    expect(drills.some((drill) => drill.content.progressions.length > 0)).toBe(true);
    expect(drills.some((drill) => drill.content.regressions.length > 0)).toBe(true);
    expect(drills.every((drill) => drill.content.safety.length > 0)).toBe(true);
    expect(drills.every((drill) => drill.content.conditions.ageMin !== undefined)).toBe(true);
    expect(drills.every((drill) => drill.content.conditions.equipment.length > 0)).toBe(true);
  });

  test("the drill content is the stored current content, unchanged", () => {
    const row = db
      .query<{ slug: string; content: string }, []>(
        `SELECT d.slug, v.content FROM drills d JOIN drill_versions v ON v.id = d.current_version_id ORDER BY d.slug LIMIT 1`,
      )
      .get();
    const drill = drillsOf(doc).find((each) => each.slug === row?.slug);

    expect(drill?.content).toEqual(JSON.parse(row?.content ?? "{}"));
  });

  test("the seed has no reviews yet, so every drill's reviews are empty", () => {
    expect(drillsOf(doc).every((drill) => drill.reviews.length === 0)).toBe(true);
  });

  test("two calls give the byte-identical document", () => {
    expect(JSON.stringify(buildExport(db))).toBe(JSON.stringify(doc));
  });

  test("generated_at is the newest stamp of the exported rows, not the clock", () => {
    const newest = db.query<{ at: string }, []>(`SELECT max(created_at) AS at FROM drill_versions`).get();

    expect(doc.generated_at).toBe(newest?.at ?? "missing");
  });

  test("building the export does not change the database", () => {
    const before = snapshot();

    buildExport(db);

    expect(snapshot()).toEqual(before);
  });

  test("sports, drills, tests are in stable order and skills follow the graph's parent-first order", () => {
    const sport = doc.sports[0];
    const slugs = (sport?.drills ?? []).map((drill) => drill.slug);
    const testSlugs = (sport?.tests ?? []).map((test) => test.slug);

    expect(slugs).toEqual([...slugs].sort());
    expect(testSlugs).toEqual([...testSlugs].sort());
    expect(sport?.graph.nodes.map((node) => node.slug)).toEqual(
      getSkillGraph(db, "football", "en")?.nodes.map((node) => node.slug),
    );
  });
});

// --- what is and is not exported ---------------------------------------------------------------

describe("buildExport: published drills, current versions, stored text", () => {
  beforeEach(() => {
    loadSeed(db, SEED_DIR);
  });

  test("an unpublished drill is left out (59) and nothing else changes", () => {
    const slug = firstSlug();
    unpublish(slug);

    const drills = drillsOf(buildExport(db));

    expect(drills).toHaveLength(59);
    expect(drills.map((drill) => drill.slug)).not.toContain(slug);
    expect(db.query<{ n: number }, []>(`SELECT count(*) AS n FROM drills`).get()?.n).toBe(60);
  });

  test("a drill not yet linked to a current version is left out", () => {
    db.run(
      `INSERT INTO drills (id, slug, sport_id, current_version_id) VALUES ('half-loaded', 'half-loaded', 'football', NULL)`,
    );

    expect(drillsOf(buildExport(db))).toHaveLength(60);
  });

  test("a drill exports its CURRENT version: content, versionId, semver, and the history behind it", () => {
    const slug = firstSlug();
    const versionId = addVersion(slug, "1.0.1", `json_set(content, '$.goal.en', 'Edited goal')`, "2026-09-22T10:00:00.000Z");

    const drill = drillsOf(buildExport(db)).find((each) => each.slug === slug);

    expect(drill?.versionId).toBe(versionId);
    expect(drill?.attribution.semver).toBe("1.0.1");
    expect(drill?.content.goal.en).toBe("Edited goal");
    expect(drill?.history.map((entry) => entry.semver)).toEqual(["1.0.1", "1.0.0"]);
  });

  test("a locale missing from the stored text stays missing: nothing is filled from a fallback", () => {
    const slug = firstSlug();
    addVersion(slug, "1.0.1", `json_remove(content, '$.title.kk')`, "2026-09-22T10:00:00.000Z");

    const drill = drillsOf(buildExport(db)).find((each) => each.slug === slug);

    expect(drill?.content.title).toBeDefined();
    expect(drill?.content.title?.kk).toBeUndefined();
    expect(text(drill?.content.title?.ru)).toBe(true);
    expect(text(drill?.content.title?.en)).toBe(true);
  });

  test("reviewers travel with the drill, newest review first, and move generated_at", () => {
    const slug = firstSlug();
    const versionId = db.query<{ id: string }, [string]>(`SELECT current_version_id AS id FROM drills WHERE slug = ?`).get(slug)?.id ?? "";
    const review = db.query(
      `INSERT INTO reviews (drill_version_id, reviewer, org_label, from_status, to_status, note, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    review.run(versionId, "Aigerim S.", "KFF Academy", "COMMUNITY", "REVIEWED", "Checked on a pitch", "2030-01-01T09:00:00.000Z");
    review.run(versionId, "Marat T.", "", "REVIEWED", "EXPERT_VERIFIED", "Safe for age 5", "2030-02-01T09:00:00.000Z");

    const doc = buildExport(db);
    const drill = drillsOf(doc).find((each) => each.slug === slug);

    expect(drill?.reviews).toEqual([
      { reviewer: "Marat T.", orgLabel: "", from: "REVIEWED", to: "EXPERT_VERIFIED", note: "Safe for age 5", at: "2030-02-01T09:00:00.000Z" },
      { reviewer: "Aigerim S.", orgLabel: "KFF Academy", from: "COMMUNITY", to: "REVIEWED", note: "Checked on a pitch", at: "2030-01-01T09:00:00.000Z" },
    ]);
    expect(doc.generated_at).toBe("2030-02-01T09:00:00.000Z");
  });

  test("the licence and author of a drill follow its stored current version", () => {
    const slug = firstSlug();
    addVersion(slug, "1.0.1", "content", "2026-09-22T10:00:00.000Z", { license: "CC-BY-4.0", author: "Some Author" });

    const drill = drillsOf(buildExport(db)).find((each) => each.slug === slug);

    expect(drill?.attribution.license).toBe("CC-BY-4.0");
    expect(drill?.attribution.author).toBe("Some Author");
  });

  test("sports come in slug order and each sport holds only its own drills", () => {
    db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('basketball', 'basketball', '{"en":"Basketball"}', '1.0.0')`);
    db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('zumba', 'zumba', '{"en":"Zumba"}', '1.0.0')`);

    const doc = buildExport(db);

    expect(doc.sports.map((sport) => sport.slug)).toEqual(["basketball", "football", "zumba"]);
    expect(doc.sports.map((sport) => sport.drills.length)).toEqual([0, 60, 0]);
    expect(doc.sports[0]?.graph.nodes).toEqual([]);
    expect(CommonsExport.safeParse(doc).success).toBe(true);
  });

  test("a stored drill that breaks the contract makes the build throw instead of emitting a bad document", () => {
    addVersion(firstSlug(), "1.0.1", `json_set(content, '$.dose', json('{}'))`, "2026-09-22T10:00:00.000Z");

    expect(() => buildExport(db)).toThrow();
  });
});

describe("buildExport on an empty migrated database", () => {
  test("no sports, a fixed generated_at, still a valid document that keeps the licence notice", () => {
    const doc = buildExport(db);

    expect(doc.sports).toEqual([]);
    expect(doc.generated_at).toBe("1970-01-01T00:00:00.000Z");
    expect(doc.attribution_notice).toBe(ATTRIBUTION_LINE);
    expect(CommonsExport.safeParse(doc).success).toBe(true);
    expect(JSON.stringify(buildExport(db))).toBe(JSON.stringify(doc));
  });
});

// --- GET /api/commons/export.json and /api/commons/schema.json ------------------------------------

describe("the export and schema endpoints on the real seed", () => {
  let app: Hono;

  const getJson = async (path: string): Promise<Record<string, any>> => (await app.request(path)).json();

  beforeEach(async () => {
    loadSeed(db, SEED_DIR);
    app = await buildApp();
  });

  test("the contract paths are the criteria's and both are public GETs", () => {
    expect(EXPORT_PATH).toBe("/api/commons/export.json");
    expect(SCHEMA_PATH).toBe("/api/commons/schema.json");
    expect(ENDPOINTS.exportCommons.method).toBe("GET");
    expect(ENDPOINTS.commonsSchema.method).toBe("GET");
  });

  test("export.json answers 200 application/json with a body the CommonsExport contract accepts", async () => {
    const res = await app.request(EXPORT_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(ENDPOINTS.exportCommons.contentType);
    expect(CommonsExport.safeParse(await res.json()).success).toBe(true);
  });

  test("export.json is the buildExport document, served as is", async () => {
    expect(await getJson(EXPORT_PATH)).toEqual(JSON.parse(JSON.stringify(buildExport(db))));
  });

  test("export.json sets no Content-Disposition: the contract does not ask for an attachment", async () => {
    const res = await app.request(EXPORT_PATH);

    expect(res.headers.get("content-disposition")).toBeNull();
  });

  test("both endpoints are public: no cookie, no authorization, no challenge", async () => {
    for (const path of [EXPORT_PATH, SCHEMA_PATH]) {
      const res = await app.request(path, { headers: {} });

      expect(res.status).toBe(200);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  test("schema.json answers 200 application/json with a JSON Schema document", async () => {
    const res = await app.request(SCHEMA_PATH);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(ENDPOINTS.commonsSchema.contentType);
    expect(CommonsJsonSchemaDocument.safeParse(body).success).toBe(true);
    expect(body.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("schema.json is generated from the CommonsExport Zod contract, not written by hand", async () => {
    expect(await getJson(SCHEMA_PATH)).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(CommonsExport))));
  });

  test("the served export validates against the served schema (ajv, draft 2020-12, strict)", async () => {
    const validate = compileSchema(await getJson(SCHEMA_PATH));

    const valid = validate(await getJson(EXPORT_PATH));

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test("the served export lists 60 drills, each with a non-empty author and licence", async () => {
    const drills = drillsOf((await getJson(EXPORT_PATH)) as CommonsExport);

    expect(drills).toHaveLength(60);
    for (const drill of drills) {
      expect(text(drill.attribution.author)).toBe(true);
      expect(text(drill.attribution.license)).toBe(true);
    }
  });

  test("the schema is not vacuous: broken exports do NOT validate", async () => {
    const validate = compileSchema(await getJson(SCHEMA_PATH));
    const good = await getJson(EXPORT_PATH);
    const broken = (edit: (doc: Record<string, any>) => void): boolean => {
      const doc = structuredClone(good);
      edit(doc);
      return validate(doc) as boolean;
    };

    expect(validate(good)).toBe(true);
    // a required key dropped, at the top and deep inside a drill
    expect(broken((doc) => delete doc.attribution_notice)).toBe(false);
    expect(broken((doc) => delete doc.sports[0].drills[0].attribution.author)).toBe(false);
    expect(broken((doc) => delete doc.sports[0].drills[0].attribution.license)).toBe(false);
    expect(broken((doc) => delete doc.sports[0].drills[0].reviews)).toBe(false);
    expect(broken((doc) => delete doc.sports[0].graph.nodes[0].prerequisites)).toBe(false);
    // a wrong type
    expect(broken((doc) => (doc.sports[0].drills[0].content.dose = { reps: "ten" }))).toBe(false);
    expect(broken((doc) => (doc.sports = {}))).toBe(false);
    // an unknown licence, at the top and on a drill
    expect(broken((doc) => (doc.license = "GPL-3.0"))).toBe(false);
    expect(broken((doc) => (doc.sports[0].drills[0].attribution.license = "All-Rights-Reserved"))).toBe(false);
    // an empty author, an unknown key, a bad timestamp
    expect(broken((doc) => (doc.sports[0].drills[0].attribution.author = ""))).toBe(false);
    expect(broken((doc) => (doc.sports[0].tests[0].thresholds = {}))).toBe(false);
    expect(broken((doc) => (doc.generated_at = "yesterday"))).toBe(false);
  });

  test("an unpublished drill drops out of the served export: 59 drills, still valid", async () => {
    unpublish(firstSlug());
    const validate = compileSchema(await getJson(SCHEMA_PATH));

    const doc = await getJson(EXPORT_PATH);

    expect(drillsOf(doc as CommonsExport)).toHaveLength(59);
    expect(validate(doc)).toBe(true);
  });

  test("two requests return the same bytes", async () => {
    const first = await (await app.request(EXPORT_PATH)).text();
    const second = await (await app.request(EXPORT_PATH)).text();

    expect(second).toBe(first);
  });

  test("serving the export does not change the database", async () => {
    const before = snapshot();

    await app.request(EXPORT_PATH);
    await app.request(SCHEMA_PATH);

    expect(snapshot()).toEqual(before);
  });

  test("POST is not served on either path", async () => {
    for (const path of [EXPORT_PATH, SCHEMA_PATH]) {
      const res = await app.request(path, { method: "POST" });

      expect([404, 405]).toContain(res.status);
    }
  });

  test("a stored drill that breaks the contract answers the app's 500 problem+json, not a bad export", async () => {
    addVersion(firstSlug(), "1.0.1", `json_set(content, '$.dose', json('{}'))`, "2026-09-22T10:00:00.000Z");
    const log = spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(EXPORT_PATH);
    log.mockRestore();

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("the endpoints before any seeding", () => {
  test("an empty database still serves a valid, empty export", async () => {
    const app = await buildApp();
    const validate = compileSchema(await (await app.request(SCHEMA_PATH)).json());

    const doc = await (await app.request(EXPORT_PATH)).json();

    expect(doc.sports).toEqual([]);
    expect(validate(doc)).toBe(true);
  });
});
