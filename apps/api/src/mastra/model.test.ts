// fc-mol-zo6.2: model ids + availability from env, and the lazy Mastra instance.
// No test here touches the network: nothing calls a model, and the Mastra store is a
// LibSQL file in a temp dir that afterEach removes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { DEFAULT_OPENAI_MODEL, aiAvailable, textModelId, visionModelId } from "./model";

describe("aiAvailable", () => {
  test("is false when there is no key", () => {
    expect(aiAvailable({})).toBe(false);
  });

  test("is false when the key is empty or whitespace only", () => {
    expect(aiAvailable({ OPENAI_API_KEY: "" })).toBe(false);
    expect(aiAvailable({ OPENAI_API_KEY: "   " })).toBe(false);
  });

  test("is true when a key is present", () => {
    expect(aiAvailable({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });

  test("ignores the model variables: a model name without a key is still unavailable", () => {
    expect(aiAvailable({ OPENAI_MODEL: "gpt-x", OPENAI_VISION_MODEL: "gpt-y" })).toBe(false);
  });

  test("reads process.env at call time when no env is passed", () => {
    const saved = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      expect(aiAvailable()).toBe(false);
      process.env.OPENAI_API_KEY = "sk-test";
      expect(aiAvailable()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("model ids", () => {
  test("the text id is openai/ + OPENAI_MODEL", () => {
    expect(textModelId({ OPENAI_MODEL: "gpt-x" })).toBe("openai/gpt-x");
  });

  test("the vision id is openai/ + OPENAI_VISION_MODEL", () => {
    expect(visionModelId({ OPENAI_MODEL: "gpt-x", OPENAI_VISION_MODEL: "gpt-y" })).toBe("openai/gpt-y");
  });

  test("the two ids come from their own variable, not from each other", () => {
    const env = { OPENAI_MODEL: "text-one", OPENAI_VISION_MODEL: "vision-two" };
    expect(textModelId(env)).toBe("openai/text-one");
    expect(visionModelId(env)).toBe("openai/vision-two");
  });

  test("the ids are built with no key present", () => {
    expect(textModelId({ OPENAI_MODEL: "gpt-x" })).toBe("openai/gpt-x");
  });

  test("an unset text model falls back to the documented default", () => {
    expect(textModelId({})).toBe(`openai/${DEFAULT_OPENAI_MODEL}`);
  });

  test("an unset vision model falls back to the text model name", () => {
    expect(visionModelId({ OPENAI_MODEL: "gpt-x" })).toBe("openai/gpt-x");
    expect(visionModelId({})).toBe(`openai/${DEFAULT_OPENAI_MODEL}`);
  });

  test("blank values count as unset and surrounding whitespace is trimmed", () => {
    expect(textModelId({ OPENAI_MODEL: "  " })).toBe(`openai/${DEFAULT_OPENAI_MODEL}`);
    expect(visionModelId({ OPENAI_MODEL: "gpt-x", OPENAI_VISION_MODEL: "" })).toBe("openai/gpt-x");
    expect(textModelId({ OPENAI_MODEL: " gpt-x " })).toBe("openai/gpt-x");
  });

  test("reads process.env at call time when no env is passed", () => {
    const saved = process.env.OPENAI_MODEL;
    try {
      process.env.OPENAI_MODEL = "from-process-env";
      expect(textModelId()).toBe("openai/from-process-env");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = saved;
    }
  });
});

describe("mastra/index (lazy instance)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mastra-model-test-"));
    dbPath = join(dir, "mastra.db");
  });

  afterEach(async () => {
    const { resetMastra } = await import("./index");
    resetMastra();
    rmSync(dir, { recursive: true, force: true });
  });

  test("importing index with no key does not throw and does not create the store", async () => {
    const saved = { key: process.env.OPENAI_API_KEY, path: process.env.MASTRA_DB_PATH };
    try {
      delete process.env.OPENAI_API_KEY;
      process.env.MASTRA_DB_PATH = dbPath;
      const mod = await import("./index");
      expect(typeof mod.getMastra).toBe("function");
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.key;
      if (saved.path === undefined) delete process.env.MASTRA_DB_PATH;
      else process.env.MASTRA_DB_PATH = saved.path;
    }
  });

  test("getMastra builds a Mastra instance with no key", async () => {
    const { getMastra } = await import("./index");
    const mastra = getMastra({ MASTRA_DB_PATH: dbPath });
    expect(mastra).toBeInstanceOf(Mastra);
    expect(mastra.getLogger()).toBeInstanceOf(PinoLogger);
  });

  test("getMastra is created once and then reused", async () => {
    const { getMastra } = await import("./index");
    const first = getMastra({ MASTRA_DB_PATH: dbPath });
    expect(getMastra({ MASTRA_DB_PATH: join(dir, "other.db") })).toBe(first);
  });

  test("resetMastra drops the cached instance", async () => {
    const { getMastra, resetMastra } = await import("./index");
    const first = getMastra({ MASTRA_DB_PATH: dbPath });
    resetMastra();
    expect(getMastra({ MASTRA_DB_PATH: dbPath })).not.toBe(first);
  });

  test("the LibSQL store is the file at MASTRA_DB_PATH", async () => {
    const { getMastra } = await import("./index");
    const storage = getMastra({ MASTRA_DB_PATH: dbPath }).getStorage();
    expect(storage).toBeDefined();
    await storage!.init();
    expect(existsSync(dbPath)).toBe(true);
  });

  test("the parent directory of MASTRA_DB_PATH is created when missing", async () => {
    const { getMastra } = await import("./index");
    const nested = join(dir, "nested", "deeper", "mastra.db");
    const storage = getMastra({ MASTRA_DB_PATH: nested }).getStorage();
    await storage!.init();
    expect(existsSync(nested)).toBe(true);
  });

  test("the logger writes one JSON object per line", async () => {
    const script = `
      const { getMastra } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
      getMastra({ MASTRA_DB_PATH: ${JSON.stringify(dbPath)} }).getLogger().info("json-probe-marker");
      await new Promise((r) => setTimeout(r, 200));
    `;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "OPENAI_API_KEY") env[k] = v;
    const proc = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const lines = (out + "\n" + err).split("\n").filter((l) => l.includes("json-probe-marker"));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(JSON.stringify(parsed)).toContain("json-probe-marker");
  });
});
