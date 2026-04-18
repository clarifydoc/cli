import type { RegexLangSpec } from "../shared/regex-base.js";

export const luaSpec: RegexLangSpec = {
  language: "lua",
  indentBased: true,
  lineCommentPrefixes: ["--"],

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
