/**
 * "No callers" is a lower bound. What the call graph holds is the calls the linker resolved; a call it
 * could not place (an untyped receiver, a dynamic dispatch, a URL it could not read) is not in it. So a
 * symbol, file or route with no caller says what could hide one, with numbers:
 *
 *  1. calls elsewhere whose name equals the member's and that resolved to nothing,
 *  2. for a route, the files whose source holds its path as a literal that no call was linked from,
 *  3. an interface or base declaration above the symbol, or a DI registration that builds it — a caller
 *     may go through that.
 *
 * (1) and the DI registrations come from one pass over the per-file JSON, kept per loaded analysis.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileAnalysis, ProjectAnalysis, RouteInfo } from "../../types/analysis.js";
import type { LoadedAnalysis } from "../store.js";
import { loc, plural } from "../format.js";
import { byOrdinal } from "../../core/ordinal.js";
import { declarationsAbove, inheritanceIndex } from "../../core/overrides.js";
import { isTestPath, type ToolContext } from "./context.js";

interface Site { file: string; line: number }

interface NameStat {
  /** Unresolved call sites in non-test files / test files. */
  count: number;
  testCount: number;
  examples: Site[];
  testExamples: Site[];
}

interface NameIndex {
  /** Leaf of a call's name (lower-cased) → the call sites of it that resolved to nothing. */
  byName: Map<string, NameStat>;
  /** An implementation's class name (lower-cased) → the registrations that build it. */
  built: Map<string, Array<{ file: string; line: number; service: string }>>;
  files: number;
}

const EXAMPLES = 5;
const MAX_FILES = 6000;
const BATCH = 32;
const INDEXES = new WeakMap<ProjectAnalysis, Promise<NameIndex>>();

/** The last name of a call as written: `repo.find`, `Club::find`, `$club->find` → `find`. */
export function leafOf(name: string): string {
  const parts = name.replace(/\(.*$/s, "").split(/\.|::|->|#|:/).filter(Boolean);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

/** The member name of a traced symbol: `Club.rename` → `rename`. */
export function memberOf(symbol: string): string {
  const dot = symbol.lastIndexOf(".");
  return (dot >= 0 ? symbol.slice(dot + 1) : symbol).toLowerCase();
}

function nameIndexFor(ctx: ToolContext, loaded: LoadedAnalysis): Promise<NameIndex> {
  const { summary } = loaded;
  let index = INDEXES.get(summary);
  if (!index) {
    index = buildNameIndex(ctx, loaded);
    INDEXES.set(summary, index);
  }
  return index;
}

async function buildNameIndex(ctx: ToolContext, loaded: LoadedAnalysis): Promise<NameIndex> {
  const { summary } = loaded;
  const resolved = new Set<string>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.relation === "reference" || l.sourceSymbol === "(reference)") continue;
    resolved.add(`${l.sourceFile}\u0000${l.sourceLine}\u0000${l.callName}`);
  }
  const files = [...new Set([...Object.keys(summary.fileProjects ?? {}), ...loaded.index.byFile.keys()])].sort(byOrdinal).slice(0, MAX_FILES);
  const out: NameIndex = { byName: new Map(), built: new Map(), files: files.length };
  const note = (file: string, line: number, name: string) => {
    const leaf = leafOf(name);
    if (!leaf) return;
    let stat = out.byName.get(leaf);
    if (!stat) out.byName.set(leaf, (stat = { count: 0, testCount: 0, examples: [], testExamples: [] }));
    if (isTestPath(summary, file)) {
      stat.testCount++;
      if (stat.testExamples.length < EXAMPLES) stat.testExamples.push({ file, line });
    } else {
      stat.count++;
      if (stat.examples.length < EXAMPLES) stat.examples.push({ file, line });
    }
  };
  for (let i = 0; i < files.length; i += BATCH) {
    const analyses = await Promise.all(files.slice(i, i + BATCH).map((f) => ctx.store.fileAnalysis(f).catch(() => null)));
    analyses.forEach((a, k) => {
      if (!a) return;
      const file = files[i + k]!;
      const seen = new Set<string>();
      const read = (calls: FileAnalysis["functions"][number]["calls"] | undefined) => {
        for (const c of calls ?? []) {
          if (c.kind === "database" || c.kind === "api-call" || c.read) continue;
          const key = `${c.line}\u0000${c.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (resolved.has(`${file}\u0000${c.line}\u0000${c.name}`)) continue;
          note(file, c.line, c.name);
        }
      };
      for (const f of a.functions ?? []) read(f.calls);
      for (const c of a.classes ?? []) for (const m of c.methods ?? []) read(m.calls);
      for (const r of a.routes ?? []) read(r.calls);
      for (const b of a.diBindings ?? []) {
        const key = b.implementation.toLowerCase();
        const list = out.built.get(key) ?? out.built.set(key, []).get(key)!;
        list.push({ file, line: b.line, service: b.service });
      }
    });
  }
  return out;
}

/** Up to five `file:line` examples, code before tests. */
function examplesOf(stat: NameStat): string {
  const rows = [...stat.examples, ...stat.testExamples].slice(0, EXAMPLES);
  const total = stat.count + stat.testCount;
  return `${rows.map((s) => loc(s.file, s.line)).join(", ")}${total > rows.length ? ` … +${total - rows.length}` : ""}`;
}

function nameLine(stat: NameStat | undefined, shown: string): string | undefined {
  if (!stat || stat.count + stat.testCount === 0) return undefined;
  const tests = stat.testCount ? ` (${stat.testCount} in tests)` : "";
  return `${plural(stat.count + stat.testCount, "call")} named \`${shown}\` elsewhere did not resolve to any definition${tests} — an untyped receiver may be this one: ${examplesOf(stat)}`;
}

export interface CallerBound {
  /** Reasons a caller may exist that the graph does not hold; empty when nothing hides one. */
  reasons: string[];
  /** The numbers behind them, for tests and callers that branch. */
  unresolvedNamed: number;
}

/** What could hide a caller of one function or method (`Class.method`) defined in `file`. */
export async function symbolBound(ctx: ToolContext, loaded: LoadedAnalysis, file: string | undefined, symbol: string): Promise<CallerBound> {
  const index = await nameIndexFor(ctx, loaded);
  const member = memberOf(symbol);
  const stat = index.byName.get(member);
  const reasons: string[] = [];
  const named = nameLine(stat, symbol.slice(symbol.lastIndexOf(".") + 1));
  if (named) reasons.push(named);
  if (file) {
    const links = loaded.summary.symbolLinks ?? [];
    const above = await declarationsAbove(inheritanceIndex(loaded.summary.classGraph), links, file, symbol, (f) => ctx.store.fileAnalysis(f)).catch(() => []);
    if (above.length) {
      const first = above[0]!;
      reasons.push(`it ${first.abstract ? "implements" : "overrides"} \`${first.symbol}\` (${loc(first.file, first.line)})${above.length > 1 ? ` and ${above.length - 1} more declaration(s)` : ""} — a caller may reach it through that declaration, and a call on the base type lands there, not here`);
    }
    const owner = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : symbol;
    const regs = index.built.get(owner.toLowerCase());
    if (regs?.length) {
      reasons.push(`its class is built by ${plural(regs.length, "container registration")} (${regs.slice(0, 3).map((r) => `${r.service} at ${loc(r.file, r.line)}`).join(", ")}) — callers hold the service type, not this class`);
    }
  }
  return { reasons, unresolvedNamed: stat ? stat.count + stat.testCount : 0 };
}

/** What could hide an importer or caller of a file: unresolved calls named like what it exports. */
export async function fileBound(ctx: ToolContext, loaded: LoadedAnalysis, file: string): Promise<CallerBound> {
  const index = await nameIndexFor(ctx, loaded);
  const analysis = await ctx.store.fileAnalysis(file).catch(() => null);
  const names = [...new Set((analysis?.exports ?? []).filter((e) => e.kind === "function" || e.kind === "class").map((e) => e.name))].filter((n) => n && n !== "default");
  const rows: Array<{ name: string; stat: NameStat }> = [];
  let total = 0;
  for (const n of names) {
    const stat = index.byName.get(n.toLowerCase());
    if (!stat) continue;
    // Calls inside the file itself are not callers from outside.
    const own = [...stat.examples, ...stat.testExamples].filter((s) => s.file === file).length;
    const count = stat.count + stat.testCount - own;
    if (count <= 0) continue;
    total += count;
    rows.push({ name: n, stat });
  }
  const reasons: string[] = [];
  if (rows.length) {
    rows.sort((a, b) => b.stat.count + b.stat.testCount - (a.stat.count + a.stat.testCount) || byOrdinal(a.name, b.name));
    const top = rows[0]!;
    reasons.push(
      `${plural(total, "unresolved call")} elsewhere ${total === 1 ? "is" : "are"} named like ${rows.length === 1 ? "an export" : `${plural(rows.length, "export")}`} of this file (${rows.slice(0, 4).map((r) => r.name).join(", ")}${rows.length > 4 ? ", …" : ""}); e.g. \`${top.name}\`: ${examplesOf(top.stat)}`,
    );
  }
  return { reasons, unresolvedNamed: total };
}

/** The renderings of the verdict: never "safe to delete", whatever is found. */
export function boundLines(subject: string, bound: CallerBound): string[] {
  if (bound.reasons.length) {
    return [`No callers found for ${subject} — a lower bound, not a proof. What could hide one:`, ...bound.reasons.map((r) => `- ${r}`)];
  }
  return [`No callers found for ${subject} — a lower bound: no unresolved call is named like it and no interface, base or container registration stands above it, but reflection, framework callbacks and other repositories are outside the analysis.`];
}

// --- routes -------------------------------------------------------------------------------------------

const PARAM = /^(?::[\w$-]+|\{[^}]*\}|<[^>]*>|\[[^\]]*\]|\*+|\$\{[^}]*\}|\$[\w]+)$/;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VALUE = "[^/\\s\"'`?#]+";

/**
 * A regular expression for the literal a client writes for a route path: static segments as they are,
 * parameter segments any value (`:id`, `{id}`, `${id}`); a path ending in a parameter also matches
 * `"/clubs/" + id`. Null when no segment is static — `/` and `/:id` match everything.
 */
export function routeLiteralPattern(path: string): RegExp | null {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const segments = clean.split("/").filter((s) => s !== "");
  if (!segments.some((s) => !PARAM.test(s))) return null;
  const parts = segments.map((s) => (PARAM.test(s) ? VALUE : escape(s)));
  const end = "(?![\\w-]|/[\\w-])";
  let source = `(?<![\\w.-])/${parts.join("/")}${end}`;
  if (PARAM.test(segments[segments.length - 1]!) && segments.length > 1) {
    source += `|(?<![\\w.-])/${parts.slice(0, -1).join("/")}/(?=["'\`])`;
  }
  return new RegExp(`(?:${source})`);
}

export interface RouteRef { method?: string | null; path: string; file: string; line: number }

export interface RouteBound {
  /** Files (code first) holding the path as a literal; `lines` the first matching line of each. */
  files: Array<{ file: string; line: number; test: boolean }>;
  /** False when the path has no static segment to look for. */
  searchable: boolean;
  /** Files read; the scan stops at a budget. */
  scanned: number;
  capped: boolean;
}

/** What precedes a path literal that names a screen, not an HTTP endpoint. */
const NAVIGATION = /(?:\b(?:to|href|path|from|pathname)\s*[=:]\s*\{?\s*|\b(?:navigate|push|replace|redirect|Redirect|navigateTo|goto)\(\s*)["'`]$/;

const SCAN_FILES = 4000;
const SCAN_BYTES = 400_000;

/**
 * For routes with no linked caller, the files whose source holds each route's path literal and that no call
 * was linked from — a client the linker could not read. One pass over the analysed files for all `routes`.
 */
export async function routeLiterals(ctx: ToolContext, loaded: LoadedAnalysis, routes: RouteRef[]): Promise<Map<RouteRef, RouteBound>> {
  const { summary } = loaded;
  const out = new Map<RouteRef, RouteBound>();
  const wanted: Array<{ route: RouteRef; re: RegExp; skip: Set<string>; hits: RouteBound["files"] }> = [];
  for (const route of routes) {
    const re = routeLiteralPattern(route.path);
    const bound: RouteBound = { files: [], searchable: !!re, scanned: 0, capped: false };
    out.set(route, bound);
    if (!re) continue;
    // Files that declare the path (the route itself, a contract row, a gateway) or already link to it are no unlinked clients.
    const skip = new Set<string>([route.file]);
    for (const r of (summary.routeMap ?? [])) if (r.path === route.path) { if (r.filePath) skip.add(r.filePath); }
    for (const l of summary.apiRouteLinks ?? []) if (l.target === route.file && l.targetLine === route.line) skip.add(l.source);
    wanted.push({ route, re, skip, hits: bound.files });
  }
  if (!wanted.length) return out;
  const all = [...new Set([...Object.keys(summary.fileProjects ?? {}), ...loaded.index.byFile.keys()])].sort(byOrdinal);
  const files = all.slice(0, SCAN_FILES);
  let scanned = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const texts = await Promise.all(files.slice(i, i + BATCH).map(async (f) => {
      try {
        const text = await readFile(join(ctx.store.projectRoot, f), "utf-8");
        return text.length <= SCAN_BYTES ? text : null;
      } catch {
        return null;
      }
    }));
    texts.forEach((text, k) => {
      if (text === null) return;
      scanned++;
      const file = files[i + k]!;
      for (const w of wanted) {
        if (w.skip.has(file)) continue;
        // The first occurrence that is not a screen's own path (`to="/clubs"`, `navigate("/clubs")`, `path: "/clubs"`).
        const re = new RegExp(w.re.source, "g");
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (NAVIGATION.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
          w.hits.push({ file, line: text.slice(0, m.index).split("\n").length, test: isTestPath(summary, file) });
          break;
        }
      }
    });
  }
  for (const w of wanted) {
    const b = out.get(w.route)!;
    b.files.sort((x, y) => Number(x.test) - Number(y.test) || byOrdinal(x.file, y.file));
    b.scanned = scanned;
    b.capped = all.length > files.length;
  }
  return out;
}

/** One route's line: how many files hold its path unlinked, with up to five `file:line` examples. */
export function routeBoundLine(bound: RouteBound | undefined): string {
  if (!bound) return "";
  if (!bound.searchable) return "its path has no fixed segment to search for in source";
  const n = bound.files.length;
  const code = bound.files.filter((f) => !f.test).length;
  if (n === 0) return `no analysed file holds its path as a literal (${plural(bound.scanned, "file")} read${bound.capped ? ", more were not" : ""})`;
  const shown = bound.files.slice(0, EXAMPLES).map((f) => `${loc(f.file, f.line)}${f.test ? " (test)" : ""}`);
  return `${plural(n, "file")} (${code} not tests) hold its path as a literal with no call linked from it: ${shown.join(", ")}${n > shown.length ? ` … +${n - shown.length}` : ""}`;
}

/** A route as `RouteRef`. */
export function refOf(route: Pick<RouteInfo, "path" | "httpMethod" | "line"> & { filePath: string }): RouteRef {
  return { method: route.httpMethod, path: route.path, file: route.filePath, line: route.line };
}
