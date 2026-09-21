// Seed safety test (fc-mol-f2u.17): the ball_wall drills need soft-ball and road rules, and the
// hop / fast-foot drills need a warm-up cue, in kk, ru AND en.
//
// Scope. Only the SAFETY text of 12 drills may differ from the pre-change seed:
//   - the 9 drills whose equipment is ball_wall (4 in weak-foot.json, 5 in passing-first-touch.json), and
//   - juggling-hop-and-freeze, juggling-drum-roll-feet and passing-partner-pass-and-stop.
// Every other field of every one of the 60 drills, and the whole of the other 48 drills, must stay
// byte-identical to the seed as it was before this change. The test cannot read master from git,
// so the pre-change seed is PINNED as sha256 hashes of the canonical JSON (keys sorted, no
// whitespace) of each drill: REST_HASH has the drill WITHOUT its `safety` field (all 60),
// UNCHANGED_FULL_HASH has the whole drill (the 48 drills that are not in the scope above).
//
// Keyword lists are lower-cased substring / regex matches, one per locale:
//   soft ball or gentle pass : en "soft"        ru "мягк"     kk "жұмсақ"
//       ("мягк" also matches "мягко" = gently, which the criteria accept: "soft ball OR gentle passes").
//   road                     : en "road"        ru "дорог"    kk "жол" as a WORD (see KK_ROAD)
//   car                      : en "car"         ru "машин"    kk "көлік"
//   street                   : en "street"      ru "улиц"     kk "көше"
//       All three of road, car and street are required: the criteria say "roads, cars and streets",
//       and in kk "жол" alone is not enough evidence, because it is also the stem of "жолынан"
//       ("out of the line of the ball") which an existing safety note already contains.
//   warm-up                  : en "warm up" / "warm-up"   ru "разомн" / "размин"
//                              kk "жылын" (warm up, as in the file's own "Алдымен жылын") or "қыздыр"
//                              (heat up, as in "денеңді қыздыр")
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate";
import { loadSeed } from "../../src/commons/seed-loader";
import { SeedDrillTrackFile } from "../../src/commons/seed-schema";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SEED_DIR = join(ROOT, "config", "commons");
const DRILLS_DIR = join(SEED_DIR, "football", "drills");
const LOCALES = ["kk", "ru", "en"] as const;
type Locale = (typeof LOCALES)[number];

const BALL_WALL_DRILLS = [
  "weak-foot-wall-taps",
  "weak-foot-wall-ladder",
  "weak-foot-wall-return-stop",
  "weak-foot-receive-and-exit",
  "passing-wall-inside-foot",
  "passing-wall-first-touch-gate",
  "passing-wall-alternate-feet",
  "passing-wall-two-touch-tempo",
  "passing-wall-target",
];
const WARM_UP_DRILLS = ["juggling-hop-and-freeze", "juggling-drum-roll-feet", "passing-partner-pass-and-stop"];
const CHANGED_DRILLS = [...BALL_WALL_DRILLS, ...WARM_UP_DRILLS];

// Case-insensitive on the lower-cased text. kk road: "жол" as a whole word, alone or as the
// plural / a case form ("жол", "жолдар", "жолдардан", "жолда", "жолдан", "жолға"), never "жолынан".
const KK_ROAD = /жол(?:дар\p{L}*|да|дан|ға)?(?![\p{L}])/u;
const SOFT: Record<Locale, RegExp> = { en: /soft/, ru: /мягк/, kk: /жұмсақ/ };
const ROAD: Record<Locale, RegExp> = { en: /road/, ru: /дорог/, kk: KK_ROAD };
const CAR: Record<Locale, RegExp> = { en: /\bcars?\b/, ru: /машин/, kk: /көлік/ };
const STREET: Record<Locale, RegExp> = { en: /street/, ru: /улиц/, kk: /көше/ };
const WARM_UP: Record<Locale, RegExp> = { en: /warm[ -]up/, ru: /разомн|размин/, kk: /жылын|қыздыр/ };

type RawDrill = Record<string, unknown> & { slug: string; equipment: string; safety?: Record<Locale, string>[] };

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

const files = readdirSync(DRILLS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const rawFiles = files.map((name) => ({ name, raw: JSON.parse(readFileSync(join(DRILLS_DIR, name), "utf8")) as { drills: RawDrill[] } }));
const drills: RawDrill[] = rawFiles.flatMap((file) => file.raw.drills);
const bySlug = new Map(drills.map((drill) => [drill.slug, drill]));
const safetyText = (slug: string, locale: Locale): string =>
  (bySlug.get(slug)?.safety ?? []).map((note) => note[locale]).join("\n").toLowerCase();

// Pinned from the seed BEFORE this change (generated once by a scratch script, not by this test).
const REST_HASH: Record<string, string> = {
  "ball-mastery-ghost-ball": "6b5e2d34e2755301e959342b02d10bbd31efb5a0ac4b15ee0040132417d93792",
  "ball-mastery-sole-taps": "ec0c92dd4893b58fe5c48d82aff48c533f69667a9a32d86f7041f8868b9a8641",
  "ball-mastery-sole-rolls": "c364cbebbe5658fc8bba77ae5a925a33370386d91df827bdcaaec5cb338a211c",
  "ball-mastery-foundation-touches": "6542523c9339f5aaeaff6be176c07821c8e7626b0edc6d4820d709a131f7ce7b",
  "ball-mastery-clock-taps": "01d32f290ac107ee453c85276137ace067f663fab026e6bab386b85f969c67c5",
  "ball-mastery-inside-ping-pong": "f178cc6e2726b268ade9b761d1404d800bea979e5d2efad2c9b6bb96ad8e346a",
  "ball-mastery-sole-pull-push": "6730bb7504b65f06a944776ce9bd2b2461750b7696fd8a615e36a21636235c7b",
  "ball-mastery-inside-outside-rhythm": "122238e258778c1c82a5d1afbf597793e04817d990f63ca7f990817dda194c35",
  "ball-mastery-figure-eight": "e0a085fc8eeb67ec73767d8a3b701b584d926cce6b5dc6886b41727b901792c1",
  "ball-mastery-turn-and-go": "3e7f522597e0ee484f1839ced63d4277caa588b3fb20685faffef1cbfc46be13",
  "ball-mastery-slow-fast-stop": "7eb670dc66b862211e23198336eebbaf67eaceb6c599492b79c4e91350a512fc",
  "ball-mastery-look-up-touches": "f8dc2cc8034402fdbfec957678718213d6c44946c69154cb0324f4b65689ee12",
  "dribbling-quick-feet-look-around": "5c8289427fe556bedfb96eb85efebd280bfc9c1444c7c917b46100f829d4c1ac",
  "dribbling-snail-circle": "ce4ce74ceec5c2364c3ae0646649bc36cba3a6f0080ea724d4d4ca19c1d98274",
  "dribbling-there-and-back": "7ac68aa827efe03b94eaa8e1679eb1449ec09e86915d29edc29225860ed94ca0",
  "dribbling-freeze-and-go": "d7342664f2c13a93077ea73443f2df42cea6082347bd629fb290df38f0f17401",
  "dribbling-five-cone-slalom": "345153712d98262b4e73c2fb72cb099ba449016be989b6af100d27a5625ba313",
  "dribbling-two-foot-zigzag": "897bff88fcb306333474335b92e52a8f63b6720eab233de0abf32bc329866aa4",
  "dribbling-sole-stop-turn": "40f445f296a926781c293e49cbd1cb6efb866b77418b3739802c8115e0b8c621",
  "dribbling-change-direction-box": "d00ee5bdeed05698bda7c2a05dc25ddb29130b35bae435a01118b39c735faabf",
  "dribbling-look-up-dribble": "cae41ebc38bcc64c8f668fa324e9c23ed1147bc3390b0e35d69aea2cda65bb14",
  "dribbling-partner-finger-signal": "3da443ebe14b84cab46b1e7163cbfb1f5e0843fa3e3cf27bedd63f2d02832d87",
  "dribbling-tight-cone-weave": "8c56fb52594b9f96c46c2e206f54569394d5bd4604e17b98ac9b9d1f7719c1b0",
  "dribbling-speed-dash-stop": "029a6bbb44e2f388770a5698413eb5fbb45f5d08c1b8b59f47e9c09683fb9945",
  "juggling-stork-stand": "1fa5daf34df36fc0d26fe47030e4a6b5ef202cd711b7f3106766a996b3fba385",
  "juggling-drum-roll-feet": "d0f6d47ac6fba07aef9bc2eee1bf9efc7a9a6cf14fd8a443174b6c6934a30592",
  "juggling-drop-bounce-catch": "121220f054b68b7b2303b07a5864f32ad10a536974501e439269019043071e64",
  "juggling-bounce-juggle": "83d79020906bf471c9e010e2084d333176c44b64f14b22112de302c03aadbfa3",
  "juggling-lift-and-catch": "06d31dba1e8895e852a521e80579f95d0208850edf0fea7a13583121f679b948",
  "juggling-touch-catch-reset": "9e442070517f43ab5044a714f6dd37d56c3f3abfd4586c552e9de4396e4af69a",
  "juggling-ladder-3-5-7": "5641743a1bb816bd3e524a32c13de6c853263903be1a99b86d066db88b442a68",
  "juggling-knee-touch-march": "302e623403d92f245a6be289ac544654c1ab5f40352c1f51c5299de9c9080596",
  "juggling-hop-and-freeze": "af13ad173d35a8232a1b3e3c17285781d1b4360091feda818c358bd5b68e1406",
  "juggling-step-compass": "ab271038334f10365150566cca399fe6949f6856b040d40c28be28229e7c495b",
  "juggling-alternating-feet": "829ea89ca04a63f0be3d5b3cc2e4e93c098611ddb36b97abc2f27c25121fafd5",
  "juggling-thigh-and-foot": "cc895d6f622f87fba64c417105f7e43bebff6e44af3fdaf43960907574d526ca",
  "passing-ready-shape": "c4c1a06ef232bd81daf8155a24301810a8f43b4afb9394331ca1c7a69df5723c",
  "passing-foot-to-foot": "d6e87209bfb99bb080c02fcc5a11c9dec3bbdfaa7f8ab9c367f679b83fa443f3",
  "passing-roll-and-stop": "91d6cf84b14adba78081904153f67a571cadec509f8a32a9c85240d53cd9fa65",
  "passing-wall-inside-foot": "a4e0d538a87bdb8640b0fef3cace52da9d8f7ffc7657b93658f9f38e7647aef8",
  "passing-pass-walk-stop": "f0d73dd073216f0f409f854b359b29df373d5a149d74212a54070b33c6f52fec",
  "passing-roll-receive-redirect": "674010dd0ec2320f9358b09bf4b7326bdd1703091a31fd4565d7b1cf77a9e8eb",
  "passing-wall-first-touch-gate": "35e701c10f2636b25c309ac2a38efc8ecaf3dcebe78b2d382f5f42370b42ae48",
  "passing-wall-alternate-feet": "e0ec084c38212a1c498a4f1ba6ac3f863bc3449138971c56ccc64da92a4b1876",
  "passing-two-touch-self": "90aa8e79cc020883cbfcf3e971138afab8bb1f953d861b358b107def8deef8f6",
  "passing-wall-two-touch-tempo": "65b4f73c2c4bc3177803cf9f7a6775493f41c1b296008ca8f07a94afbf5b327f",
  "passing-wall-target": "5bafec001e136f62b907dad4dc388a61d149ec6b2b323732252cc3ec281c71f1",
  "passing-partner-pass-and-stop": "9f5ba1ed40ab8c329d5ca029a331de16656ff3268b5ca02d179e0018cddb9f68",
  "weak-foot-air-swings": "75aec626e02ec7a5c3306b0bf38db4554ecd2dcda6310bc2c7086219f87587ba",
  "weak-foot-sole-drag": "372b379e3d03cd2e33f5c1a7e29a7837325ba49d6c371521bfaa35054d63695a",
  "weak-foot-fifty-touches": "1ffd4bca12af5c97c385475c6759d90c47b72b250c3db7f443bb85bbd2f910e3",
  "weak-foot-roll-and-stop": "a64d92c8ad6d38b4d9c73a1c063b3797e051f84e63f8369dbbcd4901c2334801",
  "weak-foot-wall-taps": "7b5aca1ee42f484ebb46e45e8593ece17ec2471bd805728c2a765fcd113dc29d",
  "weak-foot-inside-outside-walk": "5b2b9d641d685a6b449bef8895da632f2f7457078f82236e00d7849ff80c126c",
  "weak-foot-wall-ladder": "d5d41a9a21209cc0c711bc963d527e139a3a5b567eef15c14670cb1c23f95e45",
  "weak-foot-circle-dribble": "bcf18b281074704273bc6fb8fb96e8b267af297b15affc2239024428dad5c333",
  "weak-foot-wall-return-stop": "024e303e0beda53ad7916dc8daa6eac72388f31c320aebca53bfb1493ccac159",
  "weak-foot-receive-and-exit": "f5223003a2aed562d0f40f861d06ddc3e7831a72c98f7a1ebc0cb68ec144c19d",
  "weak-foot-partner-pass-and-stop": "4c5c0c67803ad35713a95337f6204244764fba040afc3f91ccc4efe815d48891",
  "weak-foot-jog-and-switch": "9023cf204ebd6f62d0d994c804e03201f98d358ad5768b3d50ccb70889da3ae5",
};

const UNCHANGED_FULL_HASH: Record<string, string> = {
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
  "juggling-drop-bounce-catch": "657c9811b2e075a37b7cb3604717cad4f3f78cd91d61ae77584192efd2e648ef",
  "juggling-bounce-juggle": "712a18f43cbf5bfe4fdaae3e7ce2911157f1fba5eebc059e68f2068c9130b08d",
  "juggling-lift-and-catch": "5514fd03d6b275b0d11217e9d76209d24217edf675a07c88b77f369ed45c4a53",
  "juggling-touch-catch-reset": "20ec43d6d1b94962e23004e92be79a120787106a4d1e4e847df79642fc52fe27",
  "juggling-ladder-3-5-7": "2ab7796ae32165c7711b315fd599e64edb36e06552fce66aca9e2d1cf013ed6b",
  "juggling-knee-touch-march": "1498040a22633047d785b4794e9f62e9cad59fb30c1c32a26c2ce5a5dfcfc275",
  "juggling-step-compass": "7241cd81dee22c7ed2f4004ddba87bc67b920c2ad60ea162093183997079e378",
  "juggling-alternating-feet": "653ca0b034b626c2ae34b1a8db347c56aaebbafdb3e46b2326310e65318c047e",
  "juggling-thigh-and-foot": "0054d5a632d052dc4e1d210ca951534d9c195f5989ee6522767fcb5f88725e47",
  "passing-ready-shape": "f5940cfceaf2c69d295d031f2d3206154228cbad3b15beb7cea57355438ed6a1",
  "passing-foot-to-foot": "3bb68bd8227d62101cded2c1a22df0f4c7a238413ed5f63b782ec32ec535d8ff",
  "passing-roll-and-stop": "8551675ab927c532703e7946ceb2fabbc7cb3062094c28bfc86b0a42f8f25c50",
  "passing-pass-walk-stop": "69ceebc75d4b31e0b55ce665372cc2a2ae8b202a3340f6ed963f272c5f650882",
  "passing-roll-receive-redirect": "163851b90fc5a4ee344ab6de462a0f9a4cbb0bbc9b624d8603b03d0b3e65d29a",
  "passing-two-touch-self": "77a1b1b32b384f93d435b68b01a29dfb81fcbe16181c02387dbdbee7f2bb66c7",
  "weak-foot-air-swings": "e90c05e3f33dd60af1c00d5708f820acb85173448b45870d4655a73846b025a6",
  "weak-foot-sole-drag": "be349d9eb5f0706472b15666b335e702ac1ba21160b2d75a1b7374677ef20dd2",
  "weak-foot-fifty-touches": "9263db199b3c3f3aacb667f3dc005d5fce1a852b70a053163e9120a2c124085c",
  "weak-foot-roll-and-stop": "4376638de7d8688159896167de74770650462ed425a8c419107a17c07c2a1478",
  "weak-foot-inside-outside-walk": "0b6912e3c214f93edfb6cb922aa990877b88fd8fc53550d14a114ed06f24e5ac",
  "weak-foot-circle-dribble": "68a5758ae16515f24615918df229da481d9d1824936229d670fc6cf20faf5487",
  "weak-foot-partner-pass-and-stop": "16248eaab7ee16c61ab3cf2975ac7fab842a67dd11508815e06b488548570238",
  "weak-foot-jog-and-switch": "deb7d61b3f322192ebdece350d125c16433a43545b5e3a0de9ff212f2e377046",
};

describe("seed safety: the pre-change seed is pinned", () => {
  test("all 60 drills of the 5 football tracks are present, pass the seed schema and are pinned", () => {
    expect(files).toHaveLength(5);
    expect(drills).toHaveLength(60);
    for (const { name, raw } of rawFiles) {
      const parsed = SeedDrillTrackFile.safeParse(raw);
      expect(parsed.success, `${name} passes the seed schema`).toBe(true);
    }
    expect(Object.keys(REST_HASH).sort()).toEqual(drills.map((drill) => drill.slug).sort());
    expect(Object.keys(UNCHANGED_FULL_HASH)).toHaveLength(48);
    for (const slug of CHANGED_DRILLS) expect(UNCHANGED_FULL_HASH[slug], `${slug} is one of the 12 changed drills`).toBeUndefined();
  });

  test("the ball_wall drills are exactly the 9 named ones", () => {
    const ballWall = drills.filter((drill) => drill.equipment === "ball_wall").map((drill) => drill.slug);
    expect(ballWall.sort()).toEqual([...BALL_WALL_DRILLS].sort());
  });

  test("every field except safety is byte-identical to the pre-change seed, for all 60 drills", () => {
    for (const drill of drills) {
      const { safety: _safety, ...rest } = drill;
      expect(sha256(canonical(rest)), `${drill.slug}: a field other than safety changed`).toBe(REST_HASH[drill.slug]);
    }
  });

  test("the 48 drills outside the 12 are byte-identical including safety", () => {
    for (const [slug, hash] of Object.entries(UNCHANGED_FULL_HASH)) {
      const drill = bySlug.get(slug);
      expect(drill, `${slug} exists`).toBeDefined();
      expect(sha256(canonical(drill)), `${slug} changed`).toBe(hash);
    }
  });
});

describe("seed safety: ball_wall drills need a soft ball and a road rule in kk, ru and en", () => {
  for (const slug of BALL_WALL_DRILLS) {
    for (const locale of LOCALES) {
      test(`${slug} (${locale}) asks for a soft ball or gentle passes`, () => {
        expect(safetyText(slug, locale)).toMatch(SOFT[locale]);
      });
      test(`${slug} (${locale}) says to keep away from roads, cars and streets`, () => {
        const text = safetyText(slug, locale);
        expect(text, "road").toMatch(ROAD[locale]);
        expect(text, "car").toMatch(CAR[locale]);
        expect(text, "street").toMatch(STREET[locale]);
      });
    }
  }
});

describe("seed safety: hop and fast-foot drills carry a warm-up cue in kk, ru and en", () => {
  for (const slug of WARM_UP_DRILLS) {
    for (const locale of LOCALES) {
      test(`${slug} (${locale}) has a warm-up cue`, () => {
        expect(safetyText(slug, locale)).toMatch(WARM_UP[locale]);
      });
    }
  }
});

describe("seed safety: the real seed still loads", () => {
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
