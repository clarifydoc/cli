import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import { rubyCodeLinesOf } from "./blocks.js";

/**
 * Calls the syntax hides. `club.name = "x"` runs `name=`; `club + other`, `club == other` and `club <=> other` run
 * the operator method; `club[1]` and `club[1] = x` run `[]` and `[]=`. A body names none of them, and a number, a
 * string or a hash reads the same, so each is recorded as `CallInfo.syntax` under the name `receiver.member`
 * (`club.name=`, `club.+`, `club.[]=`): the linker keeps one only where the receiver's declared type, or the
 * enclosing class for `self`, declares the member, never by the name alone. `!=` runs `==`.
 *
 * Read from the code lines (comments and heredocs blanked, string literals emptied here), one call per name per
 * function, and only for a receiver whose type can be stated: `self`, an instance variable, a parameter, or a local
 * with a `localTypes` entry. A call result or reader path (`page.to_i`), an index chain, a literal-bound local
 * (`total = 0`) and the framework's own hashes (`params[:id]`) state nothing.
 */
export function addRubySyntaxCalls(lines: readonly string[], analysis: FileAnalysis): void {
  const code = rubyCodeLinesOf(lines);
  const fns: FunctionInfo[] = [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)];
  for (const fn of fns) {
    if (fn.name === "<setup>" || fn.line < 1 || fn.synthetic || fn.endLine < fn.line) continue;
    const body = code.slice(fn.line - 1, fn.endLine);
    const literals = literalLocals(body);
    const typed = new Set([...fn.params.map((p) => p.name), ...(fn.localTypes ?? []).map((t) => t.name)]);
    const have = new Set(fn.calls.map((c) => c.name));
    body.forEach((raw, k) => {
      let text = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      if (k === 0) text = text.replace(/^(\s*)def\s+(?:self\.)?[^\s(;]+/, "$1");
      if (!/[=+\-*\/%<>\[&|^]/.test(text)) return;
      for (const found of syntaxCallsOf(text)) {
        // Only a receiver whose type can be stated: `self`, an instance variable, a parameter, a local with a type entry.
        // Never a call result or a reader path (`page.to_i`), an index chain, the framework's hashes or a literal-bound local.
        const receiver = found.receiver.replace(/^@/, "");
        if (receiver.includes(".") || REQUEST_OBJECTS.has(receiver) || KEYWORDS.has(receiver) || literals.has(receiver)) continue;
        if (receiver !== "self" && !found.receiver.startsWith("@") && !typed.has(receiver)) continue;
        const name = `${receiver}.${found.member}`;
        if (have.has(name)) continue;
        have.add(name);
        const call: CallInfo = { name, kind: "internal", target: null, line: fn.line + k, column: found.column, syntax: true };
        fn.calls.push(call);
      }
    });
  }
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "if", "unless", "while", "until", "case", "when", "return", "yield", "puts", "print", "raise", "rescue", "ensure", "else", "elsif", "then", "do",
  "end", "def", "class", "module", "begin", "and", "or", "not", "in", "for", "break", "next", "nil", "true", "false", "super", "lambda", "proc",
]);

/** Receivers that are the framework's hashes, never a project class. */
const REQUEST_OBJECTS: ReadonlySet<string> = new Set(["params", "session", "cookies", "headers", "flash", "request", "response", "options", "opts", "args", "kwargs", "env", "ENV"]);

/** Locals the body binds to a literal: a number, a string, a symbol, a list, a hash, a range. */
function literalLocals(body: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of body) {
    const m = /^\s*@?([a-z_]\w*)\s*(?:\|\||&&|[-+*\/%])?=\s*(?:-?\d|["'%:\[{]|nil\b|true\b|false\b)/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** A receiver: a local, an instance variable or `self`, with a path of readers after it. */
const RECEIVER = String.raw`(?<![\w.@$:)\]}"'])(@?(?:self|[a-z_]\w*)(?:&?\.[a-z_]\w*[?!]?){0,4})`;
const SETTER = new RegExp(`${RECEIVER}&?\\.([a-z_]\\w*)[ \\t]*(?:\\|\\||&&|\\*\\*|<<|>>|[-+*/%|&^])?=(?![=~>])`, "g");
const OPERATOR = new RegExp(`${RECEIVER}\\s+(<=>|===|==|!=|<<|>>|\\*\\*|<=|>=|[-+*/%<>&|^])\\s+(?=[\\w@:"'(\\[{!~-])`, "g");
const INDEXED = new RegExp(`${RECEIVER}\\[`, "g");

interface Found {
  /** As written, `@` kept: an instance variable. */
  receiver: string;
  member: string;
  column: number;
}

function syntaxCallsOf(text: string): Found[] {
  const out: Found[] = [];
  const clean = (path: string): string => path.replace(/&\./g, ".");
  for (const m of text.matchAll(SETTER)) {
    // `a.b = c` is `b=` on `a`; a reader path before it is the receiver (`self.club.name = x` is `club.name=`).
    out.push({ receiver: clean(m[1]!), member: `${m[2]}=`, column: m.index! });
  }
  for (const m of text.matchAll(OPERATOR)) {
    const op = m[2] === "!=" ? "==" : m[2]!;
    // `class A < B`, `a - b` in a block parameter list: a declaration head is no expression.
    if (/^\s*(?:class|module|def)\b/.test(text)) continue;
    out.push({ receiver: clean(m[1]!), member: op, column: m.index! });
  }
  for (const m of text.matchAll(INDEXED)) {
    const open = m.index! + m[0].length - 1;
    const close = closingBracket(text, open);
    if (close < 0) continue;
    const receiver = clean(m[1]!);
    // `rows[0]` right after the receiver with no space: `puts [1]` is an argument, `rows [1]` never reached here.
    const rest = text.slice(close + 1);
    const assigned = /^\s*(?:\|\||&&|\*\*|<<|>>|[-+*/%|&^])?=(?![=~>])/.test(rest);
    const compound = assigned && !/^\s*=/.test(rest);
    if (!assigned || compound) out.push({ receiver, member: "[]", column: m.index! });
    if (assigned) out.push({ receiver, member: "[]=", column: m.index! });
  }
  return out;
}

/** The index of the `]` closing the `[` at `open`, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}
