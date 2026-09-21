// Safety wording of the skill-test protocols in config/commons/football/tests.json (fc-mol-f2u.18).
//
// A child runs these tests alone or with a parent, so three protocols gain safety text:
//   - slalom-time, wall-passing-60s and weak-foot-passes each get a WARM-UP step, before the
//     timed / counted step (the other two tests, juggling and ball mastery, already have one);
//   - wall-passing-60s and weak-foot-passes also say: use a SOFT ball, pass GENTLY, at a wall
//     with NO WINDOWS, AWAY FROM ROADS.
// Only the protocol text of those three tests may change: everything else (thresholds, metric,
// unit, direction, equipment, slug, skill) of all five tests and the whole of the other two tests
// are pinned below by sha256 of canonical JSON (sorted keys), generated once from the file before
// this change was made.
//
// Keyword lists (lower-cased substring match on the protocol text, one list per locale):
//   warm-up   en "warm up" / "warm-up"   ru "разомн" / "размин"   kk "жылын"  (the stem of the
//             warm-up sentence "Алдымен жылын: ..." already used by juggling-max-touches)
//   soft ball en "soft"                  ru "мягк"                kk "жұмсақ"
//   road      en "road"                  ru "дорог"               kk "жол"
//   windows   en "window"                ru "окон"                kk "терезе" (also matches "терезесіз")
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate";
import { openDatabase } from "../../src/db/database";
import { getSkillTests } from "../../src/commons/repo";
import { loadSeed } from "../../src/commons/seed-loader";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SEED_DIR = join(ROOT, "config", "commons");
const TESTS_PATH = join(SEED_DIR, "football", "tests.json");

const LOCALES = ["kk", "ru", "en"] as const;
type Locale = (typeof LOCALES)[number];
type Protocol = Record<Locale, string>;
interface RawTest {
  slug: string;
  protocol: Protocol;
  [key: string]: unknown;
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const sha256 = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

async function loadTests(): Promise<RawTest[]> {
  return (JSON.parse(await Bun.file(TESTS_PATH).text()) as { tests: RawTest[] }).tests;
}
async function testOf(slug: string): Promise<RawTest> {
  const found = (await loadTests()).find((each) => each.slug === slug);
  if (found === undefined) throw new Error(`no test ${slug}`);
  return found;
}

// --- what must not change ---------------------------------------------------------------------

// sha256 of every field except `protocol`, for all five tests (baseline: master before fc-mol-f2u.18).
const NON_PROTOCOL_SHA: Record<string, string> = {
  "juggling-max-touches": "5c53849ffe4d788ab533a0bef8fd3aa48b49d7f02b8d74469cb51922ff060017",
  "wall-passing-60s": "a3fdf2443a54d2c1921aab3f9dd569aab302aa5bcf1bdcc024a4d37cb18535f5",
  "ball-mastery-30s": "b04da41808b0c6138b38dacf9d9f478eed4e5b2be6ac41d82d67cd3dc51e1e1d",
  "slalom-time": "d8f3b5c33ababab5a7e8b839c580b1a71c844c4eefb2ce23e3600229b4e9a986",
  "weak-foot-passes": "c784769085bab9701adb3b317581bf0067e0f547676a4f49ecf933757fd39e3b",
};
// sha256 of the WHOLE test object, protocol included, for the two tests that must stay untouched.
const UNTOUCHED_FULL_SHA: Record<string, string> = {
  "juggling-max-touches": "2f2799867193253b205ea115926d0fa7f48466a07a068446705c77404a5cfaad",
  "ball-mastery-30s": "b5c1883a60be9c4f0c7af22152c8bc56f040e86d0d263d9c1d6afefbf9254d7b",
};

describe("tests.json: only the protocol text of three tests changes", () => {
  test("the file holds exactly the five known tests", async () => {
    expect((await loadTests()).map((each) => each.slug).sort()).toEqual(Object.keys(NON_PROTOCOL_SHA).sort());
  });

  for (const [slug, expected] of Object.entries(NON_PROTOCOL_SHA)) {
    test(`${slug}: every field but the protocol (thresholds, metric, unit, direction, equipment, skill) is unchanged`, async () => {
      const { protocol: _protocol, ...rest } = await testOf(slug);
      expect(sha256(rest)).toBe(expected);
    });
  }

  for (const [slug, expected] of Object.entries(UNTOUCHED_FULL_SHA)) {
    test(`${slug}: the whole test, protocol included, is unchanged`, async () => {
      expect(sha256(await testOf(slug))).toBe(expected);
    });
  }
});

// --- the new wording --------------------------------------------------------------------------

const WARM_UP: Record<Locale, string[]> = { en: ["warm up", "warm-up"], ru: ["разомн", "размин"], kk: ["жылын"] };
const SOFT: Record<Locale, string[]> = { en: ["soft"], ru: ["мягк"], kk: ["жұмсақ"] };
const ROAD: Record<Locale, string[]> = { en: ["road"], ru: ["дорог"], kk: ["жол"] };
const WINDOW: Record<Locale, string[]> = { en: ["window"], ru: ["окон"], kk: ["терезе"] };

/** Every changed test: whether it also needs the soft-ball rule, the English text that opens its
 *  timed / counted step, and the digit its Kazakh text lacks against English at baseline (the try
 *  count is spelled out in Kazakh, "Үш"/"Екі", but written as a digit in ru and en). */
const CHANGED: Record<string, { soft: boolean; counted: RegExp; kkLacksDigit: string }> = {
  "slalom-time": { soft: false, counted: /starts the clock/, kkLacksDigit: "3" },
  "wall-passing-60s": { soft: true, counted: /Ask a parent or friend to time 60 seconds/, kkLacksDigit: "2" },
  "weak-foot-passes": { soft: true, counted: /Stand behind the line and try 10 passes/, kkLacksDigit: "2" },
};

const stepsOf = (text: string): string[] => text.split("\n");
const has = (text: string, keywords: string[]): boolean => keywords.some((word) => text.toLowerCase().includes(word));
/** Indexes (0-based) of the steps that contain one of the keywords. */
const stepsWith = (text: string, keywords: string[]): number[] =>
  stepsOf(text).flatMap((line, index) => (has(line, keywords) ? [index] : []));
const digitsOf = (text: string): string[] => (text.match(/\d/g) ?? []).sort();

describe("tests.json: warm-up and soft-ball wording in the three changed protocols", () => {
  for (const [slug, spec] of Object.entries(CHANGED)) {
    describe(slug, () => {
      for (const locale of LOCALES) {
        test(`${locale}: has exactly one warm-up step`, async () => {
          const { protocol } = await testOf(slug);
          expect(stepsWith(protocol[locale], WARM_UP[locale]), `warm-up steps in ${locale}`).toHaveLength(1);
        });

        if (spec.soft) {
          test(`${locale}: names a wall with no windows and a place away from roads`, async () => {
            const { protocol } = await testOf(slug);
            expect(has(protocol[locale], WINDOW[locale]), `${locale} window`).toBe(true);
            expect(has(protocol[locale], ROAD[locale]), `${locale} road`).toBe(true);
          });

          test(`${locale}: requires a soft ball`, async () => {
            const { protocol } = await testOf(slug);
            expect(stepsWith(protocol[locale], SOFT[locale]).length, `soft-ball steps in ${locale}`).toBeGreaterThanOrEqual(1);
          });
        }
      }

      test("the warm-up is the same step in every locale and comes before the timed / counted step (as does the soft-ball rule)", async () => {
        const { protocol } = await testOf(slug);
        const en = stepsOf(protocol.en);
        const counted = en.findIndex((line) => spec.counted.test(line));
        expect(counted, "the timed / counted English step exists").toBeGreaterThan(0);
        const warmUp = stepsWith(protocol.en, WARM_UP.en)[0]!;
        for (const locale of LOCALES) {
          expect(stepsWith(protocol[locale], WARM_UP[locale])[0], `${locale} warm-up step`).toBe(warmUp);
          if (spec.soft) {
            expect(Math.min(...stepsWith(protocol[locale], SOFT[locale])), `${locale} soft-ball step`).toBeLessThan(counted);
          }
        }
        expect(warmUp, "warm-up before the timed / counted step").toBeLessThan(counted);
      });

      test("steps: same count in every locale, numbered 1..n, and one more than the seven before", async () => {
        const { protocol } = await testOf(slug);
        const counts = LOCALES.map((locale) => stepsOf(protocol[locale]).length);
        expect(new Set(counts).size, `step counts ${counts.join("/")}`).toBe(1);
        expect(counts[0]!).toBeGreaterThanOrEqual(8);
        for (const locale of LOCALES) {
          stepsOf(protocol[locale]).forEach((line, index) => {
            expect(line.startsWith(`${index + 1}. `), `${locale} step ${index + 1}: ${line}`).toBe(true);
          });
        }
      });

      test("digits: ru = en, and kk = en minus exactly the spelled-out try-count digit (no digit added or dropped in one locale)", async () => {
        const { protocol } = await testOf(slug);
        expect(digitsOf(protocol.ru)).toEqual(digitsOf(protocol.en));
        const expectedKk = [...digitsOf(protocol.en)];
        const at = expectedKk.indexOf(spec.kkLacksDigit);
        expect(at, `en carries the digit ${spec.kkLacksDigit}`).toBeGreaterThanOrEqual(0);
        expectedKk.splice(at, 1);
        expect(digitsOf(protocol.kk)).toEqual(expectedKk);
      });
    });
  }
});

// --- the loader stores it ---------------------------------------------------------------------

describe("the real seed loader applies the new protocol text", () => {
  test("a migrated :memory: database returns the soft-ball wall-passing protocol from getSkillTests", () => {
    const db: Database = openDatabase(":memory:");
    try {
      migrate(db, MIGRATIONS_DIR);
      const summary = loadSeed(db, SEED_DIR);
      expect(summary.tests).toBe(5);
      const wall = getSkillTests(db, "football").find((each) => each.slug === "wall-passing-60s");
      expect(wall, "wall-passing-60s is stored").toBeDefined();
      expect((wall!.protocol.en ?? "").toLowerCase()).toContain("soft");
      expect((wall!.protocol.ru ?? "").toLowerCase()).toContain("мягк");
      expect((wall!.protocol.kk ?? "").toLowerCase()).toContain("жұмсақ");
    } finally {
      db.close();
    }
  });
});
