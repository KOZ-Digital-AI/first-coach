// The deterministic session picker (fc-mol-urn.2): builds one day's training session from the
// roadmap and the planner's candidates. Pure: no database, clock or Math.random, and no input is
// mutated. The route that persists the session (fc-mol-urn.4) supplies ids, roadmapSummary and
// graphVersion; this module returns everything else of the contract's TodaySession.
//
//   pickSession(profile, roadmap, candidates, history, opts) -> PickedSession
//
// PORTED from the prototype (first-coach-demo.html, pickSession):
//   - one drill per focus skill (roadmap order), the first drill of the skill that fits;
//   - a drill is taken only when total + minutes <= budget + 3;
//   - then fill from the rest of the pool until the total reaches budget - 2;
//   - no drill twice.
// EXTENDED (the bead's criteria), each rule below:
//   1. WARM-UP first. The prototype has no warm-up rule; a warm-up-STYLE drill is a beginner (level 1)
//      drill (the seed has no warm-up flag or tag; level 1 is the lightest thing it has). Choice: the
//      ball-mastery track (GOAL_TO_TRACK.control, the ball-familiarity track) before any other, then
//      the fewest minutes, then trust, then the seeded tie-break. The warm-up does NOT count as the
//      focus pick of its own track (simplest reading: focus picks are independent of it).
//   2. FOCUS pick "at the right level": among the track's drills prefer the focus level, then its target
//      (focus level + 1), then lower levels nearest first (highest below), then anything higher. The
//      prototype's level ceiling is gone: candidates() already caps the level. The level is compared
//      as the drill's ExperienceLevel number (beginner 1, basic 2, intermediate 3) with the focus's
//      1..5 level directly. Level ranks before trust: "the right level first"; trust decides among
//      drills of one level rank (candidates() order: trust desc), then the seeded tie-break.
//   3. HISTORY: drills of the previous 2 sessions (the 2 latest entries dated BEFORE opts.date; an
//      entry dated today or later is not "previous") are DEPRIORITISED, not banned: they sort after
//      every other drill of the same list and are used only when nothing else fits. A history entry
//      names drills by `drillVersionIds` (matched through the candidates to their drill) and/or
//      `drillIds`; ids no candidate has are ignored.
//   4. FILL: round-robin across the focus tracks (roadmap order), then the other tracks (slug order,
//      a drill without a track last); every non-recent drill of every track goes before any recent one.
//   5. WINDOW: the total (drills + the skill test's 2 minutes) is at most budget + 3 ALWAYS. It reaches
//      budget - 2 whenever the pool can (a subset of it sums into [budget - 2, budget + 3]); a greedy
//      fill can get stuck below the window when the remaining drills are all too long, so every pick
//      (warm-up, focus, fill) is accepted only if a completion into the window still exists (a
//      subset-sum over the rest of the pool). When the pool cannot reach the window at all the picker
//      packs it as fully as the same order allows: every pick that fits under budget + 3 is taken.
//      A warm-up or focus drill that would make the window unreachable is skipped for the next one.
//   6. SKILL TEST: `opts.retestDue` lists the tests the caller found due (the caller owns the
//      schedule: settings.retestIntervalsDays are days after the baseline, and it also picks tests the
//      player has the kit for). The FIRST one becomes `skillTest`, a 2-minute step. The contract has no
//      "test item": TodaySession.skillTest is a separate field, and the test's `result` event has no
//      itemId, so it is not a member of `items`. Its 2 minutes count toward totalMinutes and the window.
//   7. DETERMINISM: candidates are put into a canonical order (trust desc, level asc, slug asc,
//      versionId asc) and reduced to one version per drill (the first in that order) before anything
//      else, so the caller's order is irrelevant. Ties are broken with a mulberry32 stream seeded by
//      seedFor(playerId, date), one draw per candidate in canonical order.
import type { PublishedVersion } from '../commons/repo';
import type { CalendarDate, PlayerProfile, Roadmap, SkillTest } from '../shared/domain';
import type { TodayItem } from '../shared/session';
import { EXPERIENCE_NUMBER, TRUST_RANK } from './candidates';
import { GOAL_TO_TRACK } from './roadmap';

/** The skill test's length; it counts toward the session total. */
export const SKILL_TEST_MINUTES = 2;
/** The window around the budget: budget - WINDOW_BELOW .. budget + WINDOW_ABOVE. */
export const WINDOW_BELOW = 2;
export const WINDOW_ABOVE = 3;
/** How many of the latest previous sessions deprioritise their drills. */
export const RECENT_SESSIONS = 2;
/** The track a warm-up is taken from first. */
export const WARMUP_TRACK = GOAL_TO_TRACK.control;

/** Reason keys of an item; the client localizes them (the contract's `reason` is free text). */
export const SESSION_REASON_WARMUP = 'warmup';
export const SESSION_REASON_FOCUS = 'focus';
export const SESSION_REASON_FILL = 'fill';

/** The part of a player profile the picker reads. */
export type SessionProfile = Pick<PlayerProfile, 'minutesPerSession'>;
/** The part of the roadmap the picker reads. */
export type SessionRoadmap = Pick<Roadmap, 'focus' | 'tracks'>;

/** One earlier session of the player: its date and the drills done in it. */
export interface HistoryEntry {
  date: CalendarDate;
  drillVersionIds?: readonly string[] | undefined;
  drillIds?: readonly string[] | undefined;
}

export interface SessionOptions {
  playerId: string;
  /** The day the session is for. */
  date: CalendarDate;
  /** The skill tests that are due, most important first; the first is taken. Absent or empty: none. */
  retestDue?: readonly SkillTest[] | undefined;
}

/** A contract TodayItem without its itemId (the persisting route assigns it). */
export type PickedItem = Omit<TodayItem, 'itemId'>;

export interface PickedSession {
  date: CalendarDate;
  planner: 'rules';
  /** The drills' minutes plus the skill test's. */
  totalMinutes: number;
  items: PickedItem[];
  skillTest?: SkillTest;
}

// --- seeding ---------------------------------------------------------------------------------

/** FNV-1a, 32 bit, over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

/** The seed of a player's session on a date. */
export function seedFor(playerId: string, date: CalendarDate): number {
  return fnv1a32(`${playerId}:${date}`);
}

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- helpers ---------------------------------------------------------------------------------

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical order: trust desc, level asc, slug asc, versionId asc (a total order). */
const canonicalOrder = (a: PublishedVersion, b: PublishedVersion): number =>
  TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
  EXPERIENCE_NUMBER[a.level] - EXPERIENCE_NUMBER[b.level] ||
  compare(a.slug, b.slug) ||
  compare(a.versionId, b.versionId);

/** The drills of the RECENT_SESSIONS latest sessions dated before `date`. */
function recentDrillIds(history: readonly HistoryEntry[], pool: readonly PublishedVersion[], date: CalendarDate): Set<string> {
  const drillOfVersion = new Map(pool.map((v) => [v.versionId, v.drillId]));
  const recent = new Set<string>();
  const previous = history.filter((entry) => entry.date < date).sort((a, b) => compare(b.date, a.date));
  for (const entry of previous.slice(0, RECENT_SESSIONS)) {
    for (const id of entry.drillIds ?? []) recent.add(id);
    for (const id of entry.drillVersionIds ?? []) {
      const drillId = drillOfVersion.get(id);
      if (drillId !== undefined) recent.add(drillId);
    }
  }
  return recent;
}

/** Can some subset of `minutes` sum into [low, high]? (The empty subset counts when low <= 0.) */
function canReach(minutes: readonly number[], low: number, high: number): boolean {
  if (high < 0) return false;
  if (low <= 0) return true;
  const sums = new Uint8Array(high + 1);
  sums[0] = 1;
  for (const m of minutes) {
    for (let s = high - m; s >= 0; s -= 1) if (sums[s] === 1) sums[s + m] = 1;
  }
  for (let s = low; s <= high; s += 1) if (sums[s] === 1) return true;
  return false;
}

/** How far a drill's level is from what the focus asks for: 0 the level, 1 its target, then lower ones nearest first, then higher. */
function levelRank(version: PublishedVersion, level: number): number {
  const drill = EXPERIENCE_NUMBER[version.level];
  if (drill === level) return 0;
  if (drill === level + 1) return 1;
  return drill < level ? 1 + (level - drill) : 100 + drill;
}

// --- the picker ------------------------------------------------------------------------------

export function pickSession(
  profile: SessionProfile,
  roadmap: SessionRoadmap,
  pool: readonly PublishedVersion[],
  history: readonly HistoryEntry[],
  opts: SessionOptions,
): PickedSession {
  const budget = profile.minutesPerSession;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new RangeError(`minutesPerSession must be a positive number, got ${String(budget)}`);
  }
  const skillTest = opts.retestDue?.[0];
  const testMinutes = skillTest === undefined ? 0 : SKILL_TEST_MINUTES;
  const low = budget - WINDOW_BELOW - testMinutes;
  const high = budget + WINDOW_ABOVE - testMinutes;

  // Canonical order, one version per drill, then one seeded draw per candidate.
  const seen = new Set<string>();
  const ordered = [...pool].sort(canonicalOrder).filter((v) => {
    if (seen.has(v.drillId)) return false;
    seen.add(v.drillId);
    return true;
  });
  const random = mulberry32(seedFor(opts.playerId, opts.date));
  const jitter = new Map(ordered.map((v) => [v.versionId, random()]));
  const recent = recentDrillIds(history, pool, opts.date);

  const chosen: { version: PublishedVersion; reason: string }[] = [];
  const taken = new Set<string>();
  let total = 0;
  const poolReachesWindow = canReach(
    ordered.map((v) => v.minutes),
    low,
    high,
  );

  /** Takes the version when it fits under the ceiling and the window stays reachable. */
  const take = (version: PublishedVersion, reason: string): boolean => {
    if (taken.has(version.drillId) || total + version.minutes > high) return false;
    if (poolReachesWindow) {
      const rest = ordered.filter((v) => !taken.has(v.drillId) && v.drillId !== version.drillId).map((v) => v.minutes);
      const left = total + version.minutes;
      if (!canReach(rest, low - left, high - left)) return false;
    }
    taken.add(version.drillId);
    chosen.push({ version, reason });
    total += version.minutes;
    return true;
  };

  /** The order in which a track's drills are preferred for a player at `level` there. */
  const preference = (level: number) => (a: PublishedVersion, b: PublishedVersion) =>
    Number(recent.has(a.drillId)) - Number(recent.has(b.drillId)) ||
    levelRank(a, level) - levelRank(b, level) ||
    TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
    jitter.get(a.versionId)! - jitter.get(b.versionId)! ||
    compare(a.versionId, b.versionId);

  // 1. Warm-up: a beginner drill, the warm-up track first, the shortest first.
  const warmups = ordered
    .filter((v) => v.level === 'beginner')
    .sort(
      (a, b) =>
        Number(recent.has(a.drillId)) - Number(recent.has(b.drillId)) ||
        Number(a.track !== WARMUP_TRACK) - Number(b.track !== WARMUP_TRACK) ||
        a.minutes - b.minutes ||
        TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
        jitter.get(a.versionId)! - jitter.get(b.versionId)! ||
        compare(a.versionId, b.versionId),
    );
  for (const version of warmups) if (take(version, SESSION_REASON_WARMUP)) break;

  // 2. One drill per focus skill, at the right level.
  const trackLevel = new Map<string, number>(roadmap.tracks.map((t) => [t.skill, t.level]));
  for (const focus of roadmap.focus) trackLevel.set(focus.skill, focus.level);
  for (const focus of roadmap.focus) {
    const ofTrack = ordered.filter((v) => v.track === focus.skill).sort(preference(focus.level));
    for (const version of ofTrack) if (take(version, SESSION_REASON_FOCUS)) break;
  }

  // 3. Fill: round-robin over the focus tracks, then the other tracks; non-recent drills first.
  if (total < low) {
    const focusTracks = [...new Set(roadmap.focus.map((f) => f.skill))];
    const otherTracks = [...new Set(ordered.map((v) => v.track))]
      .filter((t): t is string => t !== null && !focusTracks.includes(t))
      .sort(compare);
    const trackOrder: (string | null)[] = [...focusTracks, ...otherTracks];
    if (ordered.some((v) => v.track === null)) trackOrder.push(null);

    const lists = trackOrder.map((track) =>
      ordered
        .filter((v) => v.track === track && !taken.has(v.drillId))
        .sort(preference(track === null ? 1 : (trackLevel.get(track) ?? 1))),
    );
    const roundRobin = (lists_: PublishedVersion[][]): PublishedVersion[] => {
      const out: PublishedVersion[] = [];
      for (let round = 0; lists_.some((list) => round < list.length); round += 1) {
        for (const list of lists_) if (round < list.length) out.push(list[round]!);
      }
      return out;
    };
    const fillOrder = [
      ...roundRobin(lists.map((list) => list.filter((v) => !recent.has(v.drillId)))),
      ...roundRobin(lists.map((list) => list.filter((v) => recent.has(v.drillId)))),
    ];
    while (total < low) {
      const next = fillOrder.find((v) => take(v, SESSION_REASON_FILL));
      if (next === undefined) break;
    }
  }

  const items: PickedItem[] = chosen.map(({ version, reason }) => ({
    drillVersionId: version.versionId,
    minutes: version.minutes,
    reason,
    done: false,
    content: version.content,
    status: version.status,
    attribution: version.attribution,
  }));
  const session: PickedSession = { date: opts.date, planner: 'rules', totalMinutes: total + testMinutes, items };
  if (skillTest !== undefined) {
    session.skillTest = {
      slug: skillTest.slug,
      skill: skillTest.skill,
      metric: skillTest.metric,
      unit: skillTest.unit,
      direction: skillTest.direction,
      protocol: skillTest.protocol,
      equipment: skillTest.equipment,
    };
  }
  return session;
}
