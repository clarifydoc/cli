import type { CallArgOrigin, ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";
import { goFunctions } from "./path-arg-calls.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a Go call's arguments come from (`CallInfo.argOrigins`) and which
 * fields an ORM statement filters on with them (`DataSourceInfo.whereFields`),
 * for the project pass that follows a route parameter to the column it
 * selects (`paramColumns`):
 *
 *   func GetLabel(ctx *context.APIContext) {
 *       labelID := ctx.PathParamInt64("id")                      ← a route parameter, by name
 *       issues_model.GetLabelInRepoByID(ctx, repoID, labelID)   ← argument 2 is that value
 *   }
 *   func GetLabelInRepoByID(ctx context.Context, repoID, labelID int64) (*Label, error) {
 *       db.Get[Label](ctx, builder.Eq{"id": labelID, "repo_id": repoID})   ← filters id on parameter 2
 *   }
 *
 * A value is a parameter of the enclosing function, a request read
 * (`c.Param("id")`, `ctx.PathParam("id")`, `chi.URLParam(r, "id")`,
 * `mux.Vars(r)["id"]`, `c.Query("q")`, `r.URL.Query().Get("q")`), a string
 * literal, or a local the function assigns once from one of those — through
 * one conversion (`strconv.ParseInt(x, 10, 64)`, `strconv.Atoi(x)`).
 */

const ROUTE_READS: RegExp[] = [
  /^\w+\.(?:Param|PathParam|PathParamInt64|PathParamInt|PathValue|Params)\(\s*"(:?[\w-]+)"\s*\)$/,
  /^\w+\.Params\.ByName\(\s*"([\w-]+)"\s*\)$/,
  /^chi\.URLParam\(\s*\w+\s*,\s*"([\w-]+)"\s*\)$/,
  /^mux\.Vars\(\s*\w+\s*\)\[\s*"([\w-]+)"\s*\]$/,
];
const QUERY_READS: RegExp[] = [
  /^\w+\.(?:Query|DefaultQuery|QueryParam|FormValue|FormString|FormInt64|FormInt|FormTrim|FormBool)\(\s*"([\w-]+)"\s*(?:,[^)]*)?\)$/,
  /^\w+\.URL\.Query\(\)\.Get\(\s*"([\w-]+)"\s*\)$/,
];
/** One conversion a value passes through, its argument first. */
const CONVERSION = /^(strconv\.(?:ParseInt|ParseUint|Atoi|ParseBool|ParseFloat)|uuid\.(?:Parse|MustParse)|int64|int|string)\(\s*/;
const STRING_LIT = /^"((?:[^"\\]|\\.)*)"$|^`([^`]*)`$/;
const IDENT = /^[A-Za-z_]\w*$/;

interface Scope {
  params: string[];
  /** 0-based, inclusive. */
  start: number;
  end: number;
  body: string;
  /** `body` with string contents blanked, offsets unchanged. */
  code: string;
}

/** The index of the bracket closing the one at `open` (strings skipped), or -1. */
function closeAt(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/** Text split at its top-level commas, quotes and brackets honoured. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const stripComment = (line: string): string => line.replace(/\/\/.*$/, "");

/** `strconv.ParseInt(x, 10, 64)` → x and the conversion; anything else as it is. */
function unwrap(expr: string): { expr: string; transform?: string } {
  const m = CONVERSION.exec(expr);
  if (!m) return { expr };
  const openAt = expr.indexOf("(", m[1]!.length);
  const close = closeAt(expr, openAt);
  if (close !== expr.length - 1) return { expr };
  const args = splitTopLevel(expr.slice(openAt + 1, close));
  return args[0] ? { expr: args[0], transform: m[1]! } : { expr };
}

/** The values `name` is assigned in the body (`x := v`, `x, err := v`, `x = v`, `var x = v`, an `if x, err := v;` header). */
function assignmentsOf(scope: Scope, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`(?:^|[;{(\s])(?:var\s+)?${name}\s*(?:,\s*[\w_]+\s*)*(?::=|=(?!=))\s*([^\n;]+)`, "g");
  for (const m of scope.code.matchAll(re)) {
    const start = m.index! + m[0].length - m[1]!.length;
    out.push(scope.body.slice(start, start + m[1]!.length).trim().replace(/\s*\{\s*$/, ""));
  }
  // `_, x := v` / `a, x = v`: assigned, value unknown here.
  const later = new RegExp(String.raw`[\w_]+\s*,\s*${name}\s*(?::=|=(?!=))`, "g");
  for (const _ of scope.code.matchAll(later)) out.push("");
  return out;
}

/** The origin of one value written in `scope`; null when unknown. */
export function goValueOrigin(raw: string, scope: Scope, depth = 0): { origin: Origin; transform?: string } | null {
  const { expr, transform } = unwrap(raw.trim().replace(/^&/, ""));
  const lit = STRING_LIT.exec(expr);
  if (lit) return { origin: { kind: "literal", value: lit[1] ?? lit[2] ?? "" } };
  for (const re of ROUTE_READS) {
    const m = re.exec(expr);
    if (m) return { origin: { kind: "route-param", name: m[1]!.replace(/^:/, "") }, ...(transform ? { transform } : {}) };
  }
  for (const re of QUERY_READS) {
    const m = re.exec(expr);
    if (m) return { origin: { kind: "query-param", name: m[1]! }, ...(transform ? { transform } : {}) };
  }
  if (!IDENT.test(expr)) return null;
  const assigned = assignmentsOf(scope, expr);
  const index = scope.params.indexOf(expr);
  if (index >= 0) return assigned.length === 0 ? { origin: { kind: "param", name: expr, index }, ...(transform ? { transform } : {}) } : null;
  // A local assigned once from a parameter, a request read or another such local.
  if (depth >= 2 || assigned.length !== 1 || !assigned[0]) return null;
  const inner = goValueOrigin(assigned[0], scope, depth + 1);
  if (!inner || inner.origin.kind === "literal") return null;
  const t = inner.transform ?? transform;
  return { origin: inner.origin, ...(t ? { transform: t } : {}) };
}

function scopesOf(lines: readonly string[]): Scope[] {
  // The code with string contents blanked to the same length: `"season = ?"` assigns nothing.
  const blank = (text: string) => text.replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, " ") + m[0]);
  return goFunctions(lines).map((f) => {
    const body = lines.slice(f.start + 1, f.end + 1).map(stripComment).join("\n");
    return { params: f.params, start: f.start, end: f.end, body, code: blank(body) };
  });
}

const scopeAt = (scopes: readonly Scope[], line0: number): Scope | undefined => scopes.find((s) => line0 >= s.start && line0 <= s.end);

/** The argument text of the call named `name` on line `line0` (over following lines), or null. */
function callArgsAt(lines: readonly string[], line0: number, name: string, end: number): string[] | null {
  const text = lines.slice(line0, Math.min(end + 1, line0 + 30)).map(stripComment).join("\n");
  const leaf = name.replace(/\(\)/g, "").split(".").pop()!;
  const re = new RegExp(String.raw`\b${leaf.replace(/[$]/g, "\\$")}\s*(?:\[[^\]\n]*\]\s*)?\(`, "g");
  const first = text.indexOf("\n");
  for (const m of text.matchAll(re)) {
    if (first >= 0 && m.index! > first) break;
    const open = m.index! + m[0].length - 1;
    const close = closeAt(text, open);
    if (close < 0) return null;
    return splitTopLevel(text.slice(open + 1, close));
  }
  return null;
}

/** Parameter types that carry machinery rather than a value: `context.Context`, `*gin.Context`, `http.ResponseWriter`, `*xorm.Session`, `*gorm.DB`. */
const PLUMBING = /Context$|ResponseWriter$|Session$|Engine$|(?:^|\.)(?:DB|Tx)$|^\*?http\.Request$|^\*?testing\.|Logger$/;

/**
 * A parameter whose value a statement can compare a column with: untyped, a builtin, a slice of
 * them, or a named type of the package (`TokenKind`) — never machinery (`PLUMBING`) or another
 * package's struct (`models.Club`), which the walk could only follow field by field.
 */
function scalarParam(type: string | null | undefined): boolean {
  if (!type) return true;
  if (PLUMBING.test(type)) return false;
  const bare = type.replace(/^(?:\[\]|\*|\.\.\.)+/, "");
  return !/^[a-z_]\w*\.[A-Z]/.test(bare) || /^(?:uuid\.UUID|time\.Time|sql\.Null\w+)$/.test(bare);
}

function addArgOrigins(lines: readonly string[], fn: FunctionInfo, scopes: readonly Scope[]): void {
  const scope = scopes.find((s) => s.start === fn.line - 1) ?? scopeAt(scopes, fn.line - 1);
  if (!scope) return;
  for (const call of fn.calls) {
    const args = callArgsAt(lines, call.line - 1, call.name, scope.end);
    if (!args || args.length === 0 || args.length > 12) continue;
    const out: CallArgOrigin[] = [];
    args.forEach((a, index) => {
      if (a.endsWith("...")) return;
      const o = goValueOrigin(a, scope);
      // Only what a statement can compare a column with: no literal (a server's literal names no
      // request value), no request context or writer, no struct handed on whole.
      if (!o || o.origin.kind === "literal") return;
      if (o.origin.kind === "param" && !scalarParam(fn.params[o.origin.index]?.type)) return;
      out.push({ index, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
    });
    if (out.length > 0) call.argOrigins = out;
  }
}

/** Arg origins on the calls of a file's functions. */
export function withGoArgOrigins(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  if (!/\(/.test(lines.join("\n"))) return fns;
  const scopes = scopesOf(lines);
  for (const fn of fns) if (fn.name !== "<setup>") addArgOrigins(lines, fn, scopes);
  return fns;
}

/** As `withGoArgOrigins`, for the methods attached to their structs. */
export function withGoArgOriginsInClasses(lines: string[], classes: ClassInfo[]): ClassInfo[] {
  const scopes = scopesOf(lines);
  for (const cls of classes) for (const m of cls.methods) addArgOrigins(lines, m, scopes);
  return classes;
}

// ─── Filter fields of ORM statements ─────────────────────────────────────

/** `repo_id = ?`, `"user".id=?`, `name LIKE ?`, `id IN (?)` — a compared column before each placeholder. */
const CONDITION = /([`"]?[A-Za-z_][\w`".]*)\s*(?:=|==|<>|!=|>=|<=|>|<|\bLIKE\b|\bILIKE\b|\bIN\b)\s*\(?\s*\?/gi;

/** The statement a database row sits in: lines joined from the chain's first line to the terminal call's end. */
function statementAt(lines: readonly string[], line0: number, scope: Scope): string {
  let from = line0;
  while (from > scope.start + 1 && stripComment(lines[from - 1]!).trimEnd().endsWith(".")) from--;
  let to = line0;
  let text = stripComment(lines[from]!);
  for (let k = from + 1; k <= line0; k++) text += "\n" + stripComment(lines[k]!);
  // Close what the row's line leaves open, and follow a chain that goes on (`.` at its end).
  const open = (t: string) => {
    let d = 0;
    for (const ch of t.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""')) d += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
    return d;
  };
  while (to < scope.end && to - line0 < 20 && (open(text) > 0 || text.trimEnd().endsWith("."))) text += "\n" + stripComment(lines[++to]!);
  return text;
}

/** `builder.Eq{"id": x, "repo_id": y}` / `&Label{RepoID: x}` pairs → field and value text. */
function pairsOf(body: string, quotedKeys: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of splitTopLevel(body)) {
    const m = quotedKeys ? /^"([\w.`"]+)"\s*:\s*([\s\S]+)$/.exec(part) : /^([A-Z]\w*)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.push([m[1]!.replace(/[`"]/g, ""), m[2]!.trim()]);
  }
  return out;
}

/** Fields a statement filters on, each with the value text it compares with. */
function filtersOf(stmt: string, verb: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // `.Where("a = ? AND b = ?", x, y)` / `.And(…)` / `.Or(…)` / gorm `.Not(…)`.
  for (const m of stmt.matchAll(/\.\s*(?:Where|And|Or|Not|Having)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close < 0) continue;
    const args = splitTopLevel(stmt.slice(open + 1, close));
    const lit = STRING_LIT.exec(args[0] ?? "");
    if (!lit) continue;
    const cols = [...(lit[1] ?? lit[2] ?? "").matchAll(CONDITION)].map((c) => c[1]!.replace(/[`"]/g, ""));
    cols.forEach((col, k) => { if (args[k + 1]) out.push([col, args[k + 1]!]); });
  }
  // `.ID(x)` (xorm) — the primary key; `.In("col", xs)`.
  for (const m of stmt.matchAll(/\.\s*ID\s*\(\s*([^()]+?)\s*\)/g)) out.push(["id", m[1]!]);
  for (const m of stmt.matchAll(/\.\s*In\s*\(\s*"([\w.`]+)"\s*,\s*([^()]+?)\s*\)/g)) out.push([m[1]!.replace(/`/g, ""), m[2]!]);
  // `builder.Eq{"id": x}` anywhere in the statement (a Where, a generic helper's condition).
  for (const m of stmt.matchAll(/\bbuilder\.Eq\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close > 0) out.push(...pairsOf(stmt.slice(open + 1, close), true));
  }
  // gorm `First(&x, id)` / `Find(&xs, ids)` — the primary key; a struct literal's fields as conditions
  // (`Get(&Label{RepoID: x})`, `Where(&Label{…})`).
  const terminal = new RegExp(String.raw`\b${verb}\s*(?:\[[^\]]*\]\s*)?\(`, "g");
  for (const m of stmt.matchAll(terminal)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close < 0) continue;
    const args = splitTopLevel(stmt.slice(open + 1, close));
    if (/^(?:First|Take|Last|Find)$/.test(verb) && args.length === 2 && /^&/.test(args[0]!) && !STRING_LIT.test(args[1]!)) out.push(["id", args[1]!]);
  }
  for (const m of stmt.matchAll(/\.\s*(?:Get|Exist|Where|Find|First|Delete|Count)\s*\(\s*&[A-Za-z_][\w.]*\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close > 0) out.push(...pairsOf(stmt.slice(open + 1, close), false));
  }
  return out;
}

/** Filter fields on a file's xorm/GORM rows whose values have a known origin. */
export function addGoWhereFields(lines: readonly string[], sources: DataSourceInfo[]): void {
  const rows = sources.filter((d) => d.kind === "database" && /^(?:xorm|GORM)\b/.test(d.name));
  if (rows.length === 0) return;
  const scopes = scopesOf(lines);
  for (const d of rows) {
    const scope = scopeAt(scopes, d.line - 1);
    if (!scope) continue;
    const verb = d.name.replace(/^[^:]*:\s*/, "");
    const fields: NonNullable<DataSourceInfo["whereFields"]> = [];
    for (const [field, value] of filtersOf(statementAt(lines, d.line - 1, scope), verb)) {
      const o = goValueOrigin(value, scope);
      if (!o || o.origin.kind === "literal" || fields.some((f) => f.field === field)) continue;
      fields.push({ field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
    }
    if (fields.length > 0) d.whereFields = fields;
  }
}
