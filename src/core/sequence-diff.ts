import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * What a flow does, as a tree, and how two such trees differ — a route's
 * sequence at the base of a change against the same route at its head.
 *
 * The tree follows the walk `buildSequence` draws (calls depth-first in
 * source order, the data each function reaches, recursion marked rather than
 * followed, `depth` hops), with each step named by what it is, not where it
 * is: `OrderService.create()`, `DB orders: insert`, `HTTP POST /payments`.
 * Lines move with every edit; names move only when the behaviour does.
 *
 * Two trees are aligned child list by child list (longest common
 * subsequence of the names); what one side has and the other lacks is
 * removed or added, and a step removed in one place and added in another is
 * reported once, as moved.
 */

export interface SequenceStep {
  name: string;
  children: SequenceStep[];
}

export interface SequenceChange {
  kind: "added" | "removed" | "moved";
  /** The steps above it, from the entry point down. */
  path: string[];
  step: string;
  /** For a move: where it was. */
  from?: string[];
}

function callIndex(summary: ProjectAnalysis): Map<string, SymbolLink[]> {
  const calls = new Map<string, SymbolLink[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.relation === "reference" || l.sourceSymbol === "(reference)" || l.navigational) continue;
    const k = `${l.sourceFile}::${l.sourceSymbol}`;
    (calls.get(k) ?? calls.set(k, []).get(k)!).push(l);
  }
  for (const list of calls.values()) list.sort((a, b) => a.sourceLine - b.sourceLine || byOrdinal(a.targetSymbol, b.targetSymbol));
  return calls;
}

const stepName = (l: SymbolLink): string => (l.relation === "http" ? `HTTP ${l.callName}` : `${l.targetSymbol.replace(/^route:/, "")}()`);

/** The flow from `seed`, as a tree of named steps. */
export function sequenceTree(summary: ProjectAnalysis, seed: { file: string; symbol: string }, opts: { depth?: number } = {}): SequenceStep {
  const depth = opts.depth ?? 8;
  const calls = callIndex(summary);
  const access = new Map<string, NonNullable<ProjectAnalysis["symbolDataAccess"]>>();
  for (const d of summary.symbolDataAccess ?? []) {
    const k = `${d.file}::${d.symbol}`;
    (access.get(k) ?? access.set(k, []).get(k)!).push(d);
  }
  const walk = (file: string, symbol: string, level: number, path: Set<string>): SequenceStep[] => {
    const key = `${file}::${symbol}`;
    const steps: SequenceStep[] = [];
    for (const d of access.get(key) ?? []) {
      const what = d.access === "queue-publish" ? `Queue ${d.datastore ?? d.entity}: publish` : d.access === "queue-consume" ? `Queue ${d.datastore ?? d.entity}: consume` : `DB ${d.entity}: ${d.access ?? d.sites[0]?.name ?? "query"}`;
      if (!steps.some((s) => s.name === what)) steps.push({ name: what, children: [] });
    }
    for (const l of calls.get(key) ?? []) {
      const callee = `${l.targetFile}::${l.targetSymbol}`;
      if (path.has(callee)) {
        steps.push({ name: `${stepName(l)} ↻`, children: [] });
        continue;
      }
      steps.push({ name: stepName(l), children: level < depth ? walk(l.targetFile, l.targetSymbol, level + 1, new Set([...path, callee])) : [] });
    }
    return steps;
  };
  return { name: seed.symbol.replace(/^route:/, ""), children: walk(seed.file, seed.symbol, 1, new Set([`${seed.file}::${seed.symbol}`])) };
}

/** The longest common subsequence of two name lists, as index pairs. */
function lcs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const t: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** How the flow `head` differs from `base`: steps added, removed, and moved (removed in one place, added in another). */
export function diffSequences(base: SequenceStep, head: SequenceStep): SequenceChange[] {
  const raw: SequenceChange[] = [];
  const visit = (a: SequenceStep, b: SequenceStep, path: string[]) => {
    const pairs = lcs(a.children.map((c) => c.name), b.children.map((c) => c.name));
    const keptA = new Set(pairs.map(([i]) => i));
    const keptB = new Set(pairs.map(([, j]) => j));
    a.children.forEach((c, i) => { if (!keptA.has(i)) raw.push({ kind: "removed", path, step: c.name }); });
    b.children.forEach((c, j) => { if (!keptB.has(j)) raw.push({ kind: "added", path, step: c.name }); });
    for (const [i, j] of pairs) visit(a.children[i]!, b.children[j]!, [...path, a.children[i]!.name]);
  };
  visit(base, head, [base.name]);
  // A step removed here and added there, once each: a move.
  const out: SequenceChange[] = [];
  const removed = raw.filter((c) => c.kind === "removed");
  const added = raw.filter((c) => c.kind === "added");
  const paired = new Set<SequenceChange>();
  for (const r of removed) {
    const sameR = removed.filter((x) => x.step === r.step);
    const sameA = added.filter((x) => x.step === r.step && !paired.has(x));
    if (sameR.length === 1 && sameA.length === 1) {
      paired.add(r).add(sameA[0]!);
      out.push({ kind: "moved", path: sameA[0]!.path, step: r.step, from: r.path });
    }
  }
  for (const c of raw) if (!paired.has(c)) out.push(c);
  return out;
}

/** The changes as an indented list for a terminal or a PR comment. */
export function renderSequenceDiff(title: string, changes: readonly SequenceChange[]): string {
  if (!changes.length) return `${title}: the flow is unchanged.\n`;
  const lines = [`${title}: ${changes.length} change${changes.length === 1 ? "" : "s"} in the flow`];
  const where = (path: readonly string[]) => path.slice(1).join(" → ") || "the entry point";
  for (const c of changes) {
    if (c.kind === "moved") lines.push(`  ~ ${c.step} moved: from ${where(c.from!)} to ${where(c.path)}`);
    else lines.push(`  ${c.kind === "added" ? "+" : "-"} ${c.step} (${c.kind === "added" ? "now" : "was"} called from ${where(c.path)})`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The flows of every API route, as a committed baseline (`seq --lock`): route
 * → its step tree. Keys are `METHOD path`; a route reached under two
 * declarations keeps the first.
 */
export interface FlowLock {
  version: 1;
  flows: Record<string, SequenceStep>;
}

export function flowLock(summary: ProjectAnalysis, anchorOf: (r: ProjectAnalysis["routeMap"][number]) => string | null, opts: { depth?: number } = {}): FlowLock {
  const flows: Record<string, SequenceStep> = {};
  for (const r of summary.routeMap ?? []) {
    if (r.kind !== "api" || !r.filePath) continue;
    const key = `${(r.httpMethod ?? "ANY").toUpperCase()} ${r.path}`;
    if (key in flows) continue;
    const anchor = anchorOf(r);
    if (anchor) flows[key] = sequenceTree(summary, { file: r.filePath, symbol: anchor }, opts);
  }
  return { version: 1, flows: Object.fromEntries(Object.entries(flows).sort(([a], [b]) => byOrdinal(a, b))) };
}

/** Each route whose flow differs from the lock — changed, new or gone — rendered; empty when every flow matches. */
export function checkFlowLock(lock: FlowLock, current: FlowLock): string[] {
  const out: string[] = [];
  for (const [route, tree] of Object.entries(current.flows)) {
    const before = lock.flows[route];
    if (!before) out.push(`${route}: new — not in the lock.\n`);
    else {
      const changes = diffSequences(before, tree);
      if (changes.length) out.push(renderSequenceDiff(route, changes));
    }
  }
  for (const route of Object.keys(lock.flows)) if (!(route in current.flows)) out.push(`${route}: gone — in the lock, no longer a route with a flow.\n`);
  return out;
}
