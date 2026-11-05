import type { CallPattern, RegexLangSpec } from "../shared/regex-base.js";

const codeLinesMemo = new WeakMap<readonly string[], string[]>();

/**
 * The lines with Lua's long brackets blanked — `--[[ … ]]` / `--[==[ … ]==]`
 * comments and `[[ … ]]` strings, whose words would read as calls (a block
 * comment holding commented-out configuration). Quoted strings and line
 * comments are left to the scan; columns and line count are kept.
 */
function luaCodeLines(lines: readonly string[]): string[] {
  const memo = codeLinesMemo.get(lines);
  if (memo) return memo;
  let close: string | null = null;
  const out = lines.map((line) => {
    let text = "";
    let i = 0;
    while (i < line.length) {
      if (close !== null) {
        const j = line.indexOf(close, i);
        const end = j < 0 ? line.length : j + close.length;
        text += " ".repeat(end - i);
        i = end;
        if (j >= 0) close = null;
        continue;
      }
      const c = line[i]!;
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        text += line.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const open = /^(?:--)?\[(=*)\[/.exec(line.slice(i));
      if (open) {
        close = `]${open[1]}]`;
        text += " ".repeat(open[0].length);
        i += open[0].length;
        continue;
      }
      if (c === "-" && line[i + 1] === "-") {
        text += line.slice(i);
        break;
      }
      text += c;
      i++;
    }
    return text;
  });
  codeLinesMemo.set(lines, out);
  return out;
}

/**
 * A function of a module called on the `require` that loads it
 * (`require("resty.openidc").authenticate(opts)`): the module's function, named
 * as the module's binding would name it (`openidc.authenticate`).
 */
const REQUIRE_CALL: CallPattern = {
  pattern: /\brequire\s*\(?\s*(["'])[^"']*\1\s*\)?\s*[.:]\s*([A-Za-z_]\w*)\s*\(/,
  buildName: (m, rawLine) => {
    const module = /^require\s*\(?\s*["']([^"']+)["']/.exec((rawLine ?? "").slice(m.index))?.[1] ?? "";
    const binding = module.split(".").pop() || "require";
    return { name: `${binding}.${m[2]}`, leafName: m[2]! };
  },
};

/**
 * Where a one-line function's body starts on its declaration line (`function M.kick() return M.tally() end`):
 * after the parameter list. -1 when the line ends with it (the body follows) or only a comment does.
 */
export function luaInlineBodyColumn(line: string, from: number): number {
  let k = from;
  while (line[k] === " " || line[k] === "\t") k++;
  if (line[k] !== "(") return -1;
  let depth = 0;
  for (; k < line.length; k++) {
    if (line[k] === "(") depth++;
    else if (line[k] === ")" && --depth === 0) break;
  }
  if (depth !== 0) return -1;
  const rest = line.slice(k + 1);
  return rest.trim() === "" || rest.trimStart().startsWith("--") ? -1 : k + 1;
}

export const luaSpec: RegexLangSpec = {
  language: "lua",
  extensions: [".lua"],
  indentBased: true,
  lineCommentPrefixes: ["--"],
  // A script's own statements run when it loads (an OpenResty access-phase script is mostly top-level code).
  topLevelCalls: true,
  callSourceLines: luaCodeLines,
  inlineBodyColumn: luaInlineBodyColumn,
  callPatterns: [REQUIRE_CALL],

  functionPatterns: [
    {
      pattern: /(?:local\s+)?function\s+([a-zA-Z_][\w.:]*)\s*\(/,
      isExported: (line) => !line.trimStart().startsWith("local"),
    },
  ],

  classPatterns: [],

  importPatterns: [
    {
      // Roblox: `require(script.Parent.Ball)` is the sibling module `Ball`, `script.Parent.Parent.Ball` one directory up.
      pattern: /(?:local\s+(\w+)\s*=\s*)?require\s*\(\s*script((?:\.Parent)+)\.(\w+(?:\.\w+)*)\s*\)/,
      getSource: (m) => `${m[2].split(".Parent").length > 2 ? "../".repeat(m[2].split(".Parent").length - 2) : "./"}${m[3].replace(/\./g, "/")}`,
      getSpecifiers: (m) => [m[1] ?? m[3].split(".").pop()!],
    },
    {
      pattern: /(?:local\s+(\w+)\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/,
      getSource: (m) => m[2],
      // The name the module is bound to (`local r = require("referee")`), else the module's own last part.
      getSpecifiers: (m) => { const parts = m[2].split("."); return [m[1] ?? parts[parts.length - 1]]; },
    },
  ],
};
