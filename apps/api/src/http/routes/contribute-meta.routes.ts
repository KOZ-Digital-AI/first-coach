// Contribute meta route: GET /api/contribute/meta?locale. Public (no auth). Method, path and the
// Zod query/response schemas come from the contract (shared/contributions ENDPOINTS.getMeta).
//
// One call gives the contribution form every option list and the upload limits:
// - sports: every sport row (slug + the LocalizedText name the row holds), in slug order;
// - skills: ONE tree, the tracks (roots of the skill graph) with their children, built from the
//   repository's getSkillGraph of each sport. With several sports their tracks are merged in the
//   sports' order; slugs are unique across sports, so the merged tree is unambiguous. Names carry
//   the requested locale filled by the repository's fallback (requested -> ru -> en);
// - levels, equipment, spaces, licenses, improvementKinds and upload.mimeTypes: the contract's
//   own constants, never copies;
// - upload.maxMb: settings.uploadMaxMb, read on every request (no module cache).
//
// Errors are RFC 9457 problems (http/problem):
// - a query the contract schema rejects -> 400, one `errors[]` entry per Zod issue with a JSON
//   Pointer (`/locale`; an unknown query key sits at the root pointer "");
// - no sport in the database (the seed has not been loaded) -> 503, because the contract requires
//   at least one sport and an empty list would be a schema-invalid answer;
// - anything else is rethrown to the app's onError (500 problem), never swallowed.
import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../../app";
import { getSettings } from "../../admin/settings";
import { getSkillGraph } from "../../commons/repo";
import {
  type ContributionMeta,
  ENDPOINTS,
  IMPROVEMENT_KINDS,
  type SkillOption,
  type SportOption,
  UPLOAD_MIME_TYPES,
} from "../../shared/contributions";
import {
  EQUIPMENT,
  EXPERIENCE_LEVELS,
  LICENSE_IDS,
  type Locale,
  LocalizedText,
  SPACES,
  pickLocalized,
} from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

/** The contract sets no default locale (`locale` is optional); Russian is the middle of the fallback chain. */
const DEFAULT_LOCALE: Locale = "ru";

/** The text with the requested locale filled by the fallback chain, as the repository localizes names. */
function localize(text: LocalizedText, locale: Locale): LocalizedText {
  const picked = pickLocalized(text, locale);
  return picked === undefined ? text : { ...text, [locale]: picked };
}

/** Every sport, by slug. `sports.name` is the LocalizedText JSON the row stores. */
function listSports(db: Database, locale: Locale): SportOption[] {
  return db
    .query<{ slug: string; name: string }, []>("SELECT slug, name FROM sports ORDER BY slug")
    .all()
    .map(({ slug, name }) => ({ slug, name: localize(LocalizedText.parse(JSON.parse(name)), locale) }));
}

/** The tracks of one sport with their children nested. Graph nodes come parent before child. */
function skillTree(db: Database, sport: string, locale: Locale): SkillOption[] {
  const graph = getSkillGraph(db, sport, locale);
  if (graph === null) return [];
  const bySlug = new Map<string, SkillOption>();
  const tracks: SkillOption[] = [];
  for (const node of graph.nodes) {
    const option: SkillOption = { slug: node.slug, name: node.names, children: [] };
    bySlug.set(node.slug, option);
    const parent = node.parent === null ? undefined : bySlug.get(node.parent);
    (parent === undefined ? tracks : parent.children).push(option);
  }
  return tracks;
}

export function register(app: Hono, deps: AppDeps): void {
  const spec = ENDPOINTS.getMeta;

  app.get(spec.path, (c: Context) => {
    const query = spec.query.safeParse(c.req.query());
    if (!query.success) {
      return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(query.error));
    }
    const locale = query.data.locale ?? DEFAULT_LOCALE;

    const sports = listSports(deps.db, locale);
    if (sports.length === 0) {
      return problem(503, "Service Unavailable", "The commons is not seeded yet");
    }

    const body: ContributionMeta = {
      sports,
      skills: sports.flatMap((sport) => skillTree(deps.db, sport.slug, locale)),
      levels: [...EXPERIENCE_LEVELS],
      equipment: [...EQUIPMENT],
      spaces: [...SPACES],
      licenses: [...LICENSE_IDS],
      improvementKinds: [...IMPROVEMENT_KINDS],
      upload: { maxMb: getSettings(deps.db).uploadMaxMb, mimeTypes: [...UPLOAD_MIME_TYPES] },
    };
    return c.json(body, 200);
  });
}
