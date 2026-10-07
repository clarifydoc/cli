import type { DiBinding, FunctionInfo, PropertyInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";
import { blankStringLiterals } from "../shared/regex-base.js";

/**
 * Dependency injection as Swift code spells it — Swinject, Resolver and
 * Factory registrations, the property wrappers that inject by key, and the
 * container lookups that type a local or a chained call. Facts only: the
 * linker decides which implementation a call reaches (see `DiBinding`).
 */

// ─── Text helpers ──────────────────────────────────────────────────────────

/**
 * A line with string contents and the trailing `//` comment blanked, same
 * length — structure is read from this copy, string values from the raw line
 * at the same columns.
 */
function codeOf(line: string): string {
  const code = blankStringLiterals(line);
  const comment = code.indexOf("//");
  return comment < 0 ? code : code.slice(0, comment) + " ".repeat(code.length - comment);
}

/** Index just past the bracket that closes the one at `open`, or -1. */
function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[code[open]!];
  if (!want) return -1;
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") stack.push(pairs[c]!);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Up to `span` lines from `i`, raw and code-only, joined so their columns align. */
function window(lines: string[], i: number, span = 40): { raw: string; code: string } {
  const slice = lines.slice(i, Math.min(lines.length, i + span));
  return { raw: slice.join("\n"), code: slice.map(codeOf).join("\n") };
}

function skipSpace(code: string, k: number): number {
  while (k < code.length && /\s/.test(code[k]!)) k++;
  return k;
}

/** Split argument text at depth-0 commas, keeping raw and code copies aligned. */
function splitArgs(code: string, raw: string): Array<{ code: string; raw: string }> {
  const out: Array<{ code: string; raw: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === "," && depth === 0)) {
      if (code.slice(start, i).trim()) out.push({ code: code.slice(start, i), raw: raw.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

/** `Repo<User>` / `App.Repo` / `(any Repo)` → `Repo`. */
function bareType(t: string): string {
  return t.replace(/^\(\s*|\s*\)$/g, "").replace(/^(?:any|some)\s+/, "").replace(/<.*$/s, "").trim().split(".").pop() ?? "";
}

/** A metatype argument `UserRepo.self` / `(any UserRepo).self` → `UserRepo`. */
function metatype(arg: string): string | null {
  const m = arg.match(/^\s*(\(\s*(?:any\s+)?[A-Z][\w.]*(?:<[^()]*>)?\s*\)|[A-Z][\w.]*(?:<[^()]*>)?)\s*\.self\s*$/);
  return m ? bareType(m[1]!) || null : null;
}

/** A registration name: `"mem"` → mem, `.mem` → mem, anything else as written. */
function nameValue(raw: string): string {
  const t = raw.trim();
  const str = t.match(/^"([^"]*)"$/);
  if (str) return str[1]!;
  const member = t.match(/^\.(\w+)$/);
  if (member) return member[1]!;
  return t.replace(/\s+/g, " ");
}

/** Labelled arguments (`name: "x"`) and positional ones, in order. */
function readArgs(code: string, raw: string): { positional: string[]; labelled: Map<string, { code: string; raw: string }> } {
  const positional: string[] = [];
  const labelled = new Map<string, { code: string; raw: string }>();
  for (const a of splitArgs(code, raw)) {
    const label = a.code.match(/^\s*([a-zA-Z_]\w*)\s*:(?!:)/);
    if (label) {
      const cut = label[0].length;
      labelled.set(label[1]!, { code: a.code.slice(cut), raw: a.raw.slice(cut) });
    } else positional.push(a.code);
  }
  return { positional, labelled };
}

/**
 * What a factory closure body returns when it is ONE construction —
 * `{ _ in PgRepo() }`, `{ r in PgRepo(db: r.resolve(Db.self)!) }`,
 * `{ PgRepo() as UserRepo }` (Resolver's cast names the service) — or null
 * for anything else (a statement list, a shared instance, a helper call).
 */
export function closureProduct(body: string): { impl: string; cast: string | null } | null {
  let text = body.replace(/^\s*(?:\[[^\]]*\]\s*)?(?:\([^()]*\)|[\w\s,]+?)\s+in\b/, "");
  text = text.replace(/^\s*return\b/, "");
  return constructionOf(text);
}

/** `PgRepo(…)` / `PgRepo.init(…)` / `Repo<User>(…)`, optionally `as I`, and nothing else. */
function constructionOf(text: string): { impl: string; cast: string | null } | null {
  const head = text.match(/^\s*([A-Z]\w*(?:\.[A-Z]\w*)*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*(?:\.init\s*)?\(/);
  if (!head) return null;
  const end = closeOf(text, head[0].length - 1);
  if (end < 0) return null;
  const rest = text.slice(end).replace(/^\s*!/, "");
  const cast = rest.match(/^\s*as\s+((?:any\s+)?[A-Z][\w.]*(?:<[^<>]*>)?)\s*;?\s*$/);
  if (!cast && rest.replace(/;/g, "").trim() !== "") return null;
  return { impl: bareType(head[1]!), cast: cast ? bareType(cast[1]!) : null };
}

// ─── Registrations ─────────────────────────────────────────────────────────

/** `.implements(I.self, name: …)` / `.onTest { … }` and friends after a registration. */
interface Modifier {
  name: string;
  args: { code: string; raw: string } | null;
  closure: string | null;
}

/** The `.modifier(…) { … }` chain starting at `k` (after a call's closing bracket). */
function modifierChain(code: string, raw: string, k: number): Modifier[] {
  const out: Modifier[] = [];
  for (;;) {
    let j = skipSpace(code, k);
    const m = code.slice(j).match(/^\.\s*([a-zA-Z_]\w*)/);
    if (!m) return out;
    j += m[0].length;
    const mod: Modifier = { name: m[1]!, args: null, closure: null };
    let n = skipSpace(code, j);
    if (code[n] === "(") {
      const end = closeOf(code, n);
      if (end < 0) return out;
      mod.args = { code: code.slice(n + 1, end - 1), raw: raw.slice(n + 1, end - 1) };
      j = end;
      n = skipSpace(code, j);
    }
    if (code[n] === "{") {
      const end = closeOf(code, n);
      if (end < 0) return out;
      mod.closure = code.slice(n + 1, end - 1);
      j = end;
    }
    out.push(mod);
    k = j;
  }
}

/** Factory context overrides (`.onTest { Mock() }`): another implementation of the same key. */
const FACTORY_CONTEXT_RE = /^(?:on[A-Z]\w*|context)$/;

/**
 * Swinject `container.register(UserRepo.self[, name: "x"]) { _ in PgRepo() }`
 * and Resolver `register { PgRepo() as UserRepo }` / `register(UserRepo.self)
 * { PgRepo() }` / `register { PgRepo() }.implements(UserRepo.self)` — one
 * grammar: the service is the metatype argument, else the closure's cast;
 * `.implements` adds services; a `name:` makes the registration reachable by
 * that name only.
 */
function registerBindings(lines: string[], i: number, at: number, out: DiBinding[]): void {
  const { raw, code } = window(lines, i);
  const prefix = code.slice(0, at);
  let k = skipSpace(code, at + "register".length);
  // A declaration (`func register(`) or a Factory key's runtime override
  // (`Container.shared.repo.register {` — read by `factoryBindings`) is no
  // registration of this kind.
  if (/\bfunc\s+$/.test(prefix)) return;
  if (code[k] === "{" && /(?:[A-Z]\w*)?Container\s*(?:\.\s*shared\s*)?\.\s*\w+\s*\.\s*$/.test(prefix)) return;
  let args: { code: string; raw: string } | null = null;
  if (code[k] === "(") {
    const end = closeOf(code, k);
    if (end < 0) return;
    args = { code: code.slice(k + 1, end - 1), raw: raw.slice(k + 1, end - 1) };
    k = skipSpace(code, end);
  }
  let closure: string | null = null;
  if (code[k] === "{") {
    const end = closeOf(code, k);
    if (end < 0) return;
    closure = code.slice(k + 1, end - 1);
    k = end;
  }
  const { positional, labelled } = args ? readArgs(args.code, args.raw) : { positional: [], labelled: new Map() };
  // Only the container's own labels — `tableView.register(Cell.self,
  // forCellReuseIdentifier:)` is UIKit, not DI.
  for (const label of labelled.keys()) if (label !== "name" && label !== "factory") return;
  if (closure === null) {
    const factory = labelled.get("factory")?.code.trim();
    if (factory?.startsWith("{") && factory.endsWith("}")) closure = factory.slice(1, -1);
  }
  if (closure === null || positional.length > 1) return;
  const product = closureProduct(closure);
  if (!product) return;

  const line = i + 1;
  const name = labelled.get("name");
  const qualifier = name ? nameValue(name.raw) : undefined;
  const explicit = positional[0] !== undefined ? metatype(positional[0]) : null;
  if (positional[0] !== undefined && !explicit) return;
  const service = explicit ?? product.cast;
  const push = (svc: string, q: string | undefined, via: string): void => {
    if (svc === product.impl && !q) return;
    const b: DiBinding = { service: svc, implementation: product.impl, line, via };
    if (q) {
      b.qualifier = q;
      b.keyedOnly = true;
    }
    out.push(b);
  };
  if (service) push(service, qualifier, "register");
  for (const mod of modifierChain(code, raw, k)) {
    if (mod.name !== "implements" || !mod.args) continue;
    const a = readArgs(mod.args.code, mod.args.raw);
    const svc = a.positional[0] ? metatype(a.positional[0]) : null;
    const n = a.labelled.get("name");
    if (svc) push(svc, n ? nameValue(n.raw) : undefined, "implements");
  }
}

/** SwinjectAutoregistration `container.autoregister(UserRepo.self, initializer: PgRepo.init)`. */
function autoregisterBinding(lines: string[], i: number, at: number, out: DiBinding[]): void {
  const { raw, code } = window(lines, i, 8);
  const open = skipSpace(code, at + "autoregister".length);
  if (code[open] !== "(") return;
  const end = closeOf(code, open);
  if (end < 0) return;
  const { positional, labelled } = readArgs(code.slice(open + 1, end - 1), raw.slice(open + 1, end - 1));
  const service = positional[0] ? metatype(positional[0]) : null;
  const init = labelled.get("initializer")?.code.match(/^\s*([A-Z][\w.]*?)\s*\.\s*init\b/);
  if (!service || !init) return;
  const impl = bareType(init[1]!);
  const name = labelled.get("name");
  if (impl === service && !name) return;
  const b: DiBinding = { service, implementation: impl, line: i + 1, via: "autoregister" };
  if (name) {
    b.qualifier = nameValue(name.raw);
    b.keyedOnly = true;
  }
  out.push(b);
}

/**
 * The implementations a Factory definition produces: the `self { … }` /
 * `Factory(self) { … }` closure, plus each context override (`.onTest { … }`)
 * — an environment switch the linker must see to refuse a choice.
 */
function factoryProducts(code: string): string[] {
  const opener = code.match(/(?:^|[^\w.])self\s*\{|\(\s*self\s*(?:,[^()]*)?\)\s*\{/);
  if (!opener) return [];
  const open = (opener.index ?? 0) + opener[0].length - 1;
  const end = closeOf(code, open);
  if (end < 0) return [];
  const impls: string[] = [];
  const main = closureProduct(code.slice(open + 1, end - 1));
  if (!main) return [];
  impls.push(main.impl);
  for (const mod of modifierChain(code, code, end)) {
    if (!FACTORY_CONTEXT_RE.test(mod.name) || mod.closure === null) continue;
    const alt = closureProduct(mod.closure);
    if (alt) impls.push(alt.impl);
  }
  return impls;
}

/**
 * Factory keys: `var userRepo: Factory<UserRepo> { self { PgRepo() } }`
 * (Factory 2, in a `Container` extension), `static let userRepo =
 * Factory<UserRepo> { PgRepo() }` (Factory 1), and runtime overrides
 * `Container.shared.userRepo.register { MockRepo() }`. The key path is the
 * service — `@Injected(\.userRepo)` and `Container.shared.userRepo()` ask
 * for it by that name — so each binding is keyed only.
 */
function factoryBindings(lines: string[], i: number, out: DiBinding[]): void {
  const line = codeOf(lines[i]!);
  const push = (key: string, impl: string): void => {
    out.push({ service: key, implementation: impl, line: i + 1, via: "Factory", keyedOnly: true });
  };
  const computed = line.match(/\bvar\s+([a-zA-Z_]\w*)\s*:\s*(?:Parameter)?Factory\s*</);
  if (computed) {
    const { code } = window(lines, i, 20);
    const open = code.indexOf("{", computed.index! + computed[0].length);
    const end = open < 0 ? -1 : closeOf(code, open);
    if (end < 0) return;
    for (const impl of factoryProducts(code.slice(open + 1, end - 1))) push(computed[1]!, impl);
    return;
  }
  const stored = line.match(/\b(?:let|var)\s+([a-zA-Z_]\w*)\s*=\s*(?:Parameter)?Factory\s*</);
  if (stored) {
    const { code } = window(lines, i, 20);
    const rest = code.slice(stored.index! + stored[0].length - 1);
    // `Factory<I>(scope: .singleton) { … }` — the closure follows the type
    // and an optional argument list.
    const head = rest.match(/^<[^{}]*?>\s*(?:\([^(){}]*\)\s*)?\{/);
    if (!head) return;
    const body = rest.slice(head[0].length - 1);
    const end = closeOf(body, 0);
    if (end < 0) return;
    const product = closureProduct(body.slice(1, end - 1));
    if (product) push(stored[1]!, product.impl);
    return;
  }
  const override = line.match(/\b(?:[A-Z]\w*)?Container\s*(?:\.\s*shared\s*)?\.\s*([a-zA-Z_]\w*)\s*\.\s*register\s*\{/);
  if (override) {
    const { code } = window(lines, i, 20);
    const open = override.index! + override[0].length - 1;
    const end = closeOf(code, open);
    if (end < 0) return;
    const product = closureProduct(code.slice(open + 1, end - 1));
    if (product) push(override[1]!, product.impl);
  }
}

/** Every container registration in a Swift file → `FileAnalysis.diBindings`. */
export function extractSwiftDiBindings(lines: string[]): DiBinding[] {
  const out: DiBinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Cheap gate: every form names one of these words.
    if (!raw.includes("register") && !raw.includes("Factory")) continue;
    const code = codeOf(raw);
    if (code.trimStart().startsWith("//")) continue;
    for (const m of code.matchAll(/(?<![\w])(register|autoregister)\s*[({]/g)) {
      if (m[1] === "register") registerBindings(lines, i, m.index!, out);
      else autoregisterBinding(lines, i, m.index!, out);
    }
    if (code.includes("Factory") || /\.\s*register\s*\{/.test(code)) factoryBindings(lines, i, out);
  }
  return out;
}

// ─── Injection points ──────────────────────────────────────────────────────

/** Property wrappers that inject (Factory, Resolver). */
const INJECTING_WRAPPERS = new Set([
  "Injected", "LazyInjected", "WeakLazyInjected", "OptionalInjected", "InjectedObject", "InjectedObservable",
]);

/**
 * The key an injecting wrapper names: Factory key paths `\.userRepo` /
 * `\Container.userRepo`, Factory 1 `Container.userRepo`, Resolver
 * `name: "mem"` / `name: .mem`. Null when it injects by type alone.
 */
export function wrapperQualifier(decorators: readonly string[] | undefined): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(\w+)\s*\((.*)\)\s*$/s);
    if (!m || !INJECTING_WRAPPERS.has(m[1]!)) continue;
    const args = m[2]!.trim();
    const keyPath = args.match(/^\\(?:[A-Z]\w*)?\.([a-zA-Z_]\w*)\s*(?:,|$)/);
    if (keyPath) return keyPath[1]!;
    const staticKey = args.match(/^[A-Z]\w*\.([a-zA-Z_]\w*)\s*(?:,|$)/);
    if (staticKey) return staticKey[1]!;
    const named = lookupName(args);
    if (named) return named;
  }
  return null;
}

/**
 * `name: "x"` / `name: .x` among a lookup's arguments — or the name
 * expression as written, which then only matches a registration spelling it
 * the same way (never the unnamed one).
 */
function lookupName(args: string): string | undefined {
  const m = args.match(/\bname\s*:\s*([^,()]+)/);
  return m ? nameValue(m[1]!) : undefined;
}

/**
 * What an initializer expression evaluates to, when the source states it:
 * a construction (`PgRepo()`), a container lookup (`container.resolve(
 * UserRepo.self)!`, `Resolver.resolve(UserRepo.self, name: "mem")`,
 * `container ~> UserRepo.self`), a Factory key (`Container.shared.userRepo()`
 * — keyed, no type), or a cast (`… as! UserRepo`).
 */
export function initializerType(rhs: string): { type: string; qualifier?: string } | null {
  const text = rhs.replace(/\/\/.*$/, "").replace(/^\s*(?:try[?!]?\s+)?(?:await\s+)?/, "").trim();
  const cast = text.match(/\bas[!?]?\s+((?:any\s+)?[A-Z][\w.]*(?:<[^<>]*>)?)\s*$/);
  if (cast) return { type: cast[1]! };
  const lookup = text.match(/^[A-Za-z_][\w.]*\s*\.\s*(?:resolve|optional)\s*\(\s*(\(\s*(?:any\s+)?[A-Z][\w.]*(?:<[^()]*>)?\s*\)|[A-Z][\w.]*(?:<[^()]*>)?)\s*\.self\s*(,[^()]*)?\)\s*[!?]?\s*(?:\?\?.*)?$/);
  if (lookup) {
    const out: { type: string; qualifier?: string } = { type: lookup[1]!.replace(/^\(\s*|\s*\)$/g, "") };
    const q = lookup[2] ? lookupName(lookup[2]) : undefined;
    if (q) out.qualifier = q;
    return out;
  }
  const arrow = text.match(/^[A-Za-z_][\w.]*\s*~>\s*\(?\s*([A-Z][\w.]*(?:<[^()]*>)?)\.self\s*(,[^()]*)?\)?\s*$/);
  if (arrow) {
    const out: { type: string; qualifier?: string } = { type: arrow[1]! };
    const q = arrow[2] ? lookupName(arrow[2]) : undefined;
    if (q) out.qualifier = q;
    return out;
  }
  const factory = text.match(/^(?:[A-Z]\w*)?Container\s*(?:\.\s*shared\s*)?\.\s*([a-zA-Z_]\w*)\s*(?:\([^()]*\)|\.\s*resolve\s*\(\s*\))\s*$/);
  if (factory) return { type: "", qualifier: factory[1]! };
  const built = constructionOf(text);
  if (built && !built.cast) {
    // Keep generic arguments as written (`Repo<User>`); the linker strips them.
    const head = text.match(/^([A-Z][\w.]*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?)/);
    return { type: head ? head[1]! : built.impl };
  }
  return null;
}

/** A qualifier a typed member's own initializer adds: `let r: Repo = container.resolve(Repo.self, name: "x")!`. */
export function initializerQualifier(rhs: string): string | undefined {
  if (!/\b(?:resolve|optional)\s*\(/.test(rhs)) return undefined;
  return lookupName(rhs);
}

/**
 * The statements of one body line, raw and without its trailing comment:
 * split at top-level `;`, a one-line body's own braces dropped —
 * `{ val r = new PgRepo(); r.find(1) }` holds two.
 */
function statementsOf(line: string): string[] {
  const cut = blankStringLiterals(line).indexOf("//");
  let src = cut < 0 ? line : line.slice(0, cut);
  const open = src.match(/^\s*\{/);
  if (open) {
    src = " ".repeat(open[0].length) + src.slice(open[0].length);
    const close = src.lastIndexOf("}");
    if (close >= 0 && src.slice(close + 1).trim() === "") src = src.slice(0, close);
  }
  const code = blankStringLiterals(src);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === ";" && depth === 0)) {
      const part = src.slice(start, i);
      if (part.trim()) out.push(part);
      start = i + 1;
    }
  }
  return out;
}

/**
 * Does the statement ending on line `i` continue on the next code line — a
 * wrapped method chain or operator (`let h = Pipeline()` / `.addHandler(r)`)?
 * Then its first line does not state the value's type.
 */
export function continuedBelow(lines: readonly string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (t === "" || t.startsWith("//")) continue;
    return /^(?:\.|\?\?|\?|:|&&|\|\||[+\-*\/%](?!\/)|as\b|match\b)/.test(t);
  }
  return false;
}

/** Each body line's statements, with the line index and whether it is the line's last. */
function statementsWithLine(bodyLines: string[], words: string[]): Array<[number, string, boolean]> {
  const out: Array<[number, string, boolean]> = [];
  bodyLines.forEach((l, i) => {
    if (!words.some((w) => l.includes(w))) return;
    const parts = statementsOf(l);
    parts.forEach((p, k) => out.push([i, p, k === parts.length - 1]));
  });
  return out;
}

const LOCAL_RE = /^\s*(?:(?:if|guard|while)\s+)?(?:let|var)\s+([a-zA-Z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+?))?\s*(?:\belse\s*\{.*|\{\s*)?$/;

/**
 * One entry per name; a name declared again with a different type or key
 * (`let r = PgRepo()` in one branch, `let r = MemRepo()` in another) is
 * dropped — which declaration a call sees is a scoping question a line scan
 * cannot answer.
 */
export function uniqueLocals(entries: NonNullable<FunctionInfo["localTypes"]>): NonNullable<FunctionInfo["localTypes"]> {
  const byName = new Map<string, { name: string; type: string; qualifier?: string } | null>();
  for (const e of entries) {
    const prev = byName.get(e.name);
    if (prev === undefined) byName.set(e.name, e);
    else if (prev && (prev.type !== e.type || prev.qualifier !== e.qualifier)) byName.set(e.name, null);
  }
  return [...byName.values()].filter((e): e is { name: string; type: string; qualifier?: string } => e !== null);
}

/**
 * Locals whose type the body states — `let r: UserRepo = …`, `let r =
 * PgRepo()`, `let r = container.resolve(UserRepo.self)!`, `let r =
 * Container.shared.userRepo()` (keyed) → `FunctionInfo.localTypes`.
 */
export function extractSwiftLocalTypes(bodyLines: string[], _fn: { name: string }): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  for (const [i, statement, last] of statementsWithLine(bodyLines, ["let", "var"])) {
    const m = statement.match(LOCAL_RE);
    if (!m) continue;
    if (last && m[3] && continuedBelow(bodyLines, i)) continue;
    const name = m[1]!;
    const declared = m[2]?.trim();
    if (declared) {
      const entry: { name: string; type: string; qualifier?: string } = { name, type: declared };
      const q = m[3] ? initializerQualifier(m[3]) : undefined;
      if (q) entry.qualifier = q;
      out.push(entry);
      continue;
    }
    const inferred = m[3] ? initializerType(m[3]) : null;
    if (inferred) out.push({ name, ...inferred });
  }
  return uniqueLocals(out);
}

/**
 * Assign the key an injecting wrapper names to each property (own-line
 * wrappers reach `decorators` only after the pattern built the property), and
 * drop the untyped members nothing types — a bare `var x` exists only behind
 * a wrapper, and is useful only when that wrapper names a key.
 */
export function applyInjectionKeys(properties: PropertyInfo[]): PropertyInfo[] {
  for (const p of properties) {
    if (p.qualifier) continue;
    const q = wrapperQualifier(p.decorators);
    if (q) p.qualifier = q;
  }
  return properties.filter((p) => p.type !== null || p.qualifier);
}

// ─── Lookups chained into a call ───────────────────────────────────────────

/**
 * `container.resolve(UserRepo.self)!.find(…)` / `Resolver.resolve(UserRepo.self,
 * name: "mem").load()` and Factory's `Container.shared.userRepo().find()` —
 * the receiver is what the lookup names.
 */
export const swiftDiCallPatterns: CallPattern[] = [
  {
    pattern: /\b([A-Za-z_][\w.]*?)\s*\.\s*(?:resolve|optional)\s*\(\s*((?:any\s+)?[A-Z][\w.]*(?:<[^<>()]*>)?)\s*\.self\s*(,[^()]*)?\)\s*[!?]?\s*\.\s*([a-zA-Z_]\w*)\s*\(/,
    buildName: (m, rawLine) => {
      const type = m[2]!.replace(/^any\s+/, "");
      const name = `${m[1]}.resolve(${type}.self).${m[4]}`;
      const q = m[3] ? lookupName(rawLine?.slice(m.index, m.index + m[0].length) ?? "") : undefined;
      // A name argument that cannot be read must not fall back to the
      // unnamed registration's type.
      if (m[3] && /\bname\s*:/.test(m[3]) && !q) return { name, leafName: m[4]! };
      return q ? { name, leafName: m[4]!, receiverType: type, receiverQualifier: q } : { name, leafName: m[4]!, receiverType: type };
    },
  },
  {
    pattern: /\b((?:[A-Z]\w*)?Container)\s*\.\s*(?:shared\s*\.\s*)?([a-zA-Z_]\w*)\s*\([^()]*\)\s*\.\s*([a-zA-Z_]\w*)\s*\(/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}().${m[3]}`, leafName: m[3]!, receiverQualifier: m[2]! }),
  },
];
