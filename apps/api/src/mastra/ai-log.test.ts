import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../db/database";
import { migrate } from "../db/migrate";
import { AI_FALLBACK_CODES } from "../shared/ai";
import { logAiCall } from "./ai-log";
import type { AiCallEntry } from "./ai-log";

// The writer of the ai_calls table (008_ai_calls.sql), tested against the REAL migrations on an in-memory
// database: the table's CHECKs are the last line of defence, but the writer is the SOLE guard for free text
// (a CHECK cannot tell a drill id from a person's words spelt as short id-shaped elements), so most tests here
// feed it things that must never reach the table and read the row back.

const PLAYER = "player-1";
const HASH = "a".repeat(32) + "0123456789abcdef".repeat(2);
const NOTE = "my-ankle-is-tired-today";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  insertProfile(PLAYER);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // a test may have closed it already
  }
});

function insertProfile(playerId: string): void {
  db.run(
    "INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale) VALUES (?, 12, 'basic', 'dribbling', 'ball', 'yard', 0, 3, 20, 'ru')",
    [playerId],
  );
}

function entry(overrides: Partial<AiCallEntry> = {}): AiCallEntry {
  return {
    playerId: PLAYER,
    kind: "plan",
    model: "openai/gpt-4o-mini",
    profileHash: HASH,
    candidateIds: ["drill-a", "drill-b", "drill-c"],
    chosenIds: ["drill-a", "drill-c"],
    validatorResult: "ok",
    fallbackCode: null,
    latencyMs: 1234,
    tokensIn: 900,
    tokensOut: 120,
    ...overrides,
  };
}

interface Row {
  id: number;
  player_id: string | null;
  kind: string;
  model: string;
  profile_hash: string | null;
  candidate_ids: string;
  chosen_ids: string;
  validator_result: string | null;
  fallback_code: string | null;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

function rows(): Row[] {
  return db.query("SELECT * FROM ai_calls ORDER BY id").all() as Row[];
}

function only(): Row {
  const all = rows();
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** A logger that collects the lines it is given. */
function collector(): { lines: object[]; log: (line: object) => void } {
  const lines: object[] = [];
  return { lines, log: (line) => lines.push(line) };
}

/** A database whose every use throws, whatever method the writer picks. */
function explodingDb(message: string): Database {
  return new Proxy({} as Database, {
    get() {
      throw new Error(message);
    },
  });
}

describe("logAiCall: the row", () => {
  test("writes one row with the profile hash, ids, validator result, latency and token usage, and returns true", () => {
    expect(logAiCall(db, entry())).toBe(true);
    const row = only();
    expect(row.player_id).toBe(PLAYER);
    expect(row.kind).toBe("plan");
    expect(row.model).toBe("openai/gpt-4o-mini");
    expect(row.profile_hash).toBe(HASH);
    expect(row.candidate_ids).toBe('["drill-a","drill-b","drill-c"]');
    expect(row.chosen_ids).toBe('["drill-a","drill-c"]');
    expect(row.validator_result).toBe("ok");
    expect(row.fallback_code).toBeNull();
    expect(row.latency_ms).toBe(1234);
    expect(row.tokens_in).toBe(900);
    expect(row.tokens_out).toBe(120);
    expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test("one call, one row: every call appends, nothing is replaced", () => {
    expect(logAiCall(db, entry())).toBe(true);
    expect(logAiCall(db, entry())).toBe(true);
    expect(logAiCall(db, entry({ kind: "explain", candidateIds: ["v1"], chosenIds: ["v1"] }))).toBe(true);
    expect(rows().map((r) => r.kind)).toEqual(["plan", "plan", "explain"]);
  });

  test.each(["plan", "explain", "video"] as const)("kind %s is accepted", (kind) => {
    expect(logAiCall(db, entry({ kind }))).toBe(true);
    expect(only().kind).toBe(kind);
  });

  test.each([...AI_FALLBACK_CODES])("fallback code %s is stored and the chosen ids are then empty", (code) => {
    expect(
      logAiCall(db, entry({ fallbackCode: code, validatorResult: null, tokensIn: null, tokensOut: null })),
    ).toBe(true);
    const row = only();
    expect(row.fallback_code).toBe(code);
    expect(row.chosen_ids).toBe("[]");
    expect(row.candidate_ids).toBe('["drill-a","drill-b","drill-c"]');
    expect(row.validator_result).toBeNull();
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
  });

  test("a call that belongs to no player is logged with a NULL player_id and no profile hash", () => {
    expect(logAiCall(db, entry({ playerId: null }))).toBe(true);
    const row = only();
    expect(row.player_id).toBeNull();
    expect(row.profile_hash).toBeNull();
  });

  test("the row goes away with the player (the table's cascade is reachable through the writer)", () => {
    logAiCall(db, entry());
    logAiCall(db, entry({ playerId: null }));
    db.run("DELETE FROM player_profiles WHERE player_id = ?", [PLAYER]);
    expect(rows().map((r) => r.player_id)).toEqual([null]);
  });
});

describe("logAiCall: nothing free-form reaches the table", () => {
  test("a profile hash that is not a sha-256 hex digest is not stored (a profile must never land here)", () => {
    expect(logAiCall(db, entry({ profileHash: JSON.stringify({ age: 12, goal: "dribbling" }) }))).toBe(true);
    expect(only().profile_hash).toBeNull();
  });

  test("an upper-case digest is stored in lower case", () => {
    logAiCall(db, entry({ profileHash: HASH.toUpperCase() }));
    expect(only().profile_hash).toBe(HASH);
  });

  test("ids that are not id-shaped are dropped, so a sentence cannot ride in the id lists", () => {
    const sentence = "my ankle hurts, please skip {running}";
    expect(logAiCall(db, entry({ candidateIds: ["drill-a", sentence, "drill-b"], chosenIds: ["drill-a", sentence] }))).toBe(
      true,
    );
    const row = only();
    expect(row.candidate_ids).toBe('["drill-a","drill-b"]');
    expect(row.chosen_ids).toBe('["drill-a"]');
    expect(row.candidate_ids + row.chosen_ids).not.toContain("ankle");
  });

  test("an id longer than 128 characters is dropped", () => {
    const long = "a".repeat(129);
    const ok = "b".repeat(128);
    logAiCall(db, entry({ candidateIds: [long, ok], chosenIds: [long, ok] }));
    const row = only();
    expect(JSON.parse(row.candidate_ids)).toEqual([ok]);
    expect(JSON.parse(row.chosen_ids)).toEqual([ok]);
  });

  test("chosen ids the server never offered are dropped (chosen is a subset of candidate)", () => {
    logAiCall(db, entry({ candidateIds: ["drill-a", "drill-b"], chosenIds: ["drill-a", NOTE, "drill-z"] }));
    const row = only();
    expect(JSON.parse(row.chosen_ids)).toEqual(["drill-a"]);
    expect(row.chosen_ids).not.toContain(NOTE);
  });

  test("a validator result that is a sentence rather than a short code is not stored", () => {
    expect(logAiCall(db, entry({ validatorResult: "the player said my ankle is tired" }))).toBe(true);
    const row = only();
    expect(row.validator_result).toBe("invalid_format");
    expect(JSON.stringify(row)).not.toContain("ankle");
  });

  test("a short validator code with the usual punctuation is kept as it is", () => {
    logAiCall(db, entry({ validatorResult: "invalid_output:unknown_id,duplicate" }));
    expect(only().validator_result).toBe("invalid_output:unknown_id,duplicate");
  });

  test("a blank validator result means no validator ran (NULL)", () => {
    logAiCall(db, entry({ validatorResult: "   " }));
    expect(only().validator_result).toBeNull();
  });

  test("a model that is not id-shaped is replaced, not stored", () => {
    expect(logAiCall(db, entry({ model: `gpt ${NOTE} please` }))).toBe(true);
    const row = only();
    expect(row.model).toBe("unknown");
    expect(JSON.stringify(row)).not.toContain(NOTE);
  });

  test("a blank model is stored as unknown, and the row is still written", () => {
    expect(logAiCall(db, entry({ model: "  " }))).toBe(true);
    expect(only().model).toBe("unknown");
  });

  test("no column of the row holds the text of a note passed in any field", () => {
    logAiCall(
      db,
      entry({
        model: "my ankle is tired",
        profileHash: "my ankle is tired",
        candidateIds: ["my ankle is tired", "drill-a"],
        chosenIds: ["my ankle is tired"],
        validatorResult: "my ankle is tired and more words",
      }),
    );
    expect(JSON.stringify(rows())).not.toContain("ankle");
  });
});

describe("logAiCall: clamping, so a long or odd value still gets logged", () => {
  test("a model id longer than 200 characters is cut to 200", () => {
    expect(logAiCall(db, entry({ model: "m".repeat(500) }))).toBe(true);
    expect(only().model).toBe("m".repeat(200));
  });

  test("a validator code longer than 200 characters is cut to 200", () => {
    expect(logAiCall(db, entry({ validatorResult: "v".repeat(500) }))).toBe(true);
    expect(only().validator_result).toBe("v".repeat(200));
  });

  test("id lists over 8192 characters are cut to fit and the row is still written", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `drill-version-${String(i).padStart(4, "0")}-xxxxxxxxxxxx`);
    expect(JSON.stringify(ids).length).toBeGreaterThan(8192);
    expect(logAiCall(db, entry({ candidateIds: ids, chosenIds: ids }))).toBe(true);
    const row = only();
    for (const text of [row.candidate_ids, row.chosen_ids]) {
      expect(text.length).toBeLessThanOrEqual(8192);
      const stored = JSON.parse(text) as string[];
      expect(stored.length).toBeGreaterThan(100);
      expect(stored).toEqual(ids.slice(0, stored.length));
    }
  });

  test("an id list of exactly 8192 characters is kept whole; one more id is what gets cut", () => {
    // n ids: 2 + n * 2 (quotes) + (n - 1) (commas) + the id characters = 8192; n = 100 gives 7891 id characters.
    const ids = Array.from({ length: 99 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(77)}`);
    ids.push("y".repeat(70));
    expect(JSON.stringify(ids)).toHaveLength(8192);
    expect(logAiCall(db, entry({ candidateIds: ids, chosenIds: ids }))).toBe(true);
    expect(rows()[0]!.candidate_ids).toBe(JSON.stringify(ids));
    expect(rows()[0]!.chosen_ids).toBe(JSON.stringify(ids));
    expect(logAiCall(db, entry({ candidateIds: [...ids, "z"], chosenIds: [...ids, "z"] }))).toBe(true);
    expect(rows()[1]!.candidate_ids).toBe(JSON.stringify(ids));
    // one character over the cap: the last id no longer fits, and the row is still written
    const over = [...ids.slice(0, 99), "y".repeat(71)];
    expect(JSON.stringify(over)).toHaveLength(8193);
    expect(logAiCall(db, entry({ candidateIds: over, chosenIds: over }))).toBe(true);
    expect(rows()[2]!.candidate_ids).toBe(JSON.stringify(ids.slice(0, 99)));
  });

  test("latency is stored as a whole number of milliseconds, never negative", () => {
    logAiCall(db, entry({ latencyMs: 12.6 }));
    logAiCall(db, entry({ latencyMs: -5 }));
    logAiCall(db, entry({ latencyMs: Number.NaN }));
    logAiCall(db, entry({ latencyMs: 0 }));
    expect(rows().map((r) => r.latency_ms)).toEqual([13, 0, 0, 0]);
  });

  test("token counts are whole numbers; a count the provider did not report, or an impossible one, is NULL", () => {
    logAiCall(db, entry({ tokensIn: 10.4, tokensOut: 20.6 }));
    logAiCall(db, entry({ tokensIn: null, tokensOut: null }));
    logAiCall(db, entry({ tokensIn: -1, tokensOut: Number.NaN }));
    logAiCall(db, entry({ tokensIn: 0, tokensOut: 0 }));
    expect(rows().map((r) => [r.tokens_in, r.tokens_out])).toEqual([
      [10, 21],
      [null, null],
      [null, null],
      [0, 0],
    ]);
  });
});

describe("logAiCall: a failed log write never fails the AI call", () => {
  test("a throwing DB does not propagate: false is returned and nothing throws", () => {
    const { log } = collector();
    let result: boolean | undefined;
    expect(() => {
      result = logAiCall(explodingDb("disk on fire"), entry(), log);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  test("a closed database does not propagate either", () => {
    db.close();
    const { lines, log } = collector();
    expect(logAiCall(db, entry(), log)).toBe(false);
    expect(lines).toHaveLength(1);
  });

  test("the failure is logged as one error line that carries no content of the entry or of the error message", () => {
    const { lines, log } = collector();
    const secret = "SECRET-DISK-DETAIL";
    const result = logAiCall(
      explodingDb(secret),
      entry({ playerId: "player-secret-id", model: "model-secret", candidateIds: ["cand-secret"], validatorResult: "val-secret" }),
      log,
    );
    expect(result).toBe(false);
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect((lines[0] as { level?: string }).level).toBe("error");
    expect(text).toContain("ai_calls");
    for (const forbidden of [secret, "player-secret-id", "model-secret", "cand-secret", "val-secret", HASH]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("a logger that throws does not propagate", () => {
    const log = () => {
      throw new Error("logger down");
    };
    expect(() => logAiCall(explodingDb("x"), entry(), log)).not.toThrow();
    expect(logAiCall(explodingDb("x"), entry(), log)).toBe(false);
  });

  test("an entry whose fields throw when read does not propagate", () => {
    const hostile = new Proxy({} as AiCallEntry, {
      get() {
        throw new Error("hostile getter");
      },
    });
    const { log } = collector();
    expect(logAiCall(db, hostile, log)).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  test("a player with no profile (the foreign key refuses) logs the failure and writes no row", () => {
    const { lines, log } = collector();
    expect(logAiCall(db, entry({ playerId: "nobody" }), log)).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain("nobody");
  });

  test("without a logger the failure goes to console.error, without content", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(logAiCall(explodingDb("SECRET-DISK-DETAIL"), entry({ model: "model-secret" }))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      const text = String(spy.mock.calls[0]?.[0]);
      expect(text).toContain("ai_calls");
      expect(text).not.toContain("SECRET-DISK-DETAIL");
      expect(text).not.toContain("model-secret");
    } finally {
      spy.mockRestore();
    }
  });

  test("a kind outside plan, explain, video is refused, not stored", () => {
    const { lines, log } = collector();
    expect(logAiCall(db, entry({ kind: "chat" as unknown as AiCallEntry["kind"] }), log)).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { refused?: string }).refused).toBe("kind");
  });

  test("a fallback code outside AI_FALLBACK_CODES is refused, not stored as 'served by the AI'", () => {
    const { lines, log } = collector();
    expect(logAiCall(db, entry({ fallbackCode: "gremlins" as unknown as AiCallEntry["fallbackCode"] }), log)).toBe(false);
    expect(rows()).toHaveLength(0);
    expect((lines[0] as { refused?: string }).refused).toBe("fallback_code");
  });

  test("a successful write logs nothing", () => {
    const { lines, log } = collector();
    expect(logAiCall(db, entry(), log)).toBe(true);
    expect(lines).toHaveLength(0);
  });
});
