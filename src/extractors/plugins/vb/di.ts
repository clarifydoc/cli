import type { DiBinding, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";
import { isBuiltinType } from "../../shared/builtin-types.js";
import { readVbType } from "./request-schema.js";

/**
 * Dependency-injection facts for VB.NET, read from source text: container
 * registrations (`services.AddScoped(Of IRepo, SqlRepo)()`, Autofac, Unity,
 * Simple Injector), locals whose type the body states (`Dim r As New Repo()`,
 * `Dim c = sp.GetRequiredService(Of IClock)()`), and container lookups chained
 * straight into a call. The symbol linker joins them; nothing here decides
 * which implementation an injection point receives.
 *
 * VB is case-insensitive and statements continue across lines (`_`, or
 * implicitly inside an open argument list), so everything below works on
 * LOGICAL statements with string contents and comments blanked out.
 */

// ─── Source text: strings, comments, logical statements ─────────────────────

/**
 * `line` with every string literal's contents and any `'` comment replaced by
 * spaces — same length, so a match column in the result indexes the raw line.
 * `""` inside a string is an escaped quote.
 */
export function vbCodeText(line: string): string {
  if (!line.includes('"') && !line.includes("'")) return line;
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inString) {
      if (c === '"' && line[i + 1] === '"') { out += "  "; i++; continue; }
      if (c === '"') inString = false;
      out += c === '"' ? c : " ";
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "'") return out + " ".repeat(line.length - i);
    out += c;
  }
  return out;
}

/** One logical statement: `code` (strings/comments blanked) and `raw` align character for character. */
interface LogicalLine {
  code: string;
  raw: string;
  /** 0-based index of the first physical line. */
  first: number;
}

/** Trailing tokens after which VB continues the statement on the next line. */
const CONTINUES_RE = /(?:\s_|[,(&+{=])\s*$/;

/** Most physical lines one logical statement may span. */
const MAX_STATEMENT_LINES = 15;

/**
 * Join physical lines into logical statements: an explicit ` _`, an
 * unbalanced bracket, or a trailing `,` `(` `&` `+` `{` `=` carries the
 * statement over. Physical lines are joined with `\n`, so an offset into
 * `code` still tells which line it came from.
 */
export function vbLogicalLines(lines: readonly string[]): LogicalLine[] {
  const out: LogicalLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = i;
    let code = "";
    let raw = "";
    let depth = 0;
    for (let n = 0; i < lines.length && n < MAX_STATEMENT_LINES; n++, i++) {
      let c = vbCodeText(lines[i]!);
      const r = lines[i]!;
      const continued = CONTINUES_RE.test(c);
      if (/\s_\s*$/.test(c)) c = c.replace(/_(\s*)$/, " $1");
      for (const ch of c) {
        if (ch === "(" || ch === "{") depth++;
        else if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
      }
      code += (n > 0 ? "\n" : "") + c;
      raw += (n > 0 ? "\n" : "") + r;
      if (!continued && depth === 0) { i++; break; }
    }
    out.push({ code, raw, first });
  }
  return out;
}

/** 0-based physical line of `offset` within a logical statement. */
function lineAt(stmt: LogicalLine, offset: number): number {
  let line = stmt.first;
  for (let k = 0; k < offset && k < stmt.code.length; k++) if (stmt.code[k] === "\n") line++;
  return line;
}

/** Index of the bracket closing the one at `open`, or -1. */
function closeOf(code: string, open: number): number {
  const opener = code[open];
  const closer = opener === "{" ? "}" : ")";
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === opener) depth++;
    else if (code[k] === closer && --depth === 0) return k;
  }
  return -1;
}

/** A slice of a statement, as code (for structure) and raw text (for string contents). */
interface Piece {
  code: string;
  raw: string;
}

/** `code`/`raw` from `from` to `to` split at depth-0 commas, each piece trimmed. */
function splitArgs(code: string, raw: string, from: number, to: number): Piece[] {
  const out: Piece[] = [];
  let depth = 0;
  let start = from;
  const push = (end: number) => {
    const c = code.slice(start, end);
    if (c.trim() === "") return;
    const lead = c.length - c.trimStart().length;
    const trail = c.length - c.trimEnd().length;
    out.push({ code: c.trim(), raw: raw.slice(start + lead, end - trail) });
  };
  for (let k = from; k < to; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      push(k);
      start = k + 1;
    }
  }
  push(to);
  return out;
}

/** `"sms"` → `sms`; a non-literal key (`Keys.Sms`) is kept as written; `Nothing` is no key. */
function keyText(piece: Piece | undefined): string | null {
  if (!piece) return null;
  const str = piece.raw.match(/^"((?:[^"]|"")*)"$/);
  if (str) return str[1]!.replace(/""/g, '"');
  if (/^Nothing$/i.test(piece.code)) return null;
  return /^[A-Za-z_][\w.]*$/.test(piece.code) ? piece.code : null;
}

/** True when the piece is a string literal (its contents unreadable in blanked code). */
function isStringLiteral(piece: Piece | undefined): boolean {
  return piece !== undefined && /^"/.test(piece.code);
}

/**
 * A type as the container names it: `Global.App.IRepo(Of User)` → `IRepo`,
 * `GetType(IRepo(Of ))` → `IRepo`. Null for anything that is not a type name.
 */
export function bareVbTypeName(text: string): string | null {
  let t = text.trim();
  const getType = t.match(/^GetType\s*\(([\s\S]*)\)$/i);
  if (getType) t = getType[1]!.trim();
  t = t.replace(/\s*\([\s\S]*$/, "").replace(/^Global\./i, "");
  const simple = t.split(".").pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(simple) ? simple : null;
}

// ─── Chains: `.RegisterType(Of T)().As(Of I)().Named(Of I)("x")` ─────────────

/** One `.Name(Of T1, T2)(args)` link of a fluent chain. */
interface ChainSegment {
  name: string;
  /** Offset of the name within the statement. */
  at: number;
  typeArgs: Piece[];
  args: Piece[];
}

/**
 * The fluent chain starting at the member name at `at`: each segment's
 * `(Of …)` type arguments and call arguments, then the next `.Member` — until
 * the expression stops chaining.
 */
function readChain(stmt: LogicalLine, at: number): ChainSegment[] {
  const { code, raw } = stmt;
  const out: ChainSegment[] = [];
  let k = at;
  while (k < code.length) {
    const name = /^[A-Za-z_]\w*/.exec(code.slice(k));
    if (!name) break;
    const seg: ChainSegment = { name: name[0], at: k, typeArgs: [], args: [] };
    k += name[0].length;
    for (let group = 0; group < 2; group++) {
      const ws = /^\s*/.exec(code.slice(k))![0].length;
      if (code[k + ws] !== "(") break;
      const open = k + ws;
      const close = closeOf(code, open);
      if (close < 0) return out;
      const inner = code.slice(open + 1, close);
      const of = /^\s*Of\s+/i.exec(inner);
      if (group === 0 && of) seg.typeArgs = splitArgs(code, raw, open + 1 + of[0].length, close);
      else if (seg.args.length === 0) seg.args = splitArgs(code, raw, open + 1, close);
      k = close + 1;
      if (group === 0 && !of) break;
    }
    out.push(seg);
    const dot = /^\s*\.\s*/.exec(code.slice(k));
    if (!dot) break;
    k += dot[0].length;
  }
  return out;
}

// ─── Factories: `Function(sp) New SqlRepo(…)` ───────────────────────────────

/**
 * The class a registration's instance or factory argument produces: a plain
 * construction (`New SqlRepo(cfg)`, `New SqlRepo With {…}`), a lambda whose
 * body is exactly one (`Function(sp) New SqlRepo()`, a multi-line `Function`
 * whose only statement is `Return New SqlRepo()`), or a forward to another
 * registration (`Function(sp) sp.GetRequiredService(Of SqlRepo)()` — an
 * alias the linker follows). Anything else says nothing statically.
 */
export function producedClass(code: string): string | null {
  let expr = code.trim();
  const lambda = /^Function\s*\(/i.exec(expr);
  if (lambda) {
    const open = expr.indexOf("(");
    const close = closeOf(expr, open);
    if (close < 0) return null;
    const body = expr.slice(close + 1);
    if (!/\bEnd\s+Function\s*$/i.test(body)) {
      // A single-line lambda: its body is one expression (maybe `_`-continued).
      expr = body.trim();
    } else {
      const statements = body
        .replace(/\bEnd\s+Function\s*$/i, "")
        .split(/[\n:]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (statements.length !== 1) return null;
      const ret = /^Return\s+([\s\S]+)$/i.exec(statements[0]!);
      if (!ret) return null;
      expr = ret[1]!.trim();
    }
  }
  if (/^New\s/i.test(expr)) {
    const type = plainConstruction(expr);
    return type ? bareVbTypeName(type) : null;
  }
  const forward = /^[A-Za-z_][\w.]*\.(?:GetRequiredService|GetService|Resolve|GetInstance)\s*\(\s*Of\s+([^()]+(?:\([^()]*\))?)\)\s*(?:\(\s*\))?$/i.exec(expr);
  if (forward) return bareVbTypeName(forward[1]!);
  return null;
}

/**
 * The class an expression that is ONE construction builds, as written
 * (`New Repo(x)` → `Repo`, `New Box(Of User)()` → `Box(Of User)`, `New Repo
 * With {…}` → `Repo`); null when anything is chained onto it
 * (`New Repo().WithCache()`) or it is not a construction at all.
 */
function plainConstruction(expr: string): string | null {
  const construction = /^New\s+/i.exec(expr);
  if (!construction) return null;
  const head = readVbType(expr, construction[0].length);
  if (!head) return null;
  // `readVbType` keeps an empty `()` as an array suffix; after `New` it is the
  // constructor call.
  const type = head.type.replace(/\(\s*\)$/, "");
  let k = head.end;
  const ws = /^\s*/.exec(expr.slice(k))![0].length;
  if (expr[k + ws] === "(") {
    const close = closeOf(expr, k + ws);
    if (close < 0) return null;
    k = close + 1;
  }
  const rest = expr.slice(k).trim();
  if (rest !== "" && !/^(?:With|From)\s*\{[\s\S]*\}$/i.test(rest)) return null;
  return type;
}

// ─── Registrations ───────────────────────────────────────────────────────────

/** The registration calls a statement can start with (after a `.`). */
const REGISTRATION_RE =
  /\.\s*((?:Try)?Add(?:Keyed)?(?:Scoped|Transient|Singleton)|AddHttpClient|RegisterType|RegisterInstance|RegisterSingleton|Register)\s*\(/gi;

/** Cheap whole-file gate before any statement is assembled. */
const REGISTRATION_GATE_RE = /\.\s*(?:(?:Try)?Add(?:Keyed)?(?:Scoped|Transient|Singleton)|AddHttpClient|Register\w*)\s*\(/i;

/**
 * Container registrations in a VB file → `FileAnalysis.diBindings`.
 *
 * - Microsoft.Extensions.DependencyInjection: `AddScoped/AddTransient/
 *   AddSingleton(Of I, T)()`, `(GetType(I), GetType(T))` (open generics
 *   included), a factory or instance (`AddScoped(Of I)(Function(sp) New T())`),
 *   `TryAdd*` (a default: `ifAbsent`), `AddKeyed*` (keyed: `qualifier`,
 *   `keyedOnly`), `AddHttpClient(Of I, T)()`.
 * - Autofac: `RegisterType(Of T)().As(Of I)()`, `.Named(Of I)("x")` /
 *   `.Keyed(Of I)(key)` (reachable by key only), `.PreserveExistingDefaults()`
 *   (`ifAbsent`), `Register(Function(c) New T()).As(Of I)()`,
 *   `RegisterInstance(New T()).As(Of I)()`.
 * - Unity: `RegisterType(Of I, T)()` / `("name")` (a named registration is
 *   resolved by name only), `RegisterSingleton(Of I, T)()`,
 *   `RegisterInstance(Of I)(New T())`.
 * - Simple Injector: `Register(Of I, T)(…)`, `RegisterSingleton(Of I, T)()`,
 *   `Register(Of I)(Function() New T())`.
 *
 * Registrations whose service is their own implementation say nothing and are
 * skipped; `AsImplementedInterfaces()` and other reflection-driven forms are
 * not decidable from the text and are skipped too. Every other registration
 * is emitted, conflicting ones included — choosing is the linker's job.
 */
export function extractVbDiBindings(lines: string[], _filePath: string): DiBinding[] {
  const out: DiBinding[] = [];
  if (!lines.some((l) => REGISTRATION_GATE_RE.test(l))) return out;
  for (const stmt of vbLogicalLines(lines)) {
    if (!REGISTRATION_GATE_RE.test(stmt.code)) continue;
    REGISTRATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let consumedTo = -1;
    while ((m = REGISTRATION_RE.exec(stmt.code)) !== null) {
      const nameAt = m.index + m[0].indexOf(m[1]!);
      if (nameAt < consumedTo) continue;
      const chain = readChain(stmt, nameAt);
      if (chain.length === 0) continue;
      const last = chain[chain.length - 1]!;
      consumedTo = last.at + last.name.length;
      const line = lineAt(stmt, nameAt) + 1;
      for (const b of bindingsOfChain(chain)) out.push({ ...b, line });
    }
  }
  return out;
}

type Draft = Omit<DiBinding, "line">;

function bindingsOfChain(chain: ChainSegment[]): Draft[] {
  const head = chain[0]!;
  const name = head.name.toLowerCase();
  const msdi = /^(try)?add(keyed)?(scoped|transient|singleton)$/.exec(name);
  if (msdi) return msDiBinding(head, !!msdi[1], !!msdi[2]);
  if (name === "addhttpclient") {
    if (head.typeArgs.length !== 2) return [];
    return finish(head.typeArgs[0]!.code, head.typeArgs[1]!.code, { via: head.name });
  }
  if (name === "registertype" || name === "registersingleton" || name === "register" || name === "registerinstance") {
    return containerBinding(chain);
  }
  return [];
}

/** `service` → `implementation` as a binding, or nothing when either is unreadable or it registers itself. */
function finish(serviceText: string, implementation: string | null, extra: Partial<Draft> & { via: string }): Draft[] {
  const service = bareVbTypeName(serviceText);
  if (!service || !implementation) return [];
  if (service === implementation && !extra.qualifier) return [];
  const b: Draft = { service, implementation, via: extra.via };
  if (extra.qualifier) b.qualifier = extra.qualifier;
  if (extra.keyedOnly) b.keyedOnly = true;
  if (extra.ifAbsent) b.ifAbsent = true;
  return [b];
}

/** Microsoft.Extensions.DependencyInjection `Add*` / `TryAdd*` / `AddKeyed*`. */
function msDiBinding(head: ChainSegment, tryAdd: boolean, keyed: boolean): Draft[] {
  const args = [...head.args];
  let qualifier: string | undefined;
  if (keyed) {
    // Generic: the key is the first call argument. Non-generic: `(GetType(I), key, …)`.
    const keyIdx = head.typeArgs.length > 0 ? 0 : 1;
    const key = keyText(args[keyIdx]);
    if (!key) return [];
    qualifier = key;
    args.splice(keyIdx, 1);
  }
  const extra = { via: head.name, qualifier, keyedOnly: keyed, ifAbsent: tryAdd };
  if (head.typeArgs.length === 2) {
    return finish(head.typeArgs[0]!.code, bareVbTypeName(head.typeArgs[1]!.code), extra);
  }
  if (head.typeArgs.length === 1) {
    const produced = args[0] ? producedClass(args[0].code) : null;
    return finish(head.typeArgs[0]!.code, produced, extra);
  }
  // `AddScoped(GetType(I), GetType(T))` / `AddScoped(GetType(I), Function(sp) …)`.
  const service = args[0];
  const impl = args[1];
  if (!service || !impl || !/^GetType\s*\(/i.test(service.code)) return [];
  const implementation = /^GetType\s*\(/i.test(impl.code) ? bareVbTypeName(impl.code) : producedClass(impl.code);
  return finish(service.code, implementation, extra);
}

/**
 * Autofac / Unity / Simple Injector registrations. Two type arguments name
 * service and implementation directly (Unity, Simple Injector); otherwise the
 * implementation comes from the head (`RegisterType(Of T)`, a factory, an
 * instance) and the services from the chain (`.As(Of I)`, `.Named(Of I)(n)`,
 * `.Keyed(Of I)(k)`) — Autofac, where a registration with no `As` serves only
 * its own type.
 */
function containerBinding(chain: ChainSegment[]): Draft[] {
  const head = chain[0]!;
  const via = head.name;
  if (head.typeArgs.length === 2) {
    // Unity names a registration with a leading string argument; a named one
    // is resolved by name only.
    const named = isStringLiteral(head.args[0]) ? keyText(head.args[0]) : null;
    return finish(head.typeArgs[0]!.code, bareVbTypeName(head.typeArgs[1]!.code), {
      via,
      ...(named ? { qualifier: named, keyedOnly: true } : {}),
    });
  }

  let implementation: string | null = null;
  let headService: string | null = null;
  let headName: string | null = null;
  const lower = head.name.toLowerCase();
  if (lower === "registertype") {
    if (head.typeArgs.length === 1) implementation = bareVbTypeName(head.typeArgs[0]!.code);
    else if (head.args.length === 1 && /^GetType\s*\(/i.test(head.args[0]!.code)) implementation = bareVbTypeName(head.args[0]!.code);
  } else if (lower === "registerinstance" || lower === "register" || lower === "registersingleton") {
    // Unity `RegisterInstance(Of I)([name,] instance)`, Simple Injector
    // `Register(Of I)(Function() New T())`, Autofac `Register(Function(c) …)`.
    if (head.typeArgs.length === 1) headService = head.typeArgs[0]!.code;
    if (headService && isStringLiteral(head.args[0])) headName = keyText(head.args[0]);
    const produced = head.args.map((a) => producedClass(a.code)).filter((c): c is string => c !== null);
    implementation = produced.length === 1 ? produced[0]! : null;
  }
  if (!implementation) return [];

  const services: Array<{ service: string; qualifier?: string; keyedOnly?: boolean }> = [];
  let ifAbsent = false;
  for (const seg of chain.slice(1)) {
    const n = seg.name.toLowerCase();
    if (n === "as") {
      for (const t of seg.typeArgs) services.push({ service: t.code });
      for (const a of seg.args) if (/^GetType\s*\(/i.test(a.code)) services.push({ service: a.code });
    } else if (n === "named" || n === "keyed") {
      const key = keyText(seg.args[0]);
      const service = seg.typeArgs[0]?.code ?? seg.args[1]?.code;
      if (key && service) services.push({ service, qualifier: key, keyedOnly: true });
    } else if (n === "preserveexistingdefaults") {
      ifAbsent = true;
    }
  }
  if (services.length === 0 && headService) {
    services.push(headName ? { service: headService, qualifier: headName, keyedOnly: true } : { service: headService });
  }
  const out: Draft[] = [];
  for (const s of services) {
    out.push(...finish(s.service, implementation, {
      via,
      ...(s.qualifier ? { qualifier: s.qualifier, keyedOnly: s.keyedOnly } : {}),
      ...(ifAbsent ? { ifAbsent } : {}),
    }));
  }
  return out;
}

// ─── Locals ──────────────────────────────────────────────────────────────────

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** Container lookups whose result is the requested type: `sp.GetRequiredService(Of IRepo)()`. */
const LOOKUP_RE =
  /^(?:[A-Za-z_][\w.]*\.)?(GetRequiredService|GetService|GetRequiredKeyedService|GetKeyedService|Resolve|ResolveKeyed|ResolveNamed|GetInstance)\s*\(\s*Of\s+/i;

/**
 * What an initializer expression evaluates to, when it says so itself: a
 * construction (`New Repo(…)`), a container lookup (`sp.GetRequiredService(Of
 * IRepo)()`, keyed lookups carrying their key), or a cast (`CType(x, IRepo)`,
 * `DirectCast`, `TryCast`).
 */
function typeOfExpression(code: string, raw: string): { type: string; qualifier?: string } | null {
  const expr = code.trim();
  const lead = code.length - code.trimStart().length;
  const exprRaw = raw.slice(lead, lead + expr.length);
  if (/^New\s/i.test(expr)) {
    const type = plainConstruction(expr);
    return type ? { type } : null;
  }
  const lookup = LOOKUP_RE.exec(expr);
  if (lookup) {
    const open = expr.indexOf("(", lookup.index + lookup[0].indexOf(lookup[1]!));
    const close = closeOf(expr, open);
    if (close < 0) return null;
    const type = expr.slice(lookup[0].length, close).trim();
    // The lookup's own argument list: empty, or the key of a keyed lookup.
    const rest = expr.slice(close + 1).trim();
    let qualifier: string | undefined;
    if (rest !== "") {
      if (!rest.startsWith("(") || closeOf(expr, expr.indexOf("(", close + 1)) !== expr.length - 1) return null;
      const argOpen = expr.indexOf("(", close + 1);
      const args = splitArgs(expr, exprRaw, argOpen + 1, expr.length - 1);
      const keyed = /Keyed|Named/i.test(lookup[1]!) || args.length > 0;
      if (keyed) {
        const key = keyText(args[0]);
        if (!key || args.length !== 1) return null;
        qualifier = key;
      }
    }
    if (!/^[A-Za-z_][\w.]*(?:\s*\(\s*Of\b[^)]*\))?$/i.test(type)) return null;
    return qualifier ? { type, qualifier } : { type };
  }
  const cast = /^(?:CType|DirectCast|TryCast)\s*\(/i.exec(expr);
  if (cast) {
    const open = cast[0].length - 1;
    if (closeOf(expr, open) !== expr.length - 1) return null;
    const args = splitArgs(expr, exprRaw, open + 1, expr.length - 1);
    if (args.length !== 2) return null;
    const t = readVbType(args[1]!.code, 0);
    return t && t.end === args[1]!.code.length ? { type: t.type } : null;
  }
  return null;
}

/** The simple name of a VB type text, for the builtin check (`Integer?` → `Integer`). */
function simpleTypeName(type: string): string {
  return type.replace(/\s*\(.*$/s, "").replace(/\?$/, "").split(".").pop() ?? type;
}

/** Statement keywords that declare locals: `Dim`, `Static`, `Using`, `For Each x As T`, `For i As T =`. */
const DECLARATION_RE = /^(?:(Dim|Static|Using)\s+|For\s+(?:Each\s+)?)/i;

/**
 * Locals whose type a VB body states → `FunctionInfo.localTypes`:
 * `Dim r As IRepo`, `Dim r As New Repo()`, `Dim r = New Repo()`,
 * `Dim r As IRepo = sp.GetRequiredService(Of IRepo)()`, `Dim c = sp.GetRequiredService(Of IClock)()`,
 * `Dim n = sp.GetRequiredKeyedService(Of INotifier)("sms")` (with its key),
 * `Dim c = CType(sp.GetService(GetType(IClock)), IClock)`, `Using`, `For Each x As T`,
 * and `Dim a, b As Repo` (both `Repo`). A name declared with two different
 * types in one body is left out rather than guessed; builtin-typed locals
 * (`Integer`, `String`) carry nothing for a receiver and are skipped.
 */
export function extractVbLocalTypes(bodyLines: string[], _fn: { name: string; params: ParamInfo[] }): LocalType[] {
  const found = new Map<string, LocalType | null>();
  const record = (name: string, local: { type: string; qualifier?: string }) => {
    if (isBuiltinType(simpleTypeName(local.type), "vb")) return;
    const prev = found.get(name);
    if (prev === null) return;
    if (prev && (prev.type !== local.type || prev.qualifier !== local.qualifier)) {
      found.set(name, null);
      return;
    }
    found.set(name, local.qualifier ? { name, type: local.type, qualifier: local.qualifier } : { name, type: local.type });
  };

  for (const stmt of vbLogicalLines(bodyLines)) {
    if (!/\b(?:Dim|Static|Using|For)\b/i.test(stmt.code)) continue;
    for (const part of splitStatements(stmt)) {
      const decl = DECLARATION_RE.exec(part.code.trimStart());
      if (!decl) continue;
      const lead = part.code.length - part.code.trimStart().length + decl[0].length;
      const isFor = !decl[1];
      const end = isFor ? forDeclaratorEnd(part.code, lead) : part.code.length;
      if (end < 0) continue;
      const declarators = splitArgs(part.code, part.raw, lead, end);
      // `Dim a, b As Repo`: names without a type take the next declarator's.
      let pending: string[] = [];
      for (const d of declarators) {
        const head = /^([A-Za-z_]\w*)(\s*\(\s*\))?(\s+As\s+(New\s+)?)?/i.exec(d.code);
        if (!head || head[2]) { pending = []; continue; }
        const name = head[1]!;
        if (head[3]) {
          const t = readVbType(d.code, head[0].length);
          if (!t) { pending = []; continue; }
          // `As New Repo()`: the parens are the constructor call, not an array.
          if (head[4]) t.type = t.type.replace(/\(\s*\)$/, "");
          let local: { type: string; qualifier?: string } = { type: t.type };
          const init = d.code.slice(t.end).match(/^\s*=\s*/);
          if (init && !head[4]) {
            // A declared type stays the type; a keyed lookup adds its key.
            const from = t.end + init[0].length;
            const value = typeOfExpression(d.code.slice(from), d.raw.slice(from));
            if (value?.qualifier) local = { type: t.type, qualifier: value.qualifier };
          }
          for (const p of pending) record(p, { type: t.type });
          pending = [];
          record(name, local);
          continue;
        }
        const init = /^\s*=\s*/.exec(d.code.slice(head[0].length));
        if (init) {
          const from = head[0].length + init[0].length;
          const value = typeOfExpression(d.code.slice(from), d.raw.slice(from));
          if (value) record(name, value);
          pending = [];
          continue;
        }
        pending.push(name);
      }
    }
  }
  const out: LocalType[] = [];
  for (const local of found.values()) if (local) out.push(local);
  return out;
}

/** The statement split at depth-0 `:` separators (a `:=` named argument is not one). */
function splitStatements(stmt: LogicalLine): Piece[] {
  const out: Piece[] = [];
  const { code, raw } = stmt;
  let depth = 0;
  let start = 0;
  for (let k = 0; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === ":" && depth === 0 && code[k + 1] !== "=") {
      out.push({ code: code.slice(start, k), raw: raw.slice(start, k) });
      start = k + 1;
    }
  }
  out.push({ code: code.slice(start), raw: raw.slice(start) });
  return out;
}

/** Where a `For`/`For Each` declarator ends: before ` In ` / ` = … To`. -1 when it declares no type. */
function forDeclaratorEnd(code: string, from: number): number {
  const m = /^\s*[A-Za-z_]\w*\s+As\s+/i.exec(code.slice(from));
  if (!m) return -1;
  const t = readVbType(code, from + m[0].length);
  return t ? t.end : -1;
}

// ─── Lookups chained into a call ─────────────────────────────────────────────

/**
 * Container lookups and casts chained straight into a member call: the
 * receiver's type is in the expression itself.
 *
 *   sp.GetRequiredService(Of IClock)().NowUtc()        → receiverType IClock
 *   sp.GetRequiredKeyedService(Of INotifier)(Keys.Sms).Send(m)  → + receiverQualifier Keys.Sms
 *   CType(sp.GetService(GetType(IClock)), IClock).NowUtc()      → receiverType IClock
 *
 * The call patterns run on lines whose string literals are blanked, so a
 * keyed lookup with a literal key (`("sms")`) cannot be read here and is left
 * alone — calling it unkeyed would name the wrong registration.
 */
export const VB_LOOKUP_CALL_PATTERNS: CallPattern[] = [
  {
    pattern:
      /\b((?:[A-Za-z_]\w*\.)*)(GetRequiredService|GetService|GetRequiredKeyedService|GetKeyedService)\s*\(\s*Of\s+([A-Za-z_][\w.]*(?:\s*\(\s*Of\s+[^()]*\))?)\s*\)\s*(?:\(\s*([A-Za-z_][\w.]*)?\s*\))?\s*\.\s*([A-Za-z_]\w*)\s*\(/i,
    buildName: (m) => {
      const keyed = /Keyed/i.test(m[2]!);
      const key = m[4] ?? "";
      const type = m[3]!.trim();
      const leaf = m[5]!;
      const name = `${m[1]}${m[2]}(Of ${type})(${key}).${leaf}`;
      if (!keyed) return key === "" ? { name, leafName: leaf, receiverType: type } : { name, leafName: leaf };
      // A keyed lookup without a readable key would name the unkeyed registration.
      if (key === "" || /^Nothing$/i.test(key)) return { name, leafName: leaf };
      return { name, leafName: leaf, receiverType: type, receiverQualifier: key };
    },
  },
  {
    pattern:
      /\b(CType|DirectCast|TryCast)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*),\s*([A-Za-z_][\w.]*(?:\s*\(\s*Of\s+[^()]*\))?)\s*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/i,
    buildName: (m) => {
      const leaf = m[4]!;
      return { name: `${m[1]}(${m[2]!.trim()}, ${m[3]!.trim()}).${leaf}`, leafName: leaf, receiverType: m[3]!.trim() };
    },
  },
];

// ─── Injection-point keys ────────────────────────────────────────────────────

/**
 * The service key of a keyed constructor parameter:
 * `<FromKeyedServices("sms")> notifier As INotifier` → `sms`.
 */
export function vbParamQualifier(paramText: string): string | null {
  const m = /<\s*(?:[\w.]+\.)?\[?FromKeyedServices\]?(?:Attribute)?\s*\(\s*("(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*\)\s*>/i.exec(paramText);
  if (!m) return null;
  const arg = m[1]!;
  return arg.startsWith('"') ? arg.slice(1, -1).replace(/""/g, '"') : arg;
}
