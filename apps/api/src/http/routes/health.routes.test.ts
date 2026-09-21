import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppDeps } from '../../app';
import { openDatabase } from '../../db/database';
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
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HealthResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({ ok: true, version: DEPS_VERSION, database: 'ok' });
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
