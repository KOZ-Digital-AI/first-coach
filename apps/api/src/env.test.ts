import { describe, expect, test } from "bun:test";
import { ENV_VARIABLES, EnvError, parseEnv } from "./env";

const SECRET_32 = "s".repeat(32);
const PROD = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: SECRET_32,
  BETTER_AUTH_URL: "https://coach.example.com",
};

/** Runs parseEnv and returns the thrown EnvError (fails the test if nothing throws). */
function failure(source: Record<string, string | undefined>): EnvError {
  try {
    parseEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return error as EnvError;
  }
  throw new Error("expected parseEnv to throw");
}

describe("ENV_VARIABLES", () => {
  test.each([
    "PORT",
    "APP_DB_PATH",
    "MEDIA_DIR",
    "MASTRA_DB_PATH",
    "BACKUP_DIR",
    "WEB_DIST",
    "BUILD_VERSION",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_VISION_MODEL",
    "VITE_CONTACT_EMAIL",
  ])("lists %s", (name) => {
    expect(ENV_VARIABLES).toContain(name);
  });

  test("NODE_ENV only selects strictness and is not a schema variable", () => {
    expect(ENV_VARIABLES).not.toContain("NODE_ENV");
  });

  test("is exactly the set of keys of a fully populated parse", () => {
    const full = Object.fromEntries(ENV_VARIABLES.map((name) => [name, name === "PORT" ? "4000" : SECRET_32]));
    const env = parseEnv({ ...full, NODE_ENV: "production" });
    expect(Object.keys(env).sort()).toEqual([...ENV_VARIABLES].sort());
  });
});

describe("production strictness", () => {
  test("a valid production environment parses", () => {
    const env = parseEnv(PROD);
    expect(env.BETTER_AUTH_SECRET).toBe(SECRET_32);
    expect(env.BETTER_AUTH_URL).toBe("https://coach.example.com");
  });

  test("production without BETTER_AUTH_SECRET fails naming the variable", () => {
    const error = failure({ ...PROD, BETTER_AUTH_SECRET: undefined });
    expect(error.message).toContain("BETTER_AUTH_SECRET");
    expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
  });

  test("production with an empty BETTER_AUTH_SECRET counts as missing", () => {
    const error = failure({ ...PROD, BETTER_AUTH_SECRET: "" });
    expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
  });

  test("production without BETTER_AUTH_URL fails naming the variable", () => {
    const error = failure({ ...PROD, BETTER_AUTH_URL: undefined });
    expect(error.message).toContain("BETTER_AUTH_URL");
    expect(error.variables).toEqual(["BETTER_AUTH_URL"]);
  });

  test("a secret of 31 characters fails in production, 32 passes", () => {
    const error = failure({ ...PROD, BETTER_AUTH_SECRET: "s".repeat(31) });
    expect(error.message).toContain("BETTER_AUTH_SECRET");
    expect(error.message).toContain("32");
    expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
    expect(parseEnv({ ...PROD, BETTER_AUTH_SECRET: "s".repeat(32) }).BETTER_AUTH_SECRET).toHaveLength(32);
  });

  test("every offending variable is named in one error", () => {
    const error = failure({ NODE_ENV: "production", PORT: "nope" });
    expect([...error.variables].sort()).toEqual(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "PORT"]);
    for (const name of error.variables) expect(error.message).toContain(name);
  });

  test("outside production the secret and URL are optional and short secrets pass", () => {
    expect(parseEnv({}).BETTER_AUTH_SECRET).toBeUndefined();
    expect(parseEnv({ NODE_ENV: "development" }).BETTER_AUTH_URL).toBeUndefined();
    expect(parseEnv({ NODE_ENV: "test", BETTER_AUTH_SECRET: "short" }).BETTER_AUTH_SECRET).toBe("short");
  });
});

describe("secrets never leak into errors", () => {
  const MARKER = "MARKER-secret-do-not-print";
  const expectAbsent = (error: EnvError, marker: string) => {
    expect(error.message).not.toContain(marker);
    expect(error.variables.join(" ")).not.toContain(marker);
    expect(String(error)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(String(error.stack ?? "")).not.toContain(marker);
  };

  test("a too-short production secret is not echoed", () => {
    const error = failure({ ...PROD, BETTER_AUTH_SECRET: MARKER });
    expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
    expectAbsent(error, MARKER);
  });

  test("other values in a failing environment are not echoed either", () => {
    const apiKey = "sk-MARKER-openai-key";
    const badPort = "MARKER-port-value";
    const error = failure({ ...PROD, BETTER_AUTH_SECRET: MARKER, OPENAI_API_KEY: apiKey, PORT: badPort });
    expect([...error.variables].sort()).toEqual(["BETTER_AUTH_SECRET", "PORT"]);
    expectAbsent(error, MARKER);
    expectAbsent(error, apiKey);
    expectAbsent(error, badPort);
  });
});

describe("OpenAI is optional", () => {
  test("a missing OPENAI_API_KEY parses, in production too", () => {
    expect(parseEnv({}).OPENAI_API_KEY).toBeUndefined();
    expect(parseEnv(PROD).OPENAI_API_KEY).toBeUndefined();
  });

  test("a present key and models pass through", () => {
    const env = parseEnv({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m", OPENAI_VISION_MODEL: "v" });
    expect(env.OPENAI_API_KEY).toBe("k");
    expect(env.OPENAI_MODEL).toBe("m");
    expect(env.OPENAI_VISION_MODEL).toBe("v");
  });
});

describe("PORT", () => {
  test("defaults to 4111", () => {
    expect(parseEnv({}).PORT).toBe(4111);
  });

  test("a numeric string is coerced to a number", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  test.each(["abc", "0", "65536", "-1", "12.5", "1e3", "80 80"])("%p fails naming PORT", (raw) => {
    const error = failure({ PORT: raw });
    expect(error.variables).toEqual(["PORT"]);
    expect(error.message).toContain("PORT");
    expect(error.message).not.toContain(raw);
  });
});

describe("defaults and unset handling", () => {
  test("keeps the defaults the code uses today", () => {
    const env = parseEnv({});
    expect(env.APP_DB_PATH).toBe("./data/app.db");
    expect(env.WEB_DIST).toBe("apps/web/dist");
  });

  test("variables without a default stay undefined", () => {
    const env = parseEnv({});
    for (const name of [
      "MEDIA_DIR",
      "MASTRA_DB_PATH",
      "BACKUP_DIR",
      "BUILD_VERSION",
      "OPENAI_MODEL",
      "OPENAI_VISION_MODEL",
      "VITE_CONTACT_EMAIL",
    ] as const) {
      expect(env[name]).toBeUndefined();
    }
  });

  test("set string values pass through unchanged", () => {
    const env = parseEnv({
      APP_DB_PATH: "/data/x.db",
      MEDIA_DIR: "/data/media",
      MASTRA_DB_PATH: "/data/mastra.db",
      BACKUP_DIR: "/data/backups",
      WEB_DIST: "/srv/web",
      BUILD_VERSION: "1.2.3",
      VITE_CONTACT_EMAIL: "hi@example.com",
    });
    expect(env.APP_DB_PATH).toBe("/data/x.db");
    expect(env.MEDIA_DIR).toBe("/data/media");
    expect(env.MASTRA_DB_PATH).toBe("/data/mastra.db");
    expect(env.BACKUP_DIR).toBe("/data/backups");
    expect(env.WEB_DIST).toBe("/srv/web");
    expect(env.BUILD_VERSION).toBe("1.2.3");
    expect(env.VITE_CONTACT_EMAIL).toBe("hi@example.com");
  });

  test("empty strings are treated as unset", () => {
    const env = parseEnv({
      PORT: "",
      APP_DB_PATH: "",
      WEB_DIST: "",
      OPENAI_API_KEY: "",
      BUILD_VERSION: "",
      MEDIA_DIR: "",
    });
    expect(env.PORT).toBe(4111);
    expect(env.APP_DB_PATH).toBe("./data/app.db");
    expect(env.WEB_DIST).toBe("apps/web/dist");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BUILD_VERSION).toBeUndefined();
    expect(env.MEDIA_DIR).toBeUndefined();
  });

  test("parseEnv({}) does not consult process.env", () => {
    const before = process.env.PORT;
    process.env.PORT = "9999";
    try {
      expect(parseEnv({}).PORT).toBe(4111);
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });

  test("with no argument parseEnv reads process.env at call time", () => {
    const before = process.env.PORT;
    process.env.PORT = "9999";
    try {
      expect(parseEnv().PORT).toBe(9999);
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });
});
