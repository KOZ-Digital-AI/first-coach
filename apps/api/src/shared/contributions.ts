// Contract: coach contributes a method and follows its review (fc-mol-ffm).
//
// Serves the contribute form, "My contributions" and the suggest-improvement dialog.
// Errors on every endpoint are ProblemDetails (see ./primitives), with per-field
// pointers into the payload (`/name`, `/targetDrillSlug`, ...); not redeclared here.
//
// Transport: POST /api/contributions and PUT /api/contributions/:id are multipart
// (`payload` JSON field + optional `video` + up to 3 `files`, ONE request). Multipart is
// not a schema concern: the JSON `payload` part is validated by ContributionPayloadRequest;
// the file parts are checked by the server against `upload` from the meta response.
//
// Call budget: submitting a contribution with a video is <= 2 calls (GET meta + POST create).
//
// Gate-tested, NOT parse-tested (a schema parse cannot prove them): the call budget; the
// upload limits (file count, size, mime types of the actual files); honeypot handling on the
// server (a filled `website` is rejected or silently dropped there); "PUT only in
// changes_requested or pending" (state gating, see EDITABLE_STATES); DELETE as a withdraw;
// that mutations return the updated resource; `ageMax >= ageMin` (the criteria do not state
// it, so the schema does not refine it; the server validates it).
//
// This module is bundled into the browser through the @api-types alias, so it imports
// ONLY "zod", "./primitives" and "./domain". Consumers must use `import type` for
// type-only names (verbatimModuleSyntax).
import { z } from "zod";
import { Count, Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";
import {
  EntityId,
  Equipment,
  ExperienceLevel,
  Goal,
  LICENSE_IDS,
  Locale,
  LocalizedText,
  MediaKind,
  Space,
} from "./primitives";

// --- Fixed lists the criteria name ------------------------------------------------------

export const IMPROVEMENT_KINDS = [
  "explanation",
  "progression",
  "simpler_variant",
  "age_adaptation",
  "translation",
  "video",
  "accessibility",
  "safety",
] as const;
export const ImprovementKind = z.enum(IMPROVEMENT_KINDS);
export type ImprovementKind = z.infer<typeof ImprovementKind>;

/** The upload types the criteria name. The meta response may list more (the server can add types). */
export const UPLOAD_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;

export const CONTRIBUTION_KINDS = ["new", "improvement"] as const;
export const ContributionKind = z.enum(CONTRIBUTION_KINDS);
export type ContributionKind = z.infer<typeof ContributionKind>;

export const CONTRIBUTION_STATES = ["pending", "changes_requested", "approved", "rejected", "withdrawn"] as const;
export const ContributionState = z.enum(CONTRIBUTION_STATES);
export type ContributionState = z.infer<typeof ContributionState>;

/** The owner may edit (PUT) only in these states. The server enforces it; the UI hides the button. */
export const EDITABLE_STATES = ["changes_requested", "pending"] as const satisfies readonly ContributionState[];

// --- GET /api/contribute/meta?locale ------------------------------------------------------

export const ContributionMetaQuery = z.strictObject({ locale: Locale.optional() });
export type ContributionMetaQuery = z.infer<typeof ContributionMetaQuery>;

export const SportOption = z.object({ slug: EntityId, name: LocalizedText });
export type SportOption = z.infer<typeof SportOption>;

/** One node of the skills tree; `children` recurses through a getter (lazy). */
export const SkillOption = z.object({
  slug: EntityId,
  name: LocalizedText,
  get children() {
    return z.array(SkillOption);
  },
});
export type SkillOption = z.infer<typeof SkillOption>;

export const ContributionMeta = z.object({
  sports: z.array(SportOption).min(1),
  skills: z.array(SkillOption),
  levels: z.array(ExperienceLevel),
  equipment: z.array(Equipment),
  spaces: z.array(Space),
  licenses: z.array(z.enum(LICENSE_IDS)),
  improvementKinds: z.array(ImprovementKind),
  upload: z.object({
    maxMb: z.number().positive(),
    mimeTypes: z.array(z.string().min(1)).min(1),
  }),
});
export type ContributionMeta = z.infer<typeof ContributionMeta>;

// --- The contribution payload -----------------------------------------------------------------

/**
 * The content fields, shared by the request and the response view. `goal` uses the
 * primitives' Goal enum (an unconfirmed guess: the criteria say only "goal"). `mistakes`,
 * `progression`, `regression` and `safety` are required keys that MAY be blank (the form
 * does not mark them required). `ageMin`/`ageMax` are non-negative integers.
 */
const ContributionPayloadShape = {
  kind: ContributionKind,
  targetDrillSlug: EntityId.optional(),
  improvementKind: ImprovementKind.optional(),
  locale: Locale,
  name: z.string().min(1),
  sport: EntityId,
  skill: EntityId,
  ageMin: Count,
  ageMax: Count,
  level: ExperienceLevel,
  goal: Goal,
  instructions: z.string().min(1),
  durationMin: z.int().positive(),
  equipment: Equipment,
  mistakes: z.string(),
  progression: z.string(),
  regression: z.string(),
  safety: z.string(),
  source: z.string().min(1),
  sourceUrl: z.httpUrl().optional(),
  author: z.string().min(1),
};

/**
 * REQUEST base, UNREFINED so `.pick()`/`.partial()` keep working (Zod 4 throws on a refined
 * object). Adds the two attestations (must be `true`) and the honeypot `website` (must be
 * empty or absent: humans never see it).
 */
export const ContributionPayloadBase = z.strictObject({
  ...ContributionPayloadShape,
  rightsAttested: z.literal(true),
  noCommercialContent: z.literal(true),
  website: z.literal("").optional(),
});

/** POST/PUT `payload` part. An improvement must name the drill it improves. */
export const ContributionPayloadRequest = ContributionPayloadBase.refine(
  (payload) => payload.kind !== "improvement" || payload.targetDrillSlug !== undefined,
  { path: ["targetDrillSlug"], error: "An improvement must name the drill it improves" },
);
export type ContributionPayloadRequest = z.infer<typeof ContributionPayloadRequest>;

/**
 * RESPONSE view of a stored payload: loose and refinement-free (no attestations, no
 * honeypot, no improvement rule; unknown server keys are stripped) so an additive server
 * change or an older stored payload cannot fail the parse.
 */
export const ContributionPayloadView = z.object(ContributionPayloadShape);
export type ContributionPayloadView = z.infer<typeof ContributionPayloadView>;

// --- Contribution (the resource every endpoint returns) ------------------------------------------

/** Only `id`, `kind` and `url` are guaranteed; a missing filename/mimeType/size must not fail. */
export const ContributionAttachment = z.object({
  id: EntityId,
  kind: MediaKind,
  url: z.string().min(1),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  /** Bytes. */
  size: Count.optional(),
});
export type ContributionAttachment = z.infer<typeof ContributionAttachment>;

export const Contribution = z.object({
  id: EntityId,
  state: ContributionState,
  payload: ContributionPayloadView,
  attachments: z.array(ContributionAttachment),
  reviewerNote: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  resultingDrillSlug: EntityId.optional(),
});
export type Contribution = z.infer<typeof Contribution>;

/** GET /api/contributions/mine: a bare array (criteria). */
export const MyContributionsResponse = z.array(Contribution);
export type MyContributionsResponse = z.infer<typeof MyContributionsResponse>;

export const ContributionParams = z.strictObject({ id: EntityId });
export type ContributionParams = z.infer<typeof ContributionParams>;

// --- Endpoints ---------------------------------------------------------------------------------

export const ENDPOINTS = {
  getMeta: {
    method: "GET",
    path: "/api/contribute/meta",
    query: ContributionMetaQuery,
    response: ContributionMeta,
  },
  createContribution: {
    method: "POST",
    path: "/api/contributions",
    request: ContributionPayloadRequest,
    contentType: "multipart/form-data",
    response: Contribution,
  },
  listMine: {
    method: "GET",
    path: "/api/contributions/mine",
    response: MyContributionsResponse,
  },
  updateContribution: {
    method: "PUT",
    path: "/api/contributions/:id",
    params: ContributionParams,
    request: ContributionPayloadRequest,
    contentType: "multipart/form-data",
    response: Contribution,
  },
  withdrawContribution: {
    method: "DELETE",
    path: "/api/contributions/:id",
    params: ContributionParams,
    response: Contribution,
  },
} as const satisfies Record<string, EndpointSpec>;
