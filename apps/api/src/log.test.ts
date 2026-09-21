import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { problem } from './http/problem';
import { register } from './http/routes/00-request-log.routes';
import { createLogger } from './log';

const NOW = new Date('2026-01-02T03:04:05.678Z');

type Line = Record<string, unknown>;

/** A logger whose sink appends to an array: no globals are patched. */
function capture() {
  const lines: string[] = [];
  const logger = createLogger(
    (line) => {
      lines.push(line);
    },
    () => NOW,
  );
  const parsed = (): Line[] => lines.map((line) => JSON.parse(line) as Line);
  return { lines, logger, parsed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createLogger', () => {
  test('emits one parseable JSON line with ts, level, msg and flat fields', () => {
    const { lines, logger, parsed } = capture();
    logger.info('hello', { a: 1, b: 'two' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(parsed()[0]).toEqual({
      level: 'info',
      msg: 'hello',
      a: 1,
      b: 'two',
      ts: '2026-01-02T03:04:05.678Z',
    });
  });

  test('each level method sets the level key', () => {
    const { logger, parsed } = capture();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(parsed().map((line) => line.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  test('fields can never override ts, level or msg', () => {
    const { logger, parsed } = capture();
    logger.info('real', { level: 'error', msg: 'fake', ts: 'yesterday' });
    const [line] = parsed();
    expect(line?.level).toBe('info');
    expect(line?.msg).toBe('real');
    expect(line?.ts).toBe('2026-01-02T03:04:05.678Z');
  });

  test('can emit a line compatible with the boot "listening" line', () => {
    const { lines, logger } = capture();
    logger.info('listening', { port: 4111, version: '1.2.3' });
    expect(lines[0]?.startsWith('{"level":"info","msg":"listening","port":4111,"version":"1.2.3"')).toBe(
      true,
    );
  });

  test('unserializable fields still yield one parseable line and do not throw', () => {
    const { lines, logger, parsed } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info('bad fields', { circular })).not.toThrow();
    expect(() => logger.info('bigint', { n: 10n })).not.toThrow();
    expect(lines).toHaveLength(2);
    expect(parsed().map((line) => line.msg)).toEqual(['bad fields', 'bigint']);
  });

  test('a throwing sink never propagates into the caller', () => {
    const logger = createLogger(() => {
      throw new Error('disk full');
    });
    expect(() => logger.error('x')).not.toThrow();
  });
});

describe('request log middleware', () => {
  const deps = { db: new Database(':memory:'), version: 'test' };

  function build() {
    const cap = capture();
    const app = new Hono();
    // Registered first, exactly as app.ts mounts `00-` modules before the others.
    register(app, deps, cap.logger);
    let errorHandled = 0;
    app.get('/api/drills/:slug', (c) => c.json({ slug: c.req.param('slug') }));
    app.post('/api/echo', async (c) => c.text(await c.req.text(), 201, { 'x-custom': 'kept' }));
    app.post('/recover', (c) => c.json({ ok: true }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.get('/teapot', (c) => c.text('short and stout', 503));
    app.all('/api/*', (c) => c.notFound());
    app.onError((_err, _c) => {
      errorHandled += 1;
      return problem(500, 'Internal Server Error', 'An unexpected error occurred.');
    });
    return { ...cap, app, errorHandledCount: () => errorHandled };
  }

  test('writes exactly one parseable line per request with method, template, status, duration, id', async () => {
    const { app, parsed, lines } = build();
    const res = await app.request('/api/drills/some-drill');
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    const [line] = parsed();
    expect(line?.msg).toBe('request');
    expect(line?.level).toBe('info');
    expect(line?.method).toBe('GET');
    expect(line?.path).toBe('/api/drills/:slug');
    expect(line?.status).toBe(200);
    expect(typeof line?.duration_ms).toBe('number');
    expect(line?.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(line?.ts).toBe('2026-01-02T03:04:05.678Z');
    expect(line?.request_id).toBe(res.headers.get('x-request-id'));
  });

  test('never logs the raw path: a matched route logs its template only', async () => {
    const { app, lines } = build();
    await app.request('/api/drills/SLUGMARKER-9f3');
    expect(lines.join('\n')).not.toContain('SLUGMARKER-9f3');
  });

  test('an unmatched request logs the constant "unmatched", never the raw path', async () => {
    const { app, parsed, lines } = build();
    const res = await app.request('/no/such/RAWPATHMARKER-77');
    expect(res.status).toBe(404);
    expect(lines).toHaveLength(1);
    expect(parsed()[0]?.path).toBe('unmatched');
    expect(parsed()[0]?.status).toBe(404);
    expect(lines.join('\n')).not.toContain('RAWPATHMARKER-77');
  });

  test('an unknown /api path logs its wildcard pattern, not the raw path', async () => {
    const { app, parsed, lines } = build();
    const res = await app.request('/api/APIRAWMARKER-31/deep');
    expect(res.status).toBe(404);
    expect(lines).toHaveLength(1);
    expect(parsed()[0]?.path).toBe('/api/*');
    expect(lines.join('\n')).not.toContain('APIRAWMARKER-31');
  });

  test('never logs bodies, cookies, authorization, query strings or response content', async () => {
    const { app, lines } = build();
    const res = await app.request('/api/echo?token=QUERYMARKER-1', {
      method: 'POST',
      headers: {
        cookie: 'session=COOKIEMARKER-2',
        authorization: 'Bearer AUTHMARKER-3',
        'content-type': 'text/plain',
      },
      body: 'BODYMARKER-4',
    });
    // The handler could still read the body, so the middleware did not consume it.
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('BODYMARKER-4');
    await app.request('/recover?code=RECOVERYMARKER-5&keyframes=KEYFRAMEMARKER-6', {
      method: 'POST',
      body: JSON.stringify({ code: 'RECOVERYBODYMARKER-7' }),
      headers: { 'content-type': 'application/json' },
    });
    const output = lines.join('\n');
    expect(lines).toHaveLength(2);
    for (const marker of [
      'QUERYMARKER-1',
      'COOKIEMARKER-2',
      'AUTHMARKER-3',
      'BODYMARKER-4',
      'RECOVERYMARKER-5',
      'KEYFRAMEMARKER-6',
      'RECOVERYBODYMARKER-7',
    ]) {
      expect(output).not.toContain(marker);
    }
    expect(output).not.toContain('?');
  });

  test('a thrown error logs exactly one line: level error with the stack, in the log only', async () => {
    const { app, parsed, lines, errorHandledCount } = build();
    const res = await app.request('/boom');
    expect(lines).toHaveLength(1);
    const [line] = parsed();
    expect(line?.level).toBe('error');
    expect(line?.status).toBe(500);
    expect(line?.path).toBe('/boom');
    expect(typeof line?.stack).toBe('string');
    expect(line?.stack as string).toContain('kaboom');
    expect(line?.stack as string).toContain('at ');
    // Not swallowed: the app's own error handler ran once and owns the response.
    expect(errorHandledCount()).toBe(1);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('kaboom');
    expect(body).not.toContain('at ');
    expect(JSON.parse(body)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
    });
  });

  test('a 5xx response that was not thrown logs level error without a stack', async () => {
    const { app, parsed } = build();
    const res = await app.request('/teapot');
    expect(res.status).toBe(503);
    const [line] = parsed();
    expect(line?.level).toBe('error');
    expect(line?.status).toBe(503);
    expect(line).not.toHaveProperty('stack');
  });

  test('does not alter the status, body or headers of the response', async () => {
    const { app } = build();
    const res = await app.request('/api/echo', { method: 'POST', body: 'passthrough' });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-custom')).toBe('kept');
    expect(await res.text()).toBe('passthrough');
  });

  test('echoes a sane incoming x-request-id in the header and the log line', async () => {
    const { app, parsed } = build();
    const res = await app.request('/api/drills/x', { headers: { 'x-request-id': 'req-abc_123.X' } });
    expect(res.headers.get('x-request-id')).toBe('req-abc_123.X');
    expect(parsed()[0]?.request_id).toBe('req-abc_123.X');
  });

  test('generates a UUID when the request id is absent', async () => {
    const { app, parsed } = build();
    const res = await app.request('/api/drills/x');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(UUID);
    expect(parsed()[0]?.request_id).toBe(id);
  });

  test.each([
    ['too long', 'a'.repeat(65)],
    ['contains spaces', 'has space'],
    ['contains a quote', 'a"b'],
    ['contains a comma', 'a,b'],
    ['contains a slash', 'a/b'],
  ])('replaces an unsafe incoming request id (%s) with a UUID', async (_name, value) => {
    const { app, parsed, lines } = build();
    const res = await app.request('/api/drills/x', { headers: { 'x-request-id': value } });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(UUID);
    expect(parsed()[0]?.request_id).toBe(id);
    expect(lines.join('\n')).not.toContain(value);
  });

  test('an empty incoming request id is replaced with a UUID', async () => {
    const { app } = build();
    const res = await app.request('/api/drills/x', { headers: { 'x-request-id': '' } });
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  test('the request id header is present on 404 and 500 responses too', async () => {
    const { app, parsed } = build();
    const notFound = await app.request('/nowhere');
    const failed = await app.request('/boom');
    expect(notFound.headers.get('x-request-id')).toMatch(UUID);
    expect(failed.headers.get('x-request-id')).toMatch(UUID);
    expect(parsed().map((line) => line.request_id)).toEqual([
      notFound.headers.get('x-request-id'),
      failed.headers.get('x-request-id'),
    ]);
  });

  test('each request gets its own id and its own line', async () => {
    const { app, parsed } = build();
    await app.request('/api/drills/a');
    await app.request('/api/drills/b');
    const ids = parsed().map((line) => line.request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
