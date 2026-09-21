// The drill swap picker (fc-mol-urn.6): which drill replaces one unfinished item of today's session when the
// player asks for something easier or harder. Pure: no database, clock or randomness, no input is mutated.
//
//   pickSwap(subject, direction, pool, inSession) -> PublishedVersion | undefined
//
// `pool` is the player's CANDIDATE SET (planner/candidates.ts: equipment, space, partner, age, trust status,
// level and prerequisite rules already applied, exactly as for pickSession), so a replacement can never be a
// drill the player may not be given. The picker only chooses among it.
//
// The rule, in order:
//   1. LINKED: a candidate that the subject lists as its regression (easier) or progression (harder). The
//      commons store the links as the linked drills' titles in the version's content (`regressions` /
//      `progressions`), not as ids, so a candidate is linked when its `title` equals such an entry in at least
//      one locale. Several linked candidates: the nearest in minutes, then the higher trust status, then slug.
//   2. else the NEAREST LOWER (easier) / HIGHER (harder) LEVEL candidate of the SAME SKILL (`track`): the level
//      nearest to the subject's first, then the nearest in minutes ("similar minutes" is a preference, not a
//      cut-off: the swap never fails for want of an exact match), then the higher trust status, then slug.
//   3. else undefined (the route answers 409 "no alternative").
//
// Readings the criteria leave open:
//   * A LINK ONLY COUNTS FORWARD: the subject's own lists. (The seed's lists are mostly symmetric.) A linked
//     regression may be of the SAME level as the subject (the seed links sibling drills); the link decides, not
//     the level.
//   * A drill of the session (`inSession`, drill ids) and the subject itself are never the replacement, so a
//     swap cannot put one drill in a session twice. A subject with no track has only rule 1.
//   * The level of a drill is its ExperienceLevel number (candidates.EXPERIENCE_NUMBER).
import type { PublishedVersion } from '../commons/repo';
import { LOCALES } from '../shared/primitives';
import type { LocalizedText } from '../shared/primitives';
import { EXPERIENCE_NUMBER, TRUST_RANK } from './candidates';

export type SwapDirection = 'easier' | 'harder';

/** What the picker reads of the drill being replaced (a PublishedVersion fits; so does an older version's data). */
export type SwapSubject = Pick<PublishedVersion, 'drillId' | 'track' | 'level' | 'minutes' | 'content'>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const usable = (text: string | undefined): text is string => typeof text === 'string' && text.trim() !== '';

/** The same drill title: equal, non-blank text in at least one locale. */
function sameTitle(a: LocalizedText, b: LocalizedText): boolean {
  return LOCALES.some((locale) => usable(a[locale]) && a[locale]!.trim() === b[locale]?.trim());
}

/** Nearest in minutes, then the higher trust status, then slug, then version id (a total order). */
const byMinutes = (subject: SwapSubject) => (a: PublishedVersion, b: PublishedVersion) =>
  Math.abs(a.minutes - subject.minutes) - Math.abs(b.minutes - subject.minutes) ||
  TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
  compare(a.slug, b.slug) ||
  compare(a.versionId, b.versionId);

export function pickSwap(
  subject: SwapSubject,
  direction: SwapDirection,
  pool: readonly PublishedVersion[],
  inSession: ReadonlySet<string>,
): PublishedVersion | undefined {
  const free = pool.filter((v) => v.drillId !== subject.drillId && !inSession.has(v.drillId));

  // 1. The drills the subject links to in this direction.
  const links = direction === 'easier' ? subject.content.regressions : subject.content.progressions;
  const linked = free.filter((v) => v.content.title !== undefined && links.some((link) => sameTitle(link, v.content.title!)));
  const [link] = linked.sort(byMinutes(subject));
  if (link !== undefined) return link;

  // 2. The nearest lower / higher level of the same skill.
  if (subject.track === null) return undefined;
  const level = EXPERIENCE_NUMBER[subject.level];
  const step = (v: PublishedVersion): number => (direction === 'easier' ? level - EXPERIENCE_NUMBER[v.level] : EXPERIENCE_NUMBER[v.level] - level);
  const [next] = free
    .filter((v) => v.track === subject.track && step(v) > 0)
    .sort((a, b) => step(a) - step(b) || byMinutes(subject)(a, b));
  return next;
}
