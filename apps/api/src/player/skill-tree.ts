// Skill tree state derivation (fc-mol-0bt.2). Pure: no database, clock or randomness, and no input is
// mutated. Turns the sport's skill graph, the player's track levels and per-node completed drill counts
// into the contract's `tree` (shared/journey.ts TreeTrack[]): one entry per track, each sub-skill
// mastered, training or locked.
//
// Readings of the criteria (they leave these open; each is the simplest that fits):
//   * Tracks are the graph's root nodes (parent null); a track's sub-skills are the nodes under it, in
//     the order the graph lists them (getSkillGraph: a parent before its children, siblings by order).
//   * A node's level is its 1-based position in its track, capped at SKILL_LEVEL_MAX - 1 so that the top
//     track level can master every node. Levels exist per TRACK (estimateLevels); a missing track level
//     is DEFAULT_TRACK_LEVEL.
//   * mastered: the track level is strictly above the node's level AND the node has at least
//     MASTERY_MIN_DRILLS completed drills.
//   * A prerequisite {skill, minLevel} is met when the level of the prerequisite skill's TRACK is at
//     least minLevel (inclusive). A prerequisite that is not a node of the graph is never met.
//   * training: a not-mastered node named in the focus (a focus entry naming a track means that track's
//     first not-mastered node), or the track's frontier: its first not-mastered node whose
//     prerequisites are met. When none is met the first not-mastered node still trains, so a track that
//     is not finished always has a training node. Everything else is locked.
//   * Precedence: mastered, then training, then locked.
// Prerequisites are compared to levels, never followed, so a prerequisite cycle cannot loop; the parent
// chain is walked with a guard, and a node whose chain has no root (a cycle, a missing parent) is left out.
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from "../shared/domain";
import type { RoadmapFocus, RoadmapTrack } from "../shared/domain";
import type { SkillNode } from "../shared/commons";
import type { TreeNode, TreeTrack } from "../shared/journey";
import { pickLocalized } from "../shared/primitives";
import type { Locale } from "../shared/primitives";

/** Completed drills a node needs before it can be mastered. */
export const MASTERY_MIN_DRILLS = 3;

/** The level of a track the player has no entry for: a beginner's. */
export const DEFAULT_TRACK_LEVEL = SKILL_LEVEL_MIN;

/** The part of a skill node the derivation reads; a SkillGraph is assignable to TreeGraph. */
export interface TreeGraph {
  nodes: readonly Pick<SkillNode, "slug" | "parent" | "names" | "prerequisites">[];
}

/** A focus entry: a track slug or a sub-skill slug. A roadmap's `focus` array fits as is. */
export type TreeFocus = Pick<RoadmapFocus, "skill">;

export function deriveTree(
  graph: TreeGraph,
  levels: readonly RoadmapTrack[],
  completedDrillCounts: Readonly<Record<string, number>>,
  focus: readonly TreeFocus[],
  locale: Locale = "en",
): TreeTrack[] {
  const nodes: TreeGraph["nodes"][number][] = [];
  const bySlug = new Map<string, TreeGraph["nodes"][number]>();
  for (const each of graph.nodes) {
    if (bySlug.has(each.slug)) continue;
    bySlug.set(each.slug, each);
    nodes.push(each);
  }

  /** The track (root node) a skill belongs to, or null for an unknown skill or a broken parent chain. */
  const rootOf = (slug: string): string | null => {
    const seen = new Set<string>();
    let current = bySlug.get(slug);
    while (current !== undefined) {
      if (current.parent === null) return current.slug;
      if (seen.has(current.slug)) return null;
      seen.add(current.slug);
      current = bySlug.get(current.parent);
    }
    return null;
  };

  const levelOf = new Map<string, number>();
  for (const each of levels) if (!levelOf.has(each.skill)) levelOf.set(each.skill, each.level);
  const trackLevel = (root: string): number => levelOf.get(root) ?? DEFAULT_TRACK_LEVEL;

  const members = new Map<string, TreeGraph["nodes"][number][]>();
  for (const each of nodes) if (each.parent === null) members.set(each.slug, []);
  for (const each of nodes) {
    if (each.parent === null) continue;
    const root = rootOf(each.slug);
    if (root !== null) members.get(root)!.push(each);
  }

  const focused = new Set(focus.map((each) => each.skill));
  const drillsOf = (slug: string): number => (Object.hasOwn(completedDrillCounts, slug) ? completedDrillCounts[slug]! : 0);
  const prerequisitesMet = (each: TreeGraph["nodes"][number]): boolean =>
    each.prerequisites.every((prerequisite) => {
      const root = rootOf(prerequisite.skill);
      return root !== null && trackLevel(root) >= prerequisite.minLevel;
    });

  return [...members].map(([root, subSkills]) => {
    const level = trackLevel(root);
    const entries = subSkills.map((each, index) => {
      const nodeLevel = Math.min(index + 1, SKILL_LEVEL_MAX - 1);
      return { node: each, nodeLevel, mastered: level > nodeLevel && drillsOf(each.slug) >= MASTERY_MIN_DRILLS };
    });
    const open = entries.filter((entry) => !entry.mastered);
    const frontier = focused.has(root) ? open[0] : (open.find((entry) => prerequisitesMet(entry.node)) ?? open[0]);

    const treeNodes: TreeNode[] = entries.map((entry) => {
      const state: TreeNode["state"] = entry.mastered ? "mastered" : entry === frontier || focused.has(entry.node.slug) ? "training" : "locked";
      const name = pickLocalized(entry.node.names, locale) ?? entry.node.slug;
      return { slug: entry.node.slug, name, state, level: entry.nodeLevel };
    });
    return { track: root, nodes: treeNodes };
  });
}
