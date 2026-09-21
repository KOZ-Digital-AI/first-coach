// Thin entrypoint: `bun apps/api/src/index.ts`. The sequence lives in boot.ts.
import { runBoot } from "./boot";
import { stopBackupSchedule } from "./boot/40-backup.boot";

const DEFAULT_PORT = 4111;
// Bun's default is 10 s and closes a request that sends no bytes for that long;
// synchronous AI / video-analysis calls take far longer. 255 s is Bun's maximum.
const IDLE_TIMEOUT_SECONDS = 255;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Unset or empty means the default; otherwise a plain decimal integer in 1..65535. */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

export type ShutdownContext = {
  server: { stop(): unknown };
  db: { close(): void };
  /** Log sink (tests). Defaults to console.log for info lines, console.error for error lines. */
  log?: (line: object) => void;
  /** Cancels the nightly backup schedule. Defaults to stopBackupSchedule. */
  stopBackup?: () => void;
  /** Process exit (tests). Defaults to process.exit. */
  exit?: (code: number) => void;
};

const defaultLog = (line: object): void => {
  const text = JSON.stringify(line);
  if ((line as { level?: string }).level === "error") console.error(text);
  else console.log(text);
};

/**
 * Graceful shutdown: stop the backup schedule first (so no backup fires against
 * a closed database), then the server, then the DB, then exit. Any failure logs
 * "shutdown failed" and exits 1. Resolves to the exit code.
 */
export async function shutdownSequence(ctx: ShutdownContext, signal: string): Promise<number> {
  const log = ctx.log ?? defaultLog;
  const stopBackup = ctx.stopBackup ?? stopBackupSchedule;
  const exit = ctx.exit ?? ((code: number) => process.exit(code));
  let code = 0;
  try {
    log({ level: "info", msg: "shutting down", signal });
    stopBackup();
    await ctx.server.stop();
    ctx.db.close();
  } catch (error) {
    code = 1;
    log({ level: "error", msg: "shutdown failed", error: messageOf(error) });
  } finally {
    exit(code);
  }
  return code;
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const { app, deps } = await runBoot();
  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: IDLE_TIMEOUT_SECONDS });
  console.log(
    JSON.stringify({ level: "info", msg: "listening", port: server.port, version: deps.version }),
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await shutdownSequence({ server, db: deps.db }, signal);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "boot failed",
        error: messageOf(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    process.exit(1);
  });
}
