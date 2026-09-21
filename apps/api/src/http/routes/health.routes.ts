// GET /health: liveness plus a database probe. The response is a loose object
// (see HealthResponse), so later beads may add fields (drill count, migration
// version) without breaking existing consumers.
import type { Hono } from 'hono';
import type { AppDeps } from '../../app';
import type { HealthResponse } from '../../shared/primitives';

export function register(app: Hono, deps: AppDeps): void {
  app.get('/health', (c) => {
    // Read per request so a redeploy-time or test-time change is picked up.
    const version = process.env.BUILD_VERSION?.trim() || deps.version;
    try {
      deps.db.query('SELECT 1').get();
      const body: HealthResponse = { ok: true, version, database: 'ok' };
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
