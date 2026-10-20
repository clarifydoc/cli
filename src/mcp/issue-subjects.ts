import type { ProjectAnalysis } from "../types/analysis.js";
import { findRoutes } from "../core/sequence.js";

/**
 * What an issue (a bug report, a ticket, a stack trace pasted into one) is
 * about, in terms the analysis knows: the routes, files and functions it
 * names. Strongest evidence first — a stack frame names the code that ran; a
 * route or a path is stated outright; a code span or an identifier only
 * mentions something — and only names that match the analysis count, so the
 * subjects are real ones, never guesses at what the reporter meant.
 */
export interface IssueSubject {
  kind: "route" | "file" | "symbol";
  subject: string;
  /** The file, for a symbol a stack frame placed. */
  file?: string;
  /** Why: what in the issue named it. */
  why: string;
}

const RANK: Record<string, number> = { stack: 0, route: 1, path: 2, code: 3, word: 4 };

export function issueSubjects(issue: string, summary: ProjectAnalysis, limit = 5): IssueSubject[] {
  let text = issue;
  const files = summary.files ?? [];
  const symbols = new Map<string, Set<string>>();
  const know = (symbol: string, file: string) => (symbols.get(symbol) ?? symbols.set(symbol, new Set()).get(symbol)!).add(file);
  for (const l of summary.symbolLinks ?? []) {
    if (l.targetSymbol.startsWith("route:") || l.targetSymbol.startsWith("(")) continue;
    know(l.targetSymbol, l.targetFile);
  }
  // Every analysed function, called or not (a route handler is often no call's target).
  for (const c of summary.complexity ?? []) for (const fn of c.functions ?? []) if (fn.functionName && !fn.functionName.startsWith("<")) know(fn.functionName, c.filePath);
  const short = new Map<string, string[]>();
  for (const s of symbols.keys()) {
    const leaf = s.split(".").pop()!;
    (short.get(leaf) ?? short.set(leaf, []).get(leaf)!).push(s);
  }
  /** A path the issue writes, as the analysis names it: exact, or the one file it is the end of. */
  const fileOf = (p: string): string | null => {
    const clean = p.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");
    if (files.includes(clean)) return clean;
    const ends = files.filter((f) => f.endsWith(`/${clean}`) || clean.endsWith(`/${f}`));
    return ends.length === 1 ? ends[0]! : null;
  };
  /** A symbol by its full name, or by a leaf only one symbol has. */
  const symbolOf = (name: string): string | null => {
    if (symbols.has(name)) return name;
    const leaf = short.get(name.split(".").pop()!) ?? [];
    return leaf.length === 1 ? leaf[0]! : null;
  };

  /** A symbol a stack frame names, in the file the frame names: the name there, or its leaf. */
  const symbolIn = (name: string, file: string | null): string | null => {
    if (!file) return null;
    if (symbols.get(name)?.has(file)) return name;
    const leaf = (short.get(name.split(".").pop()!) ?? []).filter((x) => symbols.get(x)!.has(file));
    return leaf.length === 1 ? leaf[0]! : null;
  };

  const found = new Map<string, IssueSubject & { rank: number; count: number; order: number }>();
  const add = (s: IssueSubject, how: keyof typeof RANK) => {
    const key = `${s.kind}:${s.subject}:${s.file ?? ""}`;
    const prev = found.get(key);
    if (prev) {
      prev.count++;
      if (RANK[how]! < prev.rank) Object.assign(prev, { rank: RANK[how]!, why: s.why });
    } else found.set(key, { ...s, rank: RANK[how]!, count: 1, order: found.size });
  };

  // Stack frames: `at OrderService.create (src/orders/service.ts:42:7)`, `File "app/x.py", line 10, in handler`.
  for (const m of text.matchAll(/\bat\s+(?:async\s+)?([\w$.<>]+)\s+\(([^()\s]+?):(\d+)(?::\d+)?\)/g)) {
    const file = fileOf(m[2]!);
    const symbol = symbolIn(m[1]!.replace(/^Object\.|^<anonymous>$/, ""), file);
    if (file && symbol) add({ kind: "symbol", subject: symbol, file, why: `a stack frame: ${m[0].trim()}` }, "stack");
    else if (file) add({ kind: "file", subject: file, why: `a stack frame: ${m[0].trim()}` }, "stack");
  }
  for (const m of text.matchAll(/File "([^"]+)", line (\d+), in (\w+)/g)) {
    const file = fileOf(m[1]!);
    const symbol = symbolIn(m[3]!, file);
    if (file && symbol) add({ kind: "symbol", subject: symbol, file, why: `a stack frame: ${m[0]}` }, "stack");
    else if (file) add({ kind: "file", subject: file, why: `a stack frame: ${m[0]}` }, "stack");
  }
  // The frames are read; the rest of the text is what the reporter wrote around them.
  text = text.replace(/\bat\s+(?:async\s+)?[\w$.<>]+\s+\([^()\s]+?:\d+(?::\d+)?\)|File "[^"]+", line \d+, in \w+/g, " ");
  // Routes: `POST /api/orders`, or a path alone the route map has.
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/{}:.\-]*)/g)) {
    const hit = findRoutes(summary.routeMap ?? [], `${m[1]} ${m[2]}`);
    if (hit.length === 1) add({ kind: "route", subject: `${hit[0]!.httpMethod?.toUpperCase() ?? m[1]} ${hit[0]!.path}`, why: `names the route: ${m[0]}` }, "route");
  }
  // A concrete path (`/api/users/42`) matches the route patterns it fits (`/api/users/:id`).
  const api = (summary.routeMap ?? []).filter((r) => r.kind === "api");
  const pattern = (path: string) => new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}/]+\\?\}|:[\w]+/g, "[^/]+").replace(/\/+$/, "")}/?$`);
  for (const m of text.matchAll(/(?<![\w/])(\/(?:api|v\d)\/[\w/{}:.\-]+)/g)) {
    const path = m[1]!.replace(/[.,;:]+$/, "");
    const hit = api.filter((r) => r.path === path || pattern(r.path).test(path));
    const paths = [...new Set(hit.map((r) => r.path))];
    if (hit.length === 1) add({ kind: "route", subject: `${hit[0]!.httpMethod ? `${hit[0]!.httpMethod.toUpperCase()} ` : ""}${hit[0]!.path}`, why: `names the path ${path}` }, "route");
    else if (paths.length === 1) add({ kind: "route", subject: paths[0]!, why: `names the path ${path}` }, "route");
  }
  // Paths: `src/orders/service.ts`, `OrderService.cs`.
  for (const m of text.matchAll(/(?<![\w/.])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,6})(?::\d+)?\b/g)) {
    const file = fileOf(m[1]!);
    if (file) add({ kind: "file", subject: file, why: `names the file ${m[1]}` }, "path");
  }
  // Code spans, then identifiers that read as code (camelCase, PascalCase, snake_case, a.b).
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const name = m[1]!.replace(/\(\)$/, "").trim();
    const symbol = /^[\w$.]+$/.test(name) ? symbolOf(name) : null;
    if (symbol) add({ kind: "symbol", subject: symbol, why: `mentions \`${m[1]}\`` }, "code");
  }
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/g)) {
    const w = m[1]!;
    if (!/[a-z][A-Z]|_|\./.test(w) && !/^[A-Z][a-z]+[A-Z]/.test(w)) continue;
    const symbol = symbolOf(w);
    if (symbol) add({ kind: "symbol", subject: symbol, why: `mentions ${w}` }, "word");
  }

  return [...found.values()]
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.order - b.order)
    .slice(0, limit)
    .map(({ rank: _r, count: _c, order: _o, ...s }) => s);
}
