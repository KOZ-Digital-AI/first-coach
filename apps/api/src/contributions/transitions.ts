// Contribution moderation state machine and trust-status change rules (fc-mol-0v3.1).
//
// PURE: no db, no http, no I/O, no clock, no randomness. The server calls the guards;
// the tables are plain frozen data the client can receive as they are. They agree with
// the client-facing tables in ../shared/admin (CONTRIBUTION_TRANSITIONS, STATUS_TRANSITIONS).
import type { ContributionState } from "../shared/contributions";
import type { TrustStatus } from "../shared/primitives";

// --- Contribution state machine ------------------------------------------------------------

/**
 * Legal moves per state. pending goes to changes_requested, approved, rejected or withdrawn;
 * changes_requested goes back to pending (resubmit) or to withdrawn; approved, rejected and
 * withdrawn are final. Everything else, including staying in the same state, is illegal.
 */
export const CONTRIBUTION_MACHINE: Readonly<Record<ContributionState, readonly ContributionState[]>> = Object.freeze({
  pending: Object.freeze<ContributionState[]>(["changes_requested", "approved", "rejected", "withdrawn"]),
  changes_requested: Object.freeze<ContributionState[]>(["pending", "withdrawn"]),
  approved: Object.freeze<ContributionState[]>([]),
  rejected: Object.freeze<ContributionState[]>([]),
  withdrawn: Object.freeze<ContributionState[]>([]),
});

export function canTransition(from: ContributionState, to: ContributionState): boolean {
  return CONTRIBUTION_MACHINE[from].includes(to);
}

// --- Trust-status changes -----------------------------------------------------------------

/** Targets that need a named reviewer: REVIEWED and above. */
const REVIEWER_TARGETS: readonly TrustStatus[] = ["REVIEWED", "EXPERT_VERIFIED", "ACADEMY_VERIFIED"];

/** Targets that need an orgLabel. */
const ORG_LABEL_TARGETS: readonly TrustStatus[] = ["ACADEMY_VERIFIED"];

/** Any status may move to any other status; staying in the same status is not a change. */
export function canChangeStatus(from: TrustStatus, to: TrustStatus): boolean {
  return from !== to;
}

export interface StatusChangeInput {
  readonly from: TrustStatus;
  readonly to: TrustStatus;
  /** Always required for an admin change. */
  readonly note: string;
  /** The acting reviewer's name; required for REVIEWED and above. Supplied by the server. */
  readonly reviewer?: string | undefined;
  /** Required for ACADEMY_VERIFIED. */
  readonly orgLabel?: string | undefined;
}

export type StatusChangeRefusal = "same_status" | "note_required" | "reviewer_required" | "org_label_required";

export type StatusChangeResult = { readonly ok: true } | { readonly ok: false; readonly reason: StatusChangeRefusal };

const isBlank = (value: string | undefined): boolean => typeof value !== "string" || value.trim() === "";

/** First failing rule wins: same status, then note, then reviewer, then orgLabel. */
export function checkStatusChange(input: StatusChangeInput): StatusChangeResult {
  if (!canChangeStatus(input.from, input.to)) return { ok: false, reason: "same_status" };
  if (isBlank(input.note)) return { ok: false, reason: "note_required" };
  if (REVIEWER_TARGETS.includes(input.to) && isBlank(input.reviewer)) return { ok: false, reason: "reviewer_required" };
  if (ORG_LABEL_TARGETS.includes(input.to) && isBlank(input.orgLabel)) return { ok: false, reason: "org_label_required" };
  return { ok: true };
}
