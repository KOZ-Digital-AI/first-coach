// apps/web/e2e/j1b-validate.mjs: helper of the gate j1b-commons.sh (bead fc-mol-dzt). Validates a downloaded Commons export against
// the JSON Schema the API serves, with ajv (draft 2020-12, strict, formats), and prints ONE JSON line:
//   {"valid": bool, "errors": [first 10 ajv errors], "drills": N, "unattributed": [slugs], "sports": N}
// Usage (from any cwd): bun apps/web/e2e/j1b-validate.mjs <schema.json> <export.json>
// ajv is a dependency of apps/api (not of apps/web), so it is resolved from apps/api's package.json: nothing new is installed.
// Exit 0 = the script ran (read `valid`), 2 = it could not run (bad arguments, unreadable file, ajv missing).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [schemaPath, dataPath] = process.argv.slice(2);
if (!schemaPath || !dataPath) {
  console.error('usage: bun j1b-validate.mjs <schema.json> <export.json>');
  process.exit(2);
}
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const requireFromApi = createRequire(resolve(here, '../../api/package.json'));
  const Ajv2020 = requireFromApi('ajv/dist/2020').default ?? requireFromApi('ajv/dist/2020');
  const addFormats = requireFromApi('ajv-formats').default ?? requireFromApi('ajv-formats');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(data) === true;
  const sports = Array.isArray(data?.sports) ? data.sports : [];
  const drills = sports.flatMap((sport) => (Array.isArray(sport?.drills) ? sport.drills : []));
  const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
  const unattributed = drills
    .filter((d) => !(nonEmpty(d?.attribution?.author) && nonEmpty(d?.attribution?.source) && nonEmpty(d?.attribution?.license)))
    .map((d) => d?.slug ?? '?');
  console.log(
    JSON.stringify({
      valid,
      errors: (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message}`),
      drills: drills.length,
      unattributed,
      sports: sports.length,
    }),
  );
} catch (error) {
  console.error(`j1b-validate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
