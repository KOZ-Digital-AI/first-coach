import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { CONTRIBUTION_STATES, Contribution, EDITABLE_STATES, MyContributionsResponse } from "../shared/contributions";
import type { ContributionPayloadRequest, ContributionState } from "../shared/contributions";
import { EntityId } from "../shared/primitives";
import {
  ContributionNotFoundError,
  InvalidStateError,
  TargetDrillNotFoundError,
  attachmentPathsOf,
  contentHash,
  createContribution,
  findDuplicates,
  getForOwner,
  listMine,
  updateForResubmit,
  withdraw,
} from "./repo";
import type { NewAttachment } from "./repo";

// Every test runs on a fresh in-memory database migrated with the real migrations (STRICT tables,
// CHECKs, FKs, the immutability trigger) and loaded with the REAL seed, so the target slugs of an
// improvement are real drills. The one test that needs two connections uses a temp FILE database,
// removed in afterEach.

const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");

const ALICE = "user-alice";
const BOB = "user-bob";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const T1 = new Date("2026-03-02T11:30:15.250Z");
const T2 = new Date("2026-03-03T08:00:00.000Z");

let db: Database;
let tmpDir: string | undefined;
let db2: Database | undefined;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
});

afterEach(() => {
  db.close();
  db2?.close();
  db2 = undefined;
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
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
  goal: "technique",
  instructions: "Pass the ball against the wall.",
  durationMin: 10,
  equipment: "ball_wall",
  mistakes: "",
  progression: "",
  regression: "",
  safety: "",
  source: "My own training notes",
  author: "Coach Aidos",
  rightsAttested: true,
  noCommercialContent: true,
  ...over,
});

const DRILL_SLUG = "ball-mastery-sole-rolls";
const OTHER_DRILL_SLUG = "ball-mastery-foundation-touches";

const improvementPayload = (over: Partial<ContributionPayloadRequest> = {}): ContributionPayloadRequest =>
  newPayload({ kind: "improvement", targetDrillSlug: DRILL_SLUG, improvementKind: "safety", ...over });

const attachment = (n: number, over: Partial<NewAttachment> = {}): NewAttachment => ({
  kind: n === 1 ? "video" : "image",
  storedPath: `2026/03/file-${n}.bin`,
  mime: n === 1 ? "video/mp4" : "image/png",
  bytes: 1000 * n,
  originalName: `original-${n}.bin`,
  ...over,
});

const create = (userId = ALICE, payload = newPayload(), attachments?: NewAttachment[], now: Date = T0): Contribution =>
  createContribution(db, { userId, payload, ...(attachments === undefined ? {} : { attachments }), now });

interface RawRow {
  id: string;
  kind: string;
  target_drill_id: string | null;
  improvement_kind: string | null;
  payload: string;
  state: string;
  origin: string;
  submitter_user_id: string;
  reviewer_note: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

const rawRow = (id: string): RawRow | null => db.query("SELECT * FROM contributions WHERE id = ?").get(id) as RawRow | null;
const count = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
const setState = (id: string, state: ContributionState): void => {
  if (state === "approved") {
    const drill = db.query("SELECT id FROM drills WHERE slug = ?").get(DRILL_SLUG) as { id: string };
    db.run("UPDATE contributions SET state = 'approved', resulting_drill_id = ? WHERE id = ?", [drill.id, id]);
  } else db.run("UPDATE contributions SET state = ? WHERE id = ?", [state, id]);
};
const drillId = (slug: string): string => (db.query("SELECT id FROM drills WHERE slug = ?").get(slug) as { id: string }).id;

// --- contentHash --------------------------------------------------------------------------

describe("contentHash", () => {
  test("is 64 lower-case hex characters", () => {
    expect(contentHash(newPayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the sha256 of the canonical JSON: sorted keys, no attestations, no honeypot", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          ageMax: 12,
          ageMin: 8,
          author: "Coach Aidos",
          durationMin: 10,
          equipment: "ball_wall",
          goal: "technique",
          instructions: "Pass the ball against the wall.",
          kind: "new",
          level: "beginner",
          locale: "ru",
          mistakes: "",
          name: "Wall passes",
          progression: "",
          regression: "",
          safety: "",
          skill: "alternating-touches",
          source: "My own training notes",
          sport: "football",
        }),
      )
      .digest("hex");
    expect(contentHash(newPayload())).toBe(expected);
  });

  test("does not depend on key order", () => {
    const p = newPayload();
    const reversed = Object.fromEntries(Object.entries(p).reverse()) as ContributionPayloadRequest;
    expect(Object.keys(reversed)[0]).not.toBe(Object.keys(p)[0]);
    expect(contentHash(reversed)).toBe(contentHash(p));
  });

  test("does not depend on surrounding whitespace of any string", () => {
    const padded = newPayload({
      name: "  Wall passes \n",
      instructions: "\tPass the ball against the wall.  ",
      author: " Coach Aidos ",
      sourceUrl: " https://example.com/a ",
    });
    expect(contentHash(padded)).toBe(contentHash(newPayload({ sourceUrl: "https://example.com/a" })));
  });

  test("collapses internal whitespace in the name", () => {
    expect(contentHash(newPayload({ name: "Wall \t  passes" }))).toBe(contentHash(newPayload({ name: "Wall passes" })));
  });

  test("keeps internal whitespace of the other text fields (only the name is collapsed)", () => {
    const a = contentHash(newPayload({ instructions: "Pass the ball.\n\nThen pass again." }));
    const b = contentHash(newPayload({ instructions: "Pass the ball.\nThen pass again." }));
    expect(a).not.toBe(b);
  });

  test("normalises Unicode to NFC", () => {
    expect(contentHash(newPayload({ name: "Cafe\u0301 drill" }))).toBe(contentHash(newPayload({ name: "Caf\u00e9 drill" })));
  });

  test("ignores the honeypot: empty and absent are the same, and a filled one does not change it", () => {
    const base = contentHash(newPayload());
    expect(contentHash(newPayload({ website: "" }))).toBe(base);
    expect(contentHash({ ...newPayload(), website: "http://spam.example" } as unknown as ContributionPayloadRequest)).toBe(base);
  });

  test("ignores the attestation booleans", () => {
    const base = contentHash(newPayload());
    const flipped = { ...newPayload(), rightsAttested: false, noCommercialContent: false } as unknown as ContributionPayloadRequest;
    expect(contentHash(flipped)).toBe(base);
  });

  test("an optional field set to undefined is the same as absent", () => {
    expect(contentHash(newPayload({ sourceUrl: undefined }))).toBe(contentHash(newPayload()));
  });

  const plain = (): ContributionPayloadRequest => newPayload();
  const improving = (): ContributionPayloadRequest => improvementPayload();
  test.each<[string, () => ContributionPayloadRequest, Partial<ContributionPayloadRequest>]>([
    ["name", plain, { name: "Wall pass" }],
    ["instructions", plain, { instructions: "Pass the ball at the wall." }],
    ["ageMax", plain, { ageMax: 13 }],
    ["equipment", plain, { equipment: "cones" }],
    ["sourceUrl", plain, { sourceUrl: "https://example.com/x" }],
    ["kind and target", plain, { kind: "improvement", targetDrillSlug: DRILL_SLUG }],
    ["target slug", improving, { targetDrillSlug: OTHER_DRILL_SLUG }],
    ["improvementKind", improving, { improvementKind: "video" }],
  ])("a different %s gives a different hash", (_label, base, over) => {
    expect(contentHash({ ...base(), ...over })).not.toBe(contentHash(base()));
  });
});

// --- createContribution ---------------------------------------------------------------------

describe("createContribution", () => {
  test("returns a pending Contribution that parses with the contract schema", () => {
    const c = create();
    expect(() => Contribution.parse(c)).not.toThrow();
    expect(c.state).toBe("pending");
    expect(EntityId.safeParse(c.id).success).toBe(true);
    expect(c.attachments).toEqual([]);
    expect(c.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(c.updatedAt).toBe(c.createdAt);
    expect(c.reviewerNote).toBeUndefined();
    expect(c.resultingDrillSlug).toBeUndefined();
    expect(c.payload.name).toBe("Wall passes");
    expect(c.payload.kind).toBe("new");
  });

  test("gives every contribution its own id", () => {
    expect(create().id).not.toBe(create().id);
  });

  test("stores origin 'form', the submitter, no target for a new contribution, and the content hash", () => {
    const payload = newPayload();
    const row = rawRow(create(ALICE, payload).id)!;
    expect(row.origin).toBe("form");
    expect(row.submitter_user_id).toBe(ALICE);
    expect(row.state).toBe("pending");
    expect(row.kind).toBe("new");
    expect(row.target_drill_id).toBeNull();
    expect(row.improvement_kind).toBeNull();
    expect(row.reviewer_note).toBeNull();
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.content_hash).toBe(contentHash(payload));
  });

  test("a new contribution never has a target, even when the payload names a slug", () => {
    const c = create(ALICE, newPayload({ targetDrillSlug: DRILL_SLUG }));
    expect(rawRow(c.id)!.target_drill_id).toBeNull();
  });

  test("an improvement resolves its slug to drills.id and stores the improvement kind", () => {
    const c = create(ALICE, improvementPayload());
    const row = rawRow(c.id)!;
    expect(row.kind).toBe("improvement");
    expect(row.target_drill_id).toBe(drillId(DRILL_SLUG));
    expect(row.improvement_kind).toBe("safety");
    expect(c.payload.targetDrillSlug).toBe(DRILL_SLUG);
  });

  test("an improvement of an unknown slug fails with TargetDrillNotFoundError and stores nothing", () => {
    expect(() => create(ALICE, improvementPayload({ targetDrillSlug: "no-such-drill" }))).toThrow(TargetDrillNotFoundError);
    expect(count("contributions")).toBe(0);
  });

  test("an improvement that names no drill at all fails with TargetDrillNotFoundError", () => {
    const { targetDrillSlug: _omitted, ...withoutTarget } = improvementPayload();
    expect(() => create(ALICE, withoutTarget as ContributionPayloadRequest)).toThrow(TargetDrillNotFoundError);
    expect(count("contributions")).toBe(0);
  });

  test("the honeypot is not stored, and unknown fields do not reach the view", () => {
    const c = create(ALICE, newPayload({ website: "" }));
    expect(JSON.parse(rawRow(c.id)!.payload)).not.toHaveProperty("website");
    expect(c.payload).not.toHaveProperty("website");
    expect(c.payload).not.toHaveProperty("rightsAttested");
  });

  test("stores attachments in upload order and maps them to the contract view", () => {
    const c = create(ALICE, newPayload(), [attachment(1), attachment(2), attachment(3)]);
    expect(() => Contribution.parse(c)).not.toThrow();
    expect(c.attachments).toHaveLength(3);
    expect(c.attachments.map((a) => a.filename)).toEqual(["original-1.bin", "original-2.bin", "original-3.bin"]);
    expect(c.attachments[0]).toMatchObject({ kind: "video", mimeType: "video/mp4", size: 1000, filename: "original-1.bin" });
    expect(c.attachments[0]!.url).toContain("2026/03/file-1.bin");
    expect(new Set(c.attachments.map((a) => a.id)).size).toBe(3);
    expect(count("contribution_attachments")).toBe(3);
    expect(attachmentPathsOf(db, c.id)).toEqual(["2026/03/file-1.bin", "2026/03/file-2.bin", "2026/03/file-3.bin"]);
  });

  test("a failing attachment insert leaves no contribution row behind (one transaction)", () => {
    const clash = [attachment(1), attachment(2, { storedPath: attachment(1).storedPath })];
    expect(() => create(ALICE, newPayload(), clash)).toThrow();
    expect(count("contributions")).toBe(0);
    expect(count("contribution_attachments")).toBe(0);
  });

  test("an identical payload is not refused: duplicates are flagged, not blocked", () => {
    const a = create(ALICE);
    const b = create(BOB);
    expect(a.id).not.toBe(b.id);
    expect(count("contributions")).toBe(2);
  });
});

// --- listMine / getForOwner --------------------------------------------------------------------

describe("listMine", () => {
  test("is empty for a user without contributions", () => {
    create(ALICE);
    expect(listMine(db, BOB)).toEqual([]);
  });

  test("returns only the caller's contributions, in every state", () => {
    const a1 = create(ALICE);
    const a2 = create(ALICE, newPayload({ name: "Second" }));
    const b1 = create(BOB, newPayload({ name: "Bob's" }));
    setState(a2.id, "rejected");
    const mine = listMine(db, ALICE);
    expect(mine.map((c) => c.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(mine.map((c) => c.id)).not.toContain(b1.id);
    expect(mine.find((c) => c.id === a2.id)!.state).toBe("rejected");
  });

  test("is newest first", () => {
    const first = create(ALICE, newPayload({ name: "First" }), undefined, T0);
    const third = create(ALICE, newPayload({ name: "Third" }), undefined, T2);
    const second = create(ALICE, newPayload({ name: "Second" }), undefined, T1);
    expect(listMine(db, ALICE).map((c) => c.id)).toEqual([third.id, second.id, first.id]);
  });

  test("breaks a tie on created_at by id, descending, so the order is total", () => {
    const ids = [create(ALICE).id, create(ALICE).id, create(ALICE).id];
    expect(listMine(db, ALICE).map((c) => c.id)).toEqual([...ids].sort().reverse());
  });

  test("puts each contribution's own attachments on it, and the result parses as MyContributionsResponse", () => {
    const withFiles = create(ALICE, newPayload({ name: "With files" }), [attachment(1), attachment(2)], T0);
    const without = create(ALICE, newPayload({ name: "Without" }), undefined, T1);
    create(BOB, newPayload({ name: "Bob's" }), [attachment(3)], T1);
    const mine = listMine(db, ALICE);
    expect(() => MyContributionsResponse.parse(mine)).not.toThrow();
    expect(mine.find((c) => c.id === withFiles.id)!.attachments).toHaveLength(2);
    expect(mine.find((c) => c.id === without.id)!.attachments).toEqual([]);
  });
});

describe("getForOwner", () => {
  test("returns the owner's contribution, parsing with the contract schema", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    const got = getForOwner(db, ALICE, c.id);
    expect(got).toEqual(c);
    expect(() => Contribution.parse(got)).not.toThrow();
  });

  test("returns null for someone else's contribution, exactly as for an id that does not exist", () => {
    const c = create(ALICE);
    expect(getForOwner(db, BOB, c.id)).toBeNull();
    expect(getForOwner(db, BOB, "does-not-exist")).toBeNull();
    expect(getForOwner(db, ALICE, "does-not-exist")).toBeNull();
  });

  test("shows the reviewer note and the resulting drill slug once a moderator has set them", () => {
    const c = create(ALICE, improvementPayload());
    setState(c.id, "approved");
    db.run("UPDATE contributions SET reviewer_note = 'Thanks!' WHERE id = ?", [c.id]);
    const got = getForOwner(db, ALICE, c.id)!;
    expect(got.state).toBe("approved");
    expect(got.reviewerNote).toBe("Thanks!");
    expect(got.resultingDrillSlug).toBe(DRILL_SLUG);
    expect(() => Contribution.parse(got)).not.toThrow();
  });
});

// --- updateForResubmit -----------------------------------------------------------------------

describe("updateForResubmit", () => {
  const revised = newPayload({ name: "Wall passes v2", instructions: "Pass harder." });

  test("state matrix: allowed exactly in the contract's EDITABLE_STATES", () => {
    for (const state of CONTRIBUTION_STATES) {
      const c = create();
      setState(c.id, state);
      const attempt = () => updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
      if ((EDITABLE_STATES as readonly string[]).includes(state)) {
        expect(attempt().state).toBe("pending");
      } else {
        expect(attempt).toThrow(InvalidStateError);
        expect(rawRow(c.id)!.state).toBe(state);
        expect(JSON.parse(rawRow(c.id)!.payload).name).toBe("Wall passes");
      }
    }
  });

  test("a changes_requested contribution goes back to pending with the new payload and a recomputed hash", () => {
    const c = create(ALICE, newPayload(), undefined, T0);
    setState(c.id, "changes_requested");
    const before = rawRow(c.id)!;
    const updated = updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
    expect(() => Contribution.parse(updated)).not.toThrow();
    expect(updated.state).toBe("pending");
    expect(updated.payload.name).toBe("Wall passes v2");
    expect(updated.payload.instructions).toBe("Pass harder.");
    const row = rawRow(c.id)!;
    expect(row.state).toBe("pending");
    expect(row.content_hash).toBe(contentHash(revised));
    expect(row.content_hash).not.toBe(before.content_hash);
    expect(JSON.parse(row.payload).name).toBe("Wall passes v2");
  });

  test("keeps id, submitter and created_at, and bumps updated_at", () => {
    const c = create(ALICE, newPayload(), undefined, T0);
    setState(c.id, "changes_requested");
    const updated = updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
    const row = rawRow(c.id)!;
    expect(updated.id).toBe(c.id);
    expect(row.id).toBe(c.id);
    expect(row.submitter_user_id).toBe(ALICE);
    expect(row.created_at).toBe("2026-03-01T10:00:00.000Z");
    expect(updated.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(row.updated_at).toBe("2026-03-02T11:30:15.250Z");
    expect(updated.updatedAt).toBe("2026-03-02T11:30:15.250Z");
  });

  test("editing while still pending keeps it pending and recomputes the hash", () => {
    const c = create();
    const updated = updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
    expect(updated.state).toBe("pending");
    expect(rawRow(c.id)!.content_hash).toBe(contentHash(revised));
  });

  test("keeps the reviewer's note until a moderator changes it", () => {
    const c = create();
    setState(c.id, "changes_requested");
    db.run("UPDATE contributions SET reviewer_note = 'Add a safety line' WHERE id = ?", [c.id]);
    const updated = updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
    expect(updated.reviewerNote).toBe("Add a safety line");
    expect(rawRow(c.id)!.reviewer_note).toBe("Add a safety line");
  });

  test("omitted attachments are kept; an array replaces them; an empty array clears them", () => {
    const c = create(ALICE, newPayload(), [attachment(1), attachment(2)]);
    const kept = updateForResubmit(db, ALICE, c.id, revised, undefined, T1);
    expect(kept.attachments).toHaveLength(2);
    expect(attachmentPathsOf(db, c.id)).toEqual(["2026/03/file-1.bin", "2026/03/file-2.bin"]);

    const replaced = updateForResubmit(db, ALICE, c.id, revised, [attachment(3), attachment(1)], T1);
    expect(replaced.attachments.map((a) => a.filename)).toEqual(["original-3.bin", "original-1.bin"]);
    expect(count("contribution_attachments")).toBe(2);

    const cleared = updateForResubmit(db, ALICE, c.id, revised, [], T1);
    expect(cleared.attachments).toEqual([]);
    expect(count("contribution_attachments")).toBe(0);
  });

  test("does not touch another contribution's attachments", () => {
    const mine = create(ALICE, newPayload(), [attachment(1)]);
    create(BOB, newPayload(), [attachment(2)]);
    updateForResubmit(db, ALICE, mine.id, revised, [attachment(3)], T1);
    expect(count("contribution_attachments")).toBe(2);
    expect(listMine(db, BOB)[0]!.attachments).toHaveLength(1);
  });

  test("owner isolation: someone else's contribution is ContributionNotFoundError and is left unchanged", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    const before = rawRow(c.id)!;
    expect(() => updateForResubmit(db, BOB, c.id, revised, [attachment(2)], T1)).toThrow(ContributionNotFoundError);
    expect(rawRow(c.id)).toEqual(before);
    expect(attachmentPathsOf(db, c.id)).toEqual(["2026/03/file-1.bin"]);
  });

  test("an id that does not exist is the same ContributionNotFoundError", () => {
    expect(() => updateForResubmit(db, ALICE, "nope", revised)).toThrow(ContributionNotFoundError);
  });

  test("the owner check comes before the state check: a stranger never learns the state", () => {
    const c = create();
    setState(c.id, "approved");
    expect(() => updateForResubmit(db, BOB, c.id, revised)).toThrow(ContributionNotFoundError);
  });

  test("after a withdraw, a resubmit is an InvalidStateError and the contribution stays withdrawn", () => {
    const c = create();
    withdraw(db, ALICE, c.id, T1);
    expect(() => updateForResubmit(db, ALICE, c.id, revised, undefined, T2)).toThrow(InvalidStateError);
    expect(rawRow(c.id)!.state).toBe("withdrawn");
    expect(rawRow(c.id)!.updated_at).toBe("2026-03-02T11:30:15.250Z");
  });

  test("InvalidStateError says which state and which operation were refused", () => {
    const c = create();
    setState(c.id, "rejected");
    try {
      updateForResubmit(db, ALICE, c.id, revised);
      throw new Error("expected InvalidStateError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).state).toBe("rejected");
      expect((error as InvalidStateError).operation).toBe("resubmit");
    }
  });

  test("turning it into an improvement resolves the target; an unknown slug is refused and nothing changes", () => {
    const c = create();
    const improved = updateForResubmit(db, ALICE, c.id, improvementPayload({ targetDrillSlug: OTHER_DRILL_SLUG }), undefined, T1);
    expect(improved.payload.kind).toBe("improvement");
    expect(rawRow(c.id)!.target_drill_id).toBe(drillId(OTHER_DRILL_SLUG));
    const before = rawRow(c.id)!;
    expect(() => updateForResubmit(db, ALICE, c.id, improvementPayload({ targetDrillSlug: "no-such-drill" }), undefined, T2)).toThrow(
      TargetDrillNotFoundError,
    );
    expect(rawRow(c.id)).toEqual(before);
  });

  test("turning an improvement back into a new contribution clears the target and the improvement kind", () => {
    const c = create(ALICE, improvementPayload());
    updateForResubmit(db, ALICE, c.id, newPayload(), undefined, T1);
    const row = rawRow(c.id)!;
    expect(row.kind).toBe("new");
    expect(row.target_drill_id).toBeNull();
    expect(row.improvement_kind).toBeNull();
  });

  test("a clock earlier than created_at does not break the row: updated_at is clamped to created_at", () => {
    const c = create(ALICE, newPayload(), undefined, T1);
    const updated = updateForResubmit(db, ALICE, c.id, revised, undefined, T0);
    expect(updated.updatedAt).toBe(c.createdAt);
  });
});

// --- withdraw ----------------------------------------------------------------------------------

describe("withdraw", () => {
  test("state matrix: allowed before a decision only (pending, changes_requested)", () => {
    const allowed: readonly ContributionState[] = ["pending", "changes_requested"];
    for (const state of CONTRIBUTION_STATES) {
      const c = create();
      setState(c.id, state);
      const attempt = () => withdraw(db, ALICE, c.id, T1);
      if (allowed.includes(state)) {
        const done = attempt();
        expect(() => Contribution.parse(done)).not.toThrow();
        expect(done.state).toBe("withdrawn");
        expect(rawRow(c.id)!.state).toBe("withdrawn");
      } else {
        expect(attempt).toThrow(InvalidStateError);
        expect(rawRow(c.id)!.state).toBe(state);
      }
    }
  });

  test("removes the attachment rows and returns the contribution without them", () => {
    const c = create(ALICE, newPayload(), [attachment(1), attachment(2)]);
    const done = withdraw(db, ALICE, c.id, T1);
    expect(done.state).toBe("withdrawn");
    expect(done.attachments).toEqual([]);
    expect(count("contribution_attachments")).toBe(0);
    expect(rawRow(c.id)).not.toBeNull();
    expect(getForOwner(db, ALICE, c.id)!.state).toBe("withdrawn");
  });

  test("attachmentPathsOf lists the files to purge before the withdraw, and nothing after", () => {
    const c = create(ALICE, newPayload(), [attachment(1), attachment(2)]);
    create(BOB, newPayload(), [attachment(3)]);
    expect(attachmentPathsOf(db, c.id)).toEqual(["2026/03/file-1.bin", "2026/03/file-2.bin"]);
    withdraw(db, ALICE, c.id, T1);
    expect(attachmentPathsOf(db, c.id)).toEqual([]);
    expect(count("contribution_attachments")).toBe(1);
  });

  test("attachmentPathsOf of an unknown id is empty", () => {
    expect(attachmentPathsOf(db, "nope")).toEqual([]);
  });

  test("bumps updated_at, keeps created_at and the reviewer note", () => {
    const c = create(ALICE, newPayload(), undefined, T0);
    setState(c.id, "changes_requested");
    db.run("UPDATE contributions SET reviewer_note = 'Please fix' WHERE id = ?", [c.id]);
    const done = withdraw(db, ALICE, c.id, T1);
    expect(done.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(done.updatedAt).toBe("2026-03-02T11:30:15.250Z");
    expect(done.reviewerNote).toBe("Please fix");
  });

  test("a second withdraw is an InvalidStateError and changes nothing", () => {
    const c = create();
    withdraw(db, ALICE, c.id, T1);
    const before = rawRow(c.id)!;
    expect(() => withdraw(db, ALICE, c.id, T2)).toThrow(InvalidStateError);
    expect(rawRow(c.id)).toEqual(before);
  });

  test("owner isolation: someone else's contribution is ContributionNotFoundError; attachments and state stay", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    const before = rawRow(c.id)!;
    expect(() => withdraw(db, BOB, c.id, T1)).toThrow(ContributionNotFoundError);
    expect(() => withdraw(db, BOB, "nope", T1)).toThrow(ContributionNotFoundError);
    expect(rawRow(c.id)).toEqual(before);
    expect(count("contribution_attachments")).toBe(1);
  });

  test("the owner check comes before the state check: a stranger never learns the state", () => {
    const c = create();
    setState(c.id, "approved");
    expect(() => withdraw(db, BOB, c.id)).toThrow(ContributionNotFoundError);
  });

  test("leaves other contributions of the same user alone", () => {
    const keep = create(ALICE, newPayload({ name: "Keep" }), [attachment(2)]);
    const gone = create(ALICE, newPayload({ name: "Gone" }), [attachment(1)]);
    withdraw(db, ALICE, gone.id, T1);
    expect(getForOwner(db, ALICE, keep.id)).toMatchObject({ state: "pending" });
    expect(getForOwner(db, ALICE, keep.id)!.attachments).toHaveLength(1);
  });
});

// --- findDuplicates ----------------------------------------------------------------------------

describe("findDuplicates", () => {
  test("returns the other contributions with the same hash, oldest first, excluding the given id", () => {
    const a = create(ALICE, newPayload(), undefined, T0);
    const b = create(BOB, newPayload(), undefined, T1);
    const c = create(BOB, newPayload(), undefined, T2);
    const hash = contentHash(newPayload());
    expect(findDuplicates(db, hash)).toEqual([a.id, b.id, c.id]);
    expect(findDuplicates(db, hash, a.id)).toEqual([b.id, c.id]);
    expect(findDuplicates(db, hash, c.id)).toEqual([a.id, b.id]);
  });

  test("is empty for a hash nobody else has", () => {
    const a = create();
    expect(findDuplicates(db, "0".repeat(64))).toEqual([]);
    expect(findDuplicates(db, contentHash(newPayload()), a.id)).toEqual([]);
  });

  test("does not match a different payload", () => {
    create(ALICE, newPayload({ name: "One" }));
    const two = create(BOB, newPayload({ name: "Two" }));
    expect(findDuplicates(db, contentHash(newPayload({ name: "Two" })), two.id)).toEqual([]);
  });

  test("a duplicate whose text differs only by whitespace is found", () => {
    const a = create(ALICE, newPayload({ name: "Wall passes" }));
    const b = create(BOB, newPayload({ name: "  Wall   passes " }));
    expect(findDuplicates(db, rawRow(b.id)!.content_hash, b.id)).toEqual([a.id]);
  });

  test("follows an edit: after a resubmit the old hash no longer matches", () => {
    const a = create(ALICE);
    const b = create(BOB);
    updateForResubmit(db, BOB, b.id, newPayload({ name: "Something else" }), undefined, T1);
    expect(findDuplicates(db, contentHash(newPayload()), a.id)).toEqual([]);
    expect(findDuplicates(db, contentHash(newPayload({ name: "Something else" })))).toEqual([b.id]);
  });
});

// --- atomicity ---------------------------------------------------------------------------------

describe("one transaction per operation", () => {
  test("withdraw: a failing attachment delete rolls the state change back", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    db.run(`CREATE TRIGGER t_no_attachment_delete BEFORE DELETE ON contribution_attachments BEGIN SELECT RAISE(ABORT, 'no'); END`);
    expect(() => withdraw(db, ALICE, c.id, T1)).toThrow();
    expect(rawRow(c.id)!.state).toBe("pending");
    expect(rawRow(c.id)!.updated_at).toBe("2026-03-01T10:00:00.000Z");
    expect(count("contribution_attachments")).toBe(1);
  });

  test("withdraw: a failing state update rolls the attachment delete back", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    db.run(
      `CREATE TRIGGER t_no_withdraw BEFORE UPDATE OF state ON contributions WHEN NEW.state = 'withdrawn' BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );
    expect(() => withdraw(db, ALICE, c.id, T1)).toThrow();
    expect(rawRow(c.id)!.state).toBe("pending");
    expect(count("contribution_attachments")).toBe(1);
  });

  test("resubmit: a failing attachment insert rolls the payload, hash and state back", () => {
    const c = create(ALICE, newPayload(), [attachment(1)]);
    setState(c.id, "changes_requested");
    const before = rawRow(c.id)!;
    db.run(`CREATE TRIGGER t_no_attachment_insert BEFORE INSERT ON contribution_attachments BEGIN SELECT RAISE(ABORT, 'no'); END`);
    expect(() => updateForResubmit(db, ALICE, c.id, newPayload({ name: "Changed" }), [attachment(2)], T1)).toThrow();
    expect(rawRow(c.id)).toEqual(before);
    expect(attachmentPathsOf(db, c.id)).toEqual(["2026/03/file-1.bin"]);
  });

  /**
   * Runs `op` while spying on every SQL call of `conn`; at each call a SECOND connection to the same
   * file tries BEGIN IMMEDIATE with no wait. It can only fail if `conn` already holds the write lock,
   * i.e. the guard (read) and the write both run inside one immediate transaction.
   */
  function probeWriteLock(conn: Database, other: Database, op: () => void): { calls: number; locked: number } {
    const result = { calls: 0, locked: 0 };
    const probe = (): void => {
      result.calls += 1;
      try {
        other.run("BEGIN IMMEDIATE");
        other.run("ROLLBACK");
      } catch (error) {
        if (/locked|busy/i.test(String(error))) result.locked += 1;
        else throw error;
      }
    };
    const wrapStatement = <T extends object>(statement: T): T =>
      new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (typeof value !== "function") return value;
          if (prop === "run" || prop === "get" || prop === "all" || prop === "values") {
            return (...args: unknown[]) => {
              probe();
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      });
    const mutable = conn as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["query", "prepare"] as const) {
      const original = mutable[name]!.bind(conn);
      mutable[name] = (...args: unknown[]) => wrapStatement(original(...args) as object);
    }
    op();
    return result;
  }

  test("check and write run inside one immediate transaction (a second connection cannot take the write lock meanwhile)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "contrib-repo-"));
    const path = join(tmpDir, "app.db");
    const file = openDatabase(path);
    migrate(file, MIGRATIONS_DIR);
    loadSeed(file, SEED_DIR);
    db2 = openDatabase(path);
    db2.run("PRAGMA busy_timeout = 0");

    const attachments = [attachment(1)];
    let id = "";
    const cases: Array<[string, () => void]> = [
      ["createContribution", () => void (id = createContribution(file, { userId: ALICE, payload: newPayload(), attachments, now: T0 }).id)],
      ["updateForResubmit", () => void updateForResubmit(file, ALICE, id, newPayload({ name: "Changed" }), [attachment(2)], T1)],
      ["withdraw", () => void withdraw(file, ALICE, id, T2)],
    ];
    try {
      for (const [name, op] of cases) {
        const { calls, locked } = probeWriteLock(file, db2, op);
        expect(calls, `${name} issued SQL`).toBeGreaterThan(0);
        expect(locked, `${name}: every statement ran under the write lock`).toBe(calls);
      }
    } finally {
      file.close();
    }
  });
});
