import type { ClassInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractPowerShellRoutes } from "./routes.js";
import { extractPowerShellDataSources } from "./data-sources.js";

/**
 * PowerShell regex spec (scripts, modules, Pode / Polaris web servers, Pester
 * tests). tree-sitter-powershell 0.26 left a quarter of Pode's files with
 * ERROR nodes (whole Pester test files lost), so PowerShell takes the regex
 * path. The plugin's preprocess blanks `<# … #>` comments and here-strings
 * first: comment-based help writes `.EXAMPLE Get-User -Id 5`, which is no call.
 */

/** Words that open a statement but call nothing (lowercase; PowerShell is case-insensitive). */
const KEYWORDS = [
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "break", "continue", "return",
  "exit", "throw", "try", "catch", "finally", "trap", "function", "filter", "workflow", "param", "begin",
  "process", "end", "clean", "dynamicparam", "class", "enum", "using", "data", "configuration", "in", "hidden",
  "static", "default", "parallel", "sequence", "inlinescript",
];

/**
 * A command — how PowerShell calls everything: `Get-User -Id 5`,
 * `Invoke-Pester`, `Main`, `Describe 'x' { It 'y' { … } }`. A bare word that
 * opens a statement is always a command invocation (PowerShell has no bare
 * expression statement for a name), and a statement opens at the line start,
 * after a pipe, `;`, `{`, `(` (a subexpression), `=` (an assignment's value)
 * or `return` / `throw`. A hashtable key (`Name = 'x'`) is no command.
 */
const COMMAND_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`(?:^|[|;{(=]|&&|\|\|)\s*(?:(?:return|throw)\s+)?(?:&\s*)?(?!(?:${KEYWORDS.join("|")})\b(?!-))` +
      String.raw`([A-Za-z_]\w*(?:-[A-Za-z][\w.]*)?)(?!\s*=)(?=\s|$|;|\||\))`,
    "i",
  ),
  notAfter: /(?:`|[|,(=]|-and|-or)\s*$/i,
  buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
  // Commands, methods and static calls are all a PowerShell call is: the
  // generic `name(` matcher would read `Write-Output (Get-Date)` as a call of
  // `Output`, and `-Value (…)`, `[Parameter(…)]`, `param(` call nothing.
  replacesBaseline: true,
};

/** `$repo.Find($q)`, `$this.Server.Connect()` → `repo.Find` / `this.Server.Connect`. */
const METHOD_CALL: CallPattern = {
  pattern: /\$((?:\w+\.)*\w+)\.(\w+)\s*\(/,
  buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
};

/** `[UserRepository]::new('db')`, `[Math]::Round($x)` → `UserRepository.new` / `Math.Round`. */
const STATIC_CALL: CallPattern = {
  pattern: /\[([\w.]+)\]::(\w+)\s*\(/,
  buildName: (m) => {
    const type = m[1]!.split(".").pop()!;
    return m[2]!.toLowerCase() === "new" ? { name: `new ${type}`, leafName: type } : { name: `${type}.${m[2]}`, leafName: m[2]! };
  },
};

/** `function Get-User`, `filter Where-Big`, `function script:Helper` (scope prefix dropped). */
const FUNCTION_RE = /^\s*(?:function|filter|workflow)\s+(?:(?:global|script|local|private):)?([A-Za-z_][\w-]*)\s*(?=\(|\{|$)/i;
/** Class members: `[User[]] Find([string]$q) {`, `static [Repo] Create() {`, `Repo([string]$n) { … }`. */
const METHOD_RE = /^\s*(?:(?:hidden|static)\s+)*(?:\[[^\[\]]+(?:\[\])?\]\s*)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*base\([^)]*\)\s*)?\{/i;
const CLASS_RE = /^\s*class\s+([A-Za-z_]\w*)(?:\s*:\s*([^{]+))?/i;

/**
 * `[Parameter(Mandatory = $false)][ValidateNotNull()][string[]]$Name = 'x'` →
 * name, type, default. The leading `[…]` groups are read off first (an
 * attribute's arguments may hold a `$false`); the type is the last group
 * without arguments.
 */
function parsePowerShellParam(raw: string): ParamInfo | null {
  let text = raw.trim();
  const groups: string[] = [];
  while (text.startsWith("[")) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]" && --depth === 0) { end = i; break; }
    }
    if (end < 0) return null;
    groups.push(text.slice(1, end).trim());
    text = text.slice(end + 1).trim();
  }
  const name = /^\$([A-Za-z_]\w*)/.exec(text);
  if (!name) return null;
  const types = groups.filter((g) => !g.includes("("));
  const type = types.length > 0 ? types[types.length - 1]! : null;
  const eq = text.indexOf("=", name[0].length);
  return { name: name[1]!, type, defaultValue: eq >= 0 ? text.slice(eq + 1).trim() || null : null };
}

/**
 * The parameters of a function written `function X { param(...) … }` (the
 * usual form) — the generic extractor only reads `X(...)` on the declaration
 * line. The `param(` block is the body's first statement; it may span lines.
 */
function paramBlock(lines: string[], fn: FunctionInfo): ParamInfo[] | null {
  let text = "";
  let depth = 0;
  let started = false;
  for (let i = fn.line - 1; i < Math.min(fn.endLine, lines.length); i++) {
    const line = lines[i]!.replace(/#.*$/, "");
    const start = started ? 0 : line.search(/\bparam\s*\(/i);
    if (!started) {
      if (start < 0) {
        // Only `function X {`, attributes (`[CmdletBinding()]`) and blank lines may precede it.
        if (i > fn.line - 1 && !/^\s*(?:\[[^\]]*\]\s*)*\{?\s*$/.test(line)) return null;
        continue;
      }
      started = true;
    }
    for (let k = start; k < line.length; k++) {
      const c = line[k]!;
      if (c === "(") { depth++; if (depth === 1) continue; }
      if (c === ")") { depth--; if (depth === 0) return splitTopLevel(text).map(parsePowerShellParam).filter((p): p is ParamInfo => p !== null); }
      if (depth >= 1) text += c;
    }
    text += " ";
  }
  return null;
}

/** `$PSScriptRoot\lib\x.ps1`, `.\x.ps1`, `"$PSScriptRoot/../x.ps1"` → `./lib/x.ps1`; null when not a literal relative path. */
export function scriptPath(raw: string): string | null {
  let p = raw.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  const join = /^\(?\s*Join-Path\s+\$PSScriptRoot\s+["']?([^"')]+)["']?\s*\)?$/i.exec(p);
  if (join) p = `./${join[1]!.replace(/^\.?\//, "")}`;
  p = p.replace(/^\$\{?PSScriptRoot\}?\//i, "./");
  if (/[$*?`]/.test(p) || !/^\.{1,2}\//.test(p)) return null;
  // `./../lib/x.ps1` → `../lib/x.ps1`
  return p.replace(/^\.\/(?=\.\.\/)/, "");
}

const imp = (source: string, line: number, isNamespace = false): ImportInfo =>
  ({ source, specifiers: [], isDefault: false, isNamespace, isType: false, line });

/**
 * `Import-Module X` / `using module X` / `#Requires -Modules X, Y` (a module
 * name, or a path), dot-sourcing `. $PSScriptRoot\lib.ps1`, and a script run
 * by path (`& "$PSScriptRoot\deploy.ps1"`, `.\build.ps1 -Release`).
 */
function extractPowerShellImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const mod = /^\s*(?:Import-Module|using\s+module|ipmo)\s+(?:-Name\s+)?(["']?[^\s"';|]+["']?)/i.exec(line);
    if (mod) {
      const raw = mod[1]!.replace(/^["']|["']$/g, "");
      const path = scriptPath(raw);
      if (path) out.push(imp(path, n));
      else if (/^[A-Za-z][\w.]*$/.test(raw)) out.push(imp(raw, n));
      return;
    }
    const ns = /^\s*using\s+namespace\s+([\w.]+)/i.exec(line);
    if (ns) { out.push(imp(ns[1]!, n, true)); return; }
    const req = /^\s*#Requires\s+-Modules\s+(.+)$/i.exec(line);
    if (req) {
      for (const m of req[1]!.matchAll(/(?:ModuleName\s*=\s*)?["']?([A-Za-z][\w.]*)["']?/gi)) {
        if (!/^(?:ModuleName|ModuleVersion|RequiredVersion|MaximumVersion|GUID)$/i.test(m[1]!)) out.push(imp(m[1]!, n));
      }
      return;
    }
    const dot = /^\s*\.\s+(\(\s*Join-Path\s+[^)]*\)|[^\s;|]+)/i.exec(line);
    if (dot) {
      const path = scriptPath(dot[1]!);
      if (path) out.push(imp(path, n));
      return;
    }
    const run = /^\s*(?:&\s*)?(["']?(?:\$PSScriptRoot|\.{1,2})[\\/][^\s"';|]+\.ps1["']?)/i.exec(line);
    if (run) {
      const path = scriptPath(run[1]!);
      // Run, not dot-sourced: its functions do not come into this scope.
      if (path) out.push({ ...imp(path, n), executes: true });
    }
  });
  return out;
}

export const powershellSpec: RegexLangSpec = {
  language: "powershell",
  extensions: [".ps1", ".psm1"],
  indentBased: false,
  lineCommentPrefixes: ["#"],
  // A script runs its own statements; a module's are its initialization.
  topLevelCalls: true,

  functionPatterns: [
    { pattern: FUNCTION_RE, isExported: () => true },
    { pattern: METHOD_RE, isExported: (line) => !/^\s*hidden\b/i.test(line) },
  ],
  classPatterns: [
    {
      pattern: CLASS_RE,
      // `class Repo : Base, IDisposable` — the first after the colon is the
      // base class unless it reads as an interface (I + Capital).
      getExtends: (line) => {
        const parts = (CLASS_RE.exec(line)?.[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        return parts[0] && !/^I[A-Z]/.test(parts[0]) ? parts[0] : null;
      },
      getImplements: (line) => {
        const parts = (CLASS_RE.exec(line)?.[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        return parts.filter((p, i) => i > 0 || /^I[A-Z]/.test(p));
      },
    },
    { pattern: /^\s*enum\s+([A-Za-z_]\w*)/i, kind: "enum" },
  ],
  propertyPatterns: [
    {
      // `[string] $Name`, `hidden static [int] $count = 0`
      pattern: /^\s*((?:(?:hidden|static)\s+)*)\[([^\]]+)\]\s*\$([A-Za-z_]\w*)\s*(?:=.*)?$/i,
      build: (m): PropertyInfo => ({
        name: m[3]!,
        type: m[2]!.trim(),
        visibility: /\bhidden\b/i.test(m[1]!) ? "private" : "public",
        isStatic: /\bstatic\b/i.test(m[1]!),
        isReadonly: false,
      }),
    },
  ],
  parseParam: (raw) => parsePowerShellParam(raw),
  /** `[CmdletBinding()]`, `[OutputType([string])]` on the line above a function. */
  attributeLine: { pattern: /^\s*\[([A-Za-z][\w.]*(?:\(.*\))?)\]\s*$/ },
  callPatterns: [COMMAND_CALL, METHOD_CALL, STATIC_CALL],
  importPatterns: [],

  postProcessFunctions: (lines, fns) => {
    for (const fn of fns) {
      if (fn.params.length > 0 || fn.name === "<setup>") continue;
      const params = paramBlock(lines, fn);
      if (params) fn.params = params;
    }
    return fns;
  },
  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => extractClassesWithSpec(lines, powershellSpec),
  extractRoutes: (lines) => extractPowerShellRoutes(lines, [COMMAND_CALL, METHOD_CALL, STATIC_CALL]),
  extractDataSources: (lines) => extractPowerShellDataSources(lines),
};

/** Imports are read by a function, not patterns: several forms need path normalization. */
export function powershellImports(lines: string[]): ImportInfo[] {
  return extractPowerShellImports(lines);
}
