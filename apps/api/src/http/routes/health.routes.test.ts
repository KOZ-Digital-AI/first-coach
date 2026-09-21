import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DEFAULT_SETTINGS, updateSettings } from '../../admin/settings';
import type { AppDeps } from '../../app';
import { DEFAULT_SEED_DIR } from '../../boot/20-seed.boot';
import { loadSeed } from '../../commons/seed-loader';
import { openDatabase } from '../../db/database';
import { MIGRATIONS_DIR, migrate } from '../../db/migrate';
import { HealthResponse } from '../../shared/primitives';
import { register } from './health.routes';

const DEPS_VERSION = '9.8.7-test';

let dir: string;
let db: Database;
let deps: AppDeps;
let app: Hono;
let savedBuildVersion: string | undefined;

beforeEach(() => {
  savedBuildVersion = process.env.BUILD_VERSION;
  delete process.env.BUILD_VERSION;
  dir = mkdtempSync(join(tmpdir(), 'health-routes-'));
  db = openDatabase(join(dir, 'health.db'));
  deps = { db, version: DEPS_VERSION };
  app = new Hono();
  register(app, deps);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
  if (savedBuildVersion === undefined) delete process.env.BUILD_VERSION;
  else process.env.BUILD_VERSION = savedBuildVersion;
});

describe('GET /health', () => {
  test('answers 200 with ok/version/database against a real SQLite file', async () => {
    migrate(db);

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HealthResponse.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ ok: true, version: DEPS_VERSION, database: 'ok' });
  });

  test('responds with an application/json content type', async () => {
    const res = await app.request('/health');

    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('uses BUILD_VERSION when it is set', async () => {
    process.env.BUILD_VERSION = 'build-2026.09.21';

    const res = await app.request('/health');
    const body = HealthResponse.parse(await res.json());

    expect(body.version).toBe('build-2026.09.21');
  });

  test('reads BUILD_VERSION at request time, not at registration time', async () => {
    await app.request('/health');
    process.env.BUILD_VERSION = 'set-after-register';

    const body = HealthResponse.parse(await (await app.request('/health')).json());

    expect(body.version).toBe('set-after-register');
  });

  test('falls back to deps.version when BUILD_VERSION is unset', async () => {
    delete process.env.BUILD_VERSION;

    const body = HealthResponse.parse(await (await app.request('/health')).json());

    expect(body.version).toBe(DEPS_VERSION);
  });

  test('falls back to deps.version when BUILD_VERSION is blank', async () => {
    process.env.BUILD_VERSION = '   ';

    const body = HealthResponse.parse(await (await app.request('/health')).json());

    expect(body.version).toBe(DEPS_VERSION);
  });

  test('answers 503 with ok false and database error when the probe throws', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      db.close();

      const res = await app.request('/health');

      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/json');
      const text = await res.text();
      const body = JSON.parse(text);
      expect(HealthResponse.safeParse(body).success).toBe(true);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
      expect(text).not.toMatch(/^\s*at /m);
      expect(text).not.toMatch(/\bat\s+\S+\s*\(/);
      expect(text).not.toMatch(/sqlite|closed|cannot use|\.ts:\d+/i);
    } finally {
      logged.mockRestore();
    }
  });

  test('logs a single JSON line on probe failure', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      db.close();

      await app.request('/health');

      expect(logged).toHaveBeenCalledTimes(1);
      const [line] = logged.mock.calls[0] as [string];
      expect(typeof line).toBe('string');
      expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      logged.mockRestore();
    }
  });

  test('reports BUILD_VERSION in the 503 body too', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.BUILD_VERSION = 'build-on-failure';
      db.close();

      const body = HealthResponse.parse(await (await app.request('/health')).json());

      expect(body).toMatchObject({ ok: false, version: 'build-on-failure', database: 'error' });
    } finally {
      logged.mockRestore();
    }
  });
});

// --- health details on the real seed ---------------------------------------------------------
// A migrated :memory: database loaded with the real config/commons seed (the same one boot hook
// 20-seed loads). The body keys are pinned: ok, version, database (unchanged) plus publishedDrills
// (number), migration (name of the latest applied schema_migrations row, e.g. "003_settings"),
// aiAvailable (boolean only) and mediaWritable (boolean; unset MEDIA_DIR = false).

const DETAIL_KEYS = ['aiAvailable', 'aiPlannerEnabled', 'database', 'mediaWritable', 'migration', 'ok', 'publishedDrills', 'version'];

const latestMigrationName = (): string => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3,}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  return (files.at(-1) as string).slice(0, -'.sql'.length);
};

describe('GET /health details on the real seed', () => {
  let seeded: Database;
  let mediaDir: string;
  let savedKey: string | undefined;
  let savedMedia: string | undefined;

  const appOn = (database: Database): Hono => {
    const a = new Hono();
    register(a, { db: database, version: DEPS_VERSION });
    return a;
  };
  const get = async (a: Hono): Promise<{ status: number; text: string; body: Record<string, unknown> }> => {
    const res = await a.request('/health');
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };

  beforeAll(() => {
    seeded = openDatabase(':memory:');
    migrate(seeded, MIGRATIONS_DIR);
    loadSeed(seeded, DEFAULT_SEED_DIR);
  });
  afterAll(() => seeded.close());

  beforeEach(() => {
    savedKey = process.env.OPENAI_API_KEY;
    savedMedia = process.env.MEDIA_DIR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MEDIA_DIR;
    mediaDir = mkdtempSync(join(tmpdir(), 'health-media-'));
  });
  afterEach(() => {
    rmSync(mediaDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    if (savedMedia === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = savedMedia;
  });

  test('reports the 60 published drills of the real seed', async () => {
    const { status, body } = await get(appOn(seeded));

    expect(status).toBe(200);
    expect(body.publishedDrills).toBe(60);
  });

  test('reports the latest applied migration, derived from the migrations directory', async () => {
    const { body } = await get(appOn(seeded));

    expect(body.migration).toBe(latestMigrationName());
  });

  test('keeps ok, version and database unchanged and adds exactly the documented keys', async () => {
    const { body } = await get(appOn(seeded));

    expect(body).toMatchObject({ ok: true, version: DEPS_VERSION, database: 'ok' });
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    expect(HealthResponse.safeParse(body).success).toBe(true);
  });

  test('aiAvailable is false when OPENAI_API_KEY is unset or blank, true when set, read per request', async () => {
    const a = appOn(seeded);

    expect((await get(a)).body.aiAvailable).toBe(false);
    process.env.OPENAI_API_KEY = '   ';
    expect((await get(a)).body.aiAvailable).toBe(false);
    process.env.OPENAI_API_KEY = 'sk-marker-123';
    expect((await get(a)).body.aiAvailable).toBe(true);
    delete process.env.OPENAI_API_KEY;
    expect((await get(a)).body.aiAvailable).toBe(false);
  });

  test('mediaWritable is true for an existing writable MEDIA_DIR', async () => {
    process.env.MEDIA_DIR = mediaDir;

    expect((await get(appOn(seeded))).body.mediaWritable).toBe(true);
  });

  test('mediaWritable is false for a MEDIA_DIR that does not exist', async () => {
    process.env.MEDIA_DIR = join(mediaDir, 'missing');

    expect((await get(appOn(seeded))).body.mediaWritable).toBe(false);
  });

  test('mediaWritable is false when MEDIA_DIR is unset or blank', async () => {
    const a = appOn(seeded);

    expect((await get(a)).body.mediaWritable).toBe(false);
    process.env.MEDIA_DIR = '  ';
    expect((await get(a)).body.mediaWritable).toBe(false);
  });

  test('the media check creates nothing in MEDIA_DIR', async () => {
    process.env.MEDIA_DIR = mediaDir;

    await get(appOn(seeded));

    expect(readdirSync(mediaDir)).toEqual([]);
  });

  test('leaks neither the API key nor the media path, on 200 and on 503', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.OPENAI_API_KEY = 'sk-marker-123';
      process.env.MEDIA_DIR = mediaDir;
      const ok = await get(appOn(seeded));
      expect(ok.status).toBe(200);
      expect(ok.text).not.toContain('sk-marker-123');
      expect(ok.text).not.toContain(mediaDir);
      expect(ok.text).not.toContain('health-media-');

      const broken = openDatabase(':memory:');
      broken.close();
      const failed = await get(appOn(broken));
      expect(failed.status).toBe(503);
      expect(failed.text).not.toContain('sk-marker-123');
      expect(failed.text).not.toContain(mediaDir);
    } finally {
      logged.mockRestore();
    }
  });

  test('answers each of 20 sequential requests in under 100 ms', async () => {
    const a = appOn(seeded);
    await get(a);
    const durations: number[] = [];

    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const res = await a.request('/health');
      await res.text();
      durations.push(performance.now() - start);
      expect(res.status).toBe(200);
    }

    expect(Math.max(...durations)).toBeLessThan(100);
  });

  test('a closed database answers 503 with only ok, version and database', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.OPENAI_API_KEY = 'sk-marker-123';
      process.env.MEDIA_DIR = mediaDir;
      const closed = openDatabase(':memory:');
      migrate(closed, MIGRATIONS_DIR);
      closed.close();

      const { status, body } = await get(appOn(closed));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
    } finally {
      logged.mockRestore();
    }
  });

  test('publishedDrills follows the database: 0 on a migrated database with no seed', async () => {
    const empty = openDatabase(':memory:');
    try {
      migrate(empty, MIGRATIONS_DIR);

      const { status, body } = await get(appOn(empty));

      expect(status).toBe(200);
      expect(body.publishedDrills).toBe(0);
    } finally {
      empty.close();
    }
  });

  test('a migrated database whose schema_migrations table is dropped answers 503 (drill tables intact)', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const broken = openDatabase(':memory:');
    try {
      migrate(broken, MIGRATIONS_DIR);
      broken.run('DROP TABLE schema_migrations');

      const { status, body } = await get(appOn(broken));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
    } finally {
      logged.mockRestore();
      broken.close();
    }
  });

  test('a database with an empty schema_migrations table answers 503', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const broken = openDatabase(':memory:');
    try {
      migrate(broken, MIGRATIONS_DIR);
      broken.run('DELETE FROM schema_migrations');

      const { status, body } = await get(appOn(broken));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
    } finally {
      logged.mockRestore();
      broken.close();
    }
  });

  test('a database without schema_migrations is unhealthy: 503, no error text, logged once as JSON', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const unmigrated = openDatabase(':memory:');
    try {
      const { status, text, body } = await get(appOn(unmigrated));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
      expect(text).not.toMatch(/schema_migrations|no such table|sqlite/i);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse((logged.mock.calls[0] as [string])[0])).not.toThrow();
    } finally {
      logged.mockRestore();
      unmigrated.close();
    }
  });
});

// --- aiPlannerEnabled (fc-mol-zo6.11) ----------------------------------------------------------
// A player's client cannot read the admin-only settings route, so GET /health carries the admin
// switch next to aiAvailable. Each test gets its own migrated :memory: database (settings rows are
// written), so nothing leaks between tests or into the shared seeded database above.

describe('GET /health aiPlannerEnabled', () => {
  let own: Database;

  const appOn = (database: Database): Hono => {
    const a = new Hono();
    register(a, { db: database, version: DEPS_VERSION });
    return a;
  };
  const get = async (a: Hono): Promise<{ status: number; text: string; body: Record<string, unknown> }> => {
    const res = await a.request('/health');
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };

  beforeEach(() => {
    own = openDatabase(':memory:');
    migrate(own, MIGRATIONS_DIR);
  });
  afterEach(() => {
    try {
      own.close();
    } catch {
      // already closed by the test
    }
  });

  test('is a boolean on the 200 body and equals the settings default (true) on a fresh database', async () => {
    const { status, body } = await get(appOn(own));

    expect(status).toBe(200);
    expect(typeof body.aiPlannerEnabled).toBe('boolean');
    expect(body.aiPlannerEnabled).toBe(DEFAULT_SETTINGS.aiPlannerEnabled);
    expect(body.aiPlannerEnabled).toBe(true);
    expect(HealthResponse.safeParse(body).success).toBe(true);
  });

  test('is false once the admin stores aiPlannerEnabled=false', async () => {
    updateSettings(own, { aiPlannerEnabled: false });

    expect((await get(appOn(own))).body.aiPlannerEnabled).toBe(false);
  });

  test('is true when the admin stores aiPlannerEnabled=true explicitly', async () => {
    updateSettings(own, { aiPlannerEnabled: false });
    updateSettings(own, { aiPlannerEnabled: true });

    expect((await get(appOn(own))).body.aiPlannerEnabled).toBe(true);
  });

  test('is read per request: an admin change is visible to the same registered app', async () => {
    const a = appOn(own);

    expect((await get(a)).body.aiPlannerEnabled).toBe(true);
    updateSettings(own, { aiPlannerEnabled: false });
    expect((await get(a)).body.aiPlannerEnabled).toBe(false);
    updateSettings(own, { aiPlannerEnabled: true });
    expect((await get(a)).body.aiPlannerEnabled).toBe(true);
  });

  test('a stored value that fails validation reads as the default (true), like the settings getter', async () => {
    own.run("INSERT INTO settings (key, value, updated_at) VALUES ('aiPlannerEnabled', '\"nope\"', '2026-09-21T00:00:00.000Z')");

    const { status, body } = await get(appOn(own));

    expect(status).toBe(200);
    expect(body.aiPlannerEnabled).toBe(true);
  });

  test('is independent of aiAvailable (the API key)', async () => {
    const saved = process.env.OPENAI_API_KEY;
    try {
      updateSettings(own, { aiPlannerEnabled: false });
      process.env.OPENAI_API_KEY = 'sk-marker-123';
      const withKey = (await get(appOn(own))).body;
      expect(withKey.aiAvailable).toBe(true);
      expect(withKey.aiPlannerEnabled).toBe(false);

      updateSettings(own, { aiPlannerEnabled: true });
      delete process.env.OPENAI_API_KEY;
      const noKey = (await get(appOn(own))).body;
      expect(noKey.aiAvailable).toBe(false);
      expect(noKey.aiPlannerEnabled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  test('exposes no other setting: no other settings key and no settings value appears in the body', async () => {
    updateSettings(own, {
      uploadMaxMb: 4321,
      videoCoachEnabled: false,
      retestIntervalsDays: [11, 22],
      minStatusByAgeBand: { u10: 'ACADEMY_VERIFIED' },
    });

    const { body, text } = await get(appOn(own));

    for (const key of ['minStatusByAgeBand', 'uploadMaxMb', 'videoCoachEnabled', 'retestIntervalsDays', 'settings']) {
      expect(Object.keys(body)).not.toContain(key);
    }
    expect(text).not.toContain('4321');
    expect(text).not.toContain('ACADEMY_VERIFIED');
    expect(text).not.toContain('"retestIntervalsDays"');
  });

  test('the 503 body omits aiPlannerEnabled even when the stored switch is off', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      updateSettings(own, { aiPlannerEnabled: false });
      own.run('DELETE FROM schema_migrations');

      const { status, body, text } = await get(appOn(own));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
      expect(text).not.toContain('aiPlannerEnabled');
    } finally {
      logged.mockRestore();
    }
  });

  test('a closed database answers 503 without aiPlannerEnabled', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      own.close();

      const { status, body } = await get(appOn(own));

      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, version: DEPS_VERSION, database: 'error' });
    } finally {
      logged.mockRestore();
    }
  });

  test('reading the switch writes nothing to the settings table', async () => {
    const a = appOn(own);

    await get(a);
    await get(a);

    expect(own.query('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
  });
});
