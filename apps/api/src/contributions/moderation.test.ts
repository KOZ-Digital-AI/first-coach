import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { getDrill, listDrills, listPublishedVersions } from "../commons/repo";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { DecisionResponse } from "../shared/admin";
import type { DecisionRequest } from "../shared/admin";
import type { Contribution, ContributionPayloadRequest } from "../shared/contributions";
import { DrillContent } from "../shared/primitives";
import { decide, DrillNotFoundError, IllegalTransitionError, ModerationRefusedError, setStatus, unpublish } from "./moderation";
import { ContributionNotFoundError, createContribution, getForOwner, updateForResubmit } from "./repo";
import type { NewAttachment } from "./repo";

// Every test runs on a fresh in-memory database migrated with the real migrations (STRICT tables,
// CHECKs, FKs, the immutability trigger) and loaded with the REAL seed. Contributions are created
// through the merged repo (createContribution), never inserted by hand.

const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");

const ALICE = "user-alice";
const ADMIN = { id: "admin-1", name: "Admin Aidar" };
// The seed is stamped with the clock the loader is given (default: the real now). It is pinned BEFORE
// every test time below, so the seed's versions are always the oldest and "history, newest first" does
// not depend on the day the suite runs.
const T_SEED = new Date("2026-01-01T00:00:00.000Z");
const T_CREATED = new Date("2026-03-01T10:00:00.000Z");
const T_DECIDE = new Date("2026-04-01T09:00:00.000Z");
const opts = { now: () => T_DECIDE };

const DRILL_SLUG = "ball-mastery-sole-rolls";
const OLD_VERSION_ID = `${DRILL_SLUG}-v1.0.0`;

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR, { now: () => T_SEED });
});

afterEach(() => {
  db.close();
});

// --- fixtures ------------------------------------------------------------------------------

const newPayload = (over: Partial<ContributionPayloadRequest> = {}): ContributionPayloadRequest => ({
  kind: "new",
  locale: "ru",
  name: "Wall passes",
  sport: "football",
  skill: "alternating-touches",
  ageMin: 8,
  ageMax: 12,
  level: "beginner",
  goal: "control",
  instructions: "Pass the ball against the wall.\nTake it with the inside of the foot.",
  durationMin: 10,
  equipment: "ball_wall",
  mistakes: "Passing too hard\nLooking only at the ball",
  progression: "Use only the weaker foot",
  regression: "Stand closer to the wall",
  safety: "Keep away from windows",
  source: "My own training notes",
  sourceUrl: "https://example.com/wall",
  author: "Coach Aidos",
  rightsAttested: true,
  noCommercialContent: true,
  ...over,
});

const improvementPayload = (over: Partial<ContributionPayloadRequest> = {}): ContributionPayloadRequest =>
  newPayload({
    kind: "improvement",
    targetDrillSlug: DRILL_SLUG,
    improvementKind: "safety",
    name: "Перекаты подошвой",
    instructions: "Катай мяч подошвой вперёд.\nПотом назад.",
    mistakes: "Слишком сильно давить на мяч",
    progression: "",
    regression: "",
    safety: "Носи удобную обувь",
    author: "Coach Bota",
    source: "Bota's notes",
    sourceUrl: "https://example.com/bota",
    ...over,
  });

const attachment = (n: number): NewAttachment => ({
  kind: n === 1 ? "video" : "image",
  storedPath: `2026/03/file-${n}.bin`,
  mime: n === 1 ? "video/mp4" : "image/png",
  bytes: 1000 * n,
  originalName: `original-${n}.bin`,
});

const submit = (payload: ContributionPayloadRequest = newPayload(), attachments?: NewAttachment[], userId = ALICE): Contribution =>
  createContribution(db, { userId, payload, ...(attachments === undefined ? {} : { attachments }), now: T_CREATED });

const approve = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ action: "approve", ...over });

interface VersionRow {
  id: string;
  drill_id: string;
  semver: string;
  parent_version_id: string | null;
  status: string;
  content: string;
  equipment: string;
  space: string;
  partner: number;
  age_min: number | null;
  age_max: number | null;
  level: string;
  minutes: number;
  license: string;
  author_name: string;
  author_user_id: string | null;
  source: string;
  source_url: string | null;
  origin: string;
  change_summary: string | null;
  created_at: string;
}

interface ReviewRow {
  id: number;
  drill_version_id: string;
  reviewer: string;
  reviewer_user_id: string | null;
  org_label: string;
  from_status: string;
  to_status: string;
  note: string;
  reviewed_at: string;
}

const all = (sql: string, ...params: string[]): unknown[] => db.query(sql).all(...params);
const one = <T>(sql: string, ...params: string[]): T => db.query(sql).get(...params) as T;
const count = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
const drillRow = (slug: string) =>
  one<{ id: string; current_version_id: string | null; unpublished_at: string | null; sport_id: string }>(
    "SELECT * FROM drills WHERE slug = ?",
    slug,
  );
const versionsOf = (slug: string): VersionRow[] =>
  all("SELECT v.* FROM drill_versions v JOIN drills d ON d.id = v.drill_id WHERE d.slug = ? ORDER BY v.rowid", slug) as VersionRow[];
const versionRow = (id: string): VersionRow => one<VersionRow>("SELECT * FROM drill_versions WHERE id = ?", id);
const contentOf = (row: VersionRow): DrillContent => JSON.parse(row.content) as DrillContent;
const reviewsOf = (versionId: string): ReviewRow[] =>
  all("SELECT * FROM reviews WHERE drill_version_id = ? ORDER BY id", versionId) as ReviewRow[];
const contributionRow = (id: string) => one<Record<string, unknown>>("SELECT * FROM contributions WHERE id = ?", id);

/** Every table a decision may touch, whole: an unchanged snapshot proves NO row changed. */
const snapshot = () => ({
  drills: all("SELECT * FROM drills ORDER BY id"),
  versions: all("SELECT * FROM drill_versions ORDER BY id"),
  reviews: all("SELECT * FROM reviews ORDER BY id"),
  drillSkills: all("SELECT * FROM drill_skills ORDER BY drill_id, skill_id"),
  contributions: all("SELECT * FROM contributions ORDER BY id"),
  attachments: all("SELECT * FROM contribution_attachments ORDER BY id"),
});

/** Approves a new contribution and returns its drill slug. */
const approveNew = (payload: ContributionPayloadRequest = newPayload(), over: Partial<DecisionRequest> = {}): string => {
  const result = decide(db, ADMIN, submit(payload).id, approve(over), opts);
  return result.drill!.slug;
};

// --- approve: a new drill ------------------------------------------------------------------

describe("decide approve, kind new", () => {
  test("creates a published drill with version 1.0.0 (COMMUNITY by default) and marks the contribution approved", () => {
    const contribution = submit();
    const result = decide(db, ADMIN, contribution.id, approve(), opts);

    expect(DecisionResponse.safeParse(result).success).toBe(true);
    const slug = result.drill!.slug;
    expect(result.contribution.state).toBe("approved");
    expect(result.contribution.resultingDrillSlug).toBe(slug);
    expect(result.drill!.attribution.semver).toBe("1.0.0");
    expect(result.drill!.versionId).toBe(`${slug}-v1.0.0`);

    const drill = drillRow(slug);
    expect(drill.current_version_id).toBe(`${slug}-v1.0.0`);
    expect(drill.unpublished_at).toBeNull();
    const versions = versionsOf(slug);
    expect(versions).toHaveLength(1);
    const [v] = versions;
    expect(v!.semver).toBe("1.0.0");
    expect(v!.parent_version_id).toBeNull();
    expect(v!.status).toBe("COMMUNITY");
    expect(v!.origin).toBe("contribution");
    expect(v!.license).toBe("CC-BY-SA-4.0");
    expect(v!.created_at).toBe(T_DECIDE.toISOString());

    const row = contributionRow(contribution.id);
    expect(row.state).toBe("approved");
    expect(row.resulting_drill_id).toBe(drill.id);
    expect(row.updated_at).toBe(T_DECIDE.toISOString());
  });

  test("the drill shows up for the planner (listPublishedVersions) and the library (listDrills)", () => {
    const slug = approveNew();
    const published = listPublishedVersions(db, { sport: "football" }).find((p) => p.slug === slug);
    expect(published).toBeDefined();
    expect(published!.status).toBe("COMMUNITY");
    expect(published!.track).toBe("alternating-touches");
    expect(published!.level).toBe("beginner");
    expect(published!.minutes).toBe(10);
    expect(published!.equipment).toBe("ball_wall");
    expect(listDrills(db, {}, "ru").items.some((item) => item.slug === slug)).toBe(true);
  });

  test("the contributor is the author: name and user id, source and CC BY-SA 4.0 come from the payload and the attestation", () => {
    const slug = approveNew();
    const v = versionsOf(slug)[0]!;
    expect(v.author_name).toBe("Coach Aidos");
    expect(v.author_user_id).toBe(ALICE);
    expect(v.source).toBe("My own training notes");
    expect(v.source_url).toBe("https://example.com/wall");
    expect(v.license).toBe("CC-BY-SA-4.0");
    expect(v.age_min).toBe(8);
    expect(v.age_max).toBe(12);
    expect(v.level).toBe("beginner");
    expect(v.minutes).toBe(10);
    expect(v.equipment).toBe("ball_wall");
  });

  test("the payload's locale text is stored under that locale ONLY (nothing copied to kk or en)", () => {
    const slug = approveNew(newPayload({ locale: "ru" }));
    const content = contentOf(versionsOf(slug)[0]!);
    expect(content.title).toEqual({ ru: "Wall passes" });
    expect(content.instructions).toEqual({ ru: "1. Pass the ball against the wall.\n2. Take it with the inside of the foot." });
    expect(content.mistakes).toEqual([{ ru: "Passing too hard" }, { ru: "Looking only at the ball" }]);
    expect(content.progressions).toEqual([{ ru: "Use only the weaker foot" }]);
    expect(content.regressions).toEqual([{ ru: "Stand closer to the wall" }]);
    expect(content.safety).toEqual([{ ru: "Keep away from windows" }]);
    expect(Object.keys(content.goal)).toEqual(["ru"]);
    expect(JSON.stringify(content)).not.toContain('"kk"');
    expect(JSON.stringify(content)).not.toContain('"en"');
  });

  test("a kk contribution is stored under kk only and is a valid DrillContent", () => {
    const slug = approveNew(newPayload({ locale: "kk", name: "Қабырғаға пас" }));
    const content = contentOf(versionsOf(slug)[0]!);
    expect(content.title).toEqual({ kk: "Қабырғаға пас" });
    expect(Object.keys(content.instructions)).toEqual(["kk"]);
    expect(DrillContent.safeParse(content).success).toBe(true);
  });

  test("instructions become numbered lines: existing numbering is normalised, blank lines dropped", () => {
    const slug = approveNew(newPayload({ instructions: "1) First step\n\n  2. Second step  \nThird step\r\n" }));
    expect(contentOf(versionsOf(slug)[0]!).instructions).toEqual({ ru: "1. First step\n2. Second step\n3. Third step" });
  });

  test("blank list fields produce empty lists; the content, conditions and dose are valid", () => {
    const slug = approveNew(newPayload({ mistakes: "", progression: "  ", regression: "\n", safety: "" }));
    const content = contentOf(versionsOf(slug)[0]!);
    expect(content.mistakes).toEqual([]);
    expect(content.progressions).toEqual([]);
    expect(content.regressions).toEqual([]);
    expect(content.safety).toEqual([]);
    expect(content.conditions).toMatchObject({ equipment: "ball_wall", ageMin: 8, ageMax: 12, partner: false });
    expect(content.conditions.spaces).toHaveLength(1);
    expect(content.dose).toEqual({ durationSec: 600 });
    expect(versionsOf(slug)[0]!.space).toBe(content.conditions.spaces[0]!);
  });

  test("links the drill to the payload's sport and to its skill as the primary skill", () => {
    const slug = approveNew();
    const links = all(
      `SELECT s.slug AS skill, ds.is_primary AS is_primary FROM drill_skills ds
         JOIN skills s ON s.id = ds.skill_id JOIN drills d ON d.id = ds.drill_id WHERE d.slug = ?`,
      slug,
    );
    expect(links).toEqual([{ skill: "alternating-touches", is_primary: 1 }]);
    expect(one<{ slug: string }>("SELECT sp.slug FROM drills d JOIN sports sp ON sp.id = d.sport_id WHERE d.slug = ?", slug).slug).toBe("football");
  });

  test("attachments become the version's media (kind + /uploads url), in upload order", () => {
    const slug = approveNew(undefined, {});
    expect(contentOf(versionsOf(slug)[0]!).media).toEqual([]);

    const contribution = submit(newPayload({ name: "With media" }), [attachment(1), attachment(2)]);
    const result = decide(db, ADMIN, contribution.id, approve(), opts);
    const media = contentOf(versionsOf(result.drill!.slug)[0]!).media;
    expect(media).toEqual([
      { kind: "video", url: "/uploads/2026/03/file-1.bin" },
      { kind: "image", url: "/uploads/2026/03/file-2.bin" },
    ]);
    // the contribution keeps its attachment rows
    expect(count("contribution_attachments")).toBe(2);
  });

  test("writes a reviews row: reviewer, reviewer id, from/to status, orgLabel, note", () => {
    const contribution = submit();
    const result = decide(db, ADMIN, contribution.id, approve({ note: "Looks good", orgLabel: "  Aktobe Academy " }), opts);
    const reviews = reviewsOf(result.drill!.versionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      reviewer: "Admin Aidar",
      reviewer_user_id: "admin-1",
      org_label: "Aktobe Academy",
      from_status: "COMMUNITY",
      to_status: "COMMUNITY",
      note: "Looks good",
      reviewed_at: T_DECIDE.toISOString(),
    });
    expect(result.drill!.reviews[0]).toMatchObject({ reviewer: "Admin Aidar", to: "COMMUNITY", note: "Looks good" });
    expect(result.contribution.reviewerNote).toBe("Looks good");
  });

  test("an approve without a note still writes a reviews row (empty note) and leaves no reviewer note", () => {
    const result = decide(db, ADMIN, submit().id, approve(), opts);
    expect(reviewsOf(result.drill!.versionId)).toHaveLength(1);
    expect(reviewsOf(result.drill!.versionId)[0]!.note).toBe("");
    expect(result.contribution.reviewerNote).toBeUndefined();
  });

  test("the reviewer falls back to the admin id when the admin has no name", () => {
    const result = decide(db, { id: "admin-7" }, submit().id, approve(), opts);
    expect(reviewsOf(result.drill!.versionId)[0]).toMatchObject({ reviewer: "admin-7", reviewer_user_id: "admin-7" });
  });

  test("a decision status is the version's status and the reviews row's to_status", () => {
    const result = decide(db, ADMIN, submit().id, approve({ status: "EXPERT_VERIFIED", note: "Verified by the federation" }), opts);
    expect(versionRow(result.drill!.versionId).status).toBe("EXPERT_VERIFIED");
    expect(reviewsOf(result.drill!.versionId)[0]).toMatchObject({ from_status: "COMMUNITY", to_status: "EXPERT_VERIFIED" });
    expect(listPublishedVersions(db, { minStatus: "EXPERT_VERIFIED" }).some((p) => p.slug === result.drill!.slug)).toBe(true);
  });

  test("REVIEWED needs no note; a VERIFIED status needs one; ACADEMY_VERIFIED also needs an orgLabel", () => {
    const reviewed = decide(db, ADMIN, submit().id, approve({ status: "REVIEWED" }), opts);
    expect(versionRow(reviewed.drill!.versionId).status).toBe("REVIEWED");

    const noNote = submit(newPayload({ name: "Second" }));
    const afterSubmit = snapshot();
    expect(() => decide(db, ADMIN, noNote.id, approve({ status: "EXPERT_VERIFIED", note: "  " }), opts)).toThrow(ModerationRefusedError);
    expect(() => decide(db, ADMIN, noNote.id, approve({ status: "ACADEMY_VERIFIED", note: "ok" }), opts)).toThrow(ModerationRefusedError);
    try {
      decide(db, ADMIN, noNote.id, approve({ status: "ACADEMY_VERIFIED", note: "ok" }), opts);
    } catch (error) {
      expect((error as ModerationRefusedError).reason).toBe("org_label_required");
    }
    expect(snapshot()).toEqual(afterSubmit);

    const ok = decide(db, ADMIN, noNote.id, approve({ status: "ACADEMY_VERIFIED", note: "ok", orgLabel: "FC Academy" }), opts);
    expect(versionRow(ok.drill!.versionId).status).toBe("ACADEMY_VERIFIED");
    expect(reviewsOf(ok.drill!.versionId)[0]!.org_label).toBe("FC Academy");
  });

  test("two approvals with the same name get distinct valid slugs; a Cyrillic name still gets a valid slug", () => {
    const a = approveNew(newPayload({ name: "Wall passes" }));
    const b = approveNew(newPayload({ name: "Wall passes" }));
    const c = approveNew(newPayload({ name: "Пас в стену" }));
    expect(new Set([a, b, c]).size).toBe(3);
    for (const slug of [a, b, c]) expect(slug).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
    expect(drillRow(a).id).toBeDefined();
  });

  test("a new-drill decision never picks an existing drill's slug", () => {
    const slug = approveNew(newPayload({ name: "Ball mastery sole rolls" }));
    expect(slug).not.toBe(DRILL_SLUG);
    expect(versionsOf(DRILL_SLUG)).toHaveLength(1);
  });
});

// --- author preserved, admin edits ---------------------------------------------------------

describe("admin edits", () => {
  test("the edits are applied to the published content", () => {
    const slug = approveNew(newPayload(), {
      edits: { name: "Wall passes (fixed)", durationMin: 15, ageMax: 14, level: "basic", instructions: "Pass.\nCatch.", safety: "Wear shoes" },
    });
    const v = versionsOf(slug)[0]!;
    const content = contentOf(v);
    expect(content.title).toEqual({ ru: "Wall passes (fixed)" });
    expect(content.instructions).toEqual({ ru: "1. Pass.\n2. Catch." });
    expect(content.safety).toEqual([{ ru: "Wear shoes" }]);
    expect(v.minutes).toBe(15);
    expect(v.age_max).toBe(14);
    expect(content.conditions.ageMax).toBe(14);
    expect(v.level).toBe("basic");
  });

  test("the contributor stays author_name / author_user_id even when the admin edits the author field", () => {
    const contribution = submit();
    const result = decide(db, ADMIN, contribution.id, approve({ edits: { author: "Admin Aidar", name: "Renamed" } }), opts);
    const v = versionRow(result.drill!.versionId);
    expect(v.author_name).toBe("Coach Aidos");
    expect(v.author_user_id).toBe(ALICE);
    expect(result.drill!.attribution.author).toBe("Coach Aidos");
    expect(contentOf(v).title).toEqual({ ru: "Renamed" });
  });

  test("an improvement keeps the improver as the author too, and the old version keeps its own author", () => {
    const before = versionRow(OLD_VERSION_ID);
    const result = decide(db, ADMIN, submit(improvementPayload()).id, approve({ edits: { author: "Someone Else" } }), opts);
    const v = versionRow(result.drill!.versionId);
    expect(v.author_name).toBe("Coach Bota");
    expect(v.author_user_id).toBe(ALICE);
    expect(versionRow(OLD_VERSION_ID)).toEqual(before);
  });

  test("the contribution keeps what was published: edited fields updated, author and attestations as submitted", () => {
    const contribution = submit();
    const result = decide(db, ADMIN, contribution.id, approve({ edits: { name: "Renamed", author: "Nope" } }), opts);
    expect(result.contribution.payload.name).toBe("Renamed");
    expect(result.contribution.payload.author).toBe("Coach Aidos");
    expect(getForOwner(db, ALICE, contribution.id)!.payload.name).toBe("Renamed");
  });

  test("edits cannot turn a new contribution into an improvement, retarget it, or change its locale", () => {
    const slug = approveNew(newPayload(), {
      edits: { kind: "improvement", targetDrillSlug: DRILL_SLUG, improvementKind: "safety", locale: "en" },
    });
    expect(slug).not.toBe(DRILL_SLUG);
    expect(versionsOf(DRILL_SLUG)).toHaveLength(1);
    expect(versionsOf(slug)[0]!.parent_version_id).toBeNull();
    expect(Object.keys(contentOf(versionsOf(slug)[0]!).title!)).toEqual(["ru"]);
  });

  test("an edit that makes ageMax smaller than ageMin is refused and leaves no rows", () => {
    const contribution = submit();
    const before = snapshot();
    expect(() => decide(db, ADMIN, contribution.id, approve({ edits: { ageMin: 12, ageMax: 8 } }), opts)).toThrow(/age/i);
    expect(snapshot()).toEqual(before);
  });
});

// --- approve: an improvement ---------------------------------------------------------------

describe("decide approve, kind improvement", () => {
  test("creates the NEXT MINOR version (1.0.0 -> 1.1.0) with parent, change summary, and moves current_version_id", () => {
    const contribution = submit(improvementPayload());
    const result = decide(db, ADMIN, contribution.id, approve({ note: "Better wording" }), opts);

    const drill = drillRow(DRILL_SLUG);
    expect(drill.current_version_id).toBe(`${DRILL_SLUG}-v1.1.0`);
    const versions = versionsOf(DRILL_SLUG);
    expect(versions.map((v) => v.semver)).toEqual(["1.0.0", "1.1.0"]);
    const next = versions[1]!;
    expect(next.parent_version_id).toBe(OLD_VERSION_ID);
    expect(next.change_summary).toContain("safety");
    expect(next.change_summary).toContain("Better wording");
    expect(next.origin).toBe("contribution");
    expect(next.status).toBe("COMMUNITY");
    expect(next.created_at).toBe(T_DECIDE.toISOString());

    expect(result.drill!.versionId).toBe(`${DRILL_SLUG}-v1.1.0`);
    expect(result.drill!.attribution.semver).toBe("1.1.0");
    expect(result.contribution.state).toBe("approved");
    expect(result.contribution.resultingDrillSlug).toBe(DRILL_SLUG);
    expect(contributionRow(contribution.id).resulting_drill_id).toBe(drillRow(DRILL_SLUG).id);
  });

  test("the old version is untouched and still readable through the history, newest first", () => {
    const before = versionRow(OLD_VERSION_ID);
    const result = decide(db, ADMIN, submit(improvementPayload()).id, approve(), opts);
    expect(versionRow(OLD_VERSION_ID)).toEqual(before);
    const history = result.drill!.history;
    expect(history.map((h) => h.semver)).toEqual(["1.1.0", "1.0.0"]);
    expect(history.map((h) => h.versionId)).toEqual([`${DRILL_SLUG}-v1.1.0`, OLD_VERSION_ID]);
    expect(history[0]!.note).toContain("safety");
    expect(getDrill(db, DRILL_SLUG, "en")!.history).toHaveLength(2);
  });

  test("the payload's locale replaces text in THAT locale only; other locales keep the previous version's text", () => {
    const oldContent = contentOf(versionRow(OLD_VERSION_ID));
    const result = decide(db, ADMIN, submit(improvementPayload({ locale: "ru" })).id, approve(), opts);
    const content = contentOf(versionRow(result.drill!.versionId));

    expect(content.title!.ru).toBe("Перекаты подошвой");
    expect(content.title!.kk).toBe(oldContent.title!.kk);
    expect(content.title!.en).toBe(oldContent.title!.en);
    expect(content.instructions.ru).toBe("1. Катай мяч подошвой вперёд.\n2. Потом назад.");
    expect(content.instructions.kk).toBe(oldContent.instructions.kk);
    expect(content.instructions.en).toBe(oldContent.instructions.en);
    expect(content.mistakes[0]!.ru).toBe("Слишком сильно давить на мяч");
    expect(content.mistakes[0]!.kk).toBe(oldContent.mistakes[0]!.kk);
    expect(content.mistakes[0]!.en).toBe(oldContent.mistakes[0]!.en);
    expect(content.safety[0]!.ru).toBe("Носи удобную обувь");
    // the drill's goal text is not derivable from the payload's goal enum: it is kept as it was
    expect(content.goal).toEqual(oldContent.goal);
    expect(content.progressions.map((p) => p.ru)).toEqual(oldContent.progressions.map(() => undefined));
    expect(content.progressions.map((p) => p.en)).toEqual(oldContent.progressions.map((p) => p.en));
    expect(DrillContent.safeParse(content).success).toBe(true);
  });

  test("a kk improvement does not touch the ru or en text", () => {
    const oldContent = contentOf(versionRow(OLD_VERSION_ID));
    const result = decide(db, ADMIN, submit(improvementPayload({ locale: "kk", name: "Табан аударту" })).id, approve(), opts);
    const content = contentOf(versionRow(result.drill!.versionId));
    expect(content.title!.kk).toBe("Табан аударту");
    expect(content.title!.ru).toBe(oldContent.title!.ru);
    expect(content.title!.en).toBe(oldContent.title!.en);
    expect(content.instructions.ru).toBe(oldContent.instructions.ru);
    expect(content.instructions.en).toBe(oldContent.instructions.en);
  });

  test("non-localized fields come from the payload; the drill's skills and sport are unchanged", () => {
    const skillsBefore = all("SELECT * FROM drill_skills WHERE drill_id = ? ORDER BY skill_id", DRILL_SLUG);
    const result = decide(db, ADMIN, submit(improvementPayload({ ageMin: 9, ageMax: 13, level: "basic", equipment: "cones", durationMin: 20 })).id, approve(), opts);
    const v = versionRow(result.drill!.versionId);
    const content = contentOf(v);
    expect(v).toMatchObject({ age_min: 9, age_max: 13, level: "basic", equipment: "cones", minutes: 20, source: "Bota's notes", source_url: "https://example.com/bota" });
    expect(content.conditions).toMatchObject({ equipment: "cones", ageMin: 9, ageMax: 13 });
    expect(content.dose).toEqual({ durationSec: 1200 });
    expect(all("SELECT * FROM drill_skills WHERE drill_id = ? ORDER BY skill_id", DRILL_SLUG)).toEqual(skillsBefore);
  });

  test("an unchanged duration keeps the current dose (reps / sets / seconds)", () => {
    const old = versionRow(OLD_VERSION_ID);
    const result = decide(db, ADMIN, submit(improvementPayload({ durationMin: old.minutes })).id, approve(), opts);
    expect(contentOf(versionRow(result.drill!.versionId)).dose).toEqual(contentOf(old).dose);
  });

  test("attachments are appended to the current media", () => {
    const first = decide(db, ADMIN, submit(improvementPayload(), [attachment(1)]).id, approve(), opts);
    expect(contentOf(versionRow(first.drill!.versionId)).media).toEqual([{ kind: "video", url: "/uploads/2026/03/file-1.bin" }]);
    const second = decide(db, ADMIN, submit(improvementPayload(), [attachment(2)]).id, approve(), opts);
    expect(contentOf(versionRow(second.drill!.versionId)).media).toEqual([
      { kind: "video", url: "/uploads/2026/03/file-1.bin" },
      { kind: "image", url: "/uploads/2026/03/file-2.bin" },
    ]);
  });

  test("a second improvement is 1.2.0, parented on 1.1.0", () => {
    decide(db, ADMIN, submit(improvementPayload()).id, approve(), opts);
    const second = decide(db, ADMIN, submit(improvementPayload({ name: "Again" })).id, approve(), opts);
    expect(second.drill!.attribution.semver).toBe("1.2.0");
    expect(versionRow(second.drill!.versionId).parent_version_id).toBe(`${DRILL_SLUG}-v1.1.0`);
    expect(versionsOf(DRILL_SLUG).map((v) => v.semver)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  test("the reviews row goes on the new version; from_status is the drill's status before the decision", () => {
    setStatus(db, ADMIN, DRILL_SLUG, { toStatus: "EXPERT_VERIFIED", note: "Checked by an expert" }, opts);
    const result = decide(db, ADMIN, submit(improvementPayload()).id, approve({ note: "Merged" }), opts);
    const reviews = reviewsOf(result.drill!.versionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ from_status: "EXPERT_VERIFIED", to_status: "COMMUNITY", note: "Merged", reviewer: "Admin Aidar" });
    // the old version keeps its verification and its own review
    expect(versionRow(OLD_VERSION_ID).status).toBe("EXPERT_VERIFIED");
    expect(reviewsOf(OLD_VERSION_ID)).toHaveLength(1);
  });

  test("the change summary works without an improvement kind or a note", () => {
    const result = decide(db, ADMIN, submit(improvementPayload({ improvementKind: undefined })).id, approve(), opts);
    expect(versionRow(result.drill!.versionId).change_summary).toBeTruthy();
  });
});

// --- reject / request changes --------------------------------------------------------------

describe("decide reject and request_changes", () => {
  test("reject stores the note, marks the contribution rejected and creates nothing in the commons", () => {
    const contribution = submit();
    const before = { drills: count("drills"), versions: count("drill_versions"), reviews: count("reviews") };
    const result = decide(db, ADMIN, contribution.id, { action: "reject", note: "Not a football drill" }, opts);
    expect(result.contribution.state).toBe("rejected");
    expect(result.contribution.reviewerNote).toBe("Not a football drill");
    expect(result.drill).toBeUndefined();
    expect(contributionRow(contribution.id)).toMatchObject({ state: "rejected", reviewer_note: "Not a football drill", resulting_drill_id: null });
    expect({ drills: count("drills"), versions: count("drill_versions"), reviews: count("reviews") }).toEqual(before);
  });

  test("request_changes stores the note and sends it back; the owner can resubmit", () => {
    const contribution = submit();
    const result = decide(db, ADMIN, contribution.id, { action: "request_changes", note: "Add safety tips" }, opts);
    expect(result.contribution.state).toBe("changes_requested");
    expect(result.contribution.reviewerNote).toBe("Add safety tips");
    expect(result.drill).toBeUndefined();
    const resubmitted = updateForResubmit(db, ALICE, contribution.id, newPayload({ safety: "Keep away from windows" }));
    expect(resubmitted.state).toBe("pending");
    // and an admin can now decide it
    expect(decide(db, ADMIN, contribution.id, approve(), opts).contribution.state).toBe("approved");
  });

  test("a blank or missing note is refused for both, and nothing changes", () => {
    const contribution = submit();
    const before = snapshot();
    for (const action of ["reject", "request_changes"] as const) {
      expect(() => decide(db, ADMIN, contribution.id, { action }, opts)).toThrow(ModerationRefusedError);
      expect(() => decide(db, ADMIN, contribution.id, { action, note: "   " }, opts)).toThrow(ModerationRefusedError);
    }
    expect(snapshot()).toEqual(before);
  });
});

// --- illegal transitions -------------------------------------------------------------------

describe("illegal transitions", () => {
  test("a decision on an approved contribution throws a typed error and changes no row", () => {
    const contribution = submit();
    decide(db, ADMIN, contribution.id, approve(), opts);
    const before = snapshot();
    for (const decision of [approve(), { action: "reject", note: "n" } as const, { action: "request_changes", note: "n" } as const]) {
      const attempt = () => decide(db, ADMIN, contribution.id, decision, opts);
      expect(attempt).toThrow(IllegalTransitionError);
      try {
        attempt();
      } catch (error) {
        expect((error as IllegalTransitionError).state).toBe("approved");
      }
    }
    expect(snapshot()).toEqual(before);
  });

  test("rejected, withdrawn and changes_requested contributions accept no admin decision", () => {
    const rejected = submit(newPayload({ name: "R" }));
    decide(db, ADMIN, rejected.id, { action: "reject", note: "no" }, opts);
    const changes = submit(newPayload({ name: "C" }));
    decide(db, ADMIN, changes.id, { action: "request_changes", note: "fix" }, opts);
    const withdrawn = submit(newPayload({ name: "W" }));
    db.run("UPDATE contributions SET state = 'withdrawn' WHERE id = ?", [withdrawn.id]);

    const before = snapshot();
    for (const id of [rejected.id, changes.id, withdrawn.id]) {
      expect(() => decide(db, ADMIN, id, approve(), opts)).toThrow(IllegalTransitionError);
      expect(() => decide(db, ADMIN, id, { action: "reject", note: "x" }, opts)).toThrow(IllegalTransitionError);
    }
    expect(snapshot()).toEqual(before);
  });

  test("an unknown contribution id throws ContributionNotFoundError", () => {
    expect(() => decide(db, ADMIN, "does-not-exist", approve(), opts)).toThrow(ContributionNotFoundError);
  });
});

// --- atomicity -----------------------------------------------------------------------------

describe("one transaction: a failure late in the decision rolls EVERYTHING back", () => {
  // A trigger that aborts a write the decision makes AFTER the drill, version and other rows
  // were already written, standing in for any CHECK / trigger failure part-way through.
  const poison = (table: string, event: "INSERT" | "UPDATE"): void => {
    db.run(`CREATE TRIGGER poison BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'poisoned'); END`);
  };

  test.each([
    ["the final contribution update", "contributions", "UPDATE"],
    ["the reviews insert", "reviews", "INSERT"],
  ] as const)("approve new, failing at %s: no rows in drills, drill_versions, drill_skills, reviews or contributions", (_label, table, event) => {
    const contribution = submit(newPayload(), [attachment(1)]);
    const before = snapshot();
    poison(table, event);
    expect(() => decide(db, ADMIN, contribution.id, approve({ note: "n" }), opts)).toThrow(/poisoned/);
    expect(snapshot()).toEqual(before);
    expect(count("drills")).toBe(before.drills.length);
  });

  test.each([
    ["the final contribution update", "contributions", "UPDATE"],
    ["the reviews insert", "reviews", "INSERT"],
  ] as const)("approve improvement, failing at %s: the new version and the pointer move are undone", (_label, table, event) => {
    const contribution = submit(improvementPayload());
    const before = snapshot();
    poison(table, event);
    expect(() => decide(db, ADMIN, contribution.id, approve(), opts)).toThrow(/poisoned/);
    expect(snapshot()).toEqual(before);
    expect(drillRow(DRILL_SLUG).current_version_id).toBe(OLD_VERSION_ID);
    expect(versionsOf(DRILL_SLUG)).toHaveLength(1);
  });

  test("reject failing on the contribution update changes nothing", () => {
    const contribution = submit();
    const before = snapshot();
    poison("contributions", "UPDATE");
    expect(() => decide(db, ADMIN, contribution.id, { action: "reject", note: "n" }, opts)).toThrow(/poisoned/);
    expect(snapshot()).toEqual(before);
  });

  test("setStatus failing on the reviews insert leaves the status unchanged", () => {
    const before = snapshot();
    poison("reviews", "INSERT");
    expect(() => setStatus(db, ADMIN, DRILL_SLUG, { toStatus: "REVIEWED", note: "n" }, opts)).toThrow(/poisoned/);
    expect(snapshot()).toEqual(before);
  });

  test("unpublish failing on the drill update leaves no reviews row and the drill published", () => {
    const before = snapshot();
    poison("drills", "UPDATE");
    expect(() => unpublish(db, ADMIN, DRILL_SLUG, { reason: "n" }, opts)).toThrow(/poisoned/);
    expect(snapshot()).toEqual(before);
    expect(getDrill(db, DRILL_SLUG, "en")).not.toBeNull();
  });
});

// --- setStatus -----------------------------------------------------------------------------

describe("setStatus", () => {
  test("changes the CURRENT version's status, writes a reviews row and returns the detail", () => {
    const detail = setStatus(db, ADMIN, DRILL_SLUG, { toStatus: "ACADEMY_VERIFIED", orgLabel: "FC Academy", note: "Academy checked" }, opts);
    expect(versionRow(OLD_VERSION_ID).status).toBe("ACADEMY_VERIFIED");
    expect(reviewsOf(OLD_VERSION_ID)).toEqual([
      expect.objectContaining({
        reviewer: "Admin Aidar",
        reviewer_user_id: "admin-1",
        org_label: "FC Academy",
        from_status: "COMMUNITY",
        to_status: "ACADEMY_VERIFIED",
        note: "Academy checked",
        reviewed_at: T_DECIDE.toISOString(),
      }),
    ]);
    expect(detail.slug).toBe(DRILL_SLUG);
    expect(detail.reviews[0]).toMatchObject({ from: "COMMUNITY", to: "ACADEMY_VERIFIED", orgLabel: "FC Academy" });
  });

  test("only the current version changes; older versions keep their status", () => {
    decide(db, ADMIN, submit(improvementPayload()).id, approve(), opts);
    setStatus(db, ADMIN, DRILL_SLUG, { toStatus: "REVIEWED", note: "ok" }, opts);
    expect(versionRow(`${DRILL_SLUG}-v1.1.0`).status).toBe("REVIEWED");
    expect(versionRow(OLD_VERSION_ID).status).toBe("COMMUNITY");
  });

  test("a change to the same status, a blank note, or ACADEMY_VERIFIED without an orgLabel is refused and writes nothing", () => {
    const before = snapshot();
    const reason = (request: Parameters<typeof setStatus>[3]): string | undefined => {
      try {
        setStatus(db, ADMIN, DRILL_SLUG, request, opts);
      } catch (error) {
        expect(error).toBeInstanceOf(ModerationRefusedError);
        return (error as ModerationRefusedError).reason;
      }
      return undefined;
    };
    expect(reason({ toStatus: "COMMUNITY", note: "same" })).toBe("same_status");
    expect(reason({ toStatus: "REVIEWED", note: "  " })).toBe("note_required");
    expect(reason({ toStatus: "ACADEMY_VERIFIED", note: "ok" })).toBe("org_label_required");
    expect(snapshot()).toEqual(before);
  });

  test("an unknown or unpublished drill throws DrillNotFoundError", () => {
    expect(() => setStatus(db, ADMIN, "no-such-drill", { toStatus: "REVIEWED", note: "n" }, opts)).toThrow(DrillNotFoundError);
    unpublish(db, ADMIN, DRILL_SLUG, { reason: "gone" }, opts);
    expect(() => setStatus(db, ADMIN, DRILL_SLUG, { toStatus: "REVIEWED", note: "n" }, opts)).toThrow(DrillNotFoundError);
  });
});

// --- unpublish -----------------------------------------------------------------------------

describe("unpublish", () => {
  test("hides the drill from listPublishedVersions, listDrills and getDrill, and keeps every version row", () => {
    expect(listPublishedVersions(db).some((p) => p.slug === DRILL_SLUG)).toBe(true);
    const versionsBefore = count("drill_versions");
    const detail = unpublish(db, ADMIN, DRILL_SLUG, { reason: "Unsafe advice" }, opts);

    expect(detail.slug).toBe(DRILL_SLUG);
    expect(listPublishedVersions(db).some((p) => p.slug === DRILL_SLUG)).toBe(false);
    expect(listPublishedVersions(db, { sport: "football" }).some((p) => p.slug === DRILL_SLUG)).toBe(false);
    expect(listDrills(db, {}, "en").items.some((item) => item.slug === DRILL_SLUG)).toBe(false);
    expect(getDrill(db, DRILL_SLUG, "en")).toBeNull();
    expect(drillRow(DRILL_SLUG).unpublished_at).toBe(T_DECIDE.toISOString());
    expect(count("drill_versions")).toBe(versionsBefore);
    // other drills stay visible
    expect(listPublishedVersions(db).length).toBeGreaterThan(0);
  });

  test("writes a reviews row on the current version: reviewer, the status unchanged, the reason as the note", () => {
    unpublish(db, ADMIN, DRILL_SLUG, { reason: "Unsafe advice" }, opts);
    expect(reviewsOf(OLD_VERSION_ID)).toEqual([
      expect.objectContaining({
        reviewer: "Admin Aidar",
        reviewer_user_id: "admin-1",
        from_status: "COMMUNITY",
        to_status: "COMMUNITY",
        note: "Unsafe advice",
        reviewed_at: T_DECIDE.toISOString(),
      }),
    ]);
  });

  test("a blank reason is refused; an unknown or already unpublished drill throws DrillNotFoundError; nothing is written", () => {
    const before = snapshot();
    expect(() => unpublish(db, ADMIN, DRILL_SLUG, { reason: "  " }, opts)).toThrow(ModerationRefusedError);
    expect(() => unpublish(db, ADMIN, "no-such-drill", { reason: "x" }, opts)).toThrow(DrillNotFoundError);
    expect(snapshot()).toEqual(before);
    unpublish(db, ADMIN, DRILL_SLUG, { reason: "x" }, opts);
    const afterFirst = snapshot();
    expect(() => unpublish(db, ADMIN, DRILL_SLUG, { reason: "again" }, opts)).toThrow(DrillNotFoundError);
    expect(snapshot()).toEqual(afterFirst);
  });

  test("a drill created by a contribution can be unpublished too", () => {
    const slug = approveNew();
    unpublish(db, ADMIN, slug, { reason: "Duplicate" }, opts);
    expect(listPublishedVersions(db).some((p) => p.slug === slug)).toBe(false);
    expect(reviewsOf(`${slug}-v1.0.0`)).toHaveLength(2); // the approval and the unpublish
  });
});

// --- refusals and locked edits (added after the first mutation run) ------------------------

describe("refusals and locked edits", () => {
  const reasonOf = (attempt: () => unknown): string | undefined => {
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(ModerationRefusedError);
      return (error as ModerationRefusedError).reason;
    }
    return undefined;
  };

  test("what and where the coach wrote is locked in the STORED payload too: kind, target, improvement kind, locale, author", () => {
    const result = decide(
      db,
      ADMIN,
      submit().id,
      approve({ edits: { kind: "improvement", targetDrillSlug: DRILL_SLUG, improvementKind: "safety", locale: "en", author: "Admin Aidar", name: "Renamed" } }),
      opts,
    );
    expect(result.contribution.payload).toMatchObject({ kind: "new", locale: "ru", author: "Coach Aidos", name: "Renamed" });
    expect(result.contribution.payload.targetDrillSlug).toBeUndefined();
    expect(result.contribution.payload.improvementKind).toBeUndefined();
  });

  test("an improvement ignores sport and skill edits: the drill's place in the graph does not change", () => {
    const skillsBefore = all("SELECT * FROM drill_skills WHERE drill_id = ? ORDER BY skill_id", DRILL_SLUG);
    const result = decide(db, ADMIN, submit(improvementPayload()).id, approve({ edits: { sport: "no-such-sport", skill: "no-such-skill" } }), opts);
    expect(result.contribution.state).toBe("approved");
    expect(result.contribution.payload.sport).toBe("football");
    expect(all("SELECT * FROM drill_skills WHERE drill_id = ? ORDER BY skill_id", DRILL_SLUG)).toEqual(skillsBefore);
  });

  test("an age range turned upside down by an edit is refused as an invalid edit", () => {
    const contribution = submit();
    expect(reasonOf(() => decide(db, ADMIN, contribution.id, approve({ edits: { ageMin: 12, ageMax: 8 } }), opts))).toBe("invalid_edit");
  });

  test("an edit that breaks the payload schema (blank name) is refused as an invalid edit and writes nothing", () => {
    const contribution = submit();
    const before = snapshot();
    expect(reasonOf(() => decide(db, ADMIN, contribution.id, approve({ edits: { name: "" } }), opts))).toBe("invalid_edit");
    expect(reasonOf(() => decide(db, ADMIN, contribution.id, approve({ edits: { instructions: "  \n " } }), opts))).toBe("invalid_edit");
    expect(snapshot()).toEqual(before);
  });

  test("a new drill in an unknown sport, or with a skill of no such sport, is refused and writes nothing", () => {
    const unknownSport = submit(newPayload({ name: "S", sport: "no-such-sport" }));
    const unknownSkill = submit(newPayload({ name: "K", skill: "no-such-skill" }));
    const before = snapshot();
    expect(reasonOf(() => decide(db, ADMIN, unknownSport.id, approve(), opts))).toBe("unknown_sport");
    expect(reasonOf(() => decide(db, ADMIN, unknownSkill.id, approve(), opts))).toBe("unknown_skill");
    expect(snapshot()).toEqual(before);
  });

  test("an improvement of a drill that has been unpublished throws DrillNotFoundError and writes nothing", () => {
    const contribution = submit(improvementPayload());
    unpublish(db, ADMIN, DRILL_SLUG, { reason: "gone" }, opts);
    const before = snapshot();
    expect(() => decide(db, ADMIN, contribution.id, approve(), opts)).toThrow(DrillNotFoundError);
    expect(snapshot()).toEqual(before);
    expect(contributionRow(contribution.id).state).toBe("pending");
  });

  test("the acting admin needs a name or an id", () => {
    const contribution = submit();
    const before = snapshot();
    expect(reasonOf(() => decide(db, { id: " ", name: "" }, contribution.id, approve(), opts))).toBe("reviewer_required");
    expect(snapshot()).toEqual(before);
  });
});
