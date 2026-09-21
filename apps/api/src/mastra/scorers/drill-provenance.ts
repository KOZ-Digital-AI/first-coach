// The drill-provenance scorer (fc-mol-zo6.5), modelled on the reference project's number-provenance
// scorer: does everything the AI names trace back to something the server actually approved?
//
//   drillProvenance(output, knownDrills) -> { score: 0 | 1, itemScores, flagged }
//
// Pure: no network, no key, no clock, no environment, no inputs modified. The result is plain data,
// so it can be logged with each AI call as it is. Used in tests and by the planner's logging.
//
// Fail closed: anything that cannot be traced to a known published drill version scores 0.
//
// Readings of the criteria (each is a decision, not in the bead text):
//   - `output` is `unknown` (it is model output). It is read as an AiPlan-shaped object,
//     `{ items: [...] }`; anything else, and an empty item list, is the single flag kind "output"
//     and scores 0 (an output that names nothing proves nothing).
//   - `knownDrills` is the set of published versions (PublishedVersion from commons/repo fits; only
//     versionId, slug and content.title are read).
//   - the score is binary: 1 only when EVERY item is grounded, else 0. `itemScores` gives each
//     item's own 0 or 1, so a log shows which item failed; `flagged` says why.
//   - a "drill id" is an item's drillVersionId. It must equal a known versionId EXACTLY: no trimming,
//     no case folding, no fuzzy matching. A missing or non-string id cannot be traced (kind "item"
//     for a non-object item, "drill_id" otherwise).
//   - a "drill title" is a title-like key on the item (TITLE_KEYS). AiPlan itself has no title, but a
//     model may add one and the validator's strict schema would then reject it later; this scorer
//     still flags a title that is not the item's own drill's. A title is grounded when it equals, after
//     trimming, collapsing whitespace, NFC and case folding, the drill's title in ANY locale or its
//     slug (the coach tools show the slug where a drill has no title). The real title of a DIFFERENT
//     drill is not grounded: it would attribute the item to the wrong drill. An absent, undefined or
//     null title makes no claim; any other non-matching value (a number, a blank string) is flagged.
//   - when the id is unknown, only the id is flagged: the title is not judged against a drill the
//     item does not have.
//   - LIMIT: free text (the reason) is not scanned for drill names; a name in prose cannot be told
//     from any other word without language understanding. The plan validator bounds the reason
//     instead (length, no URLs).
import type { LocalizedText } from "../../shared/primitives";

/** The part of a published version the scorer reads. commons/repo's PublishedVersion is assignable. */
export interface KnownDrill {
  versionId: string;
  slug?: string | undefined;
  content?: { title?: LocalizedText | undefined } | undefined;
}

export type ProvenanceFlagKind = "output" | "item" | "drill_id" | "drill_title";

export interface ProvenanceFlag {
  kind: ProvenanceFlagKind;
  /** The item's position in the plan; null for the output as a whole. */
  index: number | null;
  /** The offending id or title (shown as JSON text when it is not a string); a note for "output" and "item". */
  value: string;
}

export interface DrillProvenance {
  /** 1 when every plan item is grounded in a known drill version, otherwise 0. */
  score: 0 | 1;
  /** Each item's own score, in plan order; empty when the output is not a plan. */
  itemScores: Array<0 | 1>;
  flagged: ProvenanceFlag[];
}

/** The item keys read as "the drill's name". */
export const TITLE_KEYS = ["title", "drillTitle", "drillName", "name"] as const;

const normalise = (text: string): string => text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

/** The normalised names one drill answers to: its title in every locale, and its slug. */
function namesOf(drill: KnownDrill): Set<string> {
  const names = new Set<string>();
  const title = drill.content?.title;
  for (const text of title === undefined ? [] : Object.values(title)) {
    if (typeof text === "string" && text.trim() !== "") names.add(normalise(text));
  }
  if (typeof drill.slug === "string" && drill.slug.trim() !== "") names.add(normalise(drill.slug));
  return names;
}

export function drillProvenance(output: unknown, knownDrills: Iterable<KnownDrill>): DrillProvenance {
  const notAPlan: DrillProvenance = {
    score: 0,
    itemScores: [],
    flagged: [{ kind: "output", index: null, value: "the output is not a plan with at least one item" }],
  };
  if (!isRecord(output) || !Array.isArray(output.items) || output.items.length === 0) return notAPlan;

  // versionId -> the names of that drill. A Map (not an object): "constructor" is not a known id.
  const known = new Map<string, Set<string>>();
  for (const drill of knownDrills) {
    if (typeof drill?.versionId === "string") known.set(drill.versionId, namesOf(drill));
  }

  const flagged: ProvenanceFlag[] = [];
  const itemScores: Array<0 | 1> = [];
  output.items.forEach((entry: unknown, index) => {
    const before = flagged.length;
    if (!isRecord(entry)) {
      flagged.push({ kind: "item", index, value: "the item is not an object" });
    } else {
      const names = typeof entry.drillVersionId === "string" ? known.get(entry.drillVersionId) : undefined;
      if (names === undefined) {
        flagged.push({ kind: "drill_id", index, value: show(entry.drillVersionId) });
      } else {
        for (const key of TITLE_KEYS) {
          const title = entry[key];
          if (title === undefined || title === null) continue;
          if (typeof title !== "string" || !names.has(normalise(title))) {
            flagged.push({ kind: "drill_title", index, value: show(title) });
          }
        }
      }
    }
    itemScores.push(flagged.length === before ? 1 : 0);
  });

  return { score: flagged.length === 0 ? 1 : 0, itemScores, flagged };
}
