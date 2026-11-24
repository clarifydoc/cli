import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/**
 * A parameterless `def` (`def total: Int`, `def name = "x"`) is called without parentheses — `club.total`, a bare
 * `total` inside the class — which the call scan, reading only an argument list, cannot tell from a field read. This
 * marks each such def the file declares (`FunctionInfo.getter`) and records the reads that may run one as
 * `CallInfo.read: "getter"`: the linker keeps one only where it resolves, through the receiver's declared type or the
 * enclosing class and its bases, to a function marked as a getter. A `val`, a field, a parameter or a def that takes
 * a parameter list is a value, so it draws no edge. Read off the text, so both front ends state the same shapes.
 */
export function addScalaGetterReads(lines: readonly string[], analysis: FileAnalysis): void {
  const code = codeView(lines);
  const owned: Array<{ fn: FunctionInfo; fields: ReadonlySet<string> }> = [];
  const none: ReadonlySet<string> = new Set();
  for (const fn of analysis.functions) owned.push({ fn, fields: none });
  for (const cls of analysis.classes) {
    const fields = new Set(cls.properties.map((p) => p.name));
    for (const m of cls.methods) owned.push({ fn: m, fields });
  }
  for (const { fn } of owned) if (fn.line > 0 && isParameterless(code.lines[fn.line - 1] ?? "", fn.name)) fn.getter = true;
  for (const { fn, fields } of owned) {
    if (fn.name === "<setup>" || fn.line < 1 || fn.synthetic) continue;
    const slice = code.lines.slice(fn.line - 1, fn.endLine).join("\n");
    const start = bodyStart(slice, fn.name);
    if (start < 0) continue;
    const text = slice.slice(start);
    const own = new Set([...declaredNames(text), ...fn.params.map((p) => p.name)]);
    const have = new Set(fn.calls.map((c) => c.name));
    const found: Array<{ name: string; at: number }> = [];
    for (const m of text.matchAll(PATH_READ)) {
      const at = m.index!;
      const names = m[1]!.split(/\s*\.\s*/);
      if (!isRead(text, at + m[0].length, text.slice(0, at))) continue;
      const [head, ...members] = names;
      if (KEYWORDS.has(head!) && head !== "this") continue;
      if (head === "this" && fields.has(members[0]!)) continue;
      // Every prefix is a read: `club.league.total` reads `club.league`, then `.total` off its result.
      for (let n = 2; n <= names.length; n++) found.push({ name: names.slice(0, n).join("."), at });
    }
    for (const m of text.matchAll(CHAIN_READ)) {
      const at = m.index!;
      if (!isRead(text, at + m[0].length, text.slice(0, at))) continue;
      if (isInfixOperand(text, at + m[0].length)) continue;
      const head = m[1]!;
      if (KEYWORDS.has(head) && head !== "this") continue;
      const steps = [...m[2]!.matchAll(CHAIN_STEP)].map((s) => ({ name: s[1]!, called: s[2] !== undefined }));
      if (!steps.some((s) => s.called)) continue;
      // Every member read along the way (`repo.find().rival`, then `.total` off it): a prefix ending in a call is the call scan's.
      for (let n = 1; n <= steps.length; n++) {
        if (steps[n - 1]!.called) continue;
        found.push({ name: `${head}${steps.slice(0, n).map((s) => `.${s.name}${s.called ? "()" : ""}`).join("")}`, at });
      }
    }
    for (const m of text.matchAll(BARE_READ)) {
      const name = m[1]!;
      if (KEYWORDS.has(name) || own.has(name) || fields.has(name)) continue;
      const before = text.slice(0, m.index!);
      if (!isRead(text, m.index! + name.length, before)) continue;
      // `xs map f`, `repo.find(1) foreach g`: an infix call, the name sits between two operands.
      if (/[\w)\]}]\s+$/.test(before) && !/\b(?:return|yield|if|else|case|match|throw|new|then|do|with|extends|in|val|var|def)\s+$/.test(before) && isInfixOperand(text, m.index! + name.length)) continue;
      found.push({ name, at: m.index! });
    }
    for (const { name, at } of found.sort((a, b) => a.at - b.at)) {
      if (have.has(name)) continue;
      have.add(name);
      const lead = slice.slice(0, start + at);
      const line = fn.line + lead.split("\n").length - 1;
      const column = start + at - (lead.lastIndexOf("\n") + 1);
      const call: CallInfo = { name, kind: "internal", target: null, line, column, read: "getter" };
      fn.calls.push(call);
    }
  }
}

/** A `def` of this name on the line with no parameter list: `def total: Int`, `def name = …`, `def all[T]: Seq[T]`. */
function isParameterless(line: string, name: string): boolean {
  const m = new RegExp(String.raw`(?<![\w$])def\s+${name.replace(/\$/g, "\\$")}\s*(\[[^\]]*\])?\s*([:={(]|$)`).exec(line);
  return !!m && m[2] !== "(";
}

/** `a.b`, `this.a.b`, `Club.name`: a head, then lowercase members, none called, indexed or given type arguments. */
const PATH_READ = /(?<![\w$.@])([A-Za-z_]\w*(?:\s*\.\s*[a-z_]\w*)+)(?![\w$])(?!\s*[(\[])/g;
/**
 * `repo.find(1).total`, `Repo.find(1).rival.total`: a head, steps of which at least one is a call with arguments, the
 * last a member read (not called, indexed or given type arguments). One nested level of arguments is read.
 */
const CALL_ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const CHAIN_READ = new RegExp(String.raw`(?<![\w$.@])([A-Za-z_]\w*)((?:\s*\.\s*[a-z_]\w*(?:\s*${CALL_ARGS})?)*?\s*\.\s*[a-z_]\w*)(?![\w$])(?!\s*[(\[])`, "g");
const CHAIN_STEP = new RegExp(String.raw`\.\s*([a-z_]\w*)(\s*${CALL_ARGS})?`, "g");
/**
 * Whether what follows the member on its line is an argument written without parentheses — a block (`.map { x => … }`),
 * an infix operand (`xs map f`, `.map _`, `.foreach "x"`) — so the member is a method called, not a getter read.
 */
function isInfixOperand(text: string, end: number): boolean {
  const m = /^[ \t]*([{_"'(]|\w+)/.exec(text.slice(end, end + 40));
  if (!m) return false;
  if (m[1] === "(") return true;
  return !/^(?:if|else|match|then|yield|with|extends|do|forSome|catch|finally|and|or)$/.test(m[1]!);
}

/** A lowercase name not after a dot and not called. */
const BARE_READ = /(?<![\w$.@])([a-z_]\w*)(?![\w$])(?!\s*[(\[])/g;

const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract", "case", "catch", "class", "def", "do", "else", "enum", "export", "extends", "extension", "false", "final", "finally", "for", "forSome",
  "given", "if", "implicit", "import", "lazy", "match", "new", "null", "object", "override", "package", "private", "protected", "return", "sealed",
  "super", "then", "this", "throw", "trait", "true", "try", "type", "using", "val", "var", "while", "with", "yield", "_", "end", "derives", "inline",
  "opaque", "transparent", "open", "macro", "scala", "java", "javax", "println", "print", "assert", "require", "sys", "implicitly", "classOf",
]);

/** Where the body begins in `slice` (the def's text): past its parameter lists and result type, after the `=` (or the `{`). */
function bodyStart(slice: string, name: string): number {
  const at = slice.search(new RegExp(String.raw`(?<![\w$])def\s+${name.replace(/\$/g, "\\$")}(?![\w$])`));
  if (at < 0) return -1;
  let depth = 0;
  for (let k = slice.indexOf(name, at) + name.length; k < slice.length; k++) {
    const c = slice[k]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === "{") return k + 1;
    else if (depth === 0 && c === "=" && slice[k + 1] !== "=" && slice[k + 1] !== ">" && !"=!<>".includes(slice[k - 1] ?? "")) return k + 1;
    else if (depth === 0 && c === ";") return -1;
  }
  return -1;
}

/**
 * Whether the name ending at `end` is read: not an assignment target (`x.m = v`, `m += 1`) nor a named argument
 * (`f(m = 1)`), not part of a pattern's or a declaration's name list.
 */
function isRead(text: string, end: number, before: string): boolean {
  const rest = text.slice(end).trimStart();
  if (/^(?:[-+*\/%&|^]|<<|>>>?)?=(?![=>])/.test(rest)) return false;
  // A declaration's name, a type ascription's, an import's.
  if (/\b(?:val|var|def|lazy val|type|import|package|class|object|trait|case)\s+$/.test(before)) return false;
  if (/\bnew\s+$/.test(before)) return false;
  // A pattern binder or a lambda parameter: `x =>`, `x <-`.
  if (/^(?:=>|<-)/.test(rest)) return false;
  return true;
}

/** Names the body binds: vals, vars, local defs, pattern and lambda binders, generator variables. */
function declaredNames(text: string): Set<string> {
  const out = new Set<string>();
  const add = (list: string | undefined): void => {
    for (const n of (list ?? "").split(",")) {
      const name = /([A-Za-z_]\w*)\s*(?::[^,]*)?$/.exec(n.trim())?.[1];
      if (name) out.add(name);
    }
  };
  for (const m of text.matchAll(/\b(?:val|var|def)\s+([A-Za-z_]\w*)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b(?:val|var)\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of text.matchAll(/\bcase\s+([A-Za-z_]\w*)\s*(?:@|:|=>|if\b)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\bcase\s+[A-Z][\w.]*\(([^)]*)\)/g)) add(m[1]);
  for (const m of text.matchAll(/\bcase\s+\(([^)]*)\)/g)) add(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*(?:<-|=>)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\(([\w\s,:\[\]]*)\)\s*=>/g)) add(m[1]);
  for (const m of text.matchAll(/\(([\w\s,]*)\)\s*<-/g)) add(m[1]);
  return out;
}

interface CodeView {
  lines: string[];
}

/**
 * The file as code: comments and the literal parts of strings blanked (same length), the names an interpolated
 * string reads (`s"$total"`, `s"${club.name}"`) kept.
 */
function codeView(lines: readonly string[]): CodeView {
  const source = lines.join("\n");
  const out = source.split("");
  const n = source.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const e = source.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && source[i + 1] === "*") {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (source[k] === "/" && source[k + 1] === "*") { depth++; k += 2; }
        else if (source[k] === "*" && source[k + 1] === "/") { depth--; k += 2; }
        else k++;
      }
      blank(i, k);
      i = k;
    } else if (c === '"') {
      const triple = source.startsWith('"""', i);
      const interpolated = /[A-Za-z]/.test(source[i - 1] ?? "") && !/[\w$]/.test(source[i - 2] ?? " ");
      const close = triple ? '"""' : '"';
      let k = i + close.length;
      blank(i, k);
      while (k < n) {
        const d = source[k]!;
        if (d === "\\" && !triple && !interpolated) { blank(k, k + 2); k += 2; continue; }
        if (source.startsWith(close, k)) {
          // `"""` closes at the last quote of a run.
          let e = k + close.length;
          while (triple && source[e] === '"') e++;
          blank(k, e);
          k = e;
          break;
        }
        if (!triple && d === "\n") break;
        if (interpolated && d === "$" && source[k + 1] === "{") {
          let depth = 1;
          let e = k + 2;
          for (; e < n && depth > 0; e++) { if (source[e] === "{") depth++; else if (source[e] === "}") depth--; }
          blank(k, k + 2);
          blank(e - 1, e);
          k = e;
          continue;
        }
        if (interpolated && d === "$" && /[A-Za-z_]/.test(source[k + 1] ?? "")) {
          blank(k, k + 1);
          k++;
          while (k < n && /\w/.test(source[k]!)) k++;
          continue;
        }
        blank(k, k + 1);
        k++;
      }
      i = k;
    } else if (c === "'" && /^'(?:\\.[^']*|[^\\'])'/.test(source.slice(i, i + 8))) {
      const e = source.indexOf("'", i + (source[i + 1] === "\\" ? 3 : 2));
      blank(i, e + 1);
      i = e + 1;
    } else i++;
  }
  return { lines: out.join("").split("\n") };
}
