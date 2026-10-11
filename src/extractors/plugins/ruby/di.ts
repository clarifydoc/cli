import type { CallInfo, ClassInfo, DiBinding, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";
import { blankStringLiterals, findEndLine, splitTopLevel } from "../shared/regex-base.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * Dependency injection as Ruby code spells it. Ruby declares no types, so the
 * facts come from what the source does state:
 *
 *  - a default that constructs (`def initialize(repo: UserRepo.new)`), a YARD
 *    `@param repo [UserRepo]` tag, a Sorbet `sig { params(repo: UserRepo) }`;
 *  - instance variables assigned from such a parameter or a construction
 *    (`@repo = repo`, `@repo = SqlUserRepo.new`) — Ruby call names drop the
 *    `@`, so the property is named `repo`, exactly what `@repo.find` and the
 *    `attr_reader :repo` reader `repo.find` are recorded as;
 *  - dry-container registrations and the dry-auto_inject readers that inject
 *    them by key (`include Import["repos.user_repo"]`);
 *  - container lookups typing a local or a chained call
 *    (`AppContainer[:user_repo].find`), and `UserRepo.new.find`.
 *
 * Facts only — `core/symbol-linker.ts` decides which implementation a call
 * reaches, and refuses when registrations disagree.
 */

export type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** A constant, possibly namespaced: `UserRepo`, `Repos::UserRepo`, `::UserRepo`. */
const CONST = String.raw`(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*`;
/** A constant named like a container: `Container`, `AppContainer`, `MyApp::Container`. */
const CONTAINER_CONST = String.raw`(?:::)?(?:[A-Z]\w*::)*(?:[A-Z]\w*)?Container\b`;

/** `UserRepo.new` / `Repos::UserRepo.new(db)` at the start of `text` → `Repos::UserRepo`. */
export function constructedClass(text: string): string | null {
  const m = new RegExp(String.raw`^(${CONST})\.new\b(?![?!])`).exec(text.trim());
  return m ? m[1]!.replace(/^::/, "") : null;
}

/** `Repos::UserRepo` → `UserRepo`: the bare simple name bindings compare by. */
function bareName(cls: string): string {
  return cls.slice(cls.lastIndexOf(":") + 1);
}

/**
 * A YARD / Sorbet type → annotation-like text: `T.nilable(Repo)` / `[Repo,
 * nil]` → `Repo | nil`, `T.any(A, B)` → `A | B`. Anything else stays as
 * written (core reads `T::Array[X]` as a collection).
 */
export function rubyTypeText(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  const nilable = /^T\.nilable\(\s*([\s\S]+)\s*\)$/.exec(t);
  if (nilable) return `${rubyTypeText(nilable[1]!)} | nil`;
  const any = /^T\.any\(\s*([\s\S]+)\s*\)$/.exec(t);
  if (any) return splitTopLevel(any[1]!).map((p) => rubyTypeText(p) ?? p.trim()).join(" | ");
  // YARD lists alternatives with commas: `[UserRepo, nil]`.
  const parts = splitTopLevel(t).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) t = parts.join(" | ");
  // YARD duck types (`#find`) and literals name no class.
  if (/(?:^|\|\s*)#/.test(t)) return null;
  return t;
}

// ─── Parameters ───────────────────────────────────────────────────────────────

/**
 * One parameter of a `def (...)` list: `repo`, `repo = UserRepo.new`,
 * `repo: UserRepo.new`, `repo:`, `*args`, `**opts`, `&blk`. A default that
 * constructs states the type the method expects (`repo: UserRepo.new`).
 * Splats keep their sigil in the name, as before.
 */
export function parseRubyParam(text: string): ParamInfo | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(?:\*\*?|&)\w*$|^\.\.\.$/.test(t)) return { name: t, type: null, defaultValue: null };
  const m = /^([a-z_]\w*)\s*(?::(?!:)\s*([\s\S]*)|=\s*([\s\S]+))?$/.exec(t);
  if (!m) return null;
  const value = (m[2] ?? m[3])?.trim() || null;
  return { name: m[1]!, type: value ? constructedClass(value) : null, defaultValue: value };
}

/**
 * The declared parameter types above the `def` at 0-based `defIdx`: a Sorbet
 * `sig { params(repo: UserRepo).void }` (single- or multi-line) and YARD
 * `@param repo [UserRepo]` / `@param [UserRepo] repo` tags. Sorbet wins over
 * YARD (it is checked).
 */
export function declaredParamTypes(lines: readonly string[], defIdx: number): Map<string, string> {
  const out = new Map<string, string>();
  const yard = new Map<string, string>();
  let sigText = "";
  // Lines seen below a `sig` start while walking up (a multi-line sig's tail).
  let pending = -1;
  // Walk up over the comments and the sig that sit directly on the `def`.
  for (let i = defIdx - 1; i >= 0 && i >= defIdx - 40; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#")) {
      const p = /^#\s*@param\s+(?:\[([^\]]+)\]\s+(\*{0,2}\w+)|(\*{0,2}\w+)\s+\[([^\]]+)\])/.exec(trimmed);
      if (p) {
        const name = (p[2] ?? p[3])!.replace(/^\*+/, "");
        const type = rubyTypeText(p[1] ?? p[4]!);
        if (type && !yard.has(name)) yard.set(name, type);
      }
      continue;
    }
    if (/^sig\s*(?:\(|\{|do\b)/.test(trimmed)) {
      sigText = lines.slice(i, pending >= 0 ? pending + 1 : i + 1).filter((l) => !l.trim().startsWith("#")).join(" ");
      pending = -1;
      continue;
    }
    // The tail of a multi-line sig: `}`, `end`, `.void`, `params(`, `repo: UserRepo,`.
    if (!sigText && trimmed && /^(?:\}|end\b|\.|\)|params\b|returns\b|void\b|[a-z_]\w*:\s)/.test(trimmed)) {
      if (pending < 0) pending = i;
      continue;
    }
    break;
  }
  if (sigText) {
    const at = sigText.search(/\bparams\s*\(/);
    const body = at >= 0 ? balanced(sigText, sigText.indexOf("(", at)) : null;
    for (const part of body !== null ? splitTopLevel(body) : []) {
      const m = /^\s*([a-z_]\w*):\s*([\s\S]+?)\s*$/.exec(part);
      const type = m ? rubyTypeText(m[2]!) : null;
      if (m && type) out.set(m[1]!, type);
    }
  }
  for (const [name, type] of yard) if (!out.has(name)) out.set(name, type);
  return out;
}

/** The text inside the bracket that opens at `open`, or null when it never closes. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, k);
    }
  }
  return null;
}

/** Apply the Sorbet / YARD types above `fn` to its parameters (a declaration beats a default's type). */
export function applyDeclaredParamTypes(lines: readonly string[], fn: FunctionInfo): void {
  if (fn.params.length === 0) return;
  const declared = declaredParamTypes(lines, fn.line - 1);
  if (declared.size === 0) return;
  for (const p of fn.params) {
    const t = declared.get(p.name.replace(/^\*+|^&/, ""));
    if (t) p.type = t;
  }
}

// ─── What a value is ─────────────────────────────────────────────────────────

interface ValueFact {
  /** "" when only a container key is known. */
  type: string;
  qualifier?: string;
}
const UNKNOWN = "unknown" as const;
const NONE = "none" as const;
type Fact = ValueFact | typeof UNKNOWN | typeof NONE;

/** `:user_repo` / `"repos.user"` / `'x'` → the key text. */
function keyOf(text: string): string | null {
  const m = /^\s*(?::(\w+[?!]?)|"([^"#\s]+)"|'([^'\s]+)')\s*$/.exec(text);
  return m ? (m[1] ?? m[2] ?? m[3])! : null;
}

/**
 * A dry-container lookup: `AppContainer[:user_repo]`, `AppContainer["repos.user"]`,
 * `AppContainer.resolve(:user_repo)` → the key. Only receivers named like a
 * container (`…Container`) — `CONFIG[:x]` is a Hash.
 */
export function containerLookupKey(text: string): string | null {
  const m = new RegExp(String.raw`^(${CONTAINER_CONST})(?:\[([^\]]+)\]|\.resolve\s*\(([^()]+)\))$`).exec(text.trim());
  if (!m) return null;
  return keyOf(m[2] ?? m[3]!);
}

/** What an assigned expression is: a construction, a container lookup, `T.let(x, Type)`, a typed name. */
function valueFact(rhs: string, scope: (name: string) => Fact): Fact {
  const t = rhs.trim().replace(/\s+#.*$/, "");
  if (t === "nil") return NONE;
  const cls = constructedClass(t);
  // Only the construction itself — `UserRepo.new.tap { … }` / `.new(…).build` are other values.
  if (cls && new RegExp(String.raw`^${CONST}\.new\b(?:\s*\([^()]*\))?\s*$`).test(t)) return { type: cls };
  const key = containerLookupKey(t);
  if (key) return { type: "", qualifier: key };
  const tlet = /^T\.let\(\s*([\s\S]+)\)$/.exec(t);
  if (tlet) {
    const parts = splitTopLevel(tlet[1]!);
    const type = parts.length === 2 ? rubyTypeText(parts[1]!) : null;
    return type ? { type } : UNKNOWN;
  }
  if (/^[a-z_]\w*$/.test(t)) return scope(t);
  return UNKNOWN;
}

function sameFact(a: ValueFact, b: ValueFact): boolean {
  return a.type === b.type && (a.qualifier ?? "") === (b.qualifier ?? "");
}

/** Every assignment must state the same thing; one the source does not type leaves the name untyped. */
class FactTable {
  private readonly facts = new Map<string, ValueFact | null>();
  private readonly seen = new Set<string>();
  /** Names in first-assignment order. */
  readonly order: string[] = [];

  assign(name: string, fact: Fact): void {
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.order.push(name);
    }
    if (fact === NONE) return;
    const prev = this.facts.get(name);
    if (fact === UNKNOWN) this.facts.set(name, null);
    else if (prev === undefined) this.facts.set(name, fact);
    else if (prev && !sameFact(prev, fact)) this.facts.set(name, null);
  }

  get(name: string): ValueFact | null {
    return this.facts.get(name) ?? null;
  }
}

function paramFact(p: ParamInfo | undefined): Fact {
  if (!p || (!p.type && !p.qualifier)) return UNKNOWN;
  const fact: ValueFact = { type: p.type ?? "" };
  if (p.qualifier) fact.qualifier = p.qualifier;
  return fact;
}

/** `x = rhs` / `x ||= rhs` — not `==`, `=~`, `=>`, `x += …`. */
const LOCAL_ASSIGN_RE = /^\s*([a-z_]\w*)\s*(?:\|\|)?=(?![=~>])\s*(.+?)\s*$/;
/** `@x = rhs` / `@x ||= rhs`. */
const IVAR_ASSIGN_RE = /^\s*@(\w+)\s*(?:\|\|)?=(?![=~>])\s*(.+?)\s*$/;
/** `@a, @b = a, b`. */
const IVAR_MULTI_RE = /^\s*(@\w+(?:\s*,\s*@\w+)+)\s*=(?![=~>])\s*(.+?)\s*$/;
/** Block parameters `|repo, i|` rebind names. */
const BLOCK_PARAMS_RE = /\|([^|]*)\|/g;

/** A line's code: string contents blanked, trailing `#` comment cut. */
function codeOf(line: string): string {
  const code = blankStringLiterals(line);
  const hash = code.search(/(?:^|\s)#(?!\{)/);
  return hash < 0 ? code : code.slice(0, hash);
}

/**
 * The right-hand side of the assignment whose target ends at column `from`,
 * read from the RAW line (string keys like `C["repos.user"]` survive) up to
 * where the code ends (trailing comment cut). `code` is the same line blanked
 * by `codeOf`, so the columns agree.
 */
function rhsOf(raw: string, code: string, from: number): string {
  const eq = code.indexOf("=", from);
  return eq < 0 ? "" : raw.slice(eq + 1, code.length);
}

/**
 * Locals whose value the body states: `repo = UserRepo.new`, `repo =
 * AppContainer[:user_repo]` (the key; type unknown), `repo = T.let(x,
 * UserRepo)`. A name also assigned something untyped, or rebound as a block
 * parameter, is left out; parameters are never re-typed.
 */
export function extractRubyLocalTypes(bodyLines: readonly string[], fn: { params: readonly ParamInfo[] }): LocalType[] {
  const table = new FactTable();
  const paramNames = new Set(fn.params.map((p) => p.name));
  const scope = (name: string): Fact => {
    if (paramNames.has(name)) return paramFact(fn.params.find((p) => p.name === name));
    return table.get(name) ?? UNKNOWN;
  };
  for (const raw of bodyLines) {
    if (raw.trimStart().startsWith("#")) continue;
    const code = codeOf(raw);
    for (const m of code.matchAll(BLOCK_PARAMS_RE)) {
      for (const n of m[1]!.split(",")) {
        const name = n.trim().replace(/^[*&]+/, "");
        if (/^[a-z_]\w*$/.test(name)) table.assign(name, UNKNOWN);
      }
    }
    const m = LOCAL_ASSIGN_RE.exec(code);
    if (!m) continue;
    table.assign(m[1]!, valueFact(rhsOf(raw, code, code.indexOf(m[1]!) + m[1]!.length), scope));
  }
  const out: LocalType[] = [];
  for (const name of table.order) {
    if (paramNames.has(name)) continue;
    const fact = table.get(name);
    if (!fact) continue;
    const local: LocalType = { name, type: fact.type };
    if (fact.qualifier) local.qualifier = fact.qualifier;
    out.push(local);
  }
  return out;
}

// ─── Classes: instance variables, readers, auto-injection ────────────────────

/** Line ranges (0-based, end exclusive) of the classes/modules nested inside `cls`. */
function nestedRanges(cls: ClassInfo, classes: readonly ClassInfo[]): Array<[number, number]> {
  return classes
    .filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine)
    .map((c) => [c.line - 1, c.endLine] as [number, number]);
}

/**
 * Instance variables a class's own methods assign — `@repo = repo` (the
 * parameter's type), `@repo = SqlUserRepo.new`, `@repo ||= …`, `@repo =
 * T.let(repo, UserRepo)`, `@a, @b = a, b` — as properties named without the
 * `@`. One assignment the source does not type leaves the variable untyped.
 */
export function collectIvarProperties(lines: readonly string[], cls: ClassInfo, classes: readonly ClassInfo[]): PropertyInfo[] {
  const nested = nestedRanges(cls, classes);
  const inNested = (idx: number): boolean => nested.some(([a, b]) => idx >= a && idx < b);
  const singleton = singletonTest(lines, cls);
  const table = new FactTable();
  for (const m of cls.methods) {
    // A singleton method's `@x` is the CLASS's instance variable.
    if (inNested(m.line - 1) || singleton(m)) continue;
    const params = new Map(m.params.map((p) => [p.name, p]));
    const locals = new Map((m.localTypes ?? []).map((l) => [l.name, l]));
    const scope = (name: string): Fact => {
      if (params.has(name)) return paramFact(params.get(name));
      const l = locals.get(name);
      if (!l) return UNKNOWN;
      return l.qualifier ? { type: l.type, qualifier: l.qualifier } : { type: l.type };
    };
    for (let i = m.line; i < Math.min(m.endLine, lines.length); i++) {
      const raw = lines[i]!;
      if (raw.trimStart().startsWith("#") || !raw.includes("@")) continue;
      const code = codeOf(raw);
      const multi = IVAR_MULTI_RE.exec(code);
      if (multi) {
        const names = multi[1]!.split(",").map((n) => n.trim().slice(1));
        const values = splitTopLevel(rhsOf(raw, code, code.indexOf(multi[1]!) + multi[1]!.length));
        names.forEach((n, k) => table.assign(n, values.length === names.length ? valueFact(values[k]!, scope) : UNKNOWN));
        continue;
      }
      const one = IVAR_ASSIGN_RE.exec(code);
      if (!one) continue;
      table.assign(one[1]!, valueFact(rhsOf(raw, code, code.indexOf("@" + one[1]!) + one[1]!.length + 1), scope));
    }
  }
  const out: PropertyInfo[] = [];
  for (const name of table.order) {
    const fact = table.get(name);
    if (!fact) continue;
    const prop: PropertyInfo = { name, type: fact.type || null, visibility: "private", isStatic: false, isReadonly: false };
    if (fact.qualifier) prop.qualifier = fact.qualifier;
    out.push(prop);
  }
  return out;
}

/** `include Import[…]` / `include Deps[…]` / `include MyApp::Import.kwargs[…]`. */
const AUTO_INJECT_RE = new RegExp(String.raw`^\s*include\s+(${CONST})(?:\.(?:kwargs|args|hash))?\s*\[`);

/**
 * dry-auto_inject readers: `include Import["repos.user_repo"]` defines a
 * reader `user_repo` (the key's last segment) holding the container's
 * `repos.user_repo`; `Import[repo: "repos.user"]` names the reader. The type
 * is unknown — the registration decides — so the property carries the key as
 * its `qualifier`.
 */
export function autoInjectProperties(lines: readonly string[], cls: ClassInfo, classes: readonly ClassInfo[]): PropertyInfo[] {
  const nested = nestedRanges(cls, classes);
  const out: PropertyInfo[] = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    if (nested.some(([a, b]) => i >= a && i < b)) continue;
    const m = AUTO_INJECT_RE.exec(lines[i]!);
    if (!m) continue;
    // The argument list may wrap over several lines.
    let text = lines[i]!.slice(m[0].length - 1);
    for (let k = i + 1; balanced(text, 0) === null && k < Math.min(lines.length, i + 30); k++) text += " " + lines[k]!.trim();
    const args = balanced(text, 0);
    if (args === null) continue;
    for (const arg of splitTopLevel(args)) {
      // `repo: "repos.user"` / `:repo => "repos.user"` / `"repo" => "repos.user"` name the reader.
      const alias = /^\s*(?:([a-z_]\w*):|:([a-z_]\w*)\s*=>|(["'])([a-z_]\w*)\3\s*=>)\s*(["'])([^"'\s]+)\5\s*$/.exec(arg);
      let reader: string | null;
      let key: string | null;
      if (alias) {
        reader = (alias[1] ?? alias[2] ?? alias[4])!;
        key = alias[6]!;
      } else {
        key = keyOf(arg);
        reader = key ? key.slice(key.lastIndexOf(".") + 1) : null;
      }
      if (!reader || !key || !/^[a-z_]\w*$/.test(reader)) continue;
      out.push({ name: reader, type: null, visibility: "public", isStatic: false, isReadonly: true, qualifier: key });
    }
  }
  return out;
}

/** True for an `include X[…]` mixin line — a dry-auto_inject import, not a module the class implements. */
export function isAutoInjectInclude(line: string): boolean {
  return AUTO_INJECT_RE.test(line);
}

// ─── Singleton / instance method collisions ──────────────────────────────────

/** Is a method of `cls` a singleton (class) method — `def self.x`, or inside `class << self`? */
function singletonTest(lines: readonly string[], cls: ClassInfo): (m: FunctionInfo) => boolean {
  const eigen: Array<[number, number]> = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    if (/^\s*class\s*<<\s*self\b/.test(lines[i]!)) eigen.push([i, findEndLine(lines as string[], i, "indent")]);
  }
  return (m) => /^\s*def\s+self\./.test(lines[m.line - 1] ?? "") || eigen.some(([a, b]) => m.line - 1 > a && m.line - 1 < b);
}

/**
 * `def self.call` and `def call` in one class are two methods; the function
 * pattern strips `self.`, so both were named `call` and one shadowed the
 * other. On such a collision the singleton method is named `self.call` —
 * `Class.call` stays the instance method, which is what a typed receiver
 * (`@service.call`) reaches. Methods inside `class << self` are singletons too.
 */
export function separateSingletonMethods(lines: readonly string[], cls: ClassInfo): void {
  const isSingleton = singletonTest(lines, cls);
  const instanceNames = new Set(cls.methods.filter((m) => !isSingleton(m)).map((m) => m.name));
  for (const m of cls.methods) {
    if (instanceNames.has(m.name) && isSingleton(m)) m.name = `self.${m.name}`;
  }
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/**
 * Call shapes whose receiver the call itself types, plus the `self.x.y`
 * spelling. Built names line up with the baseline matcher's so the dedup in
 * `extractCallsFromBody` keeps ONE call (these patterns run first and carry
 * the receiver type): `UserRepo.new.find(` is recorded as `new.find` either
 * way, `self.repo.find(` as `repo.find` — the reader `repo`, like `@repo.find`.
 */
export const RUBY_DI_CALL_PATTERNS: CallPattern[] = [
  {
    // `UserRepo.new.find(id)` / `UserRepo.new(db).find` — a member of the
    // object just constructed.
    pattern: new RegExp(String.raw`(?<![\w.@$:])(${CONST})\.new\b(?:\s*\([^()]*\))?\.([a-z_]\w*[?!]?)(?![\w?!])`),
    buildName: (m) => ({ name: `new.${m[2]}`, leafName: m[2]!, receiverType: m[1]!.replace(/^::/, "") }),
  },
  {
    // `AppContainer[:user_repo].find(id)` / `AppContainer.resolve(:user_repo).find`.
    // Symbol keys only: the scanned line has its string literals blanked, so a
    // `["repos.user"]` key is unreadable here (a local reads it from the raw line).
    pattern: new RegExp(String.raw`(?<![\w.@$:])(${CONTAINER_CONST}(?:\[\s*:\w+[?!]?\s*\]|\.resolve\s*\(\s*:\w+[?!]?\s*\)))\.([a-z_]\w*[?!]?)(?![\w?!])`),
    buildName: (m) => ({
      name: `${m[1]}.${m[2]}`,
      leafName: m[2]!,
      receiverType: "",
      receiverQualifier: containerLookupKey(m[1]!) ?? "",
    }),
  },
  {
    // `new(args).call` inside a class — the singleton-method idiom
    // `def self.call(...) = new(...).call`. Typed by the class pass
    // (`typeBareConstructions`), which knows the enclosing class.
    pattern: /(?<![\w.:@$])new\b(?:\s*\([^()]*\))?\.([a-z_]\w*[?!]?)(?![\w?!])/,
    buildName: (m) => ({ name: `new.${m[1]}`, leafName: m[1]! }),
  },
  {
    // `self.repo.find(` calls the reader `repo` — recorded like `repo.find(`.
    pattern: /\bself\.(\w+)\.(\w+[?!]?)\s*\(/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
  },
  {
    // Safe navigation `repo&.find(` is a call on `repo`.
    pattern: /(?<![\w.$])@?(\w+)&\.(\w+[?!]?)\s*\(/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
  },
];

/**
 * `new(...).m` inside a class body constructs the enclosing class: give those
 * calls (recorded by the pattern above, untyped) the class as receiver type.
 * A module has no `new` of its own, so only `class` bodies count.
 */
export function typeBareConstructions(lines: readonly string[], cls: ClassInfo): void {
  if (!/^\s*class\b/.test(lines[cls.line - 1] ?? "")) return;
  for (const m of cls.methods) {
    for (const c of m.calls) {
      if (c.receiverType !== undefined || !c.name.startsWith("new.") || c.column === undefined) continue;
      const line = lines[c.line - 1] ?? "";
      const at = line.indexOf("new", c.column);
      if (at < 0 || (at > 0 && /[\w.:@$]/.test(line[at - 1]!))) continue;
      c.receiverType = cls.name;
    }
  }
}

/**
 * Drop the baseline matcher's reading of `expr.m(` as a bare `m(` — a call on
 * `self` — where `expr` is something it cannot name (`X[:k].m(`, `a(b).m(`,
 * `x&.m(`). Such a call is a member call on another object; recorded bare it
 * links to whatever `m` the enclosing class or file defines. Calls are
 * deduplicated by name, so when the body ALSO calls `m(` bare, the call is
 * moved there instead. In place: the array is the one core restores held
 * calls into.
 */
export function dropDetachedMemberCalls(lines: readonly string[], fn: FunctionInfo): void {
  const calls: CallInfo[] = fn.calls;
  for (let k = calls.length - 1; k >= 0; k--) {
    const c = calls[k]!;
    if (c.name.includes(".") || c.receiverType !== undefined || c.receiverQualifier !== undefined || c.column === undefined) continue;
    const line = lines[c.line - 1];
    if (!line || c.column === 0 || line[c.column - 1] !== "." || !line.startsWith(c.name, c.column)) continue;
    const own = ownBareCall(lines, fn, c.name);
    if (own) {
      c.line = own.line;
      c.column = own.column;
    } else {
      calls.splice(k, 1);
    }
  }
}

/** The first `name(` in the function's own text that is a call on self (not `.name(`). */
function ownBareCall(lines: readonly string[], fn: FunctionInfo, name: string): { line: number; column: number } | null {
  const re = new RegExp(String.raw`(?<![\w.@$:&])${escapeRegex(name)}\s*\(`);
  for (let i = fn.line - 1; i < Math.min(fn.endLine, lines.length); i++) {
    const raw = lines[i]!;
    if (raw.trimStart().startsWith("#")) continue;
    let code = codeOf(raw);
    // The `def name(` line itself declares, it does not call.
    if (i === fn.line - 1) code = code.replace(/^\s*def\s+(?:self\.)?[\w?!]+/, (m) => " ".repeat(m.length));
    const m = re.exec(code);
    if (m) return { line: i + 1, column: m.index };
  }
  return null;
}

// ─── Container registrations ─────────────────────────────────────────────────

/** `register(:key) {…}` / `register "key", X.new` / `X.register(:key) do … end`. */
const REGISTER_RE = /^(\s*)(?:([A-Za-z_][\w:]*)\.)?register\s*\(?\s*(:\w+[?!]?|"[^"#]*"|'[^']*')\s*(.*)$/;
/** `namespace(:repos) do` / `namespace "repos" do |ns|`. */
const NAMESPACE_RE = /^(\s*)(?:[A-Za-z_][\w:]*\.)?namespace\s*\(?\s*(:\w+|"[^"#]*"|'[^']*')\s*\)?\s*do\b/;

/**
 * dry-container registrations → `FileAnalysis.diBindings`: `register(:repo) {
 * SqlUserRepo.new }`, `register("repos.user", SqlUserRepo.new)`, a multi-line
 * `register(:repo) do … end` block whose body is one construction, inside a
 * container (`extend Dry::Container::Mixin`, `< Dry::System::Container`, `X =
 * Dry::Container.new`, or a receiver named `…Container`). `namespace(:repos)`
 * blocks prefix the key (`repos.user`). Keyed only: the key is the token
 * dry-auto_inject and `Container[:key]` name.
 */
export function extractRubyDiBindings(lines: readonly string[]): DiBinding[] {
  const out: DiBinding[] = [];
  if (!lines.some((l) => /\bregister\b/.test(l)) || !lines.some((l) => /Container/.test(l))) return out;

  // Container bodies (bare `register` calls) and container variables.
  const bodies: Array<[number, number]> = [];
  const vars = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const v = /^\s*([A-Za-z_]\w*(?:::[A-Z]\w*)*)\s*=\s*Dry::(?:Container|System::Container)\.new\b/.exec(line);
    if (v) vars.add(v[1]!);
    const decl = /^\s*(?:class|module)\s+[A-Z][\w:]*(\s*<\s*Dry::(?:System::)?Container\b)?/.exec(line);
    if (!decl) continue;
    const end = findEndLine(lines as string[], i, "indent");
    const mixin = decl[1] || lines.slice(i + 1, end).some((l) => /^\s*(?:extend|include)\s+Dry::Container::Mixin\b/.test(l));
    if (mixin) bodies.push([i, end]);
  }
  const inBody = (i: number): boolean => bodies.some(([a, b]) => i > a && i < b);

  const namespaces: Array<{ indent: number; key: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (/^end\b/.test(trimmed)) {
      // An `end` closes the namespace opened at its indentation (and any deeper one left open).
      while (namespaces.length > 0 && namespaces[namespaces.length - 1]!.indent >= indent) {
        if (namespaces.pop()!.indent === indent) break;
      }
      continue;
    }
    while (namespaces.length > 0 && indent <= namespaces[namespaces.length - 1]!.indent) namespaces.pop();
    const ns = NAMESPACE_RE.exec(line);
    if (ns) {
      const key = keyOf(ns[2]!);
      if (key) namespaces.push({ indent, key });
      continue;
    }
    const reg = REGISTER_RE.exec(line);
    if (!reg) continue;
    const recv = reg[2];
    if (recv ? !(vars.has(recv) || /Container$/.test(recv)) : !(inBody(i) || namespaces.length > 0)) continue;
    const key = keyOf(reg[3]!);
    if (!key) continue;
    const impl = registeredClass(lines, i, reg[4]!);
    if (!impl) continue;
    const service = [...namespaces.map((n) => n.key), key].join(".");
    out.push({ service, implementation: bareName(impl), line: i + 1, via: "register", keyedOnly: true });
  }
  return out;
}

/**
 * The class a registration builds, from the text after its key: a second
 * argument `SqlUserRepo.new(…)` / `-> { SqlUserRepo.new }`, a `{ SqlUserRepo.new }`
 * block, or a `do … end` block whose only statement is the construction.
 * `call: false` registers the callable itself, not what it returns.
 */
function registeredClass(lines: readonly string[], i: number, rest: string): string | null {
  if (/\bcall:\s*false\b/.test(rest)) return null;
  const arg = /^,\s*(?:->\s*(?:\(\s*\))?\s*\{\s*|lambda\s*\{\s*|proc\s*\{\s*)?(.*)$/.exec(rest.replace(/^\)\s*/, ""));
  if (arg) {
    const value = arg[1]!.split(/,\s*\w+:\s/)[0]!;
    const cls = constructedClass(value);
    if (cls) return cls;
  }
  // `{ |c| SqlUserRepo.new }` — whatever follows the block (`if ENV["X"]`) is a modifier.
  const open = rest.indexOf("{");
  const block = open >= 0 ? balanced(rest, open) : null;
  if (block !== null) return singleConstruction(block.replace(/^\s*\|[^|]*\|/, ""));
  if (/\bdo\s*(?:\|[^|]*\|)?\s*$/.test(rest)) {
    const end = findEndLine(lines as string[], i, "indent");
    const body = lines.slice(i + 1, end).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (body.length === 0) return null;
    const first = body[0]!;
    const indent = first.length - first.trimStart().length;
    // One statement: whatever follows is the construction's wrapped arguments.
    if (body.slice(1).some((l) => l.length - l.trimStart().length <= indent && !/^\s*[)\]}]/.test(l))) return null;
    return constructedClass(first);
  }
  return null;
}

/** The text is exactly one construction (`SqlUserRepo.new(c[:db])`). */
function singleConstruction(text: string): string | null {
  const t = text.trim();
  return new RegExp(String.raw`^${CONST}\.new\b(?:\s*\(.*\))?$`).test(t) ? constructedClass(t) : null;
}
