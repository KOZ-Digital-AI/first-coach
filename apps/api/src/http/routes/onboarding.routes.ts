// Onboarding options route: GET /api/onboarding/:sport?locale. Public (no auth). Method, path and
// the Zod params/query/response schemas come from the contract (shared/onboarding ENDPOINTS); the
// enum lists come from the contract's constants and the skill tests from commons/repo, this module
// never touches the database itself.
//
// One call gives the wizard every option list. Each test carries only the protocol in the
// requested locale (requested -> ru -> en, as the repository resolves it), so `locale` decides
// what the player reads and the payload stays a third of the stored one. Thresholds are not part
// of the contract's SkillTest and are never sent.
//
// Errors are RFC 9457 problems (http/problem):
// - a path or query parameter the contract schema rejects -> 400, one `errors[]` entry per Zod
//   issue with a JSON Pointer (`/sport`, `/locale`; an unknown query key sits at the root pointer "");
// - an unknown sport (no sports row, the decision getSkillGraph makes) -> 404;
// - anything else is rethrown to the app's onError (500 problem), never swallowed.
import type { Context, Hono } from 'hono';
import type { ZodError } from 'zod';
import type { AppDeps } from '../../app';
import { getSkillGraph, getSkillTests } from '../../commons/repo';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION } from '../../shared/domain';
import type { SkillTest } from '../../shared/domain';
import { ENDPOINTS } from '../../shared/onboarding';
import type { OnboardingOptions } from '../../shared/onboarding';
import { EQUIPMENT, EXPERIENCE_LEVELS, GOALS, SPACES } from '../../shared/primitives';
import type { Locale } from '../../shared/primitives';
import { fromZodError, problem } from '../problem';

/** The contract sets no default locale (`locale` is optional); Russian is the middle of the fallback chain. */
const DEFAULT_LOCALE: Locale = 'ru';

const invalid = (error: ZodError): Response => problem(400, 'Bad Request', 'Invalid request parameters.', fromZodError(error));

export function register(app: Hono, deps: AppDeps): void {
  const spec = ENDPOINTS.getOptions;

  app.get(spec.path, (c: Context) => {
    const params = spec.params.safeParse(c.req.param());
    if (!params.success) return invalid(params.error);
    const query = spec.query.safeParse(c.req.query());
    if (!query.success) return invalid(query.error);

    const { sport } = params.data;
    const locale = query.data.locale ?? DEFAULT_LOCALE;
    if (getSkillGraph(deps.db, sport, locale) === null) return problem(404, 'Not Found', `No sport "${sport}".`);

    const tests: SkillTest[] = getSkillTests(deps.db, sport, locale).map((test) => {
      const text = test.protocol[locale];
      return {
        slug: test.slug,
        skill: test.skill,
        metric: test.metric,
        unit: test.unit,
        direction: test.direction,
        equipment: test.equipment,
        protocol: text === undefined ? test.protocol : { [locale]: text },
      };
    });

    const options: OnboardingOptions = {
      levels: [...EXPERIENCE_LEVELS],
      goals: [...GOALS],
      equipment: [...EQUIPMENT],
      spaces: [...SPACES],
      partner: [false, true],
      daysPerWeek: [...DAYS_PER_WEEK],
      minutesPerSession: [...MINUTES_PER_SESSION],
      tests,
    };
    return c.json(options, 200);
  });
}
