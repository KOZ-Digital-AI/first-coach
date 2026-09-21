// Seed copy test (fc-mol-f2u.19): the two partner pass-and-stop drills need titles a child can tell
// apart in every locale, and step 1 of passing-two-touch-self must stand on its own.
//
// Scope. Only two things may differ from the seed as it was before this change:
//   - the TITLE of weak-foot-partner-pass-and-stop (kk, ru and en; passing-partner-pass-and-stop keeps
//     its title, so the weak-foot one is the one that gets the "weaker foot" wording), and
//   - the INSTRUCTIONS of passing-two-touch-self (step 1 only; steps 2..n stay word for word).
// Every other field of every one of the 60 drills stays byte-identical. The test cannot read master
// from git, so the pre-change seed is PINNED as sha256 hashes of the canonical JSON (keys sorted,
// no whitespace) of each drill, generated ONCE by a scratch script BEFORE the data was edited:
// the full drill for 58 drills, the drill WITHOUT its title for weak-foot-partner-pass-and-stop and
// WITHOUT title and instructions for passing-two-touch-self.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate";
import { loadSeed } from "../../src/commons/seed-loader";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SEED_DIR = join(ROOT, "config", "commons");
const DRILLS_DIR = join(SEED_DIR, "football", "drills");
const LOCALES = ["kk", "ru", "en"] as const;
type Locale = (typeof LOCALES)[number];
type Text = Record<Locale, string>;
type RawDrill = Record<string, unknown> & { slug: string; title: Text; instructions: Text };

const WEAK_PARTNER = "weak-foot-partner-pass-and-stop";
const PASSING_PARTNER = "passing-partner-pass-and-stop";
const TWO_TOUCH = "passing-two-touch-self";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const drills: RawDrill[] = readdirSync(DRILLS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .flatMap((name) => (JSON.parse(readFileSync(join(DRILLS_DIR, name), "utf8")) as { drills: RawDrill[] }).drills);
const bySlug = new Map(drills.map((drill) => [drill.slug, drill]));
const drill = (slug: string): RawDrill => {
  const found = bySlug.get(slug);
  if (!found) throw new Error(`missing drill ${slug}`);
  return found;
};

/** Lower-case, letters and digits only: "Pass and stop, friend!" and "pass and stop friend" are the same title. */
const normalise = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const steps = (slug: string, locale: Locale): string[] => drill(slug).instructions[locale].split("\n");
const digitsOf = (text: string): string => (text.match(/\d/g) ?? []).sort().join("");

// Pinned from the seed BEFORE this change (generated once by a scratch script, not by this test).
const PINNED_HASH: Record<string, string> = {
  "ball-mastery-ghost-ball": "aa6005a61e5a9f392ef2e5d80c710654bf7f6894a7866a2fc208f412a447d1b8",
  "ball-mastery-sole-taps": "26367c8c9447fdac264c30e17fd82933f3c510085389dc701ae6682396041fa0",
  "ball-mastery-sole-rolls": "930004bf2750e7a4b612e28c904bb633704c639ffb32e8b7e6e1aa8cf55cec6e",
  "ball-mastery-foundation-touches": "71b22db7618cf1ef048e050c025de6d21783aa6755ce684bfb47ac2cee4fb63f",
  "ball-mastery-clock-taps": "bc51d9c3b0b85426562e85d8b626fa2a420900500b200e27ac7b6cdd24f30041",
  "ball-mastery-inside-ping-pong": "e08427cd33c23048402bcbd547723ac4b4951410d297f3b078338da9cc283572",
  "ball-mastery-sole-pull-push": "3224d63d26795d31aa40056e201a0859e829def955dd5ce002e50529ac8eceaa",
  "ball-mastery-inside-outside-rhythm": "366e3f41ad611d2e3952049ca9f6cd11d9ed0dd0e89f24d63c878ba0c1428d3b",
  "ball-mastery-figure-eight": "4d019ec6af68926ed57b81533276cf6793211f6471ba7fe936bf76081fc1888f",
  "ball-mastery-turn-and-go": "ece5cf4905b859272701dae5d0c25eb7937c0bf5ea55c9bb7fb72c7e6369595e",
  "ball-mastery-slow-fast-stop": "c76214e9c3f3666b7e8612c8e196d6b190a39ed7a498ed2ad52987b8c1d96d5b",
  "ball-mastery-look-up-touches": "682811089437d2f9f1e1627484238b271783355b9ba6dc2feb3b702119560df5",
  "dribbling-quick-feet-look-around": "08cbbbff2fba16fbaa190427457eec4111dd3e04c9cce24da8b4751c16a7f8c1",
  "dribbling-snail-circle": "288e290ca7b47bcbdeed36182db0eef3d7cb36f300f169e29ce164c9563bef25",
  "dribbling-there-and-back": "eb350d5342477544927a85a6087ef3c05432f3cc35b625bc3e721493933bbeda",
  "dribbling-freeze-and-go": "017ce64821746671e44be1e27ecb083f78224afac11d7885084914dc3c160e87",
  "dribbling-five-cone-slalom": "1a62cf25c2fe40750ddbe9706e2c16687341c9bdc2daa232c61d48e8d2bbb9c5",
  "dribbling-two-foot-zigzag": "455b27ae537885dd752da1e90e4f257e676546d356bc6ef0fcfad6f264e1d2d0",
  "dribbling-sole-stop-turn": "d606916bed8c8fe42512cff43dcd0b81e190838cf6b3eefd48f3e2b974c90dc0",
  "dribbling-change-direction-box": "9bde8e6ac9bb30974c47a522a04b86702ca2bcadd3a62e504fb11b130fb685d4",
  "dribbling-look-up-dribble": "c12a56c71a48c78c910a60695a8c145dbdd09c9402ff25cf864fb530aa82374e",
  "dribbling-partner-finger-signal": "06037debca57247475d13735902442d5c09df852bbd941cb5877c6a087e29249",
  "dribbling-tight-cone-weave": "9ee8c12e753d85de32d7ca5a58ef9184f6c9744f227fde2ebe048f8ab6f7395c",
  "dribbling-speed-dash-stop": "3a72a2f7b7ab192aa65a2bd5bfd2faf8ec0e49f7f13fbf33582b878fb47ba514",
  "juggling-stork-stand": "ad7b2c949e52cd5838283b3fcf4a08d4241c5590d1804d50721514b1f3336836",
  "juggling-drum-roll-feet": "aca2f681ec98aa93acd11a5c6ac14a20d2c4dbbab7e61835284eadc15d72daa0",
  "juggling-drop-bounce-catch": "657c9811b2e075a37b7cb3604717cad4f3f78cd91d61ae77584192efd2e648ef",
  "juggling-bounce-juggle": "712a18f43cbf5bfe4fdaae3e7ce2911157f1fba5eebc059e68f2068c9130b08d",
  "juggling-lift-and-catch": "5514fd03d6b275b0d11217e9d76209d24217edf675a07c88b77f369ed45c4a53",
  "juggling-touch-catch-reset": "20ec43d6d1b94962e23004e92be79a120787106a4d1e4e847df79642fc52fe27",
  "juggling-ladder-3-5-7": "2ab7796ae32165c7711b315fd599e64edb36e06552fce66aca9e2d1cf013ed6b",
  "juggling-knee-touch-march": "1498040a22633047d785b4794e9f62e9cad59fb30c1c32a26c2ce5a5dfcfc275",
  "juggling-hop-and-freeze": "754a5b309c6a10ea6232b5e42f6e356953b413661977112c59349dd4da27d728",
  "juggling-step-compass": "7241cd81dee22c7ed2f4004ddba87bc67b920c2ad60ea162093183997079e378",
  "juggling-alternating-feet": "653ca0b034b626c2ae34b1a8db347c56aaebbafdb3e46b2326310e65318c047e",
  "juggling-thigh-and-foot": "0054d5a632d052dc4e1d210ca951534d9c195f5989ee6522767fcb5f88725e47",
  "passing-ready-shape": "f5940cfceaf2c69d295d031f2d3206154228cbad3b15beb7cea57355438ed6a1",
  "passing-foot-to-foot": "3bb68bd8227d62101cded2c1a22df0f4c7a238413ed5f63b782ec32ec535d8ff",
  "passing-roll-and-stop": "8551675ab927c532703e7946ceb2fabbc7cb3062094c28bfc86b0a42f8f25c50",
  "passing-wall-inside-foot": "d2c214d1dcff60d5116defebe288cb81583860c00658ba8daf014f6640ba2495",
  "passing-pass-walk-stop": "69ceebc75d4b31e0b55ce665372cc2a2ae8b202a3340f6ed963f272c5f650882",
  "passing-roll-receive-redirect": "163851b90fc5a4ee344ab6de462a0f9a4cbb0bbc9b624d8603b03d0b3e65d29a",
  "passing-wall-first-touch-gate": "9124d961c37e7a9125215ffd82aeed65eff2134f0ee7b9e3634c64cf85fcf04a",
  "passing-wall-alternate-feet": "31437a2b7fa9fda03155be4947dafa30b876b2f0b361608ee5483df971139266",
  "passing-two-touch-self": "89930727e1165646feb11688ba03a2c83b4ed308d952d16b13c7808890ff4ca9",
  "passing-wall-two-touch-tempo": "7cf8959b78214157cbacf8beea8f2a01dfcd1d5e56405828be7c81e8b8fe3926",
  "passing-wall-target": "7e86af2286222b492aee50fcd385f42bc264e7121fdf255155c04ac0860c7f73",
  "passing-partner-pass-and-stop": "c2c3fa779a3c51fde3defd435e578e01d26c3c741772efec6a4f68c99947bcc9",
  "weak-foot-air-swings": "e90c05e3f33dd60af1c00d5708f820acb85173448b45870d4655a73846b025a6",
  "weak-foot-sole-drag": "be349d9eb5f0706472b15666b335e702ac1ba21160b2d75a1b7374677ef20dd2",
  "weak-foot-fifty-touches": "9263db199b3c3f3aacb667f3dc005d5fce1a852b70a053163e9120a2c124085c",
  "weak-foot-roll-and-stop": "4376638de7d8688159896167de74770650462ed425a8c419107a17c07c2a1478",
  "weak-foot-wall-taps": "99112668d302e9a9948a78b6c16b2166fff33423ddc60e4ef466b431d828b91e",
  "weak-foot-inside-outside-walk": "0b6912e3c214f93edfb6cb922aa990877b88fd8fc53550d14a114ed06f24e5ac",
  "weak-foot-wall-ladder": "f3b4820460f8393464843305c4663d2b936492852ecd5080344bc91e5a00256e",
  "weak-foot-circle-dribble": "68a5758ae16515f24615918df229da481d9d1824936229d670fc6cf20faf5487",
  "weak-foot-wall-return-stop": "b6204ae4dd8ae050842994b998659b805e912fab10aef76074e7b64c505ce7f0",
  "weak-foot-receive-and-exit": "1eabde347376e585577207f458f541d31da385c987cec18d3154ce5de8067c27",
  "weak-foot-partner-pass-and-stop": "42a7c9eef48b524746e4ec85808e3e4adacc760d245352ecbaa1bac9808cb18a",
  "weak-foot-jog-and-switch": "deb7d61b3f322192ebdece350d125c16433a43545b5e3a0de9ff212f2e377046",
};

// passing-two-touch-self: pinned before the change.
const TWO_TOUCH_STEP_COUNT = 5;
const TWO_TOUCH_STEPS_2_TO_N_HASH: Record<Locale, string> = {
  kk: "c2435f5433406d37e50a4bf19c0611df5d2652e68e6eaf556d40a2f1b3d77bdf",
  ru: "703e1bf14e33e6065b28adb7de724c5cfb32cbe29e8f9b4fa1ab7693930e92a4",
  en: "4dcaf1eeba4604691443945c95b66c6da9ffd8413211128278d86f20774e533c",
};
// Every digit of the five steps, sorted: 3 x 3 metres (3, 3), the steps 1..5, "45 seconds" (4, 5).
const TWO_TOUCH_DIGITS = "123334455";

describe("seed copy: only the intended text moved", () => {
  test("all 60 drills are present and pinned", () => {
    expect(drills).toHaveLength(60);
    expect(Object.keys(PINNED_HASH).sort()).toEqual(drills.map((d) => d.slug).sort());
  });

  test("every field of every drill is byte-identical to the pre-change seed, except the two named texts", () => {
    for (const d of drills) {
      let compared: Record<string, unknown> = d;
      if (d.slug === WEAK_PARTNER) {
        const { title: _title, ...rest } = d;
        compared = rest;
      } else if (d.slug === TWO_TOUCH) {
        const { title: _title, instructions: _instructions, ...rest } = d;
        compared = rest;
      }
      expect(sha256(canonical(compared)), `${d.slug}: a field other than the intended text changed`).toBe(PINNED_HASH[d.slug]);
    }
  });

  test("passing-partner-pass-and-stop keeps its title, so only the weak-foot drill was retitled", () => {
    expect(drill(PASSING_PARTNER).title).toEqual({
      kk: "Досыңмен пас беріп тоқтату",
      ru: "Пас и остановка с другом",
      en: "Pass and stop with a friend",
    });
  });
});

describe("seed copy: the two partner pass-and-stop drills have distinct titles", () => {
  for (const locale of LOCALES) {
    test(`the titles differ in ${locale}`, () => {
      expect(drill(WEAK_PARTNER).title[locale]).not.toBe(drill(PASSING_PARTNER).title[locale]);
    });
    test(`the titles differ in ${locale} by more than punctuation, case and spacing`, () => {
      const weak = normalise(drill(WEAK_PARTNER).title[locale]);
      const passing = normalise(drill(PASSING_PARTNER).title[locale]);
      expect(weak.length, "normalised weak-foot title is not empty").toBeGreaterThan(0);
      expect(weak).not.toBe(passing);
    });
  }

  test("the weak-foot title names the weaker foot in each locale, with the track's own wording", () => {
    const weak = drill(WEAK_PARTNER).title;
    expect(weak.kk).toMatch(/әлсіз аяқ/i);
    expect(weak.ru).toMatch(/слабой ногой/i);
    expect(weak.en).toMatch(/weaker-foot/i);
  });

  test("the passing-track title does not name the weaker foot", () => {
    const passing = drill(PASSING_PARTNER).title;
    expect(passing.kk).not.toMatch(/әлсіз/i);
    expect(passing.ru).not.toMatch(/слаб/i);
    expect(passing.en).not.toMatch(/weak/i);
  });
});

describe("seed copy: all 60 titles are unique per locale", () => {
  for (const locale of LOCALES) {
    test(`no two ${locale} titles are equal, even ignoring case, spacing and punctuation`, () => {
      const seen = new Map<string, string>();
      for (const d of drills) {
        const key = normalise(d.title[locale]);
        expect(seen.get(key), `${d.slug} (${locale}) repeats the title of ${seen.get(key)}`).toBeUndefined();
        seen.set(key, d.slug);
      }
      expect(seen.size).toBe(60);
    });
  }
});

describe("seed copy: passing-two-touch-self step 1 stands on its own", () => {
  const OLD_REFERENCE: Record<Locale, RegExp> = { en: /easier/i, ru: /лёгк/i, kk: /жеңіл/i };
  for (const locale of LOCALES) {
    test(`step 1 (${locale}) no longer refers to easier drills`, () => {
      expect(steps(TWO_TOUCH, locale)[0]).not.toMatch(OLD_REFERENCE[locale]);
    });
    test(`no step (${locale}) refers to easier drills`, () => {
      expect(drill(TWO_TOUCH).instructions[locale]).not.toMatch(OLD_REFERENCE[locale]);
    });
    test(`step 1 (${locale}) is still step 1 and keeps the 3 x 3 space and the two-step roll`, () => {
      const [first] = steps(TWO_TOUCH, locale);
      expect(first).toStartWith("1. ");
      expect(digitsOf(first ?? "")).toBe("133");
    });
    test(`steps 2..n (${locale}) are unchanged`, () => {
      expect(sha256(steps(TWO_TOUCH, locale).slice(1).join("\n"))).toBe(TWO_TOUCH_STEPS_2_TO_N_HASH[locale]);
    });
    test(`the step count and step numbers (${locale}) are unchanged`, () => {
      const all = steps(TWO_TOUCH, locale);
      expect(all).toHaveLength(TWO_TOUCH_STEP_COUNT);
      all.forEach((step, index) => expect(step).toStartWith(`${index + 1}. `));
    });
    test(`the digits (${locale}) are unchanged`, () => {
      expect(digitsOf(drill(TWO_TOUCH).instructions[locale])).toBe(TWO_TOUCH_DIGITS);
    });
  }

  test("the digit multiset is the same in kk, ru and en", () => {
    const [kk, ru, en] = LOCALES.map((locale) => digitsOf(drill(TWO_TOUCH).instructions[locale]));
    expect(kk).toBe(en);
    expect(ru).toBe(en);
  });
});

describe("seed copy: the real seed still loads", () => {
  test("loadSeed on a migrated :memory: database inserts all 60 drills", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db, MIGRATIONS_DIR);
      const summary = loadSeed(db, SEED_DIR);
      expect(summary.drills.inserted).toBe(60);
      expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM drills").get()?.n).toBe(60);
    } finally {
      db.close();
    }
  });
});
