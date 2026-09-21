// Static checks over Dockerfile and .dockerignore. No Docker daemon: the real
// `docker build` and the container /health run are proven by the S0 gate.
//
// The Dockerfile is parsed by instruction (comments stripped, continuation lines
// joined), so a comment that mentions `EXPOSE 4111` cannot satisfy an assertion.
// Assertions name what must hold; they never pin the exact instruction list, so a
// later bead may add labels or args.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const readRoot = (name: string): string => readFileSync(join(repoRoot, name), "utf8");

const BASE_IMAGE = "oven/bun:1.4.2";
const APP_DIR = "/app";

// ---------------------------------------------------------------- Dockerfile parser

interface Instruction {
  keyword: string;
  args: string;
}

interface Stage {
  index: number;
  image: string;
  name: string | undefined;
  instructions: Instruction[]; // everything after this stage's FROM
}

/** Drops comment lines and joins backslash continuations, like the Docker parser. */
export function logicalLines(text: string): string[] {
  const out: string[] = [];
  let buffer: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue; // also inside a continuation
    const continues = line.endsWith("\\");
    const piece = continues ? line.slice(0, -1).trimEnd() : line;
    buffer = buffer === undefined ? piece : `${buffer} ${piece}`;
    if (!continues) {
      out.push(buffer);
      buffer = undefined;
    }
  }
  if (buffer !== undefined) out.push(buffer);
  return out;
}

export function parseStages(text: string): { preamble: Instruction[]; stages: Stage[] } {
  const preamble: Instruction[] = [];
  const stages: Stage[] = [];
  for (const line of logicalLines(text)) {
    const match = /^(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const instruction: Instruction = { keyword: (match[1] ?? "").toUpperCase(), args: match[2] ?? "" };
    if (instruction.keyword === "FROM") {
      const tokens = instruction.args.split(/\s+/).filter((token) => !token.startsWith("--"));
      const asAt = tokens.findIndex((token) => token.toUpperCase() === "AS");
      stages.push({
        index: stages.length,
        image: tokens[0] ?? "",
        name: asAt === -1 ? undefined : tokens[asAt + 1],
        instructions: [],
      });
    } else {
      const current = stages.at(-1);
      if (current) current.instructions.push(instruction);
      else preamble.push(instruction);
    }
  }
  return { preamble, stages };
}

interface Copy {
  from: string | undefined;
  sources: string[];
  dest: string;
}

export function parseCopy(args: string): Copy {
  let from: string | undefined;
  let rest = args.trim();
  for (;;) {
    const flag = /^--(\S+?)(?:=(\S*))?\s+/.exec(rest);
    if (!flag) break;
    if (flag[1] === "from") from = flag[2];
    rest = rest.slice(flag[0].length);
  }
  const paths: string[] = rest.startsWith("[") ? (JSON.parse(rest) as string[]) : rest.split(/\s+/);
  return { from, sources: paths.slice(0, -1), dest: paths.at(-1) ?? "" };
}

/** Effective ENV of a stage (`ENV K=V K2="V 2"` and the legacy `ENV K V` form). */
export function envOf(stage: Stage): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { keyword, args } of stage.instructions) {
    if (keyword !== "ENV") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) {
      for (const pair of args.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|\S*)/g)) {
        env[pair[1] ?? ""] = pair[3] ?? pair[4] ?? pair[2] ?? "";
      }
    } else {
      const legacy = /^(\S+)\s+(.*)$/.exec(args);
      if (legacy) env[legacy[1] ?? ""] = (legacy[2] ?? "").replace(/^"(.*)"$/, "$1");
    }
  }
  return env;
}

/** The individual shell commands of a stage's RUN instructions, in order, with their instruction index. */
function runCommands(stage: Stage): Array<{ at: number; command: string; tokens: string[] }> {
  const out: Array<{ at: number; command: string; tokens: string[] }> = [];
  stage.instructions.forEach((instruction, at) => {
    if (instruction.keyword !== "RUN") return;
    const body = instruction.args.replace(/^(?:--\S+\s+)+/, ""); // --mount=... and friends
    for (const part of body.split(/&&|\|\||;/)) {
      const command = part.trim();
      if (command !== "") out.push({ at, command, tokens: command.split(/\s+/) });
    }
  });
  return out;
}

const isManifest = (source: string): boolean => /(^|\/)(package\.json|bun\.lock|bunfig\.toml)$/.test(source);

/** Index of the first COPY/ADD from the build context that brings in anything but manifests. */
const firstSourceCopyAt = (stage: Stage): number =>
  stage.instructions.findIndex(
    ({ keyword, args }) =>
      (keyword === "COPY" || keyword === "ADD") &&
      parseCopy(args).from === undefined &&
      parseCopy(args).sources.some((source) => !isManifest(source)),
  );

const isBunInstall = (tokens: string[]): boolean =>
  tokens[0] === "bun" && (tokens[1] === "install" || tokens[1] === "i");

const workdirAtEnd = (stage: Stage): string => {
  let dir = "/";
  for (const { keyword, args } of stage.instructions) {
    if (keyword === "WORKDIR") dir = posix.resolve(dir, args.trim());
  }
  return dir;
};

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * True when some COPY of `stage` puts the file or directory at `sourceSuffix` (as seen
 * in its source: the build context root, or the source stage's final WORKDIR) at
 * `expectedDest`. A directory source needs `dest` to be the target itself (a copy copies
 * the directory's CONTENTS); a file source (basename with a dot) may also target a
 * directory with a trailing slash.
 */
function copiesTo(
  stages: Stage[],
  stage: Stage,
  sourceSuffix: string,
  expectedDest: string,
  match: (copy: Copy) => boolean = () => true,
): boolean {
  const destBase = workdirAtEnd(stage);
  return stage.instructions.some(({ keyword, args }) => {
    if (keyword !== "COPY" && keyword !== "ADD") return false;
    const copy = parseCopy(args);
    if (!match(copy)) return false;
    const sourceStage = copy.from === undefined ? undefined : stageByRef(stages, copy.from);
    if (copy.from !== undefined && !sourceStage) return false;
    const sourceBase = sourceStage ? workdirAtEnd(sourceStage) : "/";
    return copy.sources.some((source) => {
      const resolved = trimSlash(posix.resolve(sourceBase, source));
      if (resolved !== `/${sourceSuffix}` && !resolved.endsWith(`/${sourceSuffix}`)) return false;
      const dest = posix.resolve(destBase, copy.dest);
      if (dest === expectedDest) return true;
      const isFile = basename(resolved).includes(".");
      return isFile && copy.dest.endsWith("/") && posix.join(dest, basename(resolved)) === expectedDest;
    });
  });
}

function stageByRef(stages: Stage[], ref: string): Stage | undefined {
  return stages.find((stage) => stage.name === ref) ?? (/^\d+$/.test(ref) ? stages[Number(ref)] : undefined);
}

const dockerfile = (): { preamble: Instruction[]; stages: Stage[]; text: string } => {
  const text = readRoot("Dockerfile");
  return { ...parseStages(text), text };
};

const stagesOf = () => {
  const { stages } = dockerfile();
  const build = stages.find((stage) => stage.name === "build");
  const runtime = stages.at(-1);
  if (!build || !runtime || build === runtime) {
    throw new Error("Dockerfile must have a `build` stage followed by a distinct final runtime stage");
  }
  return { stages, build, runtime };
};

// ---------------------------------------------------------------- .dockerignore matcher

/** Lines of a .dockerignore: comments and blanks dropped. */
export function ignorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function patternRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?"; // `**/` is zero or more directories
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Docker's rule: patterns are anchored at the context root; a pattern that matches a
 * path or any parent directory of it excludes it; a later pattern (`!`-prefixed
 * re-includes) overrides an earlier one.
 */
export function isIgnored(patterns: string[], path: string): boolean {
  const clean = posix.normalize(path).replace(/^\.?\//, "");
  const parts = clean.split("/");
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const body = posix.normalize((negated ? raw.slice(1) : raw).trim()).replace(/^\/+/, "");
    const regexp = patternRegExp(body);
    const hit = parts.some((_, i) => regexp.test(parts.slice(0, i + 1).join("/")));
    if (hit) ignored = !negated;
  }
  return ignored;
}

const dockerignore = (): string[] => ignorePatterns(readRoot(".dockerignore"));

// ---------------------------------------------------------------- self-checks of the helpers

describe("the parsers used below are not fooled by comments", () => {
  test("comment lines vanish and continuations are joined", () => {
    const parsed = parseStages(
      ["# EXPOSE 4111", "FROM a AS one", "# HEALTHCHECK CMD x", "RUN echo a \\", "  # note", "  && echo b", "EXPOSE 80"].join("\n"),
    );
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0]?.instructions).toEqual([
      { keyword: "RUN", args: "echo a && echo b" },
      { keyword: "EXPOSE", args: "80" },
    ]);
  });

  test("ENV parsing handles both forms and quotes", () => {
    const stage = parseStages('FROM a\nENV A=1 B="x y"\nENV C legacy value').stages[0] as Stage;
    expect(envOf(stage)).toEqual({ A: "1", B: "x y", C: "legacy value" });
  });

  test("the .dockerignore matcher follows Docker's anchoring, parents and negation", () => {
    const patterns = ["**/node_modules", ".env", ".env.*", "!.env.example", "data"];
    expect(isIgnored(patterns, "apps/api/node_modules/hono/index.js")).toBe(true);
    expect(isIgnored(patterns, ".env.local")).toBe(true);
    expect(isIgnored(patterns, ".env.example")).toBe(false);
    expect(isIgnored(patterns, "data/app.db")).toBe(true);
    expect(isIgnored(patterns, "apps/api/src/db/data")).toBe(false); // anchored at the root
    expect(isIgnored(["node_modules"], "apps/api/node_modules")).toBe(false); // root only without **/
  });
});

// ---------------------------------------------------------------- Dockerfile

describe("Dockerfile base images", () => {
  test("there is a build stage and a distinct runtime stage", () => {
    const { stages, build, runtime } = stagesOf();
    expect(stages.length).toBeGreaterThanOrEqual(2);
    expect(build.index).toBeLessThan(runtime.index);
  });

  test(`build and runtime stages are both ${BASE_IMAGE}`, () => {
    const { build, runtime } = stagesOf();
    expect(build.image).toBe(BASE_IMAGE);
    expect(runtime.image).toBe(BASE_IMAGE);
  });

  test("every stage is pinned: an image or an earlier stage, never latest or untagged", () => {
    const { stages } = dockerfile();
    const seen: string[] = [];
    for (const stage of stages) {
      if (!seen.includes(stage.image)) {
        expect(stage.image).toMatch(/^[^:\s]+:[^:\s]+$/);
        expect(stage.image.endsWith(":latest")).toBe(false);
      }
      if (stage.name) seen.push(stage.name);
    }
  });

  test("no instruction refers to a :latest tag", () => {
    const lines = logicalLines(dockerfile().text);
    expect(lines.filter((line) => /:latest\b/.test(line))).toEqual([]);
  });
});

describe("Dockerfile build stage", () => {
  test("installs with `bun install --frozen-lockfile`", () => {
    const { build } = stagesOf();
    const installs = runCommands(build).filter(({ tokens }) => isBunInstall(tokens));
    expect(installs.length).toBeGreaterThan(0);
    expect(installs.some(({ tokens }) => tokens.includes("--frozen-lockfile"))).toBe(true);
  });

  test("copies the manifests and lockfile, then installs, THEN copies the sources (layer cache)", () => {
    const { build } = stagesOf();
    const install = runCommands(build).find(
      ({ tokens }) => isBunInstall(tokens) && tokens.includes("--frozen-lockfile"),
    );
    expect(install).toBeDefined();
    const installAt = install?.at ?? -1;

    const copies = build.instructions
      .map((instruction, at) => ({ at, instruction }))
      .filter(({ instruction }) => instruction.keyword === "COPY" || instruction.keyword === "ADD")
      .map(({ at, instruction }) => ({ at, copy: parseCopy(instruction.args) }))
      .filter(({ copy }) => copy.from === undefined);
    const before = copies.filter(({ at }) => at < installAt).flatMap(({ copy }) => copy.sources);
    for (const needed of ["package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json"]) {
      expect(before.map((source) => posix.normalize(source))).toContain(needed);
    }
    // Nothing but manifests before the install, so a source edit does not bust the dependency layer.
    expect(before.filter((source) => !isManifest(source))).toEqual([]);

    const sourceCopy = copies.find(({ copy }) => copy.sources.some((source) => !isManifest(source)));
    expect(sourceCopy).toBeDefined();
    expect(sourceCopy?.at ?? -1).toBeGreaterThan(installAt);
  });

  test("runs `bun run typecheck` after the sources are copied", () => {
    const { build } = stagesOf();
    const typecheck = runCommands(build).find(({ command }) => /^bun (?:run )?typecheck$/.test(command));
    expect(typecheck).toBeDefined();
    expect(firstSourceCopyAt(build)).toBeGreaterThanOrEqual(0);
    expect(typecheck?.at ?? -1).toBeGreaterThan(firstSourceCopyAt(build));
  });

  test("runs the web build after the sources are copied", () => {
    const { build } = stagesOf();
    // `bun run build` is the root script, `bun --filter '*' build`: only the web app has a build script.
    const webBuild = runCommands(build).find(({ command }) =>
      /^bun (?:run )?--filter[= ]["']?@first-coach\/web["']? (?:run )?build$|^bun (?:run )?build$/.test(command),
    );
    expect(webBuild).toBeDefined();
    expect(firstSourceCopyAt(build)).toBeGreaterThanOrEqual(0);
    expect(webBuild?.at ?? -1).toBeGreaterThan(firstSourceCopyAt(build));
  });

  test("the WORKDIR is /app", () => {
    const { build } = stagesOf();
    expect(workdirAtEnd(build)).toBe(APP_DIR);
  });
});

describe("Dockerfile runtime stage", () => {
  test("puts the web build at /app/apps/web/dist, copied from the stage that builds it", () => {
    const { stages, build, runtime } = stagesOf();
    expect(
      copiesTo(stages, runtime, "apps/web/dist", "/app/apps/web/dist", (copy) =>
        copy.from !== undefined && stageByRef(stages, copy.from) === build,
      ),
    ).toBe(true);
  });

  test("puts the API sources at /app/apps/api/src (static.ts finds the web dist relative to them)", () => {
    const { stages, runtime } = stagesOf();
    expect(copiesTo(stages, runtime, "apps/api/src", "/app/apps/api/src")).toBe(true);
  });

  test("carries the config the app reads at run time", () => {
    const { stages, runtime } = stagesOf();
    expect(workdirAtEnd(runtime)).toBe(APP_DIR);
    for (const [source, dest] of [
      ["package.json", "/app/package.json"],
      ["bun.lock", "/app/bun.lock"],
      ["apps/api/package.json", "/app/apps/api/package.json"], // boot.ts reads its version
      ["apps/web/package.json", "/app/apps/web/package.json"], // the workspace the lockfile describes
      ["tsconfig.base.json", "/app/tsconfig.base.json"],
      ["apps/api/tsconfig.json", "/app/apps/api/tsconfig.json"],
    ] as const) {
      expect({ source, present: copiesTo(stages, runtime, source, dest) }).toEqual({ source, present: true });
    }
  });

  test("has production node_modules: a frozen `--production` install (here or in a stage it copies from)", () => {
    const { stages, runtime } = stagesOf();
    const isProdInstall = (tokens: string[]): boolean =>
      isBunInstall(tokens) &&
      tokens.includes("--frozen-lockfile") &&
      (tokens.includes("--production") || tokens.includes("-p"));
    const prodStages = stages.filter((stage) => runCommands(stage).some(({ tokens }) => isProdInstall(tokens)));
    const viaOwnInstall = prodStages.includes(runtime);
    const viaCopy = runtime.instructions.some(({ keyword, args }) => {
      if (keyword !== "COPY") return false;
      const copy = parseCopy(args);
      const source = copy.from === undefined ? undefined : stageByRef(stages, copy.from);
      return (
        source !== undefined &&
        prodStages.includes(source) &&
        copy.sources.some((path) => trimSlash(path).endsWith("node_modules"))
      );
    });
    expect(viaOwnInstall || viaCopy).toBe(true);
  });

  test("the production install runs after the manifests and lockfile are copied", () => {
    const { runtime } = stagesOf();
    const install = runCommands(runtime).find(({ tokens }) => isBunInstall(tokens) && tokens.includes("--production"));
    if (!install) return; // node_modules arrives via a prod-deps stage instead; the test above covers it
    const before = runtime.instructions
      .slice(0, install.at)
      .filter(({ keyword }) => keyword === "COPY")
      .flatMap(({ args }) => parseCopy(args).sources.map((source) => posix.normalize(source)));
    for (const needed of ["package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json"]) {
      expect(before).toContain(needed);
    }
  });

  test("never copies .env files, data, or the whole context into the image", () => {
    const { runtime } = stagesOf();
    const contextSources = runtime.instructions
      .filter(({ keyword }) => keyword === "COPY" || keyword === "ADD")
      .map(({ args }) => parseCopy(args))
      .filter((copy) => copy.from === undefined)
      .flatMap((copy) => copy.sources)
      .map((source) => posix.normalize(source));
    expect(contextSources.filter((source) => basename(source).startsWith(".env"))).toEqual([]);
    expect(contextSources.filter((source) => source === "." || source === "data" || source.startsWith("data/"))).toEqual([]);
  });
});

describe("Dockerfile runtime configuration", () => {
  test("ENV points every writable path at /data", () => {
    const env = envOf(stagesOf().runtime);
    expect(env.APP_DB_PATH).toBe("/data/app.db");
    expect(env.MEDIA_DIR).toBe("/data/media");
    expect(env.MASTRA_DB_PATH).toBe("/data/mastra.db");
    expect(env.BACKUP_DIR).toBe("/data/backups");
  });

  test("accepts BUILD_VERSION as a build arg (default dev) and exports it to the environment", () => {
    const { runtime } = stagesOf();
    const argAt = runtime.instructions.findIndex(
      ({ keyword, args }) => keyword === "ARG" && args.trim().startsWith("BUILD_VERSION"),
    );
    expect(argAt).toBeGreaterThanOrEqual(0);
    expect(runtime.instructions[argAt]?.args.trim()).toBe("BUILD_VERSION=dev");
    const exportedAt = runtime.instructions.findIndex(
      (instruction, at) =>
        at > argAt &&
        instruction.keyword === "ENV" &&
        ["$BUILD_VERSION", "${BUILD_VERSION}"].includes(envOf({ ...runtime, instructions: [instruction] }).BUILD_VERSION ?? ""),
    );
    expect(exportedAt).toBeGreaterThan(argAt);
  });

  test("EXPOSE 4111", () => {
    const ports = stagesOf()
      .runtime.instructions.filter(({ keyword }) => keyword === "EXPOSE")
      .flatMap(({ args }) => args.split(/\s+/));
    expect(ports.map((port) => port.replace(/\/tcp$/, ""))).toContain("4111");
  });

  test("HEALTHCHECK fetches /health with bun itself (no curl or wget in the image)", () => {
    const { runtime } = stagesOf();
    const health = runtime.instructions.filter(({ keyword }) => keyword === "HEALTHCHECK").at(-1);
    expect(health).toBeDefined();
    const parsed = /^(?:--\S+\s+)*CMD\s+(.+)$/s.exec(health?.args ?? "");
    expect(parsed).not.toBeNull();
    const command = parsed?.[1] ?? "";
    expect(command).toMatch(/^bun\s/);
    expect(command).toMatch(/\/health(?![\w/-])/); // the /health path itself, not /healthz or /health/x
    expect(command).toContain("fetch(");
    expect(command).toContain("process.exit(");
    expect(command).not.toMatch(/\b(curl|wget)\b/);
  });

  test('CMD is exactly ["bun","apps/api/src/index.ts"], run from /app', () => {
    const { runtime } = stagesOf();
    const cmd = runtime.instructions.filter(({ keyword }) => keyword === "CMD").at(-1);
    expect(cmd).toBeDefined();
    expect(JSON.parse(cmd?.args ?? "null")).toEqual(["bun", "apps/api/src/index.ts"]);
    expect(workdirAtEnd(runtime)).toBe(APP_DIR);
  });
});

// ---------------------------------------------------------------- .dockerignore

describe(".dockerignore", () => {
  test.each([
    "node_modules",
    "apps/api/node_modules",
    "apps/web/node_modules/vite/package.json",
    ".git",
    ".git/HEAD",
    ".beads",
    ".beads/config.yaml",
    "data",
    "data/app.db",
    ".env",
    ".env.local",
    ".env.production",
    "apps/web/e2e/fixtures",
    "apps/web/e2e/fixtures/clip.mp4",
    "apps/web/dist",
    "apps/web/dist/index.html",
    ".playwright-cli",
    "e2e-artifacts",
    "server.log",
    "apps/api/server.log",
  ])("excludes %s from the build context", (path) => {
    expect(isIgnored(dockerignore(), path)).toBe(true);
  });

  test.each([
    ".env.example",
    "package.json",
    "bun.lock",
    "tsconfig.base.json",
    "apps/api/package.json",
    "apps/api/tsconfig.json",
    "apps/api/src/index.ts",
    "apps/api/src/db/migrations/001_init.sql",
    "apps/web/package.json",
    "apps/web/tsconfig.json",
    "apps/web/index.html",
    "apps/web/vite.config.ts",
    "apps/web/src/main.tsx",
    "apps/web/public/icon.svg",
  ])("keeps %s in the build context", (path) => {
    expect(isIgnored(dockerignore(), path)).toBe(false);
  });

  test("the build never COPYs a path the .dockerignore removes", () => {
    const patterns = dockerignore();
    const sources = dockerfile()
      .stages.flatMap((stage) => stage.instructions)
      .filter(({ keyword }) => keyword === "COPY" || keyword === "ADD")
      .map(({ args }) => parseCopy(args))
      .filter((copy) => copy.from === undefined)
      .flatMap((copy) => copy.sources)
      .filter((source) => !/[*?[]/.test(source) && posix.normalize(source) !== ".");
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((source) => isIgnored(patterns, source))).toEqual([]);
  });
});
