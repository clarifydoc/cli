/**
 * What kind of thing a file or function is — route handler, data access,
 * screen, entity, entry point, API client, shared utility, orchestrator —
 * said in one line at the head of `clarifydoc_explain`. A decision table over
 * facts the analysis extracted (routes, entry points, screens, the ER graph,
 * direct data access, outbound calls, the call graph's shape), never over the
 * words in a name: `UserRepository` is a repository only when it touches a
 * table. Each arm that holds contributes its evidence; the first is the role,
 * the others follow as "also". Nothing holds → no line, never a guess.
 */

import type { ApiCallWithFile, LoadedAnalysis } from "./store.js";
import type { ComplexityInfo, EntryPointInfo, ProjectAnalysis } from "../types/analysis.js";
import { isTestFile } from "../core/test-file-detector.js";
import { routeAnchor } from "../core/sequence.js";

export interface RoleArm {
  role: string;
  /** The facts behind it, as short phrases with a line where one exists. */
  evidence: string[];
}

const ENTRY_ROLE: Record<EntryPointInfo["kind"], string> = {
  "mcp-tool": "MCP tool",
  "editor-command": "editor command",
  "lm-tool": "language-model tool",
  "cli-command": "CLI command",
  "scheduled-job": "scheduled job",
  "message-consumer": "message consumer",
};

/** Whether a summary symbol ("Class.method" | "fn") is the subject named ("method", "Class.method"). */
function sameSymbol(candidate: string | null | undefined, subject: string): boolean {
  if (!candidate) return false;
  return candidate === subject || candidate.endsWith(`.${subject}`) || subject.endsWith(`.${candidate}`);
}

const shown = (xs: string[], n = 3): string => `${xs.slice(0, n).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

/**
 * Every role the facts support for `file` (the whole file) or `symbol` in it,
 * most specific first. Empty when none does.
 */
export function inferRoles(loaded: LoadedAnalysis, subject: { file: string; symbol?: string }): RoleArm[] {
  const { summary, index } = loaded;
  const { file, symbol } = subject;
  const f = index.byFile.get(file);
  const arms: RoleArm[] = [];
  const mine = (s: string | null | undefined) => !symbol || sameSymbol(s, symbol);

  if (isTestFile(file)) arms.push({ role: "test", evidence: ["its file is a test file"] });

  // A declared model, not a table the code merely queries (an `inferred` node is that).
  const entities = (summary.entityGraph?.nodes ?? []).filter((n) => n.filePath === file && n.kind === "entity" && n.orm !== "inferred" && mine(n.name));
  if (entities.length) arms.push({ role: "data model", evidence: entities.slice(0, 3).map((n) => `${n.orm ? `${n.orm} ` : ""}entity ${n.name}${n.table && n.table !== n.name ? ` (table ${n.table})` : ""}, line ${n.line}`) });

  const routes = (f?.routes ?? []).filter((r) => r.kind === "api" && (!symbol || sameSymbol(r.handler, symbol) || sameSymbol(routeAnchor(r, summary.symbolLinks ?? []), symbol)));
  if (routes.length) arms.push({ role: "route handler", evidence: [`handles ${shown(routes.map((r) => `${r.httpMethod ? `${r.httpMethod.toUpperCase()} ` : ""}${r.path}`))}`] });

  const entries = (summary.entryPoints ?? []).filter((e) => e.filePath === file && (!symbol || sameSymbol(e.handler, symbol)));
  for (const kind of [...new Set(entries.map((e) => e.kind))]) {
    const of = entries.filter((e) => e.kind === kind);
    arms.push({ role: ENTRY_ROLE[kind], evidence: [`registered as ${shown(of.map((e) => `"${e.name}"${e.schedule ? ` (${e.schedule})` : ""}`))}${of[0]!.framework ? ` via ${of[0]!.framework}` : ""}`] });
  }

  const screens = (f?.screens ?? []).filter((s) => !symbol || s.name === symbol);
  if (screens.length) arms.push({ role: "screen", evidence: screens.slice(0, 2).map((s) => `${s.name}${s.routePath ? ` at ${s.routePath}` : ""}`) });

  const access = (f?.dataAccess ?? []).filter((d) => mine(d.symbol));
  const db = access.filter((d) => !d.access);
  if (db.length) arms.push({ role: "data access", evidence: [`queries ${shown([...new Set(db.map((d) => d.entity))])} directly${symbol ? `, line ${db[0]!.sites[0]?.line ?? db[0]!.symbolLine}` : ""}`] });
  const published = access.filter((d) => d.access === "queue-publish");
  if (published.length) arms.push({ role: "message publisher", evidence: [`publishes ${shown([...new Set(published.map((d) => d.entity))])}`] });
  const consumed = access.filter((d) => d.access === "queue-consume");
  if (consumed.length && !arms.some((a) => a.role === "message consumer")) arms.push({ role: "message consumer", evidence: [`consumes ${shown([...new Set(consumed.map((d) => d.entity))])}`] });

  const span = symbol ? functionSpan(f?.complexity?.functions ?? [], symbol) : undefined;
  if (!symbol || span) {
    const calls = (f?.apiCalls ?? []).filter((c: ApiCallWithFile) => c.kind === "api-call" && (!span || (c.line >= span.line && c.line <= span.endLine)));
    if (calls.length) arms.push({ role: "API client", evidence: [`sends ${shown([...new Set(calls.map((c) => c.target ?? c.name))])}`] });
  }

  if (!arms.length) arms.push(...shapeRoles(summary, file, symbol));
  return arms;
}

/** The function named, by its complexity row (its span bounds what it sends). */
function functionSpan(fns: ComplexityInfo[], symbol: string): { line: number; endLine: number } | undefined {
  const hits = fns.filter((fn) => sameSymbol(fn.functionName, symbol));
  return hits.length === 1 ? { line: hits[0]!.line, endLine: hits[0]!.endLine } : undefined;
}

/**
 * Roles read off the call graph alone, only when no stated fact gave one:
 * called from many files and calling into none — a shared utility; calling
 * into more files than call it, and into several — an orchestrator.
 */
function shapeRoles(summary: ProjectAnalysis, file: string, symbol?: string): RoleArm[] {
  const links = summary.symbolLinks ?? [];
  const callers = new Set(links.filter((l) => l.targetFile === file && l.sourceFile !== file && (!symbol || sameSymbol(l.targetSymbol, symbol))).map((l) => l.sourceFile));
  const callees = new Set(links.filter((l) => l.sourceFile === file && l.targetFile !== file && (!symbol || sameSymbol(l.sourceSymbol, symbol))).map((l) => l.targetFile));
  if (callers.size >= 3 && callees.size === 0) return [{ role: "shared utility", evidence: [`called from ${callers.size} files, calls into no other`] }];
  if (callees.size >= 3 && callers.size < callees.size) return [{ role: "orchestrator", evidence: [`calls into ${callees.size} other files${callers.size ? `, called from ${callers.size}` : ""}`] }];
  return [];
}

/** "Role: route handler — handles GET /x · also data access — queries player directly", or null. */
export function roleLine(loaded: LoadedAnalysis, subject: { file: string; symbol?: string }): string | null {
  const arms = inferRoles(loaded, subject);
  if (!arms.length) return null;
  const [first, ...rest] = arms;
  return [
    `Role: ${first!.role} — ${first!.evidence.join("; ")}`,
    ...rest.slice(0, 3).map((a) => `also ${a.role} — ${a.evidence.join("; ")}`),
  ].join(" · ");
}
