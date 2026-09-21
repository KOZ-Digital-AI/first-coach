// Moderation decision service (fc-mol-0v3.3): what an admin's decision does to the contributions and
// the commons tables. Consumers: the admin routes (POST /api/admin/contributions/:id/decision,
// POST /api/admin/drills/:slug/status, POST /api/admin/drills/:slug/unpublish). The contract is
// shared/admin.ts (DecisionRequest, DecisionResponse, DrillStatusRequest, UnpublishRequest); the
// contribution state machine and the trust-status rules are ./transitions.
//
// Every function takes the bun:sqlite Database first (no module singleton), is synchronous and uses
// bound parameters only.
//
// AUTHORITY: the admin identity is a parameter. Whether the caller IS an admin is the route's
// business (the auth guard); nothing here reads a session. The reviewer named on every reviews row is
// the admin's name, or the admin id when there is none.
//
// ONE TRANSACTION: each function runs its reads (state guard, current version), its checks and ALL
// its writes in a single BEGIN IMMEDIATE transaction. The write lock is taken up front, so what was
// checked cannot change before it is written (no TOCTOU: two admins deciding the same contribution
// cannot both approve it), and any failure part-way (a refusal, a CHECK, a trigger) rolls everything
// back. The response is built inside the transaction from the rows it just wrote.
//
// WHAT APPROVE WRITES (in this order)
//   1. the admin's edits are applied to the payload (see EDITS);
//   2. new: a drill (id = slug), version 1.0.0, the drill_skills link (the payload's skill, primary) and
//      the current_version_id pointer. improvement: the NEXT MINOR version of the target drill
//      (1.0.0 -> 1.1.0, parent = the current version, change_summary), then the pointer moves. The old
//      version is never touched (drill_versions is only INSERTed; the immutability trigger stays quiet);
//   3. the contribution's attachments become the version's media (appended to the current media);
//   4. a reviews row on the new version (reviewer, from/to status, orgLabel, note);
//   5. the contribution becomes approved, pointing at the drill, with the (edited) payload.
//   request_changes and reject touch only the contribution (state + note): no drill is involved, so
//   there is no reviews row (reviews.drill_version_id is NOT NULL).
//
// AUTHOR: the version's author_name / author_user_id are the contributor's (payload.author and the
// submitter), never the admin's, even when the admin edited the content or the author field.
//
// LOCALES: the payload's text is in ONE locale (payload.locale) and is stored under that locale only.
// A new drill has just that locale; other locales fall back (requested -> ru -> en, commons/repo) until
// somebody translates. An improvement REPLACES that locale's slot only and keeps the other locales'
// text of the current version (list fields are merged by position; see mergeList).
//
// READINGS the criteria leave open (each pinned by a test)
//   - EDITS: the admin may correct the payload's content fields. kind, targetDrillSlug,
//     improvementKind, locale (what and where the coach wrote), author (the contributor stays the
//     author) and the attestations / honeypot are NOT editable: such keys are ignored. For an
//     improvement sport and skill are ignored too (the drill's place in the graph does not change).
//     The edited payload is stored back on the contribution, with its content_hash recomputed.
//   - goal: the payload's goal is an enum, the drill's goal is text. A new drill gets the enum's label
//     in the payload's locale (GOAL_LABELS); an improvement keeps the drill's goal text as it was.
//   - space: the payload names none. A new drill gets one derived from its equipment (SPACE_FOR).
//     An improvement keeps the drill's spaces and partner flag.
//   - dose: a new drill's dose is durationMin as seconds. An improvement keeps the current dose when
//     the duration is unchanged, and otherwise replaces it with the new duration in seconds.
//   - status: the version starts at decision.status (default COMMUNITY). The reviews row's from_status
//     is COMMUNITY for a new drill and the drill's status BEFORE the decision for an improvement.
//   - licence: DEFAULT_LICENSE_ID (CC BY-SA 4.0), which the contributor attested to.
//   - a blank list field (mistakes, progression, ...) in an improvement CLEARS that locale's text of the
//     list; an item left without text in any locale is dropped.
//   - an improvement whose target drill is unpublished counts as not found (nothing to improve).
//   - reviewer_note: the latest decision's note replaces the previous one (null when the note is blank).
import type { Database } from "bun:sqlite";
import { getDrill } from "../commons/repo";
import { DEFAULT_DECISION_STATUS, isVerifiedStatus } from "../shared/admin";
import type { DecisionRequest, DecisionResponse, DrillStatusRequest, UnpublishRequest } from "../shared/admin";
import type { DrillDetail } from "../shared/commons";
import { ContributionPayloadView } from "../shared/contributions";
import type { ContributionKind, ContributionPayloadRequest, ContributionState } from "../shared/contributions";
import { DEFAULT_LICENSE_ID, DrillContent, LOCALES } from "../shared/primitives";
import type { DrillMedia, Equipment, Goal, Locale, LocalizedText, Space, TrustStatus } from "../shared/primitives";
import { ContributionNotFoundError, contentHash, getForOwner, UPLOADS_URL_PREFIX } from "./repo";
import { canTransition, checkStatusChange } from "./transitions";

// --- public surface --------------------------------------------------------------------------

/** The acting admin. The route has already checked that the caller is one. */
export interface Admin {
  id: string;
  name?: string | null | undefined;
}

export interface ModerationOptions {
  /** Clock (tests). */
  now?: () => Date;
  /** Locale the returned DrillDetail is localized to. Default: the payload's locale for decide, ru otherwise. */
  locale?: Locale;
}

/** The contribution is not in a state that accepts this action (routes answer 409). */
export class IllegalTransitionError extends Error {
  readonly state: ContributionState;
  readonly action: DecisionRequest["action"];

  constructor(state: ContributionState, action: DecisionRequest["action"]) {
    super(`Cannot ${action} a contribution that is ${state}`);
    this.name = "IllegalTransitionError";
    this.state = state;
    this.action = action;
  }
}

/** No published drill has this slug (unknown, unpublished, or an improvement's target) (routes answer 404). */
export class DrillNotFoundError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`No published drill with slug "${slug}"`);
    this.name = "DrillNotFoundError";
    this.slug = slug;
  }
}

export type ModerationRefusal =
  | "note_required"
  | "reason_required"
  | "org_label_required"
  | "reviewer_required"
  | "same_status"
  | "invalid_edit"
  | "unknown_sport"
  | "unknown_skill";

/** The request breaks a moderation rule (routes answer 422). Nothing was written. */
export class ModerationRefusedError extends Error {
  readonly reason: ModerationRefusal;

  constructor(reason: ModerationRefusal, message: string) {
    super(message);
    this.name = "ModerationRefusedError";
    this.reason = reason;
  }
}

// --- small helpers ---------------------------------------------------------------------------

const DEFAULT_LOCALE: Locale = "ru";

const clean = (value: string | undefined): string => (value ?? "").trim();

/** The name shown on the drill: the admin's name, or the id. */
function reviewerOf(admin: Admin): string {
  const reviewer = clean(admin.name ?? undefined) || clean(admin.id);
  if (reviewer === "") throw new ModerationRefusedError("reviewer_required", "The acting admin must have a name or an id");
  return reviewer;
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Numbered steps "1. ...": blank lines dropped, an existing "1." / "2)" prefix replaced by the running number. */
const numbered = (text: string): string =>
  lines(text)
    .map((line) => line.replace(/^\d{1,2}[.)]\s+/, "").trim())
    .filter((line) => line !== "")
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n");

const hasText = (text: LocalizedText): boolean => LOCALES.some((locale) => clean(text[locale]) !== "");

/** A copy of `text` with `locale` set to `value`, or removed when `value` is undefined. */
function withLocale(text: LocalizedText | undefined, locale: Locale, value: string | undefined): LocalizedText {
  const copy: LocalizedText = { ...text };
  if (value === undefined) delete copy[locale];
  else copy[locale] = value;
  return copy;
}

/**
 * Replaces `locale`'s text of a list by `texts`, position by position; the other locales of each
 * item are kept. Items beyond `texts` lose their `locale` slot; an item with no text left is dropped.
 */
function mergeList(current: readonly LocalizedText[], texts: readonly string[], locale: Locale): LocalizedText[] {
  const merged: LocalizedText[] = [];
  for (let index = 0; index < Math.max(current.length, texts.length); index += 1) {
    const item = withLocale(current[index], locale, texts[index]);
    if (hasText(item)) merged.push(item);
  }
  return merged;
}

const PAYLOAD_NOT_EDITABLE = ["kind", "targetDrillSlug", "improvementKind", "locale", "author", "rightsAttested", "noCommercialContent", "website"];
const IMPROVEMENT_NOT_EDITABLE = [...PAYLOAD_NOT_EDITABLE, "sport", "skill"];

/** The stored payload with the admin's edits applied (see EDITS in the header). */
function applyEdits(stored: Record<string, unknown>, kind: ContributionKind, edits: DecisionRequest["edits"]): Record<string, unknown> {
  const locked = kind === "improvement" ? IMPROVEMENT_NOT_EDITABLE : PAYLOAD_NOT_EDITABLE;
  const merged = { ...stored };
  for (const [key, value] of Object.entries(edits ?? {})) {
    if (value !== undefined && !locked.includes(key)) merged[key] = value;
  }
  return merged;
}

const GOAL_LABELS: Readonly<Record<Goal, Readonly<Record<Locale, string>>>> = {
  control: { kk: "Допты меңгеру", ru: "Контроль мяча", en: "Ball control" },
  dribbling: { kk: "Допты алып жүру", ru: "Ведение мяча", en: "Dribbling" },
  passing: { kk: "Пас беру", ru: "Передачи", en: "Passing" },
  weakfoot: { kk: "Әлсіз аяқты жаттықтыру", ru: "Слабая нога", en: "Weak foot" },
  coordination: { kk: "Үйлесімділік", ru: "Координация", en: "Coordination" },
};

const SPACE_FOR: Readonly<Record<Equipment, Space>> = {
  nothing: "home_3x3",
  ball: "home_3x3",
  ball_wall: "yard",
  cones: "field",
  full_field: "field",
};

// --- slugs and versions ----------------------------------------------------------------------

const TRANSLIT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    а: "a", ә: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", і: "i", й: "y",
    к: "k", қ: "k", л: "l", м: "m", н: "n", ң: "n", о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ұ: "u",
    ү: "u", ф: "f", х: "kh", һ: "h", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ы: "y", э: "e", ю: "yu", я: "ya",
  }),
);

/** URL-safe slug from a drill name: Cyrillic (ru and kk) transliterated, everything else [a-z0-9-]. */
function slugify(name: string): string {
  const latin = [...name.normalize("NFC").toLowerCase()].map((char) => TRANSLIT[char] ?? char).join("");
  const slug = latin
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "drill" : slug;
}

/** A drill slug (also the drill id) that no drill has: the name's slug, then -2, -3, ... */
function freeSlug(db: Database, name: string): string {
  const base = slugify(name);
  const taken = db.query("SELECT 1 FROM drills WHERE slug = ? OR id = ?");
  let slug = base;
  for (let n = 2; taken.get(slug, slug) !== null; n += 1) slug = `${base}-${n}`;
  return slug;
}

/** The next minor version after `current` that the drill does not have: 1.0.0 -> 1.1.0. */
function nextMinor(db: Database, drillId: string, current: string): string {
  const [major = 1, minor = 0] = current.split("-")[0]!.split(".").map(Number);
  const taken = db.query("SELECT 1 FROM drill_versions WHERE drill_id = ? AND semver = ?");
  let next = minor + 1;
  while (taken.get(drillId, `${major}.${next}.0`) !== null) next += 1;
  return `${major}.${next}.0`;
}

// --- row shapes and shared writes ------------------------------------------------------------

interface ContributionRow {
  id: string;
  kind: ContributionKind;
  target_drill_id: string | null;
  payload: string;
  state: ContributionState;
  submitter_user_id: string;
  created_at: string;
}

interface CurrentVersionRow {
  drill_id: string;
  slug: string;
  version_id: string;
  semver: string;
  status: TrustStatus;
  content: string;
  minutes: number;
}

/** The current version of a PUBLISHED drill, or null. */
function currentVersion(db: Database, where: "d.slug" | "d.id", value: string): CurrentVersionRow | null {
  return db
    .query(
      `SELECT d.id AS drill_id, d.slug AS slug, v.id AS version_id, v.semver AS semver, v.status AS status,
              v.content AS content, v.minutes AS minutes
         FROM drills d JOIN drill_versions v ON v.id = d.current_version_id
        WHERE ${where} = ? AND d.unpublished_at IS NULL`,
    )
    .get(value) as CurrentVersionRow | null;
}

interface ReviewInput {
  versionId: string;
  reviewer: string;
  reviewerUserId: string;
  orgLabel: string;
  from: TrustStatus;
  to: TrustStatus;
  note: string;
  at: string;
}

function insertReview(db: Database, review: ReviewInput): void {
  db.query(
    `INSERT INTO reviews (drill_version_id, reviewer, reviewer_user_id, org_label, from_status, to_status, note, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(review.versionId, review.reviewer, review.reviewerUserId, review.orgLabel, review.from, review.to, review.note, review.at);
}

interface NewVersion {
  id: string;
  drillId: string;
  semver: string;
  parentId: string | null;
  status: TrustStatus;
  content: DrillContent;
  payload: ContributionPayloadView;
  authorUserId: string;
  changeSummary: string | null;
  at: string;
}

/** Inserts an immutable version. The filter columns are copies of content.conditions (the schema CHECKs they agree). */
function insertVersion(db: Database, v: NewVersion): void {
  const { conditions } = v.content;
  db.query(
    `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space, partner,
                                 age_min, age_max, level, minutes, license, author_name, author_user_id, source,
                                 source_url, origin, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'contribution', ?, ?)`,
  ).run(
    v.id,
    v.drillId,
    v.semver,
    v.parentId,
    v.status,
    JSON.stringify(v.content),
    conditions.equipment,
    conditions.spaces[0]!,
    conditions.partner ? 1 : 0,
    conditions.ageMin ?? null,
    conditions.ageMax ?? null,
    v.payload.level,
    v.payload.durationMin,
    DEFAULT_LICENSE_ID,
    v.payload.author,
    v.authorUserId,
    v.payload.source,
    v.payload.sourceUrl ?? null,
    v.changeSummary,
    v.at,
  );
}

/** The drill content as the schema sees it; a content that fails it is the admin's edit gone wrong. */
function validContent(content: unknown): DrillContent {
  const parsed = DrillContent.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModerationRefusedError("invalid_edit", `The drill content is not valid: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

/** The contribution's files as drill media, in upload order. */
function attachedMedia(db: Database, contributionId: string): DrillMedia[] {
  const rows = db
    .query("SELECT kind, stored_path FROM contribution_attachments WHERE contribution_id = ? ORDER BY created_at, rowid")
    .all(contributionId) as { kind: DrillMedia["kind"]; stored_path: string }[];
  return rows.map((row) => ({ kind: row.kind, url: `${UPLOADS_URL_PREFIX}${row.stored_path.replace(/^\/+/, "")}` }));
}

const detailOf = (db: Database, slug: string, locale: Locale): DrillDetail => {
  const detail = getDrill(db, slug, locale);
  if (detail === null) throw new DrillNotFoundError(slug);
  return detail;
};

// --- decide ----------------------------------------------------------------------------------

const TARGET_STATE = { approve: "approved", reject: "rejected", request_changes: "changes_requested" } as const;

/** The drill an approval produced or changed, and the status its current version had before. */
interface Published {
  drillId: string;
  slug: string;
  versionId: string;
  fromStatus: TrustStatus;
}

interface ApproveContext {
  row: ContributionRow;
  payload: ContributionPayloadView;
  status: TrustStatus;
  note: string;
  at: string;
}

function publishNew(db: Database, { row, payload, status, at }: ApproveContext): Published {
  const sport = db.query("SELECT id FROM sports WHERE slug = ?").get(payload.sport) as { id: string } | null;
  if (sport === null) throw new ModerationRefusedError("unknown_sport", `Unknown sport "${payload.sport}"`);
  const skill = db.query("SELECT id FROM skills WHERE slug = ? AND sport_id = ?").get(payload.skill, sport.id) as { id: string } | null;
  if (skill === null) throw new ModerationRefusedError("unknown_skill", `Unknown skill "${payload.skill}" in sport "${payload.sport}"`);

  const locale = payload.locale;
  const texts = (text: string): LocalizedText[] => lines(text).map((line) => ({ [locale]: line }));
  const content = validContent({
    title: { [locale]: payload.name.trim() },
    goal: { [locale]: GOAL_LABELS[payload.goal][locale] },
    instructions: { [locale]: numbered(payload.instructions) },
    dose: { durationSec: payload.durationMin * 60 },
    mistakes: texts(payload.mistakes),
    progressions: texts(payload.progression),
    regressions: texts(payload.regression),
    conditions: { equipment: payload.equipment, spaces: [SPACE_FOR[payload.equipment]], partner: false, ageMin: payload.ageMin, ageMax: payload.ageMax },
    safety: texts(payload.safety),
    media: attachedMedia(db, row.id),
  });

  const slug = freeSlug(db, payload.name);
  const semver = "1.0.0";
  const versionId = `${slug}-v${semver}`;
  db.query("INSERT INTO drills (id, slug, sport_id, current_version_id, created_at) VALUES (?, ?, ?, NULL, ?)").run(slug, slug, sport.id, at);
  insertVersion(db, { id: versionId, drillId: slug, semver, parentId: null, status, content, payload, authorUserId: row.submitter_user_id, changeSummary: null, at });
  db.query("INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES (?, ?, 1)").run(slug, skill.id);
  db.query("UPDATE drills SET current_version_id = ? WHERE id = ?").run(versionId, slug);
  return { drillId: slug, slug, versionId, fromStatus: "COMMUNITY" };
}

function publishImprovement(db: Database, { row, payload, status, note, at }: ApproveContext, kind: string | null): Published {
  const current = row.target_drill_id === null ? null : currentVersion(db, "d.id", row.target_drill_id);
  if (current === null) throw new DrillNotFoundError(row.target_drill_id ?? "");

  const old = DrillContent.parse(JSON.parse(current.content));
  const locale = payload.locale;
  const content = validContent({
    ...old,
    title: withLocale(old.title, locale, payload.name.trim()),
    instructions: withLocale(old.instructions, locale, numbered(payload.instructions)),
    dose: payload.durationMin === current.minutes ? old.dose : { durationSec: payload.durationMin * 60 },
    mistakes: mergeList(old.mistakes, lines(payload.mistakes), locale),
    progressions: mergeList(old.progressions, lines(payload.progression), locale),
    regressions: mergeList(old.regressions, lines(payload.regression), locale),
    conditions: { ...old.conditions, equipment: payload.equipment, ageMin: payload.ageMin, ageMax: payload.ageMax },
    safety: mergeList(old.safety, lines(payload.safety), locale),
    media: [...old.media, ...attachedMedia(db, row.id)],
  });

  const semver = nextMinor(db, current.drill_id, current.semver);
  const versionId = `${current.drill_id}-v${semver}`;
  const changeSummary = ["Improvement", kind === null ? "" : ` (${kind})`, note === "" ? "" : `: ${note}`].join("");
  insertVersion(db, {
    id: versionId,
    drillId: current.drill_id,
    semver,
    parentId: current.version_id,
    status,
    content,
    payload,
    authorUserId: row.submitter_user_id,
    changeSummary,
    at,
  });
  db.query("UPDATE drills SET current_version_id = ? WHERE id = ?").run(versionId, current.drill_id);
  return { drillId: current.drill_id, slug: current.slug, versionId, fromStatus: current.status };
}

/**
 * Applies an admin's decision to a contribution. approve runs the whole publish in ONE transaction (see
 * the header); reject and request_changes store the note. Throws ContributionNotFoundError (unknown id),
 * IllegalTransitionError (the state does not accept the action), ModerationRefusedError (a note or an
 * orgLabel is missing, an edit is invalid, the sport or skill does not exist) and DrillNotFoundError (an
 * improvement's drill is gone); every throw leaves the database untouched.
 */
export function decide(db: Database, admin: Admin, contributionId: string, decision: DecisionRequest, opts: ModerationOptions = {}): DecisionResponse {
  const reviewer = reviewerOf(admin);
  const now = opts.now?.() ?? new Date();
  const note = clean(decision.note);
  const orgLabel = clean(decision.orgLabel);

  return db
    .transaction((): DecisionResponse => {
      const row = db
        .query("SELECT id, kind, target_drill_id, payload, state, submitter_user_id, created_at FROM contributions WHERE id = ?")
        .get(contributionId) as ContributionRow | null;
      if (row === null) throw new ContributionNotFoundError();
      if (!canTransition(row.state, TARGET_STATE[decision.action])) throw new IllegalTransitionError(row.state, decision.action);

      // updated_at may not precede created_at (a schema CHECK), whatever the clock says.
      const at = now.toISOString();
      const updatedAt = at < row.created_at ? row.created_at : at;
      const reviewerNote = note === "" ? null : note;

      if (decision.action !== "approve") {
        if (note === "") throw new ModerationRefusedError("note_required", `A note is required to ${decision.action === "reject" ? "reject" : "request changes"}`);
        db.query("UPDATE contributions SET state = ?, reviewer_note = ?, updated_at = ? WHERE id = ?").run(TARGET_STATE[decision.action], reviewerNote, updatedAt, row.id);
        return { contribution: getForOwner(db, row.submitter_user_id, row.id)! };
      }

      // The trust rules of an admin change (./transitions): a VERIFIED status needs a note (shared/admin),
      // ACADEMY_VERIFIED an orgLabel, REVIEWED and above a named reviewer (reviewerOf guarantees one).
      // Not checkStatusChange: it also demands a note for REVIEWED, which an approval does not need.
      const status = decision.status ?? DEFAULT_DECISION_STATUS;
      if (isVerifiedStatus(status) && note === "") throw new ModerationRefusedError("note_required", "A note is required to approve with a verified status");
      if (status === "ACADEMY_VERIFIED" && orgLabel === "") throw new ModerationRefusedError("org_label_required", "An orgLabel is required for ACADEMY_VERIFIED");

      const stored = JSON.parse(row.payload) as Record<string, unknown>;
      const edited = applyEdits(stored, row.kind, decision.edits);
      const parsed = ContributionPayloadView.safeParse(edited);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ModerationRefusedError("invalid_edit", `The edited payload is not valid: /${issue?.path.join("/") ?? ""} ${issue?.message ?? ""}`.trim());
      }
      const payload = parsed.data;
      if (payload.ageMax < payload.ageMin) {
        throw new ModerationRefusedError("invalid_edit", `ageMax (${payload.ageMax}) must not be smaller than ageMin (${payload.ageMin})`);
      }

      const context: ApproveContext = { row, payload, status, note, at };
      const published =
        row.kind === "new"
          ? publishNew(db, context)
          : publishImprovement(db, context, typeof stored.improvementKind === "string" ? stored.improvementKind : null);
      insertReview(db, { versionId: published.versionId, reviewer, reviewerUserId: admin.id, orgLabel, from: published.fromStatus, to: status, note, at });
      db.query(
        `UPDATE contributions
            SET state = 'approved', reviewer_note = ?, resulting_drill_id = ?, payload = ?, content_hash = ?, updated_at = ?
          WHERE id = ?`,
      ).run(reviewerNote, published.drillId, JSON.stringify(edited), contentHash(edited as ContributionPayloadRequest), updatedAt, row.id);

      return {
        contribution: getForOwner(db, row.submitter_user_id, row.id)!,
        drill: detailOf(db, published.slug, opts.locale ?? payload.locale),
      };
    })
    .immediate();
}

// --- setStatus and unpublish -----------------------------------------------------------------

/**
 * Changes the trust status of a drill's CURRENT version (older versions keep theirs) and writes the
 * reviews row. The rules are ./transitions checkStatusChange (the status must change, a note is
 * required, ACADEMY_VERIFIED needs an orgLabel); a broken one throws ModerationRefusedError. An unknown
 * or unpublished drill throws DrillNotFoundError.
 */
export function setStatus(db: Database, admin: Admin, slug: string, request: DrillStatusRequest, opts: ModerationOptions = {}): DrillDetail {
  const reviewer = reviewerOf(admin);
  const at = (opts.now?.() ?? new Date()).toISOString();
  const note = clean(request.note);
  const orgLabel = clean(request.orgLabel);

  return db
    .transaction((): DrillDetail => {
      const current = currentVersion(db, "d.slug", slug);
      if (current === null) throw new DrillNotFoundError(slug);
      const check = checkStatusChange({ from: current.status, to: request.toStatus, note, reviewer, orgLabel });
      if (!check.ok) throw new ModerationRefusedError(check.reason, `The status change is refused: ${check.reason}`);

      // The only column of drill_versions a trust decision may change (the immutability trigger allows it).
      db.query("UPDATE drill_versions SET status = ? WHERE id = ?").run(request.toStatus, current.version_id);
      insertReview(db, { versionId: current.version_id, reviewer, reviewerUserId: admin.id, orgLabel, from: current.status, to: request.toStatus, note, at });
      return detailOf(db, slug, opts.locale ?? DEFAULT_LOCALE);
    })
    .immediate();
}

/**
 * Hides a drill from the commons (unpublished_at), keeping every version row, and writes a reviews row
 * on its current version with the reason as the note and the status unchanged. Returns the detail as it
 * was published, with the new reviews row (DrillDetail has no unpublished marker; reading the slug
 * afterwards finds nothing). A blank reason throws ModerationRefusedError; an unknown or already
 * unpublished drill DrillNotFoundError.
 */
export function unpublish(db: Database, admin: Admin, slug: string, request: UnpublishRequest, opts: ModerationOptions = {}): DrillDetail {
  const reviewer = reviewerOf(admin);
  const at = (opts.now?.() ?? new Date()).toISOString();
  const reason = clean(request.reason);
  if (reason === "") throw new ModerationRefusedError("reason_required", "A reason is required to unpublish a drill");

  return db
    .transaction((): DrillDetail => {
      const current = currentVersion(db, "d.slug", slug);
      if (current === null) throw new DrillNotFoundError(slug);
      insertReview(db, { versionId: current.version_id, reviewer, reviewerUserId: admin.id, orgLabel: "", from: current.status, to: current.status, note: reason, at });
      // Built while the drill is still published: getDrill answers null for an unpublished one.
      const detail = detailOf(db, slug, opts.locale ?? DEFAULT_LOCALE);
      db.query("UPDATE drills SET unpublished_at = ? WHERE id = ?").run(at, current.drill_id);
      return detail;
    })
    .immediate();
}
