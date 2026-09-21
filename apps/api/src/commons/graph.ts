// Seeding-side skill-graph integrity check (fc-mol-f2u.3).
//
// `validateGraph(nodes, drills)` finds cycles along prerequisites and along parent links,
// references to skills or drills that do not exist, and duplicate skill slugs, and returns a
// topological order of the skills. It is the seeding job's counterpart of the wire-side
// `graphProblems` in ../shared/commons (which has no cycle paths and no order).
//
// Pure: no I/O, no side effects, input untouched. The input types are structural minimums
// (extra fields are ignored), so any seed file shape with these fields fits.
//
// Derived (the criteria leave them open):
//   - A drill trains `skill`, plus optionally more in `skills`; each must be a node slug.
//     `progression` / `regression` hold drill slugs (a single string or a list); each must be
//     a slug of a drill in the input, so a skill slug there is dangling.
//   - `mixed_cycle`: a loop that needs both parent and prerequisite edges (a's parent is b and
//     b requires a). Neither chain loops alone, yet no order can put both first. It is only
//     reported when no parent_cycle / prerequisite_cycle already lies within that loop.
//   - `duplicate_slug` covers skill nodes only; it makes the order ill-defined.
//   - Cycle paths follow the "depends on" direction (a requires b: a -> b; a's parent is b:
//     a -> b), start at the smallest slug of the loop, end on it again, and are the shortest
//     such path with ties broken by slug. One cycle is reported per strongly connected loop.
//   - `order`: Kahn's algorithm over prerequisite AND parent edges, the smallest ready slug
//     first, each distinct slug once. With any cycle it is []. With only dangling references
//     or duplicates it is still computed over the resolvable nodes (dangling edges skipped).
//   - Problems come sorted by kind (the order of PROBLEM_KINDS), then slug, then target, then
//     path, so the report does not depend on the order of the input.

export interface SeedSkillNode {
  slug: string;
  parent?: string | null;
  prerequisites?: { skill: string; minLevel?: number }[];
}

export interface SeedDrill {
  slug: string;
  /** The track skill the drill trains. */
  skill: string;
  /** Further skills the drill trains. */
  skills?: string[];
  /** Drill slugs. */
  progression?: string[] | string;
  /** Drill slugs. */
  regression?: string[] | string;
}

const PROBLEM_KINDS = [
  "prerequisite_cycle",
  "parent_cycle",
  "mixed_cycle",
  "dangling_prerequisite",
  "dangling_parent",
  "dangling_drill_skill",
  "dangling_progression",
  "dangling_regression",
  "duplicate_slug",
] as const;

export type GraphProblemKind = (typeof PROBLEM_KINDS)[number];

export interface GraphProblem {
  kind: GraphProblemKind;
  /** The node (or drill) the problem is about; for a cycle, the first slug of `path`. */
  slug: string;
  /** Cycles only: first slug repeated at the end, e.g. ["a", "b", "c", "a"]. */
  path?: string[];
  /** Dangling references only: the slug that does not exist. */
  target?: string;
  message: string;
}

export interface GraphReport {
  ok: boolean;
  problems: GraphProblem[];
  order: string[];
}

type Adjacency = Map<string, string[]>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);
const asList = (value: string[] | string | undefined): string[] =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;

/** Strongly connected components (iterative Tarjan, so a long chain cannot overflow the stack). */
function components(slugs: string[], edges: Adjacency): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;

  const open = (slug: string): { slug: string; next: number } => {
    index.set(slug, counter);
    low.set(slug, counter);
    counter++;
    stack.push(slug);
    onStack.add(slug);
    return { slug, next: 0 };
  };

  for (const root of slugs) {
    if (index.has(root)) continue;
    const work = [open(root)];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = edges.get(frame.slug) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!index.has(target)) work.push(open(target));
        else if (onStack.has(target)) low.set(frame.slug, Math.min(low.get(frame.slug)!, index.get(target)!));
        continue;
      }
      work.pop();
      const caller = work[work.length - 1];
      if (caller) low.set(caller.slug, Math.min(low.get(caller.slug)!, low.get(frame.slug)!));
      if (low.get(frame.slug) !== index.get(frame.slug)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.slug);
      found.push(component);
    }
  }
  return found;
}

/** The loops of a graph: one per strongly connected component that contains a cycle. */
function loops(slugs: string[], edges: Adjacency): string[][] {
  return components(slugs, edges)
    .filter((component) => component.length > 1 || (edges.get(component[0]!) ?? []).includes(component[0]!))
    .map((component) => component.sort(compare));
}

/** The shortest cycle through `start` inside `members` (ties by slug), first slug repeated last. */
function cycleThrough(start: string, members: Set<string>, edges: Adjacency): string[] {
  const cameFrom = new Map<string, string>();
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const targets = (edges.get(current) ?? []).filter((target) => members.has(target));
    if (targets.includes(start)) {
      const back: string[] = [];
      for (let step = current; step !== start; step = cameFrom.get(step)!) back.push(step);
      return [start, ...back.reverse(), start];
    }
    for (const target of targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      cameFrom.set(target, current);
      queue.push(target);
    }
  }
  return [start, start];
}

/** Min-heap of slugs, so the smallest ready skill is next. */
class SlugHeap {
  private readonly items: string[] = [];
  get size(): number {
    return this.items.length;
  }
  push(slug: string): void {
    const items = this.items;
    items.push(slug);
    for (let at = items.length - 1; at > 0; ) {
      const up = (at - 1) >> 1;
      if (compare(items[up]!, items[at]!) <= 0) break;
      [items[up], items[at]] = [items[at]!, items[up]!];
      at = up;
    }
  }
  pop(): string {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let at = 0; ; ) {
        const left = 2 * at + 1;
        const right = left + 1;
        let smallest = at;
        if (left < items.length && compare(items[left]!, items[smallest]!) < 0) smallest = left;
        if (right < items.length && compare(items[right]!, items[smallest]!) < 0) smallest = right;
        if (smallest === at) break;
        [items[smallest], items[at]] = [items[at]!, items[smallest]!];
        at = smallest;
      }
    }
    return top;
  }
}

/** Kahn's algorithm: `needs` maps a slug to what must come before it. Assumes no cycle. */
function topologicalOrder(slugs: string[], needs: Adjacency): string[] {
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready = new SlugHeap();
  for (const slug of slugs) {
    const before = needs.get(slug) ?? [];
    waiting.set(slug, before.length);
    if (before.length === 0) ready.push(slug);
    for (const each of before) {
      const list = dependents.get(each);
      if (list) list.push(slug);
      else dependents.set(each, [slug]);
    }
  }
  const order: string[] = [];
  while (ready.size > 0) {
    const slug = ready.pop();
    order.push(slug);
    for (const dependent of dependents.get(slug) ?? []) {
      const left = waiting.get(dependent)! - 1;
      waiting.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  return order;
}

export function validateGraph(nodes: readonly SeedSkillNode[], drills: readonly SeedDrill[]): GraphReport {
  const problems: GraphProblem[] = [];

  // Distinct skills, and the union of the edges of nodes that share a slug.
  const counts = new Map<string, number>();
  const parents = new Map<string, Set<string>>();
  const requires = new Map<string, Set<string>>();
  for (const each of nodes) {
    counts.set(each.slug, (counts.get(each.slug) ?? 0) + 1);
    const parentSet = parents.get(each.slug) ?? new Set<string>();
    if (each.parent != null) parentSet.add(each.parent);
    parents.set(each.slug, parentSet);
    const requireSet = requires.get(each.slug) ?? new Set<string>();
    for (const prerequisite of each.prerequisites ?? []) requireSet.add(prerequisite.skill);
    requires.set(each.slug, requireSet);
  }
  const slugs = [...counts.keys()].sort(compare);
  const skillExists = (slug: string): boolean => counts.has(slug);

  for (const slug of slugs) {
    if (counts.get(slug)! > 1) {
      problems.push({ kind: "duplicate_slug", slug, message: `Skill slug "${slug}" is used by more than one node` });
    }
  }

  // Dangling skill references; the edges that resolve go into the three graphs below.
  const parentEdges: Adjacency = new Map();
  const prerequisiteEdges: Adjacency = new Map();
  const allEdges: Adjacency = new Map();
  for (const slug of slugs) {
    const parentTargets = sortedUnique(parents.get(slug)!);
    const prerequisiteTargets = sortedUnique(requires.get(slug)!);
    for (const target of parentTargets.filter((each) => !skillExists(each))) {
      problems.push({ kind: "dangling_parent", slug, target, message: `Parent "${target}" of "${slug}" is not a skill` });
    }
    for (const target of prerequisiteTargets.filter((each) => !skillExists(each))) {
      problems.push({
        kind: "dangling_prerequisite",
        slug,
        target,
        message: `Prerequisite "${target}" of "${slug}" is not a skill`,
      });
    }
    const resolvedParents = parentTargets.filter(skillExists);
    const resolvedPrerequisites = prerequisiteTargets.filter(skillExists);
    parentEdges.set(slug, resolvedParents);
    prerequisiteEdges.set(slug, resolvedPrerequisites);
    allEdges.set(slug, sortedUnique([...resolvedParents, ...resolvedPrerequisites]));
  }

  // Dangling drill references.
  const drillSlugs = new Set(drills.map((each) => each.slug));
  for (const each of drills) {
    for (const target of sortedUnique([each.skill, ...(each.skills ?? [])]).filter((slug) => !skillExists(slug))) {
      problems.push({
        kind: "dangling_drill_skill",
        slug: each.slug,
        target,
        message: `Skill "${target}" of drill "${each.slug}" is not a skill`,
      });
    }
    const links = [
      ["dangling_progression", "progression", each.progression],
      ["dangling_regression", "regression", each.regression],
    ] as const;
    for (const [kind, label, value] of links) {
      for (const target of sortedUnique(asList(value)).filter((slug) => !drillSlugs.has(slug))) {
        problems.push({
          kind,
          slug: each.slug,
          target,
          message: `The ${label} "${target}" of drill "${each.slug}" is not a drill`,
        });
      }
    }
  }

  // Cycles.
  const cycleMembers = new Set<string>();
  for (const [kind, label, edges] of [
    ["prerequisite_cycle", "prerequisites", prerequisiteEdges],
    ["parent_cycle", "parents", parentEdges],
  ] as const) {
    for (const members of loops(slugs, edges)) {
      const path = cycleThrough(members[0]!, new Set(members), edges);
      problems.push({ kind, slug: path[0]!, path, message: `Cycle along ${label}: ${path.join(" -> ")}` });
      for (const slug of path) cycleMembers.add(slug);
    }
  }
  for (const members of loops(slugs, allEdges)) {
    if (members.some((slug) => cycleMembers.has(slug))) continue;
    const path = cycleThrough(members[0]!, new Set(members), allEdges);
    problems.push({
      kind: "mixed_cycle",
      slug: path[0]!,
      path,
      message: `Cycle along parents and prerequisites: ${path.join(" -> ")}`,
    });
  }

  const rank = (kind: GraphProblemKind): number => PROBLEM_KINDS.indexOf(kind);
  problems.sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      compare(a.slug, b.slug) ||
      compare(a.target ?? "", b.target ?? "") ||
      compare(a.path?.join("\0") ?? "", b.path?.join("\0") ?? ""),
  );

  const hasCycle = problems.some((problem) => problem.path !== undefined);
  return {
    ok: problems.length === 0,
    problems,
    order: hasCycle ? [] : topologicalOrder(slugs, allEdges),
  };
}
