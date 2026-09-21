// Static checks over .github/workflows/ci.yml. No GitHub runner: the workflow
// is parsed with Bun's built-in YAML parser and asserted on as data.
//
// Assertions name what must hold (triggers, Bun pin, the ordered command chain)
// and a short list of specific forbidden things (registry push, deploy, secrets,
// write permissions). They never pin the exact step list, so a later bead may add
// caching, labels or extra read-only steps.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const CI_PATH = join(repoRoot, ".github", "workflows", "ci.yml");

const BUN_VERSION = "1.4.2";
const INSTALL = "bun install --frozen-lockfile";
const ROOT_TESTS = "bun test ./test/";
const TYPECHECK = "bun run typecheck";
const TESTS = "bun run test";
const DOCKER_BUILD = "docker build -t first-coach:ci .";

// ---------------------------------------------------------------- workflow loader

type Json = Record<string, unknown>;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Json;
}

interface Job {
  id: string;
  steps: Step[];
  raw: Json;
}

function readCiText(): string {
  if (!existsSync(CI_PATH)) throw new Error(`missing workflow file: ${CI_PATH}`);
  return readFileSync(CI_PATH, "utf8");
}

function parseCi(): Json {
  const parsed: unknown = Bun.YAML.parse(readCiText());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ci.yml did not parse to a mapping");
  }
  return parsed as Json;
}

function jobsOf(workflow: Json): Job[] {
  const jobs = workflow.jobs;
  if (typeof jobs !== "object" || jobs === null) return [];
  return Object.entries(jobs as Record<string, Json>).map(([id, raw]) => ({
    id,
    raw,
    steps: Array.isArray(raw.steps) ? (raw.steps as Step[]) : [],
  }));
}

/** Each non-empty, trimmed line of a step's `run:` script (comments already stripped by YAML). */
function runLines(step: Step): string[] {
  if (typeof step.run !== "string") return [];
  return step.run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function allSteps(workflow: Json): Step[] {
  return jobsOf(workflow).flatMap((job) => job.steps);
}

/** Position of the first step whose `run:` contains exactly this line, or -1. */
function indexOfCommand(steps: Step[], command: string): number {
  return steps.findIndex((step) => runLines(step).includes(command));
}

function indexOfUses(steps: Step[], prefix: string): number {
  return steps.findIndex((step) => typeof step.uses === "string" && step.uses.startsWith(prefix));
}

/** The single job that carries the command chain (they must share one runner). */
function ciJob(workflow: Json): Job {
  const job = jobsOf(workflow).find((j) => indexOfCommand(j.steps, INSTALL) !== -1);
  if (!job) throw new Error(`no job runs \`${INSTALL}\``);
  return job;
}

/** Text of the workflow with YAML comment lines dropped, so prose cannot trip or satisfy a check. */
function uncommented(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

// ---------------------------------------------------------------- structure

describe("ci.yml: structure", () => {
  test("the workflow file exists and parses as YAML with name, on and jobs", () => {
    const workflow = parseCi();
    expect(typeof workflow.name).toBe("string");
    expect(workflow.on).toBeDefined();
    expect(jobsOf(workflow).length).toBeGreaterThan(0);
  });

  test("runs on push and on pull_request", () => {
    const on = parseCi().on;
    const triggers =
      typeof on === "string" ? [on] : Array.isArray(on) ? (on as string[]) : Object.keys(on as Json);
    expect(triggers).toContain("push");
    expect(triggers).toContain("pull_request");
  });

  test("checks the repository out before running anything", () => {
    const steps = ciJob(parseCi()).steps;
    const checkout = indexOfUses(steps, "actions/checkout@");
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(indexOfCommand(steps, INSTALL));
  });

  test(`sets up Bun ${BUN_VERSION} before the install`, () => {
    const steps = ciJob(parseCi()).steps;
    const setup = indexOfUses(steps, "oven-sh/setup-bun@");
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(String(steps[setup]?.with?.["bun-version"])).toBe(BUN_VERSION);
    expect(setup).toBeLessThan(indexOfCommand(steps, INSTALL));
  });
});

// ---------------------------------------------------------------- commands

describe("ci.yml: commands", () => {
  test.each([INSTALL, ROOT_TESTS, TYPECHECK, TESTS, DOCKER_BUILD])(
    "runs `%s` in one job",
    (command) => {
      expect(indexOfCommand(ciJob(parseCi()).steps, command)).toBeGreaterThanOrEqual(0);
    },
  );

  test("runs them in order: install, root tests, typecheck, tests, docker build", () => {
    const steps = ciJob(parseCi()).steps;
    const order = [INSTALL, ROOT_TESTS, TYPECHECK, TESTS, DOCKER_BUILD].map((c) =>
      indexOfCommand(steps, c),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length); // one command per step
  });

  test("the image build tags first-coach:ci and never pushes", () => {
    const build = allSteps(parseCi()).flatMap(runLines).filter((l) => l.startsWith("docker build"));
    expect(build).toEqual([DOCKER_BUILD]);
    expect(build.join(" ")).not.toContain("--push");
  });
});

// ---------------------------------------------------------------- forbidden

describe("ci.yml: no deploy, no registry push, no secrets", () => {
  test("no run line pushes an image or logs in to a registry", () => {
    const lines = allSteps(parseCi()).flatMap(runLines);
    expect(lines.filter((l) => /\bdocker\s+push\b/.test(l))).toEqual([]);
    expect(lines.filter((l) => /\bdocker\s+login\b/.test(l))).toEqual([]);
    expect(lines.filter((l) => /--push\b/.test(l))).toEqual([]);
  });

  test("no step uses docker/login-action", () => {
    const uses = allSteps(parseCi()).map((s) => s.uses ?? "");
    expect(uses.filter((u) => u.startsWith("docker/login-action"))).toEqual([]);
  });

  test("no docker/build-push-action step sets push: true", () => {
    const pushing = allSteps(parseCi()).filter(
      (s) =>
        typeof s.uses === "string" &&
        s.uses.startsWith("docker/build-push-action") &&
        String(s.with?.push).toLowerCase() === "true",
    );
    expect(pushing).toEqual([]);
  });

  test("no secrets are referenced", () => {
    expect(uncommented(readCiText())).not.toMatch(/\$\{\{\s*secrets\./);
  });

  test("no deploy step or job", () => {
    const workflow = parseCi();
    const jobIds = jobsOf(workflow).map((j) => j.id);
    const stepText = allSteps(workflow).map((s) => [s.name, s.uses, s.run].join("\n"));
    expect([...jobIds, ...stepText].filter((t) => /deploy/i.test(t))).toEqual([]);
  });

  test("permissions, where declared, never grant write", () => {
    const workflow = parseCi();
    const blocks = [workflow.permissions, ...jobsOf(workflow).map((j) => j.raw.permissions)].filter(
      (p) => p !== undefined,
    );
    for (const block of blocks) {
      const grants = typeof block === "string" ? [block] : Object.values((block ?? {}) as Json);
      for (const grant of grants) expect(String(grant)).not.toMatch(/write/);
    }
  });
});
