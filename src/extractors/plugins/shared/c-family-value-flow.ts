/**
 * How function values travel in a C or C++ file, stated as neutral `ValueFlowFact`s for core's solver
 * (`core/value-flow.ts`): a function pointer or `std::function` assigned, copied, passed on, returned and called; a
 * struct of function pointers filled by designated initializers (`{ .sign = club_sign }`, keyed on the struct TYPE, so
 * a call through any `struct club_ops *` reaches them); arrays of handlers; fields a method or a constructor sets
 * and another method runs; lambdas and `std::bind` held in a variable. The file's text is read statement by
 * statement with comments and strings blanked; nothing is resolved here, a name is stated as written.
 */
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";

/** The cell name core reads as the file's own module binding named by the fact's `member` (`MODULE_CELL` in core/value-flow.ts; the link tests here fail if the two drift). */
const MODULE_CELL = "<module>";

const NOT_A_CALL = new Set([
  "if", "while", "for", "switch", "return", "sizeof", "alignof", "decltype", "catch", "typeof", "defined", "new", "delete", "static_assert",
  "else", "case", "throw", "do", "co_await", "co_return", "co_yield", "noexcept", "typeid", "static_cast", "dynamic_cast", "reinterpret_cast",
  "const_cast", "template", "operator", "__attribute__", "__declspec", "alignas", "_Alignof", "_Static_assert", "assert",
]);
const NOT_A_TYPE = new Set([
  "return", "delete", "throw", "goto", "case", "default", "else", "new", "using", "typedef", "namespace", "template", "public", "private",
  "protected", "friend", "operator", "break", "continue", "do", "if", "while", "for", "switch", "co_return", "co_yield", "co_await", "sizeof",
  "static_assert", "this",
]);
const STORAGE = /\b(?:static|extern|inline|register|volatile|const|constexpr|constinit|thread_local|mutable|struct|union|enum|class|typename|restrict|__restrict)\b/g;
const PRIMITIVES = new Set([
  "void", "bool", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "wchar_t", "size_t", "ssize_t", "ptrdiff_t",
  "intptr_t", "uintptr_t", "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "_Bool", "string", "FILE",
]);
const FN_TYPE = /function|\(\s*[*^]|Callback|Handler|Callable|Delegate|Listener/;
const LITERALS = new Set(["NULL", "nullptr", "true", "false", "this", "TRUE", "FALSE", "nil"]);
/** Words that make a type's name one a callable has (`handler_t`, `ClubCallback`, `sign_fn`). */
const TYPE_WORDS = new Set([
  "cb", "fn", "func", "handler", "callback", "hook", "listener", "action", "proc", "task", "job", "thunk", "visitor", "pred", "predicate",
  "cmp", "compare", "closure", "lambda", "routine", "worker", "notify", "completion", "callable", "function", "delegate", "op",
]);
const wordsOf = (name: string): string[] => name.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\W]+/).filter(Boolean);
/** Member and variable names that read as holding a callable (`on_sign`, `onSave_`, `hook_`). */
const CALLABLE_NAME = { test: (name: string): boolean => wordsOf(name).some((w) => TYPE_WORDS.has(w) || w === "on") };
/** Whether a value declared with `type` may be a function: a function pointer, a `std::function`, `auto`, a typedef named for one. */
const typeCallable = (type: string, fp: boolean, fpTypedefs: ReadonlySet<string>): boolean => {
  if (fp) return true;
  if (/\bstruct\b|\bunion\b|\benum\b/.test(type)) return false;
  if (FN_TYPE.test(type)) return true;
  const key = type.replace(STORAGE, " ").replace(/[*&]/g, " ").trim().split(/\s+/).pop() ?? "";
  return fpTypedefs.has(key) || /^[A-Z]$/.test(key) || wordsOf(key).some((w) => TYPE_WORDS.has(w));
};

interface Decl {
  name: string;
  /** The type as written, storage words and all. */
  type: string;
  fp: boolean;
  array: boolean;
  init: string | null;
  /** `T x{…}`: the brace text. */
  brace: string | null;
}

interface Site {
  /** Offset of the callee's last identifier. */
  leaf: number;
  open: number;
  close: number;
  segs: string[];
  /** `id`: `a.b(…)`; `deref`: `(*a.b)(…)`; `index`: `a.b[i](…)`. */
  form: "id" | "deref" | "index";
  /** A call's result is the head of the chain (`a().b(`). */
  opaque: boolean;
}

const lineIndex = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** `lines` with comments, strings, character literals and preprocessor lines blanked, lines and columns kept. */
function blankCode(lines: readonly string[]): string {
  const src = lines.join("\n");
  const out: string[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" ? "\n" : " ");
  };
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") { out.push(c); i++; lineStart = true; continue; }
    if (lineStart && /\s/.test(c)) { out.push(c); i++; continue; }
    if (lineStart && c === "#") {
      // A preprocessor line, with its continuations.
      let end = i;
      for (;;) {
        const nl = src.indexOf("\n", end);
        if (nl < 0) { end = src.length; break; }
        end = nl;
        if (!/\\\s*$/.test(src.slice(src.lastIndexOf("\n", nl - 1) + 1, nl))) break;
        end = nl + 1;
      }
      blank(i, end);
      i = end;
      continue;
    }
    lineStart = false;
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      i = end;
    } else if (c === "/" && src[i + 1] === "/") {
      let end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
      blank(i, end);
      i = end;
    } else if (c === '"' || (c === "'" && !/[\w]/.test(src[i - 1] ?? ""))) {
      // A string or character literal; a C++ raw string `R"x(…)x"` ends at its delimiter.
      const raw = c === '"' && src[i - 1] === "R" ? /^"([^()\s]{0,16})\(/.exec(src.slice(i, i + 20)) : null;
      let end = i + 1;
      if (raw) {
        const close = src.indexOf(`)${raw[1]}"`, i);
        end = close < 0 ? src.length : close + raw[1]!.length + 2;
      } else {
        while (end < src.length && src[end] !== c && src[end] !== "\n") end += src[end] === "\\" ? 2 : 1;
        end = Math.min(src.length, end + 1);
      }
      out.push(c);
      blank(i + 1, Math.max(i + 1, end - 1));
      if (end - 1 > i) out.push(src[end - 1] === c ? c : src[end - 1]!);
      i = end;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

function matching(text: string, open: number, to: number): number {
  const o = text[open]!;
  const c = o === "(" ? ")" : o === "[" ? "]" : o === "{" ? "}" : ">";
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  return -1;
}

function matchingBack(text: string, close: number, from: number): number {
  const c = text[close]!;
  const o = c === ")" ? "(" : c === "]" ? "[" : "{";
  let depth = 0;
  for (let i = close; i >= from; i--) {
    if (text[i] === c) depth++;
    else if (text[i] === o && --depth === 0) return i;
  }
  return -1;
}

function topLevelCommas(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start).trim() !== "" || out.length > 0) out.push([start, text.length]);
  return out;
}

/** Offsets of the statements in `text[from, to)`; an initializer's or a lambda's braces stay inside one. */
function splitStatements(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = from;
  let paren = 0;
  let hold = 0;
  let eq = false;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (hold > 0) {
      if (c === "{") hold++;
      else if (c === "}") hold--;
      continue;
    }
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
    else if (paren > 0) {
      if (c === "{") hold = 1;
    } else if (c === "=") {
      if (text[i + 1] !== "=" && !"=!<>".includes(text[i - 1] ?? "")) eq = true;
    } else if (c === ";") {
      out.push([start, i]);
      start = i + 1;
      eq = false;
    } else if (c === "{") {
      if (eq) hold = 1;
      else {
        out.push([start, i]);
        start = i + 1;
      }
    } else if (c === "}") {
      out.push([start, i]);
      start = i + 1;
      eq = false;
    }
  }
  if (start < to) out.push([start, to]);
  return out.filter(([a, b]) => text.slice(a, b).trim() !== "");
}

/** How many characters of leading control syntax a statement starts with (`else`, `if (…)`, `case X:`), so the statement proper begins after them. */
function headLength(t: string): number {
  let at = 0;
  for (;;) {
    const rest = t.slice(at);
    const lead = /^\s*/.exec(rest)![0].length;
    const body = rest.slice(lead);
    const kw = /^(?:else\b|do\b)/.exec(body);
    if (kw) {
      at += lead + kw[0].length;
      continue;
    }
    const head = /^(?:if|while|for|switch)\s*(?:constexpr\s*)?\(/.exec(body);
    if (head) {
      const close = matching(body, head[0].length - 1, body.length);
      if (close < 0) return t.length;
      at += lead + close + 1;
      continue;
    }
    const label = /^(?:case\b[^:;]*?:(?!:)|default\s*:(?!:)|[A-Za-z_]\w*\s*:(?!:))/.exec(body);
    if (label && !/^(?:public|private|protected)\b/.test(body)) {
      at += lead + label[0].length;
      continue;
    }
    return at + lead;
  }
}

const FP_DECL = /^((?:[\w:<>,*&\s]|\([^()]*\))*?)\(\s*[*^]\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:=\s*([\s\S]+))?$/;
const DECL = /^((?:[A-Za-z_][\w:]*(?:\s*<[^;=]*?>)?[\s*&]+)+?)([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)(?:=(?!=)\s*([\s\S]+)|(\{[\s\S]*\})|(\([\s\S]*\)))?$/;

/** A statement that declares one name: `void (*fp)(int) = save`, `handler_t hs[] = { a, b }`, `std::function<void()> f = g`. */
function parseDecl(t: string, ctorForm = false): Decl | null {
  const text = t.trim();
  if (text === "") return null;
  const first = /^[A-Za-z_]\w*/.exec(text)?.[0];
  if (!first || NOT_A_TYPE.has(first)) return null;
  const fp = FP_DECL.exec(text);
  if (fp && /^[\w:<>,*&\s]*$/.test(fp[1]!) && fp[1]!.trim() !== "") return { name: fp[2]!, type: fp[1]!.trim(), fp: true, array: !!fp[3], init: fp[4]?.trim() ?? null, brace: null };
  const m = DECL.exec(text);
  if (!m) return null;
  const type = m[1]!.trim();
  // `struct Club;`, `class Club`: a forward declaration names a type, it declares no variable.
  if (/^(?:struct|class|union|enum|typename)$/.test(type)) return null;
  // `Club c(3)` constructs; at file scope `int f(int)` declares a function.
  if (m[6] !== undefined && !ctorForm) return null;
  const words = type.split(/[\s*&]+/).filter(Boolean);
  if (words.some((w) => NOT_A_TYPE.has(w))) return null;
  return { name: m[2]!, type, fp: false, array: (m[3] ?? "").includes("["), init: m[4]?.trim() ?? null, brace: m[5]?.trim() ?? null };
}

/** The struct or class name a declaration's type names, without storage words, pointers and template arguments. */
function typeKey(type: string): string | null {
  const text = type.replace(STORAGE, " ").replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "").replace(/[*&]/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(" ").filter((w) => !/^(?:unsigned|signed|long|short|int|char)$/.test(w));
  if (words.length !== 1 || !/^[A-Za-z_][\w:]*$/.test(words[0]!)) return null;
  const name = words[0]!.replace(/^::/, "");
  return PRIMITIVES.has(name) ? null : name;
}

const CHAIN = /^[A-Za-z_]\w*(?:\s*\[[^\]]*\])*(?:\s*(?:\.|->|::)\s*[A-Za-z_]\w*(?:\s*\[[^\]]*\])*)*$/;

/** The identifiers of a plain member path (`c->ops->sign`, `Club::registry`, `handlers[i]`), indexes dropped; null for anything else. */
function chainOf(text: string): string[] | null {
  const t = text.trim().replace(/^[*&]+\s*/, "");
  if (!CHAIN.test(t)) return null;
  const flat = t.replace(/\[[^\]]*\]/g, "");
  const parts = flat.split(/\s*(\.|->|::)\s*/);
  const segs: string[] = [];
  let scoped = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) segs.push(parts[i]!);
    else if (parts[i] === "::") scoped = true;
  }
  return scoped && segs.length > 2 ? segs.slice(-2) : segs;
}

const LAMBDA = /^\[[^\]]*\]\s*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*(?:mutable\b\s*)?(?:noexcept\b\s*)?(?:->\s*[\w:<>*&\s]+?)?\s*\{/;

export function extractCFamilyValueFlow(lines: readonly string[], analysis: FileAnalysis, cpp: boolean): void {
  const text = blankCode(lines);
  if (!/[A-Za-z_]/.test(text)) return;
  const starts = lineIndex(text);
  /** The function-pointer typedefs and aliases the file declares. */
  const fpTypedefs = new Set<string>();
  const maybeCallable = (type: string, fp: boolean): boolean => typeCallable(type, fp, fpTypedefs);
  for (const m of text.matchAll(/\btypedef\b[^;{}]*?\(\s*[*^]\s*([A-Za-z_]\w*)\s*\)/g)) fpTypedefs.add(m[1]!);
  for (const m of text.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=\s*(?:std\s*::\s*function\b|[^;]*\(\s*[*^]\s*\))/g)) fpTypedefs.add(m[1]!);
  for (const m of text.matchAll(/\btypedef\s+std\s*::\s*function\b[^;]*?\b([A-Za-z_]\w*)\s*;/g)) fpTypedefs.add(m[1]!);
  const classes = analysis.classes;
  const callable = [...new Set([...analysis.functions.filter((f) => f.name !== "<setup>"), ...classes.flatMap((c) => c.methods)])];
  const definedNames = new Set(callable.map((f) => f.name));
  const methodNames = new Set(classes.flatMap((c) => c.methods.map((m) => m.name)));

  // ── File scope ─────────────────────────────────────────────────────────
  const mask = text.split("");
  for (const f of callable) {
    const a = starts[f.line - 1] ?? 0;
    const b = f.endLine < starts.length ? starts[f.endLine]! : text.length;
    for (let i = a; i < b; i++) if (mask[i] !== "\n") mask[i] = " ";
  }
  const fileText = mask.join("");
  interface ModuleVar { type: string; table: string | null; callable: boolean }
  const moduleVars = new Map<string, ModuleVar>();
  const moduleStatements = splitStatements(fileText, 0, fileText.length);
  // The bodies of the structs and classes the file declares, read off its text (the analysis's own line extents are for members).
  const bodies: Array<{ name: string; from: number; to: number }> = [];
  for (const m of fileText.matchAll(/\b(?:struct|class|union)\s+(?:[A-Z_]+\s+)*([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{}()]*)?\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matching(fileText, open, fileText.length);
    if (close > 0) bodies.push({ name: m[1]!, from: open, to: close });
  }
  const classAround = (offset: number): { name: string } | null => {
    let best: { name: string; from: number } | null = null;
    for (const c of bodies) if (c.from < offset && offset < c.to && (!best || c.from > best.from)) best = c;
    return best;
  };
  const moduleDecls: Array<{ decl: Decl; at: number; owner: { name: string } | null }> = [];
  for (const [a, b] of moduleStatements) {
    const t = fileText.slice(a, b);
    const skip = headLength(t);
    const body = t.slice(skip);
    // A block's head (`struct club`, `namespace x`) declares nothing.
    if (fileText[b] === "{" || /^\s*(?:typedef|using|namespace|template|friend)\b/.test(body)) continue;
    const decl = parseDecl(body);
    if (!decl) continue;
    // A function's prototype or a constructor-style declaration is no variable.
    const owner = classAround(a);
    moduleDecls.push({ decl, at: a + skip, owner });
    if (!owner) moduleVars.set(decl.name, { type: decl.type, table: typeKey(decl.type), callable: maybeCallable(decl.type, decl.fp) });
  }

  // A variable the file calls is a callable, whatever its type is called.
  for (const f of callable) for (const c of f.calls) { const v = moduleVars.get(c.name); if (v) v.callable = true; }
  const moduleFacts: ValueFlowFact[] = [];
  const assignedMembers = new Set<string>();

  // ── Expressions ────────────────────────────────────────────────────────
  interface Scope {
    fn: FunctionInfo | null;
    cls: ClassInfo | null;
    declared: Map<string, { type: string; fp: boolean }>;
    params: Map<string, { type: string; fp: boolean }>;
    out: ValueFlowFact[];
    /** Where a name not declared here is written to: a module binding, a field, or nothing. */
    calls: Map<string, CallInfo>;
    leafCalls: Map<string, CallInfo[]>;
    /** Names the body reads members or elements of: data, not functions. */
    data: Set<string>;
    /** Names the body calls as values (`cb(1)`, `(*cb)(1)`, `hs[i](1)`): callables whatever their declared type says. */
    called: Set<string>;
  }
  /** Facts that wait until every assignment of the file is read (they depend on which fields hold callables). */
  const deferred: Array<() => void> = [];
  /** Whether a member name holds a callable: stored one in this file, declared with a function type, or named like one. */
  const callableField = (name: string): boolean => {
    if (assignedMembers.has(name)) return true;
    for (const c of classes) {
      const p = c.properties.find((q) => q.name === name);
      if (p?.type) return FN_TYPE.test(p.type);
    }
    return CALLABLE_NAME.test(name);
  };
  const holds = (s: Scope, name: string, info: { type: string; fp: boolean }): boolean => maybeCallable(info.type, info.fp) || s.called.has(name);
  const plausibleFunction = (s: Scope, name: string): boolean =>
    name.length >= 2 && !/^[A-Z][A-Z0-9_]*$/.test(name) && !s.data.has(name) && !/^\d/.test(name);

  const kindOf = (s: Scope, name: string): "local" | "param" | "module" | "field" | "unknown" => {
    if (s.declared.has(name)) return "local";
    if (s.params.has(name)) return "param";
    if (moduleVars.has(name)) return "module";
    if (s.cls && !definedNames.has(name) && !methodNames.has(name)) return "field";
    return "unknown";
  };

  /** The cell a plain member path names, or null. */
  const cellOfSegs = (s: Scope, segs: string[]): ValueCell | null => {
    if (segs.length === 0) return null;
    const head = segs[0]!;
    if (segs.length === 1) {
      switch (kindOf(s, head)) {
        case "local": case "param": return { name: head };
        case "module": return { name: head };
        case "field": return { name: "this", member: head };
        default: return null;
      }
    }
    let root = head;
    let path = segs.slice(1, -1);
    const leaf = segs[segs.length - 1]!;
    const kind = kindOf(s, head);
    if (kind === "module") {
      const table = moduleVars.get(head)!.table;
      if (!table) return null;
      root = table;
    } else if (kind === "field" && head !== "this") {
      root = "this";
      path = segs.slice(0, -1);
    }
    return { name: [root, ...path].join("."), member: leaf };
  };

  /** Where an assignment to `segs` goes: the same cell, or a module binding a function does not declare. */
  const targetOf = (s: Scope, segs: string[]): ValueCell | null => {
    // A function writing a global it does not declare: the file's module binding.
    if (segs.length === 1 && s.fn && kindOf(s, segs[0]!) === "module") return { name: MODULE_CELL, member: segs[0]! };
    return cellOfSegs(s, segs);
  };

  const pseudoCount = new Map<Scope, number>();
  const pseudo = (s: Scope, at: number): ValueCell => {
    const n = (pseudoCount.get(s) ?? 0) + 1;
    pseudoCount.set(s, n);
    return { name: `$v${at}_${n}` };
  };

  const callAt = (s: Scope, leafOffset: number, leaf: string): CallInfo | null => {
    const line = lineOf(starts, leafOffset);
    const col = leafOffset - starts[line - 1]!;
    const exact = s.calls.get(`${line}:${col}`);
    if (exact) return exact;
    const same = s.leafCalls.get(`${line}:${leaf}`);
    return same && same.length === 1 ? same[0]! : null;
  };

  /** The calls written in `text[from, to)`. */
  const scanCalls = (from: number, to: number): Site[] => {
    const sites: Site[] = [];
    for (let i = from; i < to; i++) {
      if (text[i] !== "(") continue;
      let p = i - 1;
      while (p >= from && /\s/.test(text[p]!)) p--;
      if (p < from) continue;
      const close = matching(text, i, to);
      if (close < 0) continue;
      const ch = text[p]!;
      let form: Site["form"] = "id";
      let end = p;
      if (ch === "]") {
        const open = matchingBack(text, p, from);
        if (open < 0) continue;
        form = "index";
        end = open - 1;
        while (end >= from && /\s/.test(text[end]!)) end--;
        // `a[i][j](…)`: indexes of indexes.
        while (end >= from && text[end] === "]") {
          const o = matchingBack(text, end, from);
          if (o < 0) break;
          end = o - 1;
          while (end >= from && /\s/.test(text[end]!)) end--;
        }
        if (end < from || !/\w/.test(text[end]!)) continue;
      } else if (ch === ")") {
        const open = matchingBack(text, p, from);
        if (open < 0) continue;
        // `(*cb)(…)` is a call of cb; before its `(` a type would make it a declaration.
        let b = open - 1;
        while (b >= from && /\s/.test(text[b]!)) b--;
        const before = b >= from ? text[b]! : "";
        const word = /[A-Za-z_]\w*$/.exec(text.slice(Math.max(from, b - 12), b + 1))?.[0] ?? "";
        if ((/[\w*&>]/.test(before) && word !== "return") || /^\s*[*]\s*$/.test(text.slice(open + 1, p))) {
          if (/[\w*&>]/.test(before) && word !== "return") continue;
        }
        const inner = text.slice(open + 1, p);
        const m = /^\s*\*\s*(.+?)\s*$/.exec(inner);
        const segs = m ? chainOf(m[1]!) : null;
        if (!segs) continue;
        const leafAt = text.lastIndexOf(segs[segs.length - 1]!, p);
        sites.push({ leaf: leafAt, open: i, close, segs, form: "deref", opaque: false });
        continue;
      } else if (!/\w/.test(ch)) continue;
      // The identifier chain ending at `end`.
      const segs: string[] = [];
      let leaf = -1;
      let opaque = false;
      let q = end;
      for (;;) {
        let a = q;
        while (a >= from && /\w/.test(text[a]!)) a--;
        const ident = text.slice(a + 1, q + 1);
        if (ident === "" || /^\d/.test(ident)) { opaque = true; break; }
        if (leaf < 0) leaf = a + 1;
        segs.unshift(ident);
        let r = a;
        while (r >= from && /\s/.test(text[r]!)) r--;
        const sep = text.slice(Math.max(from, r - 1), r + 1);
        if (sep === "->" || sep === "::") r -= 2;
        else if (text[r] === ".") r -= 1;
        else break;
        while (r >= from && /\s/.test(text[r]!)) r--;
        // Indexes and calls before the separator: `a[i].b(`, `a().b(`.
        while (r >= from && text[r] === "]") {
          const o = matchingBack(text, r, from);
          if (o < 0) break;
          r = o - 1;
          while (r >= from && /\s/.test(text[r]!)) r--;
        }
        if (r >= from && text[r] === ")") { opaque = true; break; }
        if (r < from || !/\w/.test(text[r]!)) { opaque = true; break; }
        q = r;
      }
      if (segs.length === 0 || NOT_A_CALL.has(segs[segs.length - 1]!)) continue;
      // `int f(int)`, `Club c(3)`: a name after a type declares.
      if (form === "id" && !opaque && segs.length === 1) {
        let b = leaf - 1;
        while (b >= from && /\s/.test(text[b]!)) b--;
        const prev = b >= from ? text[b]! : "";
        const word = /[A-Za-z_]\w*$/.exec(text.slice(Math.max(from, b - 16), b + 1))?.[0] ?? "";
        if (word && !NOT_A_CALL.has(word) && !["else", "return", "case", "new", "delete", "throw", "co_await"].includes(word)) continue;
        if (prev === "*" || prev === "&" || prev === ">") {
          // `x * f(…)` multiplies, `Club *c(…)` declares: no way to tell; leave it to the parse's own call.
        }
      }
      sites.push({ leaf, open: i, close, segs, form, opaque });
    }
    return sites;
  };

  /** Seeds and copies that put what the expression `expr` (at `at`) holds into `to`. */
  const flowInto = (s: Scope, to: ValueCell, expr: string, at: number, depth = 0, allowResult = false): void => {
    if (depth > 4) return;
    let e = expr.trim();
    if (e === "" || e.length > 4000) return;
    const line = lineOf(starts, at + (expr.length - expr.trimStart().length));
    // Wrappers that hand the same value on.
    for (;;) {
      const wrap = /^(?:std\s*::\s*)?(?:move|forward(?:\s*<[^<>]*>)?|ref|cref)\s*\(([\s\S]*)\)$/.exec(e);
      if (wrap && matching(e, e.indexOf("("), e.length) === e.length - 1) { e = wrap[1]!.trim(); continue; }
      const cast = /^\(\s*[A-Za-z_][\w\s:*&<>,]*\)\s*(?=[&\w(*])/.exec(e);
      if (cast && !/^\(\s*\*/.test(e)) { e = e.slice(cast[0].length).trim(); continue; }
      const cast2 = /^(?:static_cast|reinterpret_cast|const_cast)\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\(([\s\S]*)\)$/.exec(e);
      if (cast2) { e = cast2[1]!.trim(); continue; }
      if (e.startsWith("(") && matching(e, 0, e.length) === e.length - 1) { e = e.slice(1, -1).trim(); continue; }
      break;
    }
    if (e === "" || LITERALS.has(e) || /^[\d"'.-]/.test(e)) return;
    const off = at + Math.max(0, expr.indexOf(e));
    // A conditional holds either branch.
    const qm = topLevelOf(e, "?");
    if (qm > 0) {
      const colon = topLevelOf(e.slice(qm + 1), ":");
      if (colon >= 0) {
        flowInto(s, to, e.slice(qm + 1, qm + 1 + colon), off + qm + 1, depth + 1, allowResult);
        flowInto(s, to, e.slice(qm + 2 + colon), off + qm + 2 + colon, depth + 1, allowResult);
      }
      return;
    }
    // A lambda held: the project functions its body calls.
    if (LAMBDA.test(e)) {
      lambdaSeeds(e, off, (fn) => s.out.push({ kind: "seed", to, fn, line }));
      return;
    }
    // `std::bind(&Club::save, this)`, `std::mem_fn(&Club::save)`.
    const bind = /^(?:std\s*::\s*)?(?:bind|mem_fn|bind_front|function\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>)\s*\(/.exec(e);
    if (bind && /\bbind|mem_fn/.test(bind[0])) {
      const open = bind[0].length - 1;
      if (matching(e, open, e.length) !== e.length - 1) return;
      const first = e.slice(open + 1, e.length - 1).split(",")[0]!.trim();
      flowInto(s, to, first, off + open + 1, depth + 1, allowResult);
      return;
    }
    // A call: its result.
    const callMatch = /^[A-Za-z_][\w:.\->\s\[\]]*\(/.exec(e);
    if (callMatch && e.endsWith(")") && matching(e, callMatch[0].length - 1, e.length) === e.length - 1) {
      if (!allowResult) return;
      const sites = scanCalls(off, off + e.length);
      const site = sites.find((x) => x.open === off + callMatch[0].length - 1 && x.form === "id");
      if (site) {
        const call = callAt(s, site.leaf, site.segs[site.segs.length - 1]!);
        if (call) s.out.push({ kind: "result", call: call.name, line: call.line, to });
      }
      return;
    }
    const addrOf = e.startsWith("&") ? e.slice(1).trim() : e;
    const segs = chainOf(addrOf);
    if (!segs || segs[0] === "std") return;
    if (segs.length === 1) {
      const name = segs[0]!;
      if (LITERALS.has(name)) return;
      const kind = kindOf(s, name);
      if (kind === "local" || kind === "param") {
        if (e.startsWith("&")) return;
        const info = s.declared.get(name) ?? s.params.get(name)!;
        if (holds(s, name, info)) s.out.push({ kind: "copy", from: { name }, to, line });
        return;
      }
      if (kind === "module") {
        if (!moduleVars.get(name)!.callable) return;
        s.out.push({ kind: "copy", from: { name }, to, line });
        return;
      }
      if (!plausibleFunction(s, name)) return;
      // A function named, or (in a method) a field of the class holding one.
      if (kind !== "field" || !/(?:_$|^m_|^_)/.test(name)) s.out.push({ kind: "seed", to, fn: name, line });
      if (kind === "field") {
        const out = s.out;
        deferred.push(() => { if (callableField(name)) out.push({ kind: "copy", from: { name: "this", member: name }, to, line }); });
      }
      return;
    }
    // `Club::save`, `&Club::save`: the function; `this->save`: a method of this class or a field.
    const text0 = addrOf.replace(/\s+/g, "");
    if (text0.includes("::")) {
      const cell = cellOfSegs(s, segs);
      s.out.push({ kind: "seed", to, fn: segs.join("."), line });
      if (cell && !e.startsWith("&")) s.out.push({ kind: "copy", from: cell, to, line });
      return;
    }
    const cell = cellOfSegs(s, segs);
    const leaf = segs[segs.length - 1]!;
    const out = s.out;
    if (cell) deferred.push(() => { if (callableField(leaf)) out.push({ kind: "copy", from: cell, to, line }); });
    if (segs[0] === "this" && segs.length === 2) s.out.push({ kind: "seed", to, fn: `this.${segs[1]}`, line });
  };

  const lambdaSeeds = (lambda: string, at: number, add: (fn: string) => void): void => {
    const open = lambda.indexOf("{", LAMBDA.exec(lambda)![0].length - 1);
    const close = matching(lambda, open, lambda.length);
    if (close < 0) return;
    const names = new Set<string>();
    // The calls of the body, read as a scan of its text (their leaf positions in the file).
    const inner = text.slice(at + open + 1, at + close);
    if (inner.length !== close - open - 1) return;
    for (const site of scanCalls(at + open + 1, at + close)) {
      if (site.form !== "id" || site.opaque) continue;
      const segs = site.segs;
      if (segs.length === 1 && !NOT_A_CALL.has(segs[0]!)) names.add(segs[0]!);
      else if (segs.length === 2 && segs[0] === "this") names.add(`this.${segs[1]}`);
      else if (segs.length === 2 && /^[A-Z]/.test(segs[0]!) && text.slice(site.leaf - 2, site.leaf) === "::") names.add(segs.join("."));
      if (names.size > 4) return;
    }
    for (const n of names) add(n);
  };

  /** The cell holding what an operand of a call or a return holds, with the facts that fill it. */
  const operandCell = (s: Scope, expr: string, at: number, allowResult = false): ValueCell | null => {
    const e = expr.trim();
    if (e === "" || LITERALS.has(e) || /^[\d"'.-]/.test(e)) return null;
    const segs = chainOf(e.startsWith("&") ? e.slice(1) : e);
    if (segs && segs.length === 1) {
      const kind = kindOf(s, segs[0]!);
      if (!e.startsWith("&") && (kind === "local" || kind === "param")) {
        const info = s.declared.get(segs[0]!) ?? s.params.get(segs[0]!)!;
        return holds(s, segs[0]!, info) ? { name: segs[0]! } : null;
      }
      if (!e.startsWith("&") && kind === "module") return moduleVars.get(segs[0]!)!.callable ? { name: segs[0]! } : null;
      if (!e.startsWith("&") && kind === "field") return callableField(segs[0]!) ? { name: "this", member: segs[0]! } : null;
    }
    if (segs && segs.length > 1 && !e.startsWith("&") && !e.includes("::")) {
      const cell = cellOfSegs(s, segs);
      return cell && callableField(segs[segs.length - 1]!) ? cell : null;
    }
    const cell = pseudo(s, at);
    const before = s.out.length;
    flowInto(s, cell, expr, at, 0, allowResult);
    return s.out.length > before ? cell : null;
  };

  // ── Per function ───────────────────────────────────────────────────────
  const factCap = 600;
  const processFunction = (fn: FunctionInfo, cls: ClassInfo | null): (() => void) | null => {
    const first = starts[fn.line - 1] ?? 0;
    const last = fn.endLine < starts.length ? starts[fn.endLine]! : text.length;
    // The body is the last braced block the function's lines close: `bs` its `{`, `be` its `}`.
    const be = text.lastIndexOf("}", last - 1);
    if (be < first) return null;
    const bs = matchingBack(text, be, first);
    if (bs < 0) return null;
    const open0 = text.indexOf("(", first);
    if (open0 < 0 || open0 > bs) return null;
    const sigEnd = matching(text, open0, bs);
    if (sigEnd < 0) return null;
    // A constructor's initializer list sits between the signature and the body: `: cb_(cb), n_{3} {`.
    const initList: Array<{ member: string; expr: string; at: number }> = [];
    const lead = /^\s*(?:(?:const|noexcept|override|final|volatile|mutable)\b\s*)*:(?!:)/.exec(text.slice(sigEnd + 1, bs));
    if (cls && lead) {
      let k = sigEnd + 1 + lead[0].length;
      for (;;) {
        const m = /^\s*([A-Za-z_][\w:]*)\s*(?:<[^(){};]*>)?\s*([({])/.exec(text.slice(k, bs));
        if (!m) break;
        const open = k + m[0].length - 1;
        const close = matching(text, open, bs);
        if (close < 0) break;
        initList.push({ member: m[1]!.split("::").pop()!, expr: text.slice(open + 1, close), at: open + 1 });
        k = close + 1;
        while (k < bs && /\s/.test(text[k]!)) k++;
        if (text[k] === ",") { k++; continue; }
        break;
      }
    }
    const scope: Scope = {
      fn,
      cls,
      declared: new Map(),
      params: new Map(fn.params.map((p) => [p.name, { type: p.type ?? "", fp: /\(\s*[*^]/.test(p.type ?? "") }])),
      out: [],
      calls: new Map(),
      leafCalls: new Map(),
      data: new Set(),
      called: new Set(),
    };
    for (const c of fn.calls) {
      if (c.column === undefined) continue;
      scope.calls.set(`${c.line}:${c.column}`, c);
      const key = `${c.line}:${c.name.split(".").pop()}`;
      (scope.leafCalls.get(key) ?? scope.leafCalls.set(key, []).get(key)!).push(c);
    }
    const statements = splitStatements(text, bs + 1, be);
    // Declarations first: a name's kind does not depend on where it is declared in the body.
    const parsed: Array<{ a: number; t: string; decl: Decl | null }> = [];
    for (const [a, b] of statements) {
      const t0 = text.slice(a, b);
      const skip = headLength(t0);
      const t = t0.slice(skip);
      const decl = /^\s*(?:return|typedef|using)\b/.test(t) ? null : parseDecl(t, true);
      if (decl) {
        scope.declared.set(decl.name, { type: decl.type, fp: decl.fp });
        // `auto g = [this] { … };`, `auto h = std::bind(…)`: a value built to be called.
        if (/\bauto\b/.test(decl.type) && decl.init !== null && (LAMBDA.test(decl.init) || /^(?:std\s*::\s*)?(?:bind|mem_fn|function)\b/.test(decl.init) || /^&\s*[A-Za-z_]\w*\s*::/.test(decl.init))) scope.called.add(decl.name);
        // `float *a, *b;`: the names after the first.
        const parts = topLevelCommas(t);
        for (const [pa, pb] of parts.slice(1)) {
          const more = /^\s*[*&\s]*([A-Za-z_]\w*)\s*(?:=(?!=)|\[|$)/.exec(t.slice(pa, pb));
          if (more) scope.declared.set(more[1]!, { type: decl.type, fp: decl.fp });
        }
      }
      parsed.push({ a: a + skip, t, decl });
    }
    const bodyText = text.slice(bs, be);
    for (const m of bodyText.matchAll(/\b([A-Za-z_]\w*)\s*(?:->|\.|\[)/g)) if (m[1] !== "this") scope.data.add(m[1]!);
    for (const c of fn.calls) if (c.boundLocally) scope.called.add(c.name.split(".")[0]!);
    for (const m of bodyText.matchAll(/\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(|\b([A-Za-z_]\w*)\s*\[[^\]]*\]\s*\(/g)) scope.called.add((m[1] ?? m[2])!);
    // `for (auto& h : handlers)`: the loop variable holds what the collection holds.
    const returns: Array<{ expr: string; at: number; line: number }> = [];
    const rangeFors: Array<{ name: string; source: string; at: number }> = [];
    for (let f = text.indexOf("for", bs); f >= 0 && f < be; f = text.indexOf("for", f + 3)) {
      if (/\w/.test(text[f - 1] ?? "") || !/^for\s*\(/.test(text.slice(f, f + 8))) continue;
      const open = text.indexOf("(", f);
      const close = matching(text, open, be);
      if (close < 0) continue;
      const head = text.slice(open + 1, close);
      const colon = topLevelOf(head, ":");
      if (colon < 0 || head.slice(0, colon).includes(";") || topLevelOf(head, ";") >= 0) continue;
      const name = /([A-Za-z_]\w*)\s*$/.exec(head.slice(0, colon))?.[1];
      if (!name) continue;
      scope.declared.set(name, { type: "auto", fp: false });
      rangeFors.push({ name, source: head.slice(colon + 1), at: open + 1 + colon + 1 });
    }
    for (const r of rangeFors) flowInto(scope, { name: r.name }, r.source, r.at);
    for (const { a, t, decl } of parsed) {
      if (scope.out.length > factCap) break;
      const ret = /^\s*return\b([\s\S]*)$/.exec(t);
      if (ret) {
        returns.push({ expr: ret[1]!, at: a + t.indexOf(ret[1]!), line: lineOf(starts, a) });
        continue;
      }
      if (decl) {
        const to: ValueCell = { name: decl.name };
        if (decl.init !== null) {
          const initAt = a + t.indexOf(decl.init, t.indexOf("="));
          if (decl.init.startsWith("{")) initTable(scope, decl, decl.init, initAt, to);
          else if (holds(scope, decl.name, decl)) flowInto(scope, to, decl.init, initAt, 0, true);
        } else if (decl.brace !== null) {
          const braceAt = a + t.lastIndexOf(decl.brace);
          initTable(scope, decl, decl.brace, braceAt, to);
        }
        continue;
      }
      const insert = /^([^()=]+?)\s*(?:\.|->)\s*(?:push_back|emplace_back|push_front|emplace_front|push|insert|emplace|add|append)\s*\(([\s\S]*)\)$/.exec(t);
      if (insert) {
        const segs = chainOf(insert[1]!);
        const to = segs ? cellOfSegs(scope, segs) : null;
        const parts = topLevelCommas(insert[2]!);
        const last = parts[parts.length - 1];
        if (to && last) {
          const argAt = a + t.indexOf("(", insert[1]!.length) + 1;
          const before = scope.out.length;
          flowInto(scope, to, insert[2]!.slice(last[0], last[1]), argAt + last[0]);
          if (scope.out.length > before && to.member !== undefined) assignedMembers.add(to.member);
        }
        continue;
      }
      const assign = /^([^=]*?[^=!<>+\-*/%&|^\s])\s*=(?!=)\s*([\s\S]+)$/.exec(t);
      if (assign) {
        const lhs = assign[1]!.trim();
        const segs = chainOf(lhs);
        if (!segs) continue;
        const to = targetOf(scope, segs);
        if (!to) continue;
        const before = scope.out.length;
        const rhsAt = a + t.indexOf("=", lhs.length) + 1;
        if (assign[2]!.trim().startsWith("{")) continue;
        // The destination's type, when the name states it: a number or a data pointer holds no function.
        let allowResult = true;
        if (segs.length === 1) {
          const kind = kindOf(scope, segs[0]!);
          const info = kind === "local" ? scope.declared.get(segs[0]!) : kind === "param" ? scope.params.get(segs[0]!) : undefined;
          if (info && !holds(scope, segs[0]!, info)) continue;
          if (kind === "module" && !moduleVars.get(segs[0]!)!.callable) continue;
          if (kind === "field" || kind === "module") allowResult = callableField(segs[0]!);
        } else allowResult = callableField(segs[segs.length - 1]!);
        flowInto(scope, to, assign[2]!, rhsAt, 0, allowResult);
        if (scope.out.length > before && to.member !== undefined && to.name !== MODULE_CELL) assignedMembers.add(to.member);
        if (scope.out.length > before && to.name === MODULE_CELL) assignedMembers.add(to.member!);
      }
    }
    // A constructor's initializer list: `: cb_(cb)` sets the field.
    for (const item of initList) {
      if (item.expr.trim() === "") continue;
      const before = scope.out.length;
      flowInto(scope, { name: "this", member: item.member }, item.expr, item.at);
      if (scope.out.length > before) assignedMembers.add(item.member);
    }
    // Calls: arguments handed on, and calls that run a held value (once every function's assignments are read).
    return () => {
    for (const r of returns) {
      const allow = maybeCallable(fn.returnType ?? "", /\(\s*[*^]/.test(fn.returnType ?? ""));
      const cell = operandCell(scope, r.expr, r.at, allow);
      if (cell) scope.out.push({ kind: "return", from: cell, line: r.line });
    }
    const sites = scanCalls(bs + 1, be);
    const seen = new Set<string>();
    for (const site of sites) {
      if (scope.out.length > factCap) break;
      const leafName = site.segs[site.segs.length - 1]!;
      const call = site.form === "id" && !site.opaque ? callAt(scope, site.leaf, leafName) : null;
      if (call && site.segs[0] !== "std" && !/^(?:push_back|emplace_back|push_front|emplace_front|push|insert|emplace|add|append)$/.test(leafName)) {
        const argText = text.slice(site.open + 1, site.close);
        const parts = topLevelCommas(argText);
        for (const [index, [pa, pb]] of parts.entries()) {
          const cell = operandCell(scope, argText.slice(pa, pb), site.open + 1 + pa);
          if (cell) scope.out.push({ kind: "arg", call: call.name, line: call.line, index, from: cell });
        }
      }
      const invoke = invokeCell(scope, site, call);
      if (invoke) {
        const name = call?.name ?? (site.form === "id" ? leafName : leafName);
        const line = call?.line ?? lineOf(starts, site.leaf);
        const key = `${name}\0${line}\0${invoke.name}.${invoke.member ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scope.out.push({ kind: "invoke", cell: invoke, call: name, line });
      }
    }
    while (deferred.length > 0) deferred.shift()!();
    if (scope.out.length > 0) fn.valueFlow = [...(fn.valueFlow ?? []), ...scope.out];
    };
  };

  /** The cell a call runs, when the call runs a value rather than a function. */
  const invokeCell = (s: Scope, site: Site, call: CallInfo | null): ValueCell | null => {
    if (site.opaque && site.form === "id") return null;
    const segs = site.segs;
    if (site.form === "id") {
      if (!call) return null;
      if (call.boundLocally) return null;
      if (segs.length === 1) {
        const name = segs[0]!;
        const kind = kindOf(s, name);
        if (kind === "module") return moduleVars.get(name)!.callable && !definedNames.has(name) && !classes.some((c) => c.name === name) ? { name } : null;
        if (kind === "field" && cpp && s.cls && assignedMembers.has(name)) return { name: "this", member: name };
        return null;
      }
      // `x.m(…)`, `p->m(…)`: in C every such call runs a function-pointer member.
      if (!cpp) return cellOfSegs(s, segs);
      const leaf = segs[segs.length - 1]!;
      if (methodNames.has(leaf) || !assignedMembers.has(leaf)) return null;
      return cellOfSegs(s, segs);
    }
    // `(*cb)(…)`, `handlers[i](…)`.
    if (segs.length === 1) {
      const kind = kindOf(s, segs[0]!);
      if (kind === "unknown") return null;
      return cellOfSegs(s, segs);
    }
    return cellOfSegs(s, segs);
  };

  /** A table initializer: `{ .sign = club_sign }` fills the struct type's members, `{ a, b }` an array of handlers. */
  const initTable = (s: Scope | null, decl: Decl, init: string, at: number, to: ValueCell, rootType?: string, path: string[] = [], sink?: ValueFlowFact[], element = false): void => {
    const out = sink ?? (s ?? moduleScope).out;
    const inner = init.trim().slice(1, init.trim().lastIndexOf("}"));
    const base = at + init.indexOf("{") + 1;
    const root = rootType ?? typeKey(decl.type) ?? undefined;
    const pseudoScope: Scope = s ?? moduleScope;
    for (const [pa, pb] of topLevelCommas(inner)) {
      const part = inner.slice(pa, pb);
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const at2 = base + pa;
      const designated = /^\.\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/.exec(trimmed);
      if (designated) {
        if (!root) continue;
        const member = designated[1]!;
        const value = designated[2]!.trim();
        const valueAt = at2 + part.indexOf(value);
        const cell: ValueCell = { name: [root, ...path].join("."), member };
        if (value.startsWith("{")) initTable(s, decl, value, valueAt, to, root, [...path, member], sink, element);
        else flowIntoSink(pseudoScope, out, cell, value, valueAt);
        continue;
      }
      if (/^\[[^\]]*\]\s*=/.test(trimmed)) {
        const value = trimmed.replace(/^\[[^\]]*\]\s*=\s*/, "");
        if (value.startsWith("{")) initTable(s, decl, value, at2 + part.indexOf(value), to, root, path, sink);
        else if (decl.array && !element && path.length === 0) flowIntoSink(pseudoScope, out, to, value, at2 + part.indexOf(value));
        continue;
      }
      if (trimmed.startsWith("{")) {
        // An element of an array of structs: its designated members are the struct type's.
        initTable(s, decl, trimmed, at2 + part.indexOf("{"), to, root, path, sink, true);
        continue;
      }
      if (decl.array && !element && path.length === 0 && (decl.fp || maybeCallable(decl.type, decl.fp))) flowIntoSink(pseudoScope, out, to, trimmed, at2 + part.indexOf(trimmed));
    }
  };

  const flowIntoSink = (s: Scope, sink: ValueFlowFact[], to: ValueCell, expr: string, at: number): void => {
    const saved = s.out;
    s.out = sink;
    try {
      flowInto(s, to, expr, at);
    } finally {
      s.out = saved;
    }
  };

  const moduleScope: Scope = { fn: null, cls: null, declared: new Map(), params: new Map(), out: moduleFacts, calls: new Map(), leafCalls: new Map(), data: new Set(), called: new Set() };

  const finishers: Array<() => void> = [];
  // A method is one object in its class and in the file's function list: read it once, with its class.
  const read = new Set<FunctionInfo>();
  for (const c of classes) for (const m of c.methods) { if (read.has(m)) continue; read.add(m); const done = processFunction(m, c); if (done) finishers.push(done); }
  for (const f of analysis.functions) if (f.name !== "<setup>" && !read.has(f)) { read.add(f); const done = processFunction(f, null); if (done) finishers.push(done); }
  while (deferred.length > 0) deferred.shift()!();
  for (const done of finishers) done();

  // File scope: tables and handler variables initialized outside any function.
  for (const { decl, at, owner } of moduleDecls) {
    const to: ValueCell = owner ? { name: owner.name, member: decl.name } : { name: decl.name };
    const initAt = fileText.indexOf(decl.init ?? decl.brace ?? "\0", at);
    if (decl.init !== null && initAt >= 0) {
      if (decl.init.startsWith("{")) initTable(null, decl, decl.init, initAt, to);
      else if (maybeCallable(decl.type, decl.fp)) flowInto(moduleScope, to, decl.init, initAt);
    } else if (decl.brace !== null) {
      const braceAt = fileText.indexOf(decl.brace, at);
      if (braceAt >= 0) initTable(null, decl, decl.brace, braceAt, to);
    }
  }
  while (deferred.length > 0) deferred.shift()!();
  if (moduleFacts.length > 0) analysis.moduleValueFlow = [...(analysis.moduleValueFlow ?? []), ...moduleFacts];

}

/** Index of the first `c` at bracket depth zero in `text`, or -1. */
function topLevelOf(text: string, c: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === c) {
      if (c === ":" && (text[i + 1] === ":" || text[i - 1] === ":")) continue;
      if (c === "?" && (text[i + 1] === "?" || text[i - 1] === "?")) continue;
      return i;
    }
  }
  return -1;
}
