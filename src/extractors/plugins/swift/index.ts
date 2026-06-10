import type { RegexLangSpec } from "../shared/regex-base.js";

export const swiftSpec: RegexLangSpec = {
  language: "swift",
  extensions: [".swift"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => !line.trimStart().startsWith("private") && !line.trimStart().startsWith("fileprivate"),
      isAsync: (line) => line.includes("async "),
    },
  ],

  classPatterns: [
    {
      pattern: /(?:public\s+)?(?:final\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/:\s*(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /protocol\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /enum\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*import\s+(\w+)/,
      getSource: (m) => m[1],
      getSpecifiers: () => [],
    },
  ],
};
