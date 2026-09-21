import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRIBUTION_TRANSITIONS, STATUS_TRANSITIONS } from "../shared/admin";
import type { DecisionAction, DrillStatusRequest } from "../shared/admin";
import { CONTRIBUTION_STATES, EDITABLE_STATES } from "../shared/contributions";
import type { ContributionState } from "../shared/contributions";
import { TRUST_STATUSES } from "../shared/primitives";
import type { TrustStatus } from "../shared/primitives";
import { CONTRIBUTION_MACHINE, canChangeStatus, canTransition, checkStatusChange } from "./transitions";

// --- Contribution state machine ------------------------------------------------------------

// The legal map, written out independently of the implementation (criteria):
// pending -> changes_requested | approved | rejected | withdrawn;
// changes_requested -> pending | withdrawn; decided states are final.
const LEGAL: readonly (readonly [ContributionState, ContributionState])[] = [
  ["pending", "changes_requested"],
  ["pending", "approved"],
  ["pending", "rejected"],
  ["pending", "withdrawn"],
  ["changes_requested", "pending"],
  ["changes_requested", "withdrawn"],
];

const isLegal = (from: ContributionState, to: ContributionState): boolean =>
  LEGAL.some(([f, t]) => f === from && t === to);

describe("canTransition: every ordered pair of contribution states", () => {
  test("the five states of the contract are the ones under test", () => {
    expect([...CONTRIBUTION_STATES]).toEqual(["pending", "changes_requested", "approved", "rejected", "withdrawn"]);
  });

  for (const from of CONTRIBUTION_STATES) {
    for (const to of CONTRIBUTION_STATES) {
      const legal = isLegal(from, to);
      test(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canTransition(from, to)).toBe(legal);
      });
    }
  }

  test("there are exactly 6 legal pairs out of 25", () => {
    const pairs = CONTRIBUTION_STATES.flatMap((from) => CONTRIBUTION_STATES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(25);
    expect(pairs.filter(([from, to]) => canTransition(from, to))).toHaveLength(6);
  });

  test("approved, rejected and withdrawn are final: nothing leaves them", () => {
    for (const from of ["approved", "rejected", "withdrawn"] as const) {
      for (const to of CONTRIBUTION_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test("no state may transition to itself", () => {
    for (const state of CONTRIBUTION_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  test("a changes_requested contribution cannot be decided directly, only resubmitted or withdrawn", () => {
    expect(canTransition("changes_requested", "approved")).toBe(false);
    expect(canTransition("changes_requested", "rejected")).toBe(false);
    expect(canTransition("changes_requested", "pending")).toBe(true);
    expect(canTransition("changes_requested", "withdrawn")).toBe(true);
  });

  test("a decided contribution cannot go back to pending", () => {
    expect(canTransition("approved", "pending")).toBe(false);
    expect(canTransition("rejected", "pending")).toBe(false);
    expect(canTransition("withdrawn", "pending")).toBe(false);
  });

  test("the owner can edit only where the contract's EDITABLE_STATES say, and those are the non-final states", () => {
    const nonFinal = CONTRIBUTION_STATES.filter((state) => CONTRIBUTION_MACHINE[state].length > 0);
    expect([...nonFinal].sort()).toEqual([...EDITABLE_STATES].sort());
  });
});

describe("CONTRIBUTION_MACHINE: the legal map as data", () => {
  test("holds exactly the criteria's legal pairs", () => {
    for (const from of CONTRIBUTION_STATES) {
      const expected = LEGAL.filter(([f]) => f === from).map(([, t]) => t);
      expect([...CONTRIBUTION_MACHINE[from]].sort()).toEqual([...expected].sort());
    }
  });

  test("agrees with canTransition for every pair", () => {
    for (const from of CONTRIBUTION_STATES) {
      for (const to of CONTRIBUTION_STATES) {
        expect(canTransition(from, to)).toBe(CONTRIBUTION_MACHINE[from].includes(to));
      }
    }
  });

  test("is frozen, including every row, so the server cannot mutate the rules", () => {
    expect(Object.isFrozen(CONTRIBUTION_MACHINE)).toBe(true);
    for (const state of CONTRIBUTION_STATES) {
      expect(Object.isFrozen(CONTRIBUTION_MACHINE[state])).toBe(true);
    }
  });

  test("is JSON-serialisable data (the client receives it as plain data)", () => {
    const roundTripped = JSON.parse(JSON.stringify(CONTRIBUTION_MACHINE));
    expect(roundTripped).toEqual(CONTRIBUTION_MACHINE);
  });
});

// Agreement with the client-facing data in shared/admin.ts.
const ACTION_TARGET: Readonly<Record<DecisionAction, ContributionState>> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "changes_requested",
};

describe("agreement with shared CONTRIBUTION_TRANSITIONS (admin actions per state)", () => {
  test("every state reachable by an admin action is a legal transition of the machine", () => {
    for (const from of CONTRIBUTION_STATES) {
      for (const action of CONTRIBUTION_TRANSITIONS[from]) {
        expect(canTransition(from, ACTION_TARGET[action])).toBe(true);
      }
    }
  });

  test("admin actions exist only for pending, and lead to approved, rejected and changes_requested", () => {
    const withActions = CONTRIBUTION_STATES.filter((state) => CONTRIBUTION_TRANSITIONS[state].length > 0);
    expect(withActions).toEqual(["pending"]);
    const reached = CONTRIBUTION_TRANSITIONS.pending.map((action) => ACTION_TARGET[action]);
    expect([...reached].sort()).toEqual(["approved", "changes_requested", "rejected"]);
  });

  test("the machine's moves that admin actions do not cover are the contributor's: withdraw, resubmit", () => {
    const contributorMoves = LEGAL.filter(
      ([from, to]) => !CONTRIBUTION_TRANSITIONS[from].some((action) => ACTION_TARGET[action] === to),
    );
    expect(contributorMoves).toEqual([
      ["pending", "withdrawn"],
      ["changes_requested", "pending"],
      ["changes_requested", "withdrawn"],
    ]);
    for (const [from, to] of contributorMoves) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  test("a state with no admin action offers no admin-reachable state that the machine forbids", () => {
    for (const from of CONTRIBUTION_STATES) {
      for (const to of Object.values(ACTION_TARGET)) {
        const adminCan = CONTRIBUTION_TRANSITIONS[from].some((action) => ACTION_TARGET[action] === to);
        if (adminCan) expect(canTransition(from, to)).toBe(true);
      }
    }
  });
});

// --- Trust-status rules ---------------------------------------------------------------------

const REVIEWER_TARGETS: readonly TrustStatus[] = ["REVIEWED", "EXPERT_VERIFIED", "ACADEMY_VERIFIED"];
const BLANKS = ["", " ", "   ", "\t", "\n", " \t\n "] as const;

const NOTE = "Checked against the federation guidelines.";
const REVIEWER = "Dr. Aigerim Nurlanova";
const ORG_LABEL = "Kazakhstan Football Academy";

/** A fully valid input for the target status: everything present, nothing extra needed. */
const valid = (from: TrustStatus, to: TrustStatus) => ({
  from,
  to,
  note: NOTE,
  reviewer: REVIEWER,
  orgLabel: ORG_LABEL,
});

describe("canChangeStatus: every ordered pair of trust statuses", () => {
  test("the four statuses of the contract are the ones under test", () => {
    expect([...TRUST_STATUSES]).toEqual(["COMMUNITY", "REVIEWED", "EXPERT_VERIFIED", "ACADEMY_VERIFIED"]);
  });

  for (const from of TRUST_STATUSES) {
    for (const to of TRUST_STATUSES) {
      const legal = from !== to;
      test(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canChangeStatus(from, to)).toBe(legal);
      });
    }
  }

  test("any status may be raised or lowered: 12 legal pairs, 4 same-status pairs illegal", () => {
    const pairs = TRUST_STATUSES.flatMap((from) => TRUST_STATUSES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(16);
    expect(pairs.filter(([from, to]) => canChangeStatus(from, to))).toHaveLength(12);
  });
});

describe("checkStatusChange: each of the 16 pairs with complete inputs", () => {
  for (const from of TRUST_STATUSES) {
    for (const to of TRUST_STATUSES) {
      if (from === to) {
        test(`${from} -> ${to} is refused as same_status even with complete inputs`, () => {
          expect(checkStatusChange(valid(from, to))).toEqual({ ok: false, reason: "same_status" });
        });
      } else {
        test(`${from} -> ${to} is accepted with note, reviewer and orgLabel`, () => {
          expect(checkStatusChange(valid(from, to))).toEqual({ ok: true });
        });
      }
    }
  }
});

describe("checkStatusChange: the note", () => {
  for (const from of TRUST_STATUSES) {
    for (const to of TRUST_STATUSES) {
      if (from === to) continue;
      test(`${from} -> ${to}: a missing note is refused`, () => {
        const { note: _omitted, ...rest } = valid(from, to);
        // The note is required by the contract; a caller that omits it at runtime (JS, cast) is refused.
        const result = checkStatusChange(rest as unknown as Parameters<typeof checkStatusChange>[0]);
        expect(result).toEqual({ ok: false, reason: "note_required" });
      });

      test(`${from} -> ${to}: empty and whitespace-only notes are refused`, () => {
        for (const blank of BLANKS) {
          expect(checkStatusChange({ ...valid(from, to), note: blank })).toEqual({
            ok: false,
            reason: "note_required",
          });
        }
      });
    }
  }

  test("lowering to COMMUNITY needs a note but no reviewer and no orgLabel", () => {
    for (const from of ["REVIEWED", "EXPERT_VERIFIED", "ACADEMY_VERIFIED"] as const) {
      expect(checkStatusChange({ from, to: "COMMUNITY", note: NOTE })).toEqual({ ok: true });
      expect(checkStatusChange({ from, to: "COMMUNITY", note: "" })).toEqual({ ok: false, reason: "note_required" });
    }
  });

  test("a note with surrounding whitespace but real content counts as present", () => {
    expect(checkStatusChange({ from: "REVIEWED", to: "COMMUNITY", note: "  lowered after complaint  " })).toEqual({
      ok: true,
    });
  });
});

describe("checkStatusChange: a named reviewer for REVIEWED and above", () => {
  for (const to of REVIEWER_TARGETS) {
    const from: TrustStatus = to === "REVIEWED" ? "COMMUNITY" : "REVIEWED";
    const orgLabel = ORG_LABEL; // present, so only the reviewer is at issue

    test(`-> ${to}: a missing reviewer is refused`, () => {
      expect(checkStatusChange({ from, to, note: NOTE, orgLabel })).toEqual({
        ok: false,
        reason: "reviewer_required",
      });
    });

    test(`-> ${to}: empty and whitespace-only reviewers are refused`, () => {
      for (const blank of BLANKS) {
        expect(checkStatusChange({ from, to, note: NOTE, reviewer: blank, orgLabel })).toEqual({
          ok: false,
          reason: "reviewer_required",
        });
      }
    });

    test(`-> ${to}: a named reviewer is accepted`, () => {
      expect(checkStatusChange({ from, to, note: NOTE, reviewer: REVIEWER, orgLabel })).toEqual({ ok: true });
    });
  }

  test("-> COMMUNITY does not need a reviewer, missing or blank", () => {
    expect(checkStatusChange({ from: "REVIEWED", to: "COMMUNITY", note: NOTE })).toEqual({ ok: true });
    expect(checkStatusChange({ from: "REVIEWED", to: "COMMUNITY", note: NOTE, reviewer: "" })).toEqual({ ok: true });
    expect(checkStatusChange({ from: "REVIEWED", to: "COMMUNITY", note: NOTE, reviewer: "  " })).toEqual({
      ok: true,
    });
  });

  test("lowering from a verified status to REVIEWED still needs a reviewer (REVIEWED and above)", () => {
    expect(checkStatusChange({ from: "ACADEMY_VERIFIED", to: "REVIEWED", note: NOTE })).toEqual({
      ok: false,
      reason: "reviewer_required",
    });
    expect(checkStatusChange({ from: "ACADEMY_VERIFIED", to: "REVIEWED", note: NOTE, reviewer: REVIEWER })).toEqual({
      ok: true,
    });
  });
});

describe("checkStatusChange: ACADEMY_VERIFIED requires an orgLabel", () => {
  const base = { from: "REVIEWED", to: "ACADEMY_VERIFIED", note: NOTE, reviewer: REVIEWER } as const;

  test("ACADEMY_VERIFIED without an orgLabel is rejected", () => {
    expect(checkStatusChange(base)).toEqual({ ok: false, reason: "org_label_required" });
  });

  test("empty and whitespace-only orgLabels are rejected", () => {
    for (const blank of BLANKS) {
      expect(checkStatusChange({ ...base, orgLabel: blank })).toEqual({ ok: false, reason: "org_label_required" });
    }
  });

  test("a real orgLabel is accepted", () => {
    expect(checkStatusChange({ ...base, orgLabel: ORG_LABEL })).toEqual({ ok: true });
  });

  test("it is required from every other starting status too", () => {
    for (const from of ["COMMUNITY", "REVIEWED", "EXPERT_VERIFIED"] as const) {
      expect(checkStatusChange({ ...base, from })).toEqual({ ok: false, reason: "org_label_required" });
      expect(checkStatusChange({ ...base, from, orgLabel: ORG_LABEL })).toEqual({ ok: true });
    }
  });

  test("REVIEWED and EXPERT_VERIFIED do not need an orgLabel", () => {
    expect(checkStatusChange({ from: "COMMUNITY", to: "REVIEWED", note: NOTE, reviewer: REVIEWER })).toEqual({
      ok: true,
    });
    expect(checkStatusChange({ from: "REVIEWED", to: "EXPERT_VERIFIED", note: NOTE, reviewer: REVIEWER })).toEqual({
      ok: true,
    });
  });

  test("an orgLabel is never required when lowering", () => {
    expect(checkStatusChange({ from: "ACADEMY_VERIFIED", to: "COMMUNITY", note: NOTE })).toEqual({ ok: true });
    expect(checkStatusChange({ from: "ACADEMY_VERIFIED", to: "EXPERT_VERIFIED", note: NOTE, reviewer: REVIEWER })).toEqual({
      ok: true,
    });
  });
});

describe("checkStatusChange: precedence when several things are wrong", () => {
  test("same_status wins over every missing input", () => {
    expect(checkStatusChange({ from: "ACADEMY_VERIFIED", to: "ACADEMY_VERIFIED", note: "" })).toEqual({
      ok: false,
      reason: "same_status",
    });
  });

  test("note_required is reported before reviewer_required and org_label_required", () => {
    expect(checkStatusChange({ from: "COMMUNITY", to: "ACADEMY_VERIFIED", note: " " })).toEqual({
      ok: false,
      reason: "note_required",
    });
  });

  test("reviewer_required is reported before org_label_required", () => {
    expect(checkStatusChange({ from: "COMMUNITY", to: "ACADEMY_VERIFIED", note: NOTE })).toEqual({
      ok: false,
      reason: "reviewer_required",
    });
  });
});

describe("agreement with shared STATUS_TRANSITIONS and DrillStatusRequest", () => {
  test("canChangeStatus is legal exactly where STATUS_TRANSITIONS lists the target, for every ordered pair", () => {
    for (const from of TRUST_STATUSES) {
      for (const to of TRUST_STATUSES) {
        expect(canChangeStatus(from, to)).toBe(STATUS_TRANSITIONS[from].includes(to));
      }
    }
  });

  test("checkStatusChange with valid inputs is ok exactly where STATUS_TRANSITIONS allows the move", () => {
    for (const from of TRUST_STATUSES) {
      for (const to of TRUST_STATUSES) {
        const result = checkStatusChange(valid(from, to));
        expect(result.ok).toBe(STATUS_TRANSITIONS[from].includes(to));
      }
    }
  });

  test("an input the shared DrillStatusRequest accepts (toStatus, note, orgLabel) maps onto the guard's fields", () => {
    const request: DrillStatusRequest = { toStatus: "ACADEMY_VERIFIED", note: NOTE, orgLabel: ORG_LABEL };
    // The reviewer is not a request field; the server supplies the acting admin's name.
    const result = checkStatusChange({
      from: "REVIEWED",
      to: request.toStatus,
      note: request.note,
      orgLabel: request.orgLabel,
      reviewer: REVIEWER,
    });
    expect(result).toEqual({ ok: true });
  });
});

// --- Purity ----------------------------------------------------------------------------------

describe("purity", () => {
  test("the same input gives an equal result on every call", () => {
    for (const from of CONTRIBUTION_STATES) {
      for (const to of CONTRIBUTION_STATES) {
        expect(canTransition(from, to)).toBe(canTransition(from, to));
      }
    }
    const input = { from: "COMMUNITY", to: "ACADEMY_VERIFIED", note: NOTE, reviewer: REVIEWER } as const;
    expect(checkStatusChange(input)).toEqual(checkStatusChange(input));
    expect(checkStatusChange({ ...input, orgLabel: ORG_LABEL })).toEqual(
      checkStatusChange({ ...input, orgLabel: ORG_LABEL }),
    );
  });

  test("checkStatusChange does not mutate its input", () => {
    const input = Object.freeze({ from: "COMMUNITY", to: "REVIEWED", note: NOTE, reviewer: REVIEWER } as const);
    expect(() => checkStatusChange(input)).not.toThrow();
    expect(input).toEqual({ from: "COMMUNITY", to: "REVIEWED", note: NOTE, reviewer: REVIEWER });
  });

  test("mutating the exported machine has no effect on canTransition", () => {
    const row = CONTRIBUTION_MACHINE.approved as ContributionState[];
    try {
      row.push("pending");
    } catch {
      // frozen: throwing is fine
    }
    try {
      (CONTRIBUTION_MACHINE as Record<string, unknown>).approved = ["pending"];
    } catch {
      // frozen: throwing is fine
    }
    expect(canTransition("approved", "pending")).toBe(false);
  });

  test("the module imports only from ../shared and uses no I/O, clock or randomness", () => {
    const source = readFileSync(join(import.meta.dir, "transitions.ts"), "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      expect(specifier?.startsWith("../shared/")).toBe(true);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\bfetch\b/);
  });
});
