// The coach agent's three tools (fc-mol-zo6.4): listCandidateDrills, getSkillGraph, getProgress.
//
// READ-ONLY by construction: each tool only reads data the server handed to createCoachTools
// (the candidate set from planner/candidates, the skill graph, the player's levels). There is no
// database handle, no file or network access and no write path in here, so the agent can only
// ever see, and therefore only ever reference, drill versions from the approved candidate set.
//
// Prompt-injection guard: candidate drill text and skill names are contributed content. Every
// such string leaves a tool wrapped by dataBlock(), i.e. inside `<data field="...">...</data>`,
// after `<` and `>` in the text were replaced by their full-width forms so the text cannot close
// its own block or open another. The agent's instructions say what the blocks mean.
//
// Readings of the criteria (the bead names the tools, not their shapes):
//   - the inputs are snapshotted (copied) when the tools are created;
//   - listCandidateDrills takes an optional `skill` and lists the candidates that train it;
//   - getProgress lists every skill of the graph with the player's level, 1 where none is known
//     (the planner's own reading: a missing level is level 1).
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { PublishedVersion } from "../../commons/repo";
import type { Levels } from "../../planner/candidates";
import type { SkillGraph } from "../../shared/commons";
import { SKILL_LEVEL_MIN } from "../../shared/domain";
import { pickLocalized } from "../../shared/primitives";
import type { Locale, LocalizedText } from "../../shared/primitives";

export interface CoachToolDeps {
  /** The approved candidate drills (planner/candidates' output): the only drills the agent may see. */
  candidates: readonly PublishedVersion[];
  graph: SkillGraph;
  levels: Levels;
  /** The language of the texts the tools return (requested -> ru -> en). */
  locale: Locale;
}

/** Full-width look-alikes: the text stays readable, but it can no longer form a tag. */
const neutralise = (text: string): string => text.replaceAll("<", "＜").replaceAll(">", "＞");

/** `text` as clearly delimited DATA. `field` is a fixed label chosen by the server, never contributed text. */
export function dataBlock(field: string, text: string): string {
  return `<data field="${field}">${neutralise(text)}</data>`;
}

const pick = (text: LocalizedText | undefined, locale: Locale, fallback: string): string =>
  (text === undefined ? undefined : pickLocalized(text, locale)) ?? fallback;

export function createCoachTools(deps: CoachToolDeps) {
  const candidates = deps.candidates.map((c) => structuredClone(c));
  const graph = structuredClone(deps.graph);
  const levels: Levels = { ...deps.levels };
  const { locale } = deps;

  const listCandidateDrills = createTool({
    id: "listCandidateDrills",
    description:
      "Lists the approved candidate drills the session may be built from. Each has a drillVersionId " +
      "(the only id you may use in the plan), minutes, level, equipment, the skills it trains, and a title " +
      "and goal inside <data> blocks. Optionally narrow the list to one skill.",
    inputSchema: z.object({ skill: z.string().optional() }),
    execute: async ({ skill }) => ({
      drills: candidates
        .filter((c) => skill === undefined || c.skills.includes(skill))
        .map((c) => ({
          drillVersionId: c.versionId,
          slug: c.slug,
          minutes: c.minutes,
          level: c.level,
          equipment: c.equipment,
          skills: c.skills,
          title: dataBlock("title", pick(c.content.title, locale, c.slug)),
          goal: dataBlock("goal", pick(c.content.goal, locale, c.slug)),
        })),
    }),
  });

  const getSkillGraph = createTool({
    id: "getSkillGraph",
    description: "Returns the skills of the sport: slug, parent skill, prerequisites (skill and minLevel) and the name inside a <data> block.",
    inputSchema: z.object({}),
    execute: async () => ({
      sport: graph.sport,
      skills: graph.nodes.map((n) => ({
        slug: n.slug,
        parent: n.parent,
        name: dataBlock("name", pick(n.names, locale, n.slug)),
        prerequisites: n.prerequisites,
      })),
    }),
  });

  const getProgress = createTool({
    id: "getProgress",
    description: "Returns the player's current level (1 to 5) in every skill of the graph; level 1 where nothing is measured yet.",
    inputSchema: z.object({}),
    execute: async () => ({
      levels: graph.nodes.map((n) => ({
        skill: n.slug,
        level: Object.hasOwn(levels, n.slug) ? (levels[n.slug] ?? SKILL_LEVEL_MIN) : SKILL_LEVEL_MIN,
      })),
    }),
  });

  return { listCandidateDrills, getSkillGraph, getProgress };
}
