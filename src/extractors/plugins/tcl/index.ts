import type { ImportInfo } from "../../../types/analysis.js";
import type { CallPattern, RegexLangSpec } from "../shared/regex-base.js";

/**
 * Tcl regex spec. A script is a list of commands: `proc name {params} {body}`
 * declares a function (`method` inside a class body does too), braces delimit
 * blocks, and a call is a command word — the first word of a line, after a
 * `[` (command substitution) or after a `;`. `source file` and `package
 * require name` are the imports. Files run their own statements, so calls
 * outside every proc are the file's `<setup>`.
 */

/** Core commands, control flow and Tk widget commands: they call no user proc. */
const BUILTINS = [
  "after", "append", "apply", "array", "binary", "break", "catch", "cd", "chan", "clock", "close", "concat", "continue",
  "default", "dict", "else", "elseif", "encoding", "eof", "error", "eval", "exec", "exit", "expr", "fconfigure",
  "fcopy", "file", "fileevent", "finally", "flush", "for", "foreach", "format", "gets", "glob", "global", "if", "incr",
  "info", "interp", "join", "lappend", "lassign", "lindex", "linsert", "list", "llength", "lmap", "load", "lrange",
  "lrepeat", "lreplace", "lreverse", "lsearch", "lset", "lsort", "namespace", "on", "open", "package", "pid", "proc",
  "puts", "pwd", "read", "regexp", "regsub", "rename", "return", "scan", "seek", "set", "socket", "source", "split",
  "string", "subst", "switch", "tell", "then", "throw", "time", "trace", "trap", "try", "unset", "update", "uplevel",
  "upvar", "variable", "vwait", "while", "yield", "zlib", "bind", "bell", "button", "canvas", "checkbutton", "clipboard",
  "destroy", "entry", "event", "focus", "font", "frame", "grab", "grid", "image", "label", "listbox", "lower", "menu",
  "message", "option", "pack", "panedwindow", "place", "radiobutton", "raise", "scale", "scrollbar", "selection",
  "spinbox", "text", "tk", "tkwait", "toplevel", "winfo", "wm", "unknown",
];
const NOT_BUILTIN = `(?!(?:${BUILTINS.join("|")})(?![\\w:]))`;

/** A command word: first on the line, after `[`, or after `;`. A name may be namespace-qualified (`::util::wait`). */
const COMMAND: CallPattern = {
  pattern: new RegExp(String.raw`(?:^\s*|[\[;]\s*)(?:::)?` + NOT_BUILTIN + String.raw`([A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*)(?=[\s\]};]|$)`),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(":") + 1) }),
  // A line that continues the one above (`\` at its end) starts no command.
  notAfter: /\\\s*$/,
  replacesBaseline: true,
};

/** `proc name {…}`, `method name {…}` (class bodies), `public method name {…}`, `::ns::name`. Group 1 the last name segment. */
const FUNCTION = /^\s*(?:(?:public|private|protected)\s+)?(?:proc|method|typemethod)\s+(?:::)?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)(?=\s)/;
/** `class name {`, `itcl::class name {`, `snit::type name {`, `oo::class create name {` (group 1). */
const CLASS = /^\s*(?:(?:itcl::)?class|snit::(?:type|widget|widgetadaptor)|(?:::)?oo::class\s+create)\s+(?:::)?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*\{/;

/** The first command of a one-line body: `if {$late} { whistle $x }`, `} else { bench }`, `foreach p [squad] { sign $p }`. */
const BODY_COMMAND: CallPattern = {
  pattern: new RegExp(
    String.raw`^\s*(?:\}\s*)?(?:(?:if|elseif|foreach|while|for|catch|lmap)\b.*[}\]"]\s*|else\s*)\{\s*(?:::)?` + NOT_BUILTIN +
      String.raw`([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)(?=[\s\]};]|$)`,
  ),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(":") + 1) }),
  notAfter: /\\\s*$/,
  replacesBaseline: true,
};

/** `proc name {a {b 1} args} {`: the parameter list is the first braced word after the name. */
function tclParams(lines: string[], i: number, name: string) {
  const line = lines[i]!;
  const at = line.indexOf(name, line.search(/\b(?:proc|method|typemethod)\b/));
  if (at < 0) return [];
  const rest = line.slice(at + name.length);
  // `proc name args {` — one bare parameter word, not a braced list.
  const bare = /^\s+([A-Za-z_]\w*)\s*\{/.exec(rest);
  if (bare) return [{ name: bare[1]!, type: null, defaultValue: null }];
  const open = line.indexOf("{", at + name.length);
  if (open < 0) return [];
  let depth = 0;
  let text = "";
  for (let c = open; c < line.length; c++) {
    const ch = line[c]!;
    if (ch === "{") { if (depth++ === 0) continue; }
    else if (ch === "}" && --depth === 0) break;
    text += ch;
  }
  const params: Array<{ name: string; type: null; defaultValue: string | null }> = [];
  const re = /\{\s*([A-Za-z_]\w*)\s*([^{}]*?)\s*\}|([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[3] !== undefined) params.push({ name: m[3], type: null, defaultValue: null });
    else params.push({ name: m[1]!, type: null, defaultValue: m[2] || null });
  }
  return params;
}

/**
 * Where each brace block ends. Tcl counts braces in a braced body whatever they
 * sit in (a comment too) and skips only a backslash-escaped one, so one pass
 * over the file pairs them. The key is a block's opening line (0-based), the
 * value its closing line (1-based); of several blocks opening on a `proc` line
 * the last to close is the body.
 */
function blockEnds(lines: readonly string[]): ReadonlyMap<number, number> {
  const ends = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "\\") { c++; continue; }
      if (ch === "{") stack.push(i);
      else if (ch === "}") {
        const open = stack.pop();
        if (open !== undefined) ends.set(open, Math.max(ends.get(open) ?? 0, i + 1));
      }
    }
  }
  return ends;
}

/**
 * Where a one-line proc's body starts: `proc ping {} { pong }` ends in its body, whose `{` is the last
 * braced word's opening. A line ending in `{` opens a multi-line body and has none on its line.
 */
function inlineBody(line: string, from: number): number {
  const code = line.replace(/\s+$/, "");
  if (!code.endsWith("}")) return -1;
  let depth = 0;
  for (let c = code.length - 1; c >= from; c--) {
    if (code[c] === "}" && code[c - 1] !== "\\") depth++;
    else if (code[c] === "{" && code[c - 1] !== "\\" && --depth === 0) return c + 1 < code.length ? c + 1 : -1;
  }
  return -1;
}

/**
 * `source tests/support/util.tcl`, `source [file join $dir util.tcl]` → the `.tcl` path. A `package require tls` is
 * no import: it names an installed package, and as an import it would resolve to a project file of that stem
 * (`unit/tls.tcl`).
 */
export function tclImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    const src = /^\s*source\s+(?:-encoding\s+\S+\s+)?(.+?)\s*$/.exec(line);
    if (!src) return;
    const paths = src[1]!.match(/[\w$./-]+\.tcl\b/g);
    const target = paths?.[paths.length - 1]?.replace(/^\$\w+\//, "");
    if (target) out.push({ source: target, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: i + 1 });
  });
  return out;
}

export const tclSpec: RegexLangSpec = {
  language: "tcl",
  extensions: [".tcl", ".tm"],
  lineCommentPrefixes: ["#"],
  topLevelCalls: true,
  blockEnds,
  functionPatterns: [{ pattern: FUNCTION }],
  classPatterns: [{ pattern: CLASS }],
  importPatterns: [
    {
      pattern: /^\s*source\s+\S/,
      getSource: (m) => tclImports([m.input ?? m[0]])[0]?.source ?? "",
      getSpecifiers: (m) => tclImports([m.input ?? m[0]])[0]?.specifiers ?? [],
    },
  ],
  callPatterns: [COMMAND, BODY_COMMAND],
  extractParams: tclParams,
  inlineBodyColumn: inlineBody,
};
