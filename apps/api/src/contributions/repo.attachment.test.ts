import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import type { ContributionPayloadRequest } from "../shared/contributions";
import { createContribution, getAttachmentForServing, withdraw } from "./repo";
import type { NewAttachment } from "./repo";

// getAttachmentForServing(db, attachmentId): the ONE read the private media route (fc-mol-70i.6) needs.
// One row per attachment id: the stored file's facts plus who owns it and whether it is PUBLIC.
// Public (reading 1): the contribution's state is 'approved' AND its resulting_drill_id points at a
// drill that is still published (unpublished_at IS NULL). Anything else is private. Every test runs on
// a fresh in-memory database migrated with the real migrations and loaded with the real seed.

const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");
const ALICE = "user-alice";
const DRILL_SLUG = "ball-mastery-sole-rolls";
const T0 = new Date("2026-03-01T10:00:00.000Z");

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
});

afterEach(() => {
  db.close();
});

const payload = (): ContributionPayloadRequest => ({
  kind: "new",
  locale: "ru",
  name: "Wall passes",
  sport: "football",
  skill: "alternating-touches",
  ageMin: 8,
  ageMax: 12,
  level: "beginner",
  goal: "control",
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
});

const files: NewAttachment[] = [
  { kind: "video", storedPath: "aaaa1111.mp4", mime: "video/mp4", bytes: 1234, originalName: "wall.mp4" },
  { kind: "image", storedPath: "bbbb2222.png", mime: "image/png", bytes: 55, originalName: "cones.png" },
];

/** A contribution of ALICE with both files; returns the contribution id and its attachment ids. */
function create(userId = ALICE): { id: string; first: string; second: string } {
  const made = createContribution(db, { userId, payload: payload(), attachments: files.map((f) => ({ ...f, storedPath: `${userId}-${f.storedPath}` })), now: T0 });
  return { id: made.id, first: made.attachments[0]!.id, second: made.attachments[1]!.id };
}

const drillId = (slug = DRILL_SLUG): string => (db.query("SELECT id FROM drills WHERE slug = ?").get(slug) as { id: string }).id;
const approve = (id: string, withDrill = true): void => {
  db.run("UPDATE contributions SET state = 'approved', resulting_drill_id = ? WHERE id = ?", [withDrill ? drillId() : null, id]);
};

describe("getAttachmentForServing", () => {
  test("null for an id that does not exist", () => {
    create();
    expect(getAttachmentForServing(db, "no-such-attachment")).toBeNull();
    expect(getAttachmentForServing(db, "")).toBeNull();
  });

  test("the id is bound, never spliced into SQL", () => {
    const { first } = create();
    expect(getAttachmentForServing(db, `${first}' OR '1'='1`)).toBeNull();
    expect(getAttachmentForServing(db, "' OR 1=1 --")).toBeNull();
  });

  test("returns the stored file's facts, its owner and its state", () => {
    const { id, first, second } = create();
    expect(getAttachmentForServing(db, first)).toEqual({
      id: first,
      contributionId: id,
      kind: "video",
      storedPath: `${ALICE}-aaaa1111.mp4`,
      mime: "video/mp4",
      bytes: 1234,
      originalName: "wall.mp4",
      submitterUserId: ALICE,
      state: "pending",
      isPublic: false,
    });
    expect(getAttachmentForServing(db, second)).toMatchObject({ id: second, kind: "image", mime: "image/png", storedPath: `${ALICE}-bbbb2222.png` });
  });

  test("finds the attachment of another user by id alone (the caller decides access)", () => {
    const bob = create("user-bob");
    expect(getAttachmentForServing(db, bob.first)).toMatchObject({ submitterUserId: "user-bob" });
  });

  test("an approved contribution whose drill is published is public", () => {
    const { id, first, second } = create();
    approve(id);
    expect(getAttachmentForServing(db, first)).toMatchObject({ state: "approved", isPublic: true });
    expect(getAttachmentForServing(db, second)).toMatchObject({ state: "approved", isPublic: true });
  });

  test("an approved contribution whose drill was unpublished is private again", () => {
    const { id, first } = create();
    approve(id);
    db.run("UPDATE drills SET unpublished_at = '2026-04-01T00:00:00.000Z' WHERE id = ?", [drillId()]);
    expect(getAttachmentForServing(db, first)).toMatchObject({ state: "approved", isPublic: false });
  });

  test("an approved contribution with no resulting drill is private", () => {
    const { id, first } = create();
    approve(id, false);
    expect(getAttachmentForServing(db, first)).toMatchObject({ state: "approved", isPublic: false });
  });

  test("pending, changes_requested and rejected are private", () => {
    for (const state of ["pending", "changes_requested", "rejected"] as const) {
      const { id, first } = create(`user-${state}`);
      db.run("UPDATE contributions SET state = ? WHERE id = ?", [state, id]);
      expect(getAttachmentForServing(db, first)).toMatchObject({ state, isPublic: false });
    }
  });

  test("only the attachments of the approved contribution become public", () => {
    const approved = create("user-a");
    const pending = create("user-b");
    approve(approved.id);
    expect(getAttachmentForServing(db, approved.first)?.isPublic).toBe(true);
    expect(getAttachmentForServing(db, pending.first)?.isPublic).toBe(false);
  });

  test("a withdrawn contribution has no attachment rows left: null", () => {
    const { id, first } = create();
    withdraw(db, ALICE, id);
    expect(getAttachmentForServing(db, first)).toBeNull();
  });
});
