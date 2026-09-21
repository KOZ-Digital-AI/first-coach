// Static checks over docs/runbook.md and railway.json (fc-mol-4ds.8). No Railway, no Docker daemon: the
// real deploy is a human step, listed in the runbook's "Not yet verified" section.
//
// The runbook must be ACCURATE against the repo, so these tests derive their expectations from the
// source instead of restating them:
//   - env vars from ENV_VARIABLES (apps/api/src/env.ts), .env.example and the `env.NAME` reads in the api;
//   - the health path and body keys from health.routes.ts, the volume layout from the Dockerfile;
//   - every `bun ...` / `docker ...` command in a fenced block is validated against the repo: scripts and
//     files must exist, the admin CLI arguments must pass the CLI's own parser, docker flags/args must be
//     ones the Dockerfile and the env schema know.
// Assertions name what must hold; they never pin the exact wording or the whole section list, so the
// runbook may grow.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SettingsPatch } from "../apps/api/src/admin/settings";
import { parseAdminArgs } from "../apps/api/src/cli/admin";
import { ENV_VARIABLES, EnvError, parseEnv } from "../apps/api/src/env";

const repoRoot = join(import.meta.dir, "..");
const RUNBOOK_PATH = "docs/runbook.md";
const RAILWAY_PATH = "railway.json";

/** A missing file reads as empty so each test fails on its own assertion instead of the module failing to load. */
const readRoot = (name: string): string => {
  const path = join(repoRoot, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const runbook = readRoot(RUNBOOK_PATH);
const railwayText = readRoot(RAILWAY_PATH);
const dockerfile = readRoot("Dockerfile");
const envExample = readRoot(".env.example");
const healthSource = readRoot("apps/api/src/http/routes/health.routes.ts");

// ---------------------------------------------------------------- markdown helpers

/** Text of the `## ` section whose heading matches `heading` (up to the next `## `), or "". */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

type Fence = { lang: string; body: string };
const fences = (text: string): Fence[] =>
  [...text.matchAll(/^```([\w-]*)\n([\s\S]*?)^```/gm)].map((m) => ({ lang: m[1] as string, body: m[2] as string }));

/** Runbook text with fenced blocks removed (prose only). */
const prose = (text: string): string => text.replace(/^```[\w-]*\n[\s\S]*?^```/gm, "");

/** Splits one shell line into words: single and double quotes group, backslash escapes are not interpreted. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current !== "") words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
    }
  }
  if (started || current !== "") words.push(current);
  return words;
}

/** Command lines of a shell block: continuations joined, comments and blanks dropped, a leading `$ ` removed. */
export function commandLines(body: string): string[] {
  const out: string[] = [];
  let buffer: string | undefined;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (buffer === undefined && (line === "" || line.startsWith("#"))) continue;
    const continues = line.endsWith("\\");
    const piece = continues ? line.slice(0, -1).trim() : line;
    buffer = buffer === undefined ? piece : `${buffer} ${piece}`;
    if (!continues) {
      out.push(buffer.replace(/^\$\s+/, ""));
      buffer = undefined;
    }
  }
  if (buffer !== undefined) out.push(buffer);
  return out;
}

// ---------------------------------------------------------------- what the repo knows

/** Names the api reads from the environment outside ENV_VARIABLES (SEED_DIR, ADMIN_PASSWORD, ...). */
function envReadsInApi(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/(?:process\.env|\benv|\bsource|\bio\.env)\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1] as string);
      }
    }
  };
  walk(join(repoRoot, "apps/api/src"));
  return names;
}
const sourceEnvNames = envReadsInApi();

const exampleNames = new Set(
  [...envExample.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
);

/** Variables owned by Railway or the shell, not read by the app: the runbook may name them. */
const PLATFORM_VARIABLES = new Set(["RAILWAY_RUN_UID"]);

const knownEnvNames = new Set<string>([...ENV_VARIABLES, ...exampleNames, ...sourceEnvNames]);

/** Names the runbook must document even though env.ts does not validate them. */
const READ_OUTSIDE_SCHEMA = ["BETTER_AUTH_TRUSTED_ORIGINS", "SEED_DIR", "ADMIN_PASSWORD", "NODE_ENV"];

const dockerArgs = new Set([...dockerfile.matchAll(/^ARG\s+([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1] as string));

function workspaceScripts(): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const root = JSON.parse(readRoot("package.json")) as { name: string; scripts?: Record<string, string> };
  map.set("", root.scripts ?? {});
  for (const app of readdirSync(join(repoRoot, "apps"))) {
    const path = join("apps", app, "package.json");
    if (!existsSync(join(repoRoot, path))) continue;
    const pkg = JSON.parse(readRoot(path)) as { name: string; scripts?: Record<string, string> };
    map.set(pkg.name, pkg.scripts ?? {});
  }
  return map;
}

// ---------------------------------------------------------------- command validation

const isFile = (relative: string): boolean => existsSync(join(repoRoot, relative)) && statSync(join(repoRoot, relative)).isFile();
const isPath = (relative: string): boolean => existsSync(join(repoRoot, relative));

function checkEnvName(name: string, where: string): string[] {
  return knownEnvNames.has(name) || PLATFORM_VARIABLES.has(name) ? [] : [`${where}: unknown environment variable ${name}`];
}

/**
 * `bun -e "<script>"`: every relative import must resolve to a repo file that exports each imported
 * name, so an inline snippet cannot call a function that does not exist.
 */
function inlineScriptProblems(script: string, shown: string): string[] {
  const problems: string[] = [];
  for (const m of script.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2] as string;
    if (!spec.startsWith(".")) continue; // bun:sqlite and friends
    const file = `${spec.replace(/^\.\//, "")}.ts`;
    if (!isFile(file)) {
      problems.push(`${shown}: import ${spec} does not resolve to ${file}`);
      continue;
    }
    const source = readRoot(file);
    for (const name of (m[1] as string).split(",").map((n) => n.trim()).filter(Boolean)) {
      if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).test(source)) {
        problems.push(`${shown}: ${file} does not export ${name}`);
      }
    }
  }
  return problems;
}

/** Problems with a `bun ...` command (tokens[0] is "bun"); an empty list means it is valid. */
export function bunProblems(tokens: string[]): string[] {
  const [, sub, ...rest] = tokens;
  if (sub === undefined) return ["bun: no subcommand"];
  const shown = tokens.join(" ");
  if (sub === "install") return [];
  if (sub === "-e") return inlineScriptProblems(rest[0] ?? "", shown);
  if (sub === "run") {
    const scripts = workspaceScripts();
    let pkg = "";
    const args = [...rest];
    if (args[0] === "--filter") {
      pkg = args[1] ?? "";
      args.splice(0, 2);
    }
    const script = args[0];
    if (!scripts.has(pkg)) return [`${shown}: no workspace package "${pkg}"`];
    if (script === undefined || !Object.hasOwn(scripts.get(pkg) as object, script)) {
      return [`${shown}: no script "${script}" in ${pkg === "" ? "the root package.json" : pkg}`];
    }
    return [];
  }
  if (sub === "test") {
    return rest.filter((arg) => !arg.startsWith("-") && !isPath(arg.replace(/^\.\//, ""))).map((arg) => `${shown}: no such test path ${arg}`);
  }
  if (/\.(ts|js|tsx)$/.test(sub)) {
    if (!isFile(sub)) return [`${shown}: no such file ${sub}`];
    if (sub === "apps/api/src/cli/admin.ts") {
      const parsed = parseAdminArgs(rest);
      return parsed.ok ? [] : [`${shown}: the admin CLI rejects these arguments${parsed.message ? ` (${parsed.message})` : ""}`];
    }
    if (sub === "apps/api/src/cli/restore.ts") {
      return rest.length === 1 && !(rest[0] as string).startsWith("-") ? [] : [`${shown}: restore.ts takes exactly one backup file`];
    }
    if (sub === "apps/api/src/index.ts") return rest.length === 0 ? [] : [`${shown}: index.ts takes no arguments`];
    return [];
  }
  return [`${shown}: unknown bun subcommand ${sub}`];
}

const DOCKER_VALUE_FLAGS = new Set(["-t", "--tag", "--build-arg", "-f", "--file", "-p", "-v", "-e", "--name"]);
const DOCKER_BOOLEAN_FLAGS = new Set(["--rm", "-d", "-i", "-it", "-ti"]);

/** Problems with a `docker ...` command (tokens[0] is "docker"). */
export function dockerProblems(tokens: string[]): string[] {
  const [, sub, ...rest] = tokens;
  const shown = tokens.join(" ");
  if (sub === undefined) return ["docker: no subcommand"];
  if (["stop", "rm", "logs"].includes(sub)) return [];
  if (!["build", "run", "exec"].includes(sub)) return [`${shown}: unsupported docker subcommand ${sub}`];

  const problems: string[] = [];
  let i = 0;
  const positional: string[] = [];
  for (; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "bun" && sub !== "build") break;
    if (arg.startsWith("-")) {
      if (DOCKER_VALUE_FLAGS.has(arg)) {
        const value = rest[++i] ?? "";
        if (arg === "-e" || arg === "--build-arg") {
          const name = value.split("=")[0] as string;
          if (arg === "-e") problems.push(...checkEnvName(name, shown));
          else if (!dockerArgs.has(name)) problems.push(`${shown}: --build-arg ${name} is not an ARG in the Dockerfile`);
        }
        if ((arg === "-f" || arg === "--file") && !isFile(value)) problems.push(`${shown}: no such Dockerfile ${value}`);
      } else if (!DOCKER_BOOLEAN_FLAGS.has(arg)) {
        problems.push(`${shown}: unsupported docker flag ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  if (sub === "build") {
    const context = positional[positional.length - 1];
    if (context === undefined || !isPath(context)) problems.push(`${shown}: build context ${context} does not exist`);
    return problems;
  }
  if (positional.length < 1) problems.push(`${shown}: docker ${sub} needs an image or container`);
  if (i < rest.length) problems.push(...bunProblems(rest.slice(i)));
  return problems;
}

/** Problems with every command line of one shell block. Lines that are not bun/docker are not checked. */
export function shellBlockProblems(body: string): string[] {
  const problems: string[] = [];
  for (const line of commandLines(body)) {
    let words = shellWords(line);
    // Leading NAME=value assignments belong to the command that follows.
    while (words.length > 0 && /^[A-Z][A-Z0-9_]*=/.test(words[0] as string)) {
      problems.push(...checkEnvName((words[0] as string).split("=")[0] as string, line));
      words = words.slice(1);
    }
    if (words[0] === "bun") problems.push(...bunProblems(words));
    else if (words[0] === "docker") problems.push(...dockerProblems(words));
  }
  return problems;
}

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "console"]);
const shellBlocks = fences(runbook).filter((f) => SHELL_LANGS.has(f.lang));

// ---------------------------------------------------------------- tests

describe("railway.json", () => {
  // The keys Railway's JSON schema (https://railway.com/railway.schema.json, fetched 2026-09-21) allows.
  const BUILD_KEYS = ["builder", "watchPatterns", "buildCommand", "dockerfilePath", "nixpacksConfigPath", "nixpacksPlan", "nixpacksVersion", "railpackVersion"];
  const DEPLOY_KEYS = [
    "startCommand", "preDeployCommand", "preDeployTimeoutSeconds", "numReplicas", "healthcheckPath", "healthcheckTimeout",
    "sleepApplication", "runtime", "registryCredentials", "restartPolicyType", "restartPolicyMaxRetries", "cronSchedule",
    "region", "multiRegionConfig", "limitOverride", "requiredMountPath", "overlapSeconds", "drainingSeconds", "ipv6EgressEnabled",
  ];

  type Config = { $schema?: string; build?: Record<string, unknown>; deploy?: Record<string, unknown> } & Record<string, unknown>;
  const config = (): Config => JSON.parse(railwayText) as Config;

  test("is valid JSON with the Railway schema reference", () => {
    expect(railwayText).not.toBe("");
    expect(config().$schema).toBe("https://railway.com/railway.schema.json");
  });

  test("uses only keys the Railway schema defines (no typos)", () => {
    const c = config();
    expect(Object.keys(c).filter((k) => !["$schema", "build", "deploy", "environments"].includes(k))).toEqual([]);
    expect(Object.keys(c.build ?? {}).filter((k) => !BUILD_KEYS.includes(k))).toEqual([]);
    expect(Object.keys(c.deploy ?? {}).filter((k) => !DEPLOY_KEYS.includes(k))).toEqual([]);
  });

  test("builds from the Dockerfile that exists in the repo", () => {
    const build = config().build ?? {};
    expect(build.builder).toBe("DOCKERFILE");
    expect(typeof build.dockerfilePath).toBe("string");
    expect(isFile(build.dockerfilePath as string)).toBe(true);
  });

  test("healthcheckPath is the path health.routes.ts serves, with a 120 second timeout", () => {
    const servedPath = /app\.get\(\s*['"]([^'"]+)['"]/.exec(healthSource)?.[1];
    expect(servedPath).toBe("/health");
    const deploy = config().deploy ?? {};
    expect(deploy.healthcheckPath).toBe(servedPath);
    expect(deploy.healthcheckTimeout).toBe(120);
  });

  test("restarts on failure with a bounded number of retries", () => {
    const deploy = config().deploy ?? {};
    expect(deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(Number.isInteger(deploy.restartPolicyMaxRetries)).toBe(true);
    expect(deploy.restartPolicyMaxRetries as number).toBeGreaterThanOrEqual(1);
  });

  test("runs exactly one replica (SQLite on one volume, one scheduler)", () => {
    expect(config().deploy?.numReplicas).toBe(1);
  });

  test("leaves the start command to the Dockerfile CMD", () => {
    expect(config().deploy ?? {}).not.toHaveProperty("startCommand");
    expect(dockerfile).toMatch(/^CMD \["bun","apps\/api\/src\/index\.ts"\]/m);
  });
});

describe("secrets", () => {
  const patterns: Array<[string, RegExp]> = [
    ["an OpenAI-style key (sk-...)", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["a long hex string (32+ characters)", /\b[0-9a-fA-F]{32,}\b/],
    ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ];
  for (const [file, text] of [[RUNBOOK_PATH, runbook], [RAILWAY_PATH, railwayText]] as const) {
    test(`${file} exists and contains no secret-looking values`, () => {
      expect(text).not.toBe("");
      for (const [what, pattern] of patterns) expect(`${file}: ${pattern.test(text) ? what : "clean"}`).toBe(`${file}: clean`);
    });
  }
});

describe("runbook environment table", () => {
  const envSection = section(runbook, /environment variables/i);
  const rows = new Map<string, string[]>(
    [...envSection.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|(.*)\|\s*$/gm)].map((m) => [
      m[1] as string,
      (m[2] as string).split("|").map((cell) => cell.trim()),
    ]),
  );

  test("the api-source scan finds the variables read outside env.ts (so the checks below are not vacuous)", () => {
    for (const name of READ_OUTSIDE_SCHEMA) expect(sourceEnvNames.has(name)).toBe(true);
  });

  test("has an environment variables section with a table", () => {
    expect(envSection).not.toBe("");
    expect(rows.size).toBeGreaterThan(0);
  });

  test("every variable in the table exists in ENV_VARIABLES, .env.example or the api source", () => {
    const unknown = [...rows.keys()].filter((name) => !knownEnvNames.has(name));
    expect(unknown).toEqual([]);
  });

  test("every ENV_VARIABLES key is documented in the table", () => {
    expect(ENV_VARIABLES.filter((name) => !rows.has(name))).toEqual([]);
  });

  test("variables the api reads outside the schema are documented too", () => {
    expect(READ_OUTSIDE_SCHEMA.filter((name) => !rows.has(name))).toEqual([]);
  });

  test("required-in-production variables are marked Required, the other schema variables Optional", () => {
    let required: string[] = [];
    try {
      parseEnv({ NODE_ENV: "production" });
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      required = error.variables;
    }
    expect(required).toEqual(expect.arrayContaining(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]));
    for (const name of ENV_VARIABLES) {
      const requiredCell = rows.get(name)?.[0] ?? "";
      expect(`${name}: ${/^required/i.test(requiredCell) ? "required" : "optional"}`).toBe(
        `${name}: ${required.includes(name) ? "required" : "optional"}`,
      );
    }
  });

  test("environment names used in fenced blocks are known variables", () => {
    const names = fences(runbook).flatMap((f) => [...f.body.matchAll(/(?:^|\s)-e\s+([A-Z][A-Z0-9_]*)|^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/gm)]).map((m) => (m[1] ?? m[2]) as string);
    expect(names.filter((name) => !knownEnvNames.has(name) && !PLATFORM_VARIABLES.has(name) && !dockerArgs.has(name))).toEqual([]);
  });

  test("states the production rules: secret length, fail closed, wildcard origins rejected", () => {
    const text = prose(runbook);
    expect(text).toMatch(/BETTER_AUTH_SECRET/);
    expect(text).toMatch(/at least 32/i);
    expect(text).toMatch(/fail(s|ed)? closed|fail-closed/i);
    expect(text).toMatch(/wildcard/i);
    expect(text).toMatch(/BETTER_AUTH_URL/);
  });

  test("says AI features are off without OPENAI_API_KEY and that Railway injects PORT", () => {
    const openai = (rows.get("OPENAI_API_KEY") ?? []).join(" ");
    expect(openai).toMatch(/optional/i);
    expect(openai).toMatch(/AI/);
    expect((rows.get("PORT") ?? []).join(" ")).toMatch(/Railway/i);
    expect(readRoot("apps/api/src/index.ts")).toMatch(/parsePort\(process\.env\.PORT\)/);
  });
});

describe("runbook commands", () => {
  test("the runbook has shell blocks with bun and docker commands", () => {
    const all = shellBlockProblems(shellBlocks.map((b) => b.body).join("\n"));
    expect(shellBlocks.length).toBeGreaterThan(0);
    expect(all).toEqual([]);
    const lines = shellBlocks.flatMap((b) => commandLines(b.body));
    expect(lines.some((l) => l.startsWith("bun apps/api/src/cli/admin.ts create"))).toBe(true);
    expect(lines.some((l) => l.startsWith("bun apps/api/src/cli/admin.ts reset-password"))).toBe(true);
    expect(lines.some((l) => l.startsWith("bun apps/api/src/cli/admin.ts list"))).toBe(true);
    expect(lines.some((l) => l.includes("bun apps/api/src/cli/restore.ts"))).toBe(true);
    expect(lines.some((l) => l.startsWith("docker build"))).toBe(true);
  });

  test("restore commands name a backup file that matches the backup naming pattern", () => {
    const targets = shellBlocks
      .flatMap((b) => commandLines(b.body))
      .flatMap((line) => {
        const words = shellWords(line);
        const at = words.indexOf("apps/api/src/cli/restore.ts");
        return at === -1 ? [] : [words[at + 1] as string];
      });
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toMatch(/\/first-coach-\d{4}-\d{2}-\d{2}\.sqlite$/);
  });

  test("no command passes a password as an argument", () => {
    for (const block of shellBlocks) expect(block.body).not.toMatch(/--password|--pass\b|\s-p\s*\S*[Ss]ecret/);
  });

  test("json blocks that carry settings are accepted by the settings patch schema", () => {
    const patches = fences(runbook).filter((f) => f.lang === "json" && /aiPlannerEnabled|videoCoachEnabled/.test(f.body));
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect(SettingsPatch.safeParse(JSON.parse(patch.body)).success).toBe(true);
  });

  describe("the command checker itself", () => {
    test("accepts what the repo has", () => {
      expect(shellBlockProblems("bun run typecheck\nbun test test/runbook.test.ts\nbun apps/api/src/cli/admin.ts list")).toEqual([]);
      expect(shellBlockProblems("bun apps/api/src/cli/admin.ts create --email a@b.co --name 'Coach A'")).toEqual([]);
      expect(shellBlockProblems("docker build -t first-coach:local .")).toEqual([]);
    });
    test("rejects a script, file, admin command, flag or docker flag that does not exist", () => {
      expect(shellBlockProblems("bun run migrate:prod")).not.toEqual([]);
      expect(shellBlockProblems("bun apps/api/src/cli/seed.ts")).not.toEqual([]);
      expect(shellBlockProblems("bun apps/api/src/cli/admin.ts promote --email a@b.co")).not.toEqual([]);
      expect(shellBlockProblems("bun apps/api/src/cli/admin.ts create --email a@b.co --name X --password Y")).not.toEqual([]);
      expect(shellBlockProblems("docker build -f Dockerfile.prod .")).not.toEqual([]);
      expect(shellBlockProblems("docker run --privileged first-coach:local")).not.toEqual([]);
      expect(shellBlockProblems("docker run -e BETTER_AUTH_SECRETT=x first-coach:local")).not.toEqual([]);
      expect(shellBlockProblems("FOO_BAR=1 bun apps/api/src/index.ts")).not.toEqual([]);
      expect(shellBlockProblems(`bun -e "import { nope } from './apps/api/src/ops/backup'; nope()"`)).not.toEqual([]);
      expect(shellBlockProblems(`bun -e "import { backupDatabase } from './apps/api/src/ops/missing'"`)).not.toEqual([]);
      expect(shellBlockProblems(`bun -e "import { backupDatabase } from './apps/api/src/ops/backup'; backupDatabase"`)).toEqual([]);
    });
  });
});

describe("runbook content matches the repo", () => {
  test("names the /data layout the Dockerfile sets", () => {
    for (const name of ["APP_DB_PATH", "MEDIA_DIR", "MASTRA_DB_PATH", "BACKUP_DIR"]) {
      const value = new RegExp(`${name}=(\\S+)`).exec(dockerfile)?.[1];
      expect(value?.startsWith("/data/")).toBe(true);
      expect(runbook).toContain(value as string);
    }
  });

  test("health section documents the path and every field of the 200 body", () => {
    const body = /const body: HealthResponse = \{([\s\S]*?)\};/.exec(healthSource)?.[1] ?? "";
    // `version,` and `publishedDrills,` are shorthand properties: a key ends at a colon or a comma.
    const keys = [...body.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1] as string);
    expect(keys).toEqual(expect.arrayContaining(["ok", "version", "database", "publishedDrills", "migration", "aiAvailable", "mediaWritable"]));
    const health = section(runbook, /health/i);
    expect(health).toContain("/health");
    for (const key of keys) expect(health).toContain(`\`${key}\``);
    expect(health).toMatch(/503/);
  });

  test("boot order: migrations, then every boot hook in filename order, then the routes", () => {
    const hooks = readdirSync(join(repoRoot, "apps/api/src/boot"))
      .filter((f) => f.endsWith(".boot.ts") && !f.endsWith(".test.ts"))
      .map((f) => f.replace(/\.boot\.ts$/, ""))
      .sort();
    expect(hooks).toEqual(expect.arrayContaining(["00-env", "20-seed", "40-backup"]));
    const restart = section(runbook, /restart/i);
    const positions = ["migrat", ...hooks, "routes"].map((needle) => restart.toLowerCase().indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("backup schedule, retention and file naming match the code", () => {
    const backupHook = readRoot("apps/api/src/boot/40-backup.boot.ts");
    const keep = /DEFAULT_KEEP = (\d+)/.exec(readRoot("apps/api/src/ops/backup.ts"))?.[1];
    expect(BACKUP_SCHEDULE_TEXT(backupHook)).toBe("0 3 * * *");
    const backups = section(runbook, /backups/i);
    expect(backups).toMatch(/03:00 UTC/);
    expect(backups).toContain(`newest ${keep}`);
    expect(backups).toContain("first-coach-YYYY-MM-DD.sqlite");
    expect(backups).toContain("/data/backups");
  });

  test("restore section states the CLI refuses while the server is up and keeps a safety copy", () => {
    const restore = section(runbook, /restor/i);
    expect(restore).toMatch(/refuses/i);
    expect(restore).toMatch(/pre-restore/);
    expect(restore).toMatch(/same (container|network)/i);
  });

  test("admin CLI section names the three commands and ADMIN_PASSWORD", () => {
    const admin = section(runbook, /first admin/i);
    for (const command of ["create", "reset-password", "list"]) expect(admin).toContain(command);
    expect(admin).toContain("ADMIN_PASSWORD");
    expect(admin).toMatch(/never (a )?command-line argument|not a command-line argument/i);
  });

  test("seed section names SEED_DIR, patch-bumped versions and the community-edit caveat fc-9s7", () => {
    const seed = section(runbook, /seed/i);
    expect(seed).toContain("SEED_DIR");
    expect(seed).toMatch(/patch/i);
    expect(seed).toContain("fc-9s7");
    expect(seed).toMatch(/COMMUNITY/);
    expect(seed).toContain("config/commons");
  });

  test("every /api path and repo path the runbook mentions exists", () => {
    const apiSources = (() => {
      const chunks: string[] = [];
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) chunks.push(readFileSync(p, "utf8"));
        }
      };
      walk(join(repoRoot, "apps/api/src"));
      return chunks.join("\n");
    })();
    const apiPaths = [...runbook.matchAll(/`(\/(?:api|health)[A-Za-z0-9_\/:.-]*)`/g)].map((m) => m[1] as string);
    expect(apiPaths.length).toBeGreaterThan(0);
    expect(apiPaths.filter((p) => !apiSources.includes(`"${p}"`) && !apiSources.includes(`'${p}'`))).toEqual([]);

    const BUILD_OUTPUT = new Set(["apps/web/dist"]);
    const repoPaths = [...runbook.matchAll(/(?<![\w/.-])((?:apps|config|test|docs)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])/g)].map((m) => m[1] as string);
    expect(repoPaths.length).toBeGreaterThan(0);
    expect(repoPaths.filter((p) => !isPath(p) && !BUILD_OUTPUT.has(p))).toEqual([]);
    for (const file of ["Dockerfile", ".env.example", "railway.json"]) expect(runbook).toContain(file);
  });
});

describe("runbook sections", () => {
  // One heading (level 2) per topic, matched case-insensitively.
  const topics: Array<[string, RegExp]> = [
    ["creating the Railway project and the /data volume", /^##\s.*railway project.*\/data volume|^##\s.*\/data volume.*railway project/im],
    ["required variables", /^##\s.*(required|environment) variables/im],
    ["RAILWAY_RUN_UID", /^##\s.*RAILWAY_RUN_UID/m],
    ["exactly one instance", /^##\s.*(exactly )?one instance/im],
    ["the first admin", /^##\s.*first admin/im],
    ["deploy and rollback", /^##\s.*deploy.*roll ?back/im],
    ["backups and restore", /^##\s.*backup.*restor/im],
    ["the restore drill", /^##\s.*restore.*drill/im],
    ["what happens on restart", /^##\s.*(what happens on )?restart/im],
    ["rotating BETTER_AUTH_SECRET and the OpenAI key", /^##\s.*rotat.*BETTER_AUTH_SECRET.*(openai|OPENAI)/im],
    ["a content takedown request", /^##\s.*takedown/im],
    ["turning AI and video off", /^##\s.*(AI|video).*off|^##\s.*turning.*off/im],
    ["updating the seed", /^##\s.*(updating|update).*seed/im],
    ["the first-deploy checklist", /^##\s.*first-deploy checklist/im],
    ["the health endpoint", /^##\s.*health/im],
    ["the rate limiter behind the proxy", /^##\s.*rate limit/im],
    ["Not yet verified", /^##\s.*not yet verified/im],
  ];
  for (const [topic, heading] of topics) {
    test(`has a heading for ${topic}`, () => {
      expect(runbook).toMatch(heading);
    });
  }

  test("RAILWAY_RUN_UID=0 is spelled out and tied to the volume", () => {
    // Body only: the heading itself already contains the words, so it must not satisfy the check.
    const text = section(runbook, /RAILWAY_RUN_UID/).split("\n").slice(1).join("\n");
    expect(text).toContain("RAILWAY_RUN_UID=0");
    expect(text).toMatch(/volume/i);
  });

  test("one-instance section says why: SQLite and the nightly scheduler, and that railway.json pins one replica", () => {
    const text = section(runbook, /one instance/i);
    expect(text).toMatch(/SQLite/);
    expect(text).toMatch(/schedul/i);
    expect(text).toContain("numReplicas");
  });

  test("the first-deploy checklist is a task list that includes the X-Forwarded-For rate-limiter check", () => {
    const checklist = section(runbook, /first-deploy checklist/i);
    expect((checklist.match(/^- \[ \] /gm) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(checklist).toMatch(/^- \[ \] .*X-Forwarded-For/m);
    expect(checklist).toContain("/health");
    expect(checklist).toContain("BETTER_AUTH_TRUSTED_ORIGINS");
  });

  test("the rate limiter section explains the advisory in the auth source", () => {
    const text = section(runbook, /rate limit/i);
    expect(text).toContain("X-Forwarded-For");
    expect(text).toMatch(/deploy time|deploy-time/i);
    expect(readRoot("apps/api/src/auth/better-auth.ts")).toContain("X-Forwarded-For");
  });

  test("Not yet verified names the external blockers", () => {
    const text = section(runbook, /not yet verified/i);
    expect(text).toMatch(/GitHub/);
    expect(text).toMatch(/Railway project/i);
    expect(text).toMatch(/OpenAI/);
    expect(text).toMatch(/Kazakh/);
  });

  test("takedown section says what exists: the unpublished_at column and the contract-only unpublish endpoint", () => {
    const text = section(runbook, /takedown/i);
    expect(text).toContain("unpublished_at");
    expect(text).toContain("/api/admin/drills/:slug/unpublish");
    expect(text).toMatch(/not (yet )?(implemented|mounted)/i);
  });

  test("turning AI off: names both settings keys, the endpoint and OPENAI_API_KEY", () => {
    const text = section(runbook, /turning|\boff\b/i);
    for (const needle of ["aiPlannerEnabled", "videoCoachEnabled", "/api/admin/settings", "OPENAI_API_KEY"]) expect(text).toContain(needle);
  });
});

/** The cron expression of the nightly backup, read from the hook source. */
function BACKUP_SCHEDULE_TEXT(source: string): string | undefined {
  return /BACKUP_SCHEDULE = "([^"]+)"/.exec(source)?.[1];
}
