// GET /api/video/rubrics/:skillSlug?locale: the AI Video Coach rubric of one skill (fc-mol-8nt.3).
// Public (no auth). Method, path and the Zod params/query schemas come from the contract
// (shared/video ENDPOINTS.getRubric).
//
// WHERE THE DATA COMES FROM: the seed's `<sport>/rubrics.json`. The seed loader only VALIDATES
// that file (there is no rubric table and migrations are frozen), and no repository or exported
// loader function returns rubrics, so this module reads the same files the way the loader does:
// UTF-8 with a leading BOM stripped, JSON, then the loader's own SeedRubricsFile schema, from the
// seed directory the boot hook resolves (SEED_DIR or <repo>/config/commons). The validated
// rubrics are cached per seed directory after the first request: seed files change only with a
// deploy/restart, exactly when the loader re-reads them. A seed the loader would refuse (invalid
// rubrics.json) throws here and becomes the app's 500 problem, never a half-served answer.
//
// Readings the contract leaves open:
//   - The contract sets no default locale (`locale` is optional); like the sibling commons routes
//     the default is Russian, and text follows requested -> ru -> en (primitives' pickLocalized).
//     A seed text has all three locales (SeedText), so the fallback is only a safety net.
//   - A skill slug is unique across sports (skills.slug is unique in the seed), so the rubrics
//     of every sport folder are indexed by skill alone.
//   - A seed with no rubrics.json (or no seed directory) simply has no rubrics: every skill is 404.
//
// Errors are RFC 9457 problems (http/problem): a params/query the contract rejects -> 400 with
// one `errors[]` entry per Zod issue (JSON Pointers `/skillSlug`, `/locale`, "" for an unknown
// query key); an unknown skill, or a skill without a rubric -> 404; anything else is rethrown to
// the app's onError (500 problem).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { resolveSeedDir } from "../../boot/20-seed.boot";
import { SeedRubricsFile } from "../../commons/seed-schema";
import type { SeedRubric } from "../../commons/seed-schema";
import { pickLocalized } from "../../shared/primitives";
import type { Locale, LocalizedText } from "../../shared/primitives";
import { ENDPOINTS } from "../../shared/video";
import type { Rubric } from "../../shared/video";
import { fromZodError, problem } from "../problem";

const DEFAULT_LOCALE: Locale = "ru";
const RUBRICS_FILE = "rubrics.json";

const invalid = (error: ZodError): Response =>
  problem(400, "Bad Request", "Invalid request parameters.", fromZodError(error));

/** Every rubric of every sport folder in the seed directory, by skill slug. Throws on an invalid file. */
function readRubrics(seedDir: string): Map<string, SeedRubric> {
  const bySkill = new Map<string, SeedRubric>();
  if (!existsSync(seedDir) || !statSync(seedDir).isDirectory()) return bySkill;
  for (const sport of readdirSync(seedDir).filter((name) => !name.startsWith(".")).sort()) {
    const file = join(seedDir, sport, RUBRICS_FILE);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    for (const rubric of SeedRubricsFile.parse(JSON.parse(text)).rubrics) bySkill.set(rubric.skill, rubric);
  }
  return bySkill;
}

const cache = new Map<string, Map<string, SeedRubric>>();

function rubrics(seedDir: string): Map<string, SeedRubric> {
  let found = cache.get(seedDir);
  if (found === undefined) {
    found = readRubrics(seedDir);
    cache.set(seedDir, found);
  }
  return found;
}

/** The seed rubric with every text localised: this is the wire `Rubric` (the seed-only status stays behind). */
function localise(rubric: SeedRubric, locale: Locale): Rubric {
  const text = (value: LocalizedText): string => pickLocalized(value, locale) ?? "";
  return {
    skill: rubric.skill,
    version: rubric.version,
    criteria: rubric.criteria.map((criterion) => ({
      key: criterion.key,
      label: text(criterion.label),
      description: text(criterion.description),
      lookFor: criterion.lookFor.map(text),
    })),
    recordingTips: rubric.recordingTips.map(text),
    minVisibility: rubric.minVisibility,
  };
}

export function register(app: Hono, _deps: AppDeps): void {
  const spec = ENDPOINTS.getRubric;

  app.get(spec.path, (c: Context) => {
    const params = spec.params.safeParse(c.req.param());
    if (!params.success) return invalid(params.error);
    const query = spec.query.safeParse(c.req.query());
    if (!query.success) return invalid(query.error);
    const rubric = rubrics(resolveSeedDir()).get(params.data.skillSlug);
    if (rubric === undefined) return problem(404, "Not Found", `No rubric for skill "${params.data.skillSlug}".`);
    return c.json(localise(rubric, query.data.locale ?? DEFAULT_LOCALE), 200);
  });
}
