// Commons read routes: GET /api/commons/drills, /api/commons/drills/:slug and
// /api/commons/skill-graph/:sport. Public (no auth). Method, path and the Zod query/params
// schemas come from the contract (shared/commons-api ENDPOINTS); every read goes through
// commons/repo, this module never touches the database itself.
//
// Errors are RFC 9457 problems (http/problem):
// - a query or path parameter the contract schema rejects -> 400, one `errors[]` entry per Zod
//   issue with a JSON Pointer (`/level`, `/limit`, `/slug`, ...; an unknown query key sits at
//   the root pointer "" and its detail names the key);
// - a cursor the repository cannot decode -> 400 on `/cursor`;
// - an unknown slug or sport -> 404;
// - anything else is rethrown to the app's onError (500 problem), never swallowed.
import type { Context, Hono } from 'hono';
import type { ZodError } from 'zod';
import type { AppDeps } from '../../app';
import { InvalidCursorError, getDrill, getSkillGraph, listDrills } from '../../commons/repo';
import { ENDPOINTS } from '../../shared/commons-api';
import type { Locale } from '../../shared/primitives';
import { fromZodError, problem } from '../problem';

/** The contract sets no default locale (`locale` is optional); Russian is the fallback pivot of pickLocalized. */
const DEFAULT_LOCALE: Locale = 'ru';

const invalid = (error: ZodError): Response => problem(400, 'Bad Request', 'Invalid request parameters.', fromZodError(error));

export function register(app: Hono, deps: AppDeps): void {
  const { listDrills: listSpec, getDrill: drillSpec, getSkillGraph: graphSpec } = ENDPOINTS;

  app.get(listSpec.path, (c: Context) => {
    const query = listSpec.query.safeParse(c.req.query());
    if (!query.success) return invalid(query.error);
    const { locale, ...filters } = query.data;
    try {
      return c.json(listDrills(deps.db, filters, locale ?? DEFAULT_LOCALE), 200);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return problem(400, 'Bad Request', 'Invalid request parameters.', [
          { pointer: '/cursor', detail: 'The cursor is not valid; restart the list without it.' },
        ]);
      }
      throw error;
    }
  });

  app.get(drillSpec.path, (c: Context) => {
    const params = drillSpec.params.safeParse(c.req.param());
    if (!params.success) return invalid(params.error);
    const query = drillSpec.query.safeParse(c.req.query());
    if (!query.success) return invalid(query.error);
    const drill = getDrill(deps.db, params.data.slug, query.data.locale ?? DEFAULT_LOCALE);
    if (drill === null) return problem(404, 'Not Found', `No drill with slug "${params.data.slug}".`);
    return c.json(drill, 200);
  });

  app.get(graphSpec.path, (c: Context) => {
    const params = graphSpec.params.safeParse(c.req.param());
    if (!params.success) return invalid(params.error);
    const query = graphSpec.query.safeParse(c.req.query());
    if (!query.success) return invalid(query.error);
    const graph = getSkillGraph(deps.db, params.data.sport, query.data.locale ?? DEFAULT_LOCALE);
    if (graph === null) return problem(404, 'Not Found', `No sport "${params.data.sport}".`);
    return c.json(graph, 200);
  });
}
