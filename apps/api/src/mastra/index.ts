// The Mastra instance (fc-mol-zo6.2): LibSQL file store at MASTRA_DB_PATH and a JSON logger.
//
// Created lazily by getMastra(), never at import, so importing this module (and booting
// the API) needs no key and touches no file: every non-AI route works without OPENAI_API_KEY.
// Constructing the instance does not need a key either; callers gate AI work on
// aiAvailable() from ./model.
//
// Options verified against the Mastra docs (context7, /mastra-ai/mastra) and the installed
// types (@mastra/core 1.67, @mastra/libsql 1.23, @mastra/loggers 1.3):
//   new Mastra({ storage, logger }); new LibSQLStore({ id, url: "file:<path>" });
//   new PinoLogger({ name, level, prettyPrint: false }) (prettyPrint false = one raw JSON line per entry).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import type { ModelEnv } from "./model";

/** Store location when MASTRA_DB_PATH is unset (matches .env.example). */
export const DEFAULT_MASTRA_DB_PATH = "./data/mastra.db";

const IN_MEMORY = ":memory:";

function dbPathOf(env: ModelEnv): string {
  const raw = env.MASTRA_DB_PATH?.trim();
  return raw === undefined || raw === "" ? DEFAULT_MASTRA_DB_PATH : raw;
}

let instance: Mastra | undefined;

/**
 * The process-wide Mastra instance, built on first call and reused after that
 * (later calls ignore `env`). `env` defaults to process.env.
 */
export function getMastra(env: ModelEnv = process.env): Mastra {
  if (instance) return instance;

  const path = dbPathOf(env);
  const url = path === IN_MEMORY ? IN_MEMORY : `file:${path}`;
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

  instance = new Mastra({
    storage: new LibSQLStore({ id: "mastra-storage", url }),
    logger: new PinoLogger({ name: "mastra", level: "info", prettyPrint: false }),
  });
  return instance;
}

/** Drops the cached instance (tests). */
export function resetMastra(): void {
  instance = undefined;
}
