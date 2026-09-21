// Onboarding options route (fc-mol-9l4.8): GET /api/onboarding/:sport?locale, served through the
// real createApp (auto-mount, /api/* 404 guard, onError) on an in-memory database migrated with
// the real migrations and loaded with the REAL seed (config/commons). Nothing is mocked or faked:
// every expectation is checked against the contract schemas of shared/onboarding and against the
// seed file itself (config/commons/football/tests.json), read independently of the route.
import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../../app';
import { DEFAULT_SEED_DIR } from '../../boot/20-seed.boot';
import { loadSeed } from '../../commons/seed-loader';
import { openDatabase } from '../../db/database';
import { MIGRATIONS_DIR, migrate } from '../../db/migrate';
import { DAYS_PER_WEEK, MINUTES_PER_SESSION, type SkillTest } from '../../shared/domain';
import { ENDPOINTS, OnboardingOptions } from '../../shared/onboarding';
import {
  EQUIPMENT,
  EXPERIENCE_LEVELS,
  GOALS,
  PROBLEM_CONTENT_TYPE,
  ProblemDetails,
  SPACES,
} from '../../shared/primitives';

const OPTIONS = (sport: string, query = '') => `${ENDPOINTS.getOptions.path.replace(':sport', sport)}${query}`;

/** Letters that exist in Kazakh Cyrillic but not in Russian. */
const KAZAKH_LETTERS = /[әғқңөұүһі]/i;
const CYRILLIC = /[Ѐ-ӿ]/;

interface SeedTest extends Omit<SkillTest, 'protocol'> {
  protocol: { kk: string; ru: string; en: string };
}

// The seed file is the oracle: the route must serve exactly what was seeded, sorted by slug.
const SEED_TESTS: SeedTest[] = (
  JSON.parse(readFileSync(join(DEFAULT_SEED_DIR, 'football', 'tests.json'), 'utf8')) as { tests: SeedTest[] }
).tests.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

// A temp route module resolves nothing from os.tmpdir(), so the mounted module is a re-export of
// the real one by absolute path: createApp discovers it exactly like a file in http/routes.
const ROUTE_MODULE = resolve(import.meta.dir, 'onboarding.routes.ts');

let routesDir: string;
let db: Database;
let app: Hono;
const extraDbs: Database[] = [];

async function buildApp(database: Database): Promise<Hono> {
  return createApp({ db: database, version: 'test' }, routesDir, { webDist: join(routesDir, 'no-such-dist') });
}

function seededDb(): Database {
  const database = openDatabase(':memory:');
  migrate(database, MIGRATIONS_DIR);
  loadSeed(database, DEFAULT_SEED_DIR);
  return database;
}

beforeAll(async () => {
  routesDir = mkdtempSync(join(tmpdir(), 'onboarding-routes-'));
  writeFileSync(join(routesDir, 'onboarding.routes.ts'), `export { register } from ${JSON.stringify(ROUTE_MODULE)};\n`);
  db = seededDb();
  app = await buildApp(db);
});

afterAll(() => {
  db.close();
  for (const extra of extraDbs) extra.close();
  rmSync(routesDir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

/** GETs football's options, asserts the contract shape (nothing missing, nothing extra) and returns them. */
async function football(query = ''): Promise<OnboardingOptions> {
  const res = await app.request(OPTIONS('football', query));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body: unknown = await res.json();
  const parsed = OnboardingOptions.parse(body);
  expect(body).toEqual(parsed);
  return parsed;
}

async function expectProblem(res: Response, status: number): Promise<ProblemDetails> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const text = await res.text();
  const parsed = ProblemDetails.parse(JSON.parse(text));
  expect(parsed.status).toBe(status);
  expect(text).not.toMatch(/sqlite|select |\.ts:\d+|\bat\s+\S+\s*\(/i);
  return parsed;
}

const pointersOf = (problem: ProblemDetails): string[] => problem.errors.map((error) => error.pointer);

// --- GET /api/onboarding/:sport ----------------------------------------------------------------

describe('GET /api/onboarding/:sport', () => {
  test('without a locale, serves every option list of the contract and the 5 seeded football tests in Russian, with no auth', async () => {
    // No credentials, no headers: onboarding is public.
    const options = await football();

    expect(options.levels).toEqual([...EXPERIENCE_LEVELS]);
    expect(options.goals).toEqual([...GOALS]);
    expect(options.equipment).toEqual([...EQUIPMENT]);
    expect(options.spaces).toEqual([...SPACES]);
    expect(options.daysPerWeek).toEqual([...DAYS_PER_WEEK]);
    expect(options.minutesPerSession).toEqual([...MINUTES_PER_SESSION]);
    expect([...options.partner].sort()).toEqual([false, true]);

    expect(SEED_TESTS).toHaveLength(5);
    expect(options.tests).toEqual(
      SEED_TESTS.map((seeded) => ({
        slug: seeded.slug,
        skill: seeded.skill,
        metric: seeded.metric,
        unit: seeded.unit,
        direction: seeded.direction,
        equipment: seeded.equipment,
        protocol: { ru: seeded.protocol.ru }, // the default locale is ru, the middle of the fallback chain
      })),
    );
  });

  test('with locale=kk, every test carries its Kazakh protocol text, not the Russian one', async () => {
    const options = await football('?locale=kk');

    expect(options.tests).toHaveLength(SEED_TESTS.length);
    for (const [index, test] of options.tests.entries()) {
      const seeded = SEED_TESTS[index]!;
      expect(test.slug).toBe(seeded.slug);
      expect(test.protocol).toEqual({ kk: seeded.protocol.kk });
      expect(test.protocol.kk).toMatch(KAZAKH_LETTERS);
      expect(test.protocol.kk).not.toBe(seeded.protocol.ru);
    }
  });

  test('with locale=en, every test carries its English protocol text', async () => {
    const options = await football('?locale=en');

    expect(options.tests).toHaveLength(SEED_TESTS.length);
    for (const [index, test] of options.tests.entries()) {
      const seeded = SEED_TESTS[index]!;
      expect(test.protocol).toEqual({ en: seeded.protocol.en });
      expect(test.protocol.en).not.toMatch(CYRILLIC);
    }
  });

  test('an unknown sport is a 404 problem, a malformed sport slug a 400 on /sport, and a sport row without tests never borrows football\'s', async () => {
    const missing = await expectProblem(await app.request(OPTIONS('curling')), 404);
    expect(missing.title).toBe('Not Found');

    const malformed = await expectProblem(await app.request(OPTIONS('not%20a%20slug')), 400);
    expect(pointersOf(malformed)).toEqual(['/sport']);

    // A second, real sport row (no skills, no tests) in its own migrated + seeded database.
    const other = seededDb();
    extraDbs.push(other);
    other.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sport-futsal', 'futsal', '{"en":"Futsal"}', '0.1.0')`);
    const futsalApp = await buildApp(other);
    const res = await futsalApp.request(OPTIONS('futsal'));
    expect(res.status).toBe(200);
    const futsal = OnboardingOptions.parse(await res.json());
    expect(futsal.tests).toEqual([]);
    expect(futsal.levels).toEqual([...EXPERIENCE_LEVELS]);
  });

  test('rejects what the contract query schema rejects: an unknown key (root pointer) and an unsupported locale (/locale)', async () => {
    const unknownKey = await expectProblem(await app.request(OPTIONS('football', '?colour=red')), 400);
    expect(pointersOf(unknownKey)).toEqual(['']);

    const badLocale = await expectProblem(await app.request(OPTIONS('football', '?locale=de')), 400);
    expect(pointersOf(badLocale)).toEqual(['/locale']);
  });
});
