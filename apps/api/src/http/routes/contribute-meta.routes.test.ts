import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { type AppDeps, createApp } from "../../app";
import { DEFAULT_SETTINGS, updateSettings } from "../../admin/settings";
import { getSkillGraph } from "../../commons/repo";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import {
  ContributionMeta,
  ENDPOINTS,
  IMPROVEMENT_KINDS,
  type SkillOption,
  UPLOAD_MIME_TYPES,
} from "../../shared/contributions";
import {
  EQUIPMENT,
  EXPERIENCE_LEVELS,
  LICENSE_IDS,
  PROBLEM_CONTENT_TYPE,
  ProblemDetails,
  SPACES,
} from "../../shared/primitives";

// Every test runs the real createApp on a fresh in-memory database migrated with the real
// migrations. The seeded tests load the REAL seed (config/commons): the numbers and names
// asserted below are what the contribution form really offers, not fixtures.

const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILE = resolve(import.meta.dir, "contribute-meta.routes.ts");
const PATH = ENDPOINTS.getMeta.path;

/** What the real seed yields: one sport (football) with 5 tracks and 30 skills in all. */
const SEEDED = { sports: ["football"], tracks: 5, skills: 30 };

let dir: string;
let db: Database;
let app: Hono;

/**
 * A real createApp that mounts ONLY the meta route module (through a one-line re-export in a
 * temp routes dir), so the app's real 404 handling and `/api/*` guard are in play without
 * depending on any sibling route module.
 */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(
    join(routesDir, "contribute-meta.routes.ts"),
    `export { register } from ${JSON.stringify(ROUTE_FILE)};\n`,
  );
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

/** GET the meta endpoint; no credentials, no headers: the route is public. */
const get = async (query = ""): Promise<Response> => app.request(`${PATH}${query}`);

/** A 200 whose body is exactly what the contract's ContributionMeta parses to (nothing extra, nothing lost). */
async function meta(query = ""): Promise<ContributionMeta> {
  const res = await get(query);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body: unknown = await res.json();
  const parsed = ContributionMeta.parse(body);
  expect(body).toEqual(parsed);
  return parsed;
}

async function expectProblem(res: Response, status: number): Promise<ProblemDetails> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const text = await res.text();
  const parsed = ProblemDetails.parse(JSON.parse(text));
  expect(parsed.status).toBe(status);
  expect(text).not.toMatch(/sqlite|select |\.ts:\d+|\bat\s+\S+\s*\(/i);
  return parsed;
}

const pointersOf = (problem: ProblemDetails): string[] =>
  (problem.errors ?? []).map((error) => error.pointer);

/** Every node of a tree, parents before children. */
function flatten(nodes: readonly SkillOption[]): SkillOption[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** slug -> parent slug (null for a track), as the tree nests them. */
function parentsOf(nodes: readonly SkillOption[], parent: string | null = null): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const node of nodes) {
    result.set(node.slug, parent);
    for (const [slug, p] of parentsOf(node.children, node.slug)) result.set(slug, p);
  }
  return result;
}

type SeedNode = { slug: string; parent: string | null; names: Record<string, string> };
const seedNodes: SeedNode[] = (
  JSON.parse(readFileSync(join(SEED_DIR, "football", "skill-graph.json"), "utf8")) as { nodes: SeedNode[] }
).nodes;
const seedNode = (slug: string): SeedNode => {
  const node = seedNodes.find((n) => n.slug === slug);
  if (node === undefined) throw new Error(`seed has no skill ${slug}`);
  return node;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contribute-meta-routes-"));
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

describe("GET /api/contribute/meta on the real seed", () => {
  beforeEach(async () => {
    loadSeed(db, SEED_DIR);
    app = await buildApp();
  });

  test("answers 200 with exactly the contract's keys and needs no credentials", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["equipment", "improvementKinds", "levels", "licenses", "skills", "spaces", "sports", "upload"].sort(),
    );
    expect(Object.keys(body.upload as object).sort()).toEqual(["maxMb", "mimeTypes"]);
    expect(ContributionMeta.safeParse(body).success).toBe(true);
  });

  test("the skills tree has the 5 seeded tracks and 30 skills, each child under its own track", async () => {
    const { skills } = await meta();
    expect(skills).toHaveLength(SEEDED.tracks);
    expect(flatten(skills)).toHaveLength(SEEDED.skills);

    const graph = getSkillGraph(db, "football", "ru");
    if (graph === null) throw new Error("football is not seeded");
    // The tree nests exactly what the repository's parent links say, and the tracks keep the graph's order.
    expect(parentsOf(skills)).toEqual(new Map(graph.nodes.map((node) => [node.slug, node.parent])));
    expect(skills.map((track) => track.slug)).toEqual(graph.nodes.filter((n) => n.parent === null).map((n) => n.slug));
    for (const track of skills) {
      expect(track.children.length).toBeGreaterThan(0);
      expect(track.children.map((child) => child.slug)).toEqual(
        graph.nodes.filter((n) => n.parent === track.slug).map((n) => n.slug),
      );
    }
    // Same tracks and children as the seed file, not just as the DB.
    expect(skills.map((track) => track.slug)).toEqual(seedNodes.filter((n) => n.parent === null).map((n) => n.slug));
  });

  test("locale=kk gives the Kazakh names of the tracks and their skills, as the seed writes them", async () => {
    const { skills } = await meta("?locale=kk");
    const ballMastery = skills.find((track) => track.slug === "ball-mastery");
    expect(ballMastery?.name.kk).toBe("Допты меңгеру");
    expect(ballMastery?.name.kk).toBe(seedNode("ball-mastery").names.kk);
    const touches = ballMastery?.children.find((child) => child.slug === "basic-touches");
    expect(touches?.name.kk).toBe(seedNode("basic-touches").names.kk);
    for (const node of flatten(skills)) expect(node.name.kk).toBe(seedNode(node.slug).names.kk);
  });

  test("names fall back requested -> ru -> en when the requested locale has no text (sports and skills alike)", async () => {
    // Real seed, one edit on top: a track and the sport lose their kk and en text.
    db.query(`UPDATE skills SET names = ? WHERE slug = 'dribbling'`).run(JSON.stringify({ ru: "Дриблинг" }));
    db.query(`UPDATE sports SET name = ? WHERE slug = 'football'`).run(JSON.stringify({ ru: "Футбол" }));

    const kk = await meta("?locale=kk");
    expect(kk.skills.find((track) => track.slug === "dribbling")?.name.kk).toBe("Дриблинг");
    expect(kk.sports[0]?.name.kk).toBe("Футбол");
    const en = await meta("?locale=en");
    expect(en.skills.find((track) => track.slug === "dribbling")?.name.en).toBe("Дриблинг");
    expect(en.sports[0]?.name.en).toBe("Футбол");
  });

  test("without a locale the answer is the Russian one", async () => {
    db.query(`UPDATE skills SET names = ? WHERE slug = 'dribbling'`).run(JSON.stringify({ en: "Dribbling", ru: "Дриблинг" }));
    const absent = await meta();
    expect(absent).toEqual(await meta("?locale=ru"));
    expect(absent.skills.find((track) => track.slug === "dribbling")?.name.kk).toBeUndefined();
  });

  test("sports lists every sport in the database with the name the database holds", async () => {
    const { sports } = await meta();
    expect(sports.map((sport) => sport.slug)).toEqual(SEEDED.sports);
    const stored = db.query<{ name: string }, []>(`SELECT name FROM sports WHERE slug = 'football'`).get();
    expect(sports[0]?.name).toEqual(JSON.parse(stored?.name ?? "null"));
  });

  test("with several sports, sports and their tracks are listed in slug order and the tracks merge into one tree", async () => {
    db.query(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('basketball', 'basketball', ?, 'v1')`).run(
      JSON.stringify({ ru: "Баскетбол", en: "Basketball" }),
    );
    db.query(
      `INSERT INTO skills (id, slug, sport_id, parent_id, sort_order, names, age_min, age_max, equipment)
       VALUES ('shooting', 'shooting', 'basketball', NULL, 1, ?, 6, 18, 'ball')`,
    ).run(JSON.stringify({ ru: "Бросок", en: "Shooting" }));

    const { sports, skills } = await meta("?locale=en");
    expect(sports.map((sport) => sport.slug)).toEqual(["basketball", "football"]);
    expect(sports[0]?.name.en).toBe("Basketball");
    expect(skills).toHaveLength(SEEDED.tracks + 1);
    expect(skills[0]?.slug).toBe("shooting");
    expect(skills[0]?.children).toEqual([]);
    expect(flatten(skills)).toHaveLength(SEEDED.skills + 1);
  });

  test("the option lists are the shared contract constants", async () => {
    const body = await meta();
    expect(body.levels).toEqual([...EXPERIENCE_LEVELS]);
    expect(body.equipment).toEqual([...EQUIPMENT]);
    expect(body.spaces).toEqual([...SPACES]);
    expect(body.licenses).toEqual([...LICENSE_IDS]);
    expect(body.improvementKinds).toEqual([...IMPROVEMENT_KINDS]);
    expect(body.upload.mimeTypes).toEqual([...UPLOAD_MIME_TYPES]);
  });

  test("upload.maxMb is the admin setting, read on every request", async () => {
    expect((await meta()).upload.maxMb).toBe(DEFAULT_SETTINGS.uploadMaxMb);

    updateSettings(db, { uploadMaxMb: 120 });
    expect((await meta()).upload.maxMb).toBe(120);

    updateSettings(db, { uploadMaxMb: 5 });
    expect((await meta()).upload.maxMb).toBe(5);
  });

  test("rejects what the contract query schema rejects: an unknown key (root pointer) and an unsupported locale (/locale)", async () => {
    const unknownKey = await expectProblem(await get("?colour=red"), 400);
    expect(pointersOf(unknownKey)).toEqual([""]);

    const badLocale = await expectProblem(await get("?locale=de"), 400);
    expect(pointersOf(badLocale)).toEqual(["/locale"]);
  });

  test("a POST is not this endpoint's method and an unknown /api/contribute path is a 404 problem", async () => {
    expect((await app.request(PATH, { method: "POST" })).status).toBe(404);
    await expectProblem(await app.request("/api/contribute/nothing"), 404);
  });

  test("is read-only: the database is unchanged after a request", async () => {
    const dump = () =>
      JSON.stringify(
        db
          .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
          .all()
          .map(({ name }) => db.query(`SELECT * FROM "${name}"`).all()),
      );
    const before = dump();
    await meta("?locale=kk");
    expect(dump()).toBe(before);
  });
});

describe("GET /api/contribute/meta on a database without a seed", () => {
  test("answers 503 Service Unavailable (the contract needs at least one sport), never a 500", async () => {
    app = await buildApp();
    const res = await get();
    const problem = await expectProblem(res, 503);
    expect(problem.title).toBe("Service Unavailable");
    expect(problem.detail).toBe("The commons is not seeded yet");
  });

  test("a bad query is still a 400 before the seed state is looked at", async () => {
    app = await buildApp();
    await expectProblem(await get("?locale=de"), 400);
  });
});
