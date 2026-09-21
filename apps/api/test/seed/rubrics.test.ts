// Seed content test for config/commons/football/rubrics.json (fc-mol-8nt.2).
//
// The file is AUTHORED content: one pose-observable rubric per skill track, each in Kazakh, Russian
// and English. A rubric says what the video coach will judge (criteria, each with a description and
// "look for" cues that can be seen from body pose and still frames, WITHOUT ball tracking), how to
// film (recording tips) and the minimum mean landmark visibility below which the clip is refused.
// Every rubric is marked status COMMUNITY (a draft that still needs a native-speaker review, see
// fc-cjh). The shape is the video-coach `Rubric` contract (shared/video.ts) with texts in three
// locales; bead 8nt.3 will serve it. These tests check the shape the criteria fix (schema, five
// rubrics matching the five tracks, 4-7 criteria each, three locales everywhere) plus the safety
// and tone rules of the content. They do NOT pin criterion keys, wording or the visibility numbers.
//
// Content rules asserted below (children from about 6, PRODUCT.md): no injury or medical claims,
// no professional-career promises, no comments on a child's body or appearance, no harsh words,
// and nothing that needs the ball to be tracked.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate";
import { loadSeed } from "../../src/commons/seed-loader";
import { SeedRubricsFile, SeedSkillGraphFile } from "../../src/commons/seed-schema";
import type { SeedRubric } from "../../src/commons/seed-schema";
import { Rubric } from "../../src/shared/video";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SEED_DIR = join(ROOT, "config", "commons");
const RUBRICS_PATH = join(SEED_DIR, "football", "rubrics.json");
const GRAPH_PATH = join(SEED_DIR, "football", "skill-graph.json");

const LOCALES = ["kk", "ru", "en"] as const;
type Locale = (typeof LOCALES)[number];
type Text = Record<Locale, string>;

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

// Forbidden content, per locale. Deliberately specific words: the tests name what must NOT appear.
const MEDICAL = {
  en: /injur|\bpain|\bhurt|medical|doctor|physio|therap|\bheal|\bcure\b|diagnos|prevent/i,
  ru: /травм|(^|[^а-яё])бол(ь|и|ит|ят)([^а-яё]|$)|врач|лечен|здоровь|диагноз|профилакт/i,
  kk: /жарақат|ауырсын|ауыру|дәрігер|емдеу|денсаулық|диагноз/i,
};
const CAREER = {
  en: /professional|\bpros?\b|scout|academy|career|champion|\bstars?\b|contract|talent|elite|world[- ]class/i,
  ru: /профессионал|скаут|академи|карьер|чемпион|звезд|контракт|талант|элит/i,
  kk: /кәсіпқой|скаут|академия|мансап|чемпион|жұлдыз|келісімшарт|талант|элита/i,
};
const APPEARANCE = {
  en: /\b(fat|skinny|overweight|slim|chubby|weight|heavy|beautiful|handsome|ugly)\b/i,
  ru: /толст|худой|худая|худые|(^|[^а-яё])вес([^а-яё]|$)|красив|некрасив|стройн/i,
  kk: /семіз|арық|әдемі|сұлу|келбет/i,
};
const HARSH = {
  en: /\b(bad|terrible|awful|poor|lazy|failure|stupid|hopeless|worst|clumsy)\b/i,
  ru: /плох|ужасн|ленив|неудачник|глуп|безнадёжн|неуклюж/i,
  kk: /жаман|қорқынышты|жалқау|ақымақ|олақ/i,
};
// Ball tracking is out: the judge sees a pose, not where the ball goes.
const BALL_TRACKING = {
  en: /trajectory|accura|on target|scor(e|ing)|track(s|ing)? the ball|where the ball|ball (position|speed|spin|flight|height|bounce)/i,
  ru: /траектор|точност|попад|куда (летит|катится)|положение мяча|скорость мяча/i,
  kk: /траектория|дәлдік|нысанаға|доптың (орны|жылдамдығы|ұшуы|бағыты)/i,
};

async function loadRaw(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function loadRubrics(): Promise<SeedRubric[]> {
  const parsed = SeedRubricsFile.safeParse(await loadRaw(RUBRICS_PATH));
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.rubrics;
}

/** The slugs of the sport's top-level skills: the tracks. */
async function loadTracks(): Promise<string[]> {
  const parsed = SeedSkillGraphFile.safeParse(await loadRaw(GRAPH_PATH));
  if (!parsed.success) throw new Error(`skill graph invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.nodes.filter((node) => node.parent === null).map((node) => node.slug);
}

const isText = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  LOCALES.some((locale) => locale in (value as Record<string, unknown>));

/** Every text object (an object carrying any of kk/ru/en) with its JSON path, found generically. */
function textLeaves(value: unknown, path = "$"): { path: string; text: Text }[] {
  if (isText(value)) return [{ path, text: value as Text }];
  if (Array.isArray(value)) return value.flatMap((item, index) => textLeaves(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => textLeaves(item, `${path}.${key}`));
  }
  return [];
}

const digitsOf = (text: string): string => (text.match(/\d/g) ?? []).sort().join("");

const byTrack = (rubrics: SeedRubric[], track: string): SeedRubric => {
  const found = rubrics.find((each) => each.skill === track);
  if (found === undefined) throw new Error(`no rubric names the track ${track}`);
  return found;
};

/** The criteria texts of a rubric (what the judge is told to look at), for every locale. */
const criteriaTexts = (rubric: SeedRubric, locale: Locale): string[] =>
  rubric.criteria.flatMap((c) => [c.label[locale], c.description[locale], ...c.lookFor.map((cue) => cue[locale])]);

/** Every text of a rubric, for every locale. */
const allTexts = (rubric: SeedRubric, locale: Locale): string[] => [
  ...criteriaTexts(rubric, locale),
  ...rubric.recordingTips.map((tip) => tip[locale]),
];

describe("rubrics.json: schema and identity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(RUBRICS_PATH).exists()).toBe(true);
    expect(await loadRaw(RUBRICS_PATH)).toBeObject();
  });

  test("parses with SeedRubricsFile for the football sport", async () => {
    const parsed = SeedRubricsFile.safeParse(await loadRaw(RUBRICS_PATH));
    if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sport).toBe("football");
  });

  test("there are five rubrics, one per track: the skills are exactly the five top-level skills", async () => {
    const rubrics = await loadRubrics();
    const tracks = await loadTracks();
    expect(tracks).toHaveLength(5);
    expect(rubrics).toHaveLength(5);
    expect(rubrics.map((each) => each.skill).sort()).toEqual([...tracks].sort());
  });

  test("every rubric is a COMMUNITY draft at version 1", async () => {
    for (const rubric of await loadRubrics()) {
      expect(rubric.status, rubric.skill).toBe("COMMUNITY");
      expect(rubric.version, rubric.skill).toBe(1);
    }
  });
});

describe("rubrics.json: what is judged and how to film", () => {
  test("each rubric has 4 to 7 criteria with unique keys and unique labels", async () => {
    for (const rubric of await loadRubrics()) {
      expect(rubric.criteria.length, `${rubric.skill} criteria`).toBeGreaterThanOrEqual(4);
      expect(rubric.criteria.length, `${rubric.skill} criteria`).toBeLessThanOrEqual(7);
      expect(new Set(rubric.criteria.map((c) => c.key)).size, `${rubric.skill} keys`).toBe(rubric.criteria.length);
      for (const locale of LOCALES) {
        const labels = rubric.criteria.map((c) => c.label[locale].toLowerCase());
        expect(new Set(labels).size, `${rubric.skill} ${locale} labels`).toBe(labels.length);
      }
    }
  });

  test("each criterion has a description and at least two look-for cues", async () => {
    for (const rubric of await loadRubrics()) {
      for (const criterion of rubric.criteria) {
        for (const locale of LOCALES) {
          expect(criterion.description[locale].trim().length, `${rubric.skill}/${criterion.key} ${locale}`).toBeGreaterThan(10);
        }
        expect(criterion.lookFor.length, `${rubric.skill}/${criterion.key} cues`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("the recording tips cover phone placement, distance, light and the full body in frame", async () => {
    for (const rubric of await loadRubrics()) {
      const tips = rubric.recordingTips.map((tip) => tip.en).join("\n");
      expect(/phone/i.test(tips), `${rubric.skill}: phone placement`).toBe(true);
      expect(/metre|meter|\bm\b|steps?\b|far|distance/i.test(tips), `${rubric.skill}: distance`).toBe(true);
      expect(/light|bright|sun|shadow|dark/i.test(tips), `${rubric.skill}: light`).toBe(true);
      expect(/whole body|full body|head to (toe|foot|feet)|from head/i.test(tips), `${rubric.skill}: full body in frame`).toBe(true);
    }
  });

  test("the minimum mean landmark visibility is a real threshold: neither trivial nor unreachable", async () => {
    for (const rubric of await loadRubrics()) {
      expect(rubric.minVisibility, rubric.skill).toBeGreaterThanOrEqual(0.4);
      expect(rubric.minVisibility, rubric.skill).toBeLessThanOrEqual(0.8);
    }
  });

  test("the dribbling rubric covers the criteria the brief names: both feet, change of direction, balance", async () => {
    const dribbling = byTrack(await loadRubrics(), "dribbling");
    const text = criteriaTexts(dribbling, "en").join("\n");
    expect(/both feet|either foot|each foot|left and right/i.test(text)).toBe(true);
    expect(/direction/i.test(text)).toBe(true);
    expect(/balance/i.test(text)).toBe(true);
    expect(/rhythm/i.test(text)).toBe(true);
  });
});

describe("rubrics.json: it maps onto the Rubric contract the API serves", () => {
  test.each([...LOCALES])("localised to %s, every rubric parses with the video Rubric schema", async (locale) => {
    for (const seed of await loadRubrics()) {
      const wire = {
        skill: seed.skill,
        version: seed.version,
        criteria: seed.criteria.map((c) => ({
          key: c.key,
          label: c.label[locale],
          description: c.description[locale],
          lookFor: c.lookFor.map((cue) => cue[locale]),
        })),
        recordingTips: seed.recordingTips.map((tip) => tip[locale]),
        minVisibility: seed.minVisibility,
      };
      const parsed = Rubric.safeParse(wire);
      if (!parsed.success) console.error(seed.skill, JSON.stringify(parsed.error.issues));
      expect(parsed.success, `${seed.skill} ${locale}`).toBe(true);
    }
  });

  test("the real seed directory loads with the rubrics file present, and rubrics write no rows", () => {
    const db = openDatabase(":memory:");
    try {
      expect(existsSync(RUBRICS_PATH)).toBe(true);
      migrate(db, MIGRATIONS_DIR);
      expect(() => loadSeed(db, SEED_DIR)).not.toThrow();
      const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%rubric%'`).all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("rubrics.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const leaves = textLeaves(await loadRaw(RUBRICS_PATH));
    expect(leaves.length).toBeGreaterThan(50);
    for (const { path, text } of leaves) {
      expect(Object.keys(text).sort(), path).toEqual(["en", "kk", "ru"]);
      for (const locale of LOCALES) {
        expect(typeof text[locale], `${path}.${locale}`).toBe("string");
        expect(text[locale].trim().length, `${path}.${locale} is blank`).toBeGreaterThan(0);
      }
    }
  });

  test("kk and ru are real translations, not copies: they differ from en and from each other", async () => {
    for (const { path, text } of textLeaves(await loadRaw(RUBRICS_PATH))) {
      const { kk, ru, en } = text;
      expect(kk, `${path}: kk is a copy of en`).not.toBe(en);
      expect(ru, `${path}: ru is a copy of en`).not.toBe(en);
      expect(kk, `${path}: kk is a copy of ru`).not.toBe(ru);
    }
  });

  test("kk and ru are written in Cyrillic with no untranslated English words; en has no Cyrillic", async () => {
    for (const { path, text } of textLeaves(await loadRaw(RUBRICS_PATH))) {
      const { kk, ru, en } = text;
      expect(CYRILLIC.test(kk), `${path}.kk has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(ru), `${path}.ru has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(en), `${path}.en contains Cyrillic`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(kk), `${path}.kk has a Latin word: ${kk}`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(ru), `${path}.ru has a Latin word: ${ru}`).toBe(false);
    }
  });

  test("kk text carries Kazakh letters and ru text carries none", async () => {
    for (const { path, text } of textLeaves(await loadRaw(RUBRICS_PATH))) {
      const { kk, ru } = text;
      if (kk.length >= 30) expect(KAZAKH_ONLY.test(kk), `${path}.kk has no Kazakh letter: ${kk}`).toBe(true);
      expect(KAZAKH_ONLY.test(ru), `${path}.ru has a Kazakh letter: ${ru}`).toBe(false);
    }
  });

  test("the numbers in a text are the same in all three locales (distances must not drift)", async () => {
    for (const { path, text } of textLeaves(await loadRaw(RUBRICS_PATH))) {
      expect(digitsOf(text.kk), `${path}: kk digits`).toBe(digitsOf(text.en));
      expect(digitsOf(text.ru), `${path}: ru digits`).toBe(digitsOf(text.en));
    }
  });

  test("texts carry no placeholder markers and stay short", async () => {
    for (const { path, text } of textLeaves(await loadRaw(RUBRICS_PATH))) {
      for (const locale of LOCALES) {
        const value = text[locale];
        expect(value.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(300);
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});

describe("rubrics.json: safe, positive content for children", () => {
  const rules: [string, Record<Locale, RegExp>][] = [
    ["an injury or medical claim", MEDICAL],
    ["a professional-career promise", CAREER],
    ["a comment on the body or appearance", APPEARANCE],
    ["a harsh word", HARSH],
  ];

  for (const [name, patterns] of rules) {
    test(`no text contains ${name}`, async () => {
      for (const rubric of await loadRubrics()) {
        for (const locale of LOCALES) {
          for (const value of allTexts(rubric, locale)) {
            expect(patterns[locale].test(value), `${rubric.skill} ${locale}: ${value}`).toBe(false);
          }
        }
      }
    });
  }

  test("no criterion needs the ball to be tracked: cues describe the body and stay pose-observable", async () => {
    for (const rubric of await loadRubrics()) {
      for (const locale of LOCALES) {
        for (const value of criteriaTexts(rubric, locale)) {
          expect(BALL_TRACKING[locale].test(value), `${rubric.skill} ${locale}: ${value}`).toBe(false);
        }
      }
    }
  });

  test("the criteria are worded as something to notice and build on: at least one cue names the body", async () => {
    for (const rubric of await loadRubrics()) {
      const cues = rubric.criteria.flatMap((c) => c.lookFor.map((cue) => cue.en)).join("\n");
      expect(/\b(knees?|feet|foot|arms?|head|shoulders?|hips?|chest|body|steps?|legs?|ankles?)\b/i.test(cues), rubric.skill).toBe(true);
    }
  });
});
