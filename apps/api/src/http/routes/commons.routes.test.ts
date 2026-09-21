// Commons read routes (fc-mol-hum.1): list, detail and skill graph, served through the real
// createApp (auto-mount, /api/* 404 guard, onError) on an in-memory database migrated with the
// real migrations and loaded with the REAL seed (config/commons). Nothing is mocked or faked:
// every expectation is checked against the contract schemas of shared/commons(-api).
import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hono } from 'hono';
import type { z } from 'zod';
import { createApp } from '../../app';
import { DEFAULT_SEED_DIR } from '../../boot/20-seed.boot';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../commons/repo';
import { loadSeed } from '../../commons/seed-loader';
import { openDatabase } from '../../db/database';
import { MIGRATIONS_DIR, migrate } from '../../db/migrate';
import { DrillDetail, DrillListResponse, SkillGraph, graphProblems } from '../../shared/commons';
import { ENDPOINTS } from '../../shared/commons-api';
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from '../../shared/primitives';

const LIST = ENDPOINTS.listDrills.path;
const DETAIL = (slug: string) => ENDPOINTS.getDrill.path.replace(':slug', slug);
const GRAPH = (sport: string) => ENDPOINTS.getSkillGraph.path.replace(':sport', sport);

const REAL_DRILL = 'ball-mastery-foundation-touches';
const REAL_DRILL_KK_GOAL_START = 'Аяқтың ішкі жағымен';
const KK_ONLY_DRILL = 'weak-foot-air-swings'; // kk "Ауада сермеу", ru "Махи в воздухе"
const TOTAL_DRILLS = 60;
const TOTAL_TRACKS = 5;
const TOTAL_SKILLS = 30;

// Temp route modules resolve nothing from os.tmpdir(), so the mounted module is a re-export of
// the real one by absolute path: createApp discovers it exactly like a file in http/routes.
const ROUTE_MODULE = resolve(import.meta.dir, 'commons.routes.ts');

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
  routesDir = mkdtempSync(join(tmpdir(), 'commons-routes-'));
  writeFileSync(join(routesDir, 'commons.routes.ts'), `export { register } from ${JSON.stringify(ROUTE_MODULE)};\n`);
  db = seededDb();
  app = await buildApp(db);
});

afterAll(() => {
  db.close();
  for (const extra of extraDbs) {
    try {
      extra.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(routesDir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

/** The body equals what the contract schema yields: nothing missing, nothing extra. */
function expectContract<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.parse(body);
  expect(body).toEqual(parsed);
  return parsed;
}

async function getJson(path: string): Promise<{ res: Response; body: unknown }> {
  const res = await app.request(path);
  return { res, body: await res.json() };
}

async function list(query = ''): Promise<DrillListResponse> {
  const { res, body } = await getJson(`${LIST}${query}`);
  expect(res.status).toBe(200);
  return expectContract(ENDPOINTS.listDrills.response, body);
}

async function expectProblem(res: Response, status: number): Promise<ProblemDetails> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const text = await res.text();
  const problem = ProblemDetails.parse(JSON.parse(text));
  expect(problem.status).toBe(status);
  expect(text).not.toMatch(/sqlite|select |\.ts:\d+|\bat\s+\S+\s*\(/i);
  return problem;
}

const pointersOf = (problem: ProblemDetails): string[] => problem.errors.map((error) => error.pointer);

/** Follows nextCursor from the first page until it is null; returns every page. */
async function walk(query = ''): Promise<DrillListResponse[]> {
  const pages: DrillListResponse[] = [];
  let cursor: string | null = null;
  do {
    const sep = query === '' ? '?' : '&';
    const suffix: string = cursor === null ? query : `${query}${sep}cursor=${encodeURIComponent(cursor)}`;
    const page = await list(suffix);
    pages.push(page);
    cursor = page.nextCursor;
    expect(pages.length).toBeLessThan(50);
  } while (cursor !== null);
  return pages;
}

const sum = (entries: { count: number }[]): number => entries.reduce((total, entry) => total + entry.count, 0);

// --- GET /api/commons/drills -------------------------------------------------------------------

describe('GET /api/commons/drills', () => {
  test('answers the first page: DEFAULT_LIMIT items, a next cursor and the total, as the contract shapes them', async () => {
    const { res, body } = await getJson(LIST);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const page = expectContract(DrillListResponse, body);
    expect(DEFAULT_LIMIT).toBe(20);
    expect(page.items).toHaveLength(20);
    expect(typeof page.nextCursor).toBe('string');
    expect(page.total).toBe(TOTAL_DRILLS);
  });

  test('is public: no session or credentials are needed', async () => {
    const res = await app.request(LIST, { headers: {} });

    expect(res.status).toBe(200);
  });

  test('following nextCursor walks all 60 real drills exactly once, in three pages of 20', async () => {
    const pages = await walk();

    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 20]);
    const slugs = pages.flatMap((page) => page.items.map((item) => item.slug));
    expect(slugs).toHaveLength(TOTAL_DRILLS);
    expect(new Set(slugs).size).toBe(TOTAL_DRILLS);
    expect(pages[pages.length - 1]?.nextCursor).toBeNull();
    expect(slugs).toContain(REAL_DRILL);
  });

  test('a page size of 5 returns 5 items and a cursor; the total and facets still cover the whole set', async () => {
    const all = await list();
    const page = await list('?limit=5');

    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(TOTAL_DRILLS);
    expect(page.facets).toEqual(all.facets);
  });

  test('limit=100 returns all 60 drills and no next cursor', async () => {
    const page = await list('?limit=100');

    expect(page.items).toHaveLength(TOTAL_DRILLS);
    expect(page.nextCursor).toBeNull();
  });

  test('a limit above MAX_LIMIT is capped by the repository, not rejected (the contract sets no maximum)', async () => {
    expect(MAX_LIMIT).toBe(100);

    const page = await list('?limit=1000');

    expect(page.items).toHaveLength(TOTAL_DRILLS);
    expect(page.nextCursor).toBeNull();
  });

  test('facets sum to the total: every drill has exactly one status, equipment and level', async () => {
    const { total, facets } = await list();

    expect(total).toBe(TOTAL_DRILLS);
    expect(sum(facets.statuses)).toBe(TOTAL_DRILLS);
    expect(sum(facets.equipment)).toBe(TOTAL_DRILLS);
    expect(sum(facets.levels)).toBe(TOTAL_DRILLS);
    expect(facets.skills.length).toBeGreaterThanOrEqual(TOTAL_TRACKS);
    expect(sum(facets.skills)).toBeGreaterThanOrEqual(TOTAL_DRILLS);
  });

  test('skill filters to the drills linked to that skill', async () => {
    const all = await list();
    const weakFoot = all.facets.skills.find((skill) => skill.slug === 'weak-foot');
    expect(weakFoot?.count).toBeGreaterThan(0);

    const page = await list('?skill=weak-foot&limit=100');

    expect(page.total).toBe(weakFoot?.count as number);
    expect(page.items).toHaveLength(weakFoot?.count as number);
    expect(page.items.map((item) => item.slug)).toContain(KK_ONLY_DRILL);
  });

  test('a well-formed skill nobody has linked is an empty list, not an error', async () => {
    const page = await list('?skill=no-such-skill');

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(0);
  });

  test('status=COMMUNITY keeps the whole seed; a status with no drills is an empty list', async () => {
    expect((await list('?status=COMMUNITY')).total).toBe(TOTAL_DRILLS);

    const none = await list('?status=EXPERT_VERIFIED');

    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.facets.statuses).toEqual([]);
  });

  test('equipment=ball keeps only ball drills, as many as the facet announced', async () => {
    const all = await list();
    const announced = all.facets.equipment.find((entry) => entry.value === 'ball')?.count as number;
    expect(announced).toBeGreaterThan(0);
    expect(announced).toBeLessThan(TOTAL_DRILLS);

    const page = await list('?equipment=ball&limit=100');

    expect(page.total).toBe(announced);
    expect(page.items).toHaveLength(announced);
    expect(page.items.every((item) => item.equipment === 'ball')).toBe(true);
  });

  test('level=beginner keeps only beginner drills, as many as the facet announced', async () => {
    const all = await list();
    const announced = all.facets.levels.find((entry) => entry.value === 'beginner')?.count as number;
    expect(announced).toBeGreaterThan(0);
    expect(announced).toBeLessThan(TOTAL_DRILLS);

    const page = await list('?level=beginner&limit=100');

    expect(page.total).toBe(announced);
    expect(page.items.every((item) => item.level === 'beginner')).toBe(true);
    expect(page.facets.levels).toEqual([{ value: 'beginner', count: announced }]);
  });

  test('filters combine: level and equipment both hold for every item', async () => {
    const page = await list('?level=beginner&equipment=ball&limit=100');

    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((item) => item.level === 'beginner' && item.equipment === 'ball')).toBe(true);
    expect(page.total).toBeLessThan((await list('?level=beginner')).total);
  });

  test('a filtered list can be walked to its end through the cursor', async () => {
    const expected = (await list('?equipment=ball')).total;

    const pages = await walk('?equipment=ball&limit=7');

    const slugs = pages.flatMap((page) => page.items.map((item) => item.slug));
    expect(slugs).toHaveLength(expected);
    expect(new Set(slugs).size).toBe(expected);
  });

  describe('q (literal, case-insensitive text search in the requested locale)', () => {
    test('finds a drill by a word of its real Russian title', async () => {
      const all = await list('?limit=100');
      const source = all.items.find((item) => item.slug === REAL_DRILL);
      const word = (source?.title.ru ?? '')
        .split(/\s+/)
        .filter((each) => /^\p{L}{4,}$/u.test(each))
        .sort((a, b) => b.length - a.length)[0] as string;
      expect(word).toBeTruthy();

      const found = await list(`?locale=ru&limit=100&q=${encodeURIComponent(word)}`);

      expect(found.items.map((item) => item.slug)).toContain(REAL_DRILL);
      expect(found.total).toBeGreaterThan(0);
      expect(found.total).toBeLessThan(TOTAL_DRILLS);
    });

    test('is case-insensitive for Cyrillic', async () => {
      const lower = await list(`?locale=ru&limit=100&q=${encodeURIComponent('махи')}`);
      const upper = await list(`?locale=ru&limit=100&q=${encodeURIComponent('МАХИ')}`);

      expect(lower.items.map((item) => item.slug)).toContain(KK_ONLY_DRILL);
      expect(upper.items.map((item) => item.slug)).toEqual(lower.items.map((item) => item.slug));
    });

    test('finds a drill by a Kazakh title word when the locale is kk', async () => {
      const found = await list(`?locale=kk&limit=100&q=${encodeURIComponent('сермеу')}`);

      expect(found.items.map((item) => item.slug)).toContain(KK_ONLY_DRILL);
    });

    test('searches the requested locale only: the Kazakh word does not match under ru', async () => {
      const found = await list(`?locale=ru&limit=100&q=${encodeURIComponent('сермеу')}`);

      expect(found.items.map((item) => item.slug)).not.toContain(KK_ONLY_DRILL);
    });

    test('finds a drill by a word of its English title', async () => {
      const found = await list(`?locale=en&limit=100&q=${encodeURIComponent('foundation')}`);

      expect(found.items.map((item) => item.slug)).toContain(REAL_DRILL);
    });

    test('a query nothing matches is an empty, well-formed list', async () => {
      const found = await list(`?q=${encodeURIComponent('zzqqxx-no-such-drill')}`);

      expect(found.items).toEqual([]);
      expect(found.nextCursor).toBeNull();
      expect(found.total).toBe(0);
    });

    test('an empty q (a cleared search box) is no filter at all', async () => {
      expect((await list('?q=')).total).toBe(TOTAL_DRILLS);
    });
  });

  describe('locale', () => {
    test('locale=kk returns Kazakh text in the title slot of every item', async () => {
      const page = await list('?locale=kk&limit=100');

      expect(page.items.every((item) => typeof item.title.kk === 'string' && /[Ѐ-ӿ]/.test(item.title.kk))).toBe(true);
      const drill = page.items.find((item) => item.slug === REAL_DRILL);
      expect(drill?.title.kk).toBe('100 негізгі жанасу');
    });

    test('an omitted locale still answers a valid list', async () => {
      const page = await list();

      expect(page.items.every((item) => Object.keys(item.title).length > 0)).toBe(true);
    });

    test('the order follows the requested locale, so kk and ru list differently', async () => {
      const kk = (await list('?locale=kk&limit=100')).items.map((item) => item.slug);
      const ru = (await list('?locale=ru&limit=100')).items.map((item) => item.slug);

      expect([...kk].sort()).toEqual([...ru].sort());
      expect(kk).not.toEqual(ru);
    });
  });

  describe('invalid queries answer a 400 problem with JSON pointers', () => {
    test.each([
      ['level=9', ['/level']],
      ['level=expert', ['/level']],
      ['limit=0', ['/limit']],
      ['limit=-3', ['/limit']],
      ['limit=abc', ['/limit']],
      ['limit=1.5', ['/limit']],
      ['equipment=jetpack', ['/equipment']],
      ['status=PUBLISHED', ['/status']],
      ['locale=de', ['/locale']],
      ['skill=has%20space', ['/skill']],
      ['foo=1', ['']],
    ])('?%s -> %j', async (query, pointers) => {
      const res = await app.request(`${LIST}?${query}`);

      const problem = await expectProblem(res, 400);
      expect(pointersOf(problem)).toEqual(pointers);
      expect(problem.errors.every((error) => error.detail.length > 0)).toBe(true);
    });

    test('an unknown query key is reported at the root pointer and its detail names the key', async () => {
      const problem = await expectProblem(await app.request(`${LIST}?foo=1`), 400);

      expect(problem.errors).toHaveLength(1);
      expect(problem.errors[0]?.pointer).toBe('');
      expect(problem.errors[0]?.detail).toContain('foo');
    });

    test('every invalid value is reported, one pointer each', async () => {
      const problem = await expectProblem(await app.request(`${LIST}?level=9&limit=0&equipment=jetpack`), 400);

      expect([...pointersOf(problem)].sort()).toEqual(['/equipment', '/level', '/limit']);
    });

    test('a valid filter next to an invalid one reports only the invalid one', async () => {
      const problem = await expectProblem(await app.request(`${LIST}?status=COMMUNITY&level=9`), 400);

      expect(pointersOf(problem)).toEqual(['/level']);
    });

    test('a cursor the repository cannot decode is a 400 on /cursor', async () => {
      const problem = await expectProblem(await app.request(`${LIST}?cursor=not-a-cursor`), 400);

      expect(pointersOf(problem)).toEqual(['/cursor']);
      expect(problem.errors[0]?.detail).toMatch(/cursor/i);
    });
  });
});

// --- GET /api/commons/drills/:slug -------------------------------------------------------------

describe('GET /api/commons/drills/:slug', () => {
  test('answers a real drill as the contract DrillDetail, with its history', async () => {
    const { res, body } = await getJson(DETAIL(REAL_DRILL));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const detail = expectContract(DrillDetail, body);
    expect(detail.slug).toBe(REAL_DRILL);
    expect(detail.history.length).toBeGreaterThanOrEqual(1);
    expect(detail.history.map((entry) => entry.versionId)).toContain(detail.versionId);
    expect(detail.attribution.author.length).toBeGreaterThan(0);
    expect(detail.attribution.license).toBe('CC-BY-SA-4.0');
    expect(detail.content.conditions.equipment).toBe('ball');
    expect(detail.reviews).toEqual([]);
  });

  test('locale=kk returns Kazakh text for the goal', async () => {
    const detail = expectContract(DrillDetail, (await getJson(`${DETAIL(REAL_DRILL)}?locale=kk`)).body);

    expect(detail.content.goal.kk).toStartWith(REAL_DRILL_KK_GOAL_START);
  });

  test('every drill the list announces has a detail that satisfies the contract', async () => {
    const slugs = (await list('?limit=100')).items.map((item) => item.slug);
    expect(slugs).toHaveLength(TOTAL_DRILLS);

    for (const slug of slugs) {
      const { res, body } = await getJson(DETAIL(slug));
      expect(res.status).toBe(200);
      expect(expectContract(DrillDetail, body).slug).toBe(slug);
    }
  });

  test('an unknown slug is a 404 problem that leaks nothing', async () => {
    const res = await app.request(DETAIL('no-such-drill'));

    const problem = await expectProblem(res, 404);
    expect(problem.title).toBe('Not Found');
  });

  test('a slug that is not a valid id is a 400 on /slug', async () => {
    const problem = await expectProblem(await app.request(DETAIL('has%20space')), 400);

    expect(pointersOf(problem)).toEqual(['/slug']);
  });

  test('a slug longer than an id may be is a 400 on /slug', async () => {
    const problem = await expectProblem(await app.request(DETAIL('x'.repeat(129))), 400);

    expect(pointersOf(problem)).toEqual(['/slug']);
  });

  test('a bad locale is a 400 on /locale', async () => {
    const problem = await expectProblem(await app.request(`${DETAIL(REAL_DRILL)}?locale=de`), 400);

    expect(pointersOf(problem)).toEqual(['/locale']);
  });

  test('an unknown query key is a 400 at the root pointer', async () => {
    const problem = await expectProblem(await app.request(`${DETAIL(REAL_DRILL)}?foo=1`), 400);

    expect(pointersOf(problem)).toEqual(['']);
    expect(problem.errors[0]?.detail).toContain('foo');
  });

  test('is public: no credentials are needed', async () => {
    expect((await app.request(DETAIL(REAL_DRILL))).status).toBe(200);
  });
});

// --- GET /api/commons/skill-graph/:sport -------------------------------------------------------

describe('GET /api/commons/skill-graph/:sport', () => {
  test('answers the football graph as the contract SkillGraph: 5 tracks and 30 skills', async () => {
    const { res, body } = await getJson(GRAPH('football'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const graph = expectContract(SkillGraph, body);
    expect(graph.sport).toBe('football');
    expect(graph.version.length).toBeGreaterThan(0);
    expect(graph.nodes).toHaveLength(TOTAL_SKILLS);
    expect(graph.nodes.filter((node) => node.parent === null)).toHaveLength(TOTAL_TRACKS);
    expect(graphProblems(graph)).toEqual([]);
  });

  test('every track of the graph is a track the drill list uses', async () => {
    const graph = expectContract(SkillGraph, (await getJson(GRAPH('football'))).body);
    const tracks = new Set(graph.nodes.filter((node) => node.parent === null).map((node) => node.slug));

    const usedTracks = new Set((await list('?limit=100')).items.map((item) => item.track));

    expect([...usedTracks].sort()).toEqual([...tracks].sort());
  });

  test('locale=kk returns Kazakh names for the tracks', async () => {
    const graph = expectContract(SkillGraph, (await getJson(`${GRAPH('football')}?locale=kk`)).body);
    const roots = graph.nodes.filter((node) => node.parent === null);

    expect(roots.every((node) => typeof node.names.kk === 'string' && /[Ѐ-ӿ]/.test(node.names.kk))).toBe(true);
  });

  test('an unknown sport is a 404 problem', async () => {
    const problem = await expectProblem(await app.request(GRAPH('curling')), 404);

    expect(problem.title).toBe('Not Found');
  });

  test('a sport that is not a valid id is a 400 on /sport', async () => {
    const problem = await expectProblem(await app.request(GRAPH('has%20space')), 400);

    expect(pointersOf(problem)).toEqual(['/sport']);
  });

  test('a bad locale is a 400 on /locale', async () => {
    const problem = await expectProblem(await app.request(`${GRAPH('football')}?locale=de`), 400);

    expect(pointersOf(problem)).toEqual(['/locale']);
  });

  test('an unknown query key is a 400 at the root pointer', async () => {
    const problem = await expectProblem(await app.request(`${GRAPH('football')}?foo=1`), 400);

    expect(pointersOf(problem)).toEqual(['']);
  });

  test('is public: no credentials are needed', async () => {
    expect((await app.request(GRAPH('football'))).status).toBe(200);
  });
});

// --- wiring ------------------------------------------------------------------------------------

describe('commons routes in the app', () => {
  test('only GET is routed: a POST to the list is the app 404 problem, not HTML', async () => {
    const res = await app.request(LIST, { method: 'POST' });

    await expectProblem(res, 404);
  });

  test('a path under /api/commons that no route claims is the app 404 problem', async () => {
    await expectProblem(await app.request('/api/commons/nothing-here'), 404);
  });

  test('an unexpected failure is not swallowed: the app onError answers a 500 problem and logs it', async () => {
    const broken = seededDb();
    extraDbs.push(broken);
    const brokenApp = await buildApp(broken);
    broken.close();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const path of [LIST, DETAIL(REAL_DRILL), GRAPH('football')]) {
        const problem = await expectProblem(await brokenApp.request(path), 500);
        expect(problem.title).toBe('Internal Server Error');
      }
      expect(logged).toHaveBeenCalledTimes(3);
    } finally {
      logged.mockRestore();
    }
  });
});
