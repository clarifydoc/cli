/**
 * `clarifydoc rules init`: dependency rules drawn from the folder dependency
 * matrix as it stands, so a team can gate CI on layering without writing the
 * `rules` section of `.clarifydoc/config.json` by hand.
 *
 * Units are folders at a fixed depth (the same cut `clarifydoc_architecture
 * view=modules` draws), written as globs the rules language already has. Two
 * kinds of rule come out, each one `to` rule per unit:
 *
 * - "below its dependents": a unit must not import a unit that depends on it,
 *   directly or through others. Only dependency paths that exist are turned
 *   into order, so two unrelated units are never ranked against each other (no
 *   arbitrary topological order frozen into a rule);
 * - "outside its cycle": a unit in a dependency cycle (a strongly connected
 *   group of folders) must not import the other units of that group. Every
 *   edge inside the cycle breaks it, which is the point: those edges are the
 *   baseline, and what the rule stops is a NEW import joining the group.
 *
 * Never an `allowOnly` per unit: that would freeze accidents as rules.
 */
import type { LayerViolation } from "../types/analysis.js";
import { detectRuleViolations, stronglyConnected } from "./layer-analyzer.js";
import type { DependencyRuleInput } from "./project-config.js";

/** The unit a file belongs to at `depth`, or null for a file at the project root. */
export function unitOf(file: string, depth: number): string | null {
  const parts = file.split("/");
  // A folder whose name holds glob characters cannot be written as a pattern that matches only itself: no unit.
  if (parts.length <= 1) return null;
  const unit = parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
  return /[*?[\]{}()!]/.test(unit) ? null : unit;
}

export interface InitialRules {
  rules: DependencyRuleInput[];
  /** Units found, their dependency edges and the cycles (groups of two or more units). */
  units: number;
  edges: number;
  cycles: string[][];
}

/**
 * The rules for a project's file graph.
 *
 * @param graph - File → files it imports (`componentGraph`)
 * @param depth - Folder depth that cuts the units
 */
export function initialRules(graph: Readonly<Record<string, string[]>>, depth: number): InitialRules {
  const units = new Set<string>();
  const out = new Map<string, Set<string>>();
  for (const [from, targets] of Object.entries(graph)) {
    const a = unitOf(from, depth);
    if (a === null) continue;
    units.add(a);
    for (const t of targets) {
      const b = unitOf(t, depth);
      if (b === null) continue;
      units.add(b);
      if (a !== b) (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
    }
  }
  const component = stronglyConnected(out);
  const groups = new Map<number, string[]>();
  for (const [u, c] of component) (groups.get(c) ?? groups.set(c, []).get(c)!).push(u);
  for (const g of groups.values()) g.sort();

  // Who depends on a unit, directly or through others.
  const dependents = new Map<string, Set<string>>();
  for (const [a, bs] of out) for (const b of bs) (dependents.get(b) ?? dependents.set(b, new Set()).get(b)!).add(a);
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length) for (const d of dependents.get(todo.pop()!) ?? []) if (d !== start && !seen.has(d)) { seen.add(d); todo.push(d); }
    return seen;
  };

  const sorted = [...units].sort();
  // `a/*` for a unit that holds deeper units of its own, else `a/**`: the unit is its own files only.
  const glob = (u: string): string => (sorted.some((o) => o.startsWith(`${u}/`)) ? `${u}/*` : `${u}/**`);
  const rules: DependencyRuleInput[] = [];
  for (const u of sorted) {
    const peers = new Set(component.has(u) ? groups.get(component.get(u)!)!.filter((p) => p !== u) : []);
    const above = [...reach(u)].filter((d) => !peers.has(d)).sort();
    if (above.length) {
      rules.push({
        name: `layering: ${u} stays below its dependents`,
        from: [glob(u)],
        to: above.map(glob),
        severity: "error",
        description: `${u} is imported, directly or not, by these folders; importing any of them would turn that order around. Written by clarifydoc rules init.`,
      });
    }
    if (peers.size) {
      rules.push({
        name: `layering: ${u} stays out of its cycle`,
        from: [glob(u)],
        to: [...peers].sort().map(glob),
        severity: "error",
        description: `${u} is in a dependency cycle with these folders; the imports among them today are the baseline, a new one is drift. Written by clarifydoc rules init.`,
      });
    }
  }
  return {
    rules,
    units: units.size,
    edges: [...out.values()].reduce((n, s) => n + s.size, 0),
    cycles: [...groups.values()].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  };
}

/** Which of `proposed` an existing config takes (new names) and which it already has by name. */
export function mergeRules(existing: readonly unknown[], proposed: readonly DependencyRuleInput[]): { added: DependencyRuleInput[]; kept: string[] } {
  const names = new Set(existing.map((r) => (r && typeof r === "object" ? (r as { name?: unknown }).name : undefined)));
  const added: DependencyRuleInput[] = [];
  const kept: string[] = [];
  for (const r of proposed) {
    if (names.has(r.name)) kept.push(r.name);
    else added.push(r);
  }
  return { added, kept };
}

/** Today's breaches of `rules` over the graph: what a baseline records. */
export function violationsOf(graph: Record<string, string[]>, rules: readonly DependencyRuleInput[]): LayerViolation[] {
  return detectRuleViolations([], graph, {}, rules.map((r) => ({
    name: r.name, from: r.from, to: r.to, except: r.except ?? [], severity: r.severity ?? "error",
  })));
}
