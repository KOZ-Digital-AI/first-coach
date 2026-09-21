import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENV_VARIABLES, EnvError, parseEnv } from "./env";

// Policy for .env.example (documented here, enforced below):
//  - every variable in the env.ts schema appears exactly once as `NAME=value`;
//  - variables required in production are uncommented and non-empty;
//  - optional variables may be commented out (`# NAME=value`) but must still appear;
//  - the line above every variable is a `#` comment saying what it is and
//    whether it is required in production (or optional);
//  - placeholders are obviously fake: no real-looking secret anywhere.

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const EXAMPLE_PATH = resolve(REPO_ROOT, ".env.example");

type Assignment = { name: string; value: string; commented: boolean; line: number };

// A missing file reads as empty so each test fails on its own assertion instead of the module failing to load.
const content = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";
const lines = content.split(/\r?\n/);

// Simple line parsing, no dotenv dependency.
const assignments: Assignment[] = lines.flatMap((text, line) => {
  const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(text);
  return match ? [{ name: match[2]!, value: match[3]!.trim(), commented: match[1] !== undefined, line }] : [];
});

const find = (name: string): Assignment[] => assignments.filter((entry) => entry.name === name);

/** The variables env.ts itself demands in production, read from the schema so this cannot drift. */
function requiredInProduction(): string[] {
  try {
    parseEnv({ NODE_ENV: "production" });
  } catch (error) {
    if (error instanceof EnvError) return error.variables;
    throw error;
  }
  return [];
}

const gitCheckIgnore = (path: string): number => {
  const result = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: REPO_ROOT });
  return result.exitCode;
};

describe(".env.example documents every variable", () => {
  test("the file exists", () => {
    expect(existsSync(EXAMPLE_PATH)).toBe(true);
  });

  test("the schema exports the variables this test covers", () => {
    expect(ENV_VARIABLES.length).toBeGreaterThan(0);
    expect(requiredInProduction()).toEqual(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]);
  });

  test.each([...ENV_VARIABLES])("%s appears exactly once as an assignment line", (name) => {
    expect(find(name).length).toBe(1);
  });

  test("variables required in production are uncommented with a non-empty placeholder", () => {
    for (const name of requiredInProduction()) {
      const [entry] = find(name);
      expect(entry, `${name} is missing`).toBeDefined();
      expect(entry!.commented, `${name} must not be commented out`).toBe(false);
      expect(entry!.value, `${name} needs a placeholder value`).not.toBe("");
    }
  });

  test.each([...ENV_VARIABLES])("%s has a one-line comment above saying what it is and whether it is required", (name) => {
    const [entry] = find(name);
    expect(entry, `${name} is missing`).toBeDefined();
    const above = lines[entry!.line - 1] ?? "";
    expect(above).toMatch(/^#\s+\S/);
    expect(above).not.toMatch(/^#\s*[A-Z][A-Z0-9_]*=/);
    expect(above).toMatch(/required in production|optional/i);
  });
});

describe(".env.example placeholders are safe", () => {
  test("BETTER_AUTH_SECRET placeholder is clearly a change-me value", () => {
    const [entry] = find("BETTER_AUTH_SECRET");
    expect(entry, "BETTER_AUTH_SECRET is missing").toBeDefined();
    expect(entry!.value).toContain("change-me");
  });

  test("OPENAI_API_KEY has no value", () => {
    const [entry] = find("OPENAI_API_KEY");
    expect(entry, "OPENAI_API_KEY is missing").toBeDefined();
    expect(entry!.value).toBe("");
  });

  test("no sk- style key appears anywhere in the file", () => {
    expect(content).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });

  test("no value is a long hex or base64 run", () => {
    for (const { name, value } of assignments) {
      expect(value, `${name} looks like a real secret (hex)`).not.toMatch(/[0-9a-fA-F]{40,}/);
      expect(value, `${name} looks like a real secret (base64)`).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });
});

describe("git ignore rules for env files", () => {
  test(".env stays ignored", () => {
    expect(gitCheckIgnore(".env")).toBe(0);
  });

  test(".env.local stays ignored", () => {
    expect(gitCheckIgnore(".env.local")).toBe(0);
  });

  test(".env.example is not ignored", () => {
    expect(gitCheckIgnore(".env.example")).toBe(1);
  });
});
