import type { DataSourceInfo, FunctionInfo, ImportInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Windows batch (`.bat` / `.cmd`) regex spec. A batch "function" is a label
 * (`:build`) reached by `call :build`; it runs until the next label (or a
 * `goto :eof` / `exit /b` before it). Commands are the calls; another script
 * run by path (`call scripts\build.cmd`) is an import that `executes`. The
 * shell is case-insensitive and `%~dp0` is the script's own directory.
 */

const COMMENT_PREFIXES = ["::", "REM ", "rem ", "Rem ", "@REM ", "@rem ", "@Rem "];

/** Words that open a statement but run no program of the project's (lowercase). */
const KEYWORDS = [
  "if", "else", "for", "in", "do", "goto", "set", "setlocal", "endlocal", "echo", "rem", "exit", "shift", "pause",
  "cls", "title", "color", "pushd", "popd", "cd", "chdir", "not", "exist", "defined", "errorlevel", "call", "start",
  "ver", "vol", "prompt", "path", "type", "del", "erase", "copy", "move", "ren", "rename", "md", "mkdir", "rd", "rmdir",
  "dir", "verify", "break", "time", "date", "choice", "timeout", "nul", "con", "equ", "neq", "lss", "leq", "gtr", "geq",
];

/** A label call, `call :build` → `build`. */
const LABEL_CALL: CallPattern = {
  pattern: /\bcall\s+:([A-Za-z_][\w.-]*)/i,
  buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
};

/**
 * A command — `msbuild app.sln`, `npm ci`, `curl …` — at a statement's start
 * (line start, after `@`, `(`, `&`, `&&`, `||`, `|`, `else`, a `for`'s `do`). A path (`scripts\x.cmd`)
 * is an import, not a call; batch has no `name(` call syntax, so the generic
 * matcher is off.
 */
const COMMAND_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`(?:^|[(&|]|\b(?:else|do)\b)\s*@?(?!(?:${KEYWORDS.join("|")})\b)([A-Za-z_][\w-]*)(?:\.exe)?(?=\s|$|[&|)>])`,
    "i",
  ),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
  replacesBaseline: true,
};

/** `%~dp0scripts\build.cmd`, `.\tools\x.bat`, `"%~dp0..\lib.cmd"` → `./scripts/build.cmd`; null when not a literal relative path. */
function batchPath(raw: string): string | null {
  let p = raw.trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
  const anchored = /^%~dp0/i.test(p);
  p = p.replace(/^%~dp0\/?/i, anchored ? "./" : "");
  if (/[%!*?]/.test(p) || /^[A-Za-z]:/.test(p) || p.startsWith("/") || p === "") return null;
  if (anchored) return p.replace(/^\.\/(?=\.\.\/)/, "");
  return p.replace(/^\.\//, "");
}

/** Scripts the file runs: `call x.bat`, `call "%~dp0build.cmd" arg`, or a `.bat`/`.cmd` path as a command. */
export function batchImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    if (COMMENT_PREFIXES.some((p) => line.trimStart().startsWith(p))) return;
    const m = /(?:^|[(&|]|\bcall)\s*@?("?[^\s"&|()]+\.(?:bat|cmd)"?)/i.exec(line);
    if (!m) return;
    const path = batchPath(m[1]!);
    if (path) out.push({ source: path, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: i + 1, executes: true });
  });
  return out;
}

/**
 * Labels run until the next label: set each one's end and read its calls
 * over that span (the generic block finder knows no label scopes).
 */
function labelScopes(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  const labels = fns.filter((f) => f.name !== "<setup>").sort((a, b) => a.line - b.line);
  labels.forEach((fn, k) => {
    const next = labels[k + 1]?.line ?? lines.length + 1;
    fn.endLine = next - 1;
    fn.calls = extractCallsFromBody(lines, fn.line, fn.endLine, COMMENT_PREFIXES, [LABEL_CALL, COMMAND_CALL]);
  });
  return fns;
}

const HTTP = /\bcurl(?:\.exe)?\b(.*)$/i;
const DB_CLIENT = /\b(?:sqlcmd|psql|mysql|sqlite3|osql|bcp)(?:\.exe)?\b/i;

/** `curl -X POST https://…` and SQL given to a database client (`sqlcmd -Q "…"`). */
function batchDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const sqlLines = lines.map(() => "");
  lines.forEach((line, i) => {
    if (COMMENT_PREFIXES.some((p) => line.trimStart().startsWith(p))) return;
    const http = HTTP.exec(line);
    if (http) {
      const url = /(?:^|\s)"?((?:https?:\/\/|%\w+%\/)[^\s"]+)"?/.exec(http[1]!)?.[1];
      if (url) {
        const base = /^%(\w+)%(?=\/)/.exec(url);
        const target = (base ? url.slice(base[0].length) : url).replace(/%(\w+)%/g, "{$1}");
        const method = (/(?:-X|--request)\s+"?(\w+)/i.exec(http[1]!)?.[1] ?? (/\s(?:-d|--data\S*)\s/.test(http[1]!) ? "POST" : "GET")).toUpperCase();
        if (target.startsWith("/") || /^https?:\/\//.test(target)) {
          const ds: DataSourceInfo = { kind: "api-call", name: `${method} ${target}`, target, calls: [], line: i + 1 };
          if (base) ds.baseEnv = base[1]!;
          out.push(ds);
        }
      }
    }
    if (DB_CLIENT.test(line)) sqlLines[i] = line.replace(/""/g, '\\"') + ";";
  });
  return [...out, ...extractSqlStringDataSources(sqlLines)].sort((a, b) => a.line - b.line);
}

export const batchSpec: RegexLangSpec = {
  language: "batch",
  extensions: [".bat", ".cmd"],
  indentBased: false,
  lineCommentPrefixes: COMMENT_PREFIXES,
  topLevelCalls: true,
  functionPatterns: [{ pattern: /^\s*:(?!:)([A-Za-z_][\w.-]*)\s*$/, isExported: () => true }],
  classPatterns: [],
  importPatterns: [],
  callPatterns: [LABEL_CALL, COMMAND_CALL],
  postProcessFunctions: labelScopes,
  extractDataSources: (lines) => batchDataSources(lines),
};
