// GET /api/video/rubrics/:skillSlug?locale (fc-mol-8nt.3), served through the real createApp
// (auto-mount, /api/* 404 guard) on the REAL seed (config/commons/football/rubrics.json).
// Nothing is mocked or faked. The expected bodies are computed from the raw seed JSON in this
// file, independently of the route's own reading code, and every body is checked against the
// contract schema (shared/video Rubric).
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../app";
import { DEFAULT_SEED_DIR } from "../../boot/20-seed.boot";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { LOCALES, PROBLEM_CONTENT_TYPE, ProblemDetails } from "../../shared/primitives";
import type { Locale } from "../../shared/primitives";
import { ENDPOINTS, Rubric } from "../../shared/video";

const RUBRIC = (skill: string): string => ENDPOINTS.getRubric.path.replace(":skillSlug", skill);

const ROUTE_MODULE = resolve(import.meta.dir, "video-rubrics.routes.ts");
const DEFAULT_LOCALE: Locale = "ru"; // the sibling commons routes' default

type Text = Record<Locale, string>;
interface RawRubric {
  skill: string;
  version: number;
  status: string;
  minVisibility: number;
  criteria: { key: string; label: Text; description: Text; lookFor: Text[] }[];
  recordingTips: Text[];
}

/** The seed file exactly as committed: the oracle for what the route must serve. */
const rawRubrics: RawRubric[] = (
  JSON.parse(readFileSync(join(DEFAULT_SEED_DIR, "football", "rubrics.json"), "utf8")) as { rubrics: RawRubric[] }
).rubrics;

/** Skill slugs of the real skill graph: some of them have no rubric yet. */
const graphSkills: string[] = (
  JSON.parse(readFileSync(join(DEFAULT_SEED_DIR, "football", "skill-graph.json"), "utf8")) as {
    nodes: { slug: string }[];
  }
).nodes.map((node) => node.slug);

/** What the route must answer for one rubric in one locale (every seed text has all locales). */
function expected(rubric: RawRubric, locale: Locale): Rubric {
  return {
    skill: rubric.skill,
    version: rubric.version,
    criteria: rubric.criteria.map((criterion) => ({
      key: criterion.key,
      label: criterion.label[locale],
      description: criterion.description[locale],
      lookFor: criterion.lookFor.map((text) => text[locale]),
    })),
    recordingTips: rubric.recordingTips.map((text) => text[locale]),
    minVisibility: rubric.minVisibility,
  };
}

let routesDir: string;
let db: Database;
let app: Hono;

beforeAll(async () => {
  routesDir = mkdtempSync(join(tmpdir(), "video-rubrics-routes-"));
  // createApp discovers a re-export of the real module exactly like a file in http/routes.
  writeFileSync(join(routesDir, "video-rubrics.routes.ts"), `export { register } from ${JSON.stringify(ROUTE_MODULE)};\n`);
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  app = await createApp({ db, version: "test" }, routesDir, { webDist: join(routesDir, "no-such-dist") });
});

afterAll(() => {
  db.close();
  rmSync(routesDir, { recursive: true, force: true });
});

async function expectProblem(res: Response, status: number): Promise<ProblemDetails> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const text = await res.text();
  const problem = ProblemDetails.parse(JSON.parse(text));
  expect(problem.status).toBe(status);
  expect(text).not.toMatch(/sqlite|select |\.ts:\d+|\bat\s+\S+\s*\(/i);
  return problem;
}

describe("the real seed the tests run on", () => {
  test("has rubrics, and at least one real skill without one", () => {
    expect(rawRubrics.length).toBeGreaterThanOrEqual(1);
    expect(graphSkills.some((slug) => !rawRubrics.some((rubric) => rubric.skill === slug))).toBe(true);
  });
});

describe("GET /api/video/rubrics/:skillSlug", () => {
  for (const locale of LOCALES) {
    test(`serves every seeded rubric as the contract Rubric with ${locale} text`, async () => {
      for (const rubric of rawRubrics) {
        const res = await app.request(`${RUBRIC(rubric.skill)}?locale=${locale}`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body: unknown = await res.json();
        expect(Rubric.parse(body)).toEqual(expected(rubric, locale));
        // Nothing beyond the contract: no seed-only trust status, no other locales' text.
        expect(body).toEqual(expected(rubric, locale));
      }
    });
  }

  test("the three locales really serve three different texts", async () => {
    const skill = rawRubrics[0]!.skill;
    const texts = await Promise.all(
      LOCALES.map(async (locale) => {
        const body = Rubric.parse(await (await app.request(`${RUBRIC(skill)}?locale=${locale}`)).json());
        return body.criteria[0]!.label;
      }),
    );

    expect(new Set(texts).size).toBe(LOCALES.length);
  });

  test("without a locale the text is in the default locale (ru, as the sibling commons routes)", async () => {
    for (const rubric of rawRubrics) {
      const res = await app.request(RUBRIC(rubric.skill));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected(rubric, DEFAULT_LOCALE));
    }
  });

  test("the rubric keeps the seed's version, criteria order and minVisibility", async () => {
    for (const rubric of rawRubrics) {
      const body = Rubric.parse(await (await app.request(`${RUBRIC(rubric.skill)}?locale=en`)).json());

      expect(body.skill).toBe(rubric.skill);
      expect(body.version).toBe(rubric.version);
      expect(body.minVisibility).toBe(rubric.minVisibility);
      expect(body.criteria.map((criterion) => criterion.key)).toEqual(rubric.criteria.map((criterion) => criterion.key));
      expect(body.recordingTips.length).toBe(rubric.recordingTips.length);
    }
  });

  test("a second request answers the same body (the cache never changes an answer)", async () => {
    const skill = rawRubrics[0]!.skill;
    const first = await (await app.request(`${RUBRIC(skill)}?locale=kk`)).json();
    const second = await (await app.request(`${RUBRIC(skill)}?locale=kk`)).json();
    const other = await (await app.request(`${RUBRIC(skill)}?locale=en`)).json();
    const again = await (await app.request(`${RUBRIC(skill)}?locale=kk`)).json();

    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
    expect(again).toEqual(first);
  });

  test("is public: no session or credentials are needed", async () => {
    const res = await app.request(RUBRIC(rawRubrics[0]!.skill), { headers: {} });

    expect(res.status).toBe(200);
  });

  test("an unknown skill is a 404 problem", async () => {
    const problem = await expectProblem(await app.request(RUBRIC("no-such-skill")), 404);

    expect(problem.title).toBe("Not Found");
  });

  test("a real skill that has no rubric is a 404 problem", async () => {
    const skill = graphSkills.find((slug) => !rawRubrics.some((rubric) => rubric.skill === slug))!;

    await expectProblem(await app.request(`${RUBRIC(skill)}?locale=en`), 404);
  });

  test("a skill slug that is not a valid id is a 400 on /skillSlug", async () => {
    const problem = await expectProblem(await app.request(RUBRIC("has%20space")), 400);

    expect(problem.errors.map((error) => error.pointer)).toEqual(["/skillSlug"]);
  });

  test("a bad locale is a 400 on /locale, even for a skill that has a rubric", async () => {
    const problem = await expectProblem(await app.request(`${RUBRIC(rawRubrics[0]!.skill)}?locale=de`), 400);

    expect(problem.errors.map((error) => error.pointer)).toEqual(["/locale"]);
  });

  test("an unknown query key is a 400 at the root pointer", async () => {
    const problem = await expectProblem(await app.request(`${RUBRIC(rawRubrics[0]!.skill)}?foo=1`), 400);

    expect(problem.errors.map((error) => error.pointer)).toEqual([""]);
    expect(problem.errors[0]?.detail).toContain("foo");
  });

  test("only GET is routed: a POST is the app's 404 problem, not a rubric", async () => {
    const res = await app.request(RUBRIC(rawRubrics[0]!.skill), { method: "POST" });

    await expectProblem(res, 404);
  });
});
