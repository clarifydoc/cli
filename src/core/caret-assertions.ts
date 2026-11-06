import { manifestFor } from "../extractors/registry.js";
import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, ProjectAnalysis } from "../types/analysis.js";

/**
 * Assertions beside the source. A comment line under a source line, in the
 * language's own comment syntax, whose `^^^` marks a span of the line above and
 * names the fact expected there:
 *
 *     const clubs = await repo.listClubs();
 *     //                  ^^^^^^^^^ call -> src/repo.ts::listClubs
 *
 * Grammar (one assertion per comment line; consecutive caret lines all speak
 * about the nearest source line above them; `<-` in place of the carets points
 * at the comment's own column and checks no span):
 *
 *     def <name>                       a function, method (`Club.save`) or class defined on the line
 *     call [-> <file>::<symbol>]       a call the span names; with a target, the symbol link it resolved to
 *     route [<METHOD>] <path>          a route registered on the line
 *     api-call [<METHOD>] <url> [-> <METHOD> <routePath>]
 *                                      a request the line makes; with `->`, the route it joined
 *     table <name> [read|write]        a database access on the line, by entity/table name
 *
 * The comment prefix is the language's plain line-comment prefix from its
 * manifest (`docComments.line`, the last, least specific entry) — core names no
 * language. `renderCarets` prints the same labels for every fact of a file, so a
 * snapshot is also valid input for `checkCaretAssertions`.
 *
 * Pure: sources and per-file analyses come from the caller.
 */
export type CaretKind = "def" | "call" | "route" | "api-call" | "table";

export const CARET_KINDS: readonly CaretKind[] = ["def", "call", "route", "api-call", "table"];

export interface CaretAssertion {
  file: string;
  /** The source line (1-based) the assertion speaks about. 0 when no source line precedes it. */
  line: number;
  /** The line (1-based) the assertion is written on. */
  commentLine: number;
  /** 0-based span of the source line; `endCol` exclusive. Equal for the `<-` form. */
  startCol: number;
  endCol: number;
  marker: "span" | "arrow";
  kind: string;
  /** Everything after the kind, trimmed. */
  text: string;
  raw: string;
}

export type CaretStatus = "passed" | "failed" | "unmatched";

export interface CaretResult {
  assertion: CaretAssertion;
  status: CaretStatus;
  /** Why it failed or could not be judged. */
  message?: string;
  /** On a failure: the facts of that kind found on the line (or in the span) instead. */
  found?: string[];
}

export interface CaretFile {
  source: string;
  analysis: FileAnalysis;
}

/** A fact at a source line, in the label form assertions are written in. */
export interface CaretFact {
  line: number;
  kind: CaretKind;
  /** The label after the kind — what an assertion's text is compared with. */
  label: string;
  /** The text the span must contain to be about this fact (a callee's leaf, a definition's name). */
  anchor?: string;
  /** 0-based column when the extractor stated one. */
  column?: number;
  /** Facts that are matched by structured fields rather than the label. */
  detail?: { target?: string; method?: string; path?: string; routeLabel?: string; entity?: string; access?: string; name?: string };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The plain line-comment prefix of a language, from its manifest. */
export function commentPrefixFor(language: string): string | undefined {
  const line = manifestFor(language as never)?.docComments?.line;
  return line && line.length > 0 ? line[line.length - 1] : undefined;
}

const leafOf = (symbol: string): string => symbol.split(/::|\.|#|\\|->/).pop() || symbol;

/** Reads the assertions of one file. Lines whose comment is not an assertion stay source lines. */
export function parseCaretAssertions(file: string, source: string, prefix: string): CaretAssertion[] {
  const re = new RegExp(`^(\\s*)${escapeRe(prefix)}(\\s*)(\\^+|<-)(?:\\s+(\\S+)\\s*(.*?))?\\s*$`);
  const out: CaretAssertion[] = [];
  let sourceLine = 0;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const m = re.exec(raw);
    // A marker with no kind after it is prose, not an assertion.
    if (!m || m[4] === undefined) {
      sourceLine = i + 1;
      continue;
    }
    const start = m[1]!.length + prefix.length + m[2]!.length;
    const arrow = m[3] === "<-";
    out.push({
      file,
      line: sourceLine,
      commentLine: i + 1,
      startCol: arrow ? m[1]!.length : start,
      endCol: arrow ? m[1]!.length : start + m[3]!.length,
      marker: arrow ? "arrow" : "span",
      kind: m[4]!,
      text: (m[5] ?? "").trim(),
      raw,
    });
  }
  return out;
}

const methodOf = (ds: DataSourceInfo): string | undefined => {
  if (ds.httpMethod) return ds.httpMethod.toUpperCase();
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i.exec(ds.name);
  if (m) return m[1]!.toUpperCase();
  const leaf = ds.name.split(/[.:]/).pop()?.toUpperCase();
  return leaf && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(leaf) ? leaf : undefined;
};

/** The URL path of an api-call row: its target, else the name after a verb. */
const urlOf = (ds: DataSourceInfo): string => (ds.target ?? ds.name.replace(/^[A-Za-z]+\s+(?=\/)/, "")).trim();

/** Every fact a file states that an assertion can name, with the project's resolved links joined on. */
export function factsOfFile(analysis: ProjectAnalysis, path: string, fa: FileAnalysis): CaretFact[] {
  const facts: CaretFact[] = [];
  const links = (analysis.symbolLinks ?? []).filter((l) => l.sourceFile === path);
  const apiLinks = (analysis.apiRouteLinks ?? []).filter((l) => l.source === path);

  const addFn = (f: FunctionInfo, owner?: ClassInfo) => {
    if (!f.name.startsWith("<")) {
      const name = owner ? `${owner.name}.${f.name}` : f.name;
      facts.push({ line: f.line, kind: "def", label: name, anchor: f.name, detail: { name } });
    }
    for (const c of f.calls ?? []) addCall(c);
  };
  const addCall = (c: FunctionInfo["calls"][number]) => {
    const leaf = leafOf(c.name);
    const link = links.find((l) => l.sourceLine === c.line && (l.callName === c.name || leafOf(l.callName) === leaf));
    const target = link ? `${link.targetFile}::${link.targetSymbol}` : undefined;
    facts.push({ line: c.line, kind: "call", label: target ? `-> ${target}` : "", anchor: leaf, column: c.column, detail: { target } });
  };

  for (const f of fa.functions ?? []) addFn(f);
  for (const c of fa.classes ?? []) {
    facts.push({ line: c.line, kind: "def", label: c.name, anchor: c.name, detail: { name: c.name } });
    for (const m of c.methods ?? []) addFn(m, c);
  }
  for (const r of fa.routes ?? []) {
    const method = r.httpMethod ? r.httpMethod.toUpperCase() : undefined;
    facts.push({ line: r.line, kind: "route", label: `${method ? `${method} ` : ""}${r.path}`, anchor: r.path, detail: { method, path: r.path } });
    for (const c of r.calls ?? []) addCall(c);
  }
  for (const ds of fa.dataSources ?? []) {
    if (ds.kind === "api-call") {
      const method = methodOf(ds);
      const url = urlOf(ds);
      const link = apiLinks.find((l) => l.sourceLine === ds.line && (l.url === url || !url));
      const routeLabel = link ? `${link.method ? `${link.method.toUpperCase()} ` : ""}${link.routePath}` : undefined;
      facts.push({
        line: ds.line,
        kind: "api-call",
        label: `${method ? `${method} ` : ""}${url}${routeLabel ? ` -> ${routeLabel}` : ""}`,
        anchor: url,
        detail: { method, path: url, routeLabel },
      });
    } else if (ds.kind === "database" && ds.entity) {
      facts.push({ line: ds.line, kind: "table", label: `${ds.entity}${ds.access ? ` ${ds.access}` : ""}`, anchor: ds.entity, detail: { entity: ds.entity, access: ds.access } });
    }
  }
  return facts;
}

const sameText = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** `[METHOD] rest` → its verb and the rest. */
function splitMethod(text: string): { method?: string; rest: string } {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(.*)$/i.exec(text.trim());
  return m ? { method: m[1]!.toUpperCase(), rest: m[2]!.trim() } : { rest: text.trim() };
}

function judge(a: CaretAssertion, facts: CaretFact[], sourceLine: string): CaretResult {
  const here = facts.filter((f) => f.line === a.line && f.kind === a.kind);
  const spanText = a.marker === "span" ? sourceLine.slice(a.startCol, a.endCol) : sourceLine;
  const fail = (message: string, found: CaretFact[] = here): CaretResult => ({
    assertion: a,
    status: "failed",
    message,
    found: found.map((f) => describeFact(f)),
  });
  const ok: CaretResult = { assertion: a, status: "passed" };
  const inSpan = (f: CaretFact) => a.marker === "arrow" || f.anchor === undefined || spanText.includes(f.anchor);
  const noFact = `no ${a.kind} fact on line ${a.line}`;

  switch (a.kind as CaretKind) {
    case "def": {
      if (a.text === "") return { assertion: a, status: "unmatched", message: "`def` needs a name" };
      const cand = here.filter((f) => (a.text.includes(".") ? f.detail?.name === a.text : f.anchor === a.text || f.detail?.name === a.text));
      if (cand.length === 0) return fail(here.length ? `line ${a.line} defines other names` : noFact);
      return cand.some(inSpan) ? ok : fail(`the span "${spanText}" does not name "${leafOf(a.text)}"`, cand);
    }
    case "call": {
      const cand = here.filter(inSpan);
      if (cand.length === 0) return fail(here.length ? `no call on line ${a.line} is named by the span "${spanText}"` : noFact);
      if (a.text === "") return ok;
      const want = a.text.replace(/^->\s*/, "");
      return cand.some((f) => f.detail?.target === want) ? ok : fail(`no call in the span resolves to ${want}`, cand);
    }
    case "route": {
      const want = splitMethod(a.text);
      const cand = here.filter((f) => f.detail?.path === want.rest && (!want.method || sameText(f.detail?.method, want.method)));
      return cand.length ? ok : fail(here.length ? `line ${a.line} registers other routes` : noFact);
    }
    case "api-call": {
      const [left, right] = a.text.split(/\s*->\s*/, 2) as [string, string | undefined];
      const want = splitMethod(left);
      const cand = here.filter((f) => f.detail?.path === want.rest && (!want.method || sameText(f.detail?.method, want.method)));
      if (cand.length === 0) return fail(here.length ? `line ${a.line} makes other requests` : noFact);
      if (right === undefined) return ok;
      return cand.some((f) => sameText(f.detail?.routeLabel, right.trim())) ? ok : fail(`the request joins no route ${right.trim()}`, cand);
    }
    case "table": {
      const m = /^(\S+)(?:\s+(read|write))?$/.exec(a.text);
      if (!m) return { assertion: a, status: "unmatched", message: "`table` reads `<name> [read|write]`" };
      const cand = here.filter((f) => sameText(f.detail?.entity, m[1]) && (!m[2] || f.detail?.access === m[2]));
      return cand.length ? ok : fail(here.length ? `line ${a.line} touches other tables` : noFact);
    }
  }
}

const describeFact = (f: CaretFact): string => (f.kind === "def" ? `def ${f.detail?.name}` : f.label ? `${f.kind} ${f.label}` : f.kind);

/**
 * Judges every caret assertion in `files`: `passed`, `failed` (the fact is absent
 * on that line, or the span does not name it — `found` lists what is there
 * instead) or `unmatched` (it cannot be judged: no source line above, an unknown
 * kind, a language with no comment syntax).
 */
export function checkCaretAssertions(analysis: ProjectAnalysis, files: ReadonlyMap<string, CaretFile>): CaretResult[] {
  const results: CaretResult[] = [];
  for (const [path, file] of [...files].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const prefix = commentPrefixFor(file.analysis.language);
    if (!prefix) continue; // no comment syntax: nothing in this file can be an assertion
    const assertions = parseCaretAssertions(path, file.source, prefix);
    if (assertions.length === 0) continue;
    const lines = file.source.split(/\r?\n/);
    const facts = factsOfFile(analysis, path, file.analysis);
    for (const a of assertions) {
      if (a.line === 0) results.push({ assertion: a, status: "unmatched", message: "no source line above the assertion" });
      else if (!CARET_KINDS.includes(a.kind as CaretKind)) results.push({ assertion: a, status: "unmatched", message: `unknown assertion kind \`${a.kind}\`` });
      else results.push(judge(a, facts, lines[a.line - 1] ?? ""));
    }
  }
  return results;
}

/** One line per result that is not `passed`, for a test failure or the CLI. */
export function formatCaretFailures(results: readonly CaretResult[]): string[] {
  return results
    .filter((r) => r.status !== "passed")
    .map((r) => {
      const a = r.assertion;
      const found = r.found && r.found.length ? `; found: ${r.found.join(" | ")}` : "";
      return `${r.status}  ${a.file}:${a.commentLine}  ${a.kind} ${a.text}`.trimEnd() + `  (${r.message ?? ""}${found})`;
    });
}

/**
 * The snapshot form: the source with a caret line under every line that states
 * a fact, one per fact, aligned to the callee / path / name where the line shows
 * it. Output of this function, put back in the file, passes
 * `checkCaretAssertions`. Returns undefined for a language with no comment syntax.
 */
export function renderCarets(analysis: ProjectAnalysis, path: string, file: CaretFile): string | undefined {
  const prefix = commentPrefixFor(file.analysis.language);
  if (!prefix) return undefined;
  const existing = new Set(parseCaretAssertions(path, file.source, prefix).map((a) => a.commentLine));
  const lines = file.source.split(/\r?\n/);
  const facts = factsOfFile(analysis, path, file.analysis);
  const byLine = new Map<number, CaretFact[]>();
  for (const f of facts) (byLine.get(f.line) ?? byLine.set(f.line, []).get(f.line)!).push(f);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    if (existing.has(i + 1)) continue; // a caret line written by hand is not a source line
    const here = (byLine.get(i + 1) ?? []).slice().sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.label < y.label ? -1 : 1));
    const seen = new Set<string>();
    const used = new Map<string, number>();
    for (const f of here) {
      const text = f.kind === "call" || f.kind === "def" ? `${f.kind}${f.kind === "def" ? ` ${f.detail?.name}` : f.label ? ` ${f.label}` : ""}` : `${f.kind} ${f.label}`;
      if (seen.has(text)) continue;
      seen.add(text);
      const anchor = f.anchor ?? "";
      const from = used.get(anchor) ?? 0;
      let col = anchor ? lines[i]!.indexOf(anchor, from) : -1;
      if (col >= 0) used.set(anchor, col + anchor.length);
      else col = (/^\s*/.exec(lines[i]!)?.[0].length ?? 0);
      const width = Math.max(anchor.length || 1, 1);
      if (col >= prefix.length + 1) out.push(`${prefix}${" ".repeat(col - prefix.length)}${"^".repeat(width)} ${text}`);
      else out.push(`${prefix} <- ${text}`);
    }
  }
  return out.join("\n");
}
