// Thin entrypoint: `bun apps/api/src/index.ts`. The sequence lives in boot.ts.
import { runBoot } from "./boot";

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
    let code = 0;
    try {
      console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
      await server.stop();
      deps.db.close();
    } catch (error) {
      code = 1;
      console.error(JSON.stringify({ level: "error", msg: "shutdown failed", error: messageOf(error) }));
    } finally {
      process.exit(code);
    }
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
