// Abuse guards for POST /api/contributions (fc-mol-4ds.4). Three cheap checks that run BEFORE any
// uploaded byte is stored, so a rejected request leaves nothing on disk and nothing in the database.
//
//   1. the per-user daily limiter: `contributionLimiter` is auth/rate-limit's `contribution` rule (the
//      numbers live in RATE_LIMITS, not here). Mounted after the session guard and before the body is
//      read: a limited caller costs no parsing. Every request that reaches it uses a unit of budget,
//      including one that a later guard rejects, so probing costs the caller.
//   2. the honeypot: the payload's `website` field is invisible to humans and must be empty. Any other
//      value (a URL, a space, null, a number) is a filled trap. The answer is a generic 422 on /website,
//      the same for every value, decided on the raw payload BEFORE the rest of it is judged, so a bot
//      learns nothing about the other fields and nothing is stored.
//   3. the duplicate: the same user's contribution that is still undecided (pending or
//      changes_requested, the states the owner can edit) with the same content hash is a 409 problem that
//      points at the existing one (`instance` is its URL, `contributionId` its id). Decided (approved,
//      rejected, withdrawn) contributions and other users' are never duplicates: a second person
//      submitting the same drill is the moderator's concern (repo.findDuplicates), not a bounce.
//
// The duplicate check runs twice in the route: once before the files are stored (the cheap early exit)
// and once in the same synchronous step as the insert (a concurrent identical request that got past the
// first check cannot both be written; the files stored for the loser are purged by the route).
import type { Database } from "bun:sqlite";
import { rateLimit } from "../auth/rate-limit";
import type { RateLimitOptions } from "../auth/rate-limit";
import { ENDPOINTS, EDITABLE_STATES } from "../shared/contributions";
import type { ContributionPayloadRequest } from "../shared/contributions";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import { problem } from "../http/problem";
import { contentHash } from "./repo";

// --- limiter ---------------------------------------------------------------------------------------

/** The per-user daily limit of POST /api/contributions (RATE_LIMITS.contribution), 429 + Retry-After. */
export const contributionLimiter = (options?: RateLimitOptions) => rateLimit("contribution", options);

// --- honeypot --------------------------------------------------------------------------------------

/** The contract's honeypot field (ContributionPayloadRequest.website). */
const HONEYPOT_FIELD = "website";

/** True when the trap holds anything but the empty string a human's untouched field sends. */
export function honeypotFilled(raw: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(raw, HONEYPOT_FIELD) && raw[HONEYPOT_FIELD] !== "";
}

/** The generic 422 for a filled honeypot, or undefined when it is empty. Nothing about the trap is named. */
export function rejectHoneypot(raw: Readonly<Record<string, unknown>>): Response | undefined {
  if (!honeypotFilled(raw)) return undefined;
  return problem(422, "Unprocessable Entity", "The contribution was not saved: some values are invalid.", [
    { pointer: `/${HONEYPOT_FIELD}`, detail: "Invalid value." },
  ]);
}

// --- duplicate -------------------------------------------------------------------------------------

/** The caller already has an undecided contribution with exactly this content. */
export class DuplicateContributionError extends Error {
  readonly existingId: string;

  constructor(existingId: string) {
    super(`An identical contribution is already awaiting a decision: ${existingId}`);
    this.name = "DuplicateContributionError";
    this.existingId = existingId;
  }
}

const UNDECIDED_PLACEHOLDERS = EDITABLE_STATES.map(() => "?").join(", ");

/**
 * The id of the caller's OLDEST undecided contribution whose content hash equals this payload's, or null.
 * Only the caller's own rows are looked at: another user's id is never returned.
 */
export function findOwnDuplicate(db: Database, userId: string, payload: ContributionPayloadRequest): string | null {
  const row = db
    .query(
      `SELECT id FROM contributions
        WHERE submitter_user_id = ? AND content_hash = ? AND state IN (${UNDECIDED_PLACEHOLDERS})
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(userId, contentHash(payload), ...EDITABLE_STATES) as { id: string } | null;
  return row === null ? null : row.id;
}

/** Throws DuplicateContributionError when findOwnDuplicate finds one. */
export function assertNotOwnDuplicate(db: Database, userId: string, payload: ContributionPayloadRequest): void {
  const existing = findOwnDuplicate(db, userId, payload);
  if (existing !== null) throw new DuplicateContributionError(existing);
}

/** The 409 problem that points at the existing contribution. */
export function duplicateProblem(existingId: string): Response {
  const body = {
    type: "about:blank",
    title: "Conflict",
    status: 409,
    detail: `You already have an identical contribution awaiting a decision (${existingId}). Edit that one instead.`,
    instance: `${ENDPOINTS.createContribution.path}/${existingId}`,
    contributionId: existingId,
  };
  return new Response(JSON.stringify(body), { status: 409, headers: { "content-type": PROBLEM_CONTENT_TYPE } });
}
