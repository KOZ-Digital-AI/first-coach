// Contract: player controls their data and privacy (fc-mol-l5e).
//
// Serves the privacy settings screen (consents, recovery code, export, delete)
// and the restore screen (recover). Consumed at RUNTIME by the web through the
// `@api-types/*` alias, so this module imports ONLY "zod", "./primitives" and
// "./domain" (no node/bun APIs, no side effects).
//
// Call budget: every action is 1 call, and every mutation returns the updated
// resource (PUT consents returns Consents, recover returns profile + roadmap).
//
// Errors on every endpoint are ProblemDetails (primitives); it is never redeclared here.
//
// Conventions: requests are strict objects, responses are plain objects (unknown
// server keys are stripped, so additive server changes never break cached PWA
// clients). The 4x4 recovery-code FORMAT is pinned on the REQUEST only: the
// response carries no regex, because a server format that differed would fail
// the parse AFTER the shown-once code had already replaced the old one.
//
// Gate-tested rather than parse-tested: the code being shown once and replacing
// an earlier one, the 422 that does not reveal whether a code exists, the rate
// limit on recover, the 204 ending the session, and export completeness.
import { z } from "zod";
import { PlayerProfileView, Roadmap, Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";

// --- GET|PUT /api/player/consents ------------------------------------------------------------

export const Consents = z.object({
  videoAnalysis: z.object({
    granted: z.boolean(),
    at: Timestamp.optional(),
    guardianConfirmed: z.boolean().optional(),
  }),
  modelImprovement: z.object({
    granted: z.boolean(),
    at: Timestamp.optional(),
  }),
});
export type Consents = z.infer<typeof Consents>;

/** What a player who never chose has: everything off. A server constant, not a schema default. */
export const DEFAULT_CONSENTS: Consents = {
  videoAnalysis: { granted: false },
  modelImprovement: { granted: false },
};

/** Booleans: true grants, false revokes, an omitted key is left as it is. */
export const UpdateConsentsRequest = z.strictObject({
  videoAnalysis: z.boolean().optional(),
  modelImprovement: z.boolean().optional(),
  guardianConfirmed: z.boolean().optional(),
});
export type UpdateConsentsRequest = z.infer<typeof UpdateConsentsRequest>;

/** Players younger than this need a guardian to grant video analysis. */
const GUARDIAN_REQUIRED_BELOW_AGE = 13;

/**
 * The under-13 rule. The player's age is not in the request, so the caller supplies it.
 * Under 13, granting videoAnalysis needs `guardianConfirmed === true` in the same
 * request. Revocation is always allowed, and nothing else is gated.
 */
export function isConsentUpdateAllowed(age: number, update: UpdateConsentsRequest): boolean {
  if (age < GUARDIAN_REQUIRED_BELOW_AGE && update.videoAnalysis === true) {
    return update.guardianConfirmed === true;
  }
  return true;
}

// --- POST /api/player/recovery-code ----------------------------------------------------------

/** Shown once, and it replaces any earlier code. The format is not re-checked here (see the header). */
export const RecoveryCodeResponse = z.object({ code: z.string().min(1), createdAt: Timestamp });
export type RecoveryCodeResponse = z.infer<typeof RecoveryCodeResponse>;

// --- POST /api/player/recover ----------------------------------------------------------------

/** Canonical recovery code: four groups of four upper-case letters or digits, hyphen separated. */
export const RECOVERY_CODE_PATTERN = /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/;

/**
 * Turns what a player typed into the canonical form: whitespace and hyphens are
 * dropped, letters are upper-cased, and the rest is regrouped in fours. It does
 * NOT validate: a wrong length or a stray symbol survives, so the pattern rejects it.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1-");
}

/** `code` is normalised first, so the parsed output is always the canonical form. */
export const RecoverRequest = z.strictObject({
  code: z
    .string()
    .trim()
    .transform(normalizeRecoveryCode)
    .pipe(z.string().regex(RECOVERY_CODE_PATTERN, { error: "Expected 4 groups of 4 letters or digits" })),
});
export type RecoverRequest = z.infer<typeof RecoverRequest>;

/** `roadmap` is null when the recovered player had reset their plan (as in the journey slice's ResetPlan). */
export const RecoverResponse = z.object({ profile: PlayerProfileView, roadmap: Roadmap.nullable() });
export type RecoverResponse = z.infer<typeof RecoverResponse>;

// --- GET /api/player/export ------------------------------------------------------------------

/** A JSON download of everything stored about the player; its content is not fixed by this contract. */
export const PlayerExport = z.looseObject({});
export type PlayerExport = z.infer<typeof PlayerExport>;

// --- Endpoints (DELETE /api/player answers 204 with no body) ---------------------------------

export const ENDPOINTS = {
  getConsents: {
    method: "GET",
    path: "/api/player/consents",
    response: Consents,
  },
  updateConsents: {
    method: "PUT",
    path: "/api/player/consents",
    request: UpdateConsentsRequest,
    response: Consents,
  },
  createRecoveryCode: {
    method: "POST",
    path: "/api/player/recovery-code",
    response: RecoveryCodeResponse,
  },
  // Not public: the player has no session yet, so the client signs in anonymously first
  // and recover moves the recovered data to that session.
  recover: {
    method: "POST",
    path: "/api/player/recover",
    request: RecoverRequest,
    response: RecoverResponse,
  },
  exportPlayer: {
    method: "GET",
    path: "/api/player/export",
    response: PlayerExport,
    contentType: "application/json",
  },
  deletePlayer: {
    method: "DELETE",
    path: "/api/player",
    status: 204,
  },
} as const satisfies Record<string, EndpointSpec>;
