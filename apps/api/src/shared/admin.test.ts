import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  CONTRIBUTION_TRANSITIONS,
  ContributionListQuery,
  DEFAULT_DECISION_STATUS,
  DECISION_ACTIONS,
  DecisionRequest,
  DecisionRequestBase,
  DecisionResponse,
  DrillStatusRequest,
  ENDPOINTS,
  ImpactMetrics,
  ModerationQueueItem,
  ModerationQueueResponse,
  QUEUE_STATES,
  STATUS_TRANSITIONS,
  Settings,
  UnpublishRequest,
  VERIFIED_STATUSES,
  isVerifiedStatus,
} from "./admin";
import { ContributionParams, ContributionState } from "./contributions";
import type { ContributionState as ContributionStateName } from "./contributions";
import { DrillDetail, DrillParams } from "./commons";
import { TRUST_STATUSES, TrustStatus } from "./primitives";
import type { TrustStatus as TrustStatusName } from "./primitives";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const firstPath = (schema: z.ZodType, value: unknown): PropertyKey[] | undefined => {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.path;
};

const AT = "2026-09-21T08:00:00Z";

// --- Local factories: realistic payloads, fresh objects per call, one field varied per case ----

/** A stored payload as the server returns it (no attestations, no honeypot). */
const makeStoredPayload = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "new",
  locale: "ru",
  name: "Слалом через 5 ворот",
  sport: "football",
  skill: "dribbling",
  ageMin: 8,
  ageMax: 14,
  level: "beginner",
  goal: "dribbling",
  instructions: "Поставьте пять ворот на расстоянии 1,5-2 м и проведите мяч обеими ногами.",
  durationMin: 7,
  equipment: "cones",
  mistakes: "Мяч далеко от тела.",
  progression: "Засеките время.",
  regression: "Увеличьте расстояние между воротами.",
  safety: "Разминка перед началом.",
  source: "Собственная методика",
  author: "Айгүл Т.",
  ...patch,
});

const makeContribution = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c-1",
  state: "pending",
  payload: makeStoredPayload(),
  attachments: [{ id: "a-1", kind: "video", url: "/media/a-1.mp4" }],
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

const makeDrillDetail = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "five-gate-slalom",
  versionId: "five-gate-slalom-v2",
  content: {
    goal: { en: "Close control while turning" },
    instructions: { en: "Dribble through five gates using both feet." },
    dose: { durationSec: 60 },
    conditions: { equipment: "cones", spaces: ["yard", "field"] },
  },
  attribution: {
    author: "Aigul T.",
    source: "Own methodology",
    license: "CC-BY-SA-4.0",
    createdAt: AT,
    semver: "1.1.0",
  },
  history: [{ versionId: "five-gate-slalom-v1", semver: "1.0.0", createdAt: AT }],
  reviews: [
    {
      reviewer: "A. Coach",
      orgLabel: "Kairat Academy",
      from: "COMMUNITY",
      to: "REVIEWED",
      note: "Checked the safety notes.",
      at: AT,
    },
  ],
  ...patch,
});

const makeQueueItem = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  contribution: makeContribution(),
  submitter: { id: "u-7", name: "Айгүл Т." },
  ...patch,
});

const makeDiff = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  field: "durationMin",
  before: 5,
  after: 7,
  ...patch,
});

/** A valid approve decision; `patch` varies one field per case. */
const makeDecision = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "approve",
  ...patch,
});

const makeDrillStatus = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  toStatus: "REVIEWED",
  note: "Проверил тренер: упражнение безопасно для детей 8-14 лет.",
  ...patch,
});

const makeImpact = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  playersWithBaseline: 1240,
  playersRetested: 310,
  medianImprovementPct: 18.5,
  sessionsCompleted: 9120,
  trainingHours: 2280.5,
  activeContributors: 14,
  verifiedCoaches: 3,
  openMethodologies: 24,
  byWeek: [
    { weekStart: "2026-09-07", sessionsCompleted: 410 },
    { weekStart: "2026-09-14", sessionsCompleted: 455 },
  ],
  ...patch,
});

const IMPACT_COUNT_KEYS = [
  "playersWithBaseline",
  "playersRetested",
  "sessionsCompleted",
  "activeContributors",
  "verifiedCoaches",
  "openMethodologies",
];

// --- Trust statuses: which ones need a note --------------------------------------------------------

describe("VERIFIED_STATUSES", () => {
  test.each([...VERIFIED_STATUSES])("%s is a TrustStatus", (status) => {
    expect(ok(TrustStatus, status)).toBe(true);
  });

  test("every trust status named *_VERIFIED is in the list (drift guard)", () => {
    const verifiedByName = TRUST_STATUSES.filter((status) => status.endsWith("_VERIFIED"));
    expect(verifiedByName.length).toBeGreaterThan(0);
    const verified: readonly string[] = VERIFIED_STATUSES;
    for (const status of verifiedByName) expect(verified).toContain(status);
  });

  test.each(["EXPERT_VERIFIED", "ACADEMY_VERIFIED"])("isVerifiedStatus(%p) is true", (status) => {
    expect(isVerifiedStatus(status as TrustStatusName)).toBe(true);
  });

  test.each(["COMMUNITY", "REVIEWED"])("isVerifiedStatus(%p) is false (not a verification)", (status) => {
    expect(isVerifiedStatus(status as TrustStatusName)).toBe(false);
  });
});

describe("DEFAULT_DECISION_STATUS", () => {
  test("is COMMUNITY, as the criteria say", () => {
    expect(DEFAULT_DECISION_STATUS).toBe("COMMUNITY");
  });

  test("is a valid TrustStatus that needs no note to approve with", () => {
    expect(ok(TrustStatus, DEFAULT_DECISION_STATUS)).toBe(true);
    expect(isVerifiedStatus(DEFAULT_DECISION_STATUS)).toBe(false);
  });

  test("is a server default: the schema does not bake it in", () => {
    expect(DecisionRequest.parse(makeDecision()).status).toBeUndefined();
  });
});

// --- POST /api/admin/contributions/:id/decision (request) ---------------------------------------------

describe("DecisionRequest success", () => {
  test("approve with nothing else parses", () => {
    expect(DecisionRequest.parse(makeDecision()).action).toBe("approve");
  });

  test.each(["COMMUNITY", "REVIEWED"])("approve as %s needs no note", (status) => {
    expect(ok(DecisionRequest, makeDecision({ status }))).toBe(true);
  });

  test("a full decision keeps note, edits, status and orgLabel", () => {
    const parsed = DecisionRequest.parse(
      makeDecision({
        note: "Отличное упражнение.",
        edits: { name: "Слалом через 5 ворот (правка)", durationMin: 8 },
        status: "EXPERT_VERIFIED",
        orgLabel: "FC Kairat Academy",
      }),
    );
    expect(parsed.note).toBe("Отличное упражнение.");
    expect(parsed.edits).toEqual({ name: "Слалом через 5 ворот (правка)", durationMin: 8 });
    expect(parsed.status).toBe("EXPERT_VERIFIED");
    expect(parsed.orgLabel).toBe("FC Kairat Academy");
  });

  test("reject with a note parses", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "reject", note: "Дублирует существующее упражнение." }))).toBe(
      true,
    );
  });

  test("request_changes with a note parses", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "request_changes", note: "Добавьте меры безопасности." }))).toBe(
      true,
    );
  });

  test.each([...VERIFIED_STATUSES])("approve as %s with a note parses", (status) => {
    expect(ok(DecisionRequest, makeDecision({ status, note: "Проверено квалифицированным экспертом." }))).toBe(true);
  });
});

describe("DecisionRequest: reject requires a note", () => {
  test("reject without a note fails, pointed at note", () => {
    const decision = makeDecision({ action: "reject" });
    expect(ok(DecisionRequest, decision)).toBe(false);
    expect(firstPath(DecisionRequest, decision)).toEqual(["note"]);
  });

  test("reject with an empty note fails", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "reject", note: "" }))).toBe(false);
  });

  test("reject with a whitespace-only note fails", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "reject", note: " \n\t " }))).toBe(false);
  });
});

describe("DecisionRequest: request_changes requires a note", () => {
  test("request_changes without a note fails, pointed at note", () => {
    const decision = makeDecision({ action: "request_changes" });
    expect(ok(DecisionRequest, decision)).toBe(false);
    expect(firstPath(DecisionRequest, decision)).toEqual(["note"]);
  });

  test("request_changes with an empty note fails", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "request_changes", note: "" }))).toBe(false);
  });

  test("request_changes with a whitespace-only note fails", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "request_changes", note: "   " }))).toBe(false);
  });
});

describe("DecisionRequest: a VERIFIED status requires a note", () => {
  test.each([...VERIFIED_STATUSES])("approve as %s without a note fails, pointed at note", (status) => {
    const decision = makeDecision({ status });
    expect(ok(DecisionRequest, decision)).toBe(false);
    expect(firstPath(DecisionRequest, decision)).toEqual(["note"]);
  });

  test.each([...VERIFIED_STATUSES])("approve as %s with an empty note fails", (status) => {
    expect(ok(DecisionRequest, makeDecision({ status, note: "" }))).toBe(false);
  });

  test.each([...VERIFIED_STATUSES])("approve as %s with a whitespace-only note fails", (status) => {
    expect(ok(DecisionRequest, makeDecision({ status, note: "  " }))).toBe(false);
  });
});

describe("DecisionRequest fields", () => {
  test("action is required", () => {
    expect(ok(DecisionRequest, without(makeDecision(), "action"))).toBe(false);
  });

  test("an unknown action fails", () => {
    expect(ok(DecisionRequest, makeDecision({ action: "publish" }))).toBe(false);
  });

  test.each([...DECISION_ACTIONS])("accepts action %p (with a note)", (action) => {
    expect(ok(DecisionRequest, makeDecision({ action, note: "ok" }))).toBe(true);
  });

  test("an unknown status fails", () => {
    expect(ok(DecisionRequest, makeDecision({ status: "GOLD" }))).toBe(false);
  });

  test("note is a string, not null", () => {
    expect(ok(DecisionRequest, makeDecision({ note: null }))).toBe(false);
  });

  test("orgLabel is an optional string", () => {
    expect(ok(DecisionRequest, makeDecision({ orgLabel: "FC Kairat Academy" }))).toBe(true);
    expect(ok(DecisionRequest, makeDecision({ orgLabel: 5 }))).toBe(false);
  });

  test("rejects an unknown key in a request (strict)", () => {
    expect(ok(DecisionRequest, makeDecision({ state: "approved" }))).toBe(false);
  });
});

describe("DecisionRequest edits (Partial<ContributionPayload>)", () => {
  test("a single edited field parses (the rest of the payload is not required)", () => {
    expect(ok(DecisionRequest, makeDecision({ edits: { durationMin: 9 } }))).toBe(true);
  });

  test("an empty edits object parses", () => {
    expect(ok(DecisionRequest, makeDecision({ edits: {} }))).toBe(true);
  });

  test("an edited field is still validated (durationMin: 0 fails)", () => {
    expect(ok(DecisionRequest, makeDecision({ edits: { durationMin: 0 } }))).toBe(false);
  });

  test("an edited enum is still validated (level: expert fails)", () => {
    expect(ok(DecisionRequest, makeDecision({ edits: { level: "expert" } }))).toBe(false);
  });

  test("an unknown key inside edits fails (strict payload)", () => {
    expect(ok(DecisionRequest, makeDecision({ edits: { reviewScore: 4 } }))).toBe(false);
  });

  test("the failing edits field is pointed at with a path into edits", () => {
    expect(firstPath(DecisionRequest, makeDecision({ edits: { durationMin: 0 } }))).toEqual(["edits", "durationMin"]);
  });
});

describe("DecisionRequestBase", () => {
  test("is unrefined: it carries no note rule", () => {
    expect(ok(DecisionRequestBase, makeDecision({ action: "reject" }))).toBe(true);
  });

  test("stays composable (pick works on the unrefined base)", () => {
    expect(() => DecisionRequestBase.pick({ action: true })).not.toThrow();
  });
});

// --- POST /api/admin/drills/:slug/status (request) ------------------------------------------------------

describe("DrillStatusRequest", () => {
  test("parses a status change with a note", () => {
    const parsed = DrillStatusRequest.parse(makeDrillStatus());
    expect(parsed.toStatus).toBe("REVIEWED");
    expect(parsed.note).toContain("Проверил тренер");
  });

  test("orgLabel is optional and kept when present", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus())).toBe(true);
    const parsed = DrillStatusRequest.parse(
      makeDrillStatus({ toStatus: "ACADEMY_VERIFIED", orgLabel: "FC Kairat Academy" }),
    );
    expect(parsed.orgLabel).toBe("FC Kairat Academy");
  });

  test("a missing note fails, pointed at note", () => {
    const request = without(makeDrillStatus(), "note");
    expect(ok(DrillStatusRequest, request)).toBe(false);
    expect(firstPath(DrillStatusRequest, request)).toEqual(["note"]);
  });

  test("an empty note fails", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ note: "" }))).toBe(false);
  });

  test("a whitespace-only note fails", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ note: " \t " }))).toBe(false);
  });

  test.each([...VERIFIED_STATUSES])("setting %s without a note fails, pointed at note", (toStatus) => {
    const request = without(makeDrillStatus({ toStatus }), "note");
    expect(ok(DrillStatusRequest, request)).toBe(false);
    expect(firstPath(DrillStatusRequest, request)).toEqual(["note"]);
  });

  test.each([...VERIFIED_STATUSES])("setting %s with a note parses", (toStatus) => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ toStatus, note: "Подтверждено экспертом." }))).toBe(true);
  });

  test("toStatus is required", () => {
    expect(ok(DrillStatusRequest, without(makeDrillStatus(), "toStatus"))).toBe(false);
  });

  test("an unknown toStatus fails", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ toStatus: "GOLD" }))).toBe(false);
  });

  test("orgLabel is a string, not a number", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ orgLabel: 5 }))).toBe(false);
  });

  test("rejects an unknown key in a request (strict)", () => {
    expect(ok(DrillStatusRequest, makeDrillStatus({ status: "REVIEWED" }))).toBe(false);
  });
});

// --- POST /api/admin/drills/:slug/unpublish (request) ---------------------------------------------------------

describe("UnpublishRequest", () => {
  test("parses a reason", () => {
    expect(UnpublishRequest.parse({ reason: "Нарушает лицензию." }).reason).toBe("Нарушает лицензию.");
  });

  test("a missing reason fails, pointed at reason", () => {
    expect(ok(UnpublishRequest, {})).toBe(false);
    expect(firstPath(UnpublishRequest, {})).toEqual(["reason"]);
  });

  test("an empty reason fails", () => {
    expect(ok(UnpublishRequest, { reason: "" })).toBe(false);
  });

  test("a whitespace-only reason fails", () => {
    expect(ok(UnpublishRequest, { reason: "  \n " })).toBe(false);
  });

  test("rejects an unknown key in a request (strict)", () => {
    expect(ok(UnpublishRequest, { reason: "Нарушает лицензию.", note: "x" })).toBe(false);
  });
});

// --- GET /api/admin/contributions?state (query + queue) -------------------------------------------------------

describe("ContributionListQuery", () => {
  test("state is optional", () => {
    expect(ok(ContributionListQuery, {})).toBe(true);
  });

  test.each([...QUEUE_STATES])("accepts state=%s", (state) => {
    expect(ContributionListQuery.parse({ state }).state).toBe(state);
  });

  test("withdrawn is not a queue state", () => {
    expect(ok(ContributionListQuery, { state: "withdrawn" })).toBe(false);
  });

  test("an unknown state fails", () => {
    expect(ok(ContributionListQuery, { state: "draft" })).toBe(false);
  });

  test("rejects an unknown key (strict)", () => {
    expect(ok(ContributionListQuery, { status: "pending" })).toBe(false);
  });
});

describe("QUEUE_STATES", () => {
  test("are exactly the four the criteria name", () => {
    expect([...QUEUE_STATES]).toEqual(["pending", "changes_requested", "approved", "rejected"]);
  });

  test.each([...QUEUE_STATES])("%s is a ContributionState", (state) => {
    expect(ok(ContributionState, state)).toBe(true);
  });
});

describe("ModerationQueueItem", () => {
  test("parses a new contribution with its full payload and submitter", () => {
    const parsed = ModerationQueueItem.parse(makeQueueItem());
    expect(parsed.contribution.id).toBe("c-1");
    expect(parsed.contribution.payload.name).toBe("Слалом через 5 ворот");
    expect(parsed.submitter).toEqual({ id: "u-7", name: "Айгүл Т." });
  });

  test("diff and duplicateOf are optional", () => {
    const parsed = ModerationQueueItem.parse(makeQueueItem());
    expect(parsed.diff).toBeUndefined();
    expect(parsed.duplicateOf).toBeUndefined();
  });

  test("an improvement carries its diff, kept as sent", () => {
    const diff = [makeDiff(), makeDiff({ field: "name", before: "Слалом", after: "Слалом через 5 ворот" })];
    const parsed = ModerationQueueItem.parse(makeQueueItem({ diff }));
    expect<unknown>(parsed.diff).toEqual(diff);
  });

  test("an empty diff parses", () => {
    expect(ModerationQueueItem.parse(makeQueueItem({ diff: [] })).diff).toEqual([]);
  });

  test.each([
    ["a string", "Слалом"],
    ["a number", 7],
    ["null", null],
    ["an object", { ru: "Слалом", en: "Slalom" }],
    ["an array", ["cones", "ball"]],
  ])("a diff before/after may be %s", (_label, value) => {
    const parsed = ModerationQueueItem.parse(makeQueueItem({ diff: [makeDiff({ before: value, after: value })] }));
    expect(parsed.diff?.[0]?.before).toEqual(value);
    expect(parsed.diff?.[0]?.after).toEqual(value);
  });

  test("a diff entry without a field fails", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ diff: [without(makeDiff(), "field")] }))).toBe(false);
  });

  test("duplicateOf is kept when present", () => {
    expect(ModerationQueueItem.parse(makeQueueItem({ duplicateOf: "five-gate-slalom" })).duplicateOf).toBe(
      "five-gate-slalom",
    );
  });

  test("duplicateOf must be an id, not a number", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ duplicateOf: 5 }))).toBe(false);
  });

  test("the contribution is required", () => {
    expect(ok(ModerationQueueItem, without(makeQueueItem(), "contribution"))).toBe(false);
  });

  test("the submitter is required", () => {
    expect(ok(ModerationQueueItem, without(makeQueueItem(), "submitter"))).toBe(false);
  });

  test("a submitter without an id fails", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ submitter: { name: "Айгүл Т." } }))).toBe(false);
  });

  test("a submitter without a name fails", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ submitter: { id: "u-7" } }))).toBe(false);
  });

  test("a submitter id that is not an EntityId fails", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ submitter: { id: "bad id", name: "Айгүл Т." } }))).toBe(false);
  });

  test("the contribution is validated (an unknown state fails)", () => {
    expect(ok(ModerationQueueItem, makeQueueItem({ contribution: makeContribution({ state: "draft" }) }))).toBe(false);
  });

  test("unknown server keys are stripped from the item and the submitter", () => {
    const parsed = ModerationQueueItem.parse(
      makeQueueItem({ internalScore: 3, submitter: { id: "u-7", name: "Айгүл Т.", email: "a@example.org" } }),
    );
    expect(parsed).not.toHaveProperty("internalScore");
    expect(parsed.submitter).not.toHaveProperty("email");
  });
});

describe("ModerationQueueResponse", () => {
  test("is a bare array of queue items", () => {
    expect(ok(ModerationQueueResponse, [makeQueueItem(), makeQueueItem({ duplicateOf: "x-1" })])).toBe(true);
  });

  test("an empty queue parses", () => {
    expect(ok(ModerationQueueResponse, [])).toBe(true);
  });

  test("an envelope object is not a bare array", () => {
    expect(ok(ModerationQueueResponse, { items: [makeQueueItem()] })).toBe(false);
  });

  test("one bad item fails the list", () => {
    expect(ok(ModerationQueueResponse, [makeQueueItem(), without(makeQueueItem(), "submitter")])).toBe(false);
  });
});

// --- Decision response ------------------------------------------------------------------------------------------

describe("DecisionResponse", () => {
  test("parses the updated contribution without a drill (reject / request_changes)", () => {
    const parsed = DecisionResponse.parse({ contribution: makeContribution({ state: "rejected" }) });
    expect(parsed.contribution.state).toBe("rejected");
    expect(parsed.drill).toBeUndefined();
  });

  test("an approval carries the published drill", () => {
    const parsed = DecisionResponse.parse({
      contribution: makeContribution({ state: "approved", resultingDrillSlug: "five-gate-slalom" }),
      drill: makeDrillDetail(),
    });
    expect(parsed.drill?.slug).toBe("five-gate-slalom");
    expect(parsed.contribution.resultingDrillSlug).toBe("five-gate-slalom");
  });

  test("the contribution is required", () => {
    expect(ok(DecisionResponse, { drill: makeDrillDetail() })).toBe(false);
  });

  test("the drill is validated (a missing versionId fails)", () => {
    expect(
      ok(DecisionResponse, {
        contribution: makeContribution(),
        drill: without(makeDrillDetail(), "versionId"),
      }),
    ).toBe(false);
  });

  test("drill is absent, not null", () => {
    expect(ok(DecisionResponse, { contribution: makeContribution(), drill: null })).toBe(false);
  });

  test("an unknown server key is stripped", () => {
    expect(DecisionResponse.parse({ contribution: makeContribution(), auditId: "x" })).not.toHaveProperty("auditId");
  });
});

// --- GET /api/admin/impact --------------------------------------------------------------------------------------

describe("ImpactMetrics", () => {
  test("parses a realistic metrics payload", () => {
    const parsed = ImpactMetrics.parse(makeImpact());
    expect(parsed.playersWithBaseline).toBe(1240);
    expect(parsed.medianImprovementPct).toBe(18.5);
    expect(parsed.trainingHours).toBe(2280.5);
    expect<unknown>(parsed.byWeek[1]).toEqual({ weekStart: "2026-09-14", sessionsCompleted: 455 });
  });

  test("a negative median improvement is legitimate", () => {
    expect(ImpactMetrics.parse(makeImpact({ medianImprovementPct: -4.2 })).medianImprovementPct).toBe(-4.2);
  });

  test("a zero median improvement parses", () => {
    expect(ok(ImpactMetrics, makeImpact({ medianImprovementPct: 0 }))).toBe(true);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "medianImprovementPct: %p fails (must be finite)",
    (medianImprovementPct) => {
      expect(ok(ImpactMetrics, makeImpact({ medianImprovementPct }))).toBe(false);
    },
  );

  test("trainingHours may be fractional", () => {
    expect(ok(ImpactMetrics, makeImpact({ trainingHours: 0.5 }))).toBe(true);
  });

  test("trainingHours: negative fails", () => {
    expect(ok(ImpactMetrics, makeImpact({ trainingHours: -1 }))).toBe(false);
  });

  test.each(IMPACT_COUNT_KEYS)("%s: a negative count fails", (key) => {
    expect(ok(ImpactMetrics, makeImpact({ [key]: -1 }))).toBe(false);
  });

  test.each(IMPACT_COUNT_KEYS)("%s: a fractional count fails", (key) => {
    expect(ok(ImpactMetrics, makeImpact({ [key]: 1.5 }))).toBe(false);
  });

  test.each(IMPACT_COUNT_KEYS)("%s: zero parses", (key) => {
    expect(ImpactMetrics.parse(makeImpact({ [key]: 0 }))[key as "verifiedCoaches"]).toBe(0);
  });

  test.each([...IMPACT_COUNT_KEYS, "medianImprovementPct", "trainingHours", "byWeek"])("rejects metrics missing %s", (key) => {
    expect(ok(ImpactMetrics, without(makeImpact(), key))).toBe(false);
  });

  test("an empty byWeek parses", () => {
    expect(ImpactMetrics.parse(makeImpact({ byWeek: [] })).byWeek).toEqual([]);
  });

  test("a byWeek weekStart must be a calendar date", () => {
    expect(ok(ImpactMetrics, makeImpact({ byWeek: [{ weekStart: "14.09.2026", sessionsCompleted: 1 }] }))).toBe(
      false,
    );
  });

  test("a byWeek sessionsCompleted must be a non-negative integer", () => {
    expect(ok(ImpactMetrics, makeImpact({ byWeek: [{ weekStart: "2026-09-14", sessionsCompleted: -1 }] }))).toBe(
      false,
    );
  });

  test("a byWeek sessionsCompleted must be an integer", () => {
    expect(ok(ImpactMetrics, makeImpact({ byWeek: [{ weekStart: "2026-09-14", sessionsCompleted: 1.5 }] }))).toBe(false);
  });

  test("a byWeek entry needs only weekStart and sessionsCompleted", () => {
    expect(ok(ImpactMetrics, makeImpact({ byWeek: [{ weekStart: "2026-09-14", sessionsCompleted: 1 }] }))).toBe(true);
  });

  test("a byWeek entry carries no activePlayers (not in the design): a sent one is stripped", () => {
    const parsed = ImpactMetrics.parse(
      makeImpact({ byWeek: [{ weekStart: "2026-09-14", sessionsCompleted: 1, activePlayers: 9 }] }),
    );
    expect(parsed.byWeek[0]).not.toHaveProperty("activePlayers");
  });

  test.each(["weekStart", "sessionsCompleted"])("a byWeek entry missing %s fails", (key) => {
    const entry = { weekStart: "2026-09-14", sessionsCompleted: 1 };
    expect(ok(ImpactMetrics, makeImpact({ byWeek: [without(entry, key)] }))).toBe(false);
  });

  test("unknown server keys are stripped from the metrics and the weeks", () => {
    const parsed = ImpactMetrics.parse(
      makeImpact({
        countriesReached: 3,
        byWeek: [{ weekStart: "2026-09-14", sessionsCompleted: 1, churn: 0.1 }],
      }),
    );
    expect(parsed).not.toHaveProperty("countriesReached");
    expect(parsed.byWeek[0]).not.toHaveProperty("churn");
  });
});

// --- GET|PUT /api/admin/settings ----------------------------------------------------------------------------------

describe("Settings", () => {
  test("an empty object parses (the field list belongs to the settings bead)", () => {
    expect(ok(Settings, {})).toBe(true);
  });

  test("keys a later bead adds are kept, not stripped or rejected", () => {
    expect(Settings.parse({ someFutureSetting: true, nested: { a: 1 } })).toEqual({
      someFutureSetting: true,
      nested: { a: 1 },
    });
  });

  test("an array is not a settings object", () => {
    expect(ok(Settings, [])).toBe(false);
  });

  test("null is not a settings object", () => {
    expect(ok(Settings, null)).toBe(false);
  });

  test("a string is not a settings object", () => {
    expect(ok(Settings, "on")).toBe(false);
  });
});

// --- Allowed transitions, exported as data ---------------------------------------------------------------------------

describe("CONTRIBUTION_TRANSITIONS (derived: state -> actions the UI may offer)", () => {
  test("every key is a ContributionState", () => {
    for (const state of Object.keys(CONTRIBUTION_TRANSITIONS)) expect(ok(ContributionState, state)).toBe(true);
  });

  test("every value is a DecisionAction", () => {
    for (const actions of Object.values(CONTRIBUTION_TRANSITIONS)) {
      for (const action of actions) expect([...DECISION_ACTIONS]).toContain(action);
    }
  });

  test.each([
    ["pending", "approve"],
    ["pending", "reject"],
    ["pending", "request_changes"],
  ] satisfies Array<[ContributionStateName, string]>)("%s allows %s", (state, action) => {
    const allowed: readonly string[] = CONTRIBUTION_TRANSITIONS[state];
    expect(allowed).toContain(action);
  });

  test("pending offers exactly approve, reject and request_changes", () => {
    expect([...CONTRIBUTION_TRANSITIONS.pending].sort()).toEqual(["approve", "reject", "request_changes"]);
  });

  test("changes_requested offers no admin action (it waits for the contributor to resubmit)", () => {
    expect(CONTRIBUTION_TRANSITIONS.changes_requested).toEqual([]);
  });

  test("changes_requested does not allow approve (it awaits the contributor's changes)", () => {
    const allowed: readonly string[] = CONTRIBUTION_TRANSITIONS.changes_requested;
    expect(allowed).not.toContain("approve");
  });

  test("changes_requested does not allow request_changes again", () => {
    const allowed: readonly string[] = CONTRIBUTION_TRANSITIONS.changes_requested;
    expect(allowed).not.toContain("request_changes");
  });

  test.each(["approved", "rejected", "withdrawn"] satisfies ContributionStateName[])(
    "%s is terminal: no action",
    (state) => {
      expect(CONTRIBUTION_TRANSITIONS[state]).toEqual([]);
    },
  );

  test.each([...QUEUE_STATES])("the queue state %s has an entry", (state) => {
    expect(Object.keys(CONTRIBUTION_TRANSITIONS)).toContain(state);
  });
});

describe("STATUS_TRANSITIONS (derived: TrustStatus -> allowed toStatus values)", () => {
  const allowedFrom = (status: TrustStatusName): readonly string[] => STATUS_TRANSITIONS[status];

  test("every key and every value is a TrustStatus", () => {
    for (const [from, targets] of Object.entries(STATUS_TRANSITIONS)) {
      expect(ok(TrustStatus, from)).toBe(true);
      for (const to of targets) expect(ok(TrustStatus, to)).toBe(true);
    }
  });

  test.each([...TRUST_STATUSES])("%s has an entry", (status) => {
    expect(Object.keys(STATUS_TRANSITIONS)).toContain(status);
  });

  test.each([...TRUST_STATUSES])("%s cannot transition to itself", (status) => {
    expect(allowedFrom(status)).not.toContain(status);
  });

  test("COMMUNITY can be promoted to REVIEWED", () => {
    expect(allowedFrom("COMMUNITY")).toContain("REVIEWED");
  });

  test("REVIEWED can be promoted to EXPERT_VERIFIED", () => {
    expect(allowedFrom("REVIEWED")).toContain("EXPERT_VERIFIED");
  });

  test("REVIEWED can be promoted to ACADEMY_VERIFIED", () => {
    expect(allowedFrom("REVIEWED")).toContain("ACADEMY_VERIFIED");
  });

  test("a verified status can be revoked back to COMMUNITY", () => {
    expect(allowedFrom("ACADEMY_VERIFIED")).toContain("COMMUNITY");
  });

  test("a REVIEWED drill can be demoted to COMMUNITY", () => {
    expect(allowedFrom("REVIEWED")).toContain("COMMUNITY");
  });

  test("COMMUNITY may be set straight to EXPERT_VERIFIED (a decision can already approve there)", () => {
    expect(allowedFrom("COMMUNITY")).toContain("EXPERT_VERIFIED");
  });

  test("COMMUNITY may be set straight to ACADEMY_VERIFIED", () => {
    expect(allowedFrom("COMMUNITY")).toContain("ACADEMY_VERIFIED");
  });

  test("EXPERT_VERIFIED and ACADEMY_VERIFIED may be swapped", () => {
    expect(allowedFrom("EXPERT_VERIFIED")).toContain("ACADEMY_VERIFIED");
    expect(allowedFrom("ACADEMY_VERIFIED")).toContain("EXPERT_VERIFIED");
  });

  test.each([...TRUST_STATUSES])("%s may move to every other status", (from) => {
    for (const to of TRUST_STATUSES.filter((status) => status !== from)) expect(allowedFrom(from)).toContain(to);
  });
});

// --- Endpoints -------------------------------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("listContributions is GET /api/admin/contributions with a state query", () => {
    expect(ENDPOINTS.listContributions).toMatchObject({ method: "GET", path: "/api/admin/contributions" });
    expect(ENDPOINTS.listContributions.query).toBe(ContributionListQuery);
    expect(ENDPOINTS.listContributions.response).toBe(ModerationQueueResponse);
  });

  test("decideContribution is POST /api/admin/contributions/:id/decision", () => {
    expect(ENDPOINTS.decideContribution).toMatchObject({
      method: "POST",
      path: "/api/admin/contributions/:id/decision",
    });
    expect(ENDPOINTS.decideContribution.params).toBe(ContributionParams);
    expect(ENDPOINTS.decideContribution.request).toBe(DecisionRequest);
    expect(ENDPOINTS.decideContribution.response).toBe(DecisionResponse);
  });

  test("the decision endpoint enforces the note rules (its request is the refined schema)", () => {
    expect(ok(ENDPOINTS.decideContribution.request, makeDecision({ action: "reject" }))).toBe(false);
  });

  test("setDrillStatus is POST /api/admin/drills/:slug/status returning a DrillDetail", () => {
    expect(ENDPOINTS.setDrillStatus).toMatchObject({ method: "POST", path: "/api/admin/drills/:slug/status" });
    expect(ENDPOINTS.setDrillStatus.params).toBe(DrillParams);
    expect(ENDPOINTS.setDrillStatus.request).toBe(DrillStatusRequest);
    expect(ENDPOINTS.setDrillStatus.response).toBe(DrillDetail);
  });

  test("unpublishDrill is POST /api/admin/drills/:slug/unpublish returning a DrillDetail", () => {
    expect(ENDPOINTS.unpublishDrill).toMatchObject({ method: "POST", path: "/api/admin/drills/:slug/unpublish" });
    expect(ENDPOINTS.unpublishDrill.params).toBe(DrillParams);
    expect(ENDPOINTS.unpublishDrill.request).toBe(UnpublishRequest);
    expect(ENDPOINTS.unpublishDrill.response).toBe(DrillDetail);
  });

  test("getImpact is GET /api/admin/impact returning ImpactMetrics", () => {
    expect(ENDPOINTS.getImpact).toMatchObject({ method: "GET", path: "/api/admin/impact" });
    expect(ENDPOINTS.getImpact.response).toBe(ImpactMetrics);
  });

  test("getSettings is GET /api/admin/settings returning Settings", () => {
    expect(ENDPOINTS.getSettings).toMatchObject({ method: "GET", path: "/api/admin/settings" });
    expect(ENDPOINTS.getSettings.response).toBe(Settings);
  });

  test("putSettings is PUT /api/admin/settings taking and returning Settings", () => {
    expect(ENDPOINTS.putSettings).toMatchObject({ method: "PUT", path: "/api/admin/settings" });
    expect(ENDPOINTS.putSettings.request).toBe(Settings);
    expect(ENDPOINTS.putSettings.response).toBe(Settings);
  });

  test("no admin endpoint is public (the client signs in first)", () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint).not.toHaveProperty("public");
  });

  test("every :param in a path has a params schema key", () => {
    for (const endpoint of [ENDPOINTS.decideContribution, ENDPOINTS.setDrillStatus, ENDPOINTS.unpublishDrill]) {
      expect([...endpoint.path.matchAll(/:(\w+)/g)].map((m) => m[1])).toEqual(Object.keys(endpoint.params.shape));
    }
  });
});

// --- Web-bundle safety -------------------------------------------------------------------------------------------------

describe("web-bundle safety", () => {
  test("imports only zod, ./primitives, ./domain, ./contributions and ./commons", () => {
    const source = readFileSync(join(import.meta.dir, "admin.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(["zod", "./primitives", "./domain", "./contributions", "./commons"]).toContain(specifier);
    }
  });
});
