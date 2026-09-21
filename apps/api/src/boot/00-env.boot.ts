// First boot hook (the 00- prefix sorts it ahead of every other hook): validate
// the environment before anything else starts. An invalid or missing required
// value throws an EnvError that names the variable and never carries a value;
// the boot runner wraps it as "Boot hook 00-env.boot.ts failed: ...".
import type { AppDeps } from "../app";
import { parseEnv } from "../env";

/** `env` defaults to process.env, read when the hook runs (not at import). */
export function onBoot(_deps: AppDeps, env: Record<string, string | undefined> = process.env): void {
  parseEnv(env);
}
