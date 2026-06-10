import type { RegexLangSpec } from "../shared/regex-base.js";

export const scalaSpec: RegexLangSpec = {
  language: "scala",
  extensions: [".scala"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /\bdef\s+([a-zA-Z_]\w*)\s*[\[(:=]/,
      isExported: (line) => !line.trimStart().startsWith("private"),
    },
  ],

  classPatterns: [
    {
      pattern: /(?:case\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => { const m = line.match(/extends\s+(\w+)/); return m?.[1] ?? null; },
    },
    { pattern: /(?:sealed\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /object\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*import\s+(.+)/,
      getSource: (m) => m[1].replace(/\.\{.*/, "").replace(/\._$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map((s) => s.trim().split(" => ").pop()!.trim());
        const parts = m[1].replace(/_$/, "").split(".");
        return [parts[parts.length - 1]].filter((s) => s && s !== "_");
      },
    },
  ],
};
