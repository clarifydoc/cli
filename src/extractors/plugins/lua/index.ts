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

export const luaSpec: RegexLangSpec = {
  language: "lua",
  extensions: [".lua"],
  indentBased: true,
  lineCommentPrefixes: ["--"],
  // A script's own statements run when it loads (an OpenResty access-phase script is mostly top-level code).
  topLevelCalls: true,
  callSourceLines: luaCodeLines,
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
      pattern: /(?:local\s+\w+\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("."); return [parts[parts.length - 1]]; },
    },
  ],
};
