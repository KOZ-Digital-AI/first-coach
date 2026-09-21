// GET /health: liveness, a database probe and a few cheap, non-secret details. The response is a
// loose object (see HealthResponse), so fields can be added without breaking consumers.
//
// 200 body keys (all stable):
//   ok             true
//   version        BUILD_VERSION (trimmed, read per request) or deps.version
//   database       'ok'
//   publishedDrills number   published drills (commons getStats().drills)
//   migration      string    name of the latest applied schema_migrations row, e.g. '003_settings'
//   aiAvailable    boolean   OPENAI_API_KEY is set and non-blank (never the key itself)
//   aiPlannerEnabled boolean the admin setting of that name (getSettings(db).aiPlannerEnabled, the
//                            same source the ai-plan route reads), read per request; the default
//                            (true) when nothing valid is stored. It lets a player's client hide
//                            the AI button (the settings route is admin-only). Only this one flag
//                            is exposed, never another setting.
//   mediaWritable  boolean   MEDIA_DIR is set, exists and is writable (false when unset/blank;
//                            checked with accessSync only, nothing is created, the path is not echoed)
// 503 body: { ok: false, version, database: 'error' } only. It is returned when the probe or any
// DB-backed detail read throws (a database without schema_migrations is not healthy; a failing
// settings read counts as one). aiPlannerEnabled and the details that need no database
// (aiAvailable, mediaWritable) are omitted there too, for consistency.
import { accessSync, constants } from 'node:fs';
import type { Hono } from 'hono';
import { getSettings } from '../../admin/settings';
import type { AppDeps } from '../../app';
import { getStats } from '../../commons/repo';
import type { HealthResponse } from '../../shared/primitives';

function isMediaWritable(): boolean {
  const dir = process.env.MEDIA_DIR?.trim();
  if (!dir) return false;
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function register(app: Hono, deps: AppDeps): void {
  app.get('/health', (c) => {
    // Read per request so a redeploy-time or test-time change is picked up.
    const version = process.env.BUILD_VERSION?.trim() || deps.version;
    try {
      deps.db.query('SELECT 1').get();
      const publishedDrills = getStats(deps.db).drills;
      const latest = deps.db
        .query<{ name: string }, []>('SELECT name FROM schema_migrations ORDER BY version DESC LIMIT 1')
        .get();
      if (!latest) throw new Error('no applied migrations');
      const body: HealthResponse = {
        ok: true,
        version,
        database: 'ok',
        publishedDrills,
        migration: latest.name,
        aiAvailable: Boolean(process.env.OPENAI_API_KEY?.trim()),
        aiPlannerEnabled: getSettings(deps.db).aiPlannerEnabled,
        mediaWritable: isMediaWritable(),
      };
      return c.json(body, 200);
    } catch (error) {
      // Log server-side only; the response never carries the error text or stack.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'health database probe failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const body: HealthResponse = { ok: false, version, database: 'error' };
      return c.json(body, 503);
    }
  });
}
