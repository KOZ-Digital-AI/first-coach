// Contract: admin moderates contributions and curates trust in the commons (fc-mol-oby).
//
// Serves: the moderation queue, the contribution review screen, the drill admin actions
// (change trust status, unpublish), the impact page and the admin settings screen (web,
// through the @api-types alias). Bundled into the browser: imports ONLY "zod",
// "./primitives", "./domain" and, because this slice depends on them, "./contributions"
// and "./commons" (schemas reused, never redefined: Contribution, DrillDetail).
//
// Call budget: one decision is 1 call (POST .../decision returns the updated contribution
// and, on approval, the drill). The queue list carries each full payload, so a review needs
// no second call. Mutations return the updated resource.
//
// Errors on every endpoint are ProblemDetails (RFC 9457, ./primitives); not redeclared here.
//
// Conventions: requests are strict objects, responses are plain objects (unknown server
// keys are stripped). Cross-field note rules are `.superRefine` on the REQUEST only; Zod 4
// throws on `.pick()/.partial()` of a refined object, so the unrefined base is exported too.
//
// Gate-tested, NOT parse-tested (a schema parse cannot prove them): the call budget; that
// only an admin may call these endpoints (auth is enforced by the API); that the allowed
// transitions are enforced server-side (the tables below only let the UI hide illegal
// actions); that an omitted decision `status` becomes DEFAULT_DECISION_STATUS on the server.
//
// DERIVED, not fixed by the criteria (marked again where they are defined): VERIFIED_STATUSES,
// duplicateOf, ImpactMetrics.byWeek, both transition tables, and that `Settings` has no
// field list.
import { z } from "zod";
import { CalendarDate, Count } from "./domain";
import type { EndpointSpec } from "./domain";
import { DrillDetail, DrillParams } from "./commons";
import { Contribution, ContributionParams, ContributionPayloadBase } from "./contributions";
import type { ContributionState } from "./contributions";
import { EntityId, TrustStatus } from "./primitives";

// --- Trust statuses -------------------------------------------------------------------------

/**
 * Derived: the statuses that certify a method (a qualified expert or an organisation), as
 * opposed to REVIEWED (checked by a coach) and COMMUNITY. primitives has no "verified"
 * notion of its own; these are exactly the *_VERIFIED names.
 */
export const VERIFIED_STATUSES = ["EXPERT_VERIFIED", "ACADEMY_VERIFIED"] as const satisfies readonly TrustStatus[];

export function isVerifiedStatus(status: TrustStatus): boolean {
  return (VERIFIED_STATUSES as readonly TrustStatus[]).includes(status);
}

/**
 * What the server uses when a decision omits `status` (criteria: "default COMMUNITY"). A
 * server constant, not a schema default: a `.default()` would mask an omitted field.
 */
export const DEFAULT_DECISION_STATUS = "COMMUNITY" satisfies TrustStatus;

/** A string that is not empty and not only whitespace. */
const NonBlankString = z.string().refine((value) => value.trim() !== "", {
  error: "Must not be blank",
});

// --- GET /api/admin/contributions?state ---------------------------------------------------------

/** The four states the queue can be filtered by (criteria); `withdrawn` never appears there. */
export const QUEUE_STATES = [
  "pending",
  "changes_requested",
  "approved",
  "rejected",
] as const satisfies readonly ContributionState[];
export const QueueState = z.enum(QUEUE_STATES);
export type QueueState = z.infer<typeof QueueState>;

export const ContributionListQuery = z.strictObject({ state: QueueState.optional() });
export type ContributionListQuery = z.infer<typeof ContributionListQuery>;

/** One changed field of an improvement; `before` and `after` can be any JSON value. */
export const DiffEntry = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type DiffEntry = z.infer<typeof DiffEntry>;

/**
 * One queue row. `contribution` carries its full payload. `diff` is present for
 * improvements. `duplicateOf` (derived: the id or slug of the existing entry this looks like)
 * is present when the server suspects a duplicate.
 */
export const ModerationQueueItem = z.object({
  contribution: Contribution,
  submitter: z.object({ id: EntityId, name: z.string() }),
  diff: z.array(DiffEntry).optional(),
  duplicateOf: EntityId.optional(),
});
export type ModerationQueueItem = z.infer<typeof ModerationQueueItem>;

/** A bare array (criteria), like the coach's own list. */
export const ModerationQueueResponse = z.array(ModerationQueueItem);
export type ModerationQueueResponse = z.infer<typeof ModerationQueueResponse>;

// --- POST /api/admin/contributions/:id/decision ----------------------------------------------------

export const DECISION_ACTIONS = ["approve", "reject", "request_changes"] as const;
export const DecisionAction = z.enum(DECISION_ACTIONS);
export type DecisionAction = z.infer<typeof DecisionAction>;

/**
 * UNREFINED request base. `edits` is the contribution payload base made partial, so an
 * admin may correct any field. `status` is optional: an omitted one is
 * DEFAULT_DECISION_STATUS on the server. `orgLabel` is a free label (for example the
 * organisation behind a verification).
 */
export const DecisionRequestBase = z.strictObject({
  action: DecisionAction,
  note: z.string().optional(),
  edits: ContributionPayloadBase.partial().optional(),
  status: TrustStatus.optional(),
  orgLabel: z.string().optional(),
});

/**
 * The note rules (criteria): reject and request_changes need a non-blank note, and so does
 * approving with a VERIFIED status. Approving with no note and a non-verified status is fine.
 */
export const DecisionRequest = DecisionRequestBase.superRefine((decision, ctx) => {
  const blank = decision.note === undefined || decision.note.trim() === "";
  if (!blank) return;
  const needsNote =
    decision.action === "reject" ||
    decision.action === "request_changes" ||
    (decision.status !== undefined && isVerifiedStatus(decision.status));
  if (needsNote) {
    ctx.addIssue({
      code: "custom",
      path: ["note"],
      message: "A note is required to reject, request changes or approve with a verified status",
    });
  }
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

/** `drill` is present when the decision published or updated one (an approval). */
export const DecisionResponse = z.object({
  contribution: Contribution,
  drill: DrillDetail.optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

// --- POST /api/admin/drills/:slug/status and /unpublish ----------------------------------------------

/**
 * `note` is REQUIRED and non-blank (criteria list it without `?`), which also covers
 * "a VERIFIED status requires a note" on this endpoint.
 */
export const DrillStatusRequest = z.strictObject({
  toStatus: TrustStatus,
  orgLabel: z.string().optional(),
  note: NonBlankString,
});
export type DrillStatusRequest = z.infer<typeof DrillStatusRequest>;

export const UnpublishRequest = z.strictObject({ reason: NonBlankString });
export type UnpublishRequest = z.infer<typeof UnpublishRequest>;

// --- GET /api/admin/impact ---------------------------------------------------------------------------------

/** Derived: one week of the trend. `weekStart` is the week's first calendar day. */
export const ImpactWeek = z.object({
  weekStart: CalendarDate,
  sessionsCompleted: Count,
  activePlayers: Count,
});
export type ImpactWeek = z.infer<typeof ImpactWeek>;

/**
 * `medianImprovementPct` may be negative (a median can be a regression) but is always a
 * finite number. `trainingHours` is a non-negative number, not a count (hours can be fractional).
 */
export const ImpactMetrics = z.object({
  playersWithBaseline: Count,
  playersRetested: Count,
  medianImprovementPct: z.number(),
  sessionsCompleted: Count,
  trainingHours: z.number().nonnegative(),
  activeContributors: Count,
  verifiedCoaches: Count,
  openMethodologies: Count,
  byWeek: z.array(ImpactWeek),
});
export type ImpactMetrics = z.infer<typeof ImpactMetrics>;

// --- GET|PUT /api/admin/settings ---------------------------------------------------------------------------

/**
 * The criteria name an "admin settings screen" but no fields, and nothing in the repo
 * (PRODUCT.md, DESIGN.md, first-coach-demo.html, the sibling contracts) names a
 * configurable value. So the field list is fixed by the settings bead; until then this is a
 * loose object that keeps whatever keys the server sends, in both directions.
 */
export const Settings = z.looseObject({});
export type Settings = z.infer<typeof Settings>;

// --- Allowed transitions, exported as data so the UI renders only legal actions ---------------------------

/**
 * Derived from the moderation flow: which decision actions a contribution in each state
 * accepts. A pending contribution can be approved, rejected or sent back; one that already
 * awaits changes cannot be sent back again; approved, rejected and withdrawn are terminal.
 * The server enforces it; the UI hides the buttons.
 */
export const CONTRIBUTION_TRANSITIONS: Readonly<Record<ContributionState, readonly DecisionAction[]>> = {
  pending: ["approve", "reject", "request_changes"],
  changes_requested: ["approve", "reject"],
  approved: [],
  rejected: [],
  withdrawn: [],
};

/**
 * Derived (conservative) from the trust ladder COMMUNITY < REVIEWED < EXPERT_VERIFIED <
 * ACADEMY_VERIFIED: a real coach must review a method before it is marked VERIFIED, so
 * COMMUNITY moves up to REVIEWED only; REVIEWED moves up to either verified status; a status
 * can always be revoked to any lower one; no status transitions to itself. The server
 * enforces it; the UI hides the actions.
 */
export const STATUS_TRANSITIONS: Readonly<Record<TrustStatus, readonly TrustStatus[]>> = {
  COMMUNITY: ["REVIEWED"],
  REVIEWED: ["EXPERT_VERIFIED", "ACADEMY_VERIFIED", "COMMUNITY"],
  EXPERT_VERIFIED: ["ACADEMY_VERIFIED", "REVIEWED", "COMMUNITY"],
  ACADEMY_VERIFIED: ["EXPERT_VERIFIED", "REVIEWED", "COMMUNITY"],
};

// --- Endpoints (none is public) ---------------------------------------------------------------------------------

export const ENDPOINTS = {
  listContributions: {
    method: "GET",
    path: "/api/admin/contributions",
    query: ContributionListQuery,
    response: ModerationQueueResponse,
  },
  decideContribution: {
    method: "POST",
    path: "/api/admin/contributions/:id/decision",
    params: ContributionParams,
    request: DecisionRequest,
    response: DecisionResponse,
  },
  setDrillStatus: {
    method: "POST",
    path: "/api/admin/drills/:slug/status",
    params: DrillParams,
    request: DrillStatusRequest,
    response: DrillDetail,
  },
  unpublishDrill: {
    method: "POST",
    path: "/api/admin/drills/:slug/unpublish",
    params: DrillParams,
    request: UnpublishRequest,
    response: DrillDetail,
  },
  getImpact: {
    method: "GET",
    path: "/api/admin/impact",
    response: ImpactMetrics,
  },
  getSettings: {
    method: "GET",
    path: "/api/admin/settings",
    response: Settings,
  },
  putSettings: {
    method: "PUT",
    path: "/api/admin/settings",
    request: Settings,
    response: Settings,
  },
} as const satisfies Record<string, EndpointSpec>;
