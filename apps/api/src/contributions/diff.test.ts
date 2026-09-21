import { describe, expect, test } from "bun:test";
import { DiffEntry } from "../shared/admin";
import type { DrillDetail } from "../shared/commons";
import type { ContributionPayloadView } from "../shared/contributions";
import type { Locale } from "../shared/primitives";
import { deepEqual, diffAgainstCurrent } from "./diff";

// The current version as the API has it: a DrillDetail, plus the library-row values the
// detail does not carry (`level`, `minutes`, `goal`), merged in by the caller.
type Current = DrillDetail & { level?: "basic"; minutes?: number; goal?: "control" };

const currentVersion = (): Current => ({
  slug: "ball-control",
  versionId: "v1",
  content: {
    title: { ru: "Ведение мяча", en: "Ball control" },
    goal: { en: "Control" },
    instructions: { kk: "Нұсқаулық", ru: "Инструкция", en: "Instructions" },
    dose: { reps: 10 },
    mistakes: [{ ru: "Ошибка 1", en: "Mistake one" }, { ru: "Ошибка 2" }],
    progressions: [{ ru: "Сложнее" }],
    regressions: [],
    conditions: { equipment: "ball", spaces: ["yard"], partner: false, ageMin: 8, ageMax: 12 },
    safety: [{ en: "Warm up" }],
    media: [],
  },
  attribution: {
    author: "Coach A",
    source: "Own practice",
    sourceUrl: "https://example.com/drill",
    license: "CC-BY-SA-4.0",
    createdAt: "2026-09-01T10:00:00Z",
    semver: "1.0.0",
  },
  history: [],
  reviews: [],
  level: "basic",
  minutes: 10,
  goal: "control",
});

/** A ru payload that repeats the current version exactly: the diff of it is empty. */
const identicalRu = (): Partial<ContributionPayloadView> => ({
  name: "Ведение мяча",
  goal: "control",
  instructions: "Инструкция",
  mistakes: "Ошибка 1\nОшибка 2",
  progression: "Сложнее",
  regression: "",
  safety: "",
  ageMin: 8,
  ageMax: 12,
  level: "basic",
  equipment: "ball",
  durationMin: 10,
  source: "Own practice",
  sourceUrl: "https://example.com/drill",
  author: "Coach A",
});

const fieldsOf = (entries: { field: string }[]): string[] => entries.map((entry) => entry.field);

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

describe("diffAgainstCurrent: what is omitted", () => {
  test("a payload that repeats the current version reports nothing", () => {
    expect(diffAgainstCurrent(currentVersion(), identicalRu(), "ru")).toEqual([]);
  });

  test("an empty payload reports nothing: absent keys are not removals", () => {
    expect(diffAgainstCurrent(currentVersion(), {}, "ru")).toEqual([]);
  });

  test("only the keys the payload carries are compared", () => {
    const entries = diffAgainstCurrent(currentVersion(), { ageMin: 9 }, "ru");
    expect(fieldsOf(entries)).toEqual(["ageMin"]);
  });

  test("a key that is present but undefined counts as absent", () => {
    expect(diffAgainstCurrent(currentVersion(), { ageMin: undefined, instructions: undefined }, "ru")).toEqual([]);
  });

  test("whitespace-only differences are not differences", () => {
    const padded: Partial<ContributionPayloadView> = {
      ...identicalRu(),
      name: "  Ведение мяча ",
      instructions: "\n Инструкция\t",
      mistakes: "  Ошибка 1  \r\n\r\n Ошибка 2 \n",
      source: " Own practice ",
      author: "Coach A  ",
    };
    expect(diffAgainstCurrent(currentVersion(), padded, "ru")).toEqual([]);
  });
});

describe("diffAgainstCurrent: non-localized fields", () => {
  test("one changed ageMin gives exactly one entry with before and after", () => {
    const entries = diffAgainstCurrent(currentVersion(), { ...identicalRu(), ageMin: 9 }, "ru");
    expect(entries).toEqual([{ field: "ageMin", before: 8, after: 9 }]);
  });

  test("a changed equipment is reported under its own name", () => {
    const entries = diffAgainstCurrent(currentVersion(), { equipment: "cones" }, "ru");
    expect(entries).toEqual([{ field: "equipment", before: "ball", after: "cones" }]);
  });

  test("durationMin is compared with the current minutes", () => {
    const entries = diffAgainstCurrent(currentVersion(), { durationMin: 15 }, "ru");
    expect(entries).toEqual([{ field: "durationMin", before: 10, after: 15 }]);
  });

  test("level and goal are compared with the current row values", () => {
    const entries = diffAgainstCurrent(currentVersion(), { level: "intermediate", goal: "passing" }, "ru");
    expect(entries).toEqual([
      { field: "goal", before: "control", after: "passing" },
      { field: "level", before: "basic", after: "intermediate" },
    ]);
  });

  test("source, sourceUrl and author are compared with the attribution", () => {
    const entries = diffAgainstCurrent(
      currentVersion(),
      { source: "Federation manual", sourceUrl: "https://example.org/x", author: "Coach B" },
      "ru",
    );
    expect(entries).toEqual([
      { field: "source", before: "Own practice", after: "Federation manual" },
      { field: "sourceUrl", before: "https://example.com/drill", after: "https://example.org/x" },
      { field: "author", before: "Coach A", after: "Coach B" },
    ]);
  });

  test("ageMax is compared with the current conditions", () => {
    const entries = diffAgainstCurrent(currentVersion(), { ageMax: 14 }, "ru");
    expect(entries).toEqual([{ field: "ageMax", before: 12, after: 14 }]);
  });

  test("a missing current value against a provided payload value is a difference with before undefined", () => {
    const current = currentVersion();
    delete current.content.conditions.ageMin;
    delete current.level;
    delete current.minutes;
    delete current.attribution.sourceUrl;
    const entries = diffAgainstCurrent(current, { ageMin: 8, level: "basic", durationMin: 10, sourceUrl: "https://example.com/drill" }, "ru");
    expect(fieldsOf(entries)).toEqual(["ageMin", "level", "durationMin", "sourceUrl"]);
    for (const entry of entries) {
      expect("before" in entry).toBe(true);
      expect(entry.before).toBeUndefined();
    }
    expect(entries.map((entry) => entry.after)).toEqual([8, "basic", 10, "https://example.com/drill"]);
  });

  test("a missing title is a difference with before undefined", () => {
    const current = currentVersion();
    delete current.content.title;
    const entries = diffAgainstCurrent(current, { name: "Ведение мяча" }, "ru");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.field).toBe("name.ru");
    expect(entries[0]?.before).toBeUndefined();
    expect(entries[0]?.after).toBe("Ведение мяча");
  });
});

describe("diffAgainstCurrent: localized text, per locale", () => {
  test("a changed text names its locale and carries the two strings", () => {
    const entries = diffAgainstCurrent(currentVersion(), { instructions: "Новая инструкция" }, "ru");
    expect(entries).toEqual([{ field: "instructions.ru", before: "Инструкция", after: "Новая инструкция" }]);
  });

  test("a translation-only improvement shows exactly one locale entry", () => {
    const current = currentVersion();
    current.content.instructions = { ru: "Инструкция" };
    const entries = diffAgainstCurrent(current, { ...identicalRu(), instructions: "Dribble round the cones" }, "en");
    // the en payload repeats no ru text, yet only the en instruction is reported
    expect(entries.filter((entry) => entry.field.startsWith("instructions."))).toEqual([
      { field: "instructions.en", before: undefined, after: "Dribble round the cones" },
    ]);
    expect(entries.some((entry) => entry.field === "instructions.ru")).toBe(false);
    expect(entries.some((entry) => entry.field === "instructions.kk")).toBe(false);
  });

  test("a translation over an existing different translation is one entry with both strings", () => {
    const entries = diffAgainstCurrent(currentVersion(), { instructions: "Better instructions" }, "en");
    expect(entries).toEqual([{ field: "instructions.en", before: "Instructions", after: "Better instructions" }]);
  });

  test("changes in two localized fields report two entries", () => {
    const entries = diffAgainstCurrent(
      currentVersion(),
      { instructions: "Новая инструкция", progression: "Ещё сложнее" },
      "ru",
    );
    expect(entries).toEqual([
      { field: "instructions.ru", before: "Инструкция", after: "Новая инструкция" },
      { field: "progression.ru", before: "Сложнее", after: "Ещё сложнее" },
    ]);
  });

  test("the payload locale scopes the comparison: a kk payload equal to the kk text reports nothing", () => {
    // the kk text differs from the ru and en text, so any comparison outside kk would report
    expect(diffAgainstCurrent(currentVersion(), { instructions: "Нұсқаулық" }, "kk")).toEqual([]);
  });

  test("a kk payload never reports ru or en fields and takes its before from kk", () => {
    const entries = diffAgainstCurrent(currentVersion(), { instructions: "Жаңа нұсқаулық" }, "kk");
    expect(entries).toEqual([{ field: "instructions.kk", before: "Нұсқаулық", after: "Жаңа нұсқаулық" }]);
  });

  test("the same payload text is a difference in a locale where the text is different", () => {
    const text = "Инструкция";
    expect(diffAgainstCurrent(currentVersion(), { instructions: text }, "ru")).toEqual([]);
    expect(diffAgainstCurrent(currentVersion(), { instructions: text }, "en")).toEqual([
      { field: "instructions.en", before: "Instructions", after: text },
    ]);
  });

  test("list fields (mistakes) compare the locale's items joined by lines", () => {
    const changed = diffAgainstCurrent(currentVersion(), { mistakes: "Ошибка 1\nОшибка 3" }, "ru");
    expect(changed).toEqual([{ field: "mistakes.ru", before: "Ошибка 1\nОшибка 2", after: "Ошибка 1\nОшибка 3" }]);
    // the en list holds only the first mistake
    expect(diffAgainstCurrent(currentVersion(), { mistakes: "Mistake one" }, "en")).toEqual([]);
  });

  test("a blank payload text over existing text reports the removal; over nothing it reports nothing", () => {
    const removed = diffAgainstCurrent(currentVersion(), { safety: "" }, "en");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.field).toBe("safety.en");
    expect(removed[0]?.before).toBe("Warm up");
    expect(removed[0]?.after).toBeUndefined();
    // ru has no safety text and no regression: a blank payload changes nothing
    expect(diffAgainstCurrent(currentVersion(), { safety: "", regression: "" }, "ru")).toEqual([]);
  });

  test("every locale is scoped the same way", () => {
    const locales: Locale[] = ["kk", "ru", "en"];
    for (const locale of locales) {
      const entries = diffAgainstCurrent(currentVersion(), { instructions: "changed" }, locale);
      expect(fieldsOf(entries)).toEqual([`instructions.${locale}`]);
    }
  });
});

describe("diffAgainstCurrent: shape and order", () => {
  test("entries are the admin contract's DiffEntry: exactly field, before and after", () => {
    const entries = diffAgainstCurrent(currentVersion(), { ageMin: 9, instructions: "x" }, "ru");
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["after", "before", "field"]);
      expect(DiffEntry.safeParse(entry).success).toBe(true);
    }
  });

  test("the order of entries does not depend on the order of payload keys", () => {
    const changed: Partial<ContributionPayloadView> = {
      author: "Coach B",
      durationMin: 15,
      equipment: "cones",
      ageMin: 9,
      safety: "Новая безопасность",
      instructions: "Новая инструкция",
      name: "Новое имя",
    };
    const expectedFields = [
      "name.ru",
      "instructions.ru",
      "safety.ru",
      "ageMin",
      "equipment",
      "durationMin",
      "author",
    ];
    const keys = Object.keys(changed) as (keyof typeof changed)[];
    const permutations: (keyof typeof changed)[][] = [
      keys,
      [...keys].reverse(),
      [...keys.slice(3), ...keys.slice(0, 3)],
      [keys[2]!, keys[5]!, keys[0]!, keys[6]!, keys[1]!, keys[4]!, keys[3]!],
    ];
    const results = permutations.map((order) => {
      const payload: Record<string, unknown> = {};
      for (const key of order) payload[key] = changed[key];
      return diffAgainstCurrent(currentVersion(), payload as Partial<ContributionPayloadView>, "ru");
    });
    for (const result of results) {
      expect(fieldsOf(result)).toEqual(expectedFields);
      expect(result).toEqual(results[0]!);
    }
  });

  test("the inputs are never mutated", () => {
    const current = deepFreeze(currentVersion());
    const payload = deepFreeze({ ...identicalRu(), ageMin: 9, instructions: "Новая", safety: "Разминка" });
    const currentBefore = structuredClone(current);
    const payloadBefore = structuredClone(payload);
    const entries = diffAgainstCurrent(current, payload, "ru");
    expect(fieldsOf(entries)).toEqual(["instructions.ru", "safety.ru", "ageMin"]);
    expect(current).toEqual(currentBefore);
    expect(payload).toEqual(payloadBefore);
  });
});

describe("deepEqual", () => {
  test("compares arrays and objects by value, not by reference", () => {
    expect(deepEqual(["ball", "cones"], ["ball", "cones"])).toBe(true);
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
  });

  test("array order matters", () => {
    expect(deepEqual(["ball", "cones"], ["cones", "ball"])).toBe(false);
  });

  test("differences at any depth, in length or in type are found", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });
});
