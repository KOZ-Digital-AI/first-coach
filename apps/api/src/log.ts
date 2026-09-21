// Structured JSON logging: one line per event, flat keys.
//
// Line shape: {"level":…,"msg":…,<fields…>,"ts":"<ISO-8601 UTC>"}.
// `level` and `msg` come first so a line stays compatible with the boot
// `{"level":"info","msg":"listening","port":…,"version":…}` line that the e2e
// harness matches on; `ts` is last. `fields` are merged as flat keys and can
// never override `level`, `msg` or `ts`.
//
// The sink is injected (`createLogger(write)`) so tests capture lines without
// patching globals. Logging never throws into the caller.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
};

const defaultSink: LogSink = (line) => console.log(line);

export function createLogger(
  write: LogSink = defaultSink,
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    const { level: _level, msg: _msg, ts: _ts, ...rest } = fields;
    const ts = now().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ level, msg, ...rest, ts });
    } catch {
      // Circular or otherwise unserializable fields: keep the event, drop the fields.
      line = JSON.stringify({ level, msg, log_error: 'unserializable fields', ts });
    }
    try {
      write(line);
    } catch {
      // A failing sink must never break the request that logged.
    }
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

/** Process-wide logger writing to stdout. */
export const logger: Logger = createLogger();
