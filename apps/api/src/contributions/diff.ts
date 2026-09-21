// Improvement diff builder (fc-mol-0v3.2): what an improvement payload changes against the
// current version of the drill, so the reviewer sees exactly that and nothing else.
//
// Pure: no I/O, inputs are only read. Types come from the shared contracts.
//
// The payload is ONE submitted contribution in ONE locale; the drill's content is localized
// text (kk/ru/en). A localized field is therefore compared with the current text IN THE
// PAYLOAD'S LOCALE only, and the reported `field` names that locale (`instructions.ru`).
// A translation-only improvement thus shows one entry, for its own locale.
import type { DiffEntry } from "../shared/admin";
import type { DrillDetail } from "../shared/commons";
import type { ContributionPayloadView } from "../shared/contributions";
import type { Locale, LocalizedText } from "../shared/primitives";

export type { DiffEntry };

/**
 * The current version as the API has it. A `DrillDetail` fits as-is (only `content` and the
 * attribution's author/source/sourceUrl are read). `level`, `minutes` and `goal` are DERIVED
 * supplements: the detail does not carry them (the library row has level and minutes; the
 * drill's goal enum is not in the detail either), so the caller merges them in. A supplement
 * that is missing counts as a missing current value (`before: undefined`).
 */
export type CurrentVersion = Pick<DrillDetail, "content"> & {
  attribution?: Partial<Pick<DrillDetail["attribution"], "author" | "source" | "sourceUrl">>;
  level?: ContributionPayloadView["level"];
  minutes?: number;
  goal?: ContributionPayloadView["goal"];
};

/** The payload keys the diff compares, in the order the entries are reported. */
export const FIELD_ORDER = [
  "name",
  "goal",
  "instructions",
  "mistakes",
  "progression",
  "regression",
  "safety",
  "ageMin",
  "ageMax",
  "level",
  "equipment",
  "durationMin",
  "source",
  "sourceUrl",
  "author",
] as const;
type DiffField = (typeof FIELD_ORDER)[number];

// Not compared: kind, targetDrillSlug, improvementKind (they describe the submission, not
// the drill), sport and skill (the drill's place in the graph, not its content), and the
// payload's own `locale` (the `locale` argument is authoritative).

/** Single localized text: trimmed; blank counts as missing (undefined). */
const normalizeText = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value.trim();
};

/** Multi-line text: every line trimmed, blank lines dropped; nothing left counts as missing. */
const normalizeLines = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? undefined : lines.join("\n");
};

/** Non-localized value: strings are trimmed, anything else is compared as it is. */
const normalizeValue = (value: unknown): unknown => (typeof value === "string" ? value.trim() : value);

/** The current items of a list field in one locale, one item per line (missing items skipped). */
const itemsInLocale = (items: LocalizedText[], locale: Locale): string =>
  items.flatMap((item) => (item[locale] === undefined ? [] : [item[locale]])).join("\n");

type FieldSpec = {
  /** Localized fields are reported as `<field>.<locale>`. */
  localized: boolean;
  normalize: (value: unknown) => unknown;
  current: (current: CurrentVersion, locale: Locale) => unknown;
};

/**
 * The ONE mapping from payload names to the current version (DERIVED from the payload view in
 * ../shared/contributions and DrillDetail in ../shared/commons):
 *  - name         <- content.title[locale]              (single text)
 *  - instructions <- content.instructions[locale]       (single text)
 *  - mistakes     <- content.mistakes[].[locale]        (payload: one string; current: a list,
 *  - progression  <- content.progressions[].[locale]     compared as one item per line)
 *  - regression   <- content.regressions[].[locale]
 *  - safety       <- content.safety[].[locale]
 *  - ageMin/ageMax <- content.conditions.ageMin/ageMax
 *  - equipment    <- content.conditions.equipment       (a single enum value, not a set)
 *  - durationMin  <- minutes                            (supplement, see CurrentVersion)
 *  - level, goal  <- level, goal                        (supplements)
 *  - source, sourceUrl, author <- attribution.source/sourceUrl/author
 */
const SPECS: Record<DiffField, FieldSpec> = {
  name: { localized: true, normalize: normalizeText, current: (c, l) => c.content.title?.[l] },
  goal: { localized: false, normalize: normalizeValue, current: (c) => c.goal },
  instructions: { localized: true, normalize: normalizeText, current: (c, l) => c.content.instructions[l] },
  mistakes: { localized: true, normalize: normalizeLines, current: (c, l) => itemsInLocale(c.content.mistakes, l) },
  progression: {
    localized: true,
    normalize: normalizeLines,
    current: (c, l) => itemsInLocale(c.content.progressions, l),
  },
  regression: {
    localized: true,
    normalize: normalizeLines,
    current: (c, l) => itemsInLocale(c.content.regressions, l),
  },
  safety: { localized: true, normalize: normalizeLines, current: (c, l) => itemsInLocale(c.content.safety, l) },
  ageMin: { localized: false, normalize: normalizeValue, current: (c) => c.content.conditions.ageMin },
  ageMax: { localized: false, normalize: normalizeValue, current: (c) => c.content.conditions.ageMax },
  level: { localized: false, normalize: normalizeValue, current: (c) => c.level },
  equipment: { localized: false, normalize: normalizeValue, current: (c) => c.content.conditions.equipment },
  durationMin: { localized: false, normalize: normalizeValue, current: (c) => c.minutes },
  source: { localized: false, normalize: normalizeValue, current: (c) => c.attribution?.source },
  sourceUrl: { localized: false, normalize: normalizeValue, current: (c) => c.attribution?.sourceUrl },
  author: { localized: false, normalize: normalizeValue, current: (c) => c.attribution?.author },
};

/**
 * Deep equality for JSON-like values: arrays are ORDER-SENSITIVE (no field the diff compares
 * is a set: `equipment` is one enum value), objects ignore key order but must have the same
 * keys (a key holding `undefined` is not the same as a missing key).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  );
}

/**
 * The fields `payload` changes against `currentVersion`, in FIELD_ORDER, as the admin
 * contract's `{field, before, after}`. Only keys present in the payload are compared (an
 * absent key is not a removal); a value that is equal after trimming is not a difference; a
 * missing current value against a provided payload value is one, with `before: undefined`.
 * `before` and `after` are the trimmed values (a blank localized text is `undefined`).
 */
export function diffAgainstCurrent(
  currentVersion: CurrentVersion,
  payload: Partial<ContributionPayloadView>,
  locale: Locale,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const field of FIELD_ORDER) {
    const provided = payload[field];
    if (provided === undefined) continue;
    const spec = SPECS[field];
    const before = spec.normalize(spec.current(currentVersion, locale));
    const after = spec.normalize(provided);
    if (deepEqual(before, after)) continue;
    entries.push({ field: spec.localized ? `${field}.${locale}` : field, before, after });
  }
  return entries;
}
