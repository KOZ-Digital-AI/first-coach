// fc-mol-zo6.3: the AI plan validator and the deterministic fallback wrapper.
// Nothing here touches the network or OpenAI: the "provider" is an injected function.
import { describe, expect, test } from "bun:test";
import { AI_PLAN_TIMEOUT_MS } from "../shared/ai";
import { planWithFallback, validatePlan } from "./validator";

// The server-computed candidate set and a 20 minute budget: the window is 18..23 (budget-2..budget+3).
const CANDIDATES = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
const BUDGET = 20;
const PROFILE = { minutesPerSession: 20 } as const;

const item = (id: string, minutes: number, reason = "Good for your ball control today.") => ({
  drillVersionId: id,
  minutes,
  reason,
});
/** A plan that satisfies every rule: 3 items, 6 + 6 + 8 = 20 minutes. */
const validPlan = () => ({ items: [item("c1", 6), item("c2", 6), item("c3", 8)] });
const check = (plan: unknown, budget = BUDGET) => validatePlan(plan, CANDIDATES, budget, PROFILE);
const rulesOf = (plan: unknown, budget = BUDGET): string[] => {
  const result = check(plan, budget);
  return result.ok ? [] : result.issues.map((issue) => issue.rule);
};

describe("validatePlan: a valid plan", () => {
  test("passes and returns the plan", () => {
    const result = check(validPlan());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan).toEqual(validPlan());
  });

  test("accepts the candidate ids from any iterable (a Set)", () => {
    expect(validatePlan(validPlan(), new Set(CANDIDATES), BUDGET, PROFILE).ok).toBe(true);
  });

  test("a failed validation reports invalid_output", () => {
    const result = check({ items: [item("nope", 10), item("c1", 10)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_output");
  });
});

describe("validatePlan: candidate set", () => {
  test("an id outside the candidate set is rejected", () => {
    expect(rulesOf({ items: [item("c1", 10), item("not-approved", 10)] })).toEqual(["unknown_id"]);
  });

  test("the issue names the offending id", () => {
    const result = check({ items: [item("c1", 10), item("not-approved", 10)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.detail).toContain("not-approved");
  });

  test("a near-miss id is not in the set (no fuzzy matching)", () => {
    expect(rulesOf({ items: [item("c1", 10), item("C2", 10)] })).toEqual(["unknown_id"]);
  });
});

describe("validatePlan: duplicates", () => {
  test("the same drill twice is rejected", () => {
    expect(rulesOf({ items: [item("c1", 10), item("c2", 5), item("c1", 5)] })).toEqual(["duplicate"]);
  });
});

describe("validatePlan: item count 2..8", () => {
  test("one item is rejected", () => {
    expect(rulesOf({ items: [item("c1", 15)] }, 15)).toEqual(["item_count"]);
  });

  test("two items are accepted", () => {
    expect(check({ items: [item("c1", 10), item("c2", 10)] }).ok).toBe(true);
  });

  test("eight items are accepted", () => {
    const ids = CANDIDATES.slice(0, 8);
    const minutes = [2, 2, 2, 2, 2, 2, 3, 3]; // 18 = budget - 2
    expect(check({ items: ids.map((id, i) => item(id, minutes[i]!)) }).ok).toBe(true);
  });

  test("nine items are rejected", () => {
    const ids = CANDIDATES.slice(0, 9);
    expect(rulesOf({ items: ids.map((id) => item(id, 2)) })).toEqual(["item_count"]); // 18 minutes: in the window
  });

  test("an empty plan is rejected", () => {
    expect(check({ items: [] }).ok).toBe(false);
  });
});

describe("validatePlan: minutes per item 2..15", () => {
  test("a 1 minute item is rejected", () => {
    expect(rulesOf({ items: [item("c1", 1), item("c2", 15), item("c3", 2)] })).toEqual(["item_minutes"]);
  });

  test("a 16 minute item is rejected", () => {
    expect(rulesOf({ items: [item("c1", 16), item("c2", 2)] })).toEqual(["item_minutes"]);
  });

  test("2 and 15 minute items are accepted", () => {
    expect(check({ items: [item("c1", 15), item("c2", 2), item("c3", 2)] }).ok).toBe(true);
  });

  test("fractional minutes are rejected", () => {
    expect(check({ items: [item("c1", 10.5), item("c2", 10)] }).ok).toBe(false);
  });
});

describe("validatePlan: total within budget-2 .. budget+3", () => {
  const two = (a: number, b: number) => ({ items: [item("c1", a), item("c2", b)] });

  test("budget-2 is accepted", () => {
    expect(check(two(9, 9)).ok).toBe(true);
  });

  test("budget+3 is accepted", () => {
    expect(check(two(12, 11)).ok).toBe(true);
  });

  test("budget-3 is rejected as under budget", () => {
    expect(rulesOf(two(9, 8))).toEqual(["total_minutes"]);
  });

  test("budget+4 is rejected as over budget", () => {
    expect(rulesOf(two(12, 12))).toEqual(["total_minutes"]);
  });

  test("the window follows the budget argument", () => {
    expect(check(two(9, 9), 10).ok).toBe(false);
    expect(check(two(4, 4), 10).ok).toBe(true); // 8 = 10 - 2
    expect(check(two(15, 15), 45).ok).toBe(false); // 30 < 43
  });
});

describe("validatePlan: reasons", () => {
  const withReason = (reason: string) => ({ items: [item("c1", 10, reason), item("c2", 10)] });

  test("160 characters are accepted", () => {
    expect(check(withReason("a".repeat(160))).ok).toBe(true);
  });

  test("161 characters are rejected", () => {
    expect(rulesOf(withReason("a".repeat(161)))).toEqual(["reason_length"]);
  });

  test("length counts characters, not UTF-16 units (a Kazakh reason of 160 letters, emoji included)", () => {
    expect(check(withReason("Қ".repeat(159) + "⚽")).ok).toBe(true);
    expect(check(withReason("Қ".repeat(159) + "🥅")).ok).toBe(true); // one code point, two UTF-16 units
  });

  test("a whitespace-only reason is rejected", () => {
    expect(rulesOf(withReason("   "))).toEqual(["reason_blank"]);
  });

  for (const reason of [
    "See https://example.com/drill for more",
    "Watch http://evil.test",
    "ftp://files.example.org/x",
    "Try www.example.com today",
    "Try www.football-drills for more",
    "Details at example.com/train",
    "Read this on youtube.com",
    "Смотри видео на example.kz/video",
  ]) {
    test(`a reason with a URL is rejected: ${reason}`, () => {
      expect(rulesOf(withReason(reason))).toEqual(["reason_url"]);
    });
  }

  for (const reason of [
    "Warm up first. Then dribble slowly.",
    "Level 2.5 control, good pace.",
    "Сегодня лёгкая работа для левой ноги. Ты устал.",
  ]) {
    test(`a reason with sentence dots and no URL is accepted: ${reason}`, () => {
      expect(check(withReason(reason)).ok).toBe(true);
    });
  }
});

describe("validatePlan: malformed output fails closed", () => {
  for (const [name, plan] of [
    ["null", null],
    ["a string", "c1,c2"],
    ["an array", [item("c1", 10)]],
    ["missing items", {}],
    ["items not an array", { items: "c1" }],
    ["an item without a reason", { items: [{ drillVersionId: "c1", minutes: 10 }, item("c2", 10)] }],
    ["a string minutes value", { items: [{ drillVersionId: "c1", minutes: "10", reason: "x" }, item("c2", 10)] }],
    ["an unknown key", { items: [item("c1", 10), item("c2", 10)], extra: true }],
    ["an empty reason", { items: [item("c1", 10, ""), item("c2", 10)] }],
  ] as const) {
    test(`${name}`, () => {
      const result = check(plan);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_output");
        expect(result.issues.map((i) => i.rule)).toEqual(["shape"]);
      }
    });
  }
});

describe("validatePlan: several violations are all reported", () => {
  test("unknown id, duplicate and over budget together", () => {
    const rules = rulesOf({ items: [item("zzz", 15), item("zzz", 15)] });
    expect(rules).toContain("unknown_id");
    expect(rules).toContain("duplicate");
    expect(rules).toContain("total_minutes");
  });
});

// --- planWithFallback ---------------------------------------------------------------------------

const DETERMINISTIC = Object.freeze({
  date: "2026-09-21",
  planner: "rules" as const,
  totalMinutes: 20,
  items: [{ drillVersionId: "d1", minutes: 20, reason: "fill", done: false }],
});
const ctx = (over: Record<string, unknown> = {}) => ({
  candidateIds: CANDIDATES,
  budgetMinutes: BUDGET,
  profile: PROFILE,
  hasKey: true,
  enabled: true,
  ...over,
});
/** A run function that answers `answer` and counts its calls. */
const provider = (answer: () => unknown) => {
  const calls: AbortSignal[] = [];
  const run = async (signal: AbortSignal) => {
    calls.push(signal);
    return answer();
  };
  return { run, calls };
};

describe("planWithFallback: success", () => {
  test("a valid plan returns planner ai with the plan as the session", async () => {
    const p = provider(() => validPlan());
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx());
    expect(result.planner).toBe("ai");
    expect(result.session).toEqual(validPlan());
    expect("fallback" in result).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  test("run receives an AbortSignal that is not aborted on success", async () => {
    const p = provider(() => validPlan());
    await planWithFallback(p.run, DETERMINISTIC, ctx());
    expect(p.calls[0]).toBeInstanceOf(AbortSignal);
    expect(p.calls[0]!.aborted).toBe(false);
  });

  test("a synchronous run function works too", async () => {
    const result = await planWithFallback(() => validPlan(), DETERMINISTIC, ctx());
    expect(result.planner).toBe("ai");
  });
});

describe("planWithFallback: invalid output falls back to the deterministic session", () => {
  const invalid: [string, unknown][] = [
    ["an id outside the candidate set", { items: [item("c1", 10), item("intruder", 10)] }],
    ["an over-budget plan", { items: [item("c1", 15), item("c2", 15)] }],
    ["an under-budget plan", { items: [item("c1", 5), item("c2", 5)] }],
    ["a duplicate", { items: [item("c1", 10), item("c1", 10)] }],
    ["a URL in a reason", { items: [item("c1", 10, "see https://x.test"), item("c2", 10)] }],
    ["garbage", "not a plan"],
  ];
  for (const [name, plan] of invalid) {
    test(`${name}`, async () => {
      const p = provider(() => plan);
      const result = await planWithFallback(p.run, DETERMINISTIC, ctx());
      expect(result.planner).toBe("rules");
      expect(result.session).toBe(DETERMINISTIC);
      if (result.planner === "rules") expect(result.fallback).toEqual({ code: "invalid_output" });
      expect(p.calls).toHaveLength(1); // no retry loop
    });
  }
});

describe("planWithFallback: provider failures", () => {
  test("a rejected run is provider_error", async () => {
    const p = provider(() => {
      throw new Error("503 from provider");
    });
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx());
    expect(result.planner).toBe("rules");
    expect(result.session).toBe(DETERMINISTIC);
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "provider_error" });
    expect(p.calls).toHaveLength(1); // no retry loop
  });

  test("a synchronous throw is provider_error", async () => {
    const calls: number[] = [];
    const result = await planWithFallback(
      () => {
        calls.push(1);
        throw new Error("boom");
      },
      DETERMINISTIC,
      ctx(),
    );
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "provider_error" });
    else throw new Error("expected the rules planner");
    expect(calls).toHaveLength(1);
  });

  test("a non-Error rejection is provider_error", async () => {
    const result = await planWithFallback(() => Promise.reject("string failure"), DETERMINISTIC, ctx());
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "provider_error" });
    else throw new Error("expected the rules planner");
  });

  test("a provider error named TimeoutError is a timeout", async () => {
    const error = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const result = await planWithFallback(() => Promise.reject(error), DETERMINISTIC, ctx());
    expect(result.session).toBe(DETERMINISTIC);
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "timeout" });
    else throw new Error("expected the rules planner");
  });
});

describe("planWithFallback: timeout", () => {
  test("a run that never answers times out, aborts its signal and returns the deterministic session", async () => {
    const p = provider(() => new Promise(() => {}));
    const started = Date.now();
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx({ timeoutMs: 20 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.planner).toBe("rules");
    expect(result.session).toBe(DETERMINISTIC);
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "timeout" });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.aborted).toBe(true);
  });

  test("an answer that arrives after the timeout is ignored", async () => {
    const late = provider(() => new Promise((resolve) => setTimeout(() => resolve(validPlan()), 80)));
    const result = await planWithFallback(late.run, DETERMINISTIC, ctx({ timeoutMs: 10 }));
    expect(result.planner).toBe("rules");
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the late answer land: no crash
  });

  test("the default timeout is the contract's AI_PLAN_TIMEOUT_MS", async () => {
    const delays: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms);
      return realSetTimeout(handler, ms, ...rest);
    }) as typeof setTimeout;
    try {
      await planWithFallback(() => validPlan(), DETERMINISTIC, ctx());
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(delays).toContain(AI_PLAN_TIMEOUT_MS);
  });

  test("the timer is cleared once the run answers (nothing left pending)", async () => {
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      return realClear(handle);
    }) as typeof clearTimeout;
    try {
      await planWithFallback(() => validPlan(), DETERMINISTIC, ctx());
    } finally {
      globalThis.clearTimeout = realClear;
    }
    expect(cleared.length).toBeGreaterThan(0);
  });
});

describe("planWithFallback: missing key or disabled setting", () => {
  test("no key: no_key, and the provider is never called", async () => {
    const p = provider(() => validPlan());
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx({ hasKey: false }));
    expect(result.planner).toBe("rules");
    expect(result.session).toBe(DETERMINISTIC);
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "no_key" });
    expect(p.calls).toHaveLength(0);
  });

  test("disabled: disabled, and the provider is never called", async () => {
    const p = provider(() => validPlan());
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx({ enabled: false }));
    expect(result.planner).toBe("rules");
    expect(result.session).toBe(DETERMINISTIC);
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "disabled" });
    expect(p.calls).toHaveLength(0);
  });

  test("disabled and no key: disabled wins (the explicit setting)", async () => {
    const p = provider(() => validPlan());
    const result = await planWithFallback(p.run, DETERMINISTIC, ctx({ enabled: false, hasKey: false }));
    if (result.planner === "rules") expect(result.fallback).toEqual({ code: "disabled" });
    else throw new Error("expected the rules planner");
  });
});

describe("planWithFallback: the deterministic session is returned unchanged", () => {
  test("the same object, not a copy, and not mutated", async () => {
    const snapshot = JSON.stringify(DETERMINISTIC);
    const result = await planWithFallback(() => Promise.reject(new Error("x")), DETERMINISTIC, ctx());
    expect(result.session).toBe(DETERMINISTIC);
    expect(JSON.stringify(DETERMINISTIC)).toBe(snapshot);
  });
});
