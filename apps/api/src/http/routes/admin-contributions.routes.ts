// GET /api/admin/contributions and POST /api/admin/contributions/:id/decision (fc-mol-0v3.4): the moderation
// queue and the admin's decision on one contribution (`listContributions`, `decideContribution`).
//
// AUTH (the moderation service trusts its caller and checks no role, ban or anonymous flag; this route is
// where that is enforced)
//   - BOTH routes sit behind requireAdmin, which runs BEFORE the query or the body is read: no session is a
//     401, an anonymous player, a plain contributor (the submitter included), a banned account and a role that
//     is not exactly "admin" are a 403, whatever the request holds, and none of them reaches the service;
//   - the acting admin is the SESSION's user (`c.var.user`: id and name) and nothing else. The body has no
//     field that names a reviewer; a key that tries (reviewer, adminId, ...) is an unknown key and a 422.
//
// THE DECISION BODY IS STRICT. The contract's `edits` is ContributionPayloadBase.partial(), which also admits
// keys the service never takes from an admin. Here `edits` is narrowed to what the service really applies,
// and a key it would silently drop is a 422 instead (an edit that reports success but changes nothing is a
// lie to the reviewer):
//   - for EVERY kind: kind, targetDrillSlug, improvementKind, locale, author, the attestations and the honeypot
//     are not editable (what and where the coach wrote, who wrote it, what they attested): the body schema
//     refuses them, as it refuses any unknown key;
//   - for an IMPROVEMENT also sport, skill and goal: the drill's place in the graph does not change (the
//     service locks sport and skill) and the drill keeps its own goal text (moderation never reads the
//     payload's goal for an improvement). A NEW contribution may edit all three. This is the one check that
//     needs the contribution's kind, so it reads it AFTER requireAdmin, the JSON parse and the schema, and
//     before the service; an unknown id adds nothing here and stays the service's 404.
// The note rules are the contract's own DecisionRequest refinement. A body that breaks any of it is a 422 with
// `errors: [{ pointer, detail }]` (JSON Pointers as in problem.ts; an unknown or locked key gets its own
// pointer, "/edits/author", "/edits/sport", "/reviewer"), every offending key reported at once, and the
// service is never called, so nothing unknown can reach contributions.payload. A body that is not a JSON
// object is a 400.
//
// DECISION ANSWERS
//   200 {contribution, drill?}  approve returns the created or improved DrillDetail in the same response;
//   404  no such contribution (or the improvement's drill is gone: the service's DrillNotFoundError);
//   409  the contribution's state does not accept the action (illegal transition);
//   422  a broken request rule: /note, /orgLabel, /edits (an invalid edit), /edits/sport, /edits/skill.
// Anything else (a database error, a bug) is not caught here: the app's error handler answers 500.
//
// THE QUEUE (readings the criteria leave open)
//   - `state` omitted lists every state (the contract says unfiltered); oldest first (created_at, id), so the
//     head of the queue is the one that has waited longest. A repeated or unknown `state`, or any other query
//     key, is a 422.
//   - `submitter.name` is the account's name; an erased account has none, and the payload's own `author`
//     stands in, so the row is never blank.
//   - `diff` is present for an improvement whose target drill is published and whose contribution is not yet
//     approved (once approved its change IS the current version, so a diff would be empty). It is
//     diffAgainstCurrent against the target's current version in the payload's locale. The payload's `goal`
//     is left out: the drill stores its goal as text, an improvement never changes it (moderation keeps it),
//     so there is nothing comparable. A missing `before` or `after` (a field the drill lacks, or that the
//     improvement blanks) is `null` on the wire: the contract's DiffEntry keys are required, and JSON drops
//     an `undefined`.
//   - `duplicateOf` is the id of the oldest OTHER contribution (any submitter, any state) with the same
//     content hash (findDuplicates), so a suspected duplicate is flagged on both rows.
import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requireAdmin } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { diffAgainstCurrent } from "../../contributions/diff";
import type { CurrentVersion } from "../../contributions/diff";
import { DrillNotFoundError, IllegalTransitionError, ModerationRefusedError, decide } from "../../contributions/moderation";
import type { ModerationRefusal } from "../../contributions/moderation";
import { ContributionNotFoundError, findDuplicates, getForOwner } from "../../contributions/repo";
import { ContributionListQuery, DecisionRequest, DecisionRequestBase, ENDPOINTS } from "../../shared/admin";
import type { DiffEntry, ModerationQueueItem } from "../../shared/admin";
import { ContributionParams, ContributionPayloadBase } from "../../shared/contributions";
import type { ContributionKind, ContributionState } from "../../shared/contributions";
import { DrillContent } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

// --- the strict body ---------------------------------------------------------------------------

/**
 * Payload keys an admin may NOT set through `edits` (what and where the coach wrote, who wrote it, what they
 * attested): the same keys the moderation service ignores. Written out (not derived) so the mask is typed.
 */
const NOT_EDITABLE = {
  kind: true,
  targetDrillSlug: true,
  improvementKind: true,
  locale: true,
  author: true,
  rightsAttested: true,
  noCommercialContent: true,
  website: true,
} as const;

/** The contract's request with `edits` narrowed to the content fields (still a strict object: unknown keys fail). */
const StrictDecisionRequest = DecisionRequestBase.extend({
  edits: ContributionPayloadBase.partial().omit(NOT_EDITABLE).optional(),
});

/**
 * The keys the service ignores for an improvement on top of NOT_EDITABLE (moderation.ts IMPROVEMENT_NOT_EDITABLE
 * locks sport and skill; goal is never read for an improvement). Allowed for a new contribution.
 */
const IMPROVEMENT_LOCKED = ["sport", "skill", "goal"] as const;

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] }))
        : [issue],
    ),
  );
}

/**
 * The issues of the strict shape and of the contract's note rules together, without a repeated (pointer,
 * detail), plus, for an improvement, one issue per locked key the edits carry (unless the schema already
 * refused that very key).
 */
function bodyIssues(body: object, kind: ContributionKind | null): ZodError | null {
  const shape = StrictDecisionRequest.safeParse(body);
  const contract = DecisionRequest.safeParse(body);
  const issues = [...(shape.success ? [] : shape.error.issues), ...(contract.success ? [] : contract.error.issues)];

  const edits = (body as { edits?: unknown }).edits;
  if (kind === "improvement" && typeof edits === "object" && edits !== null && !Array.isArray(edits)) {
    for (const key of IMPROVEMENT_LOCKED) {
      if ((edits as Record<string, unknown>)[key] === undefined) continue;
      if (issues.some((issue) => issue.path.length === 2 && issue.path[0] === "edits" && issue.path[1] === key)) continue;
      issues.push({
        code: "custom",
        path: ["edits", key],
        message: `"${key}" cannot be edited on an improvement: the drill keeps its own`,
      });
    }
  }
  if (issues.length === 0) return null;
  const seen = new Set<string>();
  const unique = expandUnknownKeys(new ZodError(issues)).issues.filter((issue) => {
    const key = `${issue.path.join("/")}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return new ZodError(unique);
}

/** The kind of a contribution, or null for an unknown id (the service answers that with its own 404). */
function kindOf(db: Database, id: string): ContributionKind | null {
  const row = db.query("SELECT kind FROM contributions WHERE id = ?").get(id) as { kind: ContributionKind } | null;
  return row === null ? null : row.kind;
}

// --- the queue ---------------------------------------------------------------------------------

interface QueueRow {
  id: string;
  kind: "new" | "improvement";
  state: ContributionState;
  content_hash: string;
  submitter_user_id: string;
  target_drill_id: string | null;
  submitter_name: string | null;
}

interface CurrentRow {
  content: string;
  level: string;
  minutes: number;
  author_name: string;
  source: string;
  source_url: string | null;
}

/** The current version of a PUBLISHED drill, with every locale of its text, or null. */
function currentVersionOf(db: Database, drillId: string): CurrentVersion | null {
  const row = db
    .query(
      `SELECT v.content AS content, v.level AS level, v.minutes AS minutes, v.author_name AS author_name,
              v.source AS source, v.source_url AS source_url
         FROM drills d JOIN drill_versions v ON v.id = d.current_version_id
        WHERE d.id = ? AND d.unpublished_at IS NULL`,
    )
    .get(drillId) as CurrentRow | null;
  if (row === null) return null;
  const content = DrillContent.safeParse(JSON.parse(row.content));
  if (!content.success) return null;
  return {
    content: content.data,
    level: row.level as CurrentVersion["level"],
    minutes: row.minutes,
    attribution: { author: row.author_name, source: row.source, ...(row.source_url === null ? {} : { sourceUrl: row.source_url }) },
  };
}

function queueItems(db: Database, state: ContributionState | undefined): ModerationQueueItem[] {
  return db.transaction((): ModerationQueueItem[] => {
    const rows = db
      .query(
        `SELECT c.id, c.kind, c.state, c.content_hash, c.submitter_user_id, c.target_drill_id, u.name AS submitter_name
           FROM contributions c LEFT JOIN "user" u ON u.id = c.submitter_user_id
          WHERE (? IS NULL OR c.state = ?)
          ORDER BY c.created_at, c.id`,
      )
      .all(state ?? null, state ?? null) as QueueRow[];

    return rows.map((row): ModerationQueueItem => {
      const contribution = getForOwner(db, row.submitter_user_id, row.id)!;
      const name = row.submitter_name ?? contribution.payload.author;

      let diff: DiffEntry[] | undefined;
      if (row.kind === "improvement" && row.state !== "approved" && row.target_drill_id !== null) {
        const current = currentVersionOf(db, row.target_drill_id);
        if (current !== null) {
          const { goal: _goal, ...payload } = contribution.payload;
          // JSON drops an `undefined`, and the contract's DiffEntry needs both keys present: no value is null.
          diff = diffAgainstCurrent(current, payload, contribution.payload.locale).map((entry) => ({
            field: entry.field,
            before: entry.before ?? null,
            after: entry.after ?? null,
          }));
        }
      }
      const duplicateOf = findDuplicates(db, row.content_hash, row.id)[0];

      return {
        contribution,
        submitter: { id: row.submitter_user_id, name },
        ...(diff === undefined ? {} : { diff }),
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
      };
    });
  })();
}

// --- refusals -> pointers ---------------------------------------------------------------------

const POINTERS: Readonly<Record<ModerationRefusal, string>> = {
  note_required: "/note",
  org_label_required: "/orgLabel",
  reason_required: "/note",
  reviewer_required: "",
  same_status: "/status",
  invalid_edit: "/edits",
  unknown_sport: "/edits/sport",
  unknown_skill: "/edits/skill",
};

// --- the module -------------------------------------------------------------------------------

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this
  // holds whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const admin = requireAdmin(deps);
  const { db } = deps;

  app.get(ENDPOINTS.listContributions.path, admin, (c) => {
    // A repeated key stays an array, so the strict schema refuses it.
    const query: Record<string, string | string[]> = {};
    for (const [key, values] of Object.entries(c.req.queries())) query[key] = values.length === 1 ? values[0]! : values;

    const parsed = ContributionListQuery.safeParse(query);
    if (!parsed.success) {
      return problem(
        422,
        "Unprocessable Entity",
        "The query is not valid.",
        fromZodError(expandUnknownKeys(parsed.error)),
      );
    }
    return c.json(queueItems(db, parsed.data.state), 200);
  });

  app.post(ENDPOINTS.decideContribution.path, admin, async (c: Context<{ Variables: AuthVariables }>) => {
    const params = ContributionParams.safeParse({ id: c.req.param("id") });
    if (!params.success) return problem(404, "Not Found", "No such contribution.");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    const invalid = bodyIssues(body, kindOf(db, params.data.id));
    if (invalid !== null) {
      return problem(422, "Unprocessable Entity", "The decision was not saved: the request is not valid.", fromZodError(invalid));
    }
    // Parsed by the strict shape: only known keys, only editable edits.
    const decision = StrictDecisionRequest.parse(body);

    // The admin is the session's user, never anything from the request.
    const { user } = c.var;
    try {
      return c.json(decide(db, { id: user.id, name: user.name }, params.data.id, decision), 200);
    } catch (error) {
      if (error instanceof ContributionNotFoundError) return problem(404, "Not Found", "No such contribution.");
      if (error instanceof DrillNotFoundError) return problem(404, "Not Found", "The drill this contribution improves no longer exists.");
      if (error instanceof IllegalTransitionError) {
        return problem(409, "Conflict", `A ${error.state} contribution cannot be ${error.action === "approve" ? "approved" : error.action === "reject" ? "rejected" : "sent back for changes"}.`);
      }
      if (error instanceof ModerationRefusedError) {
        return problem(422, "Unprocessable Entity", error.message, [{ pointer: POINTERS[error.reason], detail: error.message }]);
      }
      throw error;
    }
  });
}
