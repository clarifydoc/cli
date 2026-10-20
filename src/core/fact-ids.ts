import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Stable IDs for the facts an analysis holds, so a narrative written from it —
 * an architecture note, an agent's answer, a PR description — can cite them
 * (`[R-3fa2c1]`) and be checked against them later (`clarifydoc facts
 * --check`). An ID is a hash of the fact's line-free key: a route by method,
 * path and declaring file; an entity by name and file; a cross-tier link by
 * its calling file and the route it reaches. Lines are never part of a key,
 * so an edit elsewhere in a file keeps every ID in it.
 *
 *   R route · S screen · E entity · X entity relation · L call → route link · D function → data access
 */

export interface Fact {
  id: string;
  kind: "route" | "screen" | "entity" | "relation" | "link" | "access";
  /** The line-free key the ID hashes. */
  key: string;
  /** The fact, readably. */
  text: string;
  file?: string;
  line?: number;
}

const LETTER: Record<Fact["kind"], string> = { route: "R", screen: "S", entity: "E", relation: "X", link: "L", access: "D" };

/** FNV-1a, 24 bits as six hex digits: short enough to cite, wide enough for one project. */
export function factId(kind: Fact["kind"], key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `${LETTER[kind]}-${((h >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

export const FACT_ID_RE = /\b([RSEXLD])-([0-9a-f]{6})\b/g;

const routeLabel = (r: { httpMethod: string | null; path: string }) => `${r.httpMethod ? `${r.httpMethod.toUpperCase()} ` : ""}${r.path}`;

/** The route a link reaches, as a route's own fact key states it. */
const routeKey = (method: string | null | undefined, path: string, file: string) => `${(method ?? "").toUpperCase()} ${path} @ ${file}`;

export function routeFactId(r: { httpMethod: string | null; path: string; filePath?: string | null }): string {
  return factId("route", routeKey(r.httpMethod, r.path, r.filePath ?? ""));
}

/** Every fact of an analysis by ID. */
export function factsOf(summary: ProjectAnalysis): Map<string, Fact> {
  const out = new Map<string, Fact>();
  const add = (kind: Fact["kind"], key: string, text: string, file?: string, line?: number) => {
    const id = factId(kind, key);
    if (!out.has(id)) out.set(id, { id, kind, key, text, ...(file ? { file } : {}), ...(line ? { line } : {}) });
  };
  for (const r of summary.routeMap ?? []) add("route", routeKey(r.httpMethod, r.path, r.filePath ?? ""), `${r.kind} route ${routeLabel(r)}${r.handler ? ` → ${r.handler}` : ""}`, r.filePath ?? undefined, r.line);
  for (const s of summary.screens ?? []) add("screen", `${s.name} @ ${s.filePath}`, `screen ${s.name}${s.routePath ? ` at ${s.routePath}` : ""}`, s.filePath);
  const nodes = summary.entityGraph?.nodes ?? [];
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  for (const n of nodes) add("entity", `${n.name} @ ${n.filePath}`, `entity ${n.name}${n.orm ? ` (${n.orm})` : ""}`, n.filePath, n.line);
  for (const e of summary.entityGraph?.edges ?? []) {
    const a = nameOf.get(e.source) ?? e.source;
    const b = nameOf.get(e.target) ?? e.target;
    add("relation", `${a} ${e.sourceCardinality}-${e.targetCardinality} ${b}`, `${a} ${e.sourceCardinality}-to-${e.targetCardinality} ${b}`);
  }
  for (const l of summary.apiRouteLinks ?? []) {
    add("link", `${l.source} → ${routeKey(l.method, l.routePath, l.target)}`, `${l.source} calls ${(l.method ?? "").toUpperCase()} ${l.routePath} (${l.target})`.replace("calls  ", "calls "), l.source, l.sourceLine);
  }
  for (const d of summary.symbolDataAccess ?? []) add("access", `${d.file}::${d.symbol} → ${d.entity}`, `${d.symbol} ${d.access ?? "reaches"} ${d.entity}`, d.file, d.symbolLine);
  return out;
}

/** The IDs a text cites, each with the fact it names — or none, when the analysis holds no such fact. */
export function checkCitations(text: string, facts: ReadonlyMap<string, Fact>): Array<{ id: string; fact: Fact | null; line: number }> {
  const out: Array<{ id: string; fact: Fact | null; line: number }> = [];
  const seen = new Set<string>();
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(FACT_ID_RE)) {
      const id = `${m[1]}-${m[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, fact: facts.get(id) ?? null, line: i + 1 });
    }
  });
  return out;
}
