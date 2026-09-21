// Request logging middleware: one JSON line per request. The `00-` prefix makes
// this module mount before every other route module (see app.ts).
//
// Logged: method, path TEMPLATE (never the raw URL), status, duration_ms and
// request id; a 5xx that carries an Error also logs its stack. NEVER logged:
// bodies, headers (cookies, authorization), query strings, request or response
// content. The middleware never reads the body, never swallows an error and
// never changes the response, apart from adding `x-request-id`.
import type { Hono } from 'hono';
import type { AppDeps } from '../../app';
import { logger, type Logger } from '../../log';

/** An incoming x-request-id is echoed only if it is a short, header-safe token. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Path template used when no route matched (the raw path may carry secrets). */
const UNMATCHED = 'unmatched';

export function register(app: Hono, _deps: AppDeps, log: Logger = logger): void {
  app.use('*', async (c, next) => {
    const started = performance.now();
    const supplied = c.req.header('x-request-id');
    const requestId =
      supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();

    let thrown: unknown;
    let completed = false;
    try {
      await next();
      completed = true;
      // Set after next(): headers set before it are absent on the notFound/onError responses.
      c.header('x-request-id', requestId);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const status = completed ? c.res.status : 500;
      const error = thrown ?? c.error;
      // routePath is the deepest matched route; the bare wildcard is this middleware itself.
      const routePath = c.req.routePath;
      const path = routePath === '/*' || routePath === '*' ? UNMATCHED : routePath;
      const fields = {
        method: c.req.method,
        path,
        status,
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
        request_id: requestId,
        ...(status >= 500 && error instanceof Error && { stack: error.stack }),
      };
      if (status >= 500) log.error('request', fields);
      else log.info('request', fields);
    }
  });
}
