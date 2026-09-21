// Admin settings store (fc-mol-9l4.4): the typed settings object, its defaults, and how it is
// read from and written to the `settings` key/value table (migration 003).
//
// Consumers: the planner's candidate filter (minStatusByAgeBand), upload storage (uploadMaxMb), the
// AI and video routes (aiPlannerEnabled, videoCoachEnabled), the retest scheduler
// (retestIntervalsDays) and the admin settings screen (GET|PUT /api/admin/settings). Every function
// takes the bun:sqlite Database as its first parameter (no module singleton) and is synchronous.
//
// The contract (shared/admin.ts) leaves `Settings` a loose object and the field list to this
// module. A typed object built here is accepted by that loose schema unchanged; the reverse is not
// true (the loose schema lets any key through), so the write boundary is `updateSettings`.
//
// Storage: one row per top-level key, `value` is that key's JSON. A key with no row reads as its
// default, so a fresh database, a new setting and a changed default all need no data migration.
//
// Rules
//   - Reads never crash boot. A stored value that fails validation (an older or newer build wrote
//     it, or a rule tightened) reads as that key's default and is passed to `onInvalid`; this
//     module writes nothing to the console. A stored key this build does not know is ignored.
//     Validation is per KEY: one bad band makes the whole `minStatusByAgeBand` value read as its
//     default.
//   - Writes validate the whole patch first (unknown keys, at any depth, are rejected naming the
//     key; an invalid value is rejected naming its path) and then write every key of the patch in
//     ONE transaction: all or none. Only the keys in the patch are written, with
//     INSERT ... ON CONFLICT DO UPDATE (never REPLACE).
//   - Nested patch (a choice the criteria leave open, pinned by tests): `minStatusByAgeBand` MERGES
//     per band, so the admin form can send only the band it changed. The stored row is always the
//     full three-band object. Arrays are not merged: a `retestIntervalsDays` replaces the old one.
//     An explicit `undefined` means "absent".
//   - The criteria give no bounds beyond those in the schema below, and none are invented: no
//     upper cap on uploadMaxMb, and retestIntervalsDays is only non-empty positive integers (no
//     ordering, no uniqueness, no length limit).
//   - The criteria name the age bands (u10, u14, adult) but not the ages that map to them. That
//     mapping is the consumer's; nothing here invents one.
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { TrustStatus } from '../shared/primitives';

export const AGE_BANDS = ['u10', 'u14', 'adult'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** Strict, so a band this build does not know is refused. Unrefined, so `.partial()` works (Zod 4 throws on refined objects). */
const MinStatusByAgeBand = z.strictObject({
  u10: TrustStatus,
  u14: TrustStatus,
  adult: TrustStatus,
});

/**
 * The settings, all required. Unrefined base: `SettingsPatch` is derived from it. No `.default()`
 * anywhere: a default in the schema would turn an absent key of a patch into a write.
 */
export const SettingsSchema = z.strictObject({
  /** The lowest trust status a drill needs to be offered to a player of each age band. */
  minStatusByAgeBand: MinStatusByAgeBand,
  /** Upload size cap in megabytes. */
  uploadMaxMb: z.int().positive(),
  aiPlannerEnabled: z.boolean(),
  videoCoachEnabled: z.boolean(),
  /** Days after the baseline at which a player is asked to retest. */
  retestIntervalsDays: z.array(z.int().positive()).min(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as SettingKey[];

/** Every key optional; the bands of `minStatusByAgeBand` too (per-band merge, see the header). */
export const SettingsPatch = SettingsSchema.partial().extend({
  minStatusByAgeBand: MinStatusByAgeBand.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** What every key reads as until it is written. Deeply frozen: `getSettings` returns copies. */
export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze({
  minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'COMMUNITY' },
  uploadMaxMb: 50,
  aiPlannerEnabled: true,
  videoCoachEnabled: true,
  retestIntervalsDays: [7, 14, 30],
} satisfies Settings);

// --- errors ---------------------------------------------------------------------------------

export interface SettingIssue {
  /** Dotted path of the offending key, for example "minStatusByAgeBand.u10"; "" for the patch itself. */
  path: string;
  message: string;
}

/** A patch that `updateSettings` refused. Nothing was written. Routes answer 400 with `issues`. */
export class InvalidSettingsError extends Error {
  readonly issues: SettingIssue[];

  constructor(issues: SettingIssue[]) {
    super(`Invalid settings: ${issues.map((i) => `${i.path === '' ? '(patch)' : i.path}: ${i.message}`).join('; ')}`);
    this.name = 'InvalidSettingsError';
    this.issues = issues;
  }
}

function issuesOf(error: z.ZodError): SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) issues.push({ path: [...path, key].join('.'), message: 'Unknown setting' });
    } else {
      issues.push({ path: path.join('.'), message: issue.message });
    }
  }
  return issues;
}

// --- reading ----------------------------------------------------------------------------------

/** A stored value `getSettings` did not use. */
export interface InvalidStoredSetting {
  key: string;
  /** The stored JSON text as it is in the table. */
  value: string;
  reason: string;
}

export interface GetSettingsOptions {
  /** Called once per stored key whose value is unusable; that key reads as its default. */
  onInvalid?: (invalid: InvalidStoredSetting) => void;
}

const SETTING_SCHEMAS: Record<string, z.ZodType | undefined> = SettingsSchema.shape;

/** The full settings: stored values, and the defaults for every key with no (usable) row. */
export function getSettings(db: Database, options: GetSettingsOptions = {}): Settings {
  const result: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS);
  const stored = db.query('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[];
  for (const { key, value } of stored) {
    const schema = SETTING_SCHEMAS[key];
    if (schema === undefined || !Object.hasOwn(SETTING_SCHEMAS, key)) continue;
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch (e) {
      options.onInvalid?.({ key, value, reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) {
      result[key] = parsed.data;
    } else {
      options.onInvalid?.({ key, value, reason: issuesOf(parsed.error).map((i) => i.message).join('; ') });
    }
  }
  return result as Settings;
}

// --- writing ------------------------------------------------------------------------------------

/**
 * Validates `patch`, writes the keys it names in one transaction (all or none) and returns the
 * full settings after the write. Throws InvalidSettingsError, writing nothing, on an unknown key or
 * an invalid value. `now` is the `updated_at` of every key written. Inside a caller's transaction
 * it joins that transaction.
 */
export function updateSettings(db: Database, patch: unknown, now: Date = new Date()): Settings {
  const parsed = SettingsPatch.safeParse(patch);
  if (!parsed.success) throw new InvalidSettingsError(issuesOf(parsed.error));
  const updatedAt = now.toISOString();

  const upsert = db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const apply = db.transaction((): Settings => {
    const current = getSettings(db);
    for (const key of SETTING_KEYS) {
      const value = parsed.data[key];
      if (value === undefined) continue;
      let next: unknown = value;
      if (key === 'minStatusByAgeBand') {
        const bands: Record<string, unknown> = { ...current.minStatusByAgeBand };
        for (const [band, status] of Object.entries(parsed.data.minStatusByAgeBand ?? {})) {
          if (status !== undefined) bands[band] = status;
        }
        next = bands;
      }
      upsert.run(key, JSON.stringify(next), updatedAt);
    }
    return getSettings(db);
  });
  return db.inTransaction ? apply() : apply.immediate();
}
