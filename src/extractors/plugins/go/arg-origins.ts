import type { CallArgOrigin, ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";
import { boundFromTags, goTags } from "./bound-tags.js";
import { goFunctions } from "./path-arg-calls.js";
import { escapeRegex } from "../shared/path-utils.js";

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
 * one conversion (`strconv.ParseInt(x, 10, 64)`, `strconv.Atoi(x)`) or a
 * one-element slice (`[]int64{id}`). A method's receiver and its exported
 * fields are values too, and a parameter's fields — what a handler that binds
 * the request into a struct hands its methods:
 *
 *   type Club struct { ID int64 `param:"club"` }                       ← the route's `:club` (`boundFrom`)
 *   func (c *Club) Delete(s *xorm.Session) error {
 *       s.Where("id = ?", c.ID).Delete(&Club{})                       ← filters id on the receiver's ID
 *       return touchLeague(s, &League{ID: c.LeagueID}, c)             ← a composite's field; the receiver whole
 *   }
 *
 * Each only up to a write the body makes first (`c.ID = 0`, `*c = loaded`).
 *
 * A condition is a value too, flowing into the statement that filters on it:
 * built in place or before the statement (`conds := []builder.Cond{…}`,
 * `append`ed, `builder.And(conds...)`), handed to a helper as its columns
 * (`getClub(s, builder.Eq{"id": clubID})` → argument 1's field `id`), or
 * filtered on whole in the helper — a condition parameter (`Where(cond)`) or
 * a bean xorm conditions on its set fields (`s.Get(c)`, `club = *c;
 * s.Get(&club)`): `DataSourceInfo.whereObjects`.
 *
 * A struct literal used as the condition (`Where(&Club{ID: id})`) names MEMBERS, not columns: its rows carry the
 * type (`whereFields[].fieldOf`) and the Go entity pass maps them through the struct's tags — struct-columns.ts.
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
/** A composite literal, its fields' text captured: `&Club{ID: x}`, `models.Club{…}`. */
const COMPOSITE = /^&?[A-Za-z_][\w.]*\s*\{([\s\S]*)\}$/;
const IDENT = /^[A-Za-z_]\w*$/;

interface Scope {
  params: string[];
  /**
   * The request values a framework binds into a parameter declared as an inline struct, by
   * parameter and field: Huma's `in *struct { ClubID int64 \`path:"club"\` }` makes `in.ClubID`
   * the route's `{club}`.
   */
  bound?: Map<string, Map<string, Origin>>;
  /** A method's receiver name (`p` of `func (p *Club) Delete(…)`). */
  receiver?: string;
  /** 0-based, inclusive. */
  start: number;
  end: number;
  body: string;
  /** `body` with string contents blanked, offsets unchanged. */
  code: string;
  /** What the body's scans answered, by name: every call of a function asks about the same few names again. */
  memo?: { assigned: Map<string, readonly string[]>; written: Map<string, number> };
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

/** A one-element slice literal: `[]int64{p.ID}`. */
const ONE_SLICE = /^\[\](\*?[\w.]+)\s*\{\s*([^{},]+?)\s*,?\s*\}$/;

/** `strconv.ParseInt(x, 10, 64)` → x and the conversion; `[]int64{x}` → x; anything else as it is. */
function unwrap(expr: string): { expr: string; transform?: string } {
  const slice = ONE_SLICE.exec(expr);
  if (slice) return { expr: slice[2]!, transform: `[]${slice[1]}` };
  const m = CONVERSION.exec(expr);
  if (!m) return { expr };
  const openAt = expr.indexOf("(", m[1]!.length);
  const close = closeAt(expr, openAt);
  if (close !== expr.length - 1) return { expr };
  const args = splitTopLevel(expr.slice(openAt + 1, close));
  return args[0] ? { expr: args[0], transform: m[1]! } : { expr };
}

/** The values `name` is assigned in the body (`x := v`, `x, err := v`, `x = v`, `var x = v`, an `if x, err := v;` header). */
function assignmentsOf(scope: Scope, name: string): readonly string[] {
  const memo = (scope.memo ??= { assigned: new Map(), written: new Map() }).assigned;
  let out = memo.get(name);
  if (!out) memo.set(name, (out = scanAssignments(scope, name)));
  return out;
}

function scanAssignments(scope: Scope, name: string): string[] {
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

/**
 * `name` (or its field `field`) is written in the body before line `line0` (0-based, in the file) —
 * `p.ID = x`, `p.ID++`, `*p = x`, `*p, err = load(…)`, `p := …` — so a read there may see another value.
 * Without a line: anywhere in the body.
 */
function writes(scope: Scope, name: string, field?: string, line0?: number): boolean {
  // The first write's line decides: it is before `line0` or none is.
  const before = (first: number) => first >= 0 && (line0 === undefined || first < line0);
  if (before(firstWrite(scope, name, () => new RegExp(String.raw`(?:^|[^\w.])(?:[\w_]+\s*,\s*)*\*?${name}\s*(?:,\s*[\w_]+\s*)*(?::=|=(?!=))`)))) return true;
  if (field === undefined) return false;
  return before(firstWrite(scope, `${name}.${field}`, () => new RegExp(String.raw`(?:^|[^\w.])${name}\.${field}\s*(?:,\s*[\w_.]+\s*)*(?:[-+*/|&]?=(?!=)|\+\+|--)`)));
}

/** The file line (0-based) of the first match of `pattern` in the body, -1 when it has none; remembered under `key`. */
function firstWrite(scope: Scope, key: string, pattern: () => RegExp): number {
  const memo = (scope.memo ??= { assigned: new Map(), written: new Map() }).written;
  let line = memo.get(key);
  if (line === undefined) {
    const m = pattern().exec(scope.code);
    line = m ? scope.start + 1 + (scope.code.slice(0, m.index).match(/\n/g)?.length ?? 0) : -1;
    memo.set(key, line);
  }
  return line;
}

/** The origin of one value written in `scope`; null when unknown. */
export function goValueOrigin(raw: string, scope: Scope, depth = 0, line0?: number): { origin: Origin; transform?: string } | null {
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
  // An exported field of the receiver or of a parameter the body does not write first (`p.ID`,
  // `c.ClubID`) — exported, as a binder can only set those.
  const member = /^([A-Za-z_]\w*)\.([A-Z]\w*)$/.exec(expr);
  if (member) {
    const [, base, field] = member as unknown as [string, string, string];
    if (writes(scope, base, field, line0)) return null;
    const t = transform ? { transform } : {};
    if (base === scope.receiver) return { origin: { kind: "receiver-field", name: field }, ...t };
    const request = scope.bound?.get(base)?.get(field);
    if (request) return { origin: request, ...t };
    const index = scope.params.indexOf(base);
    return index >= 0 ? { origin: { kind: "param-field", name: base, index, member: field }, ...t } : null;
  }
  if (!IDENT.test(expr)) return null;
  if (expr === scope.receiver) return writes(scope, expr, undefined, line0) || transform ? null : { origin: { kind: "receiver" } };
  const assigned = assignmentsOf(scope, expr);
  const index = scope.params.indexOf(expr);
  if (index >= 0) return assigned.length === 0 ? { origin: { kind: "param", name: expr, index }, ...(transform ? { transform } : {}) } : null;
  // A local assigned once from a parameter, a request read or another such local.
  if (depth >= 2 || assigned.length !== 1 || !assigned[0]) return null;
  const inner = goValueOrigin(assigned[0], scope, depth + 1, line0);
  if (!inner || inner.origin.kind === "literal") return null;
  const t = inner.transform ?? transform;
  return { origin: inner.origin, ...(t ? { transform: t } : {}) };
}

function scopesOf(lines: readonly string[]): Scope[] {
  // The code with string contents blanked to the same length: `"season = ?"` assigns nothing.
  const blank = (text: string) => text.replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, " ") + m[0]);
  return goFunctions(lines).map((f) => {
    const body = lines.slice(f.start + 1, f.end + 1).map(stripComment).join("\n");
    const receiver = f.method ? /^func\s*\(\s*([A-Za-z_]\w*)\s+/.exec(lines[f.start]!)?.[1] : undefined;
    const bound = inlineBindings(f.paramText);
    return { params: f.params, ...(receiver && receiver !== "_" ? { receiver } : {}), ...(bound ? { bound } : {}), start: f.start, end: f.end, body, code: blank(body) };
  });
}

/**
 * The parameters declared as an inline struct whose fields a binder fills from the request
 * (`in *struct { ClubID int64 \`path:"club"\` }` — Huma's input), each field with that request value.
 */
function inlineBindings(paramText: string): Scope["bound"] | undefined {
  if (!/\bstruct\s*\{/.test(paramText)) return undefined;
  let out: Scope["bound"] | undefined;
  for (const part of splitTopLevel(paramText)) {
    const m = /^([A-Za-z_]\w*)\s+\*?struct\s*\{([\s\S]*)\}$/.exec(part.trim());
    if (!m) continue;
    const fields = new Map<string, Origin>();
    for (const member of m[2]!.split(/\n|;/)) {
      const name = /^\s*([A-Z]\w*)\s+\S/.exec(member)?.[1];
      const bound = name ? boundFromTags(goTags(member)) : undefined;
      if (bound) fields.set(name!, { kind: bound.kind, name: bound.name });
    }
    if (fields.size > 0) (out ??= new Map()).set(m[1]!, fields);
  }
  return out;
}

const scopeAt = (scopes: readonly Scope[], line0: number): Scope | undefined => scopes.find((s) => line0 >= s.start && line0 <= s.end);

/** The argument text of the call named `name` on line `line0` (over following lines), or null. */
function callArgsAt(lines: readonly string[], line0: number, name: string, end: number): string[] | null {
  const text = lines.slice(line0, Math.min(end + 1, line0 + 30)).map(stripComment).join("\n");
  const leaf = name.replace(/\(\)/g, "").split(".").pop()!;
  const re = new RegExp(String.raw`\b${escapeRegex(leaf)}\s*(?:\[[^\]\n]*\]\s*)?\(`, "g");
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
    /** Only what a statement can compare a column with, or a same-package object whose fields it can: no
     *  literal (a server's literal names no request value), no request context or writer, no other
     *  package's struct handed on whole. */
    const kept = (o: ReturnType<typeof goValueOrigin>): o is NonNullable<ReturnType<typeof goValueOrigin>> =>
      !!o && o.origin.kind !== "literal" && ((o.origin.kind !== "param" && o.origin.kind !== "param-field") || scalarParam(fn.params[o.origin.index]?.type));
    // A call on the method's own receiver (`p.load(s)`): the callee works on the same object.
    if (scope.receiver && call.name.startsWith(`${scope.receiver}.`) && !call.name.slice(scope.receiver.length + 1).includes(".") && !writes(scope, scope.receiver, undefined, call.line - 1)) {
      out.push({ index: -1, origin: { kind: "receiver" } });
    }
    args.forEach((a, index) => {
      // A condition built for the callee to filter on (`getClub(s, builder.Eq{"id": clubID})`, a local
      // `[]builder.Cond` spread into `builder.And(conds...)`): each compared value at its column.
      const pairs = conditionPairs(a, scope, call.line - 1);
      if (pairs && pairs.length > 0) {
        for (const [field, value] of pairs) {
          const o = goValueOrigin(value, scope, 0, call.line - 1);
          if (kept(o) && o.origin.kind !== "receiver" && !out.some((x) => x.index === index && x.field === field)) out.push({ index, field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
        }
        return;
      }
      if (a.endsWith("...")) return;
      // A composite literal's fields (`&Club{ID: p.ClubID}`): each value at its field of the argument —
      // written in place, or a local built from one before the call (`t := &Club{ID: in.ClubID}`), less
      // the fields the body writes between.
      const built = IDENT.test(a) && a !== scope.receiver && !scope.params.includes(a) ? valuesBefore(scope, a, call.line - 1) : [];
      const local = built.length === 1 && COMPOSITE.test(built[0]!) ? built[0]! : undefined;
      const composite = COMPOSITE.exec(local ?? a);
      if (composite) {
        const rewritten = local ? fieldWrites(scope, a, call.line - 1) : [];
        for (const [field, value] of pairsOf(composite[1]!, false)) {
          if (rewritten.includes(field)) continue;
          const o = goValueOrigin(value, scope, 0, call.line - 1);
          if (kept(o) && o.origin.kind !== "receiver") out.push({ index, field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
        }
        return;
      }
      const o = goValueOrigin(a, scope, 0, call.line - 1);
      if (kept(o)) out.push({ index, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
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

// ─── Conditions: a value flowing into a statement's filter ───────────────

/** The expression starting at `at` in `text`: up to a newline or `;` outside brackets and strings. */
function exprAt(text: string, at: number): string {
  let depth = 0;
  let i = at;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth < 0) break;
    } else if ((c === "\n" || c === ";") && depth === 0) break;
  }
  return text.slice(at, i).trim();
}

/** The values local `name` is given before line `line0` (0-based, in the file): `x := v`, `x = v`, `var x = v` — whole expressions, over lines. */
function valuesBefore(scope: Scope, name: string, line0: number | undefined): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`(?:^|[;{(\s])(?:var\s+${name}\s+[^=\n;]*?|${name}\s*)(?::=|=(?!=))\s*`, "g");
  for (const m of scope.code.matchAll(re)) {
    const at = m.index! + m[0].length;
    if (line0 !== undefined && scope.start + 1 + (scope.code.slice(0, at).match(/\n/g)?.length ?? 0) >= line0) continue;
    out.push(exprAt(scope.body, at));
  }
  return out;
}

/** xorm's builder conditions: a map of columns (`builder.Eq{"id": x}`), a column and a value, and their compositions. */
const COND_MAP = /^builder\.(?:Eq|Neq|Lt|Lte|Gt|Gte)\s*\{/;
const COND_LIKE = /^builder\.Like\s*\{\s*"([\w.`]+)"\s*,\s*([\s\S]+?)\s*\}$/;
const COND_CALL = /^(builder\.(?:In|NotIn|Expr|And|Or)|append)\s*\(/;
const COND_SLICE = /^\[\]builder\.Cond\s*\{/;

/**
 * The columns a builder condition compares, each with the value text it compares with:
 * `builder.Eq{"id": x}`, `builder.In("club_id", ids)`, `builder.Expr("id = ?", x)`, `builder.And(a, b)`,
 * a `[]builder.Cond{…}` and what is `append`ed to it, and a local holding one of them, built before
 * line `line0` (`conds := []builder.Cond{…}` … `builder.And(conds...)`). Null when `expr` is none of these.
 */
function conditionPairs(expr: string, scope: Scope, line0: number | undefined, depth = 0): Array<[string, string, string?]> | null {
  const e = expr.trim().replace(/\.\.\.$/, "");
  if (depth > 4 || !e) return null;
  const whole = (open: number) => closeAt(e, open) === e.length - 1;
  if (COND_MAP.test(e) || COND_SLICE.test(e)) {
    const open = e.indexOf("{");
    if (!whole(open)) return null;
    const body = e.slice(open + 1, -1);
    return COND_MAP.test(e) ? pairsOf(body, true) : splitTopLevel(body).flatMap((a) => conditionPairs(a, scope, line0, depth + 1) ?? []);
  }
  const like = COND_LIKE.exec(e);
  if (like) return [[like[1]!.replace(/`/g, ""), like[2]!]];
  const call = COND_CALL.exec(e);
  if (call) {
    const open = call[0].length - 1;
    if (!whole(open)) return null;
    const args = splitTopLevel(e.slice(open + 1, -1));
    if (call[1] === "builder.In" || call[1] === "builder.NotIn") {
      const col = STRING_LIT.exec(args[0] ?? "");
      return col && args[1] ? [[(col[1] ?? col[2] ?? "").replace(/`/g, ""), args[1]]] : null;
    }
    if (call[1] === "builder.Expr") {
      const lit = STRING_LIT.exec(args[0] ?? "");
      if (!lit) return null;
      const cols = [...(lit[1] ?? lit[2] ?? "").matchAll(CONDITION)].map((c) => c[1]!.replace(/[`"]/g, ""));
      return cols.flatMap((col, k): Array<[string, string]> => (args[k + 1] ? [[col, args[k + 1]!]] : []));
    }
    // `append(conds, more…)`: what it adds — the slice itself is read by its own assignments.
    const parts = call[1] === "append" ? args.slice(1) : args;
    const found = parts.map((a) => conditionPairs(a, scope, line0, depth + 1));
    return call[1] === "append" && found.every((f) => f === null) ? null : found.flatMap((f) => f ?? []);
  }
  // A local holding a condition (never a parameter: what that holds is the caller's).
  if (IDENT.test(e) && e !== scope.receiver && !scope.params.includes(e) && scope.code.includes("builder.")) {
    const values = valuesBefore(scope, e, line0).map((v) => conditionPairs(v, scope, line0, depth + 1));
    return values.some((v) => v !== null) ? values.flatMap((v) => v ?? []) : null;
  }
  return null;
}

/** The fields of `name` the body writes before line `line0` (`c.Title = …`, `c.Pos++`). */
function fieldWrites(scope: Scope, name: string, line0: number): string[] {
  const out = new Set<string>();
  const re = new RegExp(String.raw`(?:^|[^\w.])${name}\.([A-Z]\w*)\s*(?:,\s*[\w_.]+\s*)*(?:[-+*/|&]?=(?!=)|\+\+|--)`, "g");
  for (const m of scope.code.matchAll(re)) if (scope.start + 1 + (scope.code.slice(0, m.index).match(/\n/g)?.length ?? 0) < line0) out.add(m[1]!);
  return [...out];
}

/**
 * The object a statement filters on whole, as a parameter or the receiver: a bean the ORM conditions on
 * its set fields (`s.Get(c)`, `s.Get(&club)` after `club = *c`), or a condition handed in (`Where(cond)`).
 * Null for anything else — a local the function builds, an object it reassigns before the statement.
 */
function objectOrigin(arg: string, scope: Scope, line0: number): NonNullable<DataSourceInfo["whereObjects"]>[number] | null {
  const name = arg.trim().replace(/^&/, "");
  if (!IDENT.test(name)) return null;
  const own = (base: string, extra: string[] = []): NonNullable<DataSourceInfo["whereObjects"]>[number] | null => {
    if (writes(scope, base, undefined, line0)) return null;
    const except = [...new Set([...fieldWrites(scope, base, line0), ...extra])].sort();
    const ex = except.length > 0 ? { except } : {};
    if (base === scope.receiver) return { origin: { kind: "receiver" }, ...ex };
    const index = scope.params.indexOf(base);
    return index >= 0 ? { origin: { kind: "param", name: base, index }, ...ex } : null;
  };
  if (name === scope.receiver || scope.params.includes(name)) return own(name);
  // A copy of one (`club = *c`), assigned once.
  const assigned = assignmentsOf(scope, name);
  const copy = assigned.length === 1 ? /^\*?([A-Za-z_]\w*)$/.exec(assigned[0]!)?.[1] : undefined;
  return copy && (copy === scope.receiver || scope.params.includes(copy)) ? own(copy, fieldWrites(scope, name, line0)) : null;
}

// ─── Filter fields of ORM statements ─────────────────────────────────────

/** `repo_id = ?`, `"user".id=?`, `name LIKE ?`, `id IN (?)` — a compared column before each placeholder. */
const CONDITION = /([`"]?[A-Za-z_][\w`".]*)\s*(?:=|==|<>|!=|>=|<=|>|<|\bLIKE\b|\bILIKE\b|\bIN\b)\s*\(?\s*\?/gi;

/** The statement a database row sits in: lines joined from the chain's first line to the terminal call's end. */
function statementAt(lines: readonly string[], line0: number, scope: Scope): string {
  const open = (t: string) => {
    let d = 0;
    for (const ch of t.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""')) d += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
    return d;
  };
  // Back over lines ending in `.`, and over a step whose arguments spread over lines (`Cols(` ⏎ `"name",` ⏎ `).`).
  let from = line0;
  let back = stripComment(lines[line0]!);
  while (from > scope.start + 1 && line0 - from < 40) {
    const prev = stripComment(lines[from - 1]!);
    if (!prev.trimEnd().endsWith(".") && open(back) >= 0) break;
    back = prev + "\n" + back;
    from--;
  }
  let to = line0;
  let text = stripComment(lines[from]!);
  for (let k = from + 1; k <= line0; k++) text += "\n" + stripComment(lines[k]!);
  // Close what the row's line leaves open, and follow a chain that goes on (`.` at its end).
  while (to < scope.end && to - line0 < 20 && (open(text) > 0 || text.trimEnd().endsWith("."))) text += "\n" + stripComment(lines[++to]!);
  return text;
}

/** `builder.Eq{"id": x, "repo_id": y}` / `&Label{RepoID: x}` pairs → field and value text. */
function pairsOf(body: string, quotedKeys: boolean, owner?: string): Array<[string, string, string?]> {
  const out: Array<[string, string, string?]> = [];
  for (const part of splitTopLevel(body)) {
    const m = quotedKeys ? /^"([\w.`"]+)"\s*:\s*([\s\S]+)$/.exec(part) : /^([A-Z]\w*)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.push(owner ? [m[1]!.replace(/[`"]/g, ""), m[2]!.trim(), owner] : [m[1]!.replace(/[`"]/g, ""), m[2]!.trim()]);
  }
  return out;
}

/**
 * Fields a statement filters on, each with the value text it compares with, and the objects it
 * filters on whole (`objects`: xorm only — a bean conditions on its set fields, GORM's on its key).
 */
function filtersOf(stmt: string, verb: string, scope: Scope, line0: number, xorm: boolean): { pairs: Array<[string, string, string?]>; objects: NonNullable<DataSourceInfo["whereObjects"]> } {
  const out: Array<[string, string, string?]> = [];
  const objects: NonNullable<DataSourceInfo["whereObjects"]> = [];
  // `.Where("a = ? AND b = ?", x, y)` / `.And(…)` / `.Or(…)` / gorm `.Not(…)`.
  for (const m of stmt.matchAll(/\.\s*(?:Where|And|Or|Not|Having)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close < 0) continue;
    const args = splitTopLevel(stmt.slice(open + 1, close));
    const lit = STRING_LIT.exec(args[0] ?? "");
    if (!lit) {
      // A condition value: built in place or before the statement, or handed in (`Where(cond)`).
      if (args.length !== 1) continue;
      const pairs = conditionPairs(args[0]!, scope, line0);
      if (pairs) out.push(...pairs);
      else if (xorm && scope.params.includes(args[0]!.trim())) {
        const o = objectOrigin(args[0]!, scope, line0);
        if (o) objects.push(o);
      }
      continue;
    }
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
    if (/^(?:First|Take|Last|Find)$/.test(verb) && args.length === 2 && /^&/.test(args[0]!) && !STRING_LIT.test(args[1]!) && !xorm) out.push(["id", args[1]!]);
    // xorm: the bean a read or a delete is handed is a condition on its set fields — `Find`'s second argument.
    const bean = !xorm || /\bNoAutoCondition\s*\(/.test(stmt) ? undefined : /^(?:Get|Exist|Count|Delete)$/.test(verb) ? args[0] : /^(?:Find|FindAndCount|Iterate)$/.test(verb) ? args[1] : undefined;
    const o = bean ? objectOrigin(bean, scope, line0) : null;
    if (o && !objects.some((x) => JSON.stringify(x.origin) === JSON.stringify(o.origin))) objects.push(o);
  }
  // The literal's fields are MEMBERS of its type, named as the struct declares them (`ID`, not the column
  // `club_id`): the type travels with them (`fieldOf`) for the project pass that reads its tags.
  for (const m of stmt.matchAll(/\.\s*(?:Get|Exist|Where|Find|First|Delete|Count)\s*\(\s*&([A-Za-z_][\w.]*)\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close > 0) out.push(...pairsOf(stmt.slice(open + 1, close), false, m[1]!));
  }
  // `Find(&clubs, &Club{LeagueID: id})` — the bean is the second argument.
  for (const m of stmt.matchAll(/\.\s*(?:Find|FindAndCount|Iterate)\s*\(\s*[^,(){}]+,\s*&([A-Za-z_][\w.]*)\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeAt(stmt, open);
    if (close > 0) out.push(...pairsOf(stmt.slice(open + 1, close), false, m[1]!));
  }
  return { pairs: out, objects };
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
    const { pairs, objects } = filtersOf(statementAt(lines, d.line - 1, scope), verb, scope, d.line - 1, d.name.startsWith("xorm"));
    for (const [field, value, owner] of pairs) {
      const o = goValueOrigin(value, scope, 0, d.line - 1);
      if (!o || o.origin.kind === "literal" || o.origin.kind === "receiver" || fields.some((f) => f.field === field)) continue;
      fields.push({ field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}), ...(owner ? { fieldOf: owner } : {}) });
    }
    if (fields.length > 0) d.whereFields = fields;
    if (objects.length > 0) d.whereObjects = objects;
  }
}
