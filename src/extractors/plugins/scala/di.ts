import type { DiBinding, FunctionInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";
import { blankStringLiterals } from "../shared/regex-base.js";

/**
 * Dependency injection as Scala code spells it — Guice / scala-guice / Play
 * module bindings, `@ImplementedBy`, `@Provides` methods, MacWire `wire[…]`,
 * and the injector lookups that type a local or a chained call. Facts only:
 * the linker decides which implementation a call reaches (see `DiBinding`).
 */

// ─── Text helpers ──────────────────────────────────────────────────────────

/** A line with string contents and the trailing `//` comment blanked, same length. */
export function codeOf(line: string): string {
  const code = blankStringLiterals(line);
  const comment = code.indexOf("//");
  return comment < 0 ? code : code.slice(0, comment) + " ".repeat(code.length - comment);
}

/** Index just past the bracket that closes the one at `open`, or -1. */
export function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  if (!pairs[code[open]!]) return -1;
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
export function window(lines: string[], i: number, span = 30): { raw: string; code: string } {
  const slice = lines.slice(i, Math.min(lines.length, i + span));
  return { raw: slice.join("\n"), code: slice.map(codeOf).join("\n") };
}

/** `services.Repo[User]` → `Repo`. */
function bareType(t: string): string {
  return t.trim().replace(/\[.*$/s, "").split(".").pop()!.trim();
}

/** A string literal's contents, or the expression as written. */
function keyValue(raw: string): string {
  const t = raw.trim();
  const str = t.match(/^"([^"]*)"$/);
  return str ? str[1]! : t.replace(/\s+/g, " ");
}

/** A type as written in `[…]` / `classOf[…]`: a (possibly qualified, possibly generic) name. */
const TYPE = String.raw`[A-Za-z_][\w.]*(?:\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\])?`;

// ─── Constructor parameter lists ───────────────────────────────────────────

/**
 * The primary constructor's parameter lists, as raw text: everything in the
 * `(…)` groups after the class name — past type parameters, annotations
 * (`@Inject()`) and an access modifier (`private[app]`). An `implicit` /
 * `using` list holds context, not members, and ends the scan.
 */
export function constructorParamLists(lines: string[], startIdx: number, name: string): string[] {
  const { raw, code } = window(lines, startIdx, 30);
  const at = code.search(new RegExp(String.raw`\b${name}\b`));
  if (at < 0) return [];
  let k = at + name.length;
  const skipSpace = (): void => {
    while (k < code.length && /\s/.test(code[k]!)) k++;
  };
  skipSpace();
  if (code[k] === "[") {
    const end = closeOf(code, k);
    if (end < 0) return [];
    k = end;
    skipSpace();
  }
  for (;;) {
    const ann = code.slice(k).match(/^@[\w.]+/);
    if (ann) {
      k += ann[0].length;
      // An annotation's arguments follow its name directly: `@Inject()`.
      if (code[k] === "(") {
        const end = closeOf(code, k);
        if (end < 0) return [];
        k = end;
      }
      skipSpace();
      continue;
    }
    const access = code.slice(k).match(/^(?:private|protected)(?:\s*\[[^\]]*\])?\s*/);
    if (access) {
      k += access[0].length;
      continue;
    }
    break;
  }
  const lists: string[] = [];
  while (code[k] === "(") {
    const end = closeOf(code, k);
    if (end < 0) break;
    const inner = raw.slice(k + 1, end - 1);
    if (/^\s*(?:implicit|using)\b/.test(inner)) break;
    lists.push(inner);
    k = end;
    skipSpace();
  }
  return lists;
}

/** `@Named("stripe")` / `@Named(value = "x")` among a member's annotations → `stripe`. */
export function namedQualifier(decorators: readonly string[] | undefined): string | undefined {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w.]*\.)?Named\s*\(\s*(?:value\s*=\s*)?([^)]*)\)\s*$/);
    if (m) return keyValue(m[1]!);
  }
  return undefined;
}

// ─── Initializers ──────────────────────────────────────────────────────────

const LOOKUP_RE = new RegExp(
  String.raw`^[A-Za-z_][\w.]*\s*\.\s*(?:instanceOf\s*\[\s*(${TYPE})\s*\]\s*(?:\(\s*\))?|(?:instanceOf|getInstance)\s*\(\s*classOf\s*\[\s*(${TYPE})\s*\]\s*\)|getInstance\s*\(\s*Key\s*\.\s*get\s*\(\s*classOf\s*\[\s*(${TYPE})\s*\]\s*,\s*Names\s*\.\s*named\s*\(([^()]*)\)\s*\)\s*\))$`,
);

/**
 * What an initializer evaluates to, when the source states it: a
 * construction (`new PgRepo(db)`, `new Runnable { … }`), an injector lookup
 * (`injector.instanceOf[Repo]`, `injector.getInstance(classOf[Repo])`, a
 * `Key.get(classOf[Repo], Names.named("x"))` lookup — keyed), MacWire
 * `wire[PgRepo]`, scaldi `inject[Repo]`, `implicitly[Repo]` / `summon[Repo]`,
 * or a cast (`x.asInstanceOf[Repo]`). `Repo(…)` is not read: an `apply` may
 * return anything.
 */
export function scalaInitializerType(rhs: string): { type: string; qualifier?: string } | null {
  const text = rhs.replace(/\/\/.*$/, "").trim();
  const lookup = text.match(LOOKUP_RE);
  if (lookup) {
    const out: { type: string; qualifier?: string } = { type: (lookup[1] ?? lookup[2] ?? lookup[3])! };
    if (lookup[4] !== undefined) out.qualifier = keyValue(lookup[4]);
    return out;
  }
  const typed = text.match(new RegExp(String.raw`^(?:wire|inject|implicitly|summon)\s*\[\s*(${TYPE})\s*\]\s*$`));
  if (typed) return { type: typed[1]! };
  const cast = text.match(new RegExp(String.raw`\.asInstanceOf\s*\[\s*(${TYPE})\s*\]\s*$`));
  if (cast) return { type: cast[1]! };
  const built = text.match(new RegExp(String.raw`^new\s+(${TYPE})`));
  if (built) {
    const code = codeOf(text);
    let k = built[0].length;
    // Argument lists, then an optional anonymous body (left open on this line).
    for (;;) {
      while (/\s/.test(code[k] ?? "")) k++;
      if (code[k] !== "(") break;
      const end = closeOf(code, k);
      if (end < 0) return null;
      k = end;
    }
    const rest = code.slice(k).trim();
    if (rest === "" || rest.startsWith("{") || /^with\b/.test(rest)) return { type: built[1]! };
  }
  return null;
}

/** One entry per name; a name declared again with a different type or key is dropped. */
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

const LOCAL_RE = /^\s*(?:(?:lazy|implicit|final)\s+)*(?:val|var)\s+([a-zA-Z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+?))?\s*$/;

/**
 * Locals whose type the body states — `val r: Repo = …`, `val r = new
 * PgRepo()`, `val r = injector.instanceOf[Repo]` → `FunctionInfo.localTypes`.
 */
export function extractScalaLocalTypes(bodyLines: string[], _fn: { name: string }): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  for (const [i, statement, last] of statementsWithLine(bodyLines, ["val", "var"])) {
    const m = statement.match(LOCAL_RE);
    if (!m) continue;
    if (last && m[3] && continuedBelow(bodyLines, i)) continue;
    const declared = m[2]?.trim();
    if (declared) {
      const entry: { name: string; type: string; qualifier?: string } = { name: m[1]!, type: declared };
      const q = m[3] ? scalaInitializerType(m[3])?.qualifier : undefined;
      if (q) entry.qualifier = q;
      out.push(entry);
      continue;
    }
    const inferred = m[3] ? scalaInitializerType(m[3]) : null;
    if (inferred) out.push({ name: m[1]!, ...inferred });
  }
  return uniqueLocals(out);
}

// ─── Registrations ─────────────────────────────────────────────────────────

interface ChainCall {
  name: string;
  typeArg: string | null;
  args: { code: string; raw: string } | null;
}

/** The `.method[T](args)` chain starting at `k`. */
function chainFrom(code: string, raw: string, k: number): ChainCall[] {
  const out: ChainCall[] = [];
  for (;;) {
    const m = code.slice(k).match(/^\s*\.\s*([a-zA-Z_]\w*)\s*/);
    if (!m) return out;
    k += m[0].length;
    const call: ChainCall = { name: m[1]!, typeArg: null, args: null };
    if (code[k] === "[") {
      const end = closeOf(code, k);
      if (end < 0) return out;
      call.typeArg = code.slice(k + 1, end - 1).trim();
      k = end;
      while (/[ \t]/.test(code[k] ?? "")) k++;
    }
    if (code[k] === "(") {
      const end = closeOf(code, k);
      if (end < 0) return out;
      call.args = { code: code.slice(k + 1, end - 1), raw: raw.slice(k + 1, end - 1) };
      k = end;
    }
    out.push(call);
  }
}

/** `classOf[Impl]` → Impl. */
function classOfArg(args: string): string | null {
  const m = args.match(new RegExp(String.raw`^\s*classOf\s*\[\s*(${TYPE})\s*\]\s*$`));
  return m ? bareType(m[1]!) : null;
}

/** `new Impl(…)` as a whole argument → Impl. */
function constructedArg(args: string): string | null {
  const t = scalaInitializerType(args);
  return t && /^\s*new\b/.test(args) ? bareType(t.type) : null;
}

/**
 * Guice `bind(classOf[I]).to(classOf[Impl])`, scala-guice / Play
 * `bind[I].to[Impl]`, `.toInstance(new Impl(…))`; `annotatedWith(Names.named
 * ("x"))` / `annotatedWithName("x")` / `qualifiedWith("x")` key it.
 */
function guiceBind(lines: string[], i: number, at: number): DiBinding | null {
  const { raw, code } = window(lines, i, 12);
  const head = code.slice(at).match(new RegExp(String.raw`^bind\s*(?:\[\s*(${TYPE})\s*\]|\(\s*classOf\s*\[\s*(${TYPE})\s*\]\s*\))`));
  if (!head) return null;
  const service = bareType((head[1] ?? head[2])!);
  let impl: string | null = null;
  let qualifier: string | undefined;
  for (const c of chainFrom(code, raw, at + head[0].length)) {
    if (c.name === "to") impl = c.typeArg ? bareType(c.typeArg) : c.args ? classOfArg(c.args.code) ?? constructedArg(c.args.raw) : null;
    else if (c.name === "toInstance" && c.args) impl = constructedArg(c.args.raw);
    else if (c.name === "annotatedWithName" || (c.name === "qualifiedWith" && !c.typeArg)) {
      if (c.args) qualifier = keyValue(c.args.raw);
    } else if (c.name === "annotatedWith" && c.args) {
      const named = c.args.raw.match(/Names\s*\.\s*named\s*\(([^()]*)\)/);
      qualifier = named ? keyValue(named[1]!) : c.args.raw.trim();
    }
  }
  if (!impl || (impl === service && !qualifier)) return null;
  const b: DiBinding = { service, implementation: impl, line: i + 1, via: "bind" };
  if (qualifier) {
    b.qualifier = qualifier;
    b.keyedOnly = true;
  }
  return b;
}

/** The annotations on the lines directly above `i` and leading line `i`, joined. */
function annotationsAt(lines: string[], i: number): string {
  const parts: string[] = [];
  for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
    const t = lines[j]!.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (!t.startsWith("@")) break;
    parts.unshift(t);
  }
  parts.push(lines[i]!.match(/^\s*((?:@[\w.]+(?:\([^)]*\))?\s*)*)/)?.[1] ?? "");
  return parts.join(" ");
}

/** `@ImplementedBy(classOf[Impl]) trait I` → {I → Impl}, a default any real binding overrides. */
function implementedBy(lines: string[], i: number, name: string): DiBinding | null {
  const m = annotationsAt(lines, i).match(new RegExp(String.raw`@(?:[\w.]*\.)?ImplementedBy\s*\(\s*classOf\s*\[\s*(${TYPE})\s*\]\s*\)`));
  if (!m) return null;
  const impl = bareType(m[1]!);
  return impl === name ? null : { service: name, implementation: impl, line: i + 1, via: "@ImplementedBy", ifAbsent: true };
}

/**
 * A Guice provider method `@Provides def repo(db: Db): UserRepo = new
 * PgRepo(db)` → {UserRepo → PgRepo} (keyed by its `@Named`), and a MacWire
 * binding `lazy val repo: UserRepo = wire[PgRepo]` → {UserRepo → PgRepo}.
 */
function declaredFactory(lines: string[], i: number): DiBinding | null {
  const code = codeOf(lines[i]!);
  const wire = code.match(new RegExp(String.raw`^\s*(?:(?:private|protected|override|lazy|final|implicit)\s+)*val\s+\w+\s*:\s*(${TYPE})\s*=\s*wire\s*\[\s*(${TYPE})\s*\]\s*$`));
  if (wire) {
    const service = bareType(wire[1]!);
    const impl = bareType(wire[2]!);
    return service === impl ? null : { service, implementation: impl, line: i + 1, via: "wire" };
  }
  const annotations = annotationsAt(lines, i);
  if (!/@(?:[\w.]*\.)?Provides\b/.test(annotations)) return null;
  const def = code.match(new RegExp(String.raw`\bdef\s+\w+\s*(?:\[[^\]]*\])?\s*(?:\([^)]*\)\s*)*:\s*(${TYPE})\s*=\s*(.*)$`));
  if (!def) return null;
  // The body: the rest of the line, or the next line for `= {` / a wrapped `=`.
  let body = lines[i]!.slice(def.index! + def[0].length - def[2]!.length).trim();
  if (body === "" || body === "{") body = (lines[i + 1] ?? "").trim();
  const impl = /^new\b/.test(body) ? constructedArg(body.replace(/\s*}\s*$/, "")) : null;
  const service = bareType(def[1]!);
  if (!impl) return null;
  const qualifier = namedQualifier([...annotations.matchAll(/@([\w.]+(?:\([^)]*\))?)/g)].map((a) => a[1]!));
  if (impl === service && !qualifier) return null;
  const b: DiBinding = { service, implementation: impl, line: i + 1, via: "@Provides" };
  if (qualifier) {
    b.qualifier = qualifier;
    b.keyedOnly = true;
  }
  return b;
}

const TRAIT_OR_CLASS_RE = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:sealed|abstract|private|protected|final)\s+)*(?:trait|class)\s+([A-Z]\w*)/;

/** Every container registration in a Scala file → `FileAnalysis.diBindings`. */
export function extractScalaDiBindings(lines: string[]): DiBinding[] {
  const out: DiBinding[] = [];
  const push = (b: DiBinding | null): void => {
    if (b) out.push(b);
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trimStart().startsWith("//")) continue;
    const code = codeOf(raw);
    if (code.includes("bind")) {
      for (const m of code.matchAll(/(?<![\w.])bind\s*[[(]/g)) push(guiceBind(lines, i, m.index!));
    }
    if (code.includes("wire") || code.includes("def ")) push(declaredFactory(lines, i));
    const decl = code.match(TRAIT_OR_CLASS_RE);
    if (decl && (code.includes("ImplementedBy") || (lines[i - 1] ?? "").includes("ImplementedBy") || (lines[i - 2] ?? "").includes("ImplementedBy"))) {
      push(implementedBy(lines, i, decl[1]!));
    }
  }
  return out;
}

// ─── Lookups chained into a call ───────────────────────────────────────────

/**
 * `injector.instanceOf[Repo].find(…)`, `injector.instanceOf(classOf[Repo])
 * .find(…)`, `injector.getInstance(classOf[Repo]).find(…)` — the receiver is
 * what the lookup names. A paren-less call (`….loadAll`) is invisible to the
 * call scan and stays so.
 */
export const scalaDiCallPatterns: CallPattern[] = [
  {
    pattern: new RegExp(String.raw`\b([A-Za-z_]\w*)\s*\.\s*instanceOf\s*\[\s*(${TYPE})\s*\]\s*(?:\(\s*\))?\s*\.\s*([a-zA-Z_]\w*)\s*\(`),
    buildName: (m) => ({ name: `${m[1]}.instanceOf[${m[2]}].${m[3]}`, leafName: m[3]!, receiverType: m[2]! }),
  },
  {
    pattern: new RegExp(String.raw`\b([A-Za-z_]\w*)\s*\.\s*(instanceOf|getInstance)\s*\(\s*classOf\s*\[\s*(${TYPE})\s*\]\s*\)\s*\.\s*([a-zA-Z_]\w*)\s*\(`),
    buildName: (m) => ({ name: `${m[1]}.${m[2]}(classOf[${m[3]}]).${m[4]}`, leafName: m[4]!, receiverType: m[3]! }),
  },
];
