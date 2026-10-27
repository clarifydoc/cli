import type { CallArgOrigin, ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a Ruby call's arguments come from (`CallInfo.argOrigins`) and which
 * columns an ActiveRecord statement filters on with them
 * (`DataSourceInfo.whereFields`), for the project pass that follows a route
 * parameter to the column it selects (`paramColumns`):
 *
 *   before_action :club
 *   def club
 *     @club = Current.league.clubs.find_by!(slug: params[:id])   ← filters `slug` on the request's `id`
 *   end
 *   def show
 *     Fixtures.new(club_id: params[:club_id]).call                ← argument `club_id` is the request's
 *   end
 *
 * A value is the request's (`params[:id]`, `params["id"]`, `params.fetch(:id)`
 * — a Rails `params` merges the path and the query string, so a
 * `request-param`), a parameter of the enclosing method, a string literal, or
 * a local the method assigns once from one of those; `.to_i` / `.to_s` /
 * `Integer(x)` are conversions it passes through.
 */

interface Scope {
  params: string[];
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
}

const REQUEST_READ = /^params\s*(?:\[\s*(?::(\w+)|["'](\w+)["'])\s*\]|\.fetch\s*\(\s*(?::(\w+)|["'](\w+)["'])\s*(?:,[^)]*)?\)|\.dig\s*\(\s*(?::(\w+)|["'](\w+)["'])\s*\))$/;
const CONVERSION_SUFFIX = /\.(to_i|to_s|to_sym|downcase|strip)$/;
const CONVERSION_CALL = /^(Integer|String)\(\s*([\s\S]+)\s*\)$/;
const STRING_LIT = /^"((?:[^"\\#]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/;
const IDENT = /^[a-z_]\w*$/;

const stripComment = (line: string): string => line.replace(/(^|\s)#(?![{]).*$/, "$1");

/** Text split at its top-level commas, quotes and brackets honoured. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The index of the bracket closing the one at `open` (strings skipped), or -1. */
function closeAt(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      i = j;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** The values `name` is assigned in the method's lines (`x = v`, `x ||= v`). */
function assignmentsOf(lines: readonly string[], scope: Scope, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`^\s*${name}\s*(?:\|\||&&|\+|-)?=(?!=|~)\s*(.+)$`);
  const multi = new RegExp(String.raw`^\s*[\w\s,*]*\b${name}\b[\w\s,*]*,[\w\s,*]*=(?!=)|^\s*[\w\s,*]*,\s*${name}\s*=(?!=)`);
  for (let i = scope.line; i < scope.endLine - 1 && i < lines.length; i++) {
    const code = stripComment(lines[i]!);
    const m = re.exec(code);
    if (m) out.push(m[1]!.trim().replace(/\s+(?:if|unless)\s.+$/, ""));
    else if (multi.test(code)) out.push("");
  }
  return out;
}

/** The origin of one value written in `scope`; null when unknown. */
export function rubyValueOrigin(raw: string, lines: readonly string[], scope: Scope, depth = 0): { origin: Origin; transform?: string } | null {
  let expr = raw.trim().replace(/^\(\s*([\s\S]*)\s*\)$/, "$1");
  let transform: string | undefined;
  const call = CONVERSION_CALL.exec(expr);
  if (call) {
    transform = call[1];
    expr = call[2]!.trim();
  }
  const suffix = CONVERSION_SUFFIX.exec(expr);
  if (suffix) {
    transform ??= suffix[1];
    expr = expr.slice(0, suffix.index).trim();
  }
  const lit = STRING_LIT.exec(expr);
  if (lit) return { origin: { kind: "literal", value: lit[1] ?? lit[2] ?? "" } };
  const read = REQUEST_READ.exec(expr);
  if (read) {
    const name = read.slice(1).find((g) => g !== undefined)!;
    return { origin: { kind: "request-param", name }, ...(transform ? { transform } : {}) };
  }
  if (!IDENT.test(expr)) return null;
  const assigned = assignmentsOf(lines, scope, expr);
  const index = scope.params.indexOf(expr);
  if (index >= 0) return assigned.length === 0 ? { origin: { kind: "param", name: expr, index }, ...(transform ? { transform } : {}) } : null;
  if (depth >= 2 || assigned.length !== 1 || !assigned[0]) return null;
  const inner = rubyValueOrigin(assigned[0], lines, scope, depth + 1);
  if (!inner || inner.origin.kind === "literal") return null;
  const t = inner.transform ?? transform;
  return { origin: inner.origin, ...(t ? { transform: t } : {}) };
}

const scopeOf = (fn: FunctionInfo): Scope => ({ params: fn.params.map((p) => p.name.replace(/^[*&]+|:$/g, "")), line: fn.line, endLine: fn.endLine });

/** `foo(a, b)` / `foo a, b` after `name` on the line → the argument texts. */
function argsAfter(text: string, at: number): string[] | null {
  const rest = text.slice(at);
  if (rest.startsWith("(")) {
    const close = closeAt(text, at);
    return close < 0 ? null : splitTopLevel(text.slice(at + 1, close));
  }
  // A parenthesis-less call: the rest of the statement, up to a block or a modifier.
  const bare = /^ +(?!do\b|if\b|unless\b|\{|=|\?|:|\.|\|\||&&|and\b|or\b)([^\n]+?)(?:\s+(?:do|if|unless)\b.*)?$/.exec(rest);
  return bare ? splitTopLevel(bare[1]!) : null;
}

/** The call named `name` on 1-based `line`: its argument texts. */
function callArgsAt(lines: readonly string[], line: number, name: string): string[] | null {
  const text = stripComment(lines[line - 1] ?? "");
  const leaf = name.replace(/\(\)/g, "").split(/\.|::/).pop()!;
  const re = new RegExp(String.raw`(?<![\w])${leaf.replace(/[!?]/g, (c) => `\\${c}`)}(?![\w!?])`, "g");
  for (const m of text.matchAll(re)) {
    const args = argsAfter(text, m.index! + m[0].length);
    if (args) return args;
  }
  return null;
}

function addArgOrigins(lines: readonly string[], fn: FunctionInfo): void {
  const scope = scopeOf(fn);
  for (const call of fn.calls) {
    if (call.argOrigins) continue;
    const args = callArgsAt(lines, call.line, call.name);
    if (!args || args.length === 0 || args.length > 12) continue;
    const out: CallArgOrigin[] = [];
    args.forEach((a, index) => {
      // `club_id: params[:club_id]` — a keyword argument names the callee's parameter.
      const kw = /^([a-z_]\w*):\s+([\s\S]+)$/.exec(a);
      const o = rubyValueOrigin(kw ? kw[2]! : a, lines, scope);
      // A server's literal names no request value: only what a statement can compare a column with.
      if (o && o.origin.kind !== "literal") out.push({ index, ...(kw ? { param: kw[1]! } : {}), origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
    });
    if (out.length > 0) call.argOrigins = out;
  }
}

/** Arg origins on the calls of a file's methods and functions. */
export function withRubyArgOrigins(lines: readonly string[], fns: FunctionInfo[]): void {
  for (const fn of fns) if (fn.name !== "<setup>") addArgOrigins(lines, fn);
}

export function withRubyArgOriginsInClasses(lines: readonly string[], classes: readonly ClassInfo[]): void {
  for (const cls of classes) for (const m of cls.methods) addArgOrigins(lines, m);
}

// ─── ActiveRecord filter fields ──────────────────────────────────────────

/** `club_id = ?`, `"clubs"."slug" = ?`, `name ILIKE ?` — a compared column before each placeholder. */
const CONDITION = /([A-Za-z_][\w."]*)\s*(?:=|<>|!=|>=|<=|>|<|\bLIKE\b|\bILIKE\b|\bIN\b)\s*\(?\s*\?/gi;
const HASH_FINDERS = /^(?:where|find_by!?|find_or_create_by!?|find_or_initialize_by|exists\?|rewhere|not|create_or_find_by!?)$/;

/** `slug: v`, `:slug => v`, `"slug" => v` → field and value. */
function hashPairs(args: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const a of args) {
    const m = /^(?:([a-z_]\w*):(?!:)\s*|:([a-z_]\w*)\s*=>\s*|["']([\w.]+)["']\s*=>\s*)([\s\S]+)$/.exec(a);
    if (m) out.push([m[1] ?? m[2] ?? m[3]!, m[4]!.trim()]);
  }
  return out;
}

/** Fields the statement's verb filters on, each with the value text it compares with. */
function filtersOf(method: string, args: readonly string[]): Array<[string, string]> {
  if (/^find!?$/.test(method)) return args.length === 1 && !/^[a-z_]\w*:|=>/.test(args[0]!) ? [["id", args[0]!]] : [];
  const dynamic = /^find_by_([a-z_]\w*?)!?$/.exec(method);
  if (dynamic) {
    const cols = dynamic[1]!.split("_and_");
    return cols.length === args.length ? cols.map((c, k) => [c, args[k]!]) : [];
  }
  if (!HASH_FINDERS.test(method)) return [];
  const lit = STRING_LIT.exec(args[0] ?? "");
  if (lit) {
    const cols = [...(lit[1] ?? lit[2] ?? "").matchAll(CONDITION)].map((c) => c[1]!.replace(/"/g, ""));
    return cols.flatMap((col, k): Array<[string, string]> => (args[k + 1] ? [[col, args[k + 1]!]] : []));
  }
  // `where(slug: v)` or `where({ slug: v })`.
  const inner = args.length === 1 && /^\{[\s\S]*\}$/.test(args[0]!) ? splitTopLevel(args[0]!.slice(1, -1)) : args;
  return hashPairs(inner);
}

/** Filter fields on a file's ActiveRecord rows whose values have a known origin. */
export function addRubyWhereFields(lines: readonly string[], sources: DataSourceInfo[], classes: readonly ClassInfo[], functions: readonly FunctionInfo[] = []): void {
  const rows = sources.filter((d) => d.kind === "database");
  if (rows.length === 0) return;
  const fns = [...functions, ...classes.flatMap((c) => c.methods)];
  for (const d of rows) {
    const owner = fns.filter((f) => d.line >= f.line && d.line <= f.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
    if (!owner) continue;
    const method = d.name.slice(d.name.lastIndexOf(".") + 1);
    const args = callArgsAt(lines, d.line, method);
    if (!args) continue;
    const scope = scopeOf(owner);
    const fields: NonNullable<DataSourceInfo["whereFields"]> = [];
    for (const [field, value] of filtersOf(method, args)) {
      const o = rubyValueOrigin(value, lines, scope);
      if (!o || o.origin.kind === "literal" || fields.some((f) => f.field === field)) continue;
      fields.push({ field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
    }
    if (fields.length > 0) d.whereFields = fields;
  }
}
